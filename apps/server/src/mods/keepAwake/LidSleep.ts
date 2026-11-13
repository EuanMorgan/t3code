import * as NodeOS from "node:os";

import { KeepAwakeLidSetupError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Stops the Mac sleeping when its lid closes, which `caffeinate` cannot do on battery. */
export class LidSleep extends Context.Service<
  LidSleep,
  {
    /** Asks once for an admin password to install a helper that sudo may run without one. */
    readonly install: () => Effect.Effect<void, KeepAwakeLidSetupError>;
    /** Holds `pmset disablesleep 1` until interrupted. */
    readonly hold: () => Effect.Effect<void>;
  }
>()("t3/mods/keepAwake/LidSleep") {}

const HELPER_PATH = "/Library/PrivilegedHelperTools/e3-lid-awake";
const SUDOERS_PATH = "/etc/sudoers.d/e3-keep-awake";

// Root runs this, so it trusts nothing but a numeric PID. Watching that PID resets sleep even
// when the server is killed outright and cannot stop the helper itself.
const HELPER_SCRIPT = `#!/bin/sh
case "$1" in ''|*[!0-9]*) exit 64 ;; esac
trap '/usr/bin/pmset -a disablesleep 0' EXIT
trap 'exit 0' HUP INT TERM
/usr/bin/pmset -a disablesleep 1
while /bin/kill -0 "$1" 2>/dev/null; do
  /bin/sleep 5 &
  wait $!
done
`;

const INSTALL_PROMPT =
  "E3 Code needs your password once so Keep Awake can keep your Mac awake with the lid closed.";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const setupError = (message: string) => new KeepAwakeLidSetupError({ message });

export const layer = Layer.effect(
  LidSleep,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const isInstalled = Effect.gen(function* () {
      const helper = yield* fs.readFileString(HELPER_PATH).pipe(Effect.orElseSucceed(() => null));
      if (helper !== HELPER_SCRIPT) return false;
      const exitCode = yield* spawner
        .exitCode(ChildProcess.make("sudo", ["-n", "-l", HELPER_PATH], { stdin: "ignore" }))
        .pipe(Effect.orElseSucceed(() => 1));
      return exitCode === 0;
    });

    const runInstaller = Effect.scoped(
      Effect.gen(function* () {
        const staging = yield* fs.makeTempDirectoryScoped({ prefix: "e3-keep-awake-" });
        const helper = path.join(staging, "helper");
        const sudoers = path.join(staging, "sudoers");
        yield* fs.writeFileString(helper, HELPER_SCRIPT);
        yield* fs.writeFileString(
          sudoers,
          `${NodeOS.userInfo().username} ALL=(root) NOPASSWD: ${HELPER_PATH}\n`,
        );
        const script = [
          `/usr/sbin/visudo -cf ${shellQuote(sudoers)}`,
          "/usr/bin/install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools",
          `/usr/bin/install -o root -g wheel -m 755 ${shellQuote(helper)} ${HELPER_PATH}`,
          `/usr/bin/install -o root -g wheel -m 440 ${shellQuote(sudoers)} ${SUDOERS_PATH}`,
        ].join(" && ");
        return yield* spawner.exitCode(
          ChildProcess.make(
            "osascript",
            [
              "-e",
              "on run argv",
              "-e",
              "do shell script (item 1 of argv) with administrator privileges with prompt (item 2 of argv)",
              "-e",
              "end run",
              script,
              INSTALL_PROMPT,
            ],
            { stdin: "ignore" },
          ),
        );
      }),
    ).pipe(
      Effect.mapError((cause) =>
        setupError(`Could not set up keeping the Mac awake with the lid closed: ${cause.message}`),
      ),
    );

    return LidSleep.of({
      install: Effect.fn("LidSleep.install")(function* () {
        if (yield* isInstalled) return;
        const exitCode = yield* runInstaller;
        if (exitCode !== 0 || !(yield* isInstalled)) {
          return yield* setupError(
            "Keep awake with lid closed needs your admin password once. It stays off until you enter it.",
          );
        }
      }),
      hold: Effect.fn("LidSleep.hold")(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("sudo", ["-n", HELPER_PATH, String(process.pid)], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
            const exitCode = yield* child.exitCode;
            yield* Effect.logWarning("The lid-closed helper exited while Keep Awake was on", {
              exitCode,
            });
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not run the lid-closed helper", { cause }),
          ),
        );
      }),
    });
  }),
);
