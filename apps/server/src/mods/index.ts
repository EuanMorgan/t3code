import {
  CALENDAR_METHODS,
  KEEP_AWAKE_METHODS,
  REVIEW_REQUESTS_METHODS,
  SPOTIFY_METHODS,
  type KeepAwakeSetInput,
  type SpotifyAction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Calendar from "./calendar/Calendar.ts";
import * as KeepAwake from "./keepAwake/KeepAwake.ts";
import * as ReviewRequests from "./reviewRequests/ReviewRequests.ts";
import * as Spotify from "./spotify/Spotify.ts";

export const layer = Layer.mergeAll(
  Calendar.layer,
  KeepAwake.layer,
  Spotify.layer,
  ReviewRequests.layer,
);

const modNotRunning = (name: string) => new Error(`${name} is not running on this server.`);

export const MOD_RPC_AGGREGATES = {
  [CALENDAR_METHODS.setFeed]: "mods",
  [CALENDAR_METHODS.subscribe]: "mods",
  [KEEP_AWAKE_METHODS.set]: "mods",
  [KEEP_AWAKE_METHODS.subscribe]: "mods",
  [SPOTIFY_METHODS.control]: "mods",
  [SPOTIFY_METHODS.subscribe]: "mods",
  [REVIEW_REQUESTS_METHODS.subscribe]: "mods",
  [REVIEW_REQUESTS_METHODS.refresh]: "mods",
  [REVIEW_REQUESTS_METHODS.setSlackToken]: "mods",
} as const;

// Read optionally so upstream harnesses that build the WS layer need no mod services.
export const makeModRpcHandlers = Effect.gen(function* () {
  const calendar = Option.getOrUndefined(yield* Effect.serviceOption(Calendar.Calendar));
  const keepAwake = Option.getOrUndefined(yield* Effect.serviceOption(KeepAwake.KeepAwake));
  const spotify = Option.getOrUndefined(yield* Effect.serviceOption(Spotify.Spotify));
  const reviewRequests = Option.getOrUndefined(
    yield* Effect.serviceOption(ReviewRequests.ReviewRequests),
  );
  const pullRequests = Option.getOrUndefined(
    yield* Effect.serviceOption(PullRequestService.PullRequestService),
  );
  const projects = Option.getOrUndefined(
    yield* Effect.serviceOption(ProjectService.ProjectService),
  );
  return {
    [CALENDAR_METHODS.setFeed]: ({ url }: { readonly url: string | null }) =>
      calendar === undefined ? Effect.die(modNotRunning("Calendar")) : calendar.setFeed(url),
    [CALENDAR_METHODS.subscribe]: () =>
      calendar === undefined ? Stream.die(modNotRunning("Calendar")) : calendar.status,
    [KEEP_AWAKE_METHODS.set]: (input: KeepAwakeSetInput) =>
      keepAwake === undefined ? Effect.die(modNotRunning("Keep Awake")) : keepAwake.set(input),
    [KEEP_AWAKE_METHODS.subscribe]: () =>
      keepAwake === undefined ? Stream.die(modNotRunning("Keep Awake")) : keepAwake.status,
    [SPOTIFY_METHODS.control]: ({ action }: { readonly action: SpotifyAction }) =>
      spotify === undefined ? Effect.die(modNotRunning("Spotify")) : spotify.control(action),
    [SPOTIFY_METHODS.subscribe]: () =>
      spotify === undefined ? Stream.die(modNotRunning("Spotify")) : spotify.status,
    [REVIEW_REQUESTS_METHODS.subscribe]: () =>
      reviewRequests === undefined || pullRequests === undefined || projects === undefined
        ? Stream.die(modNotRunning("Review requests"))
        : ReviewRequests.statuses(reviewRequests, pullRequests, projects),
    [REVIEW_REQUESTS_METHODS.refresh]: () =>
      reviewRequests === undefined
        ? Effect.die(modNotRunning("Review requests"))
        : reviewRequests.refresh,
    [REVIEW_REQUESTS_METHODS.setSlackToken]: ({ token }: { readonly token: string | null }) =>
      reviewRequests === undefined
        ? Effect.die(modNotRunning("Review requests"))
        : reviewRequests.setSlackToken(token),
  };
});
