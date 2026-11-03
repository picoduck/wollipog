import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationSpec, RunnerMetadata } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";

const runner: RunnerMetadata = {
  runnerId: "runner-removal",
  hostname: "removal-host",
  os: "linux",
  version: "test",
  workspaces: [{ id: "home", name: "home", path: "/home/person" }],
  agents: [],
};

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, 1);
  const managed = db.registerMachineWorkspace(runner.runnerId, { name: "Notes", path: "/srv/notes" }, undefined, 2);
  return { db, managed };
}

function session(db: ControlPlaneDb, id: string, workspaceId: string, now: number) {
  db.createSession({
    id, runnerId: runner.runnerId, workspaceId, agentId: null, title: id, useWorktree: false,
    driver: "acp", config: {}, now,
  });
}

test("workspaces carry their source and an unused managed workspace unregisters completely", () => {
  const { db, managed } = fixture();
  assert.deepEqual(db.getRunner(runner.runnerId)?.workspaces.map(({ id, source }) => ({ id, source })), [
    { id: "home", source: "configured" },
    { id: managed.id, source: "managed" },
  ]);
  assert.equal(db.workspaceSource(runner.runnerId, "home"), "configured");
  assert.equal(db.workspaceSource(runner.runnerId, managed.id), "managed");
  assert.equal(db.workspaceSource(runner.runnerId, "missing"), null);

  db.renameWorkspace(runner.runnerId, managed.id, "Renamed Notes");
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, managed.id), []);
  db.unregisterWorkspace(runner.runnerId, managed.id);
  assert.deepEqual(db.getRunner(runner.runnerId)?.workspaces.map((workspace) => workspace.id), ["home"]);
  assert.equal(db.workspaceSource(runner.runnerId, managed.id), null);
  assert.equal(db.workspaceScope(runner.runnerId, managed.id), null);

  // The same folder can be added again afterwards.
  assert.ok(db.registerMachineWorkspace(runner.runnerId, { name: "Notes", path: "/srv/notes" }, undefined, 3));
});

test("project locations, unarchived sessions and automations block removal; archived history does not", () => {
  const { db } = fixture();
  // A reported workspace gets its own project at registration.
  const project = db.listProjects(true).find((candidate) => candidate.locations.some((location) => location.workspaceId === "home"))!;
  const location = project.locations.find((candidate) => candidate.workspaceId === "home")!;
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, "home"), [
    { kind: "project_location", projectId: project.id, projectName: project.name },
  ]);
  db.removeProjectLocation(location.id, 3);
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, "home"), []);

  session(db, "session-live", "home", 4);
  session(db, "session-history", "home", 5);
  db.setSessionArchived("session-history", true, 6);
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, "home"), [{ kind: "session", count: 1 }]);
  db.setSessionArchived("session-live", true, 7);
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, "home"), []);

  const spec: AutomationSpec = {
    name: "Nightly",
    cron: "0 2 * * *",
    timezone: "UTC",
    enabled: false,
    misfirePolicy: { kind: "fire_once" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "skip",
    limits: { maxCostUsd: 1, maxToolCalls: 10 },
    notifications: { pushEvents: [] },
    action: { kind: "create_session", request: { runnerId: runner.runnerId, workspaceId: "home", agentId: "agent", prompt: "Go" } },
  };
  db.createAutomation({ automationId: "auto-nightly", spec, nextFireAt: null, actor: { kind: "human", id: "device" }, now: 8 });
  assert.deepEqual(db.workspaceRemovalBlockers(runner.runnerId, "home"), [
    { kind: "automation", automationId: "auto-nightly", automationName: "Nightly" },
  ]);

  // Unregistering never touches sessions or project history.
  db.unregisterWorkspace(runner.runnerId, "home");
  assert.equal(db.getSession("session-history")?.workspaceId, "home");
  assert.equal(db.getSession("session-live")?.archived, true);
});
