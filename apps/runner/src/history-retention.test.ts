import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager } from "./session-manager.js";
import type { Driver } from "./drivers/driver.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { PROTOCOL_VERSION, type SessionEventPayload } from "@wollipog/protocol";

function fixture(events = 300) {
  const root = mkdtempSync(join(tmpdir(), "runner-retention-"));
  const store = new SessionStore(root, undefined, { triggerActiveBytes: 1, retainActiveBytes: 1,
    retainActiveEvents: 1, maxSegmentBytes: 1024 * 1024, orphanGraceMs: 0 });
  store.create({ sessionId: "s_test", agentId: "agent", workspaceId: "repo", repoPath: root,
    worktreePath: null, driver: "codex", command: "codex", args: [], env: {}, context: { kind: "native" },
    agentSessionId: "resume-id", status: "completed", title: "Retention", config: { maxToolCalls: 1 },
    tokensIn: 40, tokensOut: 20, costUsd: 2, preview: "Final answer", pendingApproval: null,
    seq: 0, createdAt: 1, updatedAt: 1 } satisfies SessionMeta);
  const append = (payload: SessionEventPayload) => store.appendEvent("s_test", payload)!;
  append({ kind: "user_message", text: "Keep prompt" });
  append({ kind: "agent_message", text: "Old final report", final: true });
  append({ kind: "permission_resolved", requestId: "approval", optionId: "yes" });
  append({ kind: "question_resolved", requestId: "question", answered: true });
  append({ kind: "workflow_action_admission_armed", occurrenceId: "decision", commandDigest: "digest", sessionTurnId: "turn", providerTurnId: "native" });
  append({ kind: "checkpoint", turn: 1, tree: "tree" });
  append({ kind: "token_usage", inputTokens: 40, outputTokens: 20, costUsd: 2 });
  append({ kind: "tool_call", toolCallId: "call", title: "Private command", text: "Discard command", status: "completed" });
  for (let n = 0; n < events; n++) append({ kind: "command_output", text: "discard output ".repeat(250) });
  append({ kind: "agent_message", text: "Final ", messageId: "last" });
  append({ kind: "token_usage", inputTokens: 0 });
  append({ kind: "agent_message", text: "answer", messageId: "last" });
  append({ kind: "agent_response_completed" });
  append({ kind: "status", status: "completed" }); // removed tail must never reuse its seq
  store.flushAll();
  return { root, store, append, throughSeq: store.readMeta("s_test")!.seq };
}

function diskBytes(root: string): number {
  return readdirSync(join(root, "s_test"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("events."))
    .reduce((sum, entry) => sum + statSync(join(root, "s_test", entry.name)).size, 0);
}

test("retention reduces compacted disk bytes, keeps audit/resume/accounting evidence and preserves cursors", async (t) => {
  const f = fixture();
  try {
    assert.equal(f.store.acquireLock("s_test", "compactor"), true);
    assert.equal((await f.store.compactHistory("s_test", "compactor", true)).compacted, true);
    f.store.releaseLock("s_test", "compactor");
    const oldEvents = f.store.readEvents("s_test");
    const before = diskBytes(f.root);
    const started = performance.now();
    const result = await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim");
    assert.equal(result.trimmed, true);
    t.diagnostic(JSON.stringify({ inputBytes: before, retainedBytes: diskBytes(f.root), copyMs: performance.now() - started }));
    assert.ok(diskBytes(f.root) < before / 10, JSON.stringify(readdirSync(join(f.root, "s_test")).map(name => [name, statSync(join(f.root, "s_test", name)).size])));
    const restarted = new SessionStore(f.root);
    assert.deepEqual(restarted.toolCallIds("s_test"), ["call"]);
    const kept = restarted.readEvents("s_test");
    assert.ok(kept.every((event) => oldEvents.some((old) => JSON.stringify(old) === JSON.stringify(event))));
    assert.deepEqual(kept.map((event) => event.payload.kind), ["user_message", "agent_message",
      "permission_resolved", "question_resolved", "workflow_action_admission_armed", "checkpoint", "token_usage",
      "agent_message", "token_usage", "agent_message", "agent_response_completed"]);
    const paged: typeof kept = [];
    let afterSeq = 0;
    for (let attempt = 0; attempt < kept.length + 2; attempt++) {
      const page = restarted.readEventPage("s_test", { afterSeq, limit: 2 });
      assert.equal(page.ok, true, JSON.stringify(page));
      if (!page.ok) break;
      paged.push(...page.events); afterSeq = page.page.nextAfterSeq;
      if (!page.page.hasMore) break;
    }
    assert.deepEqual(paged, kept);
    assert.equal(afterSeq, f.throughSeq);
    const meta = restarted.readMeta("s_test")!;
    assert.equal(meta.agentSessionId, "resume-id");
    assert.equal(meta.costUsd, 2);
    assert.equal(meta.logEpoch ?? 0, 0);
    const next = restarted.appendEvent("s_test", { kind: "user_message", text: "Resume" })!;
    assert.equal(next.seq, f.throughSeq + 1);
    restarted.flushAll();
    const page = restarted.readEventPageForProtocol("s_test", { afterSeq: f.throughSeq, limit: 10 }, PROTOCOL_VERSION);
    assert.equal(page.ok, true, JSON.stringify(page));
    if (page.ok) assert.deepEqual(page.events, [next]);
    assert.equal((await restarted.trimHistory("s_test", { logEpoch: 0, throughSeq: next.seq }, "trim")).trimmed, true);
    assert.deepEqual(restarted.toolCallIds("s_test"), ["call"]);
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a live writer or changed boundary wins; copying yields while other sessions append", async () => {
  const f = fixture(1500);
  try {
    f.store.acquireLock("s_test", "live");
    assert.equal((await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim")).trimmed, false);
    f.store.releaseLock("s_test", "live");
    const original = f.store.readEvents("s_test");
    f.store.create({ ...f.store.readMeta("s_test")!, sessionId: "s_live", seq: 0 });
    let checks = 0;
    const job = f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim", () => ++checks < 2);
    let turns = 0;
    const timer = setInterval(() => { turns++; f.store.appendEvent("s_live", { kind: "command_output", text: "Live I/O" }); }, 1);
    const result = await job;
    clearInterval(timer);
    assert.ok(turns > 0);
    assert.equal(f.store.readEvents("s_live").length, turns);
    assert.equal(result.trimmed, false);
    assert.deepEqual(f.store.readEvents("s_test"), original);
    assert.equal(f.store.historyRetention("s_test"), undefined);
    assert.equal((await f.store.trimHistory("s_test", { logEpoch: 1, throughSeq: f.throughSeq }, "trim")).trimmed, false);
    assert.equal((await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim")).trimmed, true);
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const point of ["before_manifest", "after_manifest"] as const) {
  test(`process death ${point} leaves readable history; next pass finishes`, async () => {
    const f = fixture();
    try {
      const script = join(f.root, "crash.mjs");
      writeFileSync(script, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { SessionStore } from ${JSON.stringify(new URL("./session-store.ts", import.meta.url).href)};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('events.manifest.json')) {
    if (${JSON.stringify(point)} === 'after_manifest') rename(from, to);
    process.exit(71);
  }
  return rename(from, to);
};
syncBuiltinESMExports();
const store = new SessionStore(${JSON.stringify(f.root)});
await store.trimHistory('s_test', {logEpoch: 0, throughSeq: ${f.throughSeq}}, 'crashed');
process.exit(72);
`);
      const child = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
      assert.equal(child.status, 71, child.stderr);
      const recovered = new SessionStore(f.root);
      const preview = recovered.readEventPage("s_test", { afterSeq: 300, limit: 10 }, true);
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const events = recovered.readEvents("s_test");
      assert.ok(events.some((event) => event.payload.kind === "user_message"));
      const page = recovered.readEventPage("s_test", { afterSeq: 0, limit: 100 });
      assert.equal(page.ok, true, JSON.stringify(page));
      // A real runner restart owns the whole store lease, so no prior session writer survives.
      recovered.releaseLock("s_test", "crashed");
      assert.equal((await recovered.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "retry")).trimmed, true);
      assert.ok(diskBytes(f.root) < 10_000, JSON.stringify(readdirSync(join(f.root, "s_test")).map(name => [name, statSync(join(f.root, "s_test", name)).size])));
    } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("trimmed sessions resume across manager restarts; Reprocess refuses before replacing history", async () => {
  const f = fixture(100);
  const resumeIds: Array<string | undefined> = [];
  const prompts: string[] = [];
  const messages: unknown[] = [];
  let manager: SessionManager | undefined;
  try {
    f.store.patchMeta("s_test", { driver: "codex-app-server", config: {}, adopted: true });
    await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim");
    const kept = f.store.readEvents("s_test");
    const factory: ConstructorParameters<typeof SessionManager>[5] = (_kind, options, callbacks): Driver => {
      resumeIds.push(options.resumeId);
      return { pid: undefined, initialize: async () => {}, newSession: async () => options.resumeId ?? "wrong-new-id",
        agentSessionId: () => options.resumeId ?? null,
        prompt: async (text) => { prompts.push(text); callbacks.onEvent({ kind: "agent_message", text: "Resumed", final: true }); return "end_turn"; },
        setConfig: () => {}, cancel: () => {}, resolvePermission: () => false, dispose: () => {} };
    };
    for (let round = 0; round < 2; round++) {
      const store = new SessionStore(f.root);
      manager = new SessionManager(message => messages.push(message), message => messages.push(message), store, "runner", undefined, factory, f.root);
      assert.throws(() => manager!.reprocess("s_test", [{ kind: "user_message", text: "short replacement" }]), /Full history cannot be restored/);
      if (round === 0) assert.deepEqual(store.readEvents("s_test"), kept);
      manager.prompt("s_test", `Resume ${round}`);
      for (let spin = 0; spin < 400 && prompts.length <= round; spin++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(prompts.length, round + 1, JSON.stringify(messages));
      assert.equal(resumeIds[round], "resume-id");
      assert.ok(store.readMeta("s_test")!.seq > f.throughSeq);
      manager.shutdownAll(); manager = undefined;
      store.flushAll();
    }
  } finally { manager?.shutdownAll(); f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an empty kept prefix remains readable by indexed peers and never reuses removed sequence ids", async () => {
  const f = fixture(1);
  try {
    f.store.resetEvents("s_test");
    for (let n = 0; n < 400; n++) f.append({ kind: "command_output", text: "Discard" });
    f.store.flushAll();
    const throughSeq = f.store.readMeta("s_test")!.seq;
    assert.equal((await f.store.trimHistory("s_test", { logEpoch: 1, throughSeq }, "trim")).trimmed, true);
    const store = new SessionStore(f.root);
    const page = store.readEventPage("s_test", { afterSeq: 200, limit: 10 }, true);
    assert.equal(page.ok, true, JSON.stringify(page));
    if (page.ok) { assert.deepEqual(page.events, []); assert.equal(page.page.nextAfterSeq, throughSeq); }
    assert.equal(store.appendEvent("s_test", { kind: "user_message", text: "New turn" })!.seq, throughSeq + 1);
    store.flushAll();
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy runner-marked background delivery remains durable resume evidence", async () => {
  const f = fixture(1);
  try {
    const marker = f.append({ kind: "stderr", runnerMarker: "background_continuation_delivery", text: "Managed background continuation delivered: continuation" });
    f.store.flushAll();
    await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: marker.seq }, "trim");
    assert.deepEqual(f.store.readEvents("s_test").find(event => event.seq === marker.seq), marker);
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

test("retention admits one copy at a time and joins only the exact duplicate boundary", async () => {
  const f = fixture(200);
  try {
    f.store.create({ ...f.store.readMeta("s_test")!, sessionId: "s_other", seq: 0 });
    f.store.appendEvent("s_other", { kind: "command_output", text: "Discard" });
    f.store.flushAll();
    const first = f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim");
    assert.equal(f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "duplicate"), first);
    assert.equal((await f.store.trimHistory("s_other", { logEpoch: 0, throughSeq: 1 }, "other")).trimmed, false);
    assert.equal((await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq + 1 }, "stale")).trimmed, false);
    assert.equal((await first).trimmed, true);
    assert.equal((await f.store.trimHistory("s_other", { logEpoch: 0, throughSeq: 1 }, "retry")).trimmed, true);
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});

test("failed unlinks do not claim reclaimed disk bytes and a later pass retries cleanup", async () => {
  const f = fixture(20);
  const originalUnlink = fsPromises.unlink;
  try {
    fsPromises.unlink = async () => { throw new Error("fixture open-file refusal"); };
    syncBuiltinESMExports();
    const result = await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim");
    assert.equal(result.trimmed, true);
    assert.equal(result.bytesRemoved, 0);
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
    assert.ok((await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "retry")).bytesRemoved > 0);
    assert.ok(diskBytes(f.root) < 10_000);
  } finally {
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
    f.store.flushAll(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("retained hot appends do not re-read the unchanged manifest to append an index checkpoint", async () => {
  const f = fixture(5);
  try {
    await f.store.trimHistory("s_test", { logEpoch: 0, throughSeq: f.throughSeq }, "trim");
    f.append({ kind: "user_message", text: "Resume" });
    const internals = f.store as unknown as {
      readHistoryManifest: (...args: unknown[]) => unknown;
      historyLayoutCache: Map<string, { validatedAt: number; fullyValidatedAt: number }>;
    };
    const read = internals.readHistoryManifest.bind(f.store);
    let manifestReads = 0;
    internals.readHistoryManifest = (...args) => { manifestReads++; return read(...args); };
    const cached = internals.historyLayoutCache.get("s_test")!;
    cached.validatedAt = cached.fullyValidatedAt = performance.now() + 60_000;
    for (let n = 0; n < 300; n++) f.append({ kind: "command_output", text: "Live output" });
    assert.equal(manifestReads, 0, "crossing an index checkpoint must not validate every cold segment on the hot path");
  } finally { f.store.flushAll(); rmSync(f.root, { recursive: true, force: true }); }
});
