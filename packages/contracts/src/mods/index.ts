import {
  CALENDAR_METHODS,
  CALENDAR_RPC_SCOPES,
  CalendarSetFeedRpc,
  CalendarSubscribeRpc,
} from "./calendar.ts";
import {
  KEEP_AWAKE_METHODS,
  KEEP_AWAKE_RPC_SCOPES,
  KeepAwakeSetRpc,
  KeepAwakeSubscribeRpc,
} from "./keepAwake.ts";
import {
  REVIEW_REQUESTS_METHODS,
  REVIEW_REQUESTS_RPC_SCOPES,
  ReviewRequestsRefreshRpc,
  ReviewRequestsSetSlackTokenRpc,
  ReviewRequestsSubscribeRpc,
} from "./reviewRequests.ts";
import {
  SPOTIFY_METHODS,
  SPOTIFY_RPC_SCOPES,
  SpotifyControlRpc,
  SpotifySubscribeRpc,
} from "./spotify.ts";

export * from "./calendar.ts";
export * from "./keepAwake.ts";
export * from "./reviewRequests.ts";
export * from "./spotify.ts";

export const MOD_RPCS = [
  CalendarSetFeedRpc,
  CalendarSubscribeRpc,
  KeepAwakeSetRpc,
  KeepAwakeSubscribeRpc,
  SpotifyControlRpc,
  SpotifySubscribeRpc,
  ReviewRequestsSubscribeRpc,
  ReviewRequestsRefreshRpc,
  ReviewRequestsSetSlackTokenRpc,
] as const;

export const MOD_RPC_SCOPES = {
  ...CALENDAR_RPC_SCOPES,
  ...KEEP_AWAKE_RPC_SCOPES,
  ...SPOTIFY_RPC_SCOPES,
  ...REVIEW_REQUESTS_RPC_SCOPES,
} as const;

export type ModSubscriptionRpcTag =
  | typeof CALENDAR_METHODS.subscribe
  | typeof KEEP_AWAKE_METHODS.subscribe
  | typeof SPOTIFY_METHODS.subscribe
  | typeof REVIEW_REQUESTS_METHODS.subscribe;
