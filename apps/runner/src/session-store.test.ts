import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_PAGE_MAX_BYTES,
  SessionStore,
  isAdoptedSession,
  metaToSnapshot,
  type SessionMeta,
} from "./session-store.js";

function tmpStore(): { store: SessionStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-"));
  return { store: new SessionStore(root), root };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s_abc",
    agentId: "codex-native",
    workspaceId: "repo",
    repoPath: "/home/me/repo",
    worktreePath: "/home/me/repo/.agent-worktrees/s_abc",
    driver: "codex",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "thread_123",
    status: "idle",
    title: "do a thing",
    config: { model: "default" },
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

test("create + readMeta round-trips", () => {
  const { store, root } = tmpStore();
  try {
    const sessionSlashCommandProvenance = {
      driver: "claude-code",
      context: "native",
      root: "/home/me/repo/.agent-worktrees/s_abc",
      targetAdapter: "host" as const,
      targetId: null,
      includeUserCommands: true,
      handoffManifestDigest: null,
    };
    store.create(meta({ sessionSlashCommandProvenance }));
    assert.equal(store.has("s_abc"), true);
    const m = store.readMeta("s_abc");
    assert.equal(m?.agentSessionId, "thread_123");
    assert.equal(m?.driver, "codex");
    assert.deepEqual(m?.sessionSlashCommandProvenance, sessionSlashCommandProvenance);
    assert.equal(store.readMeta("missing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scrubLegacyAgentEnv durably removes pre-v54 resolved secrets from session meta", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta({ env: { API_TOKEN: "legacy-secret" } }));
    assert.equal(store.scrubLegacyAgentEnv(), 1);
    assert.deepEqual(store.readMeta("s_abc")?.env, {});
    assert.equal(readFileSync(join(root, "s_abc", "meta.json"), "utf8").includes("legacy-secret"), false);
    assert.equal(store.scrubLegacyAgentEnv(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendEvent assigns increasing seq and readEvents filters by afterSeq", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const e1 = store.appendEvent("s_abc", { kind: "user_message", text: "hi" }, 1001);
    const e2 = store.appendEvent("s_abc", { kind: "agent_message", text: "hello" }, 1002);
    assert.equal(e1?.seq, 1);
    assert.equal(e2?.seq, 2);
    assert.equal(store.readMeta("s_abc")?.seq, 2); // high-water bumped

    const all = store.readEvents("s_abc");
    assert.deepEqual(all.map((e) => e.seq), [1, 2]);
    const after1 = store.readEvents("s_abc", 1);
    assert.deepEqual(after1.map((e) => e.seq), [2]);
    assert.equal(after1[0]?.ts, 1002);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v86 wire projection omits response completions while keeping dense live and hydration cursors", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const first = store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001)!;
    const completion = store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1002)!;
    const second = store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1003)!;

    assert.deepEqual(store.readEvents("s_abc").map((event) => event.payload.kind), [
      "agent_message", "agent_response_completed", "agent_message",
    ], "runner-local history remains exact");
    assert.equal(store.snapshots(86)[0]?.seq, 2);
    assert.equal(store.snapshots(86, true)[0]?.seq, 3,
      "buffered messages retain the exact local high-water until socket send");
    assert.equal(store.snapshots(87)[0]?.seq, 3);
    assert.equal(store.snapshots(86)[0]?.historyEpoch, 1);
    assert.equal(store.snapshots(86, true)[0]?.historyEpoch, 0);
    assert.equal(store.snapshots(87)[0]?.historyEpoch, 0);
    assert.deepEqual(store.projectEventForProtocol("s_abc", first, 86), first);
    assert.equal(store.projectEventForProtocol("s_abc", completion, 86), null);
    assert.deepEqual(store.projectEventForProtocol("s_abc", second, 86), {
      ...second,
      seq: 2,
    });
    assert.deepEqual(store.projectEventForProtocol("s_abc", completion, 87), completion);

    let refreshCount = 0;
    const refresh = (store as any).refreshEventProjectionIndex.bind(store);
    (store as any).refreshEventProjectionIndex = (...args: unknown[]) => {
      refreshCount += 1;
      return refresh(...args);
    };
    const legacy = store.readEventsForProtocol("s_abc", 0, 86);
    assert.equal(refreshCount, 1, "whole-history projection refreshes derived state once per batch");
    assert.deepEqual(legacy.map((event) => [event.seq, event.payload.kind]), [
      [1, "agent_message"],
      [2, "agent_message"],
    ]);
    assert.deepEqual(store.readEventsForProtocol("s_abc", 1, 86).map((event) => event.seq), [2]);
    assert.deepEqual(store.readEventsForProtocol("s_abc", 99, 86), [],
      "legacy hydration preserves the empty result for a stale cursor beyond the projected tail");
    assert.deepEqual(store.readEventsForProtocol("s_abc", 0, 87).map((event) => event.seq), [1, 2, 3]);

    refreshCount = 0;
    const projectionIndexPath = join(root, "s_abc", "events.idx");
    rmSync(projectionIndexPath, { force: true });
    assert.equal(existsSync(projectionIndexPath), false);
    const page1 = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, 86);
    assert.equal(refreshCount, 1, "indexed projection refreshes derived state once per page operation");
    assert.equal(existsSync(projectionIndexPath), true, "the projected first page repairs its sparse index");
    assert.equal(page1.ok, true);
    if (!page1.ok) return;
    assert.deepEqual(page1.events.map((event) => [event.seq, event.payload.kind]), [[1, "agent_message"]]);
    assert.deepEqual(page1.page, {
      logEpoch: 1,
      throughSeq: 2,
      nextAfterSeq: 1,
      hasMore: true,
    });

    const page2 = store.readEventPageForProtocol("s_abc", {
      afterSeq: page1.page.nextAfterSeq,
      limit: 1,
      logEpoch: page1.page.logEpoch,
      throughSeq: page1.page.throughSeq,
    }, 86);
    assert.equal(page2.ok, true);
    if (!page2.ok) return;
    assert.deepEqual(page2.events.map((event) => [event.seq, event.payload.kind]), [[2, "agent_message"]]);
    assert.equal(page2.page.hasMore, false);

    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1004);
    store.appendEvent("s_abc", { kind: "agent_message", text: "three" }, 1005);
    const frozen = store.readEventPageForProtocol("s_abc", {
      afterSeq: 2,
      limit: 10,
      logEpoch: page1.page.logEpoch,
      throughSeq: page1.page.throughSeq,
    }, 86);
    assert.deepEqual(frozen, {
      ok: true,
      events: [],
      page: { logEpoch: 1, throughSeq: 2, nextAfterSeq: 2, hasMore: false },
    });
    assert.deepEqual(store.readEventsForProtocol("s_abc", 2, 86).map((event) => [event.seq, event.payload.kind]), [
      [3, "agent_message"],
    ], "a new connection/version projection is evaluated from exact local history");
    appendFileSync(join(root, "s_abc", "events.ndjson"), '{"seq":999');
    const tornReader = new SessionStore(root);
    assert.equal(tornReader.projectedEventSeq("s_abc", 5, 86), 3,
      "wire projection ignores the documented recoverable torn suffix");
    assert.deepEqual(tornReader.readEventsForProtocol("s_abc", 0, 86).map((event) => event.seq), [1, 2, 3],
      "legacy hydration remains total with a torn suffix");
    assert.equal(tornReader.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 10 }, 86).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration keeps history neutral until one negotiated v86 or v87 generation is published", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1002);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1003);

    const exact = store.snapshots(87, true)[0]!;
    const historyTail = (store as any).historyTail.bind(store);
    let historyTailCalls = 0;
    (store as any).historyTail = (...args: unknown[]) => {
      historyTailCalls += 1;
      return historyTail(...args);
    };
    const firstRegister = store.registrationSnapshots()[0]!;
    const reconnectRegister = store.registrationSnapshots()[0]!;
    assert.equal(historyTailCalls, 0, "pre-negotiation registration never scans event history");
    assert.equal(firstRegister.seq, 0);
    assert.equal(firstRegister.historyEpoch, undefined);
    assert.deepEqual(reconnectRegister, firstRegister, "reconnect does not fabricate another generation");

    const v86 = store.projectSnapshotForProtocol(exact, 86);
    const v87 = store.projectSnapshotForProtocol(exact, 87);
    assert.deepEqual([v86.seq, v86.historyEpoch], [2, 1]);
    assert.deepEqual([v87.seq, v87.historyEpoch], [3, 0]);
    assert.deepEqual(store.projectSnapshotForProtocol(exact, 86), v86,
      "a v86 reconnect republishes the same negotiated generation");
    assert.deepEqual(store.projectSnapshotForProtocol(exact, 87), v87,
      "a v87 reconnect republishes the same negotiated generation");

    const legacyPage = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 10 }, 86);
    const currentPage = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 10 }, 87);
    assert.equal(legacyPage.ok, true);
    assert.equal(currentPage.ok, true);
    if (legacyPage.ok && currentPage.ok) {
      assert.equal(legacyPage.page.logEpoch, v86.historyEpoch);
      assert.equal(currentPage.page.logEpoch, v87.historyEpoch);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktree metadata is projected only to protocol v101 peers", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta({
      worktrees: [{
        id: "wt-one",
        path: "/home/me/repo/.agent-worktrees/s_abc",
        branch: "fix/one",
        baseRef: "origin/main",
        baseCommit: "a".repeat(40),
        source: "created",
      }],
    }));
    const exact = store.snapshots(101, true)[0]!;
    assert.equal(store.projectSnapshotForProtocol(exact, 100).worktrees, undefined);
    assert.equal(store.projectSnapshotForProtocol(exact, 101).worktrees?.[0]?.branch, "fix/one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed incremental projection scan commits no duplicate omissions on retry", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1002);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1003);
    assert.equal(store.projectedEventSeq("s_abc", 3, 86), 2, "prime the cached prefix");

    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1004);
    store.appendEvent("s_abc", { kind: "agent_message", text: "three" }, 1005);
    const scan = (store as any).scanHistoryLines.bind(store);
    let failAfterFirstRecord = true;
    (store as any).scanHistoryLines = (
      id: string,
      startOffset: number,
      endOffset: number,
      visit: (line: Buffer, offset: number) => boolean | void,
    ) => scan(id, startOffset, endOffset, (line: Buffer, offset: number) => {
      const result = visit(line, offset);
      if (failAfterFirstRecord) {
        failAfterFirstRecord = false;
        throw new Error("transient projection read failure");
      }
      return result;
    });

    assert.throws(() => store.projectedEventSeq("s_abc", 5, 86), /transient projection read failure/);
    assert.equal(store.projectedEventSeq("s_abc", 5, 86), 3,
      "retry subtracts each omitted local sequence exactly once");
    assert.deepEqual(store.readEventsForProtocol("s_abc", 0, 86).map((event) => event.seq), [1, 2, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projected snapshot corruption fallback never advertises an exact local tail", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1002);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1003);
    (store as any).projectedEventSeq = () => {
      throw new Error("projection index unavailable");
    };

    const legacy = store.snapshots(86)[0]!;
    assert.deepEqual([legacy.seq, legacy.historyEpoch], [0, 1],
      "legacy fallback remains in its dense sequence space");
    const current = store.snapshots(87)[0]!;
    assert.deepEqual([current.seq, current.historyEpoch], [3, 0],
      "an exact current peer may retain the metadata high-water");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection failure for a removed session is explicit for the socket containment boundary", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const event = store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001)!;
    store.remove("s_abc");
    assert.throws(
      () => store.projectEventForProtocol("s_abc", event, 86),
      /session history does not exist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer protocol changes fence dense sequence spaces with distinct wire epochs", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.resetEvents("s_abc");
    assert.equal(store.snapshots(86)[0]?.historyEpoch, 3);
    assert.equal(store.snapshots(87)[0]?.historyEpoch, 2);

    const legacy = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, 86);
    const current = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, 87);
    assert.equal(legacy.ok, true);
    assert.equal(current.ok, true);
    if (legacy.ok && current.ok) {
      assert.equal(legacy.page.logEpoch, 3);
      assert.equal(current.page.logEpoch, 2);
      assert.notEqual(legacy.page.logEpoch, current.page.logEpoch);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resetEvents truncates the log + resets seq/preview but PRESERVES usage (for reprocess re-import)", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta({ preview: "old", tokensIn: 9, tokensOut: 4, costUsd: 1 }));
    store.appendEvent("s_abc", { kind: "user_message", text: "hi" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_message", text: "hello" }, 1002);
    assert.equal(store.readMeta("s_abc")?.seq, 2);

    store.resetEvents("s_abc");
    assert.deepEqual(store.readEvents("s_abc"), []);
    const m = store.readMeta("s_abc");
    assert.equal(m?.seq, 0);
    assert.equal(m?.preview, null);
    // usage/cost are PRESERVED — the transcript parsers can't rebuild token_usage, so zeroing loses them
    assert.equal(m?.tokensIn, 9);
    assert.equal(m?.tokensOut, 4);
    assert.equal(m?.costUsd, 1);

    // a re-backfill assigns seq from 1 again
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "fresh" }, 1003)?.seq, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isAdoptedSession: explicit flag wins; legacy adopt signature is the fallback", () => {
  // explicit marker
  assert.equal(isAdoptedSession(meta({ adopted: true })), true);
  assert.equal(isAdoptedSession(meta({ adopted: false })), false);
  // legacy adopted signature (no manager agent, has a resume id, never worktree'd)
  assert.equal(isAdoptedSession(meta({ adopted: undefined, agentId: null, agentSessionId: "t1", worktreePath: null })), true);
  // a manager-created session always has an agentId → never matches the fallback
  assert.equal(isAdoptedSession(meta({ adopted: undefined, agentId: "codex-native", agentSessionId: "t1" })), false);
});

test("patchMeta merges + bumps updatedAt, keeps sessionId", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const next = store.patchMeta("s_abc", { status: "running", tokensIn: 50 });
    assert.equal(next?.status, "running");
    assert.equal(next?.tokensIn, 50);
    assert.equal(next?.sessionId, "s_abc");
    assert.ok((next?.updatedAt ?? 0) >= 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listSessions + snapshots enumerate the store and map to protocol shape", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta({ sessionId: "s_1", createdAt: 1 }));
    store.create(meta({ sessionId: "s_2", createdAt: 2, worktreePath: null }));
    assert.deepEqual(store.listSessions().map((m) => m.sessionId), ["s_1", "s_2"]);
    const snaps = store.snapshots();
    assert.deepEqual(snaps.map((s) => s.id), ["s_1", "s_2"]);
    // useWorktree derives from worktreePath presence
    assert.equal(snaps.find((s) => s.id === "s_1")?.useWorktree, true);
    assert.equal(snaps.find((s) => s.id === "s_2")?.useWorktree, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably tombstoned session directories remain internally recoverable but are never advertised", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-tombstone-"));
  try {
    const store = new SessionStore(root);
    store.create(meta({ sessionId: "deleted-session" }));
    store.markDeleted("deleted-session");
    assert.equal(store.has("deleted-session"), true, "models the crash window before row cleanup");
    assert.deepEqual(store.listSessions().map((value) => value.sessionId), ["deleted-session"]);
    assert.deepEqual(store.snapshots(), []);
    assert.doesNotThrow(() => store.markDeleted("deleted-session"), "duplicate marker creation is idempotent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock: free→acquire, second owner blocked, release frees it", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    assert.equal(store.acquireLock("s_abc", "runner-A"), true);
    assert.equal(store.ownsLock("s_abc", "runner-A"), true);
    assert.equal(store.ownsLock("s_abc", "runner-B"), false);
    assert.equal(store.acquireLock("s_abc", "runner-B"), false); // held by A (fresh)
    assert.equal(store.acquireLock("s_abc", "runner-A"), true); // re-entrant for the holder
    store.releaseLock("s_abc", "runner-A");
    assert.equal(store.ownsLock("s_abc", "runner-A"), false);
    assert.equal(store.acquireLock("s_abc", "runner-B"), true); // now free
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree leases retain a live provider across store instances and release owner-safely", () => {
  const { store: first, root } = tmpStore();
  try {
    first.create(meta());
    const second = new SessionStore(root);
    assert.equal(first.acquireWorktreeLease("s_abc", "provider:first"), true);
    assert.equal(second.acquireWorktreeLease("s_abc", "cleanup:second"), false,
      "a sibling process must treat the live provider PID as authoritative");
    second.releaseWorktreeLease("s_abc", "cleanup:second");
    assert.equal(second.acquireWorktreeLease("s_abc", "cleanup:third"), false,
      "a non-owner release must not unlink the provider lease");
    first.releaseWorktreeLease("s_abc", "provider:first");
    assert.equal(second.acquireWorktreeLease("s_abc", "cleanup:second"), true);
    second.releaseWorktreeLease("s_abc", "cleanup:second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleted-session markers reap by age while crash-window rows and recent fences remain authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-tombstone-reap-"));
  try {
    const store = new SessionStore(root);
    store.markDeleted("expired-session");
    store.markDeleted("recent-session");
    store.create(meta({ sessionId: "guarded-session" }));
    store.markDeleted("guarded-session");
    const markerRoot = join(root, ".deleted");
    const pathsById = new Map(
      readdirSync(markerRoot).map((name) => {
        const path = join(markerRoot, name);
        return [readFileSync(path, "utf8"), path] as const;
      }),
    );
    const now = Date.now();
    utimesSync(pathsById.get("expired-session")!, new Date(now - 5_000), new Date(now - 5_000));
    utimesSync(pathsById.get("guarded-session")!, new Date(now - 5_000), new Date(now - 5_000));
    utimesSync(pathsById.get("recent-session")!, new Date(now), new Date(now));

    assert.equal(store.reapDeletedMarkers(1_000, now), 1);
    assert.equal(store.isDeleted("expired-session"), false);
    assert.equal(store.isDeleted("recent-session"), true);
    assert.equal(store.isDeleted("guarded-session"), true, "an old marker still fences its crash-window row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metaToSnapshot omits runner-only fields (agentSessionId, repoPath, command provenance)", () => {
  const snap = metaToSnapshot(meta({
    controlPlaneLaunchId: "launch-proof-1",
    resolvedModel: "claude-opus-5[1m]",
    sessionSlashCommandProvenance: {
      driver: "claude-code",
      context: "native",
      root: "/repo",
      targetAdapter: "host",
      targetId: null,
      includeUserCommands: true,
      handoffManifestDigest: null,
    },
  }));
  assert.equal((snap as Record<string, unknown>).agentSessionId, undefined);
  assert.equal((snap as Record<string, unknown>).repoPath, undefined);
  assert.equal((snap as Record<string, unknown>).sessionSlashCommandProvenance, undefined);
  assert.equal(snap.id, "s_abc");
  assert.equal(snap.controlPlaneLaunchId, "launch-proof-1");
  assert.equal(snap.seq, 0);
  assert.equal(snap.resolvedModel, "claude-opus-5[1m]");
});

test("v82 snapshots expose bounded background delivery facts without runner-private context", () => {
  assert.equal(
    metaToSnapshot(meta({ backgroundJobs: undefined }), 82).backgroundJobs,
    undefined,
    "sessions without managed work do not trigger authoritative empty-inventory sweeps",
  );
  const backgroundJobs = [{
    id: "task-1",
    toolUseId: "tool-secret",
    parentTurnId: "turn-1",
    runnerId: "runner-1",
    workspaceId: "repo",
    context: { kind: "wsl" as const, distro: "Ubuntu" },
    executionTarget: {
      id: "local",
      runnerId: "runner-1",
      kind: "host" as const,
      workspaceStrategy: "in_place" as const,
      adapter: "host" as const,
      boundaries: { filesystem: "host" as const, process: "host" as const },
    },
    launchType: "agent" as const,
    registeredAt: 10,
    outputReference: "/private/provider/artifact.jsonl",
    terminalStatus: "completed" as const,
    terminalObservedAt: 20,
    continuationRequired: true,
    continuationId: "bgcont-1",
    continuationQueuedAt: 21,
    continuationSubmittedAt: 22,
    continuationAcceptedAt: 23,
    assistantResultPersistedAt: 24,
    structuredDeliveryPublishedAt: 25,
  }];
  assert.equal(metaToSnapshot(meta({ backgroundJobs }), 81).backgroundJobs, undefined);
  assert.deepEqual(metaToSnapshot(meta({ backgroundJobs }), 82).backgroundJobs, [{
    id: "task-1",
    parentTurnId: "turn-1",
    runnerId: "runner-1",
    workspaceId: "repo",
    launchType: "agent",
    registeredAt: 10,
    terminalStatus: "completed",
    terminalObservedAt: 20,
    continuationRequired: true,
    continuationId: "bgcont-1",
    continuationQueuedAt: 21,
    continuationSubmittedAt: 22,
    continuationAcceptedAt: 23,
    assistantResultPersistedAt: 24,
  }]);
  const serialized = JSON.stringify(metaToSnapshot(meta({ backgroundJobs }), 82));
  assert.equal(serialized.includes("tool-secret"), false);
  assert.equal(serialized.includes("provider/artifact"), false);
  assert.equal(serialized.includes("Ubuntu"), false);
  assert.equal(serialized.includes("structuredDeliveryPublishedAt"), false);
});

test("v83 snapshots explicitly classify provider background tracking", () => {
  assert.equal(metaToSnapshot(meta({ driver: "claude-code" }), 82).backgroundWorkTracking, undefined);
  assert.equal(metaToSnapshot(meta({ driver: "claude-code" }), 83).backgroundWorkTracking, "managed");
  for (const driver of ["acp", "codex", "codex-app-server"] as const) {
    const snap = metaToSnapshot(meta({ driver }), 83);
    assert.equal(snap.backgroundWorkTracking, "untracked", driver);
    assert.equal(snap.backgroundWorkState, undefined, "classification never invents active detached work");
  }
});

test("native snapshots publish only the session-scoped elicitation overlay", () => {
  const capabilities = {
    models: [{ id: "frozen-model" }],
    effortLevels: ["high"],
    slashCommands: [{ name: "review", source: "builtin" as const }],
    supportsImages: true,
    supportsApprovals: true,
    permissionModes: ["workspace-write"],
    elicitation: { "workspace-write": ["stdio-control" as const] },
  };
  const current = metaToSnapshot(meta({ capabilities }), 66);
  assert.deepEqual(current.agentCapabilities, {
    elicitation: { "workspace-write": ["stdio-control"] },
  });
  assert.equal(
    metaToSnapshot(meta({ capabilities }), 65).agentCapabilities,
    undefined,
    "v65 control planes must not receive the v66 native overlay",
  );
});

test("v74 native snapshots publish an explicit session command catalog, including an empty clear", () => {
  const command = { name: "deploy", source: "project" as const, argumentHint: "<environment>" };
  assert.deepEqual(
    metaToSnapshot(meta({ sessionSlashCommands: [command] }), 74).agentCapabilities,
    { slashCommands: [command] },
  );
  assert.deepEqual(
    metaToSnapshot(meta({ sessionSlashCommands: [] }), 74).agentCapabilities,
    { slashCommands: [] },
    "a successful empty discovery must clear the broader agent catalog",
  );
  assert.deepEqual(
    metaToSnapshot(meta({
      capabilities: {
        elicitation: { "workspace-write": ["stdio-control"] },
      },
      sessionSlashCommands: [command],
    }), 74).agentCapabilities,
    {
      elicitation: { "workspace-write": ["stdio-control"] },
      slashCommands: [command],
    },
    "v74 publishes elicitation and session command overlays together",
  );
  assert.equal(
    metaToSnapshot(meta({ sessionSlashCommands: [command] }), 73).agentCapabilities,
    undefined,
    "older control planes must not receive the v74 overlay",
  );
});

test("metaToSnapshot publishes raw ACP session overrides instead of the merged effective context", () => {
  const effective = { mcpServers: [{ type: "http" as const, name: "docs", url: "https://new.example/mcp" }] };
  const overrides = { mcpServers: [{ type: "http" as const, name: "docs", url: "https://old.example/mcp", disabled: true }] };
  const snap = metaToSnapshot(meta({ driver: "acp", acpSessionContext: effective, acpSessionOverrides: overrides }));
  assert.deepEqual(snap.acpSessionContext, overrides);
});

test("metaToSnapshot never republishes operator-only effective ACP context as session overrides", () => {
  const effective = { mcpServers: [{ type: "http" as const, name: "docs", url: "https://operator.example/mcp" }] };
  const snap = metaToSnapshot(meta({ driver: "acp", acpSessionContext: effective, acpSessionOverrides: undefined }));
  assert.equal(snap.acpSessionContext, undefined);
});

test("lastTurnBaseTree round-trips through patchMeta and stays out of the snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    store.patchMeta("s_abc", { lastTurnBaseTree: "abc123tree" });
    assert.equal(store.readMeta("s_abc")!.lastTurnBaseTree, "abc123tree");
    // A failed capture overwrites the stale sha with null (never captured stays undefined).
    store.patchMeta("s_abc", { lastTurnBaseTree: null });
    assert.equal(store.readMeta("s_abc")!.lastTurnBaseTree, null);
    // Box-local odb sha — meaningless off-box, so the protocol snapshot must not carry it.
    const snap = metaToSnapshot(store.readMeta("s_abc")!);
    assert.equal((snap as Record<string, unknown>).lastTurnBaseTree, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("noisy meta churn is debounced but flushAll makes it durable (fresh instance sees it)", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-lazy-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "chunk" });
    // Cache sees the bump immediately...
    assert.equal(store.readMeta("s_abc")!.seq, 1);
    // ...while a SECOND instance over the same root may still see the pre-flush meta.
    store.flushAll();
    const other = new SessionStore(root);
    assert.equal(other.readMeta("s_abc")!.seq, 1, "flushAll must persist the debounced seq");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("critical meta patches flush immediately (visible to a fresh instance, no flushAll)", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-crit-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    store.patchMeta("s_abc", { status: "failed", agentSessionId: "resume-me" });
    const other = new SessionStore(root);
    assert.equal(other.readMeta("s_abc")!.status, "failed");
    assert.equal(other.readMeta("s_abc")!.agentSessionId, "resume-me");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendEvent self-heals a seq lagging the ndjson tail (crash between append and flush)", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-heal-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    for (let i = 0; i < 5; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
    // Simulate the crash: the LOG has seq 5 but meta.json on disk lags at 3.
    store.flushAll();
    const raw = JSON.parse(readFileSync(join(root, "s_abc", "meta.json"), "utf8"));
    writeFileSync(join(root, "s_abc", "meta.json"), JSON.stringify({ ...raw, seq: 3 }));

    const revived = new SessionStore(root); // fresh process
    const ev = revived.appendEvent("s_abc", { kind: "agent_message", text: "after crash" });
    assert.equal(ev!.seq, 6, "must continue past the log tail, never mint a duplicate seq");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a debounced flush merges into fresh disk state — never clobbers another runner's critical writes", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-merge-"));
  try {
    const a = new SessionStore(root);
    a.create(meta());
    a.appendEvent("s_abc", { kind: "agent_message", text: "chunk" }); // pending delta: seq 1, dirty

    // Runner B (separate process, same shared root) recovers the session and writes critical fields.
    const b = new SessionStore(root);
    b.patchMeta("s_abc", { status: "failed", agentSessionId: "b-owns-this" }); // immediate write

    a.flush("s_abc"); // A's stale full-meta copy must NOT overwrite B's fields
    const final = new SessionStore(root).readMeta("s_abc")!;
    assert.equal(final.status, "failed", "B's critical status must survive A's lazy flush");
    assert.equal(final.agentSessionId, "b-owns-this");
    assert.equal(final.seq, 1, "A's seq bump still lands (monotonic merge)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resetEvents is durable immediately and clears stale pending deltas", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-reset-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    for (let i = 0; i < 3; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
    store.resetEvents("s_abc"); // NO flushAll — must be durable on its own
    const other = new SessionStore(root);
    assert.equal(other.readMeta("s_abc")!.seq, 0, "reset high-water visible to a fresh process");
    assert.equal(store.readMeta("s_abc")!.seq, 0, "pre-reset pending seq delta must not resurface");
    const ev = store.appendEvent("s_abc", { kind: "agent_message", text: "fresh" });
    assert.equal(ev!.seq, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seq tail-healing survives a final event line larger than the 64KB scan window", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-bigline-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "small" }); // seq 1
    store.appendEvent("s_abc", { kind: "file_edit", path: "worktree", diff: "x".repeat(150 * 1024) }); // seq 2, >64KB line
    store.flushAll();
    // Roll disk meta back to simulate the crash-before-flush.
    const p = join(root, "s_abc", "meta.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...raw, seq: 0 }));

    const revived = new SessionStore(root);
    const ev = revived.appendEvent("s_abc", { kind: "agent_message", text: "after" });
    assert.equal(ev!.seq, 3, "the widening tail scan must find seq 2 behind the giant line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale pending delta from ANOTHER process cannot resurrect a reset seq (log epoch)", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-epoch-"));
  try {
    const a = new SessionStore(root);
    a.create(meta());
    for (let i = 0; i < 5; i++) a.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
    // A holds an unflushed pending delta (seq 5) when B resets the log.
    const b = new SessionStore(root);
    b.resetEvents("s_abc");
    b.appendEvent("s_abc", { kind: "agent_message", text: "new gen" }); // seq 1, epoch 1
    b.flushAll();

    a.flush("s_abc"); // A's pre-reset delta must be DROPPED, not merged over the new generation
    const final = new SessionStore(root).readMeta("s_abc")!;
    assert.equal(final.seq, 1, "the old generation's seq high-water must not survive the reset");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseLock is owner-aware: a stale ex-holder cannot delete the new owner's lock", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-lockown-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    assert.equal(store.acquireLock("s_abc", "runner-A"), true);
    // B steals after staleness (simulate by direct release + reacquire as B).
    store.releaseLock("s_abc", "runner-A");
    assert.equal(store.acquireLock("s_abc", "runner-B"), true);
    store.releaseLock("s_abc", "runner-A"); // stale ex-holder — must be a no-op
    assert.equal(store.acquireLock("s_abc", "runner-C"), false, "B still holds the lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshLock is owner-aware: a stale ex-holder cannot overwrite the new owner's lock", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-lockrefresh-"));
  try {
    const store = new SessionStore(root);
    store.create(meta());
    assert.equal(store.acquireLock("s_abc", "runner-A"), true);
    // Simulate B legitimately taking A's lock after the stale window.
    store.releaseLock("s_abc", "runner-A");
    assert.equal(store.acquireLock("s_abc", "runner-B"), true);
    assert.equal(store.refreshLock("s_abc", "runner-A"), false);
    assert.equal(store.ownsLock("s_abc", "runner-B"), true, "A's stale refresh must preserve B's lock");
    assert.equal(store.refreshLock("s_abc", "runner-B"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexed history pages are contiguous, bounded, and freeze the durable tail across appends", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    for (let i = 1; i <= 300; i++) {
      store.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` }, 1_000 + i);
    }
    const first = store.readEventPage("s_abc", { afterSeq: 0, limit: 37 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.events.length, 37);
    assert.equal(first.page.throughSeq, 300);
    assert.equal(first.page.hasMore, true);

    // This append belongs to the next chain, not the frozen 300-event chain.
    store.appendEvent("s_abc", { kind: "agent_message", text: "later" }, 2_000);
    const seqs = first.events.map((event) => event.seq);
    let cursor = first.page.nextAfterSeq;
    while (cursor < first.page.throughSeq) {
      const page = store.readEventPage("s_abc", {
        afterSeq: cursor,
        limit: 37,
        logEpoch: first.page.logEpoch,
        throughSeq: first.page.throughSeq,
      });
      assert.equal(page.ok, true);
      if (!page.ok) return;
      seqs.push(...page.events.map((event) => event.seq));
      assert.ok(page.page.nextAfterSeq > cursor, "every non-terminal page must advance");
      cursor = page.page.nextAfterSeq;
    }
    assert.deepEqual(seqs, Array.from({ length: 300 }, (_, index) => index + 1));
    const nextChain = store.readEventPage("s_abc", { afterSeq: 300, limit: 10 });
    assert.equal(nextChain.ok, true);
    if (nextChain.ok) assert.deepEqual(nextChain.events.map((event) => event.seq), [301]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a frozen continuation never parses an oversized event appended beyond throughSeq", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 2);
    const frozen = store.readEventPage("s_abc", { afterSeq: 0, limit: 1 });
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    assert.equal(frozen.page.throughSeq, 2);

    // Append one valid event larger than the page's per-record ceiling in fixed chunks, avoiding a
    // correspondingly large test allocation. The frozen chain owns only events 1-2.
    const fd = openSync(join(root, "s_abc", "events.ndjson"), "a");
    try {
      writeSync(fd, Buffer.from('{"seq":3,"ts":3,"payload":{"kind":"agent_message","text":"'));
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let written = 0; written < HISTORY_PAGE_MAX_BYTES; written += chunk.length) writeSync(fd, chunk);
      writeSync(fd, Buffer.from('"}}\n'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    const continuation = store.readEventPage("s_abc", {
      afterSeq: frozen.page.nextAfterSeq,
      limit: 1,
      logEpoch: frozen.page.logEpoch,
      throughSeq: frozen.page.throughSeq,
    });
    assert.equal(continuation.ok, true);
    if (continuation.ok) {
      assert.deepEqual(continuation.events.map((event) => event.seq), [2]);
      assert.equal(continuation.page.hasMore, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy indexed seeks and continuations never rescan a large history from byte zero", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-seek-"));
  const writer = new SessionStore(root);
  try {
    writer.create(meta());
    for (let i = 1; i <= 1_200; i++) {
      writer.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` }, i);
    }
    const scanStarts: number[] = [];
    const reader = new SessionStore(root, (startOffset) => scanStarts.push(startOffset));
    const first = reader.readEventPage("s_abc", { afterSeq: 900, limit: 5 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(scanStarts.length > 0);
    assert.ok(scanStarts.every((offset) => offset > 0), `unexpected full-prefix scan: ${scanStarts}`);

    scanStarts.length = 0;
    const continuation = reader.readEventPage("s_abc", {
      afterSeq: first.page.nextAfterSeq,
      limit: 5,
      logEpoch: first.page.logEpoch,
      throughSeq: first.page.throughSeq,
    });
    assert.equal(continuation.ok, true);
    assert.ok(scanStarts.length > 0);
    assert.ok(scanStarts.every((offset) => offset > 0), `continuation rescanned prefix: ${scanStarts}`);

    writer.appendEvent("s_abc", { kind: "agent_message", text: "appended-after-freeze" }, 1_201);
    scanStarts.length = 0;
    const afterAppend = reader.readEventPage("s_abc", {
      afterSeq: continuation.ok ? continuation.page.nextAfterSeq : first.page.nextAfterSeq,
      limit: 5,
      logEpoch: first.page.logEpoch,
      throughSeq: first.page.throughSeq,
    });
    assert.equal(afterAppend.ok, true);
    assert.ok(scanStarts.length > 0);
    assert.ok(scanStarts.every((offset) => offset > 0), `append invalidation rescanned prefix: ${scanStarts}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy indexed first append validates only the bounded tail interval", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-append-index-"));
  const writer = new SessionStore(root);
  try {
    writer.create(meta());
    for (let i = 1; i <= 1_200; i++) {
      writer.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` }, i);
    }
    writer.flush("s_abc");

    const scanStarts: number[] = [];
    const appender = new SessionStore(root, (startOffset) => scanStarts.push(startOffset));
    appender.appendEvent("s_abc", { kind: "agent_message", text: "bounded-append" }, 1_201);
    assert.ok(scanStarts.length > 0);
    assert.ok(scanStarts.every((offset) => offset > 0), `healthy append rescanned prefix: ${scanStarts}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history indexes retain the exact MAMHIDX1 durable compatibility magic", () => {
  const { store, root } = tmpStore();
  const indexPath = join(root, "s_abc", "events.idx");
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "indexed history" }, 1);

    const index = readFileSync(indexPath);
    assert.equal(index.subarray(0, 8).toString("ascii"), "MAMHIDX1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history index is rebuilt from the authoritative log when missing, malformed, or torn", () => {
  const { store, root } = tmpStore();
  const indexPath = join(root, "s_abc", "events.idx");
  try {
    store.create(meta());
    for (let i = 1; i <= 260; i++) {
      store.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` });
    }
    rmSync(indexPath, { force: true });
    const rebuilt = store.readEventPage("s_abc", { afterSeq: 250, limit: 10 });
    assert.equal(rebuilt.ok, true);
    if (rebuilt.ok) assert.deepEqual(rebuilt.events.map((event) => event.seq), [251, 252, 253, 254, 255, 256, 257, 258, 259, 260]);
    assert.equal(existsSync(indexPath), true);

    writeFileSync(indexPath, "not-an-index");
    const malformed = store.readEventPage("s_abc", { afterSeq: 255, limit: 5 });
    assert.equal(malformed.ok, true);
    if (malformed.ok) assert.deepEqual(malformed.events.map((event) => event.seq), [256, 257, 258, 259, 260]);

    appendFileSync(indexPath, Buffer.from([0xff])); // incomplete fixed-width record
    const torn = store.readEventPage("s_abc", { afterSeq: 259, limit: 1 });
    assert.equal(torn.ok, true);
    if (torn.ok) assert.deepEqual(torn.events.map((event) => event.seq), [260]);

    // Corrupt only the middle checkpoint's sequence while preserving its safe-integer shape and
    // monotonic ordering (1, 130, 257). Header/last-record-only validation would accept this and
    // seek the healthy log with the wrong expected seq.
    const middleSeqOffset = 24 + 16;
    const interiorCorruption = readFileSync(indexPath);
    assert.equal(interiorCorruption.readBigUInt64LE(middleSeqOffset), 129n);
    interiorCorruption.writeBigUInt64LE(130n, middleSeqOffset);
    writeFileSync(indexPath, interiorCorruption);
    const recoveredInterior = new SessionStore(root).readEventPage("s_abc", { afterSeq: 129, limit: 1 });
    assert.equal(recoveredInterior.ok, true);
    if (recoveredInterior.ok) assert.deepEqual(recoveredInterior.events.map((event) => event.seq), [130]);
    assert.equal(readFileSync(indexPath).readBigUInt64LE(middleSeqOffset), 129n, "index was rebuilt from NDJSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history index rebuilds valid-looking checkpoint omissions that violate sparse intervals", () => {
  const { store, root } = tmpStore();
  const indexPath = join(root, "s_abc", "events.idx");
  try {
    store.create(meta());
    for (let i = 1; i <= 400; i++) {
      store.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` }, i);
    }
    const valid = readFileSync(indexPath);
    const headerBytes = 24;
    const recordBytes = 16;
    const checkpoint385 = headerBytes + 3 * recordBytes;
    assert.equal(valid.readBigUInt64LE(checkpoint385), 385n);
    // Keep a valid header and two individually valid, monotonic records, but omit 129 and 257.
    writeFileSync(indexPath, Buffer.concat([
      valid.subarray(0, headerBytes + recordBytes),
      valid.subarray(checkpoint385, checkpoint385 + recordBytes),
    ]));

    const recovered = new SessionStore(root).readEventPage("s_abc", { afterSeq: 384, limit: 1 });
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.deepEqual(recovered.events.map((event) => event.seq), [385]);
    const repaired = readFileSync(indexPath);
    assert.equal(repaired.readBigUInt64LE(headerBytes + recordBytes), 129n);
    assert.equal(repaired.readBigUInt64LE(headerBytes + 2 * recordBytes), 257n);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history reset invalidates frozen page continuations and publishes the new snapshot epoch", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "old-1" });
    store.appendEvent("s_abc", { kind: "agent_message", text: "old-2" });
    const old = store.readEventPage("s_abc", { afterSeq: 0, limit: 1 });
    assert.equal(old.ok, true);
    if (!old.ok) return;

    store.resetEvents("s_abc");
    store.appendEvent("s_abc", { kind: "agent_message", text: "new" });
    const stale = store.readEventPage("s_abc", {
      afterSeq: old.page.nextAfterSeq,
      limit: 1,
      logEpoch: old.page.logEpoch,
      throughSeq: old.page.throughSeq,
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "history_epoch_changed",
      error: "session history was reset during pagination",
    });
    assert.equal(metaToSnapshot(store.readMeta("s_abc")!).historyEpoch, old.page.logEpoch + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable reset intent recovers every crash point to one empty next epoch", () => {
  for (const crashPoint of ["after_intent", "after_truncate", "after_meta"] as const) {
    const { store, root } = tmpStore();
    try {
      store.create(meta({ preview: "old" }));
      store.appendEvent("s_abc", { kind: "agent_message", text: "old-1" });
      store.appendEvent("s_abc", { kind: "agent_message", text: "old-2" });
      store.flush("s_abc");
      const frozen = store.readEventPage("s_abc", { afterSeq: 0, limit: 1 });
      assert.equal(frozen.ok, true);
      if (!frozen.ok) continue;

      const sessionDir = join(root, "s_abc");
      const eventsPath = join(sessionDir, "events.ndjson");
      const metaPath = join(sessionDir, "meta.json");
      writeFileSync(
        join(sessionDir, "events.reset.json"),
        JSON.stringify({ version: 1, nextEpoch: frozen.page.logEpoch + 1 }),
      );
      if (crashPoint !== "after_intent") writeFileSync(eventsPath, "");
      if (crashPoint === "after_meta") {
        const disk = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
        writeFileSync(metaPath, JSON.stringify({
          ...disk,
          seq: 0,
          preview: null,
          logEpoch: frozen.page.logEpoch + 1,
        }));
      }

      const revived = new SessionStore(root);
      assert.deepEqual(revived.readEvents("s_abc"), [], `${crashPoint}: legacy reads complete recovery too`);
      const recovered = revived.readMeta("s_abc")!;
      assert.equal(recovered.seq, 0, crashPoint);
      assert.equal(recovered.preview, null, crashPoint);
      assert.equal(recovered.logEpoch, frozen.page.logEpoch + 1, crashPoint);
      assert.equal(existsSync(join(sessionDir, "events.reset.json")), false, crashPoint);
      const stale = revived.readEventPage("s_abc", {
        afterSeq: frozen.page.nextAfterSeq,
        limit: 1,
        logEpoch: frozen.page.logEpoch,
        throughSeq: frozen.page.throughSeq,
      });
      assert.equal(stale.ok, false, crashPoint);
      if (!stale.ok) assert.equal(stale.code, "history_epoch_changed", crashPoint);
      assert.equal(revived.appendEvent("s_abc", { kind: "agent_message", text: "new" })?.seq, 1, crashPoint);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("history page rejects malformed and half-specified cursors before reading", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    assert.equal(store.readEventPage("s_abc", { afterSeq: -1, limit: 1 }).ok, false);
    assert.equal(store.readEventPage("s_abc", { afterSeq: 0, limit: 201 }).ok, false);
    const half = store.readEventPage("s_abc", { afterSeq: 0, limit: 1, logEpoch: 0 });
    assert.equal(half.ok, false);
    if (!half.ok) assert.equal(half.code, "history_cursor_invalid");

    store.appendEvent("s_abc", { kind: "agent_message", text: "only" });
    const fabricatedTerminal = store.readEventPage("s_abc", {
      afterSeq: 999,
      limit: 1,
      logEpoch: 0,
      throughSeq: 999,
    });
    assert.equal(fabricatedTerminal.ok, false);
    if (!fabricatedTerminal.ok) assert.equal(fabricatedTerminal.code, "history_cursor_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paged history fails closed on a durable malformed record instead of skipping the cursor", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" });
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" });
    const eventsPath = join(root, "s_abc", "events.ndjson");
    const lines = readFileSync(eventsPath, "utf8").trimEnd().split("\n");
    writeFileSync(eventsPath, `${lines[0]}\n{malformed}\n`);
    rmSync(join(root, "s_abc", "events.idx"), { force: true });
    const result = store.readEventPage("s_abc", { afterSeq: 0, limit: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "history_corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paged/indexed history rejects invalid UTF-8 instead of replacement-decoding it", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "valid" }, 1);
    const eventsPath = join(root, "s_abc", "events.ndjson");
    writeFileSync(eventsPath, Buffer.concat([
      Buffer.from('{"seq":1,"ts":1,"payload":{"kind":"agent_message","text":"'),
      Buffer.from([0xc3, 0x28]), // invalid UTF-8 continuation
      Buffer.from('"}}\n'),
    ]));
    rmSync(join(root, "s_abc", "events.idx"), { force: true });
    const result = store.readEventPage("s_abc", { afterSeq: 0, limit: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "history_corrupt");
      assert.match(result.error, /invalid UTF-8/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized complete lines and torn suffixes fail with bounded typed reads", () => {
  for (const shape of ["complete_tail", "torn_suffix", "rebuild_carry"] as const) {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1);
      store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 2);
      store.flush("s_abc");
      const eventsPath = join(root, "s_abc", "events.ndjson");
      const lines = readFileSync(eventsPath, "utf8").trimEnd().split("\n").map((line) => Buffer.from(line));
      const fd = openSync(eventsPath, "r+");
      try {
        if (shape === "complete_tail") {
          const start = readFileSync(eventsPath).length;
          ftruncateSync(fd, start + HISTORY_PAGE_MAX_BYTES + 1);
          writeSync(fd, Buffer.from("\n"), 0, 1, start + HISTORY_PAGE_MAX_BYTES);
        } else if (shape === "torn_suffix") {
          const start = readFileSync(eventsPath).length;
          ftruncateSync(fd, start + HISTORY_PAGE_MAX_BYTES + 1);
        } else {
          writeFileSync(eventsPath, Buffer.concat([lines[0]!, Buffer.from("\n")]));
          const hugeStart = lines[0]!.length + 1;
          const secondStart = hugeStart + HISTORY_PAGE_MAX_BYTES + 1;
          ftruncateSync(fd, secondStart + lines[1]!.length + 1);
          writeSync(fd, Buffer.from("\n"), 0, 1, hugeStart + HISTORY_PAGE_MAX_BYTES);
          writeSync(fd, lines[1]!, 0, lines[1]!.length, secondStart);
          writeSync(fd, Buffer.from("\n"), 0, 1, secondStart + lines[1]!.length);
        }
      } finally {
        closeSync(fd);
      }
      if (shape === "rebuild_carry") rmSync(join(root, "s_abc", "events.idx"), { force: true });
      const result = new SessionStore(root).readEventPage("s_abc", { afterSeq: 0, limit: 10 });
      assert.equal(result.ok, false, shape);
      if (!result.ok) assert.equal(result.code, "history_event_too_large", shape);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("append repairs a torn non-event suffix before assigning the next unique sequence", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" });
    appendFileSync(join(root, "s_abc", "events.ndjson"), '{"seq":2,"ts":');
    const revived = new SessionStore(root);
    const appended = revived.appendEvent("s_abc", { kind: "agent_message", text: "two" });
    assert.equal(appended?.seq, 2);
    assert.deepEqual(revived.readEvents("s_abc").map((event) => event.seq), [1, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append refuses malformed or non-contiguous complete authoritative history without writing", () => {
  for (const shape of ["gap", "malformed"] as const) {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1);
      store.flush("s_abc");
      const eventsPath = join(root, "s_abc", "events.ndjson");
      appendFileSync(eventsPath, shape === "gap"
        ? '{"seq":3,"ts":3,"payload":{"kind":"agent_message","text":"gap"}}\n'
        : '{malformed}\n');
      const before = readFileSync(eventsPath);
      assert.throws(
        () => new SessionStore(root).appendEvent("s_abc", { kind: "agent_message", text: "must-not-append" }),
        /history|JSON|contiguous/i,
        shape,
      );
      assert.deepEqual(readFileSync(eventsPath), before, `${shape}: rejected append leaves authoritative bytes unchanged`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("registration snapshots advertise the durable log tail after a lost metadata flush", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "durable before flush" });
    const revived = new SessionStore(root);
    assert.equal(revived.readMeta("s_abc")?.seq, 0, "disk metadata intentionally lags the append");
    assert.equal(revived.snapshots()[0]?.seq, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration re-reads metadata after recovering a reset intent published during enumeration", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta({ preview: "old" }));
    store.appendEvent("s_abc", { kind: "agent_message", text: "old" });
    store.flush("s_abc");
    let published = false;
    class ResetDuringSnapshotsStore extends SessionStore {
      override listSessions(): SessionMeta[] {
        const listed = super.listSessions();
        if (!published) {
          published = true;
          writeFileSync(
            join(root, "s_abc", "events.reset.json"),
            JSON.stringify({ version: 1, nextEpoch: 1 }),
          );
        }
        return listed;
      }
    }

    const snapshot = new ResetDuringSnapshotsStore(root).snapshots()[0]!;
    assert.equal(snapshot.seq, 0);
    assert.equal(snapshot.historyEpoch, 2, "local epoch 1 is fenced into current-peer wire epoch 2");
    assert.equal(readFileSync(join(root, "s_abc", "events.ndjson"), "utf8"), "");
    assert.equal(existsSync(join(root, "s_abc", "events.reset.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken derived index never blocks an authoritative event append", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" });
    const indexPath = join(root, "s_abc", "events.idx");
    rmSync(indexPath, { force: true });
    mkdirSync(indexPath); // force atomic index replacement to fail without damaging events.ndjson
    const revived = new SessionStore(root);
    assert.equal(revived.appendEvent("s_abc", { kind: "agent_message", text: "two" })?.seq, 2);
    assert.deepEqual(revived.readEvents("s_abc").map((event) => event.seq), [1, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history pages stop before crossing the serialized byte budget", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const text = "x".repeat(17 * 1024 * 1024);
    store.appendEvent("s_abc", { kind: "agent_message", text });
    store.appendEvent("s_abc", { kind: "agent_message", text });
    const first = store.readEventPage("s_abc", { afterSeq: 0, limit: 2 });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.events.length, 1);
    assert.equal(first.page.hasMore, true);
    const second = store.readEventPage("s_abc", {
      afterSeq: first.page.nextAfterSeq,
      limit: 2,
      logEpoch: first.page.logEpoch,
      throughSeq: first.page.throughSeq,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.deepEqual(second.events.map((event) => event.seq), [2]);
    assert.ok(HISTORY_PAGE_MAX_BYTES < 34 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lossless compaction preserves bytes, sparse-index offsets, frozen cursors, and append sequence", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-"));
  const policy = {
    triggerActiveBytes: 1,
    retainActiveBytes: 300,
    retainActiveEvents: 5,
    maxSegmentBytes: 4 * 1024,
    orphanGraceMs: 0,
  };
  try {
    const store = new SessionStore(root, undefined, policy);
    store.create(meta());
    for (let i = 1; i <= 60; i++) {
      store.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}-${"x".repeat(40)}` }, 1_000 + i);
    }
    store.flushAll();
    const sessionDir = join(root, "s_abc");
    const beforeBytes = readFileSync(join(sessionDir, "events.ndjson"));
    const reader = new SessionStore(root, undefined, policy);
    const frozen = reader.readEventPage("s_abc", { afterSeq: 0, limit: 7 });
    assert.equal(frozen.ok, true);
    if (!frozen.ok) return;
    const indexBefore = readFileSync(join(sessionDir, "events.idx"));

    assert.equal(store.acquireLock("s_abc", "maintenance"), true);
    const compacted = store.compactHistory("s_abc", "maintenance", true);
    store.releaseLock("s_abc", "maintenance");
    assert.equal(compacted.compacted, true);
    assert.ok(compacted.bytesArchived > 0 && compacted.bytesArchived < beforeBytes.length);
    assert.equal(statSync(join(sessionDir, "events.ndjson")).isDirectory(), true, "legacy writers are fenced closed");
    assert.throws(() => appendFileSync(join(sessionDir, "events.ndjson"), "split-brain"));

    const manifest = JSON.parse(readFileSync(join(sessionDir, "events.manifest.json"), "utf8")) as {
      activeFile: string;
      segments: Array<{ file: string }>;
    };
    const retiredFile = readdirSync(sessionDir).find((file) => file.startsWith("events.retired."))!;
    rmSync(join(sessionDir, "events.ndjson"), { recursive: true, force: true });
    renameSync(join(sessionDir, retiredFile), join(sessionDir, "events.ndjson"));
    writeFileSync(join(sessionDir, "events.legacy-fence.json"), JSON.stringify({
      version: 1,
      activeFile: manifest.activeFile,
      retiredFile,
    }));
    assert.equal(new SessionStore(root, undefined, policy).readEventPage("s_abc", { afterSeq: 0, limit: 1 }).ok, true);
    assert.equal(statSync(join(sessionDir, "events.ndjson")).isDirectory(), true, "committed fence intent recovers");
    assert.equal(existsSync(join(sessionDir, "events.legacy-fence.json")), false);
    const logicalBytes = Buffer.concat([
      ...manifest.segments.map((segment) => readFileSync(join(sessionDir, segment.file))),
      readFileSync(join(sessionDir, manifest.activeFile)),
    ]);
    assert.deepEqual(logicalBytes, beforeBytes, "compaction must preserve authoritative NDJSON byte-for-byte");
    assert.deepEqual(readFileSync(join(sessionDir, "events.idx")), indexBefore, "logical offsets stay unchanged");
    assert.deepEqual(store.readEvents("s_abc").map((event) => event.seq), Array.from({ length: 60 }, (_, i) => i + 1));

    const paged = [...frozen.events];
    let afterSeq = frozen.page.nextAfterSeq;
    while (afterSeq < frozen.page.throughSeq) {
      const page = reader.readEventPage("s_abc", {
        afterSeq,
        limit: 7,
        logEpoch: frozen.page.logEpoch,
        throughSeq: frozen.page.throughSeq,
      });
      assert.equal(page.ok, true);
      if (!page.ok) break;
      paged.push(...page.events);
      afterSeq = page.page.nextAfterSeq;
    }
    assert.deepEqual(paged.map((event) => event.seq), Array.from({ length: 60 }, (_, i) => i + 1));
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "after-compaction" })?.seq, 61);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable segment tampering fails paged history closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-integrity-"));
  const policy = {
    triggerActiveBytes: 1,
    retainActiveBytes: 64,
    retainActiveEvents: 1,
    maxSegmentBytes: 64 * 1024,
    orphanGraceMs: 0,
  };
  try {
    const store = new SessionStore(root, undefined, policy);
    store.create(meta());
    for (let i = 0; i < 20; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` });
    store.flushAll();
    assert.equal(store.acquireLock("s_abc", "maintenance"), true);
    assert.equal(store.compactHistory("s_abc", "maintenance", true).compacted, true);
    store.releaseLock("s_abc", "maintenance");
    const sessionDir = join(root, "s_abc");
    const manifest = JSON.parse(readFileSync(join(sessionDir, "events.manifest.json"), "utf8")) as {
      segments: Array<{ file: string }>;
    };
    appendFileSync(join(sessionDir, manifest.segments[0]!.file), "tamper");
    const result = new SessionStore(root, undefined, policy).readEventPage("s_abc", { afterSeq: 0, limit: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "history_corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated compaction, orphan collection, and reset retain no destructive archive residue", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-reset-"));
  const policy = {
    triggerActiveBytes: Number.MAX_SAFE_INTEGER,
    retainActiveBytes: 80,
    retainActiveEvents: 2,
    maxSegmentBytes: 2 * 1024,
    orphanGraceMs: 0,
  };
  try {
    const store = new SessionStore(root, undefined, policy);
    store.create(meta());
    for (let i = 0; i < 30; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `first-${i}` });
    store.flushAll();
    assert.equal(store.acquireLock("s_abc", "maintenance"), true);
    assert.equal(store.compactHistory("s_abc", "maintenance", true).compacted, true);
    store.releaseLock("s_abc", "maintenance");
    for (let i = 0; i < 30; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `second-${i}` });
    store.flushAll();
    assert.equal(store.acquireLock("s_abc", "maintenance"), true);
    assert.equal(store.compactHistory("s_abc", "maintenance", true).compacted, true);
    store.releaseLock("s_abc", "maintenance");

    const sessionDir = join(root, "s_abc");
    const beforeMaintenance = readdirSync(sessionDir);
    assert.ok(beforeMaintenance.some((file) => file === "events.ndjson"), "superseded readers get a grace generation");
    const maintenance = store.maintainHistories("idle-maintenance", 1);
    assert.ok(maintenance.orphansRemoved >= 1);
    assert.deepEqual(store.readEvents("s_abc").map((event) => event.seq), Array.from({ length: 60 }, (_, i) => i + 1));

    const oldEpoch = store.readMeta("s_abc")?.logEpoch ?? 0;
    store.resetEvents("s_abc");
    assert.deepEqual(store.readEvents("s_abc"), []);
    assert.equal(store.readMeta("s_abc")?.logEpoch, oldEpoch + 1);
    assert.equal(existsSync(join(sessionDir, "events.manifest.json")), false);
    assert.equal(
      readdirSync(sessionDir).some((file) =>
        file.startsWith("events.active.") || file.startsWith("events.segment.") || file.startsWith("events.retired.")),
      false,
    );
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "new-epoch" })?.seq, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle maintenance never compacts a session whose writer lock is live", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-lock-"));
  const policy = {
    triggerActiveBytes: 1,
    retainActiveBytes: 32,
    retainActiveEvents: 1,
    maxSegmentBytes: 64 * 1024,
    orphanGraceMs: 0,
  };
  try {
    const writer = new SessionStore(root, undefined, policy);
    writer.create(meta());
    for (let i = 0; i < 10; i++) writer.appendEvent("s_abc", { kind: "agent_message", text: `event-${i}` });
    writer.flushAll();
    assert.equal(writer.acquireLock("s_abc", "live-turn"), true);
    const maintenance = new SessionStore(root, undefined, policy).maintainHistories("maintenance", 1);
    assert.deepEqual(maintenance, { inspected: 0, compacted: 0, bytesArchived: 0, orphansRemoved: 0, errors: 0 });
    assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false);
    writer.releaseLock("s_abc", "live-turn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle maintenance rotates fairly and rebuilds missing indexes off the prompt path", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-fair-"));
  const policy = {
    triggerActiveBytes: 1,
    retainActiveBytes: 32,
    retainActiveEvents: 1,
    maxSegmentBytes: 64 * 1024,
    orphanGraceMs: 0,
  };
  try {
    const store = new SessionStore(root, undefined, policy);
    const sessionIds = Array.from({ length: 6 }, (_, i) => `s_${i}`);
    for (const sessionId of sessionIds) {
      store.create(meta({ sessionId }));
      for (let i = 0; i < 12; i++) {
        store.appendEvent(sessionId, { kind: "agent_message", text: `${sessionId}-event-${i}` });
      }
      store.flush(sessionId);
      rmSync(join(root, sessionId, "events.idx"), { force: true });
    }
    for (let pass = 0; pass < 3; pass++) {
      const result = store.maintainHistories("maintenance", 2);
      assert.equal(result.inspected, 2);
      assert.equal(result.errors, 0);
    }
    for (const sessionId of sessionIds) {
      assert.equal(existsSync(join(root, sessionId, "events.manifest.json")), true, `${sessionId} was not starved`);
      assert.equal(existsSync(join(root, sessionId, "events.idx")), true, `${sessionId} index was not rebuilt`);
      const page = store.readEventPage(sessionId, { afterSeq: 10, limit: 2 });
      assert.equal(page.ok, true);
      if (page.ok) assert.deepEqual(page.events.map((event) => event.seq), [11, 12]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
