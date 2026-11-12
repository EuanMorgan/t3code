import {
  KEEP_AWAKE_METHODS,
  KEEP_AWAKE_RPC_SCOPES,
  KeepAwakeSetRpc,
  KeepAwakeSubscribeRpc,
} from "./keepAwake.ts";

export * from "./keepAwake.ts";

export const MOD_RPCS = [KeepAwakeSetRpc, KeepAwakeSubscribeRpc] as const;

export const MOD_RPC_SCOPES = { ...KEEP_AWAKE_RPC_SCOPES } as const;

export type ModSubscriptionRpcTag = typeof KEEP_AWAKE_METHODS.subscribe;
