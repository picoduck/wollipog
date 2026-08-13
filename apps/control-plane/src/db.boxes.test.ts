import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ControlPlaneDb, type NewBoxInput } from "./db.js";

function box(overrides: Partial<NewBoxInput> = {}): NewBoxInput {
  return {
    boxId: "box-1",
    runnerId: "box-runner-1",
    sshTarget: "me@devbox",
    sshPort: 22,
    workspaces: [{ id: "repo", name: "repo", path: "/home/me/repo" }],
    autoReconnect: true,
    now: 1000,
    ...overrides,
  };
}

test("createBox → getBox/listBoxes returns a bootstrapping box", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  const v = db.getBox("box-1");
  assert.ok(v);
  assert.equal(v?.sshTarget, "me@devbox");
  assert.equal(v?.runnerId, "box-runner-1");
  assert.equal(v?.status, "bootstrapping");
  assert.equal(v?.lastError, null);
  assert.deepEqual(
    db.listBoxes().map((b) => b.boxId),
    ["box-1"],
  );
});

test("getBoxConfig returns ssh details + parsed workspaces", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  const c = db.getBoxConfig("box-1");
  assert.equal(c?.sshPort, 22);
  assert.equal(c?.autoReconnect, true);
  assert.deepEqual(c?.workspaces, [{ id: "repo", name: "repo", path: "/home/me/repo" }]);
  assert.equal(c?.deployedVersion, null);
});

test("setBoxStatus + setBoxDeployedVersion update the row", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  db.setBoxStatus("box-1", "failed", 2000, "ssh: connection refused");
  const v = db.getBox("box-1");
  assert.equal(v?.status, "failed");
  assert.equal(v?.lastError, "ssh: connection refused");
  db.setBoxDeployedVersion("box-1", "0.4.2", 2001);
  assert.equal(db.getBoxConfig("box-1")?.deployedVersion, "0.4.2");
});

test("setBoxTriple persists and surfaces in both the config and the view", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  assert.equal(db.getBoxConfig("box-1")?.triple, null); // pre-detection
  assert.equal(db.getBox("box-1")?.triple, null);
  db.setBoxTriple("box-1", "aarch64-unknown-linux-gnu", 2000);
  assert.equal(db.getBoxConfig("box-1")?.triple, "aarch64-unknown-linux-gnu");
  const v = db.getBox("box-1");
  assert.equal(v?.triple, "aarch64-unknown-linux-gnu");
  // deployedVersion rides along on the view for the Runners card.
  db.setBoxDeployedVersion("box-1", "19682533cae6a50a", 2001);
  assert.equal(db.getBox("box-1")?.deployedVersion, "19682533cae6a50a");
});

test("boxIdForRunner correlates a registered runner back to its box", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  assert.equal(db.boxIdForRunner("box-runner-1"), "box-1");
  assert.equal(db.boxIdForRunner("nope"), null);
});

test("deleteBox removes the box (and its runner row) and returns the runnerId", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  const res = db.deleteBox("box-1");
  assert.deepEqual(res, { runnerId: "box-runner-1", sessionIds: [], runIds: [], podIds: [] });
  assert.equal(db.getBox("box-1"), null);
  assert.equal(db.deleteBox("box-1"), null); // already gone
});

test("legacy artifact migration preserves workflow artifact associations and box removal", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-box-artifact-migration-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    // Start from the complete current schema, then reproduce the data-bearing prerelease artifact
    // shape that caused SQLite to retarget workflow_attempt_artifacts during the table rename.
    ControlPlaneDb.open(path).close();
    const legacy = new DatabaseSync(path);
    legacy.exec(
      `PRAGMA foreign_keys=OFF;
       DROP TABLE workflow_attempt_artifacts;
       DROP TABLE artifacts;
       CREATE TABLE artifacts (
         id TEXT PRIMARY KEY,
         session_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         path TEXT,
         data TEXT,
         created_at INTEGER NOT NULL
       );
       CREATE TABLE workflow_attempt_artifacts (
         attempt_id TEXT NOT NULL,
         contract_name TEXT NOT NULL,
         artifact_id TEXT NOT NULL,
         PRIMARY KEY (attempt_id, contract_name),
         FOREIGN KEY (attempt_id) REFERENCES workflow_attempts(attempt_id) ON DELETE CASCADE,
         FOREIGN KEY (artifact_id) REFERENCES artifacts(id)
       );
       INSERT INTO multi_agent_runs (id, title, prompt, created_at, updated_at)
         VALUES ('run-legacy', 'Legacy Run', '', 1, 1);
       INSERT INTO workflow_definitions
         (workflow_id, version, name, max_transitions, graph, source, created_by_kind, created_at)
         VALUES ('workflow-legacy', 1, 'Legacy Workflow', 10, '{}', 'manual', 'human', 1);
       INSERT INTO workflow_instances
         (instance_id, workflow_id, workflow_version, run_id, status, transition_count,
          created_by_kind, created_at, updated_at)
         VALUES ('instance-legacy', 'workflow-legacy', 1, 'run-legacy', 'running', 0, 'human', 1, 1);
       INSERT INTO workflow_node_states (instance_id, node_id, status, attempt_count)
         VALUES ('instance-legacy', 'node-legacy', 'running', 1);
       INSERT INTO workflow_attempts
         (attempt_id, instance_id, node_id, attempt, status, dispatch_key, started_at, deadline_at)
         VALUES ('attempt-legacy', 'instance-legacy', 'node-legacy', 1, 'running', 'dispatch-legacy', 1, 2);
       INSERT INTO artifacts (id, session_id, kind, path, data, created_at)
         VALUES ('artifact-legacy', 'session-legacy', 'test_log', 'legacy.log', 'preserved', 1);
       INSERT INTO workflow_attempt_artifacts (attempt_id, contract_name, artifact_id)
         VALUES ('attempt-legacy', 'output', 'artifact-legacy');`,
    );
    legacy.close();

    db = ControlPlaneDb.open(path);
    db.createBox(box());
    const artifactForeignKey = db.raw().prepare(
      "SELECT \"table\" AS parent FROM pragma_foreign_key_list('workflow_attempt_artifacts') WHERE \"from\"='artifact_id'",
    ).get() as { parent: string };
    assert.equal(artifactForeignKey.parent, "artifacts");
    const steeringArtifactForeignKey = db.raw().prepare(
      "SELECT \"table\" AS parent FROM pragma_foreign_key_list('session_steering_attempt_artifacts') WHERE \"from\"='artifact_id'",
    ).get() as { parent: string };
    assert.equal(steeringArtifactForeignKey.parent, "artifacts");
    const eventArtifactForeignKey = db.raw().prepare(
      "SELECT \"table\" AS parent FROM pragma_foreign_key_list('session_event_artifacts') WHERE \"from\"='artifact_id'",
    ).get() as { parent: string };
    assert.equal(eventArtifactForeignKey.parent, "artifacts");
    const eventArtifactPrimaryKey = db.raw().prepare(
      "SELECT name,pk FROM pragma_table_info('session_event_artifacts') WHERE name IN ('event_id','artifact_id') ORDER BY pk",
    ).all() as unknown as Array<{ name: string; pk: number }>;
    assert.deepEqual(eventArtifactPrimaryKey.map((column) => ({ ...column })), [
      { name: "event_id", pk: 1 },
      { name: "artifact_id", pk: 2 },
    ]);
    const association = db.raw().prepare(
      "SELECT attempt_id, contract_name, artifact_id FROM workflow_attempt_artifacts",
    ).get() as { attempt_id: string; contract_name: string; artifact_id: string };
    assert.deepEqual({ ...association }, {
      attempt_id: "attempt-legacy",
      contract_name: "output",
      artifact_id: "artifact-legacy",
    });
    assert.deepEqual(db.raw().prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(db.deleteBox("box-1"), {
      runnerId: "box-runner-1",
      sessionIds: [],
      runIds: [],
      podIds: [],
    });
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("deleteRunner drops a stale runner + its sessions, returns null when already gone", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(
    {
      runnerId: "stale-1",
      hostname: "h",
      os: "windows",
      version: "0.4.0",
      workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
      agents: [{ id: "a", name: "A", command: "x", args: [], env: {}, driver: "acp", context: { kind: "native" } }],
    },
    1000,
  );
  db.createSession({
    id: "s1",
    runnerId: "stale-1",
    workspaceId: "w",
    agentId: "a",
    title: "t",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: 1000,
  });
  db.createSession({
    id: "s2", runnerId: "stale-1", workspaceId: "w", agentId: "a", title: "t2",
    useWorktree: false, driver: "acp", config: {}, now: 1001,
  });
  db.createPod({ id: "pod-1", title: "Pod", objective: "", sessionIds: ["s1", "s2"], now: 1002 });
  assert.deepEqual(db.deleteRunner("stale-1"), { sessionIds: ["s1", "s2"], runIds: [], podIds: ["pod-1"] });
  assert.equal(db.getSession("s1"), null); // its sessions go with it
  assert.deepEqual(db.getPod("pod-1")?.members, []);
  assert.equal(db.reconcilePodAfterMembershipLoss("pod-1", 1003)?.status, "closed");
  assert.equal(db.deleteRunner("stale-1"), null); // already gone
});

test("deleteRunner on a box-owned runner would also drop its box row — so the runner DELETE route guards on boxIdForRunner", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  // The box's runner has connected and registered (this is when DELETE /api/runners/:id becomes a
  // hazard — deleteRunner only acts once a runners row exists).
  db.registerRunner(
    {
      runnerId: "box-runner-1",
      hostname: "devbox",
      os: "linux",
      version: "0.6.0",
      workspaces: [{ id: "repo", name: "repo", path: "/home/me/repo" }],
      agents: [],
    },
    1000,
  );
  // boxIdForRunner flags this runner as box-owned; the /api/runners/:id route uses it to reject the
  // call and require /api/boxes/:id (which also signals the orchestrator + UIs). Reaching deleteRunner
  // directly here shows why: it silently removes the box row with no box_removed/orchestrator signal.
  assert.equal(db.boxIdForRunner("box-runner-1"), "box-1");
  db.deleteRunner("box-runner-1");
  assert.equal(db.getBox("box-1"), null); // box row is gone, but nothing told the orchestrator/UI
});

test("listBoxConfigs returns every box for orchestrator rehydrate", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox(box());
  db.createBox(box({ boxId: "box-2", runnerId: "box-runner-2", autoReconnect: false }));
  const cfgs = db.listBoxConfigs();
  assert.deepEqual(
    cfgs.map((c) => [c.boxId, c.autoReconnect]),
    [
      ["box-1", true],
      ["box-2", false],
    ],
  );
});
