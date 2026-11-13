import type { ReviewRequestReactions, ReviewRequestTeam } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const SlackMessage = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  reactions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        count: Schema.Number,
        users: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
});
export type SlackMessage = typeof SlackMessage.Type;

export interface PostedReviewRequest {
  readonly url: string;
  readonly repository: string;
  readonly number: number;
  readonly team: ReviewRequestTeam;
  readonly postedTitle: string | null;
  readonly postedAt: string;
  readonly reactions: ReviewRequestReactions;
}

const TEAMS: Readonly<Record<string, ReviewRequestTeam>> = { all: "All", forest: "Forest" };

const REACTIONS = { eyes: "looking", white_check_mark: "reviewed" } as const;

// `*All*:`, `*All:*` and `Comet:` all name a team.
const TEAM_PREFIX = /^\s*(?:\*([^*\n]+)\*|([A-Za-z][A-Za-z ]*):)/;

// Slack mrkdwn links read `<url|label>` or `<url>`.
const PULL_REQUEST_LINK =
  /<(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+))[^|>]*(?:\|([^>]*))?>/;

const unescapeSlack = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const teamOf = (text: string): ReviewRequestTeam | null => {
  const match = TEAM_PREFIX.exec(text);
  const name = (match?.[1] ?? match?.[2])?.replace(/:\s*$/, "").trim().toLowerCase();
  return name === undefined ? null : (TEAMS[name] ?? null);
};

const postedAtOf = (ts: string) => DateTime.formatIso(DateTime.makeUnsafe(Number(ts) * 1000));

interface Tally {
  readonly users: Set<string>;
  /** Reactions Slack counted without listing who made them. */
  unlisted: number;
}

/**
 * The All and Forest posts that link a GitHub pull request, one per pull request, newest first.
 * A pull request posted twice keeps its newest post and counts each reacting person once.
 */
export function parseReviewRequests(
  messages: ReadonlyArray<SlackMessage>,
): ReadonlyArray<PostedReviewRequest> {
  const byKey = new Map<
    string,
    { post: PostedReviewRequest; tallies: Record<keyof ReviewRequestReactions, Tally> }
  >();
  const newestFirst = messages.toSorted((a, b) => Number(b.ts) - Number(a.ts));
  for (const message of newestFirst) {
    const text = message.text ?? "";
    const team = teamOf(text);
    const link = team === null ? null : PULL_REQUEST_LINK.exec(text);
    if (team === null || !link) continue;
    const [, url = "", repository = "", number = ""] = link;
    const key = `${repository.toLowerCase()}#${number}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      const label = link[4] === undefined ? "" : unescapeSlack(link[4]).trim();
      entry = {
        post: {
          url,
          repository,
          number: Number(number),
          team,
          postedTitle: label === "" ? null : label,
          postedAt: postedAtOf(message.ts),
          reactions: { looking: 0, reviewed: 0 },
        },
        tallies: {
          looking: { users: new Set(), unlisted: 0 },
          reviewed: { users: new Set(), unlisted: 0 },
        },
      };
      byKey.set(key, entry);
    }
    for (const reaction of message.reactions ?? []) {
      const kind = REACTIONS[reaction.name as keyof typeof REACTIONS];
      if (kind === undefined) continue;
      const tally = entry.tallies[kind];
      const users = reaction.users ?? [];
      for (const user of users) tally.users.add(user);
      tally.unlisted += Math.max(0, reaction.count - users.length);
    }
  }
  return [...byKey.values()].map(({ post, tallies }) => ({
    ...post,
    reactions: {
      looking: tallies.looking.users.size + tallies.looking.unlisted,
      reviewed: tallies.reviewed.users.size + tallies.reviewed.unlisted,
    },
  }));
}
