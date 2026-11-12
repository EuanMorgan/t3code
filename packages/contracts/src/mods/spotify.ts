import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";

export const SPOTIFY_METHODS = {
  control: "mods.spotify.control",
  subscribe: "mods.spotify.subscribe",
} as const;

export const SpotifyTrack = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  artist: Schema.String,
  album: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
  playing: Schema.Boolean,
});
export type SpotifyTrack = typeof SpotifyTrack.Type;

/** `track` is null when the server is not a Mac, Spotify is closed, or nothing is loaded. */
export const SpotifyStatus = Schema.Struct({ track: Schema.NullOr(SpotifyTrack) });
export type SpotifyStatus = typeof SpotifyStatus.Type;

export const SpotifyAction = Schema.Literals(["playpause", "next", "previous"]);
export type SpotifyAction = typeof SpotifyAction.Type;

export const SpotifyControlRpc = Rpc.make(SPOTIFY_METHODS.control, {
  payload: Schema.Struct({ action: SpotifyAction }),
  error: EnvironmentAuthorizationError,
});

export const SpotifySubscribeRpc = Rpc.make(SPOTIFY_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SpotifyStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const SPOTIFY_RPC_SCOPES = {
  [SPOTIFY_METHODS.control]: AuthOrchestrationOperateScope,
  [SPOTIFY_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;
