import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PosixMarkerScanner,
  PosixProcessBoundary,
  parsePosixMarkedProcessIds,
  terminatePosixProcessBoundaries,
  type PosixMarkedProcessIds,
  type PosixProcessBoundaryTestRuntime,
  type PosixProcessIdentity,
  type PosixProcessTable,
} from "./posix-process-tree.js";

const root: PosixProcessIdentity = { pid: 100, ppid: 1, state: "S", startedAt: "root-start" };

function processTable(...processes: PosixProcessIdentity[]): PosixProcessTable {
  return new Map(processes.map((process) => [process.pid, process]));
}

test("macOS and BSD marker parsing ignores marker-shaped process arguments", () => {
  const markers = parsePosixMarkedProcessIds(
    `${root.pid} provider --label WOLLIPOG_DESCENDANT_BOUNDARY=decoy WOLLIPOG_DESCENDANT_BOUNDARY=owner-a`,
    processTable(root),
  );

  assert.equal(markers.has("decoy"), false);
  assert.deepEqual(markers.get("owner-a"), new Set([root.pid]));
});

test("marker scan work scales with generations rather than boundary count", async () => {
  let listCalls = 0;
  let markerCalls = 0;
  const ownerB = { pid: 101, ppid: 1, state: "S", startedAt: "owner-b-start" };
  const otherRunner = { pid: 102, ppid: 1, state: "S", startedAt: "other-runner-start" };
  const table = processTable(root, ownerB, otherRunner);
  const markers: PosixMarkedProcessIds = new Map([
    ["owner-a", new Set([root.pid])],
    ["owner-b", new Set([ownerB.pid])],
    ["other-runner", new Set([otherRunner.pid])],
  ]);
  const scanner = new PosixMarkerScanner(
    async () => { listCalls++; return table; },
    async () => { markerCalls++; return markers; },
  );

  const boundaryMarkers = [...markers.keys()];
  const firstGeneration = boundaryMarkers.map((marker) => scanner.snapshot().then((snapshot) => (
    snapshot.markedProcessIds.get(marker)
  )));
  assert.deepEqual(await Promise.all(firstGeneration), [
    new Set([root.pid]),
    new Set([ownerB.pid]),
    new Set([otherRunner.pid]),
  ], "each exact marker remains distinguishable in the shared snapshot");
  assert.equal(listCalls, 1, "one process-table enumeration serves every boundary in a generation");
  assert.equal(markerCalls, 1, "one marker scan serves every boundary in a generation");

  await Promise.all(boundaryMarkers.map(() => scanner.snapshot()));
  assert.equal(listCalls, 2, "a later freshness barrier starts a new enumeration");
  assert.equal(markerCalls, 2, "scan count follows generations even as boundary count grows");
});

test("marker snapshots fail closed when a process exits during scanning", {
  skip: process.platform !== "linux" ? "requires Linux procfs environment reads" : false,
}, async () => {
  const exited = {
    pid: Number.MAX_SAFE_INTEGER,
    ppid: root.pid,
    state: "S",
    startedAt: "exited-start",
  };
  const table = processTable(exited);
  const scanner = new PosixMarkerScanner(async () => table);

  const snapshot = await scanner.snapshot();

  assert.strictEqual(snapshot.table, table);
  assert.equal(snapshot.markedProcessIds.size, 0, "a vanished process contributes no marker ownership");
});

test("a marker snapshot requested after enumeration starts does not adopt the older generation", async () => {
  let listCalls = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const scanner = new PosixMarkerScanner(async () => {
    if (++listCalls === 1) await firstBlocked;
    return processTable(root);
  }, async () => new Map());

  const first = scanner.snapshot();
  await Promise.resolve();
  const afterStart = scanner.snapshot();
  assert.notStrictEqual(afterStart, first);
  releaseFirst();
  await Promise.all([first, afterStart]);
  assert.equal(listCalls, 2);
});

type ProcessStep = PosixProcessTable | Error;

function scriptedRuntime(
  steps: ProcessStep[],
  options: { rejectNextSleep?: boolean } = {},
): PosixProcessBoundaryTestRuntime & { signals: Array<[number, NodeJS.Signals]> } {
  let now = 0;
  let rejectNextSleep = options.rejectNextSleep === true;
  const signals: Array<[number, NodeJS.Signals]> = [];
  return {
    signals,
    async listProcesses() {
      const step = steps.shift();
      assert.ok(step, "scripted process enumeration was exhausted");
      if (step instanceof Error) throw step;
      return step;
    },
    signal(pid, signal) { signals.push([pid, signal]); },
    async sleep(milliseconds) {
      if (rejectNextSleep) {
        rejectNextSleep = false;
        throw new Error("injected timer failure");
      }
      now += Math.max(milliseconds, 2_500);
    },
    now: () => now,
  };
}

test("marker-backed boundaries isolate exact session and runner markers", async () => {
  const owner = {};
  const ownerB = { pid: 101, ppid: 1, state: "S", startedAt: "owner-b-start" };
  const otherRunner = { pid: 102, ppid: 1, state: "S", startedAt: "other-runner-start" };
  const runtime = scriptedRuntime([
    processTable(root, ownerB, otherRunner),
    processTable(root),
    processTable(),
    processTable(),
  ]);
  runtime.listMarkers = async () => new Map([
    ["owner-a", new Set([root.pid])],
    ["owner-b", new Set([ownerB.pid])],
    ["other-runner", new Set([otherRunner.pid])],
  ]);
  const boundary = new PosixProcessBoundary(root.pid, owner, "owner-a", runtime);

  assert.equal(await boundary.terminate(), true);
  assert.ok(runtime.signals.some(([pid]) => pid === root.pid), "the exact owner marker is signaled");
  assert.equal(runtime.signals.some(([pid]) => pid === ownerB.pid), false, "another session remains isolated");
  assert.equal(runtime.signals.some(([pid]) => pid === otherRunner.pid), false, "another runner remains isolated");
  assert.equal(terminatePosixProcessBoundaries(owner).length, 0);
});

async function assertRetryableFailure(
  firstAttempt: ProcessStep[],
  options: {
    rejects?: boolean;
    globalRetry?: boolean;
    inspectFailure?: (runtime: PosixProcessBoundaryTestRuntime & { signals: Array<[number, NodeJS.Signals]> }) => void;
  } = {},
): Promise<void> {
  const owner = {};
  const retrySuccess = [processTable(root), processTable(root), processTable(), processTable()];
  const runtime = scriptedRuntime([...firstAttempt, ...retrySuccess], { rejectNextSleep: options.rejects });
  const boundary = new PosixProcessBoundary(root.pid, owner, undefined, runtime);

  if (options.rejects) await assert.rejects(boundary.terminate(), /injected timer failure/);
  else assert.equal(await boundary.terminate(), false);
  options.inspectFailure?.(runtime);

  const retry = terminatePosixProcessBoundaries(options.globalRetry ? undefined : owner);
  assert.equal(retry.length, 1, "the failed boundary remains registered for retry");
  assert.equal(await retry[0], true);
  assert.equal(terminatePosixProcessBoundaries(owner).length, 0, "success removes the boundary");
}

test("an initial enumeration failure retains the boundary for a successful retry", async (t) => {
  t.mock.method(console, "error", () => {});
  await assertRetryableFailure([new Error("injected initial enumeration failure")], { globalRetry: true });
});

test("a graceful verification failure retains the boundary for a successful retry", async (t) => {
  t.mock.method(console, "error", () => {});
  await assertRetryableFailure([
    processTable(root),
    processTable(root),
    new Error("injected graceful verification failure"),
  ]);
});

test("a forced verification survivor retains the boundary for a successful retry", async (t) => {
  t.mock.method(console, "error", () => {});
  const late = { pid: 101, ppid: root.pid, state: "S", startedAt: "late-start" };
  await assertRetryableFailure([
    processTable(root),
    processTable(root),
    processTable(root),
    processTable(root, late),
  ], {
    inspectFailure: ({ signals }) => assert.ok(
      signals.some(([pid, signal]) => pid === late.pid && signal === "SIGKILL"),
      "a descendant discovered during forced verification is signaled in the same attempt",
    ),
  });
});

test("a forced verification enumeration failure retains the boundary for a successful retry", async (t) => {
  t.mock.method(console, "error", () => {});
  await assertRetryableFailure([
    processTable(root),
    processTable(root),
    processTable(root),
    new Error("injected forced verification failure"),
  ]);
});

test("a rejected termination clears its in-flight guard and remains retryable", async () => {
  await assertRetryableFailure([
    processTable(root),
    processTable(root),
  ], { rejects: true });
});

test("concurrent termination callers share one active attempt", async () => {
  const owner = {};
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const steps = [processTable(root), processTable(root), processTable(), processTable()];
  let calls = 0;
  const runtime = scriptedRuntime(steps);
  const baseList = runtime.listProcesses.bind(runtime);
  runtime.listProcesses = async () => {
    if (++calls === 1) await firstBlocked;
    return baseList();
  };
  const boundary = new PosixProcessBoundary(root.pid, owner, undefined, runtime);

  const first = boundary.terminate();
  const concurrent = boundary.terminate();
  assert.strictEqual(concurrent, first);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(terminatePosixProcessBoundaries(owner).length, 0);
});
