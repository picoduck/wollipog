// Measures the per-event commit cost of the control plane's hottest write: one appendEvent per
// streamed runner event, which commits without a per-commit WAL flush. Run it on the disk that holds the real database (`--dir <path>`): a tmpfs
// temporary directory makes every fsync free and hides the regression this guards against.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ControlPlaneDb } from "../src/db.js";

const SESSIONS = 10;
const WARMUP_EVENTS = 200;
const MEASURED_EVENTS = 2_000;
// On a local NVMe SSD a runner event append measured 0.07 ms; flushing every commit, 5.1 ms.
const MAX_P50_MS = 1;

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const root = mkdtempSync(join(values.dir ?? tmpdir(), "wollipog-event-ingest-benchmark-"));

try {
  const db = ControlPlaneDb.open(join(root, "control-plane.db"));
  db.registerRunner({
    runnerId: "runner-benchmark",
    hostname: "benchmark",
    os: "linux",
    version: "benchmark",
    workspaces: [{ id: "workspace-1", name: "Workspace", path: root }],
    agents: [{
      id: "agent-1", name: "Agent", command: "agent", args: [], env: {},
      driver: "claude-code", available: true, context: { kind: "native" },
    }],
  }, Date.now(), PROTOCOL_VERSION);
  const sessionIds = Array.from({ length: SESSIONS }, (_, index) => `session-${index}`);
  for (const id of sessionIds) {
    db.createSession({
      id, runnerId: "runner-benchmark", workspaceId: "workspace-1", agentId: "agent-1",
      title: id, useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
    });
  }

  const runnerSeq = new Map<string, number>();
  const append = (index: number): number => {
    const sessionId = sessionIds[index % SESSIONS]!;
    const seq = (runnerSeq.get(sessionId) ?? 0) + 1;
    runnerSeq.set(sessionId, seq);
    const startedAt = performance.now();
    db.appendEvent(sessionId, {
      kind: "agent_message", messageId: `message-${sessionId}`, text: `streamed chunk ${index} `,
    }, Date.now(), { runnerSeq: seq, historyEpoch: null, accrueUsage: true });
    return performance.now() - startedAt;
  };
  for (let index = 0; index < WARMUP_EVENTS; index++) append(index);
  const latencies: number[] = [];
  const measuredAt = performance.now();
  for (let index = WARMUP_EVENTS; index < WARMUP_EVENTS + MEASURED_EVENTS; index++) {
    latencies.push(append(index));
  }
  const elapsedMs = performance.now() - measuredAt;
  db.close();

  latencies.sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    Number(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))]!.toFixed(3));
  const p50Ms = percentile(0.5);
  console.log(JSON.stringify({
    directory: values.dir ?? tmpdir(),
    sessions: SESSIONS,
    events: MEASURED_EVENTS,
    eventsPerSecond: Math.round(MEASURED_EVENTS / (elapsedMs / 1000)),
    p50Ms,
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxP50Ms: MAX_P50_MS,
  }));
  assert.ok(p50Ms < MAX_P50_MS,
    `appendEvent p50 was ${p50Ms}ms (limit ${MAX_P50_MS}ms); is every commit flushing to disk again?`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
