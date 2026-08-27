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
    runnerDataDir: null,
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
  assert.equal(c?.runnerDataDir, null);
  assert.equal(c?.pendingLegacyDataAdoptionEpoch, null);
  assert.equal(c?.legacyDataAdoptionEpoch, null);
  assert.equal(db.getBox("box-1")?.runnerDataLayout, "legacy");
});

test("pre-PR box schemas migrate before account-ledger backfill when empty or populated", () => {
  for (const populated of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-box-pre-pr-${populated ? "populated" : "empty"}-`));
    const path = join(root, "control-plane.db");
    let db: ControlPlaneDb | undefined;
    try {
      db = ControlPlaneDb.open(path);
      if (populated) db.createBox(box({ autoReconnect: false }));
      db.close();
      db = undefined;

      const legacy = new DatabaseSync(path);
      legacy.exec("DROP TABLE legacy_ssh_account_adoptions");
      for (const column of [
        "runner_data_dir",
        "legacy_adoption_epoch",
        "legacy_adoption_pending",
        "legacy_adoption_authorized_by",
        "legacy_adoption_authorized_role",
        "legacy_adoption_authorized_at",
        "legacy_adoption_completed_at",
      ]) {
        legacy.exec(`ALTER TABLE boxes DROP COLUMN ${column}`);
      }
      legacy.close();

      db = ControlPlaneDb.open(path);
      const columns = new Set(
        (db.raw().prepare("PRAGMA table_info(boxes)").all() as Array<{ name: string }>).map((row) => row.name),
      );
      assert.ok(columns.has("runner_data_dir"));
      assert.ok(columns.has("legacy_adoption_epoch"));
      assert.equal(
        Number((db.raw().prepare("SELECT COUNT(*) AS count FROM legacy_ssh_account_adoptions").get() as { count: number }).count),
        0,
      );
      assert.equal(Boolean(db.getBox("box-1")), populated);
    } finally {
      db?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("new managed data roots and legacy adoption authorization survive restart with stale-safe completion", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-box-data-adoption-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.createBox(box({
      boxId: "box-new",
      runnerId: "box-new",
      runnerDataDir: ".agent-manager/runner-data/box-new",
    }));
    assert.equal(db.getBoxConfig("box-new")?.runnerDataDir, ".agent-manager/runner-data/box-new");
    assert.equal(db.getBox("box-new")?.runnerDataLayout, "isolated-v1");
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-new",
      epoch: "adopt-not-allowed",
      authorizedBy: "user-owner",
      authorizedRole: "owner",
      now: 1100,
    }), false, "isolated roots never accept legacy adoption authorization");

    db.createBox(box({ boxId: "box-legacy", runnerId: "box-legacy", runnerDataDir: null }));
    db.createBox(box({ boxId: "box-legacy-sibling", runnerId: "box-legacy-sibling", runnerDataDir: null }));
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-legacy",
      epoch: "adopt-epoch-one",
      authorizedBy: "user-admin",
      authorizedRole: "admin",
      now: 1200,
    }), true);
    assert.equal(db.getBoxConfig("box-legacy")?.pendingLegacyDataAdoptionEpoch, "adopt-epoch-one");
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-legacy",
      epoch: "adopt-replay",
      authorizedBy: "user-owner",
      authorizedRole: "owner",
      now: 1250,
    }), false, "pending authorization is create-once and its audit cannot be overwritten");
    assert.deepEqual(db.getBox("box-legacy")?.legacyDataAdoption, {
      status: "pending",
      authorizedAt: 1200,
    });
    assert.equal(db.getBox("box-legacy")?.legacyDataAccountStatus, "pending");
    assert.equal(db.getBox("box-legacy-sibling")?.legacyDataAccountStatus, "pending");
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.getBoxConfig("box-legacy")?.pendingLegacyDataAdoptionEpoch, "adopt-epoch-one");
    assert.equal(db.completeBoxLegacyDataAdoption("box-legacy", "stale-epoch", 1300), false);
    assert.equal(db.getBoxConfig("box-legacy")?.pendingLegacyDataAdoptionEpoch, "adopt-epoch-one");
    assert.equal(db.completeBoxLegacyDataAdoption("box-legacy", "adopt-epoch-one", 1400), true);
    assert.equal(db.getBoxConfig("box-legacy")?.pendingLegacyDataAdoptionEpoch, null);
    assert.equal(db.getBoxConfig("box-legacy")?.legacyDataAdoptionEpoch, "adopt-epoch-one");
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-legacy",
      epoch: "adopt-after-completion",
      authorizedBy: "user-owner",
      authorizedRole: "owner",
      now: 1500,
    }), false, "completed audit is retained and cannot be replaced");
    assert.deepEqual(db.getBox("box-legacy")?.legacyDataAdoption, {
      status: "completed",
      authorizedAt: 1200,
      completedAt: 1400,
    });
    assert.equal(db.getBox("box-legacy")?.legacyDataAccountStatus, "adopted");
    assert.equal(db.getBox("box-legacy-sibling")?.legacyDataAccountStatus, "adopted");
    const audit = db.raw().prepare(
      `SELECT legacy_adoption_epoch, legacy_adoption_authorized_by, legacy_adoption_authorized_role,
              legacy_adoption_authorized_at, legacy_adoption_completed_at
         FROM boxes WHERE box_id='box-legacy'`,
    ).get() as Record<string, unknown>;
    assert.deepEqual({ ...audit }, {
      legacy_adoption_epoch: "adopt-epoch-one",
      legacy_adoption_authorized_by: "user-admin",
      legacy_adoption_authorized_role: "admin",
      legacy_adoption_authorized_at: 1200,
      legacy_adoption_completed_at: 1400,
    });
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("account adoption audit survives completed-adopter deletion and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-box-account-adoption-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.createBox(box({ boxId: "box-adopter", runnerId: "runner-adopter", autoReconnect: false }));
    db.createBox(box({ boxId: "box-sibling", runnerId: "runner-sibling", autoReconnect: false }));
    db.createBox(box({
      boxId: "box-other-port",
      runnerId: "runner-other-port",
      sshPort: 2222,
      autoReconnect: false,
    }));
    db.createBox(box({
      boxId: "box-other-target",
      runnerId: "runner-other-target",
      sshTarget: "other@devbox",
      autoReconnect: false,
    }));
    db.setBoxDeployedVersion("box-adopter", "a1b2c3d4e5f60718", 10);
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-adopter",
      epoch: "adopt-account",
      authorizedBy: "user-owner",
      authorizedRole: "owner",
      now: 11,
    }), true);
    assert.equal(db.completeBoxLegacyDataAdoption(
      "box-adopter",
      "adopt-account",
      12,
      "rcred_0123456789abcdef0123456789abcdef",
      "ab".repeat(32),
    ), true);
    const proof = db.raw().prepare(
      `SELECT status, adopter_box_id, completed_credential_id, completed_binary_identity
         FROM legacy_ssh_account_adoptions WHERE ssh_target='me@devbox' AND ssh_port=22`,
    ).get() as Record<string, unknown>;
    assert.deepEqual({ ...proof }, {
      status: "completed",
      adopter_box_id: "box-adopter",
      completed_credential_id: "rcred_0123456789abcdef0123456789abcdef",
      completed_binary_identity: "ab".repeat(32),
    });
    assert.equal(db.getBox("box-sibling")?.legacyDataAccountStatus, "adopted");
    assert.equal(db.getBox("box-other-port")?.legacyDataAccountStatus, "unclaimed");
    assert.equal(db.getBox("box-other-target")?.legacyDataAccountStatus, "unclaimed");
    assert.ok(db.deleteBox("box-adopter"));
    assert.equal(db.getBox("box-sibling")?.legacyDataAccountStatus, "adopted");
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.getBoxConfig("box-sibling")?.legacyDataAccountStatus, "adopted");
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-sibling",
      epoch: "adopt-again",
      authorizedBy: "user-owner",
      authorizedRole: "owner",
      now: 13,
    }), false, "a surviving sibling can never recreate account adoption authority");
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending account adoption blocks adopter deletion and old box mirrors backfill the account ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-box-account-backfill-"));
  const path = join(root, "control-plane.db");
  let db: ControlPlaneDb | undefined;
  try {
    db = ControlPlaneDb.open(path);
    db.createBox(box({ boxId: "box-pending", runnerId: "runner-pending", autoReconnect: false }));
    assert.equal(db.authorizeBoxLegacyDataAdoption({
      boxId: "box-pending",
      epoch: "adopt-pending",
      authorizedBy: "user-admin",
      authorizedRole: "admin",
      now: 20,
    }), true);
    assert.throws(() => db?.deleteBox("box-pending"), /cannot delete.*adoption is pending/);
    db.registerRunner({
      runnerId: "runner-pending",
      hostname: "devbox",
      os: "linux",
      version: "1.0.0",
      workspaces: [],
      agents: [],
    }, 21);
    assert.throws(() => db?.deleteRunner("runner-pending"), /cannot delete.*adoption is pending/);
    assert.ok(db.getBox("box-pending"));

    db.raw().prepare("DELETE FROM legacy_ssh_account_adoptions").run();
    assert.equal(db.boxHasPendingLegacyDataAdoption("box-pending"), false);
    db.close();
    db = ControlPlaneDb.open(path);
    assert.equal(db.boxHasPendingLegacyDataAdoption("box-pending"), true);
    assert.equal(db.getBox("box-pending")?.legacyDataAccountStatus, "pending");
    assert.equal(db.getBoxConfig("box-pending")?.pendingLegacyDataAdoptionEpoch, "adopt-pending");
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
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
  db.raw().prepare(
    "INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("org-delete-box", "Delete Box", 1, 1);
  db.setSessionNamingPreference("org-delete-box", "session_agent_account", 1);
  db.setSessionNamingHarnessTarget("org-delete-box", {
    runnerId: "box-runner-1", agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low",
  }, 1);
  const res = db.deleteBox("box-1");
  assert.deepEqual(res, { runnerId: "box-runner-1", sessionIds: [], runIds: [], podIds: [] });
  assert.equal(db.getBox("box-1"), null);
  assert.equal(db.getSessionNamingHarnessTarget("org-delete-box"), null);
  assert.equal(db.getSessionNamingPreference("org-delete-box")?.mode, "prompt_text_only",
    "deleting the selected Machine cannot silently restore per-session provider or billing selection");
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
  db.raw().prepare(
    "INSERT INTO identity_organizations (organization_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("org-delete-runner", "Delete Runner", 1, 1);
  db.setSessionNamingPreference("org-delete-runner", "session_agent_account", 1);
  db.setSessionNamingHarnessTarget("org-delete-runner", {
    runnerId: "stale-1", agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low",
  }, 1);
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
  assert.equal(db.getSessionNamingHarnessTarget("org-delete-runner"), null);
  assert.equal(db.getSessionNamingPreference("org-delete-runner")?.mode, "prompt_text_only",
    "deleting the selected Machine cannot silently restore per-session provider or billing selection");
  assert.deepEqual(db.getPod("pod-1")?.members, []);
  assert.equal(db.reconcilePodAfterMembershipLoss("pod-1", 1003)?.status, "closed");
  assert.equal(db.deleteRunner("stale-1"), null); // already gone
});

test("deleteRunner rolls back naming fallback when target cleanup fails", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner({
    runnerId: "atomic-runner",
    hostname: "atomic-host",
    os: "linux",
    version: "test",
    workspaces: [],
    agents: [],
  }, 1);
  db.configureSessionNamingHarnessTarget("org_personal", {
    runnerId: "atomic-runner",
    agentId: "codex-app-server",
    driver: "codex-app-server",
    context: { kind: "native" },
    provider: "codex",
    billingSource: "provider_account",
    model: "luna",
    effort: "low",
  }, 2);
  const target = db.getSessionNamingHarnessTarget("org_personal");
  const preference = db.getSessionNamingPreference("org_personal");
  db.raw().exec(`
    CREATE TRIGGER reject_session_naming_target_delete
    BEFORE DELETE ON session_naming_harness_targets
    BEGIN
      SELECT RAISE(ABORT, 'forced target cleanup failure');
    END;
  `);

  assert.throws(() => db.deleteRunner("atomic-runner"), /forced target cleanup failure/);
  assert.ok(db.getRunner("atomic-runner"), "runner deletion rolls back with naming cleanup");
  assert.deepEqual(db.getSessionNamingHarnessTarget("org_personal"), target);
  assert.deepEqual(db.getSessionNamingPreference("org_personal"), preference,
    "prompt fallback and target deletion are one transaction");
  db.close();
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
