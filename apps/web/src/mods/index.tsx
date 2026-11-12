import { RegistryContext } from "@effect/atom-react";
import { useContext } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { KeepAwakeButton } from "./keepAwake/KeepAwakeButton";
import { turnKeepAwakeOff } from "./keepAwake/state";
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
];

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
