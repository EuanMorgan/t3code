import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { PullRequestSummary } from "../pullRequest.ts";

export const REVIEW_REQUESTS_METHODS = {
  subscribe: "mods.reviewRequests.subscribe",
  refresh: "mods.reviewRequests.refresh",
  setSlackToken: "mods.reviewRequests.setSlackToken",
} as const;

export const ReviewRequestTeam = Schema.Literals(["All", "Forest"]);
export type ReviewRequestTeam = typeof ReviewRequestTeam.Type;

export const ReviewRequestReactions = Schema.Struct({
  /** `eyes`: someone is reviewing. */
  looking: NonNegativeInt,
  /** `white_check_mark`: someone has reviewed. */
  reviewed: NonNegativeInt,
});
export type ReviewRequestReactions = typeof ReviewRequestReactions.Type;

export const ReviewRequest = Schema.Struct({
  url: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  team: ReviewRequestTeam,
  /** The Slack post's link text, shown when GitHub could not be read. */
  postedTitle: Schema.NullOr(Schema.String),
  postedAt: IsoDateTime,
  reactions: ReviewRequestReactions,
  /** Null when GitHub could not be read for this pull request. */
  pullRequest: Schema.NullOr(PullRequestSummary),
});
export type ReviewRequest = typeof ReviewRequest.Type;

export const ReviewRequestsStatus = Schema.Struct({
  slackTokenSet: Schema.Boolean,
  /** Open, non-draft pull requests, newest post first. */
  requests: Schema.Array(ReviewRequest),
  /** Why the last Slack read failed. The rows from the read before it stay. */
  slackError: Schema.NullOr(Schema.String),
  githubError: Schema.NullOr(Schema.String),
  fetchedAt: Schema.NullOr(IsoDateTime),
});
export type ReviewRequestsStatus = typeof ReviewRequestsStatus.Type;

export const SlackUserToken = TrimmedNonEmptyString.check(Schema.isPattern(/^xox[a-z]-[\w-]+$/));

export class ReviewRequestsTokenError extends Schema.TaggedError<ReviewRequestsTokenError>()(
  "ReviewRequestsTokenError",
  { message: Schema.String },
) {}

export const ReviewRequestsSubscribeRpc = Rpc.make(REVIEW_REQUESTS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: ReviewRequestsStatus,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const ReviewRequestsRefreshRpc = Rpc.make(REVIEW_REQUESTS_METHODS.refresh, {
  payload: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

export const ReviewRequestsSetSlackTokenRpc = Rpc.make(REVIEW_REQUESTS_METHODS.setSlackToken, {
  /** Null removes the saved token. */
  payload: Schema.Struct({ token: Schema.NullOr(SlackUserToken) }),
  error: Schema.Union([ReviewRequestsTokenError, EnvironmentAuthorizationError]),
});

export const REVIEW_REQUESTS_RPC_SCOPES = {
  [REVIEW_REQUESTS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [REVIEW_REQUESTS_METHODS.refresh]: AuthOrchestrationReadScope,
  [REVIEW_REQUESTS_METHODS.setSlackToken]: AuthSettingsWriteScope,
} as const;
