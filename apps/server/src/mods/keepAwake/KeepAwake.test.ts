import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KeepAwakeUnsupportedError, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { KeepAwakeStatus } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as AgentWorkSource from "./AgentWorkSource.ts";
import * as CaffeinateProcess from "./CaffeinateProcess.ts";
import * as KeepAwake from "./KeepAwake.ts";

const NOW = DateTime.makeUnsafe("2026-11-11T12:00:00.000Z");
const SYSTEM_AWAKE = `-i -w ${process.pid}`;
const SYSTEM_AND_SCREEN_AWAKE = `-di -w ${process.pid}`;

const workingThread = (
  id: string,
  overrides: Partial<AgentWorkSource.AgentWorkThread> = {},
): AgentWorkSource.AgentWorkThread => ({
  id: ThreadId.make(id),
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  archivedAt: null,
  status: "running",
  activityRunStatus: "running",
  pendingRuntimeRequest: null,
  ...overrides,
});

const harness = Effect.fn("test.keepAwakeHarness")(function* (
  options: {
    readonly stateFile?: string;
    readonly threads?: ReadonlyArray<AgentWorkSource.AgentWorkThread>;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(yield* fs.makeTempDirectoryScoped(), "keep-awake.json");
  if (options.stateFile !== undefined) yield* fs.writeFileString(filePath, options.stateFile);
  yield* TestClock.setTime(NOW.epochMilliseconds);

  const running = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
  const threads = new Map((options.threads ?? []).map((thread) => [thread.id, thread]));
  const changedThreadIds = yield* Queue.unbounded<ThreadId>();

  const caffeinate = CaffeinateProcess.CaffeinateProcess.of({
    run: (args) =>
      Effect.acquireUseRelease(
        SubscriptionRef.update(running, (current) => [...current, args.join(" ")]),
        () => Effect.never,
        () =>
          SubscriptionRef.update(running, (current) =>
            current.filter((_, index) => index !== current.indexOf(args.join(" "))),
          ),
      ),
  });
  const agentWork = AgentWorkSource.AgentWorkSource.of({
    threads: (threadId) =>
      Effect.sync(() =>
        threadId === undefined
          ? [...threads.values()]
          : [threads.get(threadId)].filter((thread) => thread !== undefined),
      ),
    changedThreadIds: Stream.fromQueue(changedThreadIds),
  });

  const start = KeepAwake.make(filePath).pipe(
    Effect.provideService(CaffeinateProcess.CaffeinateProcess, caffeinate),
    Effect.provideService(AgentWorkSource.AgentWorkSource, agentWork),
    Effect.provideService(HostProcess.Platform, options.platform ?? "darwin"),
  );
  const keepAwake = yield* start;

  const statusWhere = (predicate: (status: KeepAwakeStatus) => boolean) =>
    keepAwake.status.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
  return {
    keepAwake,
    start,
    currentStatus: statusWhere(() => true),
    statusWhere,
    caffeinateWhere: (expected: ReadonlyArray<string>) =>
      SubscriptionRef.changes(running).pipe(
        Stream.filter((current) => current.join("|") === expected.join("|")),
        Stream.runHead,
      ),
    updateThread: (thread: AgentWorkSource.AgentWorkThread) => {
      threads.set(thread.id, thread);
      return Queue.offer(changedThreadIds, thread.id);
    },
  };
});

const modeOf = (status: KeepAwakeStatus) => status.state.mode._tag;
const isOff = (status: KeepAwakeStatus) => modeOf(status) === "Off";

describe("KeepAwake", () => {
  it.effect("holds caffeinate while on and releases it when turned off", () =>
    Effect.gen(function* () {
      const { keepAwake, caffeinateWhere } = yield* harness();

      const on = yield* keepAwake.set({ mode: { _tag: "Manual" } });
      assert.strictEqual(modeOf(on), "Manual");
      yield* caffeinateWhere([SYSTEM_AWAKE]);

      yield* keepAwake.set({ mode: { _tag: "Off" } });
      yield* caffeinateWhere([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restarts caffeinate with the screen flag when Keep screen on changes", () =>
    Effect.gen(function* () {
      const { keepAwake, caffeinateWhere } = yield* harness();
      yield* keepAwake.set({ mode: { _tag: "Manual" } });
      yield* caffeinateWhere([SYSTEM_AWAKE]);

      yield* keepAwake.set({ keepScreenOn: true });
      yield* caffeinateWhere([SYSTEM_AND_SCREEN_AWAKE]);

      yield* keepAwake.set({ keepScreenOn: false });
      yield* caffeinateWhere([SYSTEM_AWAKE]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("turns a timed mode off at its end time", () =>
    Effect.gen(function* () {
      const { keepAwake, currentStatus, statusWhere, caffeinateWhere } = yield* harness();

      const on = yield* keepAwake.set({ mode: { _tag: "For", minutes: 60 } });
      assert.deepStrictEqual(on.state.mode, {
        _tag: "Timed",
        endsAt: DateTime.makeUnsafe("2026-11-11T13:00:00.000Z"),
      });

      yield* TestClock.adjust("59 minutes");
      assert.strictEqual(modeOf(yield* currentStatus), "Timed");

      yield* TestClock.adjust("1 minute");
      yield* statusWhere(isOff);
      yield* caffeinateWhere([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends until agents finish when the last turn stops, counting approval waits", () =>
    Effect.gen(function* () {
      const working = workingThread("thread-a");
      const { keepAwake, statusWhere, updateThread, caffeinateWhere } = yield* harness({
        threads: [working],
      });
      yield* statusWhere((status) => status.agentsWorking);

      yield* keepAwake.set({ mode: { _tag: "AgentsFinish" } });
      yield* caffeinateWhere([SYSTEM_AWAKE]);

      yield* updateThread({
        ...working,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "permission",
          createdAt: NOW,
        },
      });
      const off = yield* statusWhere(isOff);
      assert.isFalse(off.agentsWorking);
      yield* caffeinateWhere([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses until agents finish when nothing is working", () =>
    Effect.gen(function* () {
      const { keepAwake } = yield* harness();
      const status = yield* keepAwake.set({ mode: { _tag: "AgentsFinish" } });
      assert.strictEqual(modeOf(status), "Off");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores the mode and screen flag after a restart", () =>
    Effect.gen(function* () {
      const first = yield* harness();
      yield* first.keepAwake.set({ mode: { _tag: "For", minutes: 120 }, keepScreenOn: true });

      const restarted = yield* first.start;
      const status = yield* restarted.status.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.deepStrictEqual(status.state, {
        mode: { _tag: "Timed", endsAt: DateTime.makeUnsafe("2026-11-11T14:00:00.000Z") },
        keepScreenOn: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restores an expired timed mode as off", () =>
    Effect.gen(function* () {
      const { currentStatus, caffeinateWhere } = yield* harness({
        stateFile: JSON.stringify({
          mode: { _tag: "Timed", endsAt: "2026-11-11T11:59:00.000Z" },
          keepScreenOn: true,
        }),
      });
      const status = yield* currentStatus;
      assert.deepStrictEqual(status.state, { mode: { _tag: "Off" }, keepScreenOn: true });
      yield* caffeinateWhere([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits two minutes after a restart for agents to resume before turning off", () =>
    Effect.gen(function* () {
      const { currentStatus, statusWhere, caffeinateWhere } = yield* harness({
        stateFile: JSON.stringify({ mode: { _tag: "AgentsFinish" }, keepScreenOn: false }),
      });
      yield* caffeinateWhere([SYSTEM_AWAKE]);

      yield* TestClock.adjust("119 seconds");
      assert.strictEqual(modeOf(yield* currentStatus), "AgentsFinish");

      yield* TestClock.adjust("1 second");
      yield* statusWhere(isOff);
      yield* caffeinateWhere([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a restored until agents finish while resumed work runs", () =>
    Effect.gen(function* () {
      const { currentStatus, statusWhere, updateThread } = yield* harness({
        stateFile: JSON.stringify({ mode: { _tag: "AgentsFinish" }, keepScreenOn: false }),
      });
      yield* TestClock.adjust("1 minute");
      const resumed = workingThread("thread-a");
      yield* updateThread(resumed);
      yield* statusWhere((status) => status.agentsWorking);

      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(modeOf(yield* currentStatus), "AgentsFinish");

      yield* updateThread({ ...resumed, status: "completed", activityRunStatus: null });
      yield* statusWhere(isOff);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unsupported off macOS and refuses to turn on", () =>
    Effect.gen(function* () {
      const { keepAwake, currentStatus } = yield* harness({ platform: "linux" });
      assert.isFalse((yield* currentStatus).supported);
      const error = yield* keepAwake.set({ mode: { _tag: "Manual" } }).pipe(Effect.flip);
      assert.instanceOf(error, KeepAwakeUnsupportedError);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
