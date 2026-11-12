import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useContext } from "react";

import type { CommandPaletteActionItem } from "../components/CommandPalette.logic";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { KeepAwakeButton } from "./keepAwake/KeepAwakeButton";
import { turnKeepAwakeOff } from "./keepAwake/state";
import { useRefreshSkillsAction } from "./refreshSkills/useRefreshSkillsAction";
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

export function ModsSettingsSection() {
  const { isEnabled, setEnabled } = useModsEnabled();
  const registry = useContext(RegistryContext);
  return (
    <SettingsSection id="plugins" title="Plugins">
      {MODS.map((mod) => (
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
        />
      ))}
    </SettingsSection>
  );
}
