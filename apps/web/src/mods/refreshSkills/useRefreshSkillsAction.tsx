import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { RefreshCwIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { useProjectLookups } from "../../components/CommandPaletteLookups";
import { toastManager } from "../../components/ui/toast";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function useRefreshSkillsAction(
  thread: EnvironmentThreadShell | null,
): CommandPaletteActionItem | null {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { projectByKey } = useProjectLookups();
  if (thread === null) return null;
  const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
  if (!project) return null;
  return {
    kind: "action",
    value: "action:mods:refresh-skills",
    searchTerms: ["refresh", "reload", "rescan", "skills", "commands", "plugins"],
    title: "Refresh skills",
    icon: <RefreshCwIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      const refreshed = await refreshProviders({
        environmentId: thread.environmentId,
        input: {
          instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
          cwd: thread.worktreePath ?? project.workspaceRoot,
          fresh: true,
        },
      });
      if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      toastManager.add({ type: "success", title: "Skills refreshed" });
    },
  };
}
