import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ARCHIVED_HISTORY_RETENTION_DELAY_MS,
  PROTOCOL_VERSION,
  type ControlPlaneToRunner,
  type RunnerMetadata,
  type SessionEventPayload,
} from "@wollipog/protocol";
import { ArchivedHistoryRetention, parseArchivedHistoryRetentionEnvironment } from "./archived-history-retention.js";
import { ControlPlaneDb } from "./db.js";
import { externalizeSessionEventPayload } from "./event-payloads.js";
import { Hub } from "./hub.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";
import { SessionsService } from "./sessions.js";

/**
 * #2777: once an organization turns archived-history retention on, archived sessions older than its
 * threshold keep their prompts, final response, turn-completion and report, usage and attachment
 * events, and lose the rest of their cached transcript together with its search rows and payloads.
 */

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 0, 1);
const RUNNER_ID = "retention-runner";
const ORG = PERSONAL_ORGANIZATION_ID;
const QUIET_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: "ws", name: "Repo", path: "/tmp/retention" }],
    agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  };
}

function openDb(location = ":memory:", protocolVersion?: number): ControlPlaneDb {
  const db = ControlPlaneDb.open(location);
  db.registerRunner(runnerMeta(), T0, protocolVersion);
  return db;
}

function createSession(db: ControlPlaneDb, id: string, now = T0): void {
  db.createSession({ id, runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: id,
    useWorktree: false, driver: "claude-code", config: {}, now });
}

class Clock {
  now = T0;
  sleeps: number[] = [];
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };
}

function retention(db: ControlPlaneDb, clock: Clock, env: NodeJS.ProcessEnv = {}, warnings: string[] = []): ArchivedHistoryRetention {
  return new ArchivedHistoryRetention(db, {
    env,
    log: { info() {}, warn: (_details, message) => warnings.push(message) },
    now: () => clock.now,
    sleep: clock.sleep,
  });
}

/** Append `turns` turns shaped like the measured mix: a prompt, streamed thoughts and messages,
 * tool calls with output, a file edit, usage, and a streamed answer closed by a completion. */
function appendTranscript(db: ControlPlaneDb, sessionId: string, turns: number, options: {
  start?: number; runnerSeq?: number; toolCalls?: number; bigOutput?: boolean;
} = {}): { runnerSeq: number; ts: number } {
  let ts = options.start ?? T0 + 1_000;
  let runnerSeq = options.runnerSeq ?? 0;
  const append = (payload: SessionEventPayload, extra: { searchPayload?: SessionEventPayload; artifactIds?: string[] } = {}) => {
    ts += 1;
    runnerSeq += 1;
    db.appendEvent(sessionId, payload, ts, { runnerSeq, historyEpoch: 1, ...extra });
  };
  for (let turn = 1; turn <= turns; turn += 1) {
    append({ kind: "user_message", text: `prompt-${turn} pelicanprompt` });
    for (const chunk of ["Looking", " into", " it"]) {
      append({ kind: "agent_message", text: chunk, messageId: `${sessionId}-progress-${turn}` });
    }
    append({ kind: "agent_thought", text: `reasoning-${turn} walrusthought` });
    for (let call = 0; call < (options.toolCalls ?? 3); call += 1) {
      const toolCallId = `${sessionId}-tool-${turn}-${call}`;
      append({ kind: "tool_call", toolCallId, title: "Run tests", status: "pending", text: `npm test ${call}` });
      append({ kind: "tool_call", toolCallId, title: "Run tests", status: "completed", text: `npm test ${call}` });
      append({ kind: "tool_call_update", toolCallId, status: "completed", text: `ok narwhaloutput ${call}` } as SessionEventPayload);
      append({ kind: "command_output", text: `narwhaloutput ${turn}-${call} `.repeat(20) });
    }
    if (options.bigOutput) {
      const original: SessionEventPayload = { kind: "command_output", text: `giant ${"narwhaloutput ".repeat(4_000)}` };
      const externalized = externalizeSessionEventPayload(db, sessionId, original, ts);
      append(externalized.payload, { searchPayload: original, artifactIds: [...externalized.artifactIds] });
    }
    append({ kind: "file_edit", path: `src/file-${turn}.ts`, diff: "+ added line\n".repeat(30) });
    append({ kind: "token_usage", inputTokens: 100 * turn, outputTokens: 10 * turn });
    for (const chunk of ["Done", " with", ` turn ${turn} osprey${turn === turns ? "final" : "answer"}`]) {
      append({ kind: "agent_message", text: chunk, messageId: `${sessionId}-answer-${turn}` });
    }
    append({ kind: "agent_response_completed" });
  }
  return { runnerSeq, ts };
}

function archive(db: ControlPlaneDb, sessionId: string, at: number): void {
  db.updateSessionStatus(sessionId, "completed", at);
  db.setSessionArchived(sessionId, true, at);
}

function kinds(db: ControlPlaneDb, sessionId: string): string[] {
  return db.listEvents(sessionId).map((event) => event.payload.kind);
}

/** Matching search rows of one session (searchEvents keeps one hit per session). */
function searchHits(db: ControlPlaneDb, term: string, sessionId: string): number {
  return (db.raw().prepare("SELECT COUNT(*) AS n FROM session_events_fts WHERE session_events_fts MATCH ? AND session_id=?")
    .get(`"${term}"`, sessionId) as { n: number }).n;
}

/** Turn retention on at `days`, then move past its delay and the session's threshold. */
async function pruneAfter(db: ControlPlaneDb, clock: Clock, days: number, archivedAt: number) {
  const policy = retention(db, clock);
  policy.update(ORG, days, "user-1");
  clock.now = Math.max(clock.now + ARCHIVED_HISTORY_RETENTION_DELAY_MS, archivedAt + days * DAY) + 1;
  return { policy, result: await policy.runPass() };
}

test("archiving records when it happened; unarchiving clears it and re-archiving restarts the clock", () => {
  const db = openDb();
  try {
    createSession(db, "s1");
    assert.equal(db.getSession("s1")!.archivedAt, undefined);
    archive(db, "s1", T0 + 5_000);
    assert.equal(db.getSession("s1")!.archivedAt, T0 + 5_000);
    db.setSessionArchived("s1", true, T0 + 9_000);
    assert.equal(db.getSession("s1")!.archivedAt, T0 + 5_000, "archiving again keeps the original time");
    db.setSessionArchived("s1", false, T0 + 10_000);
    assert.equal(db.getSession("s1")!.archivedAt, undefined);
    db.setSessionArchived("s1", true, T0 + 20_000);
    assert.equal(db.getSession("s1")!.archivedAt, T0 + 20_000);
    assert.equal(db.listSessions({ includeArchived: true }).find((session) => session.id === "s1")!.archivedAt, T0 + 20_000);
    db.createSession({ id: "born-archived", runnerId: RUNNER_ID, workspaceId: "ws", agentId: "agent", title: "x",
      useWorktree: false, driver: "claude-code", config: {}, now: T0 + 30_000, archived: true });
    assert.equal(db.getSession("born-archived")!.archivedAt, T0 + 30_000);
  } finally {
    db.close();
  }
});

test("sessions archived before the upgrade are backfilled no earlier than their real archive time", () => {
  const root = mkdtempSync(join(tmpdir(), "retention-backfill-"));
  try {
    const path = join(root, "db.sqlite");
    const db = openDb(path);
    createSession(db, "old");
    appendTranscript(db, "old", 1, { start: T0 + 2_000 });
    archive(db, "old", T0 + 50_000);
    db.raw().prepare("UPDATE sessions SET archived_at=NULL, updated_at=? WHERE id='old'").run(T0 + 60_000);
    db.close();
    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.getSession("old")!.archivedAt, T0 + 60_000);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention is off by default, arms 24 hours after it is turned on or shortened, and relaxes at once", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "s1");
    appendTranscript(db, "s1", 2);
    archive(db, "s1", T0);
    const policy = retention(db, clock);
    clock.now = T0 + 400 * DAY;
    assert.deepEqual(policy.policy(ORG), { retentionDays: null, prunesFrom: null, source: "default" });
    assert.equal((await policy.runPass()).events, 0, "off by default");

    const on = policy.update(ORG, 90, "user-1");
    assert.equal(on.retentionDays, 90);
    assert.equal(on.source, "organization");
    assert.equal(on.prunesFrom, clock.now + ARCHIVED_HISTORY_RETENTION_DELAY_MS);
    assert.deepEqual(on.eligible, { sessions: 1, events: db.getSession("s1")!.messageCount });
    clock.now += ARCHIVED_HISTORY_RETENTION_DELAY_MS - 1;
    assert.equal((await policy.runPass()).events, 0, "nothing is pruned inside the delay");

    const armedAt = on.prunesFrom!;
    assert.equal(policy.update(ORG, 120, "user-1").prunesFrom, armedAt, "lengthening keeps the arming");
    const shortened = policy.update(ORG, 30, "user-1");
    assert.equal(shortened.prunesFrom, clock.now + ARCHIVED_HISTORY_RETENTION_DELAY_MS, "shortening re-arms");
    assert.equal(policy.update(ORG, null, "user-1").prunesFrom, null, "off applies at once");
    assert.equal(policy.view(ORG, false, 30).preview!.prunesFrom, clock.now + ARCHIVED_HISTORY_RETENTION_DELAY_MS);

    policy.update(ORG, 30, "user-1");
    clock.now += ARCHIVED_HISTORY_RETENTION_DELAY_MS;
    const pass = await policy.runPass();
    assert.equal(pass.sessions, 1);
    assert.ok(pass.events > 0);
    assert.deepEqual(policy.view(ORG, true).lastRun, { finishedAt: clock.now, sessions: 1, events: pass.events });
  } finally {
    db.close();
  }
});

test("the environment sets a default that an organization's saved value, including off, overrides", () => {
  assert.deepEqual(parseArchivedHistoryRetentionEnvironment(undefined), { retentionDays: null, invalid: false });
  assert.deepEqual(parseArchivedHistoryRetentionEnvironment("0"), { retentionDays: null, invalid: false });
  assert.deepEqual(parseArchivedHistoryRetentionEnvironment(" 90 "), { retentionDays: 90, invalid: false });
  for (const invalid of ["6", "3651", "90d", "-7", "1e2", "9.5"]) {
    assert.deepEqual(parseArchivedHistoryRetentionEnvironment(invalid), { retentionDays: null, invalid: true }, invalid);
  }
  const db = openDb();
  const clock = new Clock();
  try {
    const warnings: string[] = [];
    retention(db, clock, { CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS: "abc" }, warnings);
    assert.equal(warnings.length, 1);
    const fromEnvironment = retention(db, clock, { CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS: "180" });
    assert.deepEqual(fromEnvironment.policy(ORG),
      { retentionDays: 180, prunesFrom: T0 + ARCHIVED_HISTORY_RETENTION_DELAY_MS, source: "environment" });
    clock.now += 10 * DAY;
    const restarted = retention(db, clock, { CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS: "180" });
    assert.equal(restarted.policy(ORG).prunesFrom, T0 + ARCHIVED_HISTORY_RETENTION_DELAY_MS, "a restart keeps the arming");
    const shortened = retention(db, clock, { CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS: "60" });
    assert.equal(shortened.policy(ORG).prunesFrom, clock.now + ARCHIVED_HISTORY_RETENTION_DELAY_MS);
    shortened.update(ORG, null, "user-1");
    assert.deepEqual(shortened.policy(ORG), { retentionDays: null, prunesFrom: null, source: "organization" });
    assert.equal(shortened.view(ORG, true).environmentDays, 60);
  } finally {
    db.close();
  }
});

test("a prune keeps prompts, the final response, completions, usage and attachments, and removes the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-prune-"));
  const db = openDb(join(root, "db.sqlite"));
  const clock = new Clock();
  try {
    createSession(db, "s1");
    createSession(db, "other");
    const { runnerSeq, ts } = appendTranscript(db, "s1", 3, { bigOutput: true });
    appendTranscript(db, "other", 1);
    db.reconcileRunnerHistory("s1", 1, runnerSeq);
    db.appendEvent("s1", { kind: "artifact_attached", artifact: { artifactId: "shot", sessionId: "s1", kind: "screenshot",
      name: "shot.png", mimeType: "image/png", encoding: "base64", sizeBytes: 4, sha256: "0".repeat(64),
      createdBy: { kind: "system", id: "test" }, createdAt: ts } } as SessionEventPayload, ts + 1);
    const payloadArtifacts = db.raw().prepare(
      "SELECT id FROM artifacts WHERE json_extract(metadata, '$.purpose')='session_event_payload'",
    ).all() as Array<{ id: string }>;
    assert.ok(payloadArtifacts.length > 0);
    const before = db.getSession("s1")!;
    const cursor = db.getRunnerHistoryState("s1")!;
    const toolCalls = db.countToolCalls("s1");
    const accountingEpoch = db.accountingEventEpoch("s1");
    const highestSeq = Math.max(...db.listEvents("s1").map((event) => event.seq));
    assert.ok(searchHits(db, "narwhaloutput", "s1") > 0);
    assert.ok(searchHits(db, "walrusthought", "s1") > 0);
    archive(db, "s1", T0 + DAY);
    archive(db, "other", T0 + 200 * DAY);

    const { result } = await pruneAfter(db, clock, 90, T0 + DAY);
    assert.equal(result.sessions, 1, "only the session past the threshold is pruned");

    const kept = kinds(db, "s1");
    assert.deepEqual([...new Set(kept)].sort(),
      ["agent_message", "agent_response_completed", "artifact_attached", "token_usage", "user_message"]);
    assert.equal(kept.filter((kind) => kind === "user_message").length, 3);
    assert.equal(kept.filter((kind) => kind === "token_usage").length, 3);
    assert.equal(kept.filter((kind) => kind === "agent_response_completed").length, 3);
    const response = db.listEvents("s1").filter((event) => event.payload.kind === "agent_message")
      .map((event) => (event.payload as { text: string }).text).join("");
    assert.equal(response, "Done with turn 3 ospreyfinal", "only the final response is kept, whole");

    const after = db.getSession("s1")!;
    assert.deepEqual(after.historyPruned, {
      prunedAt: clock.now, eventCount: before.messageCount - kept.length, retentionDays: 90,
    });
    assert.equal(after.messageCount, kept.length);
    assert.equal(after.eventEpoch, (before.eventEpoch ?? 0) + 1, "dashboards reload the pruned transcript");
    assert.equal(db.accountingEventEpoch("s1"), accountingEpoch, "accounting keeps its epoch");
    assert.equal(db.countToolCalls("s1"), toolCalls, "pruned tool calls still count");
    assert.equal(after.costUsd, before.costUsd);
    assert.equal(after.tokensIn, before.tokensIn);
    assert.equal(after.preview, before.preview);
    assert.equal(after.title, before.title);
    const state = db.getRunnerHistoryState("s1")!;
    assert.deepEqual([state.hydratedSeq, state.tailSeq, state.historyEpoch, state.complete],
      [cursor.hydratedSeq, cursor.tailSeq, cursor.historyEpoch, true], "the hydration cursor never moves");

    assert.equal(searchHits(db, "narwhaloutput", "s1"), 0, "pruned text leaves search");
    assert.equal(searchHits(db, "walrusthought", "s1"), 0);
    assert.equal(searchHits(db, "pelicanprompt", "s1"), 3, "kept prompts stay searchable");
    assert.equal(searchHits(db, "ospreyfinal", "s1"), 1);
    assert.ok(searchHits(db, "narwhaloutput", "other") > 0, "other sessions keep their search rows");
    for (const { id } of payloadArtifacts) {
      assert.equal(db.getWorkflowArtifact(id), null, "payloads of pruned events are removed");
      assert.equal(db.readWorkflowArtifactBytes(id), null);
    }
    assert.ok(kinds(db, "other").includes("tool_call"), "a session archived more recently is untouched");

    db.updateSessionStatus("s1", "idle", clock.now);
    db.setSessionArchived("s1", false, clock.now);
    const next = db.appendEvent("s1", { kind: "user_message", text: "after unarchive" }, clock.now);
    assert.ok(next.seq > highestSeq, "a pruned seq is never handed out again");
    assert.deepEqual(db.getSession("s1")!.historyPruned?.retentionDays, 90, "unarchiving keeps the record");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verified campaign child report stays verified when the child's history is pruned", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "campaign");
    createSession(db, "child");
    appendTranscript(db, "child", 2);
    db.appendEvent("child", { kind: "agent_message", text: "Final report: shipped.", final: true }, T0 + 50_000, {
      runnerSeq: 1_000, historyEpoch: 1,
    });
    const reportSeq = db.durableFinalReportSeq("child")!;
    assert.ok(reportSeq > 0);
    archive(db, "child", T0 + DAY);
    db.verifyCampaignChildReport("campaign", "child", reportSeq, T0 + DAY);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), true);
    await pruneAfter(db, clock, 30, T0 + DAY);
    assert.ok(db.getSession("child")!.historyPruned);
    assert.equal(db.campaignChildReportVerified("campaign", "child"), true);
    assert.equal(db.durableFinalReportSeq("child"), reportSeq);
    db.finishCampaignReportHistoryHydration("child");
    assert.equal(db.campaignChildReportVerified("campaign", "child"), true, "a later hydration keeps the proof");
  } finally {
    db.close();
  }
});

test("a campaign root pruned before its allowance keeps counting its pruned tool calls", () => {
  const db = openDb();
  try {
    createSession(db, "root");
    for (const id of ["one", "two", "three"]) {
      db.appendEvent("root", { kind: "tool_call", toolCallId: id, title: "Read", status: "completed" }, T0 + 1);
    }
    archive(db, "root", T0 + 2);
    const input = { cutoff: T0 + 100, retentionDays: 7, now: T0 + 100, maxEvents: 500, maxPayloadBytes: 2 * 1024 * 1024,
      maxSearchLength: 64 * 1024 };
    while (!db.pruneArchivedHistoryBatch("root", input).finished) { /* batches */ }
    assert.equal(db.countToolCalls("root"), 3);
    // Unarchived and resumed, it is then granted its first campaign allowance.
    db.setSessionArchived("root", false, T0 + 101);
    db.updateSessionStatus("root", "running", T0 + 101);
    db.campaignBudgets.authorize("root", { version: 1, accounting: "managed_workers_only", unpriced: "stop", toolCalls: 100,
      concurrency: 1 });
    assert.equal(db.campaignBudgets.view("root")!.actual.toolCalls, 3);
    db.appendEvent("root", { kind: "tool_call", toolCallId: "four", title: "Read", status: "completed" }, T0 + 102);
    db.appendEvent("root", { kind: "tool_call", toolCallId: "four", title: "Read", status: "completed" }, T0 + 103);
    assert.equal(db.countToolCalls("root"), 4);
    assert.equal(db.campaignBudgets.view("root")!.actual.toolCalls, 4, "a new call adds to the pruned ones, once");
  } finally {
    db.close();
  }
});

for (const replay of ["the same calls", "nothing"] as const) {
  test(`a campaign charges pruned tool calls once when a replaced history brings back ${replay}`, () => {
    const db = openDb();
    try {
      createSession(db, "root");
      const tool = (id: string, at: number) =>
        db.appendEvent("root", { kind: "tool_call", toolCallId: id, title: "Read", status: "completed" }, at);
      for (const id of ["one", "two", "three"]) tool(id, T0 + 1);
      archive(db, "root", T0 + 2);
      const input = { cutoff: T0 + 100, retentionDays: 7, now: T0 + 100, maxEvents: 500, maxPayloadBytes: 2 * 1024 * 1024,
        maxSearchLength: 64 * 1024 };
      while (!db.pruneArchivedHistoryBatch("root", input).finished) { /* batches */ }
      db.setSessionArchived("root", false, T0 + 101);
      db.campaignBudgets.authorize("root", { version: 1, accounting: "managed_workers_only", unpriced: "stop", toolCalls: 100,
        concurrency: 1 });
      db.clearSessionEvents("root");
      if (replay === "the same calls") for (const id of ["one", "two", "three"]) tool(id, T0 + 102);
      assert.equal(db.campaignBudgets.view("root")!.actual.toolCalls, 3, "a replayed call was already charged");
      tool("four", T0 + 103);
      assert.equal(db.campaignBudgets.view("root")!.actual.toolCalls, 4, "a new call adds to the pruned ones");
    } finally {
      db.close();
    }
  });
}

test("prunes visit only archived, settled sessions past the threshold", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    for (const id of ["eligible", "young", "unarchived", "stopping"]) {
      createSession(db, id);
      appendTranscript(db, id, 1);
    }
    archive(db, "eligible", T0);
    archive(db, "young", T0 + 100 * DAY);
    db.updateSessionStatus("unarchived", "completed", T0);
    archive(db, "stopping", T0);
    db.raw().prepare(`INSERT INTO session_stop_intents (session_id, runner_id, created_at, archive_after_stop, operation_id)
      VALUES ('stopping', ?, ?, 1, 'op')`).run(RUNNER_ID, T0);
    await pruneAfter(db, clock, 30, T0);
    assert.ok(db.getSession("eligible")!.historyPruned);
    for (const id of ["young", "unarchived", "stopping"]) {
      assert.equal(db.getSession(id)!.historyPruned, undefined, id);
      assert.ok(kinds(db, id).includes("tool_call"), id);
    }
  } finally {
    db.close();
  }
});

test("batches stay inside their budget and the sweeper rests between them", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "long");
    appendTranscript(db, "long", 40, { toolCalls: 6 });
    archive(db, "long", T0);
    const sizes: number[] = [];
    const original = db.pruneArchivedHistoryBatch.bind(db);
    db.pruneArchivedHistoryBatch = (sessionId, input) => {
      const result = original(sessionId, input);
      if (!result.finished) {
        assert.ok(result.removed <= input.maxEvents && input.maxEvents <= 500);
        assert.ok(result.removed === 1 || result.searchLength <= input.maxSearchLength);
        sizes.push(result.removed);
      }
      return result;
    };
    await pruneAfter(db, clock, 30, T0);
    assert.ok(sizes.length > 3, "a long transcript takes several batches");
    assert.ok(clock.sleeps.length >= sizes.length, "the sweeper rests after every batch");
    assert.ok(db.getSession("long")!.historyPruned);
  } finally {
    db.close();
  }
});

test("a long kept stretch is read one window per batch, and every removable row around it still goes", () => {
  const db = openDb();
  try {
    createSession(db, "kept");
    const append = (payload: SessionEventPayload) => db.appendEvent("kept", payload, T0 + 1);
    // Removable rows before, inside and after 2,500 kept prompts: windows end mid-batch, and at
    // least one window holds only kept rows.
    for (let index = 0; index < 5; index += 1) append({ kind: "stderr", text: `early-${index}` });
    for (let index = 0; index < 2_500; index += 1) {
      append({ kind: "user_message", text: `prompt-${index}` });
      if (index === 600) append({ kind: "stderr", text: "middle" });
    }
    for (let index = 0; index < 5; index += 1) append({ kind: "stderr", text: `late-${index}` });
    append({ kind: "agent_message", text: "the answer", messageId: "answer" });
    archive(db, "kept", T0 + 2);
    const input = { cutoff: T0 + 100, retentionDays: 7, now: T0 + 100, maxEvents: 2, maxPayloadBytes: 2 * 1024 * 1024,
      maxSearchLength: 64 * 1024 };
    let batches = 0;
    let advances = 0;
    for (;;) {
      const batch = db.pruneArchivedHistoryBatch("kept", input);
      batches += 1;
      if (batch.finished) break;
      if (batch.removed === 0) advances += 1;
    }
    assert.deepEqual(kinds(db, "kept").filter((kind) => kind !== "user_message"), ["agent_message"]);
    assert.equal(kinds(db, "kept").length, 2_501);
    assert.equal(db.getSession("kept")!.historyPruned!.eventCount, 11);
    assert.ok(advances >= 1, "a window with nothing to remove still moves the run on");
    assert.ok(batches <= Math.ceil(2_512 / 1_024) + Math.ceil(11 / 2) + 6, `${batches} batches`);
    assert.equal((db.raw().prepare("SELECT history_prune_run_seq AS v FROM sessions WHERE id='kept'").get() as { v: number | null }).v,
      null, "closing the run clears where it read through");
  } finally {
    db.close();
  }
});

test("a final response that arrives after a run read past the earlier one sends the run back, so the earlier one goes", () => {
  const db = openDb();
  try {
    createSession(db, "moved");
    db.appendEvent("moved", { kind: "agent_message", text: "earlier response", messageId: "A" }, T0 + 1);
    for (let index = 0; index < 1_023; index += 1) db.appendEvent("moved", { kind: "user_message", text: `prompt ${index}` }, T0 + 1);
    archive(db, "moved", T0 + 2);
    const input = { cutoff: T0 + 100, retentionDays: 7, now: T0 + 100, maxEvents: 500, maxPayloadBytes: 2 * 1024 * 1024,
      maxSearchLength: 64 * 1024 };
    assert.equal(db.pruneArchivedHistoryBatch("moved", input).finished, false, "the first window holds only kept rows");
    // Delayed history adds a later response while the run is open.
    db.appendEvent("moved", { kind: "agent_message", text: "latest response", messageId: "B" }, T0 + 3);
    while (!db.pruneArchivedHistoryBatch("moved", input).finished) { /* batches */ }
    const answers = db.listEvents("moved").flatMap((event) =>
      event.payload.kind === "agent_message" ? [event.payload.messageId] : []);
    assert.deepEqual(answers, ["B"]);
    assert.equal(db.getSession("moved")!.historyPruned!.eventCount, 1);
  } finally {
    db.close();
  }
});

test("an interrupted run resumes after a restart and ends where an uninterrupted run does", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-resume-"));
  try {
    const finalState = async (interrupt: boolean) => {
      const path = join(root, `${interrupt ? "interrupted" : "straight"}.sqlite`);
      let db = openDb(path);
      createSession(db, "s1");
      appendTranscript(db, "s1", 6);
      archive(db, "s1", T0);
      const clock = new Clock();
      retention(db, clock).update(ORG, 30, "user-1");
      clock.now = T0 + 31 * DAY;
      if (interrupt) {
        const partial = db.pruneArchivedHistoryBatch("s1", {
          cutoff: clock.now - 30 * DAY, retentionDays: 30, now: clock.now,
          maxEvents: 10, maxPayloadBytes: 1 << 21, maxSearchLength: 1 << 20,
        });
        assert.equal(partial.removed, 10);
        db.close();
        db = ControlPlaneDb.open(path);
        assert.equal(db.getSession("s1")!.historyPruned, undefined, "the record waits for the run to finish");
      }
      await retention(db, clock).runPass();
      const state = {
        events: db.listEvents("s1").map((event) => [event.seq, event.payload.kind]),
        pruned: db.getSession("s1")!.historyPruned?.eventCount,
        toolCalls: db.countToolCalls("s1"),
      };
      db.close();
      return state;
    };
    assert.deepEqual(await finalState(true), await finalState(false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run cut short by unarchiving closes over what it removed and resumes after re-archiving", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "s1");
    appendTranscript(db, "s1", 4);
    archive(db, "s1", T0);
    const policy = retention(db, clock);
    policy.update(ORG, 30, "user-1");
    clock.now = T0 + 31 * DAY;
    db.pruneArchivedHistoryBatch("s1", { cutoff: clock.now - 30 * DAY, retentionDays: 30, now: clock.now,
      maxEvents: 5, maxPayloadBytes: 1 << 21, maxSearchLength: 1 << 20 });
    db.setSessionArchived("s1", false, clock.now);
    await policy.runPass();
    assert.deepEqual(db.getSession("s1")!.historyPruned, { prunedAt: clock.now, eventCount: 5, retentionDays: 30 });
    assert.ok(kinds(db, "s1").includes("tool_call"), "the rest waits");
    db.setSessionArchived("s1", true, clock.now);
    clock.now += 31 * DAY;
    await policy.runPass();
    assert.equal(kinds(db, "s1").includes("tool_call"), false);
    assert.ok(db.getSession("s1")!.historyPruned!.eventCount > 5);
  } finally {
    db.close();
  }
});

test("turning retention off closes an open run and prunes nothing more", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "s1");
    appendTranscript(db, "s1", 3);
    archive(db, "s1", T0);
    const policy = retention(db, clock);
    policy.update(ORG, 30, "user-1");
    clock.now = T0 + 31 * DAY;
    db.pruneArchivedHistoryBatch("s1", { cutoff: clock.now - 30 * DAY, retentionDays: 30, now: clock.now,
      maxEvents: 4, maxPayloadBytes: 1 << 21, maxSearchLength: 1 << 20 });
    policy.update(ORG, null, "user-1");
    const remaining = kinds(db, "s1").length;
    await policy.runPass();
    assert.equal(db.getSession("s1")!.historyPruned?.eventCount, 4);
    assert.equal(kinds(db, "s1").length, remaining);
  } finally {
    db.close();
  }
});

test("reprocessing a pruned session replaces it with the full history and drops the prune record", async () => {
  const db = openDb();
  const clock = new Clock();
  try {
    createSession(db, "s1");
    appendTranscript(db, "s1", 2);
    archive(db, "s1", T0);
    await pruneAfter(db, clock, 30, T0);
    assert.ok(db.getSession("s1")!.historyPruned);
    db.clearSessionEvents("s1");
    const cleared = db.getSession("s1")!;
    assert.equal(cleared.historyPruned, undefined);
    assert.equal(db.countToolCalls("s1"), 0, "the pruned tool calls return with the replayed history");
    assert.equal(db.appendEvent("s1", { kind: "user_message", text: "replayed" }, clock.now, { runnerSeq: 1, historyEpoch: 2 }).seq, 1);
  } finally {
    db.close();
  }
});

test("search rows indexed before keyed rows are mapped first, so their pruned text leaves search", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-legacy-"));
  try {
    const path = join(root, "db.sqlite");
    const db = openDb(path);
    createSession(db, "s1");
    appendTranscript(db, "s1", 2);
    archive(db, "s1", T0);
    // Rewrite every search row as a build without keyed rows would have left it: arbitrary row ids,
    // in reverse order, some above every event id, and one orphan whose event is gone.
    const rows = db.raw().prepare("SELECT rowid, text, session_id, seq FROM session_events_fts ORDER BY rowid").all() as
      Array<{ rowid: number; text: string; session_id: string; seq: number }>;
    db.raw().exec("DELETE FROM session_events_fts");
    rows.reverse().forEach((row, index) => db.raw().prepare(
      "INSERT INTO session_events_fts(rowid, text, session_id, seq) VALUES (?, ?, ?, ?)",
    ).run(index % 2 ? index + 1 : 900_000 + index, row.text, row.session_id, row.seq));
    db.raw().prepare("INSERT INTO session_events_fts(rowid, text, session_id, seq) VALUES (950000, 'ghostword', 's1', 99999)").run();
    db.raw().exec("UPDATE fts_state SET keyed_through=NULL; DELETE FROM control_plane_metadata WHERE key='session_events_fts_legacy_scan'");
    db.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.legacySearchRowsPending(), true);
    const next = reopened.appendEvent("s1", { kind: "agent_message", text: "late narwhaloutput", messageId: "late-progress" },
      T0 + 5);
    assert.ok(next.id > 950_000, "new event ids stay above every unkeyed search row");
    reopened.appendEvent("s1", { kind: "agent_message", text: "late answer", messageId: "late-answer" }, T0 + 6);
    const clock = new Clock();
    await pruneAfter(reopened, clock, 30, T0);
    assert.equal(reopened.legacySearchRowsPending(), false);
    assert.equal(searchHits(reopened, "narwhaloutput", "s1"), 0);
    assert.equal(searchHits(reopened, "walrusthought", "s1"), 0);
    assert.equal(searchHits(reopened, "ghostword", "s1"), 0, "an orphaned search row is removed");
    assert.equal(searchHits(reopened, "pelicanprompt", "s1"), 2);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a search row id collision falls back to a recorded row the prune still removes", async () => {
  const db = openDb();
  try {
    createSession(db, "s1");
    const nextId = Number((db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='session_events'").get() as
      { seq: number } | undefined)?.seq ?? 0) + 1;
    db.raw().prepare("INSERT INTO session_events_fts(rowid, text, session_id, seq) VALUES (?, 'squatter', 'nobody', 1)")
      .run(nextId);
    const event = db.appendEvent("s1", { kind: "command_output", text: "collided narwhaloutput" }, T0 + 1);
    assert.equal(event.id, nextId);
    assert.equal(searchHits(db, "narwhaloutput", "s1"), 1);
    db.appendEvent("s1", { kind: "agent_message", text: "answer" }, T0 + 2);
    archive(db, "s1", T0);
    await pruneAfter(db, new Clock(), 30, T0);
    assert.equal(searchHits(db, "narwhaloutput", "s1"), 0);
    assert.equal(db.searchEvents("squatter", 10).length, 1, "the unrelated row stays");
  } finally {
    db.close();
  }
});

test("a later legacy scan keeps a recorded fallback row and removes duplicates and orphans", () => {
  const root = mkdtempSync(join(tmpdir(), "retention-rescan-"));
  try {
    const path = join(root, "db.sqlite");
    const db = openDb(path);
    createSession(db, "s1");
    const nextId = Number((db.raw().prepare("SELECT seq FROM sqlite_sequence WHERE name='session_events'").get() as
      { seq: number } | undefined)?.seq ?? 0) + 1;
    db.raw().prepare("INSERT INTO session_events_fts(rowid, text, session_id, seq) VALUES (?, 'squatter', 'nobody', 1)")
      .run(nextId);
    const prompt = db.appendEvent("s1", { kind: "user_message", text: "kestrelprompt" }, T0 + 1);
    db.raw().prepare("INSERT INTO session_events_fts(rowid, text, session_id, seq) VALUES (970000, 'kestrelprompt', 's1', ?)")
      .run(prompt.seq);
    assert.equal(searchHits(db, "kestrelprompt", "s1"), 2);
    // An older build ran in between: its events have unkeyed search rows, so the next open rescans.
    db.raw().exec("UPDATE fts_state SET keyed_through=keyed_through-1");
    db.close();

    const reopened = ControlPlaneDb.open(path);
    assert.equal(reopened.legacySearchRowsPending(), true);
    while (reopened.mapLegacySearchRows(2).pending) { /* paced steps */ }
    assert.equal(searchHits(reopened, "kestrelprompt", "s1"), 1, "the recorded row stays, its duplicate goes");
    assert.equal(reopened.searchEvents("squatter", 10).length, 0, "an orphan goes");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an older build's search row numbered below a finished scan is mapped and leaves search with its event", () => {
  const root = mkdtempSync(join(tmpdir(), "retention-rescan-reused-"));
  try {
    const path = join(root, "db.sqlite");
    let db = openDb(path);
    createSession(db, "s1");
    db.appendEvent("s1", { kind: "user_message", text: "keep" }, T0 + 2);
    db.appendEvent("s1", { kind: "stderr", text: "old output" }, T0 + 3);
    archive(db, "s1", T0 + 4);
    db.raw().exec("UPDATE fts_state SET keyed_through=NULL");
    db.close();
    db = ControlPlaneDb.open(path);
    while (db.mapLegacySearchRows(100).pending) { /* paced steps */ }
    const input = { cutoff: T0 + 100, retentionDays: 7, now: T0 + 100, maxEvents: 500, maxPayloadBytes: 2 * 1024 * 1024,
      maxSearchLength: 64 * 1024 };
    while (!db.pruneArchivedHistoryBatch("s1", input).finished) { /* batches */ }
    // The prune removed the highest search row, so an older build numbers its next row below the
    // finished scan's cursor.
    const sql = db.raw();
    sql.prepare("INSERT INTO session_events(session_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)")
      .run("s1", 3, T0 + 5, "stderr", JSON.stringify({ kind: "stderr", text: "rescansecret" }));
    sql.prepare("INSERT INTO session_events_fts(text, session_id, seq) VALUES (?, ?, ?)").run("rescansecret", "s1", 3);
    sql.exec("UPDATE fts_state SET last_rowid=(SELECT MAX(id) FROM session_events); UPDATE sessions SET message_count=message_count+1 WHERE id='s1'");
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.legacySearchRowsPending(), true);
    while (db.mapLegacySearchRows(100).pending) { /* paced steps */ }
    while (!db.pruneArchivedHistoryBatch("s1", input).finished) { /* batches */ }
    assert.deepEqual(kinds(db, "s1"), ["user_message"]);
    assert.equal(searchHits(db, "rescansecret", "s1"), 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const protocolVersion of [53, PROTOCOL_VERSION]) {
  test(`a protocol ${protocolVersion} runner is never asked for a pruned session's events again`, async () => {
    const db = openDb(":memory:", protocolVersion);
    const hub = new Hub(db);
    const svc = new SessionsService(db, hub, QUIET_LOG);
    try {
      createSession(db, "s1");
      const { runnerSeq } = appendTranscript(db, "s1", 2);
      db.reconcileRunnerHistory("s1", 1, runnerSeq);
      archive(db, "s1", T0);
      const clock = new Clock();
      await pruneAfter(db, clock, 30, T0);
      const kept = db.listEvents("s1").length;
      const requests: ControlPlaneToRunner[] = [];
      hub.attachRunner(RUNNER_ID, { send(data: string) {
        const message = JSON.parse(data) as ControlPlaneToRunner;
        requests.push(message);
        if (message.type === "session_history") {
          queueMicrotask(() => hub.resolveRunnerRequest({ type: "session_history_result", requestId: message.requestId,
            sessionId: message.sessionId, ok: true, events: [] }));
        } else if (message.type === "session_history_page") {
          queueMicrotask(() => hub.resolveRunnerRequest({ type: "session_history_page_result", requestId: message.requestId,
            sessionId: message.sessionId, ok: true, events: [],
            page: { logEpoch: 1, throughSeq: runnerSeq, nextAfterSeq: message.afterSeq, hasMore: false } }));
        }
      } });
      await svc.hydrateHistory("s1");
      await svc.hydrateHistory("s1", { force: true });
      for (const request of requests) {
        if (request.type === "session_history" || request.type === "session_history_page") {
          assert.ok(request.afterSeq >= runnerSeq, `${request.type} asks only past the cursor`);
        }
      }
      assert.equal(db.listEvents("s1").length, kept);
      assert.ok(db.getSession("s1")!.historyPruned);
    } finally {
      db.close();
    }
  });
}
