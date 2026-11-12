import { KEEP_AWAKE_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { readPrimaryEnvironmentId } from "../../state/environments";

export const keepAwakeStatus = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mods:keep-awake:status",
  tag: KEEP_AWAKE_METHODS.subscribe,
});

export const setKeepAwake = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mods:keep-awake:set",
  tag: KEEP_AWAKE_METHODS.set,
});

export function turnKeepAwakeOff(registry: AtomRegistry.AtomRegistry) {
  const environmentId = readPrimaryEnvironmentId();
  if (environmentId === null) return;
  void runAtomCommand(
    registry,
    setKeepAwake,
    { environmentId, input: { mode: { _tag: "Off" } } },
    { label: setKeepAwake.label, reportFailure: false, reportDefect: false },
  );
}
