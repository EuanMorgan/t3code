import { describe, expect, it } from "@effect/vitest";

import { parseReviewRequests, type SlackMessage } from "./slackPosts.ts";

// Message text as conversations.history returns it from #eng-review-requests.
const ALL_PNPM: SlackMessage = {
  ts: "1762900000.000100",
  text: "*All*: <https://github.com/zeroheight/rails/pull/8984|install local-mcp-server with pnpm in mcp_e2e when it has a pnpm lockfile> :pinching_hand:",
  reactions: [{ name: "eyes", count: 1, users: ["U01"] }],
};
const FOREST_EDGE: SlackMessage = {
  ts: "1762890000.000200",
  text: "*Forest*: <https://github.com/zeroheight/rails/pull/8981|send only the caller's address as X-Forwarded-For from the edge> :pinching_hand:",
};
const ALL_COLON_IN_BOLD: SlackMessage = {
  ts: "1762880000.000300",
  text: "*All:* <https://github.com/zeroheight/rails/pull/8983|Clean up add design file modal FF>",
  reactions: [{ name: "white_check_mark", count: 1, users: ["U02"] }],
};
const COMET_PLAIN: SlackMessage = {
  ts: "1762870000.000400",
  text: "Comet: <https://github.com/zeroheight/rails/pull/8973|Group agent events by trigger (figma sync)>",
  reactions: [{ name: "eyes", count: 2, users: ["U01", "U03"] }],
};
const COMET_BOLD_OTHER_REPO: SlackMessage = {
  ts: "1762860000.000500",
  text: "*Comet:* <https://github.com/zeroheight/serverless/pull/320|Describe is_category as a category overview page>",
};

describe("parseReviewRequests", () => {
  it("keeps All and Forest posts, newest first, and drops Comet in either spelling", () => {
    expect(
      parseReviewRequests([
        COMET_BOLD_OTHER_REPO,
        ALL_COLON_IN_BOLD,
        FOREST_EDGE,
        COMET_PLAIN,
        ALL_PNPM,
      ]),
    ).toEqual([
      {
        url: "https://github.com/zeroheight/rails/pull/8984",
        repository: "zeroheight/rails",
        number: 8984,
        team: "All",
        postedTitle: "install local-mcp-server with pnpm in mcp_e2e when it has a pnpm lockfile",
        postedAt: "2025-11-11T22:26:40.000Z",
        reactions: { looking: 1, reviewed: 0 },
      },
      {
        url: "https://github.com/zeroheight/rails/pull/8981",
        repository: "zeroheight/rails",
        number: 8981,
        team: "Forest",
        postedTitle: "send only the caller's address as X-Forwarded-For from the edge",
        postedAt: "2025-11-11T19:40:00.000Z",
        reactions: { looking: 0, reviewed: 0 },
      },
      {
        url: "https://github.com/zeroheight/rails/pull/8983",
        repository: "zeroheight/rails",
        number: 8983,
        team: "All",
        postedTitle: "Clean up add design file modal FF",
        postedAt: "2025-11-11T16:53:20.000Z",
        reactions: { looking: 0, reviewed: 1 },
      },
    ]);
  });

  it("keeps one row for a pull request posted twice and counts each person once", () => {
    const repost: SlackMessage = {
      ts: "1762950000.000100",
      text: "*Forest*: <https://github.com/zeroheight/rails/pull/8984|pnpm in mcp_e2e, again>",
      reactions: [
        { name: "eyes", count: 2, users: ["U01", "U04"] },
        { name: "white_check_mark", count: 1, users: ["U05"] },
      ],
    };
    expect(parseReviewRequests([ALL_PNPM, repost])).toEqual([
      {
        url: "https://github.com/zeroheight/rails/pull/8984",
        repository: "zeroheight/rails",
        number: 8984,
        team: "Forest",
        postedTitle: "pnpm in mcp_e2e, again",
        postedAt: "2025-11-12T12:20:00.000Z",
        reactions: { looking: 2, reviewed: 1 },
      },
    ]);
  });

  it("counts reactions Slack did not list users for", () => {
    const [request] = parseReviewRequests([
      {
        ts: "1762900000.000100",
        text: "*All*: <https://github.com/zeroheight/rails/pull/1>",
        reactions: [{ name: "eyes", count: 3, users: ["U01"] }],
      },
      {
        ts: "1762800000.000100",
        text: "*All*: <https://github.com/zeroheight/rails/pull/1>",
        reactions: [{ name: "eyes", count: 1, users: ["U01"] }],
      },
    ]);
    expect(request?.reactions).toEqual({ looking: 3, reviewed: 0 });
    expect(request?.postedTitle).toBeNull();
  });

  it("skips posts without a team prefix or a GitHub pull request link", () => {
    expect(
      parseReviewRequests([
        { ts: "1", text: "<https://github.com/zeroheight/rails/pull/2|no prefix>" },
        { ts: "2", text: "*All*: please look at the release notes" },
        { ts: "3", text: "*Note*: <https://github.com/zeroheight/rails/pull/3|not a team>" },
        { ts: "4" },
      ]),
    ).toEqual([]);
  });

  it("decodes Slack's escaped characters in the link text", () => {
    const [request] = parseReviewRequests([
      {
        ts: "1762900000.000100",
        text: "*All*: <https://github.com/zeroheight/rails/pull/5|Fix &lt;Modal&gt; &amp; tests>",
      },
    ]);
    expect(request?.postedTitle).toBe("Fix <Modal> & tests");
  });
});
