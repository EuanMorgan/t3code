import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The macOS `caffeinate` binary: `run` holds its power assertion until interrupted. */
export class CaffeinateProcess extends Context.Service<
  CaffeinateProcess,
  { readonly run: (args: ReadonlyArray<string>) => Effect.Effect<void> }
>()("t3/mods/keepAwake/CaffeinateProcess") {}

export const layer = Layer.effect(
  CaffeinateProcess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return CaffeinateProcess.of({
      run: Effect.fn("CaffeinateProcess.run")(function* (args) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("caffeinate", [...args], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
            const exitCode = yield* child.exitCode;
            yield* Effect.logWarning("caffeinate exited while Keep Awake was on", { exitCode });
          }),
        ).pipe(Effect.catch((cause) => Effect.logWarning("Could not run caffeinate", { cause })));
      }),
    });
  }),
);
