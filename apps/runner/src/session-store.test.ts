import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROTOCOL_VERSION,
  SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET,
  SESSION_EVENT_WIRE_PROJECTION_VARIANTS as VARIANTS,
  sessionEventWireProjectionVariant,
} from "@wollipog/protocol";

/** The wire epoch a peer sees for a given local epoch. Expressed through the projection arithmetic
 * rather than hardcoded, so adding an event-omission policy does not silently invalidate these
 * expectations the way a literal would. */
function wireEpoch(localEpoch: number, peer: number): number {
  return SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET +
    localEpoch * VARIANTS + sessionEventWireProjectionVariant(peer);
}

/** A peer that needs no additive session-event projection at all. It moves whenever a new event
 * kind gets an older-peer omission policy, so these tests name the boundary instead of a literal:
 * It moves only when a policy is added, which is a migration in its own right. */
const CURRENT_PEER = PROTOCOL_VERSION;
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
  symlinkSync,
  writeSync,
} from "node:fs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { join } from "node:path";
import {
  HISTORY_PAGE_MAX_BYTES,
  SessionStore,
  isAdoptedSession,
  metaToSnapshot,
  type DurableBackgroundJob,
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
    store.create(meta({
      sessionSlashCommandProvenance,
      providerAccountId: "work",
      providerAccountLabel: "Work",
      providerAccountProvider: "codex",
      providerCredentialHome: "/credentials/work",
    }));
    assert.equal(store.has("s_abc"), true);
    const m = store.readMeta("s_abc");
    assert.equal(m?.agentSessionId, "thread_123");
    assert.equal(m?.driver, "codex");
    assert.deepEqual(m?.sessionSlashCommandProvenance, sessionSlashCommandProvenance);
    const restarted = new SessionStore(root).readMeta("s_abc");
    assert.deepEqual({
      id: restarted?.providerAccountId,
      label: restarted?.providerAccountLabel,
      provider: restarted?.providerAccountProvider,
      credentialHome: restarted?.providerCredentialHome,
      transcript: restarted?.agentSessionId,
    }, {
      id: "work",
      label: "Work",
      provider: "codex",
      credentialHome: "/credentials/work",
      transcript: "thread_123",
    });
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
    assert.equal(store.snapshots(CURRENT_PEER)[0]?.seq, 3);
    assert.equal(store.snapshots(86)[0]?.historyEpoch, wireEpoch(0, 86));
    assert.equal(store.snapshots(86, true)[0]?.historyEpoch, 0);
    assert.equal(store.snapshots(CURRENT_PEER)[0]?.historyEpoch, wireEpoch(0, CURRENT_PEER));
    assert.deepEqual(store.projectEventForProtocol("s_abc", first, 86), first);
    assert.equal(store.projectEventForProtocol("s_abc", completion, 86), null);
    assert.deepEqual(store.projectEventForProtocol("s_abc", second, 86), {
      ...second,
      seq: 2,
    });
    assert.deepEqual(store.projectEventForProtocol("s_abc", completion, CURRENT_PEER), completion);

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
    assert.deepEqual(store.readEventsForProtocol("s_abc", 0, CURRENT_PEER).map((event) => event.seq), [1, 2, 3]);

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
      logEpoch: wireEpoch(0, 86),
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
      page: { logEpoch: wireEpoch(0, 86), throughSeq: 2, nextAfterSeq: 2, hasMore: false },
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

test("v129 omits native policy decisions in its own dense history generation", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const first = store.appendEvent("s_abc", { kind: "agent_message", text: "before" }, 1001)!;
    const decision = store.appendEvent("s_abc", {
      kind: "policy_hook_decision",
      auditId: "audit-1",
      requestId: "policy-hook:s_abc:1",
      stage: "resolution",
      outcome: "denied",
      actor: { kind: "policy" },
      governancePolicyId: "deny-shell",
      toolCallId: "tool-1",
    }, 1002)!;
    const second = store.appendEvent("s_abc", { kind: "agent_message", text: "after" }, 1003)!;

    assert.deepEqual(store.projectEventForProtocol("s_abc", first, 129), first);
    assert.equal(store.projectEventForProtocol("s_abc", decision, 129), null);
    assert.deepEqual(store.projectEventForProtocol("s_abc", second, 129), { ...second, seq: 2 });
    assert.deepEqual(store.readEventsForProtocol("s_abc", 0, 129).map((event) => [event.seq, event.payload.kind]), [
      [1, "agent_message"],
      [2, "agent_message"],
    ]);
    assert.deepEqual(store.readEventsForProtocol("s_abc", 0, 130).map((event) => [event.seq, event.payload.kind]), [
      [1, "agent_message"],
      [2, "policy_hook_decision"],
      [3, "agent_message"],
    ]);
    assert.deepEqual([store.snapshots(129)[0]?.seq, store.snapshots(129)[0]?.historyEpoch],
      [2, wireEpoch(0, 129)]);
    assert.deepEqual([store.snapshots(130)[0]?.seq, store.snapshots(130)[0]?.historyEpoch],
      [3, wireEpoch(0, 130)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration keeps history neutral until a negotiated wire generation is published", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_response_completed" }, 1002);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1003);

    const exact = store.snapshots(CURRENT_PEER, true)[0]!;
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
    const intermediate = store.projectSnapshotForProtocol(exact, 129);
    const currentGeneration = store.projectSnapshotForProtocol(exact, CURRENT_PEER);
    assert.deepEqual([v86.seq, v86.historyEpoch], [2, wireEpoch(0, 86)]);
    assert.deepEqual([intermediate.seq, intermediate.historyEpoch], [3, wireEpoch(0, 129)]);
    assert.deepEqual([currentGeneration.seq, currentGeneration.historyEpoch], [3, wireEpoch(0, CURRENT_PEER)]);
    assert.deepEqual(store.projectSnapshotForProtocol(exact, 86), v86,
      "a v86 reconnect republishes the same negotiated generation");
    assert.deepEqual(store.projectSnapshotForProtocol(exact, 129), intermediate,
      "a v129 reconnect republishes its projected generation");
    assert.deepEqual(store.projectSnapshotForProtocol(exact, CURRENT_PEER), currentGeneration,
      "a current-peer reconnect republishes the same negotiated generation");

    const legacyPage = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 10 }, 86);
    const currentPage = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 10 }, CURRENT_PEER);
    assert.equal(legacyPage.ok, true);
    assert.equal(currentPage.ok, true);
    if (legacyPage.ok && currentPage.ok) {
      assert.equal(legacyPage.page.logEpoch, v86.historyEpoch);
      assert.equal(currentPage.page.logEpoch, currentGeneration.historyEpoch);
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

test("worktree setup state is omitted for pre-v141 control planes", () => {
  const worktree = {
    id: "wt-one",
    path: "/home/me/repo/.agent-worktrees/s_abc",
    branch: "fix/setup",
    source: "created" as const,
    setup: {
      status: "failed" as const,
      configHash: "a".repeat(64),
      attemptId: "attempt-one",
      environmentKeys: ["PROJECT_ROOT"],
      copies: [],
      steps: [],
      error: "required setup failed",
    },
  };
  assert.equal(metaToSnapshot(meta({ worktrees: [worktree] }), 140).worktrees?.[0]?.setup, undefined);
  assert.equal(metaToSnapshot(meta({ worktrees: [worktree] }), 141).worktrees?.[0]?.setup?.status, "failed");
});

test("worktree ports and teardown state are omitted for pre-v145 control planes", () => {
  const worktree = {
    id: "wt-one",
    path: "/home/me/repo/.agent-worktrees/s_abc",
    branch: "fix/teardown",
    source: "created" as const,
    portBlock: { start: 42_000, end: 42_019, size: 20 },
    teardown: {
      status: "completed_with_failures" as const,
      configHash: "a".repeat(64),
      attemptId: "attempt-one",
      startedAt: 1,
      completedAt: 2,
      steps: [{
        name: "Stop Server",
        status: "failed" as const,
        optional: false,
        startedAt: 1,
        durationMs: 1,
        error: "exit 1",
        stdout: "out",
        stderr: "err",
      }],
    },
  };
  const legacy = metaToSnapshot(meta({ worktrees: [worktree] }), 144).worktrees?.[0];
  assert.equal(legacy?.portBlock, undefined);
  assert.equal(legacy?.teardown, undefined);
  const current = metaToSnapshot(meta({ worktrees: [worktree] }), 145).worktrees?.[0];
  assert.deepEqual(current?.portBlock, worktree.portBlock);
  assert.equal(current?.teardown?.steps[0]?.stderr, "err");
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
    assert.deepEqual([legacy.seq, legacy.historyEpoch], [0, wireEpoch(0, 86)],
      "legacy fallback remains in its dense sequence space");
    const intermediate = store.snapshots(129)[0]!;
    assert.deepEqual([intermediate.seq, intermediate.historyEpoch], [0, wireEpoch(0, 129)],
      "an intermediate projected peer also fails closed in its own generation");
    const current = store.snapshots(CURRENT_PEER)[0]!;
    assert.deepEqual([current.seq, current.historyEpoch], [3, wireEpoch(0, CURRENT_PEER)],
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

test("every distinct wire projection gets its own dense sequence space", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    // Four omission policies mean five projections, and they must never share an epoch: a control
    // plane that hydrated through one and reconnects through the other has to resync rather than
    // reuse cursors whose sequence numbers now name different events.
    const epochs = [86, 129, 147, 170, CURRENT_PEER].map((peer) => store.snapshots(peer)[0]!.historyEpoch);
    assert.equal(new Set(epochs).size, epochs.length, `distinct epochs per projection, got ${epochs.join(",")}`);
    assert.deepEqual(epochs, [86, 129, 147, 170, CURRENT_PEER].map((peer) => wireEpoch(0, peer)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the projection-count encoding fences every prior one-policy wire generation", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    const legacy = store.snapshots(86)[0]!;
    const intermediate = store.snapshots(129)[0]!;
    const recent = store.snapshots(147)[0]!;
    const previous = store.snapshots(170)[0]!;
    const lastFiveVariant = store.snapshots(203)[0]!;
    const current = store.snapshots(CURRENT_PEER)[0]!;

    // Before v130 the one-policy encoding at local epoch zero was 1 for v86 and 0 for every
    // v87+ peer. Before v148 the three-variant encoding used offset 2, before v171 the
    // four-variant encoding used offset 5, and before v204 the five-variant encoding used offset 9.
    // The advanced offset makes every current projection larger than each predecessor at the same
    // local epoch, so every control plane resyncs when the runner upgrades even if its protocol
    // changes at the same time.
    assert.notEqual(legacy.historyEpoch, 1);
    assert.notEqual(intermediate.historyEpoch, 0);
    assert.equal(legacy.historyEpoch, 19);
    assert.equal(intermediate.historyEpoch, 18);
    assert.equal(recent.historyEpoch, 17);
    assert.equal(previous.historyEpoch, 16);
    assert.equal(lastFiveVariant.historyEpoch, 15);

    assert.equal(current.historyEpoch, 14);
    for (let localEpoch = 0; localEpoch < 8; localEpoch++) {
      const retiredFormatMaximum = localEpoch * 2 + 1;
      const precedingFormatMaximum = 2 + localEpoch * 3 + 2;
      const previousFormatMaximum = 5 + localEpoch * 4 + 3;
      const fiveVariantFormatMaximum = 9 + localEpoch * 5 + 4;
      for (const peer of [86, 129, 147, 170, 203, CURRENT_PEER]) {
        assert.ok(store.projectedHistoryEpoch(localEpoch, peer) > retiredFormatMaximum,
          `v${peer} local epoch ${localEpoch} sorts above the retired encoding`);
        assert.ok(store.projectedHistoryEpoch(localEpoch, peer) > precedingFormatMaximum,
          `v${peer} local epoch ${localEpoch} sorts above the preceding three-variant encoding`);
        assert.ok(store.projectedHistoryEpoch(localEpoch, peer) > previousFormatMaximum,
          `v${peer} local epoch ${localEpoch} sorts above the preceding four-variant encoding`);
        assert.ok(store.projectedHistoryEpoch(localEpoch, peer) > fiveVariantFormatMaximum,
          `v${peer} local epoch ${localEpoch} sorts above the preceding five-variant encoding`);
      }
    }

    const stale = store.readEventPageForProtocol("s_abc", {
      afterSeq: 0,
      limit: 1,
      logEpoch: 0,
      throughSeq: 0,
    }, CURRENT_PEER);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "history_epoch_changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("peer protocol changes fence dense sequence spaces with distinct wire epochs", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.resetEvents("s_abc");
    assert.equal(store.snapshots(86)[0]?.historyEpoch, wireEpoch(1, 86));
    assert.equal(store.snapshots(129)[0]?.historyEpoch, wireEpoch(1, 129));
    assert.equal(store.snapshots(CURRENT_PEER)[0]?.historyEpoch, wireEpoch(1, CURRENT_PEER));

    const legacy = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, 86);
    const current = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, CURRENT_PEER);
    assert.equal(legacy.ok, true);
    assert.equal(current.ok, true);
    if (legacy.ok && current.ok) {
      assert.equal(legacy.page.logEpoch, wireEpoch(1, 86));
      assert.equal(current.page.logEpoch, wireEpoch(1, CURRENT_PEER));
      assert.notEqual(legacy.page.logEpoch, current.page.logEpoch);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current protocol pagination decodes projected epochs after multiple history resets", () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.resetEvents("s_abc");
    store.resetEvents("s_abc");
    store.appendEvent("s_abc", { kind: "agent_message", text: "one" }, 1001);
    store.appendEvent("s_abc", { kind: "agent_message", text: "two" }, 1002);

    const first = store.readEventPageForProtocol("s_abc", { afterSeq: 0, limit: 1 }, PROTOCOL_VERSION);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.page.logEpoch, wireEpoch(2, CURRENT_PEER));
    assert.equal(first.page.hasMore, true);
    const second = store.readEventPageForProtocol("s_abc", {
      afterSeq: first.page.nextAfterSeq,
      limit: 1,
      logEpoch: first.page.logEpoch,
      throughSeq: first.page.throughSeq,
    }, PROTOCOL_VERSION);
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.deepEqual(second.events.map((event) => event.payload.kind), ["agent_message"]);
      assert.equal(second.page.hasMore, false);
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
    providerConversationHome: "/private-account-home",
    providerUnstartedThreadId: "unused-thread-id",
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
  assert.equal((snap as Record<string, unknown>).providerConversationHome, undefined);
  assert.equal((snap as Record<string, unknown>).providerUnstartedThreadId, undefined);
  assert.equal(snap.id, "s_abc");
  assert.equal(snap.controlPlaneLaunchId, "launch-proof-1");
  assert.equal(snap.seq, 0);
  assert.equal(snap.resolvedModel, "claude-opus-5[1m]");
});

test("v126 snapshots publish service tier while older control planes receive no unknown config key", () => {
  const current = metaToSnapshot(meta({ config: { model: "gpt", effort: "high", serviceTier: "fast" } }), 126);
  assert.equal(current.config.serviceTier, "fast");
  const legacy = metaToSnapshot(meta({ config: { model: "gpt", effort: "high", serviceTier: "fast" } }), 125);
  assert.deepEqual(legacy.config, { model: "gpt", effort: "high" });
});

test("v132 snapshots preserve a precise capacity wait reason while older peers receive no unknown field", () => {
  const capacityWait = {
    kind: "target_quota" as const,
    description: "Execution target cloud-a is using 2 of 2 slots",
    usedUnits: 2,
    limitUnits: 2,
    requiredUnits: 1,
    targetId: "cloud-a",
  };
  assert.equal(metaToSnapshot(meta({ status: "queued", capacityWait }), 131).capacityWait, undefined);
  assert.deepEqual(metaToSnapshot(meta({ status: "queued", capacityWait }), 132).capacityWait, capacityWait);
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
    continuationMissingResultAt: 24,
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
    continuationMissingResultAt: undefined,
    assistantResultPersistedAt: 24,
    endedBy: undefined,
  }]);
  assert.equal(metaToSnapshot(meta({ backgroundJobs }), 133).backgroundJobs?.[0]?.continuationMissingResultAt,
    undefined, "older control planes never receive the additive terminal-recovery field");
  assert.equal(metaToSnapshot(meta({ backgroundJobs }), 134).backgroundJobs?.[0]?.continuationMissingResultAt, 24);
  const serialized = JSON.stringify(metaToSnapshot(meta({ backgroundJobs }), 82));
  assert.equal(serialized.includes("tool-secret"), false);
  assert.equal(serialized.includes("provider/artifact"), false);
  assert.equal(serialized.includes("Ubuntu"), false);
  assert.equal(serialized.includes("structuredDeliveryPublishedAt"), false);
});

test("v192 snapshots say who ended a job, naming a person by role and never by account (#1849)", () => {
  const job = (id: string, endedBy?: DurableBackgroundJob["endedBy"]): DurableBackgroundJob => ({
    id,
    parentTurnId: "turn-1",
    runnerId: "runner-1",
    workspaceId: "repo",
    context: { kind: "native" },
    launchType: "monitor",
    registeredAt: 10,
    terminalStatus: "killed",
    terminalObservedAt: 20,
    continuationRequired: false,
    ...(endedBy ? { endedBy } : {}),
  });
  const backgroundJobs = [
    job("owner-stop", { actor: { kind: "user", userId: "usr_private_owner" }, reason: "stop_request", endedAt: 20 }),
    job("orchestrator-stop", { actor: { kind: "orchestrator", sessionId: "s_parent" }, reason: "stop_request", endedAt: 21 }),
    job("bound", { actor: { kind: "runner" }, reason: "handoff_wait_bound", endedAt: 22 }),
    job("restart", { actor: { kind: "runner" }, reason: "session_restart", endedAt: 23 }),
    job("on-its-own"),
  ];
  const endedBy = (version: number) => metaToSnapshot(meta({ backgroundJobs }), version).backgroundJobs
    ?.map((projected) => [projected.id, projected.endedBy]);
  assert.deepEqual(endedBy(192), [
    ["owner-stop", { actor: { kind: "user" }, reason: "stop_request", endedAt: 20 }],
    ["orchestrator-stop", { actor: { kind: "orchestrator", sessionId: "s_parent" }, reason: "stop_request", endedAt: 21 }],
    ["bound", { actor: { kind: "runner" }, reason: "handoff_wait_bound", endedAt: 22 }],
    ["restart", { actor: { kind: "runner" }, reason: "session_restart", endedAt: 23 }],
    ["on-its-own", undefined],
  ]);
  assert.equal(JSON.stringify(metaToSnapshot(meta({ backgroundJobs }), 192)).includes("usr_private_owner"), false);
  assert.ok(endedBy(191)?.every(([, end]) => end === undefined), "an older control plane receives no endedBy");
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

test("skill commands reach only control planes that dispatch through command authority", () => {
  const prompt = { name: "review", source: "user" as const };
  const skill = { name: "review", source: "skill" as const };
  assert.deepEqual(
    metaToSnapshot(meta({ sessionSlashCommands: [prompt, skill] }), 74).agentCapabilities,
    { slashCommands: [prompt] },
    "a pre-authority peer dispatches by bare name, which the same-named prompt would capture",
  );
  assert.deepEqual(
    metaToSnapshot(meta({ sessionSlashCommands: [prompt, skill] }), 75).agentCapabilities,
    { slashCommands: [prompt, skill] },
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

/* ---- the debounced metadata flush runs its I/O off the event loop (#2833) ---- */

type FlushInternals = {
  flushTimers: Map<string, ReturnType<typeof setTimeout>>;
  backgroundFlushes: Map<string, Promise<void>>;
  startBackgroundFlush(id: string): void;
} & Record<string, (...args: never[]) => unknown>;

/** Fire a session's debounced flush now, as its 250 ms timer would, and return its completion. */
function fireDebouncedFlush(store: SessionStore, id: string): Promise<void> {
  const internals = store as unknown as FlushInternals;
  const timer = internals.flushTimers.get(id);
  assert.ok(timer, "appends arm the debounced flush");
  clearTimeout(timer);
  internals.flushTimers.delete(id);
  internals.startBackgroundFlush(id);
  return internals.backgroundFlushes.get(id) ?? Promise.resolve();
}

/** Hold the first call of one of the store's async I/O steps until released. */
function holdFirstCall(store: SessionStore, method: string): { reached: Promise<void>; release: () => void } {
  const internals = store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = internals[method]!.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  let held = false;
  internals[method] = async (...args: unknown[]) => {
    if (!held) {
      held = true;
      entered();
      await gate;
    }
    return original(...args);
  };
  return { reached, release };
}

/** Count synchronous fsyncs from the store's own module, which imports them from node:fs. */
function countSyncFsyncs(t: { after(fn: () => void): void; mock: { method: Function; restoreAll(): void } }): { count: number } {
  const counter = { count: 0 };
  const original = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    counter.count++;
    original(fd);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return counter;
}

function diskMeta(root: string, id = "s_abc"): SessionMeta {
  return JSON.parse(readFileSync(join(root, id, "meta.json"), "utf8")) as SessionMeta;
}

test("the debounced metadata flush of several streaming sessions never fsyncs on the event loop", async (t) => {
  const { store, root } = tmpStore();
  try {
    const ids = ["s_a", "s_b", "s_c", "s_d"];
    for (const id of ids) store.create(meta({ sessionId: id }));
    const fsyncs = countSyncFsyncs(t);
    const internals = store as unknown as FlushInternals;
    const backgroundFsyncs: string[] = [];
    const fsyncFileInBackground = internals.fsyncFileInBackground!.bind(store) as (path: string) => Promise<void>;
    (internals as Record<string, unknown>).fsyncFileInBackground = (path: string) => {
      backgroundFsyncs.push(path);
      return fsyncFileInBackground(path);
    };
    for (let i = 0; i < 20; i++) {
      for (const id of ids) store.appendEvent(id, { kind: "agent_message", text: `chunk ${i}` });
    }
    // The real 250 ms timers fire; wait on the durable result rather than a count of turns.
    const deadline = Date.now() + 10_000;
    while (
      (internals.flushTimers.size > 0 || internals.backgroundFlushes.size > 0 ||
        ids.some((id) => diskMeta(root, id).seq !== 20)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const id of ids) assert.equal(diskMeta(root, id).seq, 20, `${id}'s seq reaches meta.json`);
    assert.equal(fsyncs.count, 0, "every fsync of the debounced flush runs on the libuv pool");
    assert.deepEqual(
      [...new Set(backgroundFsyncs)].sort(),
      ids.map((id) => join(root, id, "events.ndjson")),
      "each session's event log is made durable before its metadata",
    );
    assert.deepEqual(readdirSync(join(root, "s_a")).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the debounced flush publishes only seqs appended before its event-log fsync began", async () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    for (let i = 0; i < 3; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
    const fsync = holdFirstCall(store, "fsyncFileInBackground");
    const flushed = fireDebouncedFlush(store, "s_abc");
    await fsync.reached;
    // These lines may not be covered by the fsync already under way.
    store.appendEvent("s_abc", { kind: "agent_message", text: "late 1" });
    store.appendEvent("s_abc", { kind: "agent_message", text: "late 2" });
    fsync.release();
    await flushed;
    assert.equal(diskMeta(root).seq, 3, "meta never names a seq the event-log fsync may have missed");
    assert.equal(store.readMeta("s_abc")!.seq, 5, "the later deltas stay pending");
    await fireDebouncedFlush(store, "s_abc");
    assert.equal(diskMeta(root).seq, 5, "the next pass lands them");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit flush is a durability barrier while a debounced flush is in flight", async (t) => {
  for (const step of ["fsyncFileInBackground", "writeSyncedFileInBackground"] as const) {
    await t.test(step, async (t) => {
      const { store, root } = tmpStore();
      try {
        store.create(meta());
        for (let i = 0; i < 3; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
        const held = holdFirstCall(store, step);
        const flushed = fireDebouncedFlush(store, "s_abc");
        await held.reached;
        store.appendEvent("s_abc", { kind: "agent_message", text: "c3" });
        const fsyncs = countSyncFsyncs(t);
        store.flush("s_abc");
        // Event log, temp meta file and directory: all synchronous before flush() returns.
        assert.equal(fsyncs.count, 3);
        const published = statSync(join(root, "s_abc", "meta.json"), { bigint: true });
        assert.equal(diskMeta(root).seq, 4);
        held.release();
        await flushed;
        const after = statSync(join(root, "s_abc", "meta.json"), { bigint: true });
        assert.equal(after.ino, published.ino, "the superseded debounced flush does not publish");
        assert.equal(diskMeta(root).seq, 4);
        assert.deepEqual(readdirSync(join(root, "s_abc")).filter((name) => name.endsWith(".tmp")), []);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("an explicit flush fsyncs the directory of a debounced flush that renamed but has not synced it", async () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
    const dirSync = holdFirstCall(store, "fsyncDirectoryAsync");
    const flushed = fireDebouncedFlush(store, "s_abc");
    await dirSync.reached;
    assert.equal(diskMeta(root).seq, 1, "renamed into place");
    const synced: string[] = [];
    const internals = store as unknown as Record<string, (path: string) => void>;
    const fsyncDirectory = internals.fsyncDirectory!.bind(store);
    internals.fsyncDirectory = (path: string) => { synced.push(path); fsyncDirectory(path); };
    store.flush("s_abc");
    assert.deepEqual(synced, [join(root, "s_abc")], "flush() makes the pending rename durable itself");
    synced.length = 0;
    store.flushAll();
    assert.deepEqual(synced, [join(root, "s_abc")], "so does the shutdown flush");
    dirSync.release();
    await flushed;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a debounced flush re-merges when another process replaces meta.json during its write", async () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    for (let i = 0; i < 4; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
    const write = holdFirstCall(store, "writeSyncedFileInBackground");
    const flushed = fireDebouncedFlush(store, "s_abc");
    await write.reached;
    const peer = new SessionStore(root);
    peer.patchMeta("s_abc", { status: "failed", agentSessionId: "peer-owns-this" });
    write.release();
    await flushed;
    const final = diskMeta(root);
    assert.equal(final.status, "failed", "the peer's critical write survives");
    assert.equal(final.agentSessionId, "peer-owns-this");
    assert.equal(final.seq, 4, "and the debounced seq still lands");
    assert.equal(store.readMeta("s_abc")!.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a debounced flush in flight never rolls back a newer seq or resurrects a reset epoch", async (t) => {
  await t.test("newer seq from another process", async () => {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      for (let i = 0; i < 2; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
      const write = holdFirstCall(store, "writeSyncedFileInBackground");
      const flushed = fireDebouncedFlush(store, "s_abc");
      await write.reached;
      writeFileSync(join(root, "s_abc", "meta.json"), JSON.stringify({ ...diskMeta(root), seq: 9 }));
      write.release();
      await flushed;
      assert.equal(diskMeta(root).seq, 9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test("reset by another process", async () => {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      for (let i = 0; i < 5; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
      const fsync = holdFirstCall(store, "fsyncFileInBackground");
      const flushed = fireDebouncedFlush(store, "s_abc");
      await fsync.reached;
      const peer = new SessionStore(root);
      peer.resetEvents("s_abc");
      peer.appendEvent("s_abc", { kind: "agent_message", text: "new generation" });
      peer.flushAll();
      fsync.release();
      await flushed;
      assert.equal(diskMeta(root).seq, 1, "the stale epoch's deltas are dropped");
      assert.equal(diskMeta(root).logEpoch, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test("reset in this process", async () => {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      for (let i = 0; i < 5; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `c${i}` });
      const write = holdFirstCall(store, "writeSyncedFileInBackground");
      const flushed = fireDebouncedFlush(store, "s_abc");
      await write.reached;
      store.resetEvents("s_abc");
      write.release();
      await flushed;
      assert.equal(diskMeta(root).seq, 0);
      assert.equal(diskMeta(root).logEpoch, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("a debounced flush never republishes a snapshot whose deltas another write already consumed", async (t) => {
  const consumers = {
    "explicit flush": (store: SessionStore) => store.flush("s_abc"),
    "critical patch": (store: SessionStore) => store.patchMeta("s_abc", { status: "running" }),
  };
  for (const step of ["fsyncFileInBackground", "writeSyncedFileInBackground"] as const) {
    for (const [name, consume] of Object.entries(consumers)) {
      await t.test(`${name} while held in ${step}`, async () => {
        const { store, root } = tmpStore();
        try {
          store.create(meta());
          store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
          store.patchMeta("s_abc", { tokensOut: 10, costUsd: 1 });
          const held = holdFirstCall(store, step);
          const flushed = fireDebouncedFlush(store, "s_abc");
          await held.reached;
          store.patchMeta("s_abc", { tokensOut: 20, costUsd: 2 });
          consume(store);
          assert.equal(diskMeta(root).tokensOut, 20);
          const internals = store as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
          const write = internals.writeSyncedFileInBackground!.bind(store);
          let writes = 0;
          internals.writeSyncedFileInBackground = (...args: unknown[]) => { writes++; return write(...args); };
          // A new batch of deltas in the same epoch that carries no usage of its own.
          store.appendEvent("s_abc", { kind: "agent_message", text: "c1" });
          held.release();
          await flushed;
          store.flushAll();
          const final = diskMeta(root);
          assert.equal(final.tokensOut, 20, "the older snapshot's usage never overwrites newer totals");
          assert.equal(final.costUsd, 2);
          assert.equal(final.seq, 2);
          if (step === "fsyncFileInBackground") assert.equal(writes, 0, "a consumed snapshot is not even written");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("a debounced flush whose deltas were dropped meanwhile does not publish them", async () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
    const write = holdFirstCall(store, "writeSyncedFileInBackground");
    const flushed = fireDebouncedFlush(store, "s_abc");
    await write.reached;
    // As reset recovery does when meta.json already names the new epoch: deltas go, the file stays.
    (store as unknown as { pending: Map<string, unknown> }).pending.delete("s_abc");
    store.appendEvent("s_abc", { kind: "agent_message", text: "c1" }); // a new batch, same epoch
    write.release();
    await flushed;
    assert.equal(diskMeta(root).seq, 0, "the dropped snapshot is not published");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a debounced flush that keeps losing the race to other writers leaves its deltas pending and re-arms", async () => {
  const { store, root } = tmpStore();
  try {
    store.create(meta());
    store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
    const internals = store as unknown as Record<string, (path: string, contents: string) => Promise<void>>;
    const write = internals.writeSyncedFileInBackground!.bind(store);
    const peer = new SessionStore(root);
    let writes = 0;
    internals.writeSyncedFileInBackground = async (path: string, contents: string) => {
      writes++;
      await write(path, contents);
      peer.patchMeta("s_abc", { title: `peer write ${writes}` });
    };
    await fireDebouncedFlush(store, "s_abc");
    assert.equal(writes, 3, "bounded retries");
    assert.equal(diskMeta(root).seq, 0);
    assert.equal(diskMeta(root).title, "peer write 3");
    assert.ok((store as unknown as FlushInternals).flushTimers.has("s_abc"), "the next pass is scheduled");
    store.flush("s_abc");
    assert.equal(diskMeta(root).seq, 1);
    assert.equal(diskMeta(root).title, "peer write 3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed debounced flush retries synchronously, and a removed session is left alone", async (t) => {
  await t.test("failed background write", async () => {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
      const internals = store as unknown as Record<string, () => Promise<void>>;
      internals.writeSyncedFileInBackground = async () => { throw new Error("EIO"); };
      await fireDebouncedFlush(store, "s_abc");
      assert.equal(diskMeta(root).seq, 1, "the synchronous fallback made the delta durable");
      assert.equal((store as unknown as FlushInternals).backgroundFlushes.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  await t.test("session removed mid-flush", async () => {
    const { store, root } = tmpStore();
    try {
      store.create(meta());
      store.appendEvent("s_abc", { kind: "agent_message", text: "c0" });
      const write = holdFirstCall(store, "writeSyncedFileInBackground");
      const flushed = fireDebouncedFlush(store, "s_abc");
      await write.reached;
      store.remove("s_abc");
      write.release();
      await flushed;
      assert.equal(existsSync(join(root, "s_abc")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
    assert.equal(snapshot.historyEpoch, wireEpoch(1, CURRENT_PEER),
      "a local epoch is fenced into its peer-specific wire epoch");
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

test("lossless compaction preserves bytes, sparse-index offsets, frozen cursors, and append sequence", async () => {
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
    const compacted = await store.compactHistory("s_abc", "maintenance", true);
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

test("immutable segment tampering fails paged history closed", async () => {
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
    assert.equal((await store.compactHistory("s_abc", "maintenance", true)).compacted, true);
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

test("repeated compaction, orphan collection, and reset retain no destructive archive residue", async () => {
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
    assert.equal((await store.compactHistory("s_abc", "maintenance", true)).compacted, true);
    store.releaseLock("s_abc", "maintenance");
    for (let i = 0; i < 30; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `second-${i}` });
    store.flushAll();
    assert.equal(store.acquireLock("s_abc", "maintenance"), true);
    assert.equal((await store.compactHistory("s_abc", "maintenance", true)).compacted, true);
    store.releaseLock("s_abc", "maintenance");

    const sessionDir = join(root, "s_abc");
    const beforeMaintenance = readdirSync(sessionDir);
    assert.ok(beforeMaintenance.some((file) => file === "events.ndjson"), "superseded readers get a grace generation");
    const maintenance = await store.maintainHistories("idle-maintenance", 1);
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

test("idle maintenance never compacts a session whose writer lock is live", async () => {
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
    const maintenance = await new SessionStore(root, undefined, policy).maintainHistories("maintenance", 1);
    assert.deepEqual(maintenance, { inspected: 0, compacted: 0, bytesArchived: 0, orphansRemoved: 0, errors: 0 });
    assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false);
    writer.releaseLock("s_abc", "live-turn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle maintenance rotates fairly and rebuilds missing indexes off the prompt path", async () => {
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
      const result = await store.maintainHistories("maintenance", 2);
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

const COMPACT_EVERY_PASS = {
  triggerActiveBytes: 1,
  retainActiveBytes: 64,
  retainActiveEvents: 2,
  maxSegmentBytes: 64 * 1024,
  orphanGraceMs: 60 * 60 * 1_000,
};

function appendMany(store: SessionStore, count: number, label: string): void {
  for (let i = 0; i < count; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `${label}-${i}` });
}

async function compactOnce(store: SessionStore, owner = "maintenance"): Promise<void> {
  assert.equal(store.acquireLock("s_abc", owner), true);
  try {
    assert.equal((await store.compactHistory("s_abc", owner, true)).compacted, true);
  } finally {
    store.releaseLock("s_abc", owner);
  }
}

function historyManifest(root: string): { activeFile: string; segments: Array<{ file: string }> } {
  return JSON.parse(readFileSync(join(root, "s_abc", "events.manifest.json"), "utf8")) as {
    activeFile: string;
    segments: Array<{ file: string }>;
  };
}

/** Every event as a process that starts now would see it: a cold store reading from disk. */
function coldSeqs(root: string): number[] {
  return new SessionStore(root, undefined, COMPACT_EVERY_PASS).readEvents("s_abc").map((event) => event.seq);
}

const seqRange = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

test("the append layout follows each compaction this store publishes under the writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-own-"));
  try {
    const store = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    store.create(meta());
    assert.equal(store.acquireLock("s_abc", "turn"), true);
    for (let round = 0; round < 9; round++) {
      appendMany(store, 10, `round-${round}`);
      assert.equal((await store.compactHistory("s_abc", "turn", true)).compacted, true);
      const appended = store.appendEvent("s_abc", { kind: "agent_message", text: `after-${round}` });
      const manifest = historyManifest(root);
      assert.equal(manifest.segments.length, round + 1);
      assert.match(
        readFileSync(join(root, "s_abc", manifest.activeFile), "utf8"),
        new RegExp(`"seq":${appended!.seq},.*"after-${round}"`),
        "the append after a compaction lands in the newly published active generation",
      );
    }
    store.releaseLock("s_abc", "turn");
    assert.deepEqual(coldSeqs(root), seqRange(99));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm append layout refetches when another process publishes a compaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-peer-"));
  try {
    const writer = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    writer.create(meta());
    appendMany(writer, 20, "before");
    let expected = 20;
    // The first switch retires the legacy file; later ones leave the superseded active generation
    // in place for grace-period readers, so a stale append target would still accept writes.
    for (let round = 0; round < 3; round++) {
      const superseded = existsSync(join(root, "s_abc", "events.manifest.json"))
        ? historyManifest(root).activeFile
        : "events.ndjson";
      const supersededBytes = readFileSync(join(root, "s_abc", superseded));
      await compactOnce(new SessionStore(root, undefined, COMPACT_EVERY_PASS));
      const appended = writer.appendEvent("s_abc", { kind: "agent_message", text: `after-peer-${round}` });
      expected += 1;
      assert.equal(appended?.seq, expected);
      const { activeFile } = historyManifest(root);
      assert.notEqual(activeFile, superseded);
      assert.match(readFileSync(join(root, "s_abc", activeFile), "utf8"), new RegExp(`"after-peer-${round}"`));
      if (round > 0) {
        assert.deepEqual(readFileSync(join(root, "s_abc", superseded)), supersededBytes, "superseded generation unchanged");
      }
      appendMany(writer, 10, `between-${round}`);
      expected += 10;
    }
    writer.flushAll();
    assert.deepEqual(coldSeqs(root), seqRange(expected));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm append layout follows an epoch replacement and a crashed reset from another process", async () => {
  for (const shape of ["reset", "crashed_reset_intent"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-epoch-"));
    try {
      const writer = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
      writer.create(meta());
      for (let round = 0; round < 3; round++) {
        appendMany(writer, 10, `old-${round}`);
        await compactOnce(writer);
      }
      appendMany(writer, 3, "old-tail");
      writer.flushAll();
      const oldEpoch = writer.readMeta("s_abc")?.logEpoch ?? 0;
      if (shape === "reset") {
        new SessionStore(root, undefined, COMPACT_EVERY_PASS).resetEvents("s_abc");
      } else {
        writeFileSync(
          join(root, "s_abc", "events.reset.json"),
          JSON.stringify({ version: 1, nextEpoch: oldEpoch + 1 }),
        );
      }
      const appended = writer.appendEvent("s_abc", { kind: "agent_message", text: "new-epoch" });
      assert.equal(appended?.seq, 1, shape);
      assert.equal(writer.readMeta("s_abc")?.logEpoch, oldEpoch + 1, shape);
      assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false, shape);
      assert.match(readFileSync(join(root, "s_abc", "events.ndjson"), "utf8"), /"new-epoch"/, shape);
      writer.flushAll();
      assert.deepEqual(coldSeqs(root), [1], shape);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a restart after compactions and a torn tail recovers from disk with a cold cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-restart-"));
  try {
    const crashed = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    crashed.create(meta());
    assert.equal(crashed.acquireLock("s_abc", "turn"), true);
    for (let round = 0; round < 8; round++) {
      appendMany(crashed, 10, `round-${round}`);
      assert.equal((await crashed.compactHistory("s_abc", "turn", true)).compacted, true);
    }
    appendMany(crashed, 5, "unflushed");
    // Crash mid-append: a partial record on the active generation and a metadata flush that never ran.
    const { activeFile, segments } = historyManifest(root);
    assert.equal(segments.length, 8);
    appendFileSync(join(root, "s_abc", activeFile), '{"seq":86,"ts":1,"payl');

    const restarted = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    assert.ok((restarted.readMeta("s_abc")?.seq ?? 0) < 85, "disk metadata lags the durable log");
    assert.equal(restarted.acquireLock("s_abc", "turn"), true, "the restarted owner reclaims its own lock");
    assert.equal(restarted.appendEvent("s_abc", { kind: "agent_message", text: "after-restart" })?.seq, 86);
    restarted.flushAll();
    assert.doesNotMatch(readFileSync(join(root, "s_abc", activeFile), "utf8"), /"payl"|"payl$/, "torn bytes removed");
    assert.deepEqual(coldSeqs(root), seqRange(86));
    const page = new SessionStore(root, undefined, COMPACT_EVERY_PASS).readEventPage("s_abc", { afterSeq: 80, limit: 10 });
    assert.equal(page.ok, true);
    if (page.ok) assert.deepEqual(page.events.map((event) => event.seq), [81, 82, 83, 84, 85, 86]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed append drops the warm layout and repairs a torn suffix before the next sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-failed-"));
  try {
    const store = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    store.create(meta());
    assert.equal(store.acquireLock("s_abc", "turn"), true);
    for (let round = 0; round < 2; round++) {
      appendMany(store, 10, `round-${round}`);
      assert.equal((await store.compactHistory("s_abc", "turn", true)).compacted, true);
    }
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "warm" })?.seq, 21);
    assert.throws(() => store.appendEvent("s_abc", { kind: "agent_message", text: 1n } as never));
    // Stand-in for the partial write a failed append can leave behind.
    appendFileSync(join(root, "s_abc", historyManifest(root).activeFile), '{"seq":22,"ts":');
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "after-failure" })?.seq, 22);
    store.releaseLock("s_abc", "turn");
    store.flushAll();
    assert.deepEqual(coldSeqs(root), seqRange(22));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm append layout never hides a missing active file or outlives session removal", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-removed-"));
  try {
    const store = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    store.create(meta());
    appendMany(store, 10, "first");
    await compactOnce(store);
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "warm" })?.seq, 11);
    const activePath = join(root, "s_abc", historyManifest(root).activeFile);
    const activeBytes = readFileSync(activePath);
    rmSync(activePath);
    assert.throws(
      () => store.appendEvent("s_abc", { kind: "agent_message", text: "lost" }),
      /active file is missing/,
    );
    writeFileSync(activePath, activeBytes);

    store.remove("s_abc");
    store.create(meta());
    assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "recreated" })?.seq, 1);
    assert.equal(statSync(join(root, "s_abc", "events.ndjson")).isFile(), true);
    store.flushAll();
    assert.deepEqual(coldSeqs(root), [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncommitted legacy fence keeps appends on the uncached path until the fence lands", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-fence-"));
  try {
    const writer = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    writer.create(meta());
    appendMany(writer, 20, "legacy");
    await compactOnce(new SessionStore(root, undefined, COMPACT_EVERY_PASS));
    // Reproduce a fence whose retirement rename was refused (an open Windows reader).
    const sessionDir = join(root, "s_abc");
    const retiredFile = readdirSync(sessionDir).find((file) => file.startsWith("events.retired."))!;
    rmSync(join(sessionDir, "events.ndjson"), { recursive: true, force: true });
    renameSync(join(sessionDir, retiredFile), join(sessionDir, "events.ndjson"));
    writeFileSync(join(sessionDir, "events.legacy-fence.json"), JSON.stringify({
      version: 1,
      activeFile: historyManifest(root).activeFile,
      retiredFile,
    }));
    assert.equal(writer.appendEvent("s_abc", { kind: "agent_message", text: "fenced" })?.seq, 21);
    assert.equal(statSync(join(sessionDir, "events.ndjson")).isDirectory(), true, "the append retried the fence");
    assert.equal(existsSync(join(sessionDir, "events.legacy-fence.json")), false);
    writer.flushAll();
    assert.deepEqual(coldSeqs(root), seqRange(21));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a warm append layout still fails closed on a damaged cold segment within one flush interval", async () => {
  for (const damage of ["deleted", "truncated"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-damage-"));
    try {
      const store = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
      store.create(meta());
      appendMany(store, 10, "first");
      await compactOnce(store);
      assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "warm" })?.seq, 11);
      const { activeFile, segments } = historyManifest(root);
      const segmentPath = join(root, "s_abc", segments[0]!.file);
      if (damage === "deleted") rmSync(segmentPath);
      else writeFileSync(segmentPath, readFileSync(segmentPath).subarray(0, 10));
      const activeBefore = readFileSync(join(root, "s_abc", activeFile));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(
        () => store.appendEvent("s_abc", { kind: "agent_message", text: "after-damage" }),
        /missing or truncated/,
        damage,
      );
      assert.deepEqual(readFileSync(join(root, "s_abc", activeFile)), activeBefore, `${damage}: nothing appended`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the post-compaction layout is keyed by the manifest it published, not a later replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-republish-"));
  try {
    const writer = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
    writer.create(meta());
    assert.equal(writer.acquireLock("s_abc", "turn"), true);
    appendMany(writer, 20, "before");
    const sessionDir = join(root, "s_abc");
    const manifestPath = join(sessionDir, "events.manifest.json");
    // A peer that took over a stale lock publishes an identical history on a new active generation
    // in the gap between this store's manifest rename and its cache update.
    const internals = writer as unknown as { publishHistoryFile(id: string, staged: { path: string }): string };
    const publish = internals.publishHistoryFile.bind(writer);
    internals.publishHistoryFile = (id, staged) => {
      const published = publish(id, staged);
      if (staged.path !== manifestPath) return published;
      const current = JSON.parse(readFileSync(manifestPath, "utf8")) as { activeFile: string };
      writeFileSync(join(sessionDir, "events.active.peer.ndjson"), readFileSync(join(sessionDir, current.activeFile)));
      writeFileSync(`${manifestPath}.peer.tmp`, JSON.stringify({ ...current, activeFile: "events.active.peer.ndjson" }));
      renameSync(`${manifestPath}.peer.tmp`, manifestPath);
      return published;
    };
    assert.equal((await writer.compactHistory("s_abc", "turn", true)).compacted, true);
    const superseded = readdirSync(sessionDir).find((file) => file.startsWith("events.active.") && !file.includes(".peer."))!;
    const supersededBytes = readFileSync(join(sessionDir, superseded));
    assert.equal(writer.appendEvent("s_abc", { kind: "agent_message", text: "after-peer" })?.seq, 21);
    assert.match(readFileSync(join(sessionDir, "events.active.peer.ndjson"), "utf8"), /"after-peer"/);
    assert.deepEqual(readFileSync(join(sessionDir, superseded)), supersededBytes);
    writer.releaseLock("s_abc", "turn");
    writer.flushAll();
    assert.deepEqual(coldSeqs(root), seqRange(21));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked or unreachable manifest fails appends closed instead of reading as missing", async () => {
  if (process.platform === "win32") return; // creating symlinks needs elevated rights there
  for (const shape of ["symlink_to_manifest", "symlink_through_file"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-layout-symlink-"));
    try {
      const store = new SessionStore(root, undefined, COMPACT_EVERY_PASS);
      store.create(meta());
      appendMany(store, 10, "first");
      await compactOnce(store);
      assert.equal(store.appendEvent("s_abc", { kind: "agent_message", text: "warm" })?.seq, 11, shape);
      const sessionDir = join(root, "s_abc");
      const activePath = join(sessionDir, historyManifest(root).activeFile);
      const manifestPath = join(sessionDir, "events.manifest.json");
      const relocated = join(sessionDir, "relocated-manifest.json");
      renameSync(manifestPath, relocated);
      // The second shape cannot be resolved at all (ENOTDIR), which a plain stat would report as missing.
      symlinkSync(shape === "symlink_to_manifest" ? relocated : join(relocated, "nested"), manifestPath);
      const activeBefore = readFileSync(activePath);
      assert.throws(
        () => store.appendEvent("s_abc", { kind: "agent_message", text: "through-symlink" }),
        /manifest is not a regular file/,
        shape,
      );
      assert.deepEqual(readFileSync(activePath), activeBefore, `${shape}: nothing appended`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const COMPACT_MEGABYTES = {
  triggerActiveBytes: 1,
  retainActiveBytes: 64 * 1024,
  retainActiveEvents: 10,
  maxSegmentBytes: 16 * 1024 * 1024,
  orphanGraceMs: 60 * 60 * 1_000,
};

/** About 4.4 MB of history: enough for several scan slices and copy chunks. */
function megabyteSession(root: string): SessionStore {
  const store = new SessionStore(root, undefined, COMPACT_MEGABYTES);
  store.create(meta());
  for (let i = 0; i < 4_000; i++) {
    store.appendEvent("s_abc", { kind: "agent_message", text: `bulk-${i}-${"x".repeat(1_000)}` });
  }
  store.flushAll();
  return store;
}

/** Run `onTick` on every event-loop turn until `work` settles; a synchronous compaction gets none. */
async function duringEachTurn<T>(work: Promise<T>, onTick: (tick: number) => void): Promise<{ result: T; ticks: number }> {
  let settled = false;
  const tracked = work.finally(() => { settled = true; });
  let ticks = 0;
  while (!settled) {
    await nextTurn();
    if (!settled) onTick(++ticks);
  }
  return { result: await tracked, ticks };
}

function compactionDebris(root: string): string[] {
  return readdirSync(join(root, "s_abc")).filter((file) =>
    file.startsWith("events.segment.") || file.startsWith("events.active.") || file.endsWith(".tmp"));
}

test("compaction yields the event loop and keeps appends made during the copy in order", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-interleave-"));
  try {
    const store = megabyteSession(root);
    assert.equal(store.acquireLock("s_abc", "turn"), true);
    let during = 0;
    const { result, ticks } = await duringEachTurn(store.compactHistory("s_abc", "turn", true), () => {
      store.appendEvent("s_abc", { kind: "agent_message", text: `during-${during++}` });
    });
    assert.equal(result.compacted, true);
    assert.ok(ticks >= 8, `compaction yielded on ${ticks} turns`);
    assert.ok(during >= 8);
    for (let i = 0; i < 5; i++) store.appendEvent("s_abc", { kind: "agent_message", text: `after-${i}` });
    store.releaseLock("s_abc", "turn");
    store.flushAll();

    const { activeFile, segments } = historyManifest(root);
    assert.equal(segments.length, 1);
    assert.match(readFileSync(join(root, "s_abc", activeFile), "utf8"), new RegExp(`"during-${during - 1}"[^\\n]*\\n.*"after-0"`));
    const events = new SessionStore(root, undefined, COMPACT_MEGABYTES).readEvents("s_abc");
    assert.deepEqual(events.map((event) => event.seq), seqRange(4_000 + during + 5));
    const texts = events.map((event) => (event.payload as { text: string }).text);
    assert.deepEqual(texts.slice(4_000), [
      ...Array.from({ length: during }, (_, i) => `during-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `after-${i}`),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle maintenance frees the writer lock while copying and yields to a turn that keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-yield-"));
  try {
    const store = megabyteSession(root);
    const turn = new SessionStore(root, undefined, COMPACT_MEGABYTES);
    let turnStarted = false;
    const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
      if (tick !== 3) return;
      turnStarted = turn.acquireLock("s_abc", "turn");
      turn.appendEvent("s_abc", { kind: "agent_message", text: "turn-event" });
    });
    assert.equal(turnStarted, true, "a turn must not be refused while maintenance copies");
    assert.deepEqual(result, { inspected: 1, compacted: 0, bytesArchived: 0, orphansRemoved: 0, errors: 0 });
    assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false);
    assert.deepEqual(compactionDebris(root), [], "a discarded copy leaves no files behind");
    assert.equal(turn.appendEvent("s_abc", { kind: "agent_message", text: "turn-event-2" })?.seq, 4_002);
    turn.releaseLock("s_abc", "turn");
    turn.flushAll();
    assert.deepEqual(coldSeqs(root), seqRange(4_002));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn that appends and finishes during the copy is carried into the published generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-carry-"));
  try {
    const store = megabyteSession(root);
    const turn = new SessionStore(root, undefined, COMPACT_MEGABYTES);
    const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
      if (tick !== 3) return;
      assert.equal(turn.acquireLock("s_abc", "turn"), true);
      for (let i = 0; i < 300; i++) turn.appendEvent("s_abc", { kind: "agent_message", text: `turn-${i}-${"y".repeat(1_000)}` });
      turn.flushAll();
      turn.releaseLock("s_abc", "turn");
    });
    assert.equal(result.compacted, 1);
    const { activeFile } = historyManifest(root);
    assert.match(readFileSync(join(root, "s_abc", activeFile), "utf8"), /"turn-299-/);
    assert.equal(turn.acquireLock("s_abc", "turn"), true);
    assert.equal(turn.appendEvent("s_abc", { kind: "agent_message", text: "next-turn" })?.seq, 4_301);
    turn.releaseLock("s_abc", "turn");
    turn.flushAll();
    const events = new SessionStore(root, undefined, COMPACT_MEGABYTES).readEvents("s_abc");
    assert.deepEqual(events.map((event) => event.seq), seqRange(4_301));
    assert.equal((events[4_000]!.payload as { text: string }).text.startsWith("turn-0-"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a torn suffix written during the copy postpones publication until the writer repairs it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-torn-"));
  try {
    const store = megabyteSession(root);
    const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
      if (tick === 3) appendFileSync(join(root, "s_abc", "events.ndjson"), '{"seq":4001,"ts":');
    });
    assert.equal(result.compacted, 0);
    assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false);
    assert.deepEqual(compactionDebris(root), []);
    const writer = new SessionStore(root, undefined, COMPACT_MEGABYTES);
    assert.equal(writer.acquireLock("s_abc", "turn"), true);
    assert.equal(writer.appendEvent("s_abc", { kind: "agent_message", text: "repaired" })?.seq, 4_001);
    writer.releaseLock("s_abc", "turn");
    writer.flushAll();
    assert.equal((await store.maintainHistories("maintenance", 1)).compacted, 1);
    assert.deepEqual(coldSeqs(root), seqRange(4_001));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reset or competing compaction during the copy aborts publication without losing history", async () => {
  for (const shape of ["reset", "competing_compaction", "manifest_switch"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-race-"));
    try {
      const store = megabyteSession(root);
      const peer = new SessionStore(root, undefined, COMPACT_MEGABYTES);
      let competing: Promise<unknown> | null = null;
      const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
        if (tick !== 3) return;
        if (shape === "reset") {
          peer.resetEvents("s_abc");
          peer.appendEvent("s_abc", { kind: "agent_message", text: "new-epoch" });
          peer.flushAll();
        } else if (shape === "competing_compaction") {
          assert.equal(peer.acquireLock("s_abc", "peer"), true);
          competing = peer.compactHistory("s_abc", "peer", true).finally(() => peer.releaseLock("s_abc", "peer"));
        } else {
          // A peer publication that completes before this copy publishes: same bytes, new generation.
          const sessionDir = join(root, "s_abc");
          writeFileSync(join(sessionDir, "events.active.peer.ndjson"), readFileSync(join(sessionDir, "events.ndjson")));
          writeFileSync(join(sessionDir, "events.manifest.json"), JSON.stringify({
            version: 1,
            logEpoch: 0,
            activeFile: "events.active.peer.ndjson",
            segments: [],
          }));
        }
      });
      if (competing) assert.equal(((await competing) as { compacted: boolean }).compacted, true, shape);
      assert.equal(result.compacted, 0, shape);
      // A peer still holding its lock makes publication yield quietly; a finished one is a changed manifest.
      if (shape !== "competing_compaction") assert.equal(result.errors, 1, shape);
      const seqs = coldSeqs(root);
      assert.deepEqual(seqs, shape === "reset" ? [1] : seqRange(4_000), shape);
      if (shape !== "reset") {
        const { activeFile, segments } = historyManifest(root);
        const referenced = new Set([activeFile, ...segments.map((segment) => segment.file)]);
        assert.deepEqual(compactionDebris(root).filter((file) => !referenced.has(file)), [], shape);
      } else {
        assert.deepEqual(compactionDebris(root), [], shape);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("publication never steals or keeps a writer lock another owner took during the copy", async () => {
  for (const shape of ["stale_lock_appeared", "lock_overwritten_after_acquire"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-lockrace-"));
    try {
      const store = megabyteSession(root);
      const lockPath = join(root, "s_abc", "lock");
      if (shape === "lock_overwritten_after_acquire") {
        // A non-atomic acquirer elsewhere writes its owner over the lock maintenance just created.
        const internals = store as unknown as { acquireFreeLock(id: string, owner: string): boolean };
        const acquire = internals.acquireFreeLock.bind(store);
        internals.acquireFreeLock = (id, owner) => {
          const acquired = acquire(id, owner);
          writeFileSync(lockPath, "racing-turn");
          return acquired;
        };
      }
      const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
        if (tick !== 3 || shape !== "stale_lock_appeared") return;
        writeFileSync(lockPath, "crashed-turn");
        const old = new Date(Date.now() - 5 * 60 * 1_000);
        utimesSync(lockPath, old, old);
      });
      assert.equal(result.compacted, 0, shape);
      assert.equal(existsSync(join(root, "s_abc", "events.manifest.json")), false, shape);
      assert.deepEqual(compactionDebris(root), [], shape);
      assert.equal(readFileSync(lockPath, "utf8"), shape === "stale_lock_appeared" ? "crashed-turn" : "racing-turn", shape);
      assert.deepEqual(coldSeqs(root), seqRange(4_000), shape);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a burst that lands just before publication is caught up off the lock, never copied under it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-burst-"));
  try {
    const store = megabyteSession(root);
    const turn = new SessionStore(root, undefined, COMPACT_MEGABYTES);
    const internals = store as unknown as {
      fsyncDirectoryAsync(path: string): Promise<void>;
      writeAll(fd: number, contents: Buffer): void;
    };
    const fsyncDirectory = internals.fsyncDirectoryAsync.bind(store);
    let burst = false;
    internals.fsyncDirectoryAsync = async (path) => {
      await fsyncDirectory(path);
      if (burst) return;
      burst = true;
      assert.equal(turn.acquireLock("s_abc", "turn"), true);
      for (let i = 0; i < 1_200; i++) turn.appendEvent("s_abc", { kind: "agent_message", text: `burst-${i}-${"z".repeat(1_000)}` });
      turn.flushAll();
      turn.releaseLock("s_abc", "turn");
    };
    let largestLockedWrite = 0;
    const writeAll = internals.writeAll.bind(store);
    internals.writeAll = (fd, contents) => {
      largestLockedWrite = Math.max(largestLockedWrite, contents.length);
      writeAll(fd, contents);
    };
    const result = await store.maintainHistories("maintenance", 1);
    assert.equal(burst, true);
    assert.equal(result.compacted, 1);
    assert.ok(largestLockedWrite <= 256 * 1024, `copied ${largestLockedWrite} bytes under the lock`);
    assert.match(readFileSync(join(root, "s_abc", historyManifest(root).activeFile), "utf8"), /"burst-1199-/);
    const events = new SessionStore(root, undefined, COMPACT_MEGABYTES).readEvents("s_abc");
    assert.deepEqual(events.map((event) => event.seq), seqRange(5_200));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed control-file staging leaves no temp file, and orphaned staged files are collected", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-stage-"));
  try {
    const store = megabyteSession(root);
    const internals = store as unknown as { manifestKeyOf(path: string): string };
    const manifestKeyOf = internals.manifestKeyOf.bind(store);
    let failed = false;
    internals.manifestKeyOf = (path) => {
      if (!failed && path.endsWith(".tmp")) {
        failed = true;
        throw new Error("injected stat failure");
      }
      return manifestKeyOf(path);
    };
    const result = await store.maintainHistories("maintenance", 1);
    assert.equal(failed, true);
    assert.equal(result.errors, 1);
    assert.deepEqual(readdirSync(join(root, "s_abc")).filter((file) => file.endsWith(".tmp")), []);
    assert.deepEqual(compactionDebris(root), []);

    // A crash between staging and publication leaves temp files that only orphan collection can see.
    const sessionDir = join(root, "s_abc");
    for (const file of ["events.manifest.json.123.dead.tmp", "events.legacy-fence.json.123.dead.tmp"]) {
      writeFileSync(join(sessionDir, file), "{}");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
      utimesSync(join(sessionDir, file), old, old);
    }
    const collected = await new SessionStore(root, undefined, COMPACT_MEGABYTES).maintainHistories("maintenance", 1);
    assert.equal(collected.compacted, 1);
    assert.ok(collected.orphansRemoved >= 2);
    assert.deepEqual(readdirSync(sessionDir).filter((file) => file.endsWith(".tmp")), []);
    assert.deepEqual(coldSeqs(root), seqRange(4_000));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a peer publication between cut-scan slices abandons the plan without hashing the peer's segment", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-scanrace-"));
  try {
    const store = megabyteSession(root);
    const sessionDir = join(root, "s_abc");
    const internals = store as unknown as { hashFile(path: string): string };
    const hashFile = internals.hashFile.bind(store);
    let hashed = 0;
    internals.hashFile = (path) => {
      hashed++;
      return hashFile(path);
    };
    const { result } = await duringEachTurn(store.maintainHistories("maintenance", 1), (tick) => {
      if (tick !== 1) return;
      // A peer process publishes its own compaction of the same prefix between two scan slices.
      const bytes = readFileSync(join(sessionDir, "events.ndjson"));
      const cut = bytes.indexOf(0x0a, 1024 * 1024) + 1;
      const segment = bytes.subarray(0, cut);
      const lastLine = segment.subarray(segment.lastIndexOf(0x0a, segment.length - 2) + 1, segment.length - 1);
      writeFileSync(join(sessionDir, "events.segment.peer.ndjson"), segment);
      writeFileSync(join(sessionDir, "events.active.peer.ndjson"), bytes.subarray(cut));
      writeFileSync(join(sessionDir, "events.manifest.json"), JSON.stringify({
        version: 1,
        logEpoch: 0,
        activeFile: "events.active.peer.ndjson",
        segments: [{
          file: "events.segment.peer.ndjson",
          firstSeq: 1,
          lastSeq: (JSON.parse(lastLine.toString("utf8")) as { seq: number }).seq,
          bytes: cut,
          sha256: createHash("sha256").update(segment).digest("hex"),
        }],
      }));
    });
    assert.equal(result.compacted, 0);
    assert.equal(result.errors, 1);
    assert.equal(hashed, 0, "the compacting store never hashed the peer's segment on the event loop");
    assert.deepEqual(coldSeqs(root), seqRange(4_000));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan collection during the copy never leaves a manifest naming removed files", async () => {
  for (const collector of ["peer_store", "same_store"] as const) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-store-compact-collect-"));
    try {
      megabyteSession(root);
      const zeroGrace = { ...COMPACT_MEGABYTES, orphanGraceMs: 0 };
      const compactor = new SessionStore(root, undefined, zeroGrace);
      const peer = new SessionStore(root, undefined, zeroGrace);
      const sessionDir = join(root, "s_abc");
      let collected = -1;
      const { result } = await duringEachTurn(compactor.maintainHistories("maintenance", 1), () => {
        if (collected >= 0 || !readdirSync(sessionDir).some((file) => file.startsWith("events.active."))) return;
        const store = collector === "peer_store" ? peer : compactor;
        collected = (store as unknown as { cleanupHistoryOrphans(id: string): number }).cleanupHistoryOrphans("s_abc");
      });
      assert.ok(collected >= 0, `${collector}: collection ran while the copy was in flight`);
      if (collector === "peer_store") {
        assert.ok(collected >= 1, "the peer removed the unreferenced prepared files");
        assert.equal(result.compacted, 0);
        assert.equal(result.errors, 1);
        assert.equal(existsSync(join(sessionDir, "events.manifest.json")), false);
      } else {
        assert.equal(collected, 0, "this store keeps its own in-flight files");
        assert.equal(result.compacted, 1);
      }
      assert.deepEqual(coldSeqs(root), seqRange(4_000), collector);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
