import {
  ReviewRequestsTokenError,
  type PullRequestSummary,
  type ReviewRequest,
  type ReviewRequestsStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import { parseReviewRequests, SlackMessage, type PostedReviewRequest } from "./slackPosts.ts";

const SLACK_TOKEN_SECRET = "mod-review-requests-slack-token";
const CHANNEL_ID = "C02D9CMLKA5";
const WINDOW_SECONDS = 14 * 24 * 60 * 60;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const POLL_INTERVAL = "60 seconds";
// A burst of refresh clicks costs one Slack read.
const MIN_REFRESH_GAP_MS = 5_000;

export interface SlackSnapshot {
  readonly slackTokenSet: boolean;
  readonly posts: ReadonlyArray<PostedReviewRequest>;
  readonly slackError: string | null;
  readonly fetchedAt: string | null;
}

export class ReviewRequests extends Context.Service<
  ReviewRequests,
  {
    /** The channel's posts, read again about every minute and only while someone subscribes. */
    readonly posts: Stream.Stream<SlackSnapshot>;
    readonly refresh: Effect.Effect<void>;
    readonly setSlackToken: (token: string | null) => Effect.Effect<void, ReviewRequestsTokenError>;
  }
>()("t3/mods/reviewRequests/ReviewRequests") {}

class SlackReadError extends Schema.TaggedError<SlackReadError>()("SlackReadError", {
  message: Schema.String,
}) {}

const HistoryPage = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(SlackMessage)),
  has_more: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
});

const RATE_LIMITED = "Slack is rate limiting this token. Trying again in a minute.";

const SLACK_ERRORS: Readonly<Record<string, string>> = {
  invalid_auth: "Slack rejected the saved token. Paste a new one.",
  not_authed: "Slack rejected the saved token. Paste a new one.",
  token_revoked: "The saved Slack token was revoked. Paste a new one.",
  token_expired: "The saved Slack token expired. Paste a new one.",
  account_inactive: "The saved Slack token belongs to a deactivated account.",
  missing_scope: "The Slack token needs the channels:history scope.",
  channel_not_found: "The token cannot see #eng-review-requests.",
  not_in_channel: "The token's user is not in #eng-review-requests.",
  ratelimited: RATE_LIMITED,
};

const NO_TOKEN: SlackSnapshot = {
  slackTokenSet: false,
  posts: [],
  slackError: null,
  fetchedAt: null,
};

type Trigger = "tick" | "refresh" | "token";

type ReadState = SlackSnapshot & { readonly readAtMs: number };

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const triggers = yield* PubSub.unbounded<Trigger>();

  const readToken = secrets.get(SLACK_TOKEN_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
    Effect.map(Option.filter((token) => token !== "")),
    Effect.mapError(
      () => new SlackReadError({ message: "The saved Slack token could not be read." }),
    ),
  );

  const readPage = Effect.fn("ReviewRequests.readPage")(function* (
    token: string,
    oldest: string,
    cursor: string | undefined,
  ) {
    const response = yield* HttpClientRequest.get(
      "https://slack.com/api/conversations.history",
    ).pipe(
      HttpClientRequest.setUrlParams({
        channel: CHANNEL_ID,
        oldest,
        limit: String(PAGE_SIZE),
        ...(cursor === undefined ? {} : { cursor }),
      }),
      HttpClientRequest.bearerToken(token),
      http.execute,
      Effect.timeout("15 seconds"),
      Effect.mapError(() => new SlackReadError({ message: "Slack could not be reached." })),
    );
    if (response.status === 429) return yield* new SlackReadError({ message: RATE_LIMITED });
    const page = yield* HttpClientResponse.schemaBodyJson(HistoryPage)(response).pipe(
      Effect.mapError(
        () => new SlackReadError({ message: "Slack sent an answer T3 Code cannot read." }),
      ),
    );
    if (!page.ok) {
      return yield* new SlackReadError({
        message:
          SLACK_ERRORS[page.error ?? ""] ?? `Slack answered ${page.error ?? "with an error"}.`,
      });
    }
    return page;
  });

  const readHistory = Effect.fn("ReviewRequests.readHistory")(function* (
    token: string,
    nowMs: number,
  ) {
    const oldest = String(Math.floor(nowMs / 1000) - WINDOW_SECONDS);
    const messages: Array<SlackMessage> = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = yield* readPage(token, oldest, cursor);
      messages.push(...(result.messages ?? []));
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!result.has_more || cursor === undefined) break;
    }
    return messages;
  });

  const read = Effect.fn("ReviewRequests.read")(function* (previous: ReadState, trigger: Trigger) {
    const nowMs = yield* Clock.currentTimeMillis;
    if (trigger === "refresh" && nowMs - previous.readAtMs < MIN_REFRESH_GAP_MS) return null;
    const outcome = yield* readToken.pipe(
      Effect.flatMap((token) =>
        Option.isNone(token)
          ? Effect.succeed(NO_TOKEN)
          : readHistory(token.value, nowMs).pipe(
              Effect.map((messages): SlackSnapshot => ({
                slackTokenSet: true,
                posts: parseReviewRequests(messages),
                slackError: null,
                fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
              })),
            ),
      ),
      Effect.catch((error) =>
        Effect.succeed<SlackSnapshot>({
          ...previous,
          slackTokenSet: true,
          slackError: error.message,
        }),
      ),
    );
    return { ...outcome, readAtMs: nowMs };
  });

  const poll = Stream.merge(
    Stream.tick(POLL_INTERVAL).pipe(Stream.as<Trigger>("tick")),
    Stream.fromPubSub(triggers),
  ).pipe(
    Stream.mapAccumEffect(
      (): ReadState => ({ ...NO_TOKEN, readAtMs: Number.NEGATIVE_INFINITY }),
      (previous, trigger) =>
        read(previous, trigger).pipe(
          Effect.map((next): readonly [ReadState, ReadonlyArray<ReadState>] =>
            next === null ? [previous, []] : [next, [next]],
          ),
        ),
    ),
    Stream.map(({ readAtMs: _, ...snapshot }): SlackSnapshot => snapshot),
  );

  const posts = yield* Stream.share(poll, {
    capacity: 1,
    strategy: "sliding",
    replay: 1,
    idleTimeToLive: "10 seconds",
  });

  return ReviewRequests.of({
    posts,
    refresh: PubSub.publish(triggers, "refresh").pipe(Effect.asVoid),
    setSlackToken: Effect.fn("ReviewRequests.setSlackToken")(function* (token) {
      yield* (
        token === null
          ? secrets.remove(SLACK_TOKEN_SECRET)
          : secrets.set(SLACK_TOKEN_SECRET, new TextEncoder().encode(token))
      ).pipe(Effect.mapError((error) => new ReviewRequestsTokenError({ message: error.message })));
      yield* PubSub.publish(triggers, "token");
    }),
  });
});

export const layer = Layer.effect(ReviewRequests, make);

export type ReadPullRequest = (
  post: PostedReviewRequest,
) => Effect.Effect<PullRequestSummary, { readonly message: string }>;

/** Adds GitHub's state to each post and drops pull requests that are merged, closed or drafts. */
export const withGitHubState = Effect.fn("ReviewRequests.withGitHubState")(function* (
  snapshot: SlackSnapshot,
  readPullRequest: ReadPullRequest,
) {
  const reads = yield* Effect.forEach(
    snapshot.posts,
    (post) =>
      readPullRequest(post).pipe(
        Effect.map((pullRequest) => ({ post, pullRequest, error: null })),
        Effect.catch((error) => Effect.succeed({ post, pullRequest: null, error: error.message })),
      ),
    { concurrency: 4 },
  );
  const requests: Array<ReviewRequest> = [];
  for (const { post, pullRequest } of reads) {
    if (pullRequest !== null && (pullRequest.state !== "open" || pullRequest.isDraft === true)) {
      continue;
    }
    requests.push({ ...post, pullRequest });
  }
  const failed = reads.filter((read) => read.error !== null);
  return {
    slackTokenSet: snapshot.slackTokenSet,
    requests,
    slackError: snapshot.slackError,
    githubError:
      failed.length === 0
        ? null
        : `GitHub could not be read for ${failed.length} of ${reads.length} pull requests: ${failed[0]?.error}`,
    fetchedAt: snapshot.fetchedAt,
  } satisfies ReviewRequestsStatus;
});

const NO_PROJECT = { message: "Add a project to T3 Code so it can read GitHub." };

/** Every subscriber reads GitHub on its own; the pull request read cache keeps that cheap. */
export const statuses = (
  reviewRequests: ReviewRequests["Service"],
  pullRequests: PullRequestService.PullRequestService["Service"],
  projects: ProjectService.ProjectService["Service"],
): Stream.Stream<ReviewRequestsStatus> =>
  reviewRequests.posts.pipe(
    Stream.mapEffect((snapshot) =>
      Effect.gen(function* () {
        // Any project will do: the read routes to a checkout of the repository when one exists.
        const projectId = yield* projects.listPage({ cursor: 0, limit: 1 }).pipe(
          Effect.map((page) => page.projects[0]?.id ?? null),
          Effect.orElseSucceed(() => null),
        );
        return yield* withGitHubState(snapshot, (post) =>
          projectId === null
            ? Effect.fail(NO_PROJECT)
            : pullRequests.summary({
                projectId,
                host: "github.com",
                repository: post.repository,
                number: post.number,
              }),
        );
      }),
    ),
  );
