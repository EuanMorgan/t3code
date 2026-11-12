import {
  isListedThreadLineage,
  KeepAwakeState,
  KeepAwakeUnsupportedError,
  type KeepAwakeMode,
  type KeepAwakeSetInput,
  type KeepAwakeStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import { forkParked } from "../../serverActivation.ts";
import * as AgentWorkSource from "./AgentWorkSource.ts";
import * as CaffeinateProcess from "./CaffeinateProcess.ts";

export class KeepAwake extends Context.Service<
  KeepAwake,
  {
    /** The current status, then every change. */
    readonly status: Stream.Stream<KeepAwakeStatus>;
    readonly set: (
      input: KeepAwakeSetInput,
    ) => Effect.Effect<KeepAwakeStatus, KeepAwakeUnsupportedError>;
  }
>()("t3/mods/keepAwake/KeepAwake") {}

/** Threads auto-continue after a restart; a restored "until agents finish" waits this long for one. */
const RESTORED_AGENTS_FINISH_GRACE = Duration.minutes(2);

interface KeepAwakeRuntimeState {
  readonly state: KeepAwakeState;
  readonly agentsWorking: boolean;
}

type KeepAwakeEvent =
  | { readonly _tag: "Restored"; readonly state: KeepAwakeState }
  | { readonly _tag: "Requested"; readonly input: KeepAwakeSetInput }
  | { readonly _tag: "AgentsWorking"; readonly working: boolean }
  | { readonly _tag: "DeadlineReached" };

const OFF_STATE: KeepAwakeState = { mode: { _tag: "Off" }, keepScreenOn: false };

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Matches the sidebar's Working shelf: a turn waiting on the user counts as finished. */
const isAgentWorking = (thread: AgentWorkSource.AgentWorkThread): boolean =>
  isListedThreadLineage(thread.lineage) &&
  thread.archivedAt === null &&
  (thread.pendingRuntimeRequest === null || thread.pendingRuntimeRequest.kind === "auth_refresh") &&
  ACTIVE_RUN_STATUSES.has(thread.activityRunStatus ?? thread.status);

const settleMode = (mode: KeepAwakeMode, agentsWorking: boolean, now: DateTime.Utc) => {
  switch (mode._tag) {
    case "Timed":
      return DateTime.isLessThanOrEqualTo(mode.endsAt, now) ? OFF_STATE.mode : mode;
    case "AgentsFinish":
      if (agentsWorking) return { _tag: "AgentsFinish" } as const;
      return mode.resumeBy !== undefined && DateTime.isGreaterThan(mode.resumeBy, now)
        ? mode
        : OFF_STATE.mode;
    case "Off":
    case "Manual":
      return mode;
  }
};

const requestedMode = (
  request: NonNullable<KeepAwakeSetInput["mode"]>,
  now: DateTime.Utc,
): KeepAwakeMode => {
  switch (request._tag) {
    case "Off":
    case "Manual":
      return request;
    case "For":
      return { _tag: "Timed", endsAt: DateTime.add(now, { minutes: request.minutes }) };
    case "AgentsFinish":
      return { _tag: "AgentsFinish" };
  }
};

const restoredMode = (mode: KeepAwakeMode, now: DateTime.Utc): KeepAwakeMode =>
  mode._tag === "AgentsFinish"
    ? { _tag: "AgentsFinish", resumeBy: DateTime.addDuration(now, RESTORED_AGENTS_FINISH_GRACE) }
    : mode;

const transition = (
  current: KeepAwakeRuntimeState,
  event: KeepAwakeEvent,
  now: DateTime.Utc,
): KeepAwakeRuntimeState => {
  const next = ((): KeepAwakeRuntimeState => {
    switch (event._tag) {
      case "Restored":
        return { ...current, state: { ...event.state, mode: restoredMode(event.state.mode, now) } };
      case "Requested":
        return {
          ...current,
          state: {
            mode:
              event.input.mode === undefined
                ? current.state.mode
                : requestedMode(event.input.mode, now),
            keepScreenOn: event.input.keepScreenOn ?? current.state.keepScreenOn,
          },
        };
      case "AgentsWorking":
        return { ...current, agentsWorking: event.working };
      case "DeadlineReached":
        return current;
    }
  })();
  return {
    ...next,
    state: { ...next.state, mode: settleMode(next.state.mode, next.agentsWorking, now) },
  };
};

const deadlineOf = (mode: KeepAwakeMode): DateTime.Utc | null => {
  switch (mode._tag) {
    case "Timed":
      return mode.endsAt;
    case "AgentsFinish":
      return mode.resumeBy ?? null;
    case "Off":
    case "Manual":
      return null;
  }
};

const modeKey = (mode: KeepAwakeMode) => {
  const deadline = deadlineOf(mode);
  return deadline === null ? mode._tag : `${mode._tag}@${deadline.epochMilliseconds}`;
};

const caffeinateArgs = (state: KeepAwakeState): ReadonlyArray<string> | null =>
  state.mode._tag === "Off"
    ? null
    : // -w ends the assertion with this server, so a crash can never leave the Mac awake.
      [state.keepScreenOn ? "-di" : "-i", "-w", String(process.pid)];

const sameArgs = (a: ReadonlyArray<string> | null, b: ReadonlyArray<string> | null) =>
  a?.join(" ") === b?.join(" ");

const sameState = (a: KeepAwakeState, b: KeepAwakeState) =>
  modeKey(a.mode) === modeKey(b.mode) && a.keepScreenOn === b.keepScreenOn;

const KeepAwakeStateJson = Schema.fromJsonString(Schema.toCodecJson(KeepAwakeState));
const decodeStateFile = Schema.decodeUnknownEffect(KeepAwakeStateJson);
const encodeStateFile = Schema.encodeEffect(KeepAwakeStateJson);

const readStateFile = Effect.fn("KeepAwake.readStateFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) return OFF_STATE;
  return yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeStateFile),
    Effect.catch((cause) =>
      Effect.logWarning("Ignoring unreadable Keep Awake state", { filePath, cause }).pipe(
        Effect.as(OFF_STATE),
      ),
    ),
  );
});

export const make = Effect.fn("KeepAwake.make")(function* (filePath: string) {
  const caffeinate = yield* CaffeinateProcess.CaffeinateProcess;
  const agentWork = yield* AgentWorkSource.AgentWorkSource;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const supported = platform === "darwin";

  const runtime = yield* SubscriptionRef.make<KeepAwakeRuntimeState>({
    state: OFF_STATE,
    agentsWorking: false,
  });
  const lock = yield* Semaphore.make(1);
  const caffeinateFiber = yield* FiberHandle.make();
  const deadlineFiber = yield* FiberHandle.make();
  const deadlinesReached = yield* Queue.unbounded<void>();

  const toStatus = (current: KeepAwakeRuntimeState): KeepAwakeStatus => ({
    supported,
    state: current.state,
    agentsWorking: current.agentsWorking,
  });

  const persist = (state: KeepAwakeState) =>
    encodeStateFile(state).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("Could not save Keep Awake state", { filePath, cause }),
      ),
    );

  const apply = Effect.fn("KeepAwake.apply")(
    function* (event: KeepAwakeEvent) {
      const now = yield* DateTime.now;
      const previous = yield* SubscriptionRef.get(runtime);
      const next = transition(previous, event, now);
      if (sameState(previous.state, next.state) && previous.agentsWorking === next.agentsWorking) {
        return next;
      }
      yield* SubscriptionRef.set(runtime, next);
      if (sameState(previous.state, next.state)) return next;
      yield* persist(next.state);

      const args = caffeinateArgs(next.state);
      if (!sameArgs(caffeinateArgs(previous.state), args)) {
        yield* args === null
          ? FiberHandle.clear(caffeinateFiber)
          : FiberHandle.run(caffeinateFiber, caffeinate.run(args)).pipe(Effect.asVoid);
      }

      const deadline = deadlineOf(next.state.mode);
      if (modeKey(previous.state.mode) !== modeKey(next.state.mode)) {
        yield* deadline === null
          ? FiberHandle.clear(deadlineFiber)
          : FiberHandle.run(
              deadlineFiber,
              Effect.sleep(DateTime.distance(now, deadline)).pipe(
                Effect.andThen(Queue.offer(deadlinesReached, undefined)),
              ),
            ).pipe(Effect.asVoid);
      }
      return next;
    },
    Effect.uninterruptible,
    lock.withPermits(1),
  );

  if (supported) {
    yield* apply({ _tag: "Restored", state: yield* readStateFile(filePath) });

    yield* Queue.take(deadlinesReached).pipe(
      Effect.andThen(apply({ _tag: "DeadlineReached" })),
      Effect.forever,
      Effect.forkScoped,
    );

    const workingThreads = new Set<ThreadId>();
    const refreshWork = (threadId: ThreadId | undefined) =>
      agentWork.threads(threadId).pipe(
        Effect.flatMap((threads) => {
          if (threadId === undefined) workingThreads.clear();
          else workingThreads.delete(threadId);
          for (const thread of threads) {
            if (isAgentWorking(thread)) workingThreads.add(thread.id);
          }
          return apply({ _tag: "AgentsWorking", working: workingThreads.size > 0 });
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Keep Awake could not read agent work", { threadId, cause }),
        ),
      );
    yield* forkParked(
      Stream.merge(Stream.make(undefined), agentWork.changedThreadIds).pipe(
        Stream.runForEach(refreshWork),
      ),
    );
  }

  return KeepAwake.of({
    status: SubscriptionRef.changes(runtime).pipe(
      Stream.map(toStatus),
      Stream.changesWith(
        (a, b) => sameState(a.state, b.state) && a.agentsWorking === b.agentsWorking,
      ),
    ),
    set: Effect.fn("KeepAwake.set")(function* (input) {
      if (!supported) {
        return yield* new KeepAwakeUnsupportedError({
          message: "Keep Awake needs macOS on the machine running T3 Code.",
        });
      }
      return toStatus(yield* apply({ _tag: "Requested", input }));
    }),
  });
});

export const layer = Layer.effect(
  KeepAwake,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make(path.join(config.stateDir, "keep-awake.json"));
  }),
).pipe(Layer.provide(CaffeinateProcess.layer), Layer.provide(AgentWorkSource.layer));
