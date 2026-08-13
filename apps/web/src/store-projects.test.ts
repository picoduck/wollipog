import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectView, UiSnapshotMessage } from "@wollipog/protocol";
import { Store } from "./store.js";

function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "project-1",
    name: "Project One",
    hidden: false,
    locations: [{
      id: "location-1",
      projectId: "project-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      name: "Checkout",
      path: "/repos/one",
      source: "reported",
      availability: "available",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function snapshot(projects?: ProjectView[]): UiSnapshotMessage {
  return {
    type: "snapshot",
    ...(projects === undefined
      ? {}
      : { capabilities: { projects: true, createProjectLocations: true }, projects }),
    runners: [],
    boxes: [],
    sessions: [],
    runs: [],
  };
}

test("Project inventory loads from snapshots and reconciles live upsert/removal messages", () => {
  const store = new Store();
  const initial = project();
  store.dispatch({ type: "msg", msg: snapshot([initial]), now: 10 });
  assert.equal(store.getState().projectsSupported, true);
  assert.equal(store.getState().projectLocationCreationSupported, true);
  assert.equal(store.getState().projects.get(initial.id), initial);

  const renamed = project({ name: "Renamed Project", updatedAt: 2 });
  store.dispatch({ type: "msg", msg: { type: "project_upsert", project: renamed } });
  assert.equal(store.getState().projects.get(initial.id), renamed);

  store.dispatch({ type: "msg", msg: { type: "project_removed", projectId: initial.id } });
  assert.equal(store.getState().projects.has(initial.id), false);
});

test("legacy snapshots without a Project inventory remain compatible and authoritative", () => {
  const store = new Store();
  store.dispatch({ type: "msg", msg: snapshot([project()]), now: 10 });
  assert.equal(store.getState().projects.size, 1);

  store.dispatch({ type: "msg", msg: snapshot(), now: 20 });
  assert.equal(store.getState().snapshotLoaded, true);
  assert.equal(store.getState().projectsSupported, false);
  assert.equal(store.getState().projectLocationCreationSupported, false);
  assert.equal(store.getState().projects.size, 0);
});

test("removing an unknown Project preserves store identity", () => {
  const store = new Store();
  const before = store.getState();
  store.dispatch({ type: "msg", msg: { type: "project_removed", projectId: "missing" } });
  assert.equal(store.getState(), before);
});
