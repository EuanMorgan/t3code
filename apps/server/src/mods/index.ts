import { KEEP_AWAKE_METHODS, type KeepAwakeSetInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as KeepAwake from "./keepAwake/KeepAwake.ts";

export const layer = KeepAwake.layer;

const MOD_NOT_RUNNING = new Error("Keep Awake is not running on this server.");

export const MOD_RPC_AGGREGATES = {
  [KEEP_AWAKE_METHODS.set]: "mods",
  [KEEP_AWAKE_METHODS.subscribe]: "mods",
} as const;

// Read optionally so upstream harnesses that build the WS layer need no mod services.
export const makeModRpcHandlers = Effect.gen(function* () {
  const keepAwake = Option.getOrUndefined(yield* Effect.serviceOption(KeepAwake.KeepAwake));
  return {
    [KEEP_AWAKE_METHODS.set]: (input: KeepAwakeSetInput) =>
      keepAwake === undefined ? Effect.die(MOD_NOT_RUNNING) : keepAwake.set(input),
    [KEEP_AWAKE_METHODS.subscribe]: () =>
      keepAwake === undefined ? Stream.die(MOD_NOT_RUNNING) : keepAwake.status,
  };
});
