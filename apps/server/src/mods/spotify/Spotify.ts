import { SpotifyStatus, type SpotifyAction } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class Spotify extends Context.Service<
  Spotify,
  {
    /** The current track, then every change. */
    readonly status: Stream.Stream<SpotifyStatus>;
    readonly control: (action: SpotifyAction) => Effect.Effect<void>;
  }
>()("t3/mods/spotify/Spotify") {}

const NOTHING_PLAYING: SpotifyStatus = { track: null };

// Reading a property of a closed app launches it, so every read checks running() first.
// The watcher prints every second even when nothing changed: once this server is gone the
// write fails and osascript exits, instead of polling Spotify forever.
const WATCH_SCRIPT = `
ObjC.import("Foundation");
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const spotify = Application("Spotify");
let track = null;
const read = () => {
  if (!spotify.running()) return null;
  try {
    const current = spotify.currentTrack;
    const id = current.id();
    if (!id) return null;
    if (track === null || track.id !== id) {
      track = { id, name: current.name(), artist: current.artist(), album: current.album(), artworkUrl: current.artworkUrl() || null };
    }
    return { ...track, playing: spotify.playerState() === "playing" };
  } catch (error) {
    return null;
  }
};
for (;;) {
  out.writeData($(JSON.stringify({ track: read() }) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
  delay(1);
}
`;

const SPOTIFY_COMMANDS = {
  playpause: "playpause",
  next: "nextTrack",
  previous: "previousTrack",
} satisfies Record<SpotifyAction, string>;

const controlScript = (action: SpotifyAction) =>
  `const spotify = Application("Spotify"); if (spotify.running()) spotify.${SPOTIFY_COMMANDS[action]}();`;

const decodeStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(SpotifyStatus)),
);

const make = Effect.fn("Spotify.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;

  const supported = platform === "darwin";

  const watch = Stream.unwrap(
    spawner
      .spawn(
        ChildProcess.make("osascript", ["-l", "JavaScript", "-e", WATCH_SCRIPT], {
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.map((child) => child.stdout)),
  ).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.changes,
    Stream.mapEffect((line) => decodeStatus(line)),
    Stream.catchCause((cause) =>
      Stream.fromEffect(Effect.logWarning("Spotify watcher failed", { cause })).pipe(Stream.drain),
    ),
    Stream.repeat(Schedule.spaced("5 seconds")),
  );

  // One watcher for every client, running only while someone is subscribed.
  const status = supported
    ? yield* Stream.share(watch, {
        capacity: 1,
        strategy: "sliding",
        replay: 1,
        idleTimeToLive: "10 seconds",
      })
    : Stream.make(NOTHING_PLAYING);

  return Spotify.of({
    status: status.pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b))),
    control: Effect.fn("Spotify.control")(function* (action) {
      if (!supported) return;
      const exitCode = yield* spawner
        .exitCode(
          ChildProcess.make("osascript", ["-l", "JavaScript", "-e", controlScript(action)], {
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.orElseSucceed(() => -1));
      if (exitCode !== 0) yield* Effect.logWarning("Spotify control failed", { action, exitCode });
    }),
  });
});

export const layer = Layer.effect(Spotify, make());
