import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectLocationView, ProjectView, RunnerView } from "@wollipog/protocol";
import { workspaceLocationKey } from "./projects.js";
import {
  buildProjectLocationCandidates,
  filterManagedProjects,
  projectAfterRemoval,
  projectAvailabilityLabel,
  projectLocationMembershipState,
  projectMachineSummary,
  projectUnavailableStatus,
  projectVisibilityCounts,
} from "./project-management.js";

function project(id: string, name: string, hidden = false): ProjectView {
  return {
    id,
    name,
    hidden,
    locations: [],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("Project management filters retain hidden and zero-session Projects by stable identity", () => {
  const alpha = project("alpha", "Alpha");
  const hidden = project("hidden", "Hidden Alpha", true);
  const sameName = project("alpha-2", "Alpha");
  assert.deepEqual(filterManagedProjects([hidden, sameName, alpha], "", "all").map((item) => item.id), ["alpha", "alpha-2", "hidden"]);
  assert.deepEqual(filterManagedProjects([alpha, hidden], "", "hidden").map((item) => item.id), ["hidden"]);
  assert.deepEqual(filterManagedProjects([alpha, hidden], "hidden", "all").map((item) => item.id), ["hidden"]);
});

function located(id: string, name: string, locations: Array<[runnerId: string, availability: ProjectLocationView["availability"], isDefault: boolean]>, hidden = false): ProjectView {
  return {
    ...project(id, name, hidden),
    locations: locations.map(([runnerId, availability, isDefault], index) => ({
      id: `${id}-${index}`, projectId: id, runnerId, workspaceId: `${id}-workspace-${index}`, name: `${id}-${index}`,
      path: `/repos/${id}-${index}`, source: "managed", availability, isDefault, createdAt: 1, updatedAt: 1,
    })),
  };
}
const MACHINES: Record<string, string> = { "runner-1": "Build Machine", "runner-2": "Studio Workstation" };
const machineName = (location: ProjectLocationView) => MACHINES[location.runnerId] ?? location.runnerId;

test("the Projects list searches names and machines, and its filter counts follow the search (#2957)", () => {
  const billing = located("billing", "Billing", [["runner-1", "available", true]]);
  const docs = located("docs", "Docs", [["runner-2", "runner_offline", true]]);
  const secret = located("secret", "Secret", [["runner-2", "runner_offline", true]], true);
  const empty = project("empty", "Empty");
  const all = [billing, docs, secret, empty];
  assert.deepEqual(filterManagedProjects(all, "studio", "all", machineName).map((item) => item.id), ["docs", "secret"]);
  assert.deepEqual(filterManagedProjects(all, "studio", "shown", machineName).map((item) => item.id), ["docs"]);
  // A location's own name and path are not what the field says it searches.
  assert.deepEqual(filterManagedProjects(all, "/repos", "all", machineName), []);
  assert.deepEqual(projectVisibilityCounts(all, "", machineName), { all: 4, shown: 3, hidden: 1 });
  assert.deepEqual(projectVisibilityCounts(all, "studio", machineName), { all: 2, shown: 1, hidden: 1 });
});

test("a project row names its default location's machine and a status only when nothing is reachable (#2957)", () => {
  const mixed = located("mixed", "Mixed", [["runner-2", "runner_offline", false], ["runner-1", "available", true]]);
  assert.equal(projectMachineSummary(mixed, machineName), "Build Machine");
  assert.equal(projectUnavailableStatus(mixed), null, "one reachable location is enough");
  const noDefault = located("spread", "Spread", [["runner-1", "available", false], ["runner-2", "available", false], ["runner-1", "available", false]]);
  assert.equal(projectMachineSummary(noDefault, machineName), "Build Machine, Studio Workstation");
  assert.equal(projectMachineSummary(project("empty", "Empty"), machineName), null);
  assert.equal(projectUnavailableStatus(project("empty", "Empty")), null, "no locations is the sub-line's to say");
  const offline = located("offline", "Offline", [["runner-1", "workspace_missing", false], ["runner-2", "runner_offline", true]]);
  assert.equal(projectUnavailableStatus(offline), "runner_offline", "the default location's state");
  const offlineNoDefault = located("away", "Away", [["runner-1", "workspace_missing", false], ["runner-2", "runner_offline", false]]);
  assert.equal(projectUnavailableStatus(offlineNoDefault), "workspace_missing", "else the first location's");
});

test("Location candidates use exact runner/workspace identity and preserve stale linked Locations", () => {
  const alpha = project("alpha", "Alpha");
  alpha.locations = [{
    id: "location-stale",
    projectId: alpha.id,
    runnerId: "runner-a",
    workspaceId: "same",
    name: "Old Label",
    path: "/old",
    source: "reported",
    availability: "workspace_missing",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  }];
  const runners = [{
    runnerId: "runner-b",
    hostname: "b",
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [{ id: "same", name: "Same", path: "/same" }],
    connectedAt: 1,
    lastSeen: 1,
  }] as RunnerView[];
  const candidates = buildProjectLocationCandidates([alpha], runners);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => [
    candidate.runnerId,
    candidate.workspaceId,
    candidate.links.map((link) => link.projectId),
  ]), [
    ["runner-a", "same", ["alpha"]],
    ["runner-b", "same", []],
  ]);
});

test("a reappeared exact workspace retains stable ownership and requires an explicit relink", () => {
  const alpha = project("alpha", "Alpha");
  alpha.locations = [{
    id: "location-detached",
    projectId: alpha.id,
    runnerId: "runner-a",
    workspaceId: "workspace-a",
    name: "Historical Label",
    path: "/historical",
    source: "reported",
    availability: "runner_removed",
    isDefault: false,
    createdAt: 1,
    updatedAt: 2,
  }];
  const runner = {
    runnerId: "runner-a",
    hostname: "a",
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [{ id: "workspace-a", name: "Restored", path: "/restored" }],
    connectedAt: 3,
    lastSeen: 3,
  } as RunnerView;

  const [candidate] = buildProjectLocationCandidates([alpha], [runner]);
  assert.deepEqual(candidate, {
    key: workspaceLocationKey("runner-a", "workspace-a"),
    runnerId: "runner-a",
    workspaceId: "workspace-a",
    name: "Restored",
    path: "/restored",
    availability: "available",
    links: [{
      projectId: "alpha",
      locationId: "location-detached",
      availability: "runner_removed",
    }],
  });
  assert.deepEqual(projectLocationMembershipState(candidate!, alpha.id), {
    alreadyAdded: false,
    relinkRequired: true,
  });
});

test("a detached Location without a live workspace remains added and cannot be relinked", () => {
  const alpha = project("alpha", "Alpha");
  alpha.locations = [{
    id: "location-detached",
    projectId: alpha.id,
    runnerId: "runner-gone",
    workspaceId: "workspace-gone",
    name: "Historical",
    path: "/historical",
    source: "reported",
    availability: "runner_removed",
    isDefault: true,
    createdAt: 1,
    updatedAt: 2,
  }];

  const [candidate] = buildProjectLocationCandidates([alpha], []);
  assert.deepEqual(projectLocationMembershipState(candidate!, alpha.id), {
    alreadyAdded: true,
    relinkRequired: false,
  });
});

test("Location candidates preserve every Project membership for one physical Location", () => {
  const alpha = project("alpha", "Alpha");
  const beta = project("beta", "Beta");
  const sharedLocation = {
    runnerId: "runner-a",
    workspaceId: "workspace-a",
    name: "Shared",
    path: "/shared",
    source: "reported" as const,
    availability: "available" as const,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
  alpha.locations = [{ ...sharedLocation, id: "location-alpha", projectId: alpha.id }];
  beta.locations = [{ ...sharedLocation, id: "location-beta", projectId: beta.id }];

  const [candidate] = buildProjectLocationCandidates([alpha, beta], []);
  assert.deepEqual(candidate?.links, [
    { projectId: "alpha", locationId: "location-alpha", availability: "available" },
    { projectId: "beta", locationId: "location-beta", availability: "available" },
  ]);
});

test("Project selection repairs to the next item, then previous, after deletion", () => {
  const projects = [project("a", "A"), project("b", "B"), project("c", "C")];
  assert.equal(projectAfterRemoval(projects, "b")?.id, "c");
  assert.equal(projectAfterRemoval(projects, "c")?.id, "b");
  assert.equal(projectAfterRemoval([projects[0]!], "a"), null);
});

test("Location availability uses concise Title Case labels", () => {
  assert.equal(projectAvailabilityLabel("available"), "Available");
  assert.equal(projectAvailabilityLabel("runner_offline"), "Runner Offline");
  assert.equal(projectAvailabilityLabel("workspace_missing"), "Workspace Missing");
  assert.equal(projectAvailabilityLabel("runner_removed"), "Runner Removed");
});
