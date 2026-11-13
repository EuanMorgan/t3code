import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { calendarStatus, setCalendarFeed } from "./state";

export function CalendarSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const { data: status } = useEnvironmentQuery(
    environmentId === null ? null : calendarStatus({ environmentId, input: {} }),
  );
  const setFeed = useAtomCommand(setCalendarFeed, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (environmentId === null || status === null) return null;

  const save = async (url: string | null) => {
    setSaving(true);
    setSaveError(null);
    const result = await setFeed({ environmentId, input: { url } });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft("");
      return;
    }
    const failure = squashAtomCommandFailure(result);
    setSaveError(failure instanceof Error ? failure.message : "Couldn't save the link.");
  };

  const message = saveError ?? status.error;

  return (
    <div className="flex flex-col gap-2 pt-2">
      {status.configured ? (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Google Calendar is connected.</span>
          <Button disabled={saving} onClick={() => void save(null)} size="xs" variant="outline">
            Remove link
          </Button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") void save(draft);
          }}
        >
          <Input
            aria-label="Google Calendar iCal link"
            className="flex-1"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Secret address in iCal format"
            size="sm"
            type="url"
            value={draft}
          />
          <Button disabled={saving || draft.trim() === ""} size="sm" type="submit">
            Save
          </Button>
        </form>
      )}
      <p className="text-xs text-muted-foreground">
        {message ??
          "In Google Calendar, open Settings, pick your calendar, and copy “Secret address in iCal format”."}
      </p>
    </div>
  );
}
