import { REVIEW_REQUESTS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const reviewRequestsStatus = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "mods:review-requests:status",
    tag: REVIEW_REQUESTS_METHODS.subscribe,
    // The server reads Slack only while subscribed, so let go soon after the tab closes.
    idleTtlMs: 5_000,
  },
);

export const refreshReviewRequests = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mods:review-requests:refresh",
  tag: REVIEW_REQUESTS_METHODS.refresh,
});

export const setReviewRequestsSlackToken = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mods:review-requests:set-slack-token",
  tag: REVIEW_REQUESTS_METHODS.setSlackToken,
});
