import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, SESSION_HISTORY_PREVIEW_BYTE_BUDGET, type WorkflowArtifactView, type ControlPlaneToRunner } from "@wollipog/protocol";
import { SessionStore } from "../../runner/src/session-store.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { HistoryPreviewReader } from "./history-preview.js";

function fixture(protocol = PROTOCOL_VERSION, { empty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-history-preview-"));
  const store = new SessionStore(root);
  store.create({ sessionId: "s1", agentId: "fixture", workspaceId: null, repoPath: root,
    worktreePath: null, driver: "codex-app-server", command: "fixture", args: [], env: {},
    context: { kind: "native" }, agentSessionId: null, status: "idle", title: "Synthetic",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 0, createdAt: 1, updatedAt: 1 });
  if (!empty) {
    store.appendEvent("s1", { kind: "user_message", text: "Old cached prompt" }, 1);
    for (let i = 0; i < 20; i++) store.appendEvent("s1", { kind: "stderr", text: "Old activity" }, 2);
    store.appendEvent("s1", { kind: "user_message", text: "Authoritative current prompt" }, 3);
    for (let i = 0; i < 450; i++) store.appendEvent("s1", { kind: "agent_message", text: `Current activity ${i}`, final: true }, 4);
  }
  store.flush("s1");
  const first = store.readEventPageForProtocol("s1", { afterSeq: 0, limit: 1 }, PROTOCOL_VERSION);
  assert.ok(first.ok);
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({ runnerId: "r1", hostname: "fixture", os: "linux", version: "test", workspaces: [], agents: [] }, 1, protocol);
  db.createSession({ id: "s1", title: "Synthetic", runnerId: "r1", workspaceId: null, agentId: "fixture",
    driver: "codex-app-server", useWorktree: false, config: {}, now: 1 });
  // A brand-new session has not completed its first hydration pass yet.
  if (!empty) {
    db.reconcileRunnerHistory("s1", first.page.logEpoch, first.page.throughSeq);
    db.appendHydratedPage("s1", { afterSeq: 0, historyEpoch: first.page.logEpoch, eventEpoch: 0 }, first.events);
  }
  const hub = new Hub(db);
  const messages: ControlPlaneToRunner[] = [];
  let intercept: ((message: Extract<ControlPlaneToRunner, { type: "session_history_page" }>, reply: () => void) => void) | undefined;
  const socket = { send(data: string) {
    const message = JSON.parse(data) as ControlPlaneToRunner;
    messages.push(message);
    if (message.type !== "session_history_page") return;
    const result = message.opening ? store.readCurrentTurnPageForProtocol("s1", message.limit, PROTOCOL_VERSION, message.maxBytes)
      : store.readEventPageForProtocol("s1", message, PROTOCOL_VERSION, message.indexedOnly === true);
    const reply = () => hub.resolveRunnerRequest({ type: "session_history_page_result",
      requestId: message.requestId, sessionId: "s1", ...result });
    queueMicrotask(() => intercept ? intercept(message, reply) : reply());
  } };
  hub.attachRunner("r1", socket);
  return { db, store, hub, socket, messages, epoch: first.page.logEpoch, tail: first.page.throughSeq,
    reader: new HistoryPreviewReader(db, hub), intercept: (fn: typeof intercept) => { intercept = fn; },
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("real indexed runner supplies an authoritative turn before CP prefix hydration and preserves frozen paging", async () => {
  const f = fixture();
  try {
    const before = f.db.getRunnerHistoryState("s1");
    const preview = await f.reader.read("s1", 0, { limit: 200 });
    assert.ok(preview);
    assert.equal(preview.turnStartSeq, 22);
    assert.equal(preview.events[0]?.payload.kind, "user_message");
    assert.equal(preview.events.length, 200);
    assert.equal(preview.throughSeq, 472);
    assert.equal(preview.hasMore, true);
    assert.deepEqual(f.db.getRunnerHistoryState("s1"), before, "the read cannot advance hydration or mark it complete");
    assert.equal(f.db.listEvents("s1").length, 1, "runner preview rows never enter the CP cache or accounting");
    const cursor = { logEpoch: preview.logEpoch, throughSeq: preview.throughSeq, turnStartSeq: preview.turnStartSeq, limit: 200 };
    f.store.appendEvent("s1", { kind: "user_message", text: "Newer raced turn" }, 5);
    f.db.reconcileRunnerHistory("s1", f.epoch, 473);
    const later = await f.reader.read("s1", 0, { ...cursor, afterSeq: preview.nextAfterSeq });
    assert.ok(later);
    assert.equal(later.events[0]?.seq, 222);
    assert.equal(later.throughSeq, 472, "later appends cannot extend the frozen read");
    const older = await f.reader.read("s1", 0, { ...cursor, beforeSeq: preview.turnStartSeq });
    assert.ok(older);
    assert.deepEqual(older.events.map(event => event.seq), Array.from({ length: 21 }, (_, index) => index + 1));
    assert.equal(f.messages.filter(message => message.type === "session_history_page" && message.opening).length, 1);
  } finally { f.close(); }
});

test("a new session's empty runner log yields no preview, so it never opens as a snapshot (#3075)", async () => {
  const f = fixture(PROTOCOL_VERSION, { empty: true });
  try {
    assert.equal(f.db.getRunnerHistoryState("s1")?.complete, false, "the cache is still hydrating");
    assert.equal(await f.reader.read("s1", 0, { limit: 200 }), null);
    assert.equal(f.messages.filter(message => message.type === "session_history_page" && message.opening).length, 1,
      "the runner answered with its empty current turn");
  } finally { f.close(); }
});

test("late authoritative replies and frozen pages are rejected after event-epoch replacement", async () => {
  const f = fixture();
  try {
    let release!: () => void;
    f.intercept((_message, reply) => { release = reply; });
    const pending = f.reader.read("s1", 0, { limit: 200 });
    await new Promise<void>(done => queueMicrotask(done));
    f.db.reconcileRunnerHistory("s1", f.epoch + 1, 1);
    release();
    assert.equal(await pending, null);
    assert.equal(await f.reader.read("s1", 0, { limit: 200 }), null);
  } finally { f.close(); }
});

test("hydration handoff uses proven CP identities including CP-only rows, never a runner offset", async () => {
  const f = fixture();
  try {
    const preview = await f.reader.read("s1", 0, { limit: 200 });
    assert.ok(preview);
    const read = { logEpoch: preview.logEpoch, throughSeq: preview.throughSeq,
      turnStartSeq: preview.turnStartSeq, handoffSeq: 22, handoffFirstSeq: 22, handoffLastSeq: 221, limit: 200 };
    assert.equal(f.reader.handoff("s1", 0, read), null, "incomplete cache cannot prove the handoff identity");
    const bytes = Buffer.from("synthetic attachment");
    const artifact: WorkflowArtifactView = { artifactId: "a1", sessionId: "s1", kind: "test_log",
      name: "synthetic.txt", mimeType: "text/plain", encoding: "utf8", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), createdBy: { kind: "system", id: "fixture" },
      metadata: { purpose: "session_attachment" }, createdAt: 2 };
    f.db.createWorkflowArtifactBytes(artifact, bytes);
    f.db.appendEvent("s1", { kind: "artifact_attached", artifact }, 2);
    let after = 1;
    while (after < f.tail) {
      const page = f.store.readEventPageForProtocol("s1", { afterSeq: after, limit: 200, logEpoch: f.epoch, throughSeq: f.tail }, PROTOCOL_VERSION);
      assert.ok(page.ok);
      const applied = f.db.appendHydratedPage("s1", { afterSeq: after, historyEpoch: f.epoch, eventEpoch: 0 }, page.events);
      assert.ok(applied.applied);
      after = page.page.nextAfterSeq;
      if (after === 201) f.db.appendEvent("s1", { kind: "artifact_attached", artifact }, 4);
    }
    const handoff = f.reader.handoff("s1", 0, read);
    assert.ok(handoff);
    assert.equal(handoff.events[0]?.seq, 23, "CP sequence includes its own prefix");
    assert.equal(handoff.events[0]?.id, f.db.listEvents("s1").find(event => event.seq === 23)?.id);
    assert.ok(handoff.events.some(event => event.payload.kind === "artifact_attached" && event.payload.artifact.artifactId === "a1"));
    assert.equal(handoff.events.length, 200);
    assert.equal(handoff.cacheComplete, true);
    assert.equal(handoff.hasMoreLater, true);
    assert.equal(handoff.hasMoreHandoff, true, "CP-only rows cannot consume a loaded runner row's slot");
    const final = f.reader.handoff("s1", 0, { ...read, handoffAfter: handoff.nextAfter });
    assert.ok(final);
    assert.equal(final.hasMoreHandoff, false);
    const identities = [...handoff.identities, ...final.identities];
    assert.deepEqual(identities.map(row => row.runnerSeq), Array.from({ length: 200 }, (_, i) => i + 22));
    assert.equal(final.events.at(-1)?.seq, final.windowEndSeq);
    const expanded = f.reader.handoff("s1", 0, { ...read, handoffFirstSeq: 1, handoffLastSeq: f.tail });
    assert.ok(expanded);
    const all = [...expanded.events];
    let next = expanded;
    while (next.hasMoreHandoff) {
      const page = f.reader.handoff("s1", 0, { ...read, handoffFirstSeq: 1, handoffLastSeq: f.tail, handoffAfter: next.nextAfter });
      assert.ok(page); all.push(...page.events); next = page;
    }
    assert.equal(all.length, f.tail + 2, "the entire explicitly loaded range retains CP-only rows");
  } finally { f.close(); }
});

test("mixed and offline peers cannot serve a falsely authoritative cache prefix", async () => {
  const old = fixture(RUNNER_CAPABILITY_MIN_PROTOCOL.authoritativeHistoryWindow - 1);
  try {
    assert.equal(await old.reader.read("s1", 0, { limit: 200 }), null);
    assert.equal(old.messages.length, 0);
  } finally { old.close(); }
  const offline = fixture();
  try {
    offline.hub.detachRunner("r1", offline.socket);
    assert.equal(await offline.reader.read("s1", 0, { limit: 200 }), null);
    assert.equal(offline.messages.length, 0);
  } finally { offline.close(); }
});


test("preview admission deduplicates readers and bounds concurrent runner work independently of hydration", async () => {
  const f = fixture();
  try {
    const replies: Array<() => void> = [];
    f.intercept((_request, reply) => replies.push(reply));
    const first = f.reader.read("s1", 0, { limit: 200 });
    const duplicate = f.reader.read("s1", 0, { limit: 200 });
    const other = f.reader.read("s1", 0, { limit: 100 });
    assert.equal(await f.reader.read("s1", 0, { limit: 50 }), null);
    await new Promise<void>(done => queueMicrotask(done));
    assert.equal(replies.length, 2);
    for (const reply of replies) reply();
    const [one, two, three] = await Promise.all([first, duplicate, other]);
    assert.ok(one);
    assert.deepEqual(two, one);
    assert.equal(three?.events.length, 100);
    f.intercept(undefined);
    assert.ok(await f.reader.read("s1", 0, { limit: 50 }), "admission is released after every response");
  } finally { f.close(); }
});

test("the live negotiated capability, rather than stale persisted capability, gates preview reads", async () => {
  const f = fixture();
  try {
    f.hub.attachRunner("r1", f.socket, RUNNER_CAPABILITY_MIN_PROTOCOL.authoritativeHistoryWindow - 1);
    assert.equal(await f.reader.read("s1", 0, { limit: 200 }), null);
    assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});


test("large realistic turn pages use the negotiated byte budget and preserve an oversized single record", async () => {
  const f = fixture();
  try {
    f.store.appendEvent("s1", { kind: "user_message", text: "Large authoritative turn" }, 5);
    for (let i = 0; i < 200; i++) f.store.appendEvent("s1", { kind: "stderr", text: "x".repeat(16_000) }, 6);
    const large = await f.reader.read("s1", 0, { limit: 200 });
    assert.ok(large);
    assert.equal(large.events[0]?.payload.kind, "user_message");
    assert.ok(large.events.length < 200);
    assert.ok(Buffer.byteLength(JSON.stringify(large.events)) < SESSION_HISTORY_PREVIEW_BYTE_BUDGET);
    assert.equal(large.hasMore, true);
    assert.ok(f.messages.some(message => message.type === "session_history_page" && message.maxBytes === SESSION_HISTORY_PREVIEW_BYTE_BUDGET));
    f.store.appendEvent("s1", { kind: "user_message", text: "x".repeat(512_000) }, 7);
    const jumbo = await f.reader.read("s1", 0, { limit: 200 });
    assert.ok(jumbo);
    assert.equal(jumbo.events.length, 1, "one authoritative record may use the existing global transport ceiling");
    assert.equal(jumbo.hasMore, false);
  } finally { f.store.flush("s1"); f.close(); }
});

test("unavailable preview results back off for the same history identity and retry on a new tail", async () => {
  const f = fixture();
  try {
    f.store.patchMeta("s1", { historyTurnAnchor: undefined });
    assert.equal(await f.reader.read("s1", 0, { limit: 200 }), null);
    const before = f.messages.length;
    for (let i = 0; i < 20; i++) assert.equal(await f.reader.read("s1", 0, { limit: 200 }), null);
    assert.equal(f.messages.length, before, "75-ms opening polls cannot repeat the unavailable runner work");
    f.store.appendEvent("s1", { kind: "user_message", text: "New turn restores authority" }, 8);
    f.db.reconcileRunnerHistory("s1", f.epoch, 473);
    assert.ok(await f.reader.read("s1", 0, { limit: 200 }));
  } finally { f.store.flush("s1"); f.close(); }
});
