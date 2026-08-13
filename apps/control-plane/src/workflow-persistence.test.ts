import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hub } from "./hub.js";
import { ControlPlaneDb } from "./db.js";
import { SessionsService } from "./sessions.js";
import { BUILD_REVIEW_WORKFLOW } from "./workflow-graphs.js";

const actor = { kind: "human" as const, id: "device-1" };

function seedRun(db: ControlPlaneDb, id = "run-1"): void {
  db.createRun({ id, title: "Workflow run", prompt: "build it", workspaceId: null, runnerId: null, now: 100 });
}

test("workflow definitions version immutably and instances persist initial graph state", () => {
  const db = ControlPlaneDb.open(":memory:");
  seedRun(db);
  const v1 = db.createWorkflowDefinition({ workflowId: "wf-1", ...BUILD_REVIEW_WORKFLOW, source: "custom", createdBy: actor, createdAt: 101 });
  const v2 = db.createWorkflowDefinition({ workflowId: "wf-1", ...BUILD_REVIEW_WORKFLOW, name: "Build-review v2", source: "custom", createdBy: actor, createdAt: 102 });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal(db.getWorkflowDefinition("wf-1", 1)?.name, BUILD_REVIEW_WORKFLOW.name);
  assert.deepEqual(db.listWorkflowDefinitions().map((definition) => [definition.workflowId, definition.version]), [["wf-1", 2]]);

  const instance = db.createWorkflowInstance({ instanceId: "instance-1", definition: v1, runId: "run-1", createdBy: actor, now: 103 });
  assert.equal(instance.workflowVersion, 1);
  assert.deepEqual(instance.nodeStates.map((node) => [node.nodeId, node.status]), [
    ["build", "ready"], ["review", "pending"], ["address", "pending"],
  ]);
  assert.deepEqual(instance.events.map((event) => [event.seq, event.kind]), [[1, "instance_created"]]);
  assert.ok(db.getRun("run-1")!.updatedAt > 100);

  db.createWorkflowAttempt({ attemptId: "attempt-1", instanceId: "instance-1", nodeId: "build", attempt: 1, status: "running", dispatchKey: "instance-1:build:1", startedAt: 104, deadlineAt: 1_104 });
  const event = db.appendWorkflowEvent({ instanceId: "instance-1", kind: "attempt_started", nodeId: "build", attemptId: "attempt-1", actor: { kind: "system", id: "scheduler" }, createdAt: 104 });
  assert.equal(event.seq, 2);
  assert.equal(db.getWorkflowInstance("instance-1")!.attempts[0]?.dispatchKey, "instance-1:build:1");
  assert.deepEqual(db.getWorkflowInstance("instance-1")!.events.map((item) => item.seq), [1, 2]);
  assert.throws(() => db.createWorkflowAttempt({ attemptId: "attempt-duplicate", instanceId: "instance-1", nodeId: "build", attempt: 2, status: "running", dispatchKey: "instance-1:build:1", startedAt: 105, deadlineAt: 1_105 }), /UNIQUE/);
  db.close();
});

test("workflow service validates custom definitions, exposes the built-in template, and binds instances to runs", () => {
  const db = ControlPlaneDb.open(":memory:");
  seedRun(db);
  const hub = { runChanged() {} } as unknown as Hub;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const builtins = svc.workflowDefinitions();
  assert.equal(builtins.ok && builtins.data.find((definition) => definition.workflowId === "builtin:build-review")?.source, "builtin");

  const malformed = svc.createWorkflowDefinition({ ...BUILD_REVIEW_WORKFLOW, maxTransitions: 0 }, actor);
  assert.deepEqual([malformed.status, malformed.ok], [400, false]);
  const custom = svc.createWorkflowDefinition({ ...BUILD_REVIEW_WORKFLOW, name: "Custom review" }, actor);
  assert.equal(custom.ok, true);
  if (!custom.ok) throw new Error(custom.error);
  const created = svc.createWorkflowInstance({ workflowId: custom.data.workflowId, workflowVersion: 1, runId: "run-1" }, actor);
  assert.equal(created.status, 201);
  assert.equal(created.ok && created.data.createdBy.id, "device-1");
  const versioned = svc.createWorkflowDefinitionVersion(custom.data.workflowId, {
    ...BUILD_REVIEW_WORKFLOW,
    name: "Custom review v2",
  }, actor);
  assert.equal(versioned.status, 201);
  assert.equal(versioned.ok && versioned.data.version, 2);
  assert.equal(svc.workflowDefinition(custom.data.workflowId, 1).data?.name, "Custom review");
  assert.equal(svc.createWorkflowDefinitionVersion("builtin:build-review", BUILD_REVIEW_WORKFLOW, actor).status, 409);
  assert.equal(svc.createWorkflowDefinitionVersion("missing", BUILD_REVIEW_WORKFLOW, actor).status, 404);
  assert.equal(svc.createWorkflowInstance({ workflowId: custom.data.workflowId, runId: "missing" }, actor).status, 404);
  assert.equal(svc.createWorkflowInstance({ workflowId: custom.data.workflowId, runId: "run-1", extra: true }, actor).status, 400);
  assert.equal(svc.workflowInstances("run-1").ok, true);
  assert.equal(svc.workflowInstances(undefined, 101).status, 400);
  db.close();
});

test("Phase 7.2 workflow databases gain execution columns additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-workflow-migration-"));
  const path = join(dir, "control-plane.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE workflow_node_states (
      instance_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, session_id TEXT, started_at INTEGER,
      completed_at INTEGER, error TEXT, PRIMARY KEY (instance_id, node_id)
    );
    CREATE TABLE workflow_attempts (
      attempt_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, status TEXT NOT NULL, dispatch_key TEXT NOT NULL UNIQUE,
      session_id TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, error TEXT,
      UNIQUE (instance_id, node_id, attempt)
    );
  `);
  legacy.close();
  const db = ControlPlaneDb.open(path);
  const nodeColumns = new Set((db.raw().prepare("PRAGMA table_info(workflow_node_states)").all() as unknown as Array<{ name: string }>).map((column) => column.name));
  const attemptColumns = new Set((db.raw().prepare("PRAGMA table_info(workflow_attempts)").all() as unknown as Array<{ name: string }>).map((column) => column.name));
  assert.equal(nodeColumns.has("ready_at"), true);
  assert.equal(nodeColumns.has("outcome"), true);
  assert.equal(attemptColumns.has("deadline_at"), true);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
