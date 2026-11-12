import type { AtomRegistry } from "effect/reactivity";
import * as Schema from "effect/Schema";
import type { ComponentType } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";

export interface WebMod {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly SidebarHeaderItem?: ComponentType<{ readonly onBackdrop: boolean }>;
  readonly onDisable?: (registry: AtomRegistry.AtomRegistry) => void;
}

const MODS_ENABLED_KEY = "t3code:mods:enabled";
const ModsEnabled = Schema.Record(Schema.String, Schema.Boolean);

/** Mods are on until switched off, so a missing entry means on. */
export function useModsEnabled() {
  const [enabled, setEnabled] = useLocalStorage(MODS_ENABLED_KEY, {}, ModsEnabled);
  return {
    isEnabled: (id: string) => enabled[id] !== false,
    setEnabled: (id: string, on: boolean) => setEnabled((current) => ({ ...current, [id]: on })),
  };
}
