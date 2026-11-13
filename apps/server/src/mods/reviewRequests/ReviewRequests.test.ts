import { describe, expect, it } from "@effect/vitest";
import { ProjectId, SourceControlProviderKind, type PullRequestSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ReviewRequests from "./ReviewRequests.ts";
import type { PostedReviewRequest } from "./slackPosts.ts";

// 2026-11-13T12:00:00Z
const NOW_MS = 1_794_571_200_000;

const PNPM_POST = {
  ts: "1794500000.000100",
  text: "*All*: <https://github.com/zeroheight/rails/pull/8984|install local-mcp-server with pnpm> :pinching_hand:",
  reactions: [{ name: "eyes", count: 1, users: ["U01"] }],
};
const EDGE_POST = {
  ts: "1794400000.000100",
  text: "*Forest*: <https://github.com/zeroheight/rails/pull/8981|send only the caller's address>",
};

type Reply = { readonly status: number; readonly body: unknown };

const harness = Effect.fn("test.reviewRequestsHarness")(function* (options: {
  readonly token?: string;
  readonly replies: Array<Reply>;
}) {
  yield* TestClock.setTime(NOW_MS);
  const secrets = new Map<string, Uint8Array>();
  if (options.token !== undefined) {
    secrets.set("mod-review-requests-slack-token", new TextEncoder().encode(options.token));
  }
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      const reply = options.replies.shift() ?? { status: 500, body: {} };
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply.body, { status: reply.status }),
      );
    }),
  );
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
  // Built in the test's scope: the shared Slack stream lives as long as the layer.
  const services = yield* Layer.build(
    ReviewRequests.layer.pipe(
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    ),
  );
  const service = Context.get(services, ReviewRequests.ReviewRequests);
  const snapshots = yield* Stream.toQueue(service.posts, { capacity: "unbounded" });
  return { service, snapshots, requests, secrets };
});

const param = (request: HttpClientRequest.HttpClientRequest | undefined, name: string) =>
  request === undefined
    ? undefined
    : Option.getOrUndefined(UrlParams.getFirst(request.urlParams, name));

describe("ReviewRequests", () => {
  it.effect("reads nothing until a token is saved, then reads the last 14 days", () =>
    Effect.gen(function* () {
      const { service, snapshots, requests, secrets } = yield* harness({
        replies: [{ status: 200, body: { ok: true, messages: [PNPM_POST] } }],
      });
      expect(yield* Queue.take(snapshots)).toEqual({
        slackTokenSet: false,
        posts: [],
        slackError: null,
        fetchedAt: null,
      });
      expect(requests).toHaveLength(0);

      yield* service.setSlackToken("xoxp-test-token");
      const read = yield* Queue.take(snapshots);
      expect(read.slackTokenSet).toBe(true);
      expect(read.posts.map((post) => post.number)).toEqual([8984]);
      expect(read.fetchedAt).toBe("2026-11-13T12:00:00.000Z");
      expect(requests[0]?.headers.authorization).toBe("Bearer xoxp-test-token");
      expect(param(requests[0], "channel")).toBe("C02D9CMLKA5");
      // 14 days before NOW_MS, in seconds.
      expect(param(requests[0], "oldest")).toBe("1793361600");

      yield* service.setSlackToken(null);
      expect((yield* Queue.take(snapshots)).slackTokenSet).toBe(false);
      expect(secrets.size).toBe(0);
    }),
  );

  it.effect("follows Slack's cursor across pages", () =>
    Effect.gen(function* () {
      const { snapshots, requests } = yield* harness({
        token: "xoxp-test-token",
        replies: [
          {
            status: 200,
            body: {
              ok: true,
              messages: [PNPM_POST],
              has_more: true,
              response_metadata: { next_cursor: "page-2" },
            },
          },
          { status: 200, body: { ok: true, messages: [EDGE_POST], has_more: false } },
        ],
      });
      const read = yield* Queue.take(snapshots);
      expect(read.posts.map((post) => post.number)).toEqual([8984, 8981]);
      expect(param(requests[1], "cursor")).toBe("page-2");
    }),
  );

  it.effect("keeps the last rows and says why when a later read fails", () =>
    Effect.gen(function* () {
      const { snapshots } = yield* harness({
        token: "xoxp-test-token",
        replies: [
          { status: 200, body: { ok: true, messages: [PNPM_POST] } },
          { status: 429, body: { ok: false, error: "ratelimited" } },
          { status: 200, body: { ok: false, error: "missing_scope" } },
        ],
      });
      const first = yield* Queue.take(snapshots);

      yield* TestClock.adjust("60 seconds");
      const limited = yield* Queue.take(snapshots);
      expect(limited.posts).toEqual(first.posts);
      expect(limited.fetchedAt).toBe(first.fetchedAt);
      expect(limited.slackError).toBe(
        "Slack is rate limiting this token. Trying again in a minute.",
      );

      yield* TestClock.adjust("60 seconds");
      expect((yield* Queue.take(snapshots)).slackError).toBe(
        "The Slack token needs the channels:history scope.",
      );
    }),
  );

  it.effect(
    "drops merged, closed and draft pull requests and keeps ones GitHub could not read",
    () =>
      Effect.gen(function* () {
        const post = (number: number): PostedReviewRequest => ({
          url: `https://github.com/zeroheight/rails/pull/${number}`,
          repository: "zeroheight/rails",
          number,
          team: "All",
          postedTitle: `Post ${number}`,
          postedAt: "2026-11-12T09:00:00.000Z",
          reactions: { looking: 1, reviewed: 0 },
        });
        const summary = (
          number: number,
          state: PullRequestSummary["state"],
          isDraft: boolean,
        ): PullRequestSummary => ({
          provider: SourceControlProviderKind.make("github"),
          projectId: ProjectId.make("project-1"),
          repository: "zeroheight/rails",
          number,
          title: `Title ${number}`,
          url: `https://github.com/zeroheight/rails/pull/${number}`,
          state,
          isDraft,
          headBranch: `branch-${number}`,
          baseBranch: "main",
          updatedAt: "2026-11-12T10:00:00.000Z",
        });
        const github: Record<number, PullRequestSummary> = {
          1: summary(1, "open", false),
          2: summary(2, "merged", false),
          3: summary(3, "closed", false),
          4: summary(4, "open", true),
        };
        const status = yield* ReviewRequests.withGitHubState(
          {
            slackTokenSet: true,
            posts: [post(1), post(2), post(3), post(4), post(5)],
            slackError: null,
            fetchedAt: "2026-11-13T12:00:00.000Z",
          },
          (request) => {
            const found = github[request.number];
            return found === undefined
              ? Effect.fail({ message: "Not Found" })
              : Effect.succeed(found);
          },
        );
        expect(
          status.requests.map((request) => [request.number, request.pullRequest?.title ?? null]),
        ).toEqual([
          [1, "Title 1"],
          [5, null],
        ]);
        expect(status.githubError).toBe(
          "GitHub could not be read for 1 of 5 pull requests: Not Found",
        );
      }),
  );
});
