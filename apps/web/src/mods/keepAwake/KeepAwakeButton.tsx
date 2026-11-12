import type { KeepAwakeMode, KeepAwakeSetInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, CoffeeIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Group } from "../../components/ui/group";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { keepAwakeStatus, setKeepAwake } from "./state";

const TIMED_OPTIONS = [
  { label: "For 1 hour", minutes: 60 },
  { label: "For 2 hours", minutes: 120 },
  { label: "For 4 hours", minutes: 240 },
] as const;

const formatRemaining = (endsAt: DateTime.Utc, nowMs: number) => {
  const minutes = Math.max(1, Math.ceil((endsAt.epochMilliseconds - nowMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

const describeKeepAwake = (mode: KeepAwakeMode, nowMs: number) => {
  switch (mode._tag) {
    case "Off":
      return "Keep Mac awake";
    case "Manual":
      return "Awake until you turn it off";
    case "Timed":
      return `Awake for ${formatRemaining(mode.endsAt, nowMs)} more`;
    case "AgentsFinish":
      return "Awake until agents finish";
  }
};

export function KeepAwakeButton({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  const { data: status } = useEnvironmentQuery(
    environmentId === null ? null : keepAwakeStatus({ environmentId, input: {} }),
  );
  const set = useAtomCommand(setKeepAwake);
  // Remaining time is read when a tooltip or the menu opens, so nothing repaints on a timer.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const refreshNow = (open: boolean) => {
    if (open) setOpenedAt(Date.now());
  };

  if (environmentId === null || status === null || !status.supported) return null;

  const { mode, keepScreenOn } = status.state;
  const on = mode._tag !== "Off";
  const description = describeKeepAwake(mode, openedAt);
  const send = (input: KeepAwakeSetInput) => void set({ environmentId, input });
  const restingVariant = onBackdrop ? "media-navigation" : "ghost";

  return (
    <Group aria-label="Keep Mac awake" className="[-webkit-app-region:no-drag]">
      <Tooltip onOpenChange={refreshNow}>
        <TooltipTrigger
          render={
            <Button
              aria-label={description}
              aria-pressed={on}
              className={cn(!on && onBackdrop && "relative top-auto translate-y-0")}
              onClick={() => send({ mode: on ? { _tag: "Off" } : { _tag: "Manual" } })}
              size="icon-sm"
              variant={on ? "default" : restingVariant}
            />
          }
        >
          <CoffeeIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{description}</TooltipPopup>
      </Tooltip>
      <Menu onOpenChange={refreshNow}>
        <MenuTrigger
          render={
            <Button
              aria-label="Keep awake options"
              className={cn(!on && onBackdrop && "relative top-auto translate-y-0")}
              size="icon-sm"
              variant={on ? "default" : restingVariant}
            />
          }
        >
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <MenuPopup align="end" width="content">
          <MenuGroup>
            <MenuGroupLabel>{on ? description : "Keep Mac awake"}</MenuGroupLabel>
            {TIMED_OPTIONS.map((option) => (
              <MenuItem
                key={option.minutes}
                onClick={() => send({ mode: { _tag: "For", minutes: option.minutes } })}
              >
                {option.label}
              </MenuItem>
            ))}
            <MenuItem
              disabled={!status.agentsWorking && mode._tag !== "AgentsFinish"}
              onClick={() => send({ mode: { _tag: "AgentsFinish" } })}
            >
              Until agents finish
            </MenuItem>
            <MenuItem onClick={() => send({ mode: { _tag: "Manual" } })}>
              Until I turn it off
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuCheckboxItem
            checked={keepScreenOn}
            onCheckedChange={(checked) => send({ keepScreenOn: Boolean(checked) })}
            variant="switch"
          >
            Keep screen on
          </MenuCheckboxItem>
          {on ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => send({ mode: { _tag: "Off" } })}>Turn off</MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
