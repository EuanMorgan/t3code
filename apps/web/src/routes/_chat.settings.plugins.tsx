import { createFileRoute } from "@tanstack/react-router";

import { ModsSettingsPanel } from "~/mods";

export const Route = createFileRoute("/_chat/settings/plugins")({ component: ModsSettingsPanel });
