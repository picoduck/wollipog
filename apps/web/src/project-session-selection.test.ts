import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateRunRequest,
  CreateWorkflowRunRequest,
  ProjectLocationView,
  ProjectView,
  RunnerView,
} from "@wollipog/protocol";
import {
  NO_PROJECT_SELECTION,
  isLaunchableProjectLocation,
  initialProjectSelectionForPreset,
  projectForSessionPreset,
  projectFallbacksAwaitingStore,
  projectLocationForSessionPreset,
  projectInventoryWithFallbacks,
  projectRunPlacementIssue,
  projectSelectionLabel,
  projectSessionPlacement,
  suggestedProjectLocation,
} from "./project-session-selection.js";

function location(id: string, overrides: Partial<ProjectLocationView> = {}): ProjectLocationView {
  return {
    id,
    projectId: "project-1",
    runnerId: `runner-${id}`,
    workspaceId: `workspace-${id}`,
    name: id,
    path: `/repos/${id}`,
    source: "reported",
    availability: "available",
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function project(id: string, locations: ProjectLocationView[], name = id): ProjectView {
  return {
    id, name, hidden: false, locations,
    activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0,
    createdAt: 1, updatedAt: 1,
  };
}

function runner(location: ProjectLocationView, status: RunnerView["status"] = "online"): RunnerView {
  return {
    runnerId: location.runnerId,
    hostname: location.runnerId,
    os: "linux",
    version: "1",
    status,
    agents: [],
    workspaces: [{ id: location.workspaceId, name: location.name, path: location.path }],
    connectedAt: 1,
    lastSeen: 1,
  };
}

test("Project Location selection uses exact IDs and never display names", () => {
  const firstLocation = location("one", { projectId: "first" });
  const secondLocation = location("two", { projectId: "second" });
  const first = project("first", [firstLocation], "Same Name");
  const second = project("second", [secondLocation], "Same Name");
  assert.equal(projectForSessionPreset([first, second], { projectId: "second" }), second);
  assert.equal(projectForSessionPreset([first, second], {
    runnerId: secondLocation.runnerId,
    workspaceId: secondLocation.workspaceId,
  }), second);
  assert.equal(projectLocationForSessionPreset(second, { projectLocationId: secondLocation.id }), secondLocation);
  assert.equal(projectLocationForSessionPreset(first, { projectLocationId: secondLocation.id }), null,
    "an explicit Location from another Project fails closed");
  assert.equal(projectSelectionLabel(first, true), "Same Name — /repos/one · runner-one");
  assert.notEqual(
    projectSelectionLabel(first, true),
    projectSelectionLabel(project("third", [location("one", { projectId: "third", runnerId: "another-runner" })], "Same Name"), true),
    "duplicate names with equal paths still include distinct runner identity",
  );
});

test("authoritative Project inventory replaces temporary inline fallbacks", () => {
  const fallback = project("project-1", [], "Inline Name");
  const authoritative = project("project-1", [], "Authoritative Name");
  const fallbackOnly = project("project-2", [], "Pending Socket Update");
  const merged = projectInventoryWithFallbacks(
    new Map([[authoritative.id, authoritative]]),
    new Map([[fallback.id, fallback], [fallbackOnly.id, fallbackOnly]]),
  );
  assert.equal(merged.get("project-1"), authoritative);
  assert.equal(merged.get("project-2"), fallbackOnly);
});

test("a newer inline mutation bridges the Project upsert round trip", () => {
  const stale = project("project-1", [], "Inline Project");
  const locationAdded = {
    ...project("project-1", [location("new", { projectId: "project-1" })], "Inline Project"),
    updatedAt: stale.updatedAt + 1,
  };
  const bridged = projectInventoryWithFallbacks(
    new Map([[stale.id, stale]]),
    new Map([[locationAdded.id, locationAdded]]),
  );
  assert.equal(bridged.get("project-1"), locationAdded);

  const authoritative = { ...locationAdded, name: "Renamed Project", updatedAt: locationAdded.updatedAt + 1 };
  const refreshed = projectInventoryWithFallbacks(
    new Map([[authoritative.id, authoritative]]),
    new Map([[locationAdded.id, locationAdded]]),
  );
  assert.equal(refreshed.get("project-1"), authoritative);
  assert.equal(projectFallbacksAwaitingStore(
    new Map([[authoritative.id, authoritative]]),
    new Map([[locationAdded.id, locationAdded]]),
  ).size, 0, "the fallback is discarded after the store catches up, so later deletion cannot revive it");
});

test("session placement submits exact Project identities or explicit No Project nulls", () => {
  const selectedLocation = location("selected", { projectId: "project-1" });
  const selectedProject = project("project-1", [selectedLocation]);
  assert.deepEqual(projectSessionPlacement(true, selectedProject, selectedLocation, {
    runnerId: "wrong-runner",
    workspaceId: "wrong-workspace",
  }), {
    runnerId: selectedLocation.runnerId,
    workspaceId: selectedLocation.workspaceId,
    projectId: selectedProject.id,
    projectLocationId: selectedLocation.id,
  });
  assert.deepEqual(projectSessionPlacement(true, null, null, {
    runnerId: "runner-ad-hoc",
    workspaceId: "workspace-ad-hoc",
  }), {
    runnerId: "runner-ad-hoc",
    workspaceId: "workspace-ad-hoc",
    projectId: null,
    projectLocationId: null,
  });
  assert.deepEqual(projectSessionPlacement(false, null, null, {
    runnerId: "runner-legacy",
    workspaceId: "workspace-legacy",
  }), {
    runnerId: "runner-legacy",
    workspaceId: "workspace-legacy",
  });
});

test("initial Project selection preserves real, explicit No Project, and absent presets", () => {
  const selectedProject = project("project-1", []);
  assert.equal(initialProjectSelectionForPreset(true, selectedProject, { projectId: "project-1" }), "project-1");
  assert.equal(initialProjectSelectionForPreset(true, null, { projectId: null }), NO_PROJECT_SELECTION);
  assert.equal(initialProjectSelectionForPreset(true, null, undefined), "");
  assert.equal(initialProjectSelectionForPreset(false, selectedProject, { projectId: "project-1" }), "");
});

test("parallel and workflow run requests preserve the same exact Project placement", () => {
  const selectedLocation = location("selected", { projectId: "project-1" });
  const selectedProject = project("project-1", [selectedLocation]);
  const placement = projectSessionPlacement(true, selectedProject, selectedLocation, {
    runnerId: "wrong-runner",
    workspaceId: "wrong-workspace",
  });
  const parallel: CreateRunRequest = {
    ...placement,
    agentIds: ["codex"],
    task: "Compare implementations",
  };
  const workflow: CreateWorkflowRunRequest = {
    ...placement,
    workflowId: "build-review",
    task: "Build and review",
  };

  for (const request of [parallel, workflow]) {
    assert.equal(request.runnerId, selectedLocation.runnerId);
    assert.equal(request.workspaceId, selectedLocation.workspaceId);
    assert.equal(request.projectId, selectedProject.id);
    assert.equal(request.projectLocationId, selectedLocation.id);
  }
});

test("a launchable default or sole Location is suggested without silently replacing an exact preset", () => {
  const offlineDefault = location("offline", { isDefault: true, availability: "runner_offline" });
  const availableOne = location("one");
  const availableTwo = location("two");
  const runners = new Map([
    [offlineDefault.runnerId, runner(offlineDefault, "offline")],
    [availableOne.runnerId, runner(availableOne)],
    [availableTwo.runnerId, runner(availableTwo)],
  ]);
  const value = project("project-1", [offlineDefault, availableOne, availableTwo]);
  assert.equal(isLaunchableProjectLocation(offlineDefault, runners), false);
  assert.equal(suggestedProjectLocation(value, runners), null, "multiple available Locations require a choice");
  assert.equal(suggestedProjectLocation(value, runners, offlineDefault.id), offlineDefault,
    "an unavailable exact preset remains visible instead of falling through elsewhere");
  assert.equal(suggestedProjectLocation(project("project-1", [offlineDefault, availableOne]), runners), availableOne);
  assert.equal(suggestedProjectLocation(project("project-1", [availableOne, { ...availableTwo, isDefault: true }]), runners)?.id, availableTwo.id);
});

test("run placement requires an explicit Project choice and exact available Location", () => {
  const first = location("one");
  const second = location("two");
  const onlineRunners = new Map([
    [first.runnerId, runner(first)],
    [second.runnerId, runner(second)],
  ]);
  const multiLocation = project("project-1", [first, second]);

  assert.equal(projectRunPlacementIssue(true, "", null, null, onlineRunners),
    "Choose a Project or No Project.");
  assert.equal(projectRunPlacementIssue(true, "project-1", multiLocation, null, onlineRunners),
    "Choose an available Project Location.", "multiple Locations without a default do not silently pick one");
  assert.equal(projectRunPlacementIssue(true, "project-1", multiLocation, second, onlineRunners), null);
  assert.equal(projectRunPlacementIssue(true, NO_PROJECT_SELECTION, null, null, onlineRunners), null,
    "No Project is a valid explicit choice");
});

test("run placement explains empty and offline Projects without falling back to another workspace", () => {
  const offlineLocation = location("offline", { availability: "runner_offline" });
  const offlineRunners = new Map([[offlineLocation.runnerId, runner(offlineLocation, "offline")]]);

  assert.equal(projectRunPlacementIssue(true, "empty", project("empty", []), null, offlineRunners),
    "This Project has no Locations. Add a Location before starting a run.");
  assert.equal(projectRunPlacementIssue(true, "offline", project("offline", [offlineLocation]), offlineLocation, offlineRunners),
    "No Project Locations are currently available.");
  assert.equal(projectRunPlacementIssue(false, "", null, null, offlineRunners), null,
    "legacy control planes retain runner/workspace validation");
});
