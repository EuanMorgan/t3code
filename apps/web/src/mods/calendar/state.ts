import { CALENDAR_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const calendarStatus = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mods:calendar:status",
  tag: CALENDAR_METHODS.subscribe,
});

export const setCalendarFeed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mods:calendar:set-feed",
  tag: CALENDAR_METHODS.setFeed,
});
