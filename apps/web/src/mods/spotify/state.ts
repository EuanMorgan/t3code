import { SPOTIFY_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const spotifyStatus = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mods:spotify:status",
  tag: SPOTIFY_METHODS.subscribe,
});

export const controlSpotify = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mods:spotify:control",
  tag: SPOTIFY_METHODS.control,
});
