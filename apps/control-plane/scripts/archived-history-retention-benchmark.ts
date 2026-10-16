// Measures how long archived-history retention holds the event loop (#2777): every prune batch runs
// synchronously in one transaction, and removing indexed text with FTS5 secure-delete costs far more
// than the rows themselves. Run it on the disk that holds the real database (`--dir <path>`): on a
// tmpfs every flush is free, which hides part of the cost.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION, type SessionEventPayload } from "@wollipog/protocol";
import { ArchivedHistoryRetention } from "../src/archived-history-retention.js";
import { ControlPlaneDb } from "../src/db.js";
import { externalizeSessionEventPayload } from "../src/event-payloads.js";
import { PERSONAL_ORGANIZATION_ID } from "../src/identity.js";

const SESSIONS = 12;
const EVENTS_PER_SESSION = 2_000;
const DAY = 24 * 60 * 60_000;
// Batches adapt toward 8 ms. On a local NVMe SSD the p95 measured well under this limit.
const MAX_BATCH_P95_MS = 16;

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const root = mkdtempSync(join(values.dir ?? tmpdir(), "wollipog-archived-history-retention-benchmark-"));

let state = 0x2777;
const random = () => ((state = (state * 1_103_515_245 + 12_345) >>> 0) / 0x1_0000_0000);
const words = (count: number) => Array.from({ length: count }, () => `w${Math.floor(random() ** 2 * 40_000).toString(36)}`).join(" ");

/** Indexed text as measured across 7.8 million events of 1,317 real runner logs: 7.9% of events
 * index nothing, 82.5% under 100 characters (mostly streamed message deltas), 8.3% up to 1 KB,
 * 1.35% up to 4 KB and 0.022% more, to the 8 KB cap. Indexed text dominates a batch's cost. */
function event(sessionId: string, index: number): SessionEventPayload {
  const roll = random();
  if (index % 150 === 0) return { kind: "user_message", text: words(40) };
  if (roll < 0.079) {
    return random() < 0.5
      ? { kind: "token_usage", inputTokens: 1_000, outputTokens: 100 }
      : { kind: "file_edit", path: "", diff: `+ ${words(1_800)}` };
  }
  if (roll < 0.904) return { kind: "agent_message", text: ` ${words(2)}`, messageId: `${sessionId}-m-${Math.floor(index / 30)}` };
  if (roll < 0.987) {
    return random() < 0.5
      ? { kind: "tool_call_update", toolCallId: `${sessionId}-t-${index}`, status: "completed", text: words(25 + Math.floor(random() * 100)) } as SessionEventPayload
      : { kind: "agent_thought", text: words(20 + Math.floor(random() * 100)) };
  }
  if (roll < 0.99978) return { kind: "command_output", text: words(150 + Math.floor(random() * 400)) };
  return { kind: "command_output", text: words(1_200) };
}

try {
  const db = ControlPlaneDb.open(join(root, "control-plane.db"));
  db.registerRunner({
    runnerId: "runner-benchmark", hostname: "benchmark", os: "linux", version: "benchmark",
    workspaces: [{ id: "workspace-1", name: "Workspace", path: root }],
    agents: [{ id: "agent-1", name: "Agent", command: "agent", args: [], env: {}, driver: "claude-code",
      available: true, context: { kind: "native" } }],
  }, Date.now(), PROTOCOL_VERSION);
  const archivedAt = Date.now() - 400 * DAY;
  for (let session = 0; session < SESSIONS; session += 1) {
    const id = `session-${session}`;
    db.createSession({ id, runnerId: "runner-benchmark", workspaceId: "workspace-1", agentId: "agent-1",
      title: id, useWorktree: false, driver: "claude-code", config: {}, now: archivedAt - DAY });
    for (let index = 0; index < EVENTS_PER_SESSION; index += 1) {
      const original = event(id, index);
      const externalized = externalizeSessionEventPayload(db, id, original, archivedAt - DAY + index);
      db.appendEvent(id, externalized.payload, archivedAt - DAY + index, {
        runnerSeq: index + 1, historyEpoch: 1, searchPayload: original, artifactIds: [...externalized.artifactIds],
      });
    }
    db.updateSessionStatus(id, "completed", archivedAt);
    db.setSessionArchived(id, true, archivedAt);
  }

  let now = Date.now();
  const retention = new ArchivedHistoryRetention(db, { env: {}, log: { info() {}, warn() {} }, now: () => now });
  retention.update(PERSONAL_ORGANIZATION_ID, 90, "benchmark");
  now += 2 * DAY;
  const batches: number[] = [];
  const prune = db.pruneArchivedHistoryBatch.bind(db);
  db.pruneArchivedHistoryBatch = (sessionId, input) => {
    const startedAt = performance.now();
    const result = prune(sessionId, input);
    batches.push(performance.now() - startedAt);
    return result;
  };
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const startedAt = performance.now();
  const pass = await retention.runPass();
  const elapsedMs = performance.now() - startedAt;
  loop.disable();
  db.close();

  batches.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number(batches[Math.min(batches.length - 1, Math.floor(batches.length * fraction))]!.toFixed(2));
  const busyMs = batches.reduce((sum, value) => sum + value, 0);
  const p95Ms = percentile(0.95);
  console.log(JSON.stringify({
    directory: values.dir ?? tmpdir(),
    sessions: pass.sessions,
    eventsPruned: pass.events,
    batches: batches.length,
    batchP50Ms: percentile(0.5),
    batchP95Ms: p95Ms,
    batchMaxMs: percentile(1),
    eventLoopDelayP99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)),
    dutyCycle: Number((busyMs / elapsedMs).toFixed(3)),
    eventsPerSecond: Math.round(pass.events / (elapsedMs / 1000)),
    maxBatchP95Ms: MAX_BATCH_P95_MS,
  }));
  assert.equal(pass.sessions, SESSIONS);
  assert.ok(p95Ms < MAX_BATCH_P95_MS,
    `prune batch p95 was ${p95Ms}ms (limit ${MAX_BATCH_P95_MS}ms); is a batch removing too much indexed text?`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
