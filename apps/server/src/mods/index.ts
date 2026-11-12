import {
  KEEP_AWAKE_METHODS,
  SPOTIFY_METHODS,
  type KeepAwakeSetInput,
  type SpotifyAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as KeepAwake from "./keepAwake/KeepAwake.ts";
import * as Spotify from "./spotify/Spotify.ts";

export const layer = Layer.mergeAll(KeepAwake.layer, Spotify.layer);

const modNotRunning = (name: string) => new Error(`${name} is not running on this server.`);

export const MOD_RPC_AGGREGATES = {
  [KEEP_AWAKE_METHODS.set]: "mods",
  [KEEP_AWAKE_METHODS.subscribe]: "mods",
  [SPOTIFY_METHODS.control]: "mods",
  [SPOTIFY_METHODS.subscribe]: "mods",
} as const;

// Read optionally so upstream harnesses that build the WS layer need no mod services.
export const makeModRpcHandlers = Effect.gen(function* () {
  const keepAwake = Option.getOrUndefined(yield* Effect.serviceOption(KeepAwake.KeepAwake));
  const spotify = Option.getOrUndefined(yield* Effect.serviceOption(Spotify.Spotify));
  return {
    [KEEP_AWAKE_METHODS.set]: (input: KeepAwakeSetInput) =>
      keepAwake === undefined ? Effect.die(modNotRunning("Keep Awake")) : keepAwake.set(input),
    [KEEP_AWAKE_METHODS.subscribe]: () =>
      keepAwake === undefined ? Stream.die(modNotRunning("Keep Awake")) : keepAwake.status,
    [SPOTIFY_METHODS.control]: ({ action }: { readonly action: SpotifyAction }) =>
      spotify === undefined ? Effect.die(modNotRunning("Spotify")) : spotify.control(action),
    [SPOTIFY_METHODS.subscribe]: () =>
      spotify === undefined ? Stream.die(modNotRunning("Spotify")) : spotify.status,
  };
});
