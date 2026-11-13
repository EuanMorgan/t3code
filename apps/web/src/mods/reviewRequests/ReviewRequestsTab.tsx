import type { EnvironmentId, ReviewRequest } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { RelativeTime } from "../../components/RelativeTime";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "../../components/pullRequest/PullRequestListRow";
import { PullRequestReviewDecisionGlyph } from "../../components/pullRequest/pullRequestPresentation";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import {
  PULL_REQUESTS_PANEL_REF,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { refreshReviewRequests, reviewRequestsStatus, setReviewRequestsSlackToken } from "./state";

const PullRequestsTab = Schema.Literals(["pull-requests", "review-requests"]);

/** Wraps the Pull requests page's list with a tab for the team's Slack review requests. */
export function ReviewRequestsTabs({ list, search }: { list: ReactNode; search: string }) {
  const [tab, setTab] = useLocalStorage(
    "t3code:mods:review-requests:tab",
    "pull-requests",
    PullRequestsTab,
  );
  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        aria-label="Pull request list"
        className="self-start"
        value={[tab]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "pull-requests" || value === "review-requests") setTab(value);
        }}
      >
        <Toggle value="pull-requests">Pull requests</Toggle>
        <Toggle value="review-requests">Review requests</Toggle>
      </ToggleGroup>
      {tab === "review-requests" ? <ReviewRequestsList search={search} /> : list}
    </div>
  );
}

function ReviewRequestsList({ search }: { search: string }) {
  const environmentId = usePrimaryEnvironmentId();
  const { data: status, error } = useEnvironmentQuery(
    environmentId === null ? null : reviewRequestsStatus({ environmentId, input: {} }),
  );
  const refresh = useAtomCommand(refreshReviewRequests);
  const [editingToken, setEditingToken] = useState(false);

  if (environmentId === null) return null;
  if (status === null) {
    return error === null ? null : <Notice variant="error">{error}</Notice>;
  }
  if (!status.slackTokenSet || editingToken) {
    return (
      <SlackTokenForm
        environmentId={environmentId}
        replacing={status.slackTokenSet}
        onDone={() => setEditingToken(false)}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const requests =
    query === ""
      ? status.requests
      : status.requests.filter((request) =>
          [
            request.pullRequest?.title ?? request.postedTitle ?? "",
            request.pullRequest?.author?.login ?? "",
            request.repository,
            `#${request.number}`,
          ].some((text) => text.toLowerCase().includes(query)),
        );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          From #eng-review-requests, All and Forest, last 14 days
          {status.fetchedAt === null ? null : (
            <>
              {" · updated "}
              <RelativeTime timestamp={status.fetchedAt} />
            </>
          )}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setEditingToken(true)}>
          Slack token
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh review requests"
          onClick={() => void refresh({ environmentId, input: {} })}
        >
          <RefreshIcon size="md" refreshing={false} />
        </Button>
      </div>
      {status.slackError === null ? null : <Notice variant="error">{status.slackError}</Notice>}
      {status.githubError === null ? null : <Notice variant="warning">{status.githubError}</Notice>}
      {requests.length === 0 && (status.fetchedAt !== null || status.slackError === null) ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {status.fetchedAt === null
            ? "Reading Slack…"
            : query === ""
              ? "No open pull requests are waiting for review."
              : "No review requests match the search."}
        </p>
      ) : (
        <div className="flex flex-col">
          {requests.map((request) => (
            <ReviewRequestRow
              key={`${request.repository}#${request.number}`}
              environmentId={environmentId}
              request={request}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Notice({ variant, children }: { variant: "error" | "warning"; children: ReactNode }) {
  return (
    <Alert variant={variant}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function SlackTokenForm({
  environmentId,
  replacing,
  onDone,
}: {
  environmentId: EnvironmentId;
  replacing: boolean;
  onDone: () => void;
}) {
  const setToken = useAtomCommand(setReviewRequestsSlackToken);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (token: string | null) => {
    setSaving(true);
    const result = await setToken({ environmentId, input: { token } });
    setSaving(false);
    if (result._tag === "Success") {
      setValue("");
      onDone();
    }
  };
  const trimmed = value.trim();
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "") void save(trimmed);
      }}
    >
      <p className="text-sm">
        {replacing ? "Replace the Slack token" : "Paste a Slack user token to list review requests"}
      </p>
      <p className="text-xs text-muted-foreground">
        A user token (xoxp-…) with the channels:history scope. It stays on this server.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Slack user token"
          autoComplete="off"
          className="min-w-0 flex-1"
          placeholder="xoxp-…"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={saving || !/^xox[a-z]-[\w-]+$/.test(trimmed)}>
          Save
        </Button>
        {replacing ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Remove
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}

function ReviewRequestRow({
  environmentId,
  request,
}: {
  environmentId: EnvironmentId;
  request: ReviewRequest;
}) {
  const navigate = useNavigate({ from: "/pull-requests" });
  const openLink = useOpenLink(null);
  const selected = useRightPanelStore((state) => {
    if (!selectThreadRightPanelState(state.byThreadKey, PULL_REQUESTS_PANEL_REF).isOpen) {
      return false;
    }
    const surface = selectSelectedRightPanelSurface(state.byThreadKey, PULL_REQUESTS_PANEL_REF);
    return (
      surface?.kind === "pull-request" &&
      surface.number === request.number &&
      surface.repository.toLowerCase() === request.repository.toLowerCase()
    );
  });
  const pullRequest = request.pullRequest;

  const open = () => {
    if (pullRequest === null) {
      void openLink(request.url);
      return;
    }
    useRightPanelStore.getState().openPullRequest(PULL_REQUESTS_PANEL_REF, {
      environmentId,
      projectId: pullRequest.projectId,
      host: "github.com",
      repository: pullRequest.repository,
      number: pullRequest.number,
    });
    void navigate({
      search: (previous) => ({
        ...previous,
        repository: pullRequest.repository,
        number: pullRequest.number,
        selectedProjectId: pullRequest.projectId,
        selectedEnvironmentId: environmentId,
        selectedHost: "github.com",
      }),
      replace: true,
    });
  };

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={open}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "cursor-pointer px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <PullRequestRowGlyph
        state={pullRequest?.state ?? "open"}
        isDraft={false}
        mergeability={pullRequest?.mergeability}
        baseBranch={pullRequest?.baseBranch}
        className="mt-0.75 self-start"
      />
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{request.number}</span>}
        title={pullRequest?.title ?? request.postedTitle ?? request.url}
        signals={
          pullRequest?.reviewDecision == null ? null : (
            <PullRequestReviewDecisionGlyph decision={pullRequest.reviewDecision} />
          )
        }
        status={<ReactionCounts reactions={request.reactions} />}
        meta={
          <>
            {pullRequest?.author === undefined ? null : (
              <PullRequestRowAuthor actor={pullRequest.author} className="min-w-3.5 max-w-40" />
            )}
            <span className="truncate">{request.repository}</span>
            <span className="shrink-0 rounded-full border border-border/60 px-1.5">
              {request.team}
            </span>
          </>
        }
        updatedAt={request.postedAt}
      />
    </button>
  );
}

function ReactionCounts({ reactions }: { reactions: ReviewRequest["reactions"] }) {
  return (
    <>
      {reactions.looking > 0 ? (
        <ReactionCount emoji="👀" count={reactions.looking} label="looking at it" />
      ) : null}
      {reactions.reviewed > 0 ? (
        <ReactionCount emoji="✅" count={reactions.reviewed} label="reviewed it" />
      ) : null}
    </>
  );
}

function ReactionCount({ emoji, count, label }: { emoji: string; count: number; label: string }) {
  const text = `${count} ${count === 1 ? "person" : "people"} ${label}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-0.5 tabular-nums" />}
        aria-label={text}
      >
        <span aria-hidden>{emoji}</span>
        {count}
      </TooltipTrigger>
      <TooltipPopup side="top">{text}</TooltipPopup>
    </Tooltip>
  );
}
