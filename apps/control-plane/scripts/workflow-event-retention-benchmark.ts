// Run on the database's disk with --dir <path>; tmpfs hides storage costs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { ControlPlaneDb } from "../src/db.js";
import { BUILD_REVIEW_WORKFLOW } from "../src/workflow-graphs.js";
import { WorkflowEventRetention } from "../src/workflow-event-retention.js";
import { WorkflowEventRetentionStore } from "../src/workflow-event-retention-store.js";

const { values } = parseArgs({ options: { dir: { type: "string" } } });
const root = mkdtempSync(join(values.dir ?? tmpdir(), "workflow-event-retention-benchmark-"));
const batches: number[] = [];
const prune = WorkflowEventRetentionStore.prototype.pruneBatch;
WorkflowEventRetentionStore.prototype.pruneBatch = function (...args) {
  const start = performance.now();
  const result = prune.apply(this, args);
  batches.push(performance.now() - start);
  return result;
};
try {
  const db = ControlPlaneDb.open(join(root, "control-plane.db"));
  try {
    let now = Date.now();
    const DAY = 86_400_000;
    db.registerRunner({ runnerId: "benchmark", hostname: "benchmark", os: "linux", version: "test", agents: [], workspaces: [] }, now);
    db.createRun({ id: "run", title: "Benchmark", prompt: "benchmark", runnerId: "benchmark", workspaceId: null, now });
    const actor = { kind: "system" as const };
    const definition = db.createWorkflowDefinition({ workflowId: "benchmark", ...BUILD_REVIEW_WORKFLOW, source: "custom", createdBy: actor, createdAt: now });
    for (let instance = 0; instance < 12; instance++) {
      const id = `instance-${instance}`;
      db.createWorkflowInstance({ instanceId: id, definition, runId: "run", createdBy: actor, now });
      db.raw().exec("BEGIN");
      const insert = db.raw().prepare("INSERT INTO workflow_events(instance_id,seq,kind,actor_kind,detail,created_at) VALUES(?,?,'node_status_changed','system',?,?)");
      for (let seq = 2; seq <= 2_000; seq++) insert.run(id, seq, JSON.stringify({ text: "x".repeat(seq % 100 === 0 ? 32_768 : 256) }), now);
      db.raw().prepare("UPDATE workflow_instances SET status='succeeded',completed_at=? WHERE instance_id=?").run(now - 400 * DAY, id);
      db.raw().exec("COMMIT");
    }
    const retention = new WorkflowEventRetention(db, { env: {}, now: () => now, log: { info() {}, warn() {} } });
    retention.update("org_personal", 90, "benchmark"); now += 2 * DAY;
    const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
    const started = performance.now(); const result = await retention.runPass(); const elapsed = performance.now() - started;
    loop.disable();
    batches.sort((a, b) => a - b);
    const percentile = (p: number) => Number(batches[Math.min(batches.length - 1, Math.floor(batches.length * p))]!.toFixed(2));
    console.log(JSON.stringify({ directory: values.dir ?? tmpdir(), instances: result.instances, eventsPruned: result.events,
      batches: batches.length, batchP50Ms: percentile(.5), batchP95Ms: percentile(.95), batchMaxMs: percentile(1),
      eventLoopDelayP99Ms: Number((loop.percentile(99) / 1e6).toFixed(2)),
      dutyCycle: Number((batches.reduce((a, b) => a + b, 0) / elapsed).toFixed(3)), maxBatchP95Ms: 16 }));
    assert.equal(result.events, 24_000); assert.equal(result.instances, 12);
    assert.ok(percentile(.95) < 16, "workflow event pruning batch p95 must stay below 16 ms");
  } finally { db.close(); }
} finally {
  WorkflowEventRetentionStore.prototype.pruneBatch = prune;
  rmSync(root, { recursive: true, force: true });
}
