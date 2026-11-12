import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

export const KEEP_AWAKE_METHODS = {
  set: "mods.keepAwake.set",
  subscribe: "mods.keepAwake.subscribe",
} as const;

const KEEP_AWAKE_MAX_MINUTES = 24 * 60;

export const KeepAwakeMode = Schema.Union([
  Schema.TaggedStruct("Off", {}),
  Schema.TaggedStruct("Manual", {}),
  Schema.TaggedStruct("Timed", { endsAt: Schema.DateTimeUtc }),
  Schema.TaggedStruct("AgentsFinish", {
    /** Set after a restart: how long to wait for work to resume before turning off. */
    resumeBy: Schema.optionalKey(Schema.DateTimeUtc),
  }),
]);
export type KeepAwakeMode = typeof KeepAwakeMode.Type;

export const KeepAwakeState = Schema.Struct({
  mode: KeepAwakeMode,
  keepScreenOn: Schema.Boolean,
});
export type KeepAwakeState = typeof KeepAwakeState.Type;

export const KeepAwakeStatus = Schema.Struct({
  supported: Schema.Boolean,
  state: KeepAwakeState,
  agentsWorking: Schema.Boolean,
});
export type KeepAwakeStatus = typeof KeepAwakeStatus.Type;

export const KeepAwakeModeRequest = Schema.Union([
  Schema.TaggedStruct("Off", {}),
  Schema.TaggedStruct("Manual", {}),
  // A duration, not an end time, so a remote client's clock cannot skew it.
  Schema.TaggedStruct("For", {
    minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: KEEP_AWAKE_MAX_MINUTES })),
  }),
  Schema.TaggedStruct("AgentsFinish", {}),
]);
export type KeepAwakeModeRequest = typeof KeepAwakeModeRequest.Type;

export const KeepAwakeSetInput = Schema.Struct({
  mode: Schema.optionalKey(KeepAwakeModeRequest),
  keepScreenOn: Schema.optionalKey(Schema.Boolean),
});
export type KeepAwakeSetInput = typeof KeepAwakeSetInput.Type;

export class KeepAwakeUnsupportedError extends Schema.TaggedError<KeepAwakeUnsupportedError>()(
  "KeepAwakeUnsupportedError",
  { message: Schema.String },
) {}

export const KeepAwakeSetRpc = Rpc.make(KEEP_AWAKE_METHODS.set, {
  payload: KeepAwakeSetInput,
  success: KeepAwakeStatus,
  error: Schema.Union([KeepAwakeUnsupportedError, EnvironmentAuthorizationError]),
});

export const KeepAwakeSubscribeRpc = Rpc.make(KEEP_AWAKE_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: KeepAwakeStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const KEEP_AWAKE_RPC_SCOPES = {
  [KEEP_AWAKE_METHODS.set]: AuthSettingsWriteScope,
  [KEEP_AWAKE_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;
