import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useContext } from "react";

import type { CommandPaletteActionItem } from "../components/CommandPalette.logic";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { CalendarSettings } from "./calendar/CalendarSettings";
import { NextMeetingCard } from "./calendar/NextMeetingCard";
import { KeepAwakeButton } from "./keepAwake/KeepAwakeButton";
import { turnKeepAwakeOff } from "./keepAwake/state";
import { useRefreshSkillsAction } from "./refreshSkills/useRefreshSkillsAction";
import { SpotifyNowPlaying } from "./spotify/SpotifyNowPlaying";
import { useModsEnabled, type WebMod } from "./registry";

const MODS: ReadonlyArray<WebMod> = [
  {
    id: "keepAwake",
    name: "Keep Awake",
    description:
      "A sidebar button that keeps the Mac running T3 Code awake: until you turn it off, for a set time, or until agents finish.",
    SidebarHeaderItem: KeepAwakeButton,
    onDisable: turnKeepAwakeOff,
  },
  {
    id: "refreshSkills",
    name: "Refresh skills",
    description:
      "A command palette action that rescans the open thread's skills without restarting the agent.",
  },
  {
    id: "spotify",
    name: "Spotify",
    description:
      "Shows the song playing in Spotify on the Mac running T3 Code at the bottom of the sidebar, with play, pause and skip buttons.",
    SidebarFooterItem: SpotifyNowPlaying,
  },
  {
    id: "calendar",
    name: "Next meeting",
    description:
      "Shows your next Google Calendar meeting in the next day at the bottom of the sidebar, with a button to join it.",
    SidebarFooterItem: NextMeetingCard,
    SettingsItem: CalendarSettings,
  },
];

export function useModCommandPaletteActions(
  thread: EnvironmentThreadShell | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const { isEnabled } = useModsEnabled();
  const refreshSkills = useRefreshSkillsAction(thread);
  return refreshSkills !== null && isEnabled("refreshSkills") ? [refreshSkills] : [];
}

export function ModSidebarHeaderSlot({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const { isEnabled } = useModsEnabled();
  return MODS.map(({ id, SidebarHeaderItem }) =>
    SidebarHeaderItem !== undefined && isEnabled(id) ? (
      <SidebarHeaderItem key={id} onBackdrop={onBackdrop} />
    ) : null,
  );
}

export function ModSidebarFooterSlot() {
  const { isEnabled } = useModsEnabled();
  return MODS.map(({ id, SidebarFooterItem }) =>
    SidebarFooterItem !== undefined && isEnabled(id) ? <SidebarFooterItem key={id} /> : null,
  );
}

export function ModsSettingsPanel() {
  const { isEnabled, setEnabled } = useModsEnabled();
  const registry = useContext(RegistryContext);
  return (
    <SettingsPageContainer>
      <SettingsSection id="plugins" title="Plugins">
        {MODS.map(({ SettingsItem, ...mod }) => (
          <SettingsRow
            key={mod.id}
            title={mod.name}
            description={mod.description}
            control={
              <Switch
                aria-label={mod.name}
                checked={isEnabled(mod.id)}
                onCheckedChange={(checked) => {
                  setEnabled(mod.id, checked);
                  if (!checked) mod.onDisable?.(registry);
                }}
              />
            }
          >
            {SettingsItem !== undefined && isEnabled(mod.id) ? <SettingsItem /> : null}
          </SettingsRow>
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
