import type { CalendarEvent } from "@t3tools/contracts";
import { CalendarIcon, VideoIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useNowMinute } from "../../hooks/useNowMinute";
import { readLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { calendarStatus } from "./state";

const clockTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const describeWhen = (event: CalendarEvent, now: number) => {
  const startsAt = event.startsAt.epochMilliseconds;
  if (startsAt <= now) return `Now · ends ${clockTime.format(event.endsAt.epochMilliseconds)}`;
  const minutes = Math.ceil((startsAt - now) / 60_000);
  return minutes < 60
    ? `In ${minutes} min · ${clockTime.format(startsAt)}`
    : `At ${clockTime.format(startsAt)}`;
};

export function NextMeetingCard() {
  const environmentId = usePrimaryEnvironmentId();
  const { data: status } = useEnvironmentQuery(
    environmentId === null ? null : calendarStatus({ environmentId, input: {} }),
  );
  const now = Date.parse(useNowMinute());
  const event = status?.events.find((candidate) => candidate.endsAt.epochMilliseconds > now);
  if (event === undefined) return null;

  const startsSoon = event.startsAt.epochMilliseconds - now <= 10 * 60_000;
  const joinUrl = event.joinUrl;

  return (
    <div
      aria-label="Next meeting"
      className="flex items-center gap-2 rounded-lg bg-sidebar-control-surface p-1.5"
      role="group"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <CalendarIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-xs font-medium text-sidebar-foreground">{event.title}</div>
        <div className="truncate text-2xs text-muted-foreground">{describeWhen(event, now)}</div>
      </div>
      {joinUrl === null ? null : (
        <Button
          aria-label={`Join ${event.title}`}
          className="shrink-0"
          onClick={() => void readLocalApi()?.shell.openExternal(joinUrl)}
          size="xs"
          variant={startsSoon ? "default" : "ghost"}
        >
          <VideoIcon />
          Join
        </Button>
      )}
    </div>
  );
}
