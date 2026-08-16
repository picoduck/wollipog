import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb, type NewSessionInput } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

function runner(
  runnerId = "runner-1",
  workspaces: RunnerMetadata["workspaces"] = [
    { id: "ws-1", name: "Alpha", path: "/repos/alpha" },
  ],
): RunnerMetadata {
  return {
    runnerId,
    hostname: `${runnerId}-host`,
    os: "linux",
    version: "1.0.0",
    agents: [],
    workspaces,
  };
}

function session(
  id: string,
  runnerId: string,
  workspaceId: string | null,
  now = 100,
): NewSessionInput {
  return {
    id,
    runnerId,
    workspaceId,
    agentId: null,
    title: id,
    useWorktree: false,
    driver: "acp",
    config: {},
    now,
  };
}

test("pre-Project database migrates additively with exact ownership and reopen idempotence", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-project-backfill-"));
  const path = join(dir, "control-plane.db");
  try {
    // Bootstrap the unrelated contemporary schema, then remove the complete Project slice. This
    // keeps the fixture maintainable while making the database presented to the migration
    // genuinely pre-Project: no Project tables, ownership, marker, or session association columns.
    let db = ControlPlaneDb.open(path);
    db.registerRunner(runner("runner-1", [
      { id: "private", name: "Shared", path: "/repos/private" },
      { id: "organization", name: "Shared", path: "/repos/organization" },
    ]), 10);
    const identity = db.localIdentityContext();
    db.createIdentityMember({
      userId: "usr_migrated_workspace_owner",
      displayName: "Migrated Owner",
      organizationId: identity.organizationId,
      role: "operator",
      now: 11,
    });
    assert.equal(db.setResourceScope({
      resource: "workspace",
      runnerId: "runner-1",
      resourceId: "private",
      scope: {
        organizationId: identity.organizationId,
        owner: { kind: "user", userId: "usr_migrated_workspace_owner" },
      },
      now: 12,
    }), true);
    const privateScope = {
      organizationId: identity.organizationId,
      owner: { kind: "user" as const, userId: "usr_migrated_workspace_owner" },
    };
    db.createSession({ ...session("private-located", "runner-1", "private"), scope: privateScope });
    db.createSession(session("organization-located", "runner-1", "organization"));
    db.createSession({
      ...session("incompatible-owner", "runner-1", "private"),
      scope: {
        organizationId: identity.organizationId,
        owner: { kind: "organization", organizationId: identity.organizationId },
      },
    });
    db.createSession({ ...session("chat", "runner-1", null), scope: privateScope });
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys=OFF");
    const sessionsSql = (raw.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='sessions'",
    ).get() as unknown as { sql: string }).sql;
    const legacySessionsSql = sessionsSql
      .split("\n")
      .filter((line) => !/\bproject_(?:location_)?id\b/u.test(line))
      .join("\n")
      .replace(/^CREATE TABLE sessions\b/u, "CREATE TABLE sessions_legacy")
      .replace(/,\s*\n\)$/u, "\n)");
    const legacyColumns = (raw.prepare("PRAGMA table_info(sessions)").all() as unknown as
      Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => name !== "project_id" && name !== "project_location_id");
    const quotedColumns = legacyColumns.map((name) => `"${name}"`).join(", ");
    raw.exec(legacySessionsSql);
    raw.exec(`INSERT INTO sessions_legacy (${quotedColumns}) SELECT ${quotedColumns} FROM sessions`);
    raw.exec("DROP TABLE sessions");
    raw.exec("ALTER TABLE sessions_legacy RENAME TO sessions");
    raw.exec(`
      DROP TABLE project_ownership;
      DROP TABLE project_location_suppressions;
      DROP TABLE project_locations;
      DROP TABLE projects;
      DELETE FROM control_plane_metadata WHERE key='project_domain_v1_backfilled';
    `);
    const beforeTables = new Set((raw.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    const beforeSessionColumns = (raw.prepare(
      "PRAGMA table_info(sessions)",
    ).all() as unknown as Array<{ name: string }>).map((column) => column.name);
    raw.close();
    assert.equal(beforeTables.has("projects"), false);
    assert.equal(beforeTables.has("project_locations"), false);
    assert.equal(beforeTables.has("project_location_suppressions"), false);
    assert.equal(beforeTables.has("project_ownership"), false);
    assert.equal(
      beforeSessionColumns.some((name) => name === "project_id" || name === "project_location_id"),
      false,
    );

    db = ControlPlaneDb.open(path);
    const first = db.listProjects(true);
    assert.equal(first.length, 2);
    assert.equal(new Set(first.map((project) => project.id)).size, 2, "equal names never merge identity");
    assert.deepEqual(first.map((project) => project.name), ["Shared", "Shared"]);
    const privateProject = first.find((project) =>
      project.locations.some((location) => location.workspaceId === "private"))!;
    const organizationProject = first.find((project) =>
      project.locations.some((location) => location.workspaceId === "organization"))!;
    const privateLocation = privateProject.locations[0]!;
    const organizationLocation = organizationProject.locations[0]!;
    assert.deepEqual({
      runnerId: privateLocation.runnerId,
      workspaceId: privateLocation.workspaceId,
      name: privateLocation.name,
      path: privateLocation.path,
      source: privateLocation.source,
      isDefault: privateLocation.isDefault,
    }, {
      runnerId: "runner-1",
      workspaceId: "private",
      name: "Shared",
      path: "/repos/private",
      source: "reported",
      isDefault: true,
    });
    assert.deepEqual(db.projectScope(privateProject.id)?.owner, {
      kind: "user",
      userId: "usr_migrated_workspace_owner",
    }, "workspace ownership wins during backfill");
    assert.deepEqual(db.projectScope(organizationProject.id)?.owner, {
      kind: "organization",
      organizationId: identity.organizationId,
    });
    assert.deepEqual(db.sessionScope("private-located"), privateScope, "migration preserves session ownership");
    assert.deepEqual({
      projectId: db.getSession("private-located")?.projectId,
      projectLocationId: db.getSession("private-located")?.projectLocationId,
    }, {
      projectId: privateProject.id,
      projectLocationId: privateLocation.id,
    });
    assert.deepEqual({
      projectId: db.getSession("organization-located")?.projectId,
      projectLocationId: db.getSession("organization-located")?.projectLocationId,
    }, {
      projectId: organizationProject.id,
      projectLocationId: organizationLocation.id,
    });
    assert.equal(
      db.getSession("incompatible-owner")?.projectId,
      null,
      "a broader legacy session is not exposed through a private Project",
    );
    assert.equal(db.getSession("chat")?.projectId, null, "repo-less sessions remain No Project");
    const firstIds = {
      projects: first.map((project) => project.id).sort(),
      locations: first.flatMap((project) => project.locations.map((location) => location.id)).sort(),
    };
    db.close();

    const migrated = new DatabaseSync(path);
    const migratedTables = new Set((migrated.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    ).all() as unknown as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "projects",
      "project_locations",
      "project_location_suppressions",
      "project_ownership",
    ]) {
      assert.equal(migratedTables.has(table), true, `${table} is added`);
    }
    const migratedColumns = new Set((migrated.prepare("PRAGMA table_info(sessions)").all() as unknown as
      Array<{ name: string }>).map((column) => column.name));
    const migratedMarker = migrated.prepare(
      "SELECT value FROM control_plane_metadata WHERE key='project_domain_v1_backfilled'",
    ).get() as unknown as { value: string } | undefined;
    migrated.close();
    assert.equal(migratedColumns.has("project_id"), true);
    assert.equal(migratedColumns.has("project_location_id"), true);
    assert.equal(migratedMarker?.value, "1");

    db = ControlPlaneDb.open(path);
    const reopened = db.listProjects(true);
    assert.deepEqual({
      projects: reopened.map((project) => project.id).sort(),
      locations: reopened.flatMap((project) => project.locations.map((location) => location.id)).sort(),
    }, firstIds, "reopening neither duplicates nor replaces migrated identities");
    assert.deepEqual({
      projectId: db.getSession("private-located")?.projectId,
      projectLocationId: db.getSession("private-located")?.projectLocationId,
    }, {
      projectId: privateProject.id,
      projectLocationId: privateLocation.id,
    });
    assert.equal(db.getSession("chat")?.projectId, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopen replaces the legacy global Location uniqueness index without changing identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-shared-location-index-"));
  const path = join(dir, "control-plane.db");
  try {
    let db = ControlPlaneDb.open(path);
    db.registerRunner(runner(), 10);
    const original = db.listProjects(true)[0]!.locations[0]!;
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP INDEX IF EXISTS idx_project_locations_active_workspace;
      DROP INDEX IF EXISTS idx_project_locations_active_project_workspace;
      CREATE UNIQUE INDEX idx_project_locations_active_workspace
        ON project_locations(runner_id, workspace_id)
        WHERE detached_at IS NULL AND removed_at IS NULL;
    `);
    raw.close();

    db = ControlPlaneDb.open(path);
    const target = db.createProject({ name: "Target", now: 20 });
    const shared = db.addProjectLocation(target.id, {
      runnerId: original.runnerId,
      workspaceId: original.workspaceId,
    }, 21);
    assert.notEqual(shared.id, original.id);
    assert.equal(db.getProject(original.projectId)?.locations[0]?.id, original.id);

    const indexRows = db.raw().prepare("PRAGMA index_list(project_locations)").all() as unknown as
      Array<{ name: string; unique: number }>;
    assert.equal(indexRows.find((index) => index.name === "idx_project_locations_active_workspace")?.unique, 0);
    assert.equal(indexRows.find((index) => index.name === "idx_project_locations_active_project_workspace")?.unique, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zero-session Projects persist and hidden filtering is explicit", () => {
  const db = ControlPlaneDb.open(":memory:");
  const project = db.createProject({ name: "Empty", now: 10 });
  assert.equal(project.totalSessionCount, 0);
  assert.deepEqual(project.locations, []);
  assert.equal(db.listProjects().some((item) => item.id === project.id), true);
  assert.equal(db.setProjectHidden(project.id, true, 20)?.hidden, true);
  assert.equal(db.listProjects().some((item) => item.id === project.id), false);
  assert.equal(db.listProjects(true).some((item) => item.id === project.id), true);
  db.close();
});

test("offline and deleted runners retain locations without silently reviving detached identity", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  const location = project.locations[0]!;
  assert.equal(location.availability, "available");

  db.registerRunner(runner("runner-1", []), 15);
  assert.equal(db.getProject(project.id)?.locations[0]?.availability, "workspace_missing");
  db.registerRunner(runner(), 16);
  assert.equal(db.getProject(project.id)?.locations[0]?.availability, "available");

  db.markOffline("runner-1", 20);
  assert.equal(db.getProject(project.id)?.locations[0]?.availability, "runner_offline");

  assert.ok(db.deleteRunner("runner-1"));
  const retained = db.getProject(project.id)!;
  assert.equal(retained.locations[0]?.availability, "runner_removed");
  assert.equal(retained.locations[0]?.isDefault, false);
  assert.equal(db.findProjectLocation("runner-1", "ws-1"), null);

  const target = db.createProject({ name: "Target", now: 21 });
  const movedWhileMissing = db.moveProjectLocation(location.id, target.id, 22);
  assert.equal(movedWhileMissing?.availability, "runner_removed");
  assert.equal(movedWhileMissing?.isDefault, false, "a still-missing detached Location stays detached");
  const projectCount = db.listProjects(true).length;
  db.registerRunner(runner(), 30);
  assert.equal(db.listProjects(true).length, projectCount, "detached tombstone blocks discovery re-add");
  assert.equal(db.findProjectLocation("runner-1", "ws-1"), null);
  assert.equal(db.getProject(target.id)?.locations[0]?.availability, "runner_removed");
  assert.throws(() => db.createSession({
    ...session("stale-location", "runner-1", "ws-1", 40),
    projectId: target.id,
    projectLocationId: location.id,
  }), /no longer available/);
  db.close();
});

test("explicit Add Location creates independent Project links and reactivates stable links", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  const location = project.locations[0]!;

  assert.ok(db.deleteRunner("runner-1"));
  db.registerRunner(runner(), 20);
  const other = db.createProject({ name: "Other", now: 21 });
  const otherLink = db.addProjectLocation(other.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 22);
  assert.notEqual(otherLink.id, location.id, "each Project receives its own membership identity");
  assert.equal(otherLink.projectId, other.id);
  assert.equal(db.findProjectLocation("runner-1", "ws-1")?.id, otherLink.id);

  const relinked = db.addProjectLocation(project.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 23);
  assert.equal(relinked.id, location.id, "same-Project relink preserves stable Location identity");
  assert.equal(relinked.availability, "available");
  assert.equal(db.findProjectLocation("runner-1", "ws-1"), null, "legacy inference is ambiguous across Projects");
  assert.deepEqual(
    db.projectLocationsForWorkspace("runner-1", "ws-1").map((item) => item.id).sort(),
    [location.id, otherLink.id].sort(),
  );
  const refreshed = db.getProject(project.id)!;
  assert.equal(refreshed.locations.length, 1, "relink does not create a duplicate Location row");
  assert.equal(refreshed.locations[0]?.id, location.id);
  assert.equal(refreshed.locations[0]?.isDefault, true);
  db.close();
});

test("one physical Location supports sessions in multiple Projects and unlinking is Project-scoped", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(), 10);
  const alpha = db.listProjects(true)[0]!;
  const alphaLink = alpha.locations[0]!;
  const beta = db.createProject({ name: "Beta", now: 11 });
  const betaLink = db.addProjectLocation(beta.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 12);

  db.createSession({
    ...session("alpha-session", "runner-1", "ws-1", 20),
    projectId: alpha.id,
    projectLocationId: alphaLink.id,
  });
  db.createSession({
    ...session("beta-session", "runner-1", "ws-1", 21),
    projectId: beta.id,
    projectLocationId: betaLink.id,
  });
  assert.equal(db.getSession("alpha-session")?.projectLocationId, alphaLink.id);
  assert.equal(db.getSession("beta-session")?.projectLocationId, betaLink.id);

  db.removeProjectLocation(betaLink.id, 30);
  assert.equal(db.getProject(alpha.id)?.locations[0]?.id, alphaLink.id);
  assert.deepEqual(db.getProject(beta.id)?.locations, []);
  assert.equal(db.getSession("beta-session")?.projectId, beta.id);
  assert.equal(db.getSession("beta-session")?.projectLocationId, betaLink.id, "historical membership identity is retained");
  assert.equal(db.findProjectLocation("runner-1", "ws-1")?.id, alphaLink.id);

  db.createSession(session("legacy-session", "runner-1", "ws-1", 31));
  assert.equal(db.getSession("legacy-session")?.projectId, alpha.id);
  assert.equal(db.getSession("legacy-session")?.projectLocationId, alphaLink.id);
  db.close();
});

test("moving a reappeared detached Location revives metadata and moves linked sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-project-location-revive-"));
  const path = join(dir, "control-plane.db");
  try {
    let db = ControlPlaneDb.open(path);
    db.registerRunner(runner("runner-1", [
      { id: "one", name: "One", path: "/repos/one" },
      { id: "two", name: "Two", path: "/repos/two" },
    ]), 10);
    const source = db.listProjects(true).find((item) => item.locations[0]?.workspaceId === "one")!;
    const target = db.listProjects(true).find((item) => item.locations[0]?.workspaceId === "two")!;
    const location = source.locations[0]!;
    const linked = db.createSession(session("linked-before-detach", "runner-1", "one", 11));
    db.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE project_locations SET detached_at=?, updated_at=? WHERE id=?").run(20, 20, location.id);
    raw.prepare("UPDATE projects SET default_location_id=NULL, updated_at=? WHERE id=?").run(20, source.id);
    raw.close();

    db = ControlPlaneDb.open(path);
    db.registerRunner(runner("runner-1", [
      { id: "one", name: "One Reappeared", path: "/repos/one-new" },
      { id: "two", name: "Two", path: "/repos/two" },
    ]), 30);
    assert.equal(db.getProject(source.id)?.locations[0]?.availability, "runner_removed");

    const moved = db.moveProjectLocation(location.id, target.id, 31)!;
    assert.equal(moved.id, location.id);
    assert.equal(moved.projectId, target.id);
    assert.equal(moved.availability, "available");
    assert.equal(moved.name, "One Reappeared");
    assert.equal(moved.path, "/repos/one-new");
    assert.equal(db.getSession(linked.id)?.projectId, target.id);
    assert.equal(db.getSession(linked.id)?.projectLocationId, location.id);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Project ownership is durable and principal-filtered", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  db.createIdentityMember({
    userId: "usr_project_owner",
    displayName: "Project Owner",
    organizationId: identity.organizationId,
    role: "operator",
    now: 10,
  });
  db.createIdentityMember({
    userId: "usr_other",
    displayName: "Other",
    organizationId: identity.organizationId,
    role: "operator",
    now: 11,
  });
  const project = db.createProject({
    name: "Private",
    scope: {
      organizationId: identity.organizationId,
      owner: { kind: "user", userId: "usr_project_owner" },
    },
    now: 12,
  });
  const principal = (userId: string): HumanPrincipal => ({
    kind: "human",
    actorId: userId,
    userId,
    userName: userId,
    organizationId: identity.organizationId,
    organizationName: "Personal organization",
    role: "operator",
    deviceId: null,
    localBootstrap: false,
  });
  assert.equal(db.projectScope(project.id)?.owner.kind, "user");
  assert.equal(db.canAccessProject(principal("usr_project_owner"), project.id), true);
  assert.equal(db.canAccessProject(principal("usr_other"), project.id), false);
  assert.equal(db.canManageProject(principal("usr_project_owner"), project.id), true);
  assert.deepEqual(db.listProjectsForPrincipal(principal("usr_other"), true), []);
  db.close();
});

test("principal Project views filter session counts and management authority", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  for (const userId of ["usr_one", "usr_two"]) {
    db.createIdentityMember({
      userId, displayName: userId, organizationId: identity.organizationId, role: "operator", now: 1,
    });
  }
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  for (const [id, userId] of [["one", "usr_one"], ["two", "usr_two"]] as const) {
    db.createSession({
      ...session(id, "runner-1", "ws-1", 20),
      scope: { organizationId: identity.organizationId, owner: { kind: "user", userId } },
    });
  }
  const principal = (userId: string, role: HumanPrincipal["role"] = "operator"): HumanPrincipal => ({
    kind: "human", actorId: userId, userId, userName: userId,
    organizationId: identity.organizationId, organizationName: "Personal organization",
    role, deviceId: null, localBootstrap: false,
  });
  assert.deepEqual(
    db.listProjectsForPrincipal(principal("usr_one"), true).map((item) => [
      item.totalSessionCount,
      item.locations[0]?.totalSessionCount,
      item.locations[0]?.unarchivedSessionCount,
      item.locations[0]?.activeSessionCount,
      item.canManage,
    ]),
    [[1, 1, 1, 1, false]],
  );
  assert.deepEqual(
    db.listProjectsForPrincipal(principal(identity.userId, "owner"), true).map((item) => [
      item.totalSessionCount,
      item.locations[0]?.totalSessionCount,
      item.locations[0]?.unarchivedSessionCount,
      item.locations[0]?.activeSessionCount,
      item.canManage,
    ]),
    [[2, 2, 2, 2, true]],
  );
  db.close();
});

test("Location counts use exact associations and track active and archived state", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1", [
    { id: "one", name: "One", path: "/repos/one" },
    { id: "two", name: "Two", path: "/repos/two" },
  ]), 10);
  const project = db.listProjects(true).find((item) => item.locations[0]?.workspaceId === "one")!;
  const secondProject = db.listProjects(true).find((item) => item.locations[0]?.workspaceId === "two")!;
  const firstLocation = project.locations[0]!;
  const secondLocation = secondProject.locations[0]!;
  db.moveProjectLocation(secondLocation.id, project.id, 11);

  const firstActive = db.createSession(session("first-active", "runner-1", "one", 20));
  const firstIdle = db.createSession(session("first-idle", "runner-1", "one", 21));
  const firstArchived = db.createSession({ ...session("first-archived", "runner-1", "one", 22), archived: true });
  const secondActive = db.createSession(session("second-active", "runner-1", "two", 23));
  db.createSession({
    ...session("unlinked", "runner-1", "one", 24),
    projectId: project.id,
    projectLocationId: null,
  });
  db.updateSessionStatus(firstIdle.id, "completed", 30);
  db.updateSessionStatus(firstArchived.id, "running", 31);
  db.updateSessionStatus(secondActive.id, "input_required", 32);

  const before = db.getProject(project.id)!;
  const beforeFirstLocation = before.locations.find((location) => location.id === firstLocation.id)!;
  const beforeSecondLocation = before.locations.find((location) => location.id === secondLocation.id)!;
  assert.deepEqual(
    [before.activeSessionCount, before.unarchivedSessionCount, before.totalSessionCount],
    [3, 4, 5],
    "Project totals include the Project-linked session whose Location is null",
  );
  assert.deepEqual(
    {
      active: beforeFirstLocation.activeSessionCount,
      unarchived: beforeFirstLocation.unarchivedSessionCount,
      total: beforeFirstLocation.totalSessionCount,
    },
    { active: 1, unarchived: 2, total: 3 },
  );
  assert.deepEqual(
    {
      active: beforeSecondLocation.activeSessionCount,
      unarchived: beforeSecondLocation.unarchivedSessionCount,
      total: beforeSecondLocation.totalSessionCount,
    },
    { active: 1, unarchived: 1, total: 1 },
  );
  assert.equal(
    before.locations.reduce((sum, location) => sum + (location.totalSessionCount ?? 0), 0),
    4,
    "a null projectLocationId is excluded from every Location count",
  );

  db.setSessionArchived(secondActive.id, true, 40);
  db.updateSessionStatus(firstActive.id, "completed", 41);
  const after = db.getProject(project.id)!;
  assert.deepEqual(
    after.locations.map((location) => [
      location.workspaceId,
      location.activeSessionCount,
      location.unarchivedSessionCount,
      location.totalSessionCount,
    ]).sort(),
    [["one", 0, 2, 3], ["two", 0, 0, 1]],
  );
  db.close();
});

test("private workspace scope follows its single-Location Project without widening access", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  for (const userId of ["usr_private", "usr_other"]) {
    db.createIdentityMember({
      userId, displayName: userId, organizationId: identity.organizationId, role: "operator", now: 1,
    });
  }
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: "runner-1", resourceId: "ws-1",
    scope: { organizationId: identity.organizationId, owner: { kind: "user", userId: "usr_private" } },
    now: 20,
  }), true);
  const principal = (userId: string): HumanPrincipal => ({
    kind: "human", actorId: userId, userId, userName: userId,
    organizationId: identity.organizationId, organizationName: "Personal organization",
    role: "operator", deviceId: null, localBootstrap: false,
  });
  assert.equal(db.canAccessProject(principal("usr_private"), project.id), true);
  assert.equal(db.canAccessProject(principal("usr_other"), project.id), false);

  const broader = db.createSession({
    ...session("broader", "runner-1", "ws-1", 30),
    scope: { organizationId: identity.organizationId, owner: { kind: "organization", organizationId: identity.organizationId } },
  });
  assert.equal(broader.projectId, null, "a broader session cannot inherit a private Project");
  const orgProject = db.createProject({ name: "Organization Project", now: 40 });
  assert.throws(
    () => db.moveProjectLocation(project.locations[0]!.id, orgProject.id, 50),
    /must not expose a private workspace/,
  );
  db.close();
});

test("narrowing a shared workspace cannot transfer Projects owned by other principals", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  for (const userId of ["usr_a", "usr_b"]) {
    db.createIdentityMember({
      userId, displayName: userId, organizationId: identity.organizationId, role: "operator", now: 1,
    });
  }
  db.registerRunner(runner(), 10);
  const userAScope = {
    organizationId: identity.organizationId,
    owner: { kind: "user" as const, userId: "usr_a" },
  };
  const userBScope = {
    organizationId: identity.organizationId,
    owner: { kind: "user" as const, userId: "usr_b" },
  };
  const projectA = db.createProject({ name: "A", scope: userAScope, now: 20 });
  const projectB = db.createProject({ name: "B", scope: userBScope, now: 21 });
  const locationA = db.addProjectLocation(projectA.id, {
    runnerId: "runner-1", workspaceId: "ws-1",
  }, 22);
  const locationB = db.addProjectLocation(projectB.id, {
    runnerId: "runner-1", workspaceId: "ws-1",
  }, 23);
  db.createSession({
    ...session("session-b", "runner-1", "ws-1", 24),
    projectId: projectB.id,
    projectLocationId: locationB.id,
    scope: userBScope,
  });

  assert.equal(db.setResourceScope({
    resource: "workspace",
    runnerId: "runner-1",
    resourceId: "ws-1",
    scope: userAScope,
    now: 30,
  }), false, "the scope change must fail rather than re-own a third-party Project");
  assert.deepEqual(db.projectScope(projectA.id), userAScope);
  assert.deepEqual(db.projectScope(projectB.id), userBScope);
  assert.deepEqual(
    {
      projectId: db.getSession("session-b")?.projectId,
      projectLocationId: db.getSession("session-b")?.projectLocationId,
    },
    { projectId: projectB.id, projectLocationId: locationB.id },
  );
  assert.equal(db.projectLocation(locationA.id)?.projectId, projectA.id);
  db.close();
});

test("merging Locations freezes the logical Project name across runner discovery", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1", [
    { id: "one", name: "One", path: "/repos/one" },
    { id: "two", name: "Two", path: "/repos/two" },
  ]), 10);
  const one = db.listProjects(true).find((project) => project.locations[0]?.workspaceId === "one")!;
  const two = db.listProjects(true).find((project) => project.locations[0]?.workspaceId === "two")!;
  db.moveProjectLocation(two.locations[0]!.id, one.id, 20);

  db.registerRunner(runner("runner-1", [
    { id: "two", name: "Changed Two", path: "/new/two" },
    { id: "one", name: "Changed One", path: "/new/one" },
  ]), 30);

  assert.equal(db.getProject(one.id)?.name, "One");
  assert.deepEqual(db.getProject(one.id)?.locations.map((location) => location.name).sort(), ["Changed One", "Changed Two"]);
  db.renameWorkspace("runner-1", "one", "Renamed Workspace");
  assert.equal(db.getProject(one.id)?.name, "One", "legacy workspace rename cannot rename a multi-Location Project");
  db.close();
});

test("location move/remove/default operations preserve exact session association", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1", [
    { id: "one", name: "One", path: "/repos/one" },
    { id: "two", name: "Two", path: "/repos/two" },
  ]), 10);
  const one = db.listProjects(true).find((project) => project.locations[0]?.workspaceId === "one")!;
  const two = db.listProjects(true).find((project) => project.locations[0]?.workspaceId === "two")!;
  const twoLocation = two.locations[0]!;

  assert.equal(db.moveProjectLocation(twoLocation.id, one.id, 20)?.projectId, one.id);
  assert.equal(db.getProject(two.id)?.locations.length, 0);
  assert.equal(db.setProjectDefaultLocation(one.id, twoLocation.id, 21)?.locations
    .find((location) => location.id === twoLocation.id)?.isDefault, true);

  const created = db.createSession(session("moved-location-session", "runner-1", "two", 30));
  assert.equal(created.projectId, one.id);
  assert.equal(created.projectLocationId, twoLocation.id);
  assert.equal(db.getProject(one.id)?.totalSessionCount, 1);

  const removed = db.removeProjectLocation(twoLocation.id, 40);
  assert.equal(removed?.id, twoLocation.id);
  assert.equal(db.getSession(created.id)?.projectId, one.id, "removing location keeps Project grouping");
  assert.equal(db.getSession(created.id)?.projectLocationId, twoLocation.id, "historical Location identity is retained");
  assert.equal(db.findProjectLocation("runner-1", "two"), null);
  assert.equal(db.getProject(one.id)?.locations.some((location) => location.id === twoLocation.id), false);
  const afterRemoval = db.createSession(session("after-removal", "runner-1", "two", 50));
  assert.equal(afterRemoval.projectId, null, "removed Locations are excluded from future inference");
  assert.equal(afterRemoval.projectLocationId, null);
  db.close();
});

test("bulk archive and Project deletion clear grouping without deleting sessions", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  const first = db.createSession(session("first", "runner-1", "ws-1", 20));
  const second = db.createSession(session("second", "runner-1", "ws-1", 21));
  const alreadyArchived = db.createSession({ ...session("already-archived", "runner-1", "ws-1", 22), archived: true });
  assert.equal(db.getProject(project.id)?.unarchivedSessionCount, 2);

  const archived = db.archiveProjectSessions(project.id, true, 30);
  assert.deepEqual(archived.map((item) => item.id).sort(), [first.id, second.id]);
  assert.ok(archived.every((item) => item.archived));
  assert.equal(
    db.getSession(alreadyArchived.id)?.updatedAt,
    alreadyArchived.updatedAt,
    "bulk archive does not rewrite sessions that were already archived",
  );
  assert.equal(db.getProject(project.id)?.unarchivedSessionCount, 0);
  assert.equal(db.getProject(project.id)?.totalSessionCount, 3);

  assert.deepEqual(db.deleteProject(project.id, 40)?.sessionIds, [alreadyArchived.id, first.id, second.id]);
  assert.equal(db.getProject(project.id), null);
  assert.equal(db.getSession(first.id)?.projectId, null);
  assert.equal(db.getSession(first.id)?.projectLocationId, null);
  assert.equal(db.getSession(first.id)?.archived, true, "Project deletion does not delete or unarchive sessions");
  db.close();
});

test("deleted Project Locations stay unlinked across runner registration and database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-project-delete-tombstone-"));
  const path = join(dir, "control-plane.db");
  try {
    let db = ControlPlaneDb.open(path);
    db.registerRunner(runner(), 10);
    const project = db.listProjects(true)[0]!;
    const active = db.createSession(session("active", "runner-1", "ws-1", 20));
    const archived = db.createSession({ ...session("archived", "runner-1", "ws-1", 21), archived: true });

    assert.deepEqual(db.deleteProject(project.id, 30)?.sessionIds, [active.id, archived.id]);
    assert.deepEqual(db.listProjects(true), []);
    for (const id of [active.id, archived.id]) {
      assert.equal(db.getSession(id)?.projectId, null);
      assert.equal(db.getSession(id)?.projectLocationId, null);
    }

    db.registerRunner(runner(), 40);
    assert.deepEqual(db.listProjects(true), [], "runner registration does not recreate an explicitly deleted Project");
    assert.equal(db.findProjectLocation("runner-1", "ws-1"), null);
    db.close();

    db = ControlPlaneDb.open(path);
    assert.deepEqual(db.listProjects(true), [], "the exact-location suppression survives reopen");
    db.registerRunner(runner(), 50);
    assert.deepEqual(db.listProjects(true), [], "re-registration after reopen remains suppressed");
    assert.equal(db.getSession(active.id)?.projectId, null);
    assert.equal(db.getSession(archived.id)?.projectId, null);
    assert.equal(db.getSession(archived.id)?.archived, true);
    const replacement = db.createProject({ name: "Replacement", now: 60 });
    const relinked = db.addProjectLocation(replacement.id, { runnerId: "runner-1", workspaceId: "ws-1" }, 61);
    assert.equal(relinked.projectId, replacement.id, "an explicit Add Location clears the deletion suppression");
    assert.equal(db.getSession(active.id)?.projectId, null, "relinking does not silently regroup historical sessions");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy createWorkspace materializes one managed Project and rename follows generated names", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1", []), 10);
  const workspace = db.createWorkspace("runner-1", { name: "Managed", path: "/repos/managed" });
  const location = db.findProjectLocation("runner-1", workspace.id)!;
  assert.equal(location.source, "managed");
  assert.equal(db.getProject(location.projectId)?.name, "Managed");

  db.renameWorkspace("runner-1", workspace.id, "Renamed");
  assert.equal(db.getProject(location.projectId)?.name, "Renamed");
  db.renameWorkspace("runner-1", workspace.id, "");
  assert.equal(db.getProject(location.projectId)?.name, "Managed");
  db.close();
});

test("Project-scoped workspace creation adds one managed Location without an orphan Project", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner("runner-1", []), 10);
  const project = db.createProject({ name: "Target Project", now: 20 });

  const workspace = db.createProjectWorkspace(
    project.id,
    "runner-1",
    { name: "New Location", path: "/repos/new-location" },
    30,
  );
  assert.match(workspace.id, /^ws_/u);
  assert.equal(db.listProjects(true).length, 1, "creation must not materialize a legacy intermediate Project");
  const refreshed = db.getProject(project.id)!;
  assert.equal(refreshed.locations.length, 1);
  assert.deepEqual(
    {
      runnerId: refreshed.locations[0]?.runnerId,
      workspaceId: refreshed.locations[0]?.workspaceId,
      name: refreshed.locations[0]?.name,
      path: refreshed.locations[0]?.path,
      source: refreshed.locations[0]?.source,
      isDefault: refreshed.locations[0]?.isDefault,
    },
    {
      runnerId: "runner-1",
      workspaceId: workspace.id,
      name: "New Location",
      path: "/repos/new-location",
      source: "managed",
      isDefault: true,
    },
  );
  assert.deepEqual(db.workspaceScope("runner-1", workspace.id), db.projectScope(project.id));
  assert.throws(
    () => db.createProjectWorkspace(
      project.id,
      "runner-1",
      { name: "Duplicate", path: "/repos/new-location" },
      31,
    ),
    /already registered/,
  );
  assert.equal(db.getRunner("runner-1")?.workspaces.length, 1, "a rejected duplicate must not leak a workspace");
  db.registerRunner(runner("runner-1", []), 40);
  assert.equal(db.getProject(project.id)?.locations[0]?.availability, "available");
  db.close();
});

test("access-scope previews bind relationships and atomically narrow or broaden sessions and Locations", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const privateScope = {
    organizationId: identity.organizationId,
    owner: { kind: "user" as const, userId: identity.userId },
  };
  const organizationScope = {
    organizationId: identity.organizationId,
    owner: { kind: "organization" as const, organizationId: identity.organizationId },
  };
  const audit = { principal: {
    kind: "human" as const,
    actorId: identity.userId,
    userId: identity.userId,
    userName: identity.userName,
    organizationId: identity.organizationId,
    organizationName: identity.organizationName,
    role: "owner" as const,
    deviceId: null,
    localBootstrap: true,
  } };
  db.registerRunner(runner(), 10);
  const project = db.listProjects(true)[0]!;
  const location = project.locations[0]!;
  const created = db.createSession({
    ...session("scope-change-session", "runner-1", "ws-1", 20),
    projectId: project.id,
    projectLocationId: location.id,
    scope: organizationScope,
  });
  assert.equal(created.status, "queued");

  const initial = db.previewProjectAccessScope(project.id, privateScope)!;
  assert.deepEqual({
    compatible: initial.compatible,
    activeSessionCount: initial.activeSessionCount,
    totalSessionCount: initial.totalSessionCount,
    sessionsToNarrow: initial.sessionsToNarrow,
    affectedProjects: initial.affectedProjects.map((item) => item.projectId),
  }, {
    compatible: true,
    activeSessionCount: 1,
    totalSessionCount: 1,
    sessionsToNarrow: 1,
    affectedProjects: [project.id],
  });
  assert.match(initial.confirmationToken ?? "", /^[a-f0-9]{64}$/u);

  db.updateSessionStatus(created.id, "completed", 21);
  assert.throws(
    () => db.applyProjectAccessScope(project.id, privateScope, initial.confirmationToken!, 22, audit),
    /changed after preview/,
    "session activity changes invalidate the displayed impact",
  );
  const current = db.previewProjectAccessScope(project.id, privateScope)!;
  db.applyProjectAccessScope(project.id, privateScope, current.confirmationToken!, 23, audit);
  assert.deepEqual(db.projectScope(project.id), privateScope);
  assert.deepEqual(db.sessionScope(created.id), privateScope);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1"), organizationScope,
    "narrowing a Project never silently changes Location access");

  const narrowLocation = db.previewWorkspaceAccessScope("runner-1", "ws-1", privateScope)!;
  assert.equal(narrowLocation.compatible, true);
  assert.deepEqual(narrowLocation.affectedProjects.map((item) => item.projectId), [project.id]);
  db.applyWorkspaceAccessScope("runner-1", "ws-1", privateScope, narrowLocation.confirmationToken!, 24, audit);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1"), privateScope);

  const broadenLocation = db.previewWorkspaceAccessScope("runner-1", "ws-1", organizationScope)!;
  assert.equal(broadenLocation.compatible, true);
  assert.equal(broadenLocation.sessionsToNarrow, 0, "broadening a Location preserves private sessions");
  db.applyWorkspaceAccessScope("runner-1", "ws-1", organizationScope, broadenLocation.confirmationToken!, 25, audit);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1"), organizationScope);
  assert.deepEqual(db.sessionScope(created.id), privateScope);
  db.close();
});

test("active team members atomically narrow Projects, Locations, and sessions to themselves with exact audit evidence", () => {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const member = db.createIdentityMember({
    userId: "usr_scope_member", displayName: "Scope Member",
    organizationId: identity.organizationId, role: "operator", now: 1,
  });
  const team = db.createIdentityTeam({
    teamId: "team_scope", organizationId: identity.organizationId, name: "Scope Team",
    memberUserIds: [member.userId], now: 2,
  });
  const principal: HumanPrincipal = {
    kind: "human", actorId: member.userId, userId: member.userId, userName: member.displayName,
    organizationId: identity.organizationId, organizationName: identity.organizationName,
    role: "operator", deviceId: "dev_scope_member", localBootstrap: false,
  };
  const teamScope = {
    organizationId: identity.organizationId,
    owner: { kind: "team" as const, teamId: team.teamId },
  };
  const privateScope = {
    organizationId: identity.organizationId,
    owner: { kind: "user" as const, userId: member.userId },
  };
  db.registerRunner(runner(), 3);
  assert.equal(db.setResourceScope({ resource: "runner", resourceId: "runner-1", scope: teamScope, now: 4 }), true);
  assert.equal(db.setResourceScope({
    resource: "workspace", runnerId: "runner-1", resourceId: "ws-1", scope: teamScope, now: 5,
  }), true);
  const project = db.listProjects(true)[0]!;
  assert.deepEqual(db.projectScope(project.id), teamScope, "the sole generated Project follows its Location scope");
  const projectSession = db.createSession({
    ...session("team-project-session", "runner-1", "ws-1", 6),
    projectId: project.id,
    projectLocationId: project.locations[0]!.id,
    scope: teamScope,
  });

  const projectPreview = db.previewProjectAccessScope(project.id, privateScope)!;
  assert.equal(projectPreview.compatible, true);
  assert.equal(projectPreview.sessionsToNarrow, 1);
  db.applyProjectAccessScope(project.id, privateScope, projectPreview.confirmationToken!, 7, {
    principal, mutationAuditId: "mut_project_narrow",
  });
  assert.deepEqual(db.projectScope(project.id), privateScope);
  assert.deepEqual(db.sessionScope(projectSession.id), privateScope);
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1"), teamScope);

  const locationSession = db.createSession({
    ...session("team-location-session", "runner-1", "ws-1", 8),
    scope: privateScope,
  });
  assert.equal(db.setResourceScope({
    resource: "session", resourceId: locationSession.id, scope: teamScope, now: 9,
  }), true);
  assert.equal(db.getSession(locationSession.id)?.projectId, null,
    "the intentionally broader Location session is detached from the private Project");
  const locationPreview = db.previewWorkspaceAccessScope("runner-1", "ws-1", privateScope)!;
  assert.equal(locationPreview.compatible, true);
  assert.equal(locationPreview.sessionsToNarrow, 1);
  db.applyWorkspaceAccessScope("runner-1", "ws-1", privateScope, locationPreview.confirmationToken!, 10, {
    principal, mutationAuditId: "mut_location_narrow",
  });
  assert.deepEqual(db.workspaceScope("runner-1", "ws-1"), privateScope);
  assert.deepEqual(db.sessionScope(locationSession.id), privateScope);

  const audit = db.listAccessScopeAudit(identity.organizationId);
  assert.deepEqual(audit.map((entry) => ({
    mutationAuditId: entry.mutationAuditId,
    actorId: entry.actorId,
    deviceId: entry.deviceId,
    resource: entry.resource,
    resourceId: entry.resourceId,
    currentOwner: entry.currentScope.owner,
    targetOwner: entry.targetScope.owner,
    affectedProjectIds: entry.affectedProjectIds,
    activeSessionIds: entry.activeSessionIds,
    sessionIds: entry.sessionIds,
    narrowedSessionIds: entry.narrowedSessionIds,
  })), [{
    mutationAuditId: "mut_location_narrow",
    actorId: member.userId,
    deviceId: "dev_scope_member",
    resource: "workspace",
    resourceId: "ws-1",
    currentOwner: teamScope.owner,
    targetOwner: privateScope.owner,
    affectedProjectIds: [project.id],
    activeSessionIds: [locationSession.id, projectSession.id],
    sessionIds: [locationSession.id, projectSession.id],
    narrowedSessionIds: [locationSession.id],
  }, {
    mutationAuditId: "mut_project_narrow",
    actorId: member.userId,
    deviceId: "dev_scope_member",
    resource: "project",
    resourceId: project.id,
    currentOwner: teamScope.owner,
    targetOwner: privateScope.owner,
    affectedProjectIds: [project.id],
    activeSessionIds: [projectSession.id],
    sessionIds: [projectSession.id],
    narrowedSessionIds: [projectSession.id],
  }]);
  db.close();
});
