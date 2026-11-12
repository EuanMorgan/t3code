import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";

export type AgentWorkThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "archivedAt" | "status" | "activityRunStatus" | "pendingRuntimeRequest"
>;

export class AgentWorkSourceError extends Schema.TaggedError<AgentWorkSourceError>()(
  "AgentWorkSourceError",
  { cause: Schema.Defect() },
) {}

export class AgentWorkSource extends Context.Service<
  AgentWorkSource,
  {
    /** Every active listed thread, or only `threadId` when given. */
    readonly threads: (
      threadId?: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AgentWorkThread>, AgentWorkSourceError>;
    /** Threads whose run or pending request may have changed. */
    readonly changedThreadIds: Stream.Stream<ThreadId>;
  }
>()("t3/mods/keepAwake/AgentWorkSource") {}

const changesRunState = (event: OrchestrationV2DomainEvent) => {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
};

export const layer = Layer.effect(
  AgentWorkSource,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return AgentWorkSource.of({
      threads: Effect.fn("AgentWorkSource.threads")(function* (threadId?: ThreadId) {
        const snapshot = yield* threads
          .getAgentAwarenessSnapshot(threadId)
          .pipe(Effect.mapError((cause) => new AgentWorkSourceError({ cause })));
        return snapshot.threads;
      }),
      changedThreadIds: threads.streamDomainEvents.pipe(
        Stream.filter(changesRunState),
        Stream.map((event) => event.threadId),
        Stream.tapCause((cause) =>
          Effect.logWarning("Keep Awake lost the orchestration event stream", { cause }),
        ),
        Stream.retry(Schedule.spaced("5 seconds")),
        Stream.orDie,
      ),
    });
  }),
);
