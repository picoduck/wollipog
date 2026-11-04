import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectLocationView, ProjectView, RunnerView } from "@wollipog/protocol";
import {
  projectActivitySummary,
  projectsMostActive,
  projectsOverviewAttention,
  projectsOverviewSummary,
} from "./projects-overview.js";

const runner = (runnerId: string, status: RunnerView["status"], workspaces: string[]): RunnerView => ({
  runnerId, hostname: runnerId, os: "linux", version: "1", status, agents: [],
  workspaces: workspaces.map((id) => ({ id, name: id, path: `/repos/${id}` })), connectedAt: 1, lastSeen: 1,
});
const runners = new Map([
  ["build", runner("build", "online", ["w-alpha", "w-beta", "w-gone"])],
  ["studio", runner("studio", "offline", ["w-docs", "w-docs-2"])],
  ["laptop", runner("laptop", "offline", ["w-docs-3"])],
]);
const machineName = (location: ProjectLocationView) => ({ build: "Build Machine", studio: "Studio Mac", laptop: "Laptop" })[location.runnerId] ?? location.runnerId;

function location(projectId: string, runnerId: string, workspaceId: string, options: Partial<ProjectLocationView> = {}): ProjectLocationView {
  return {
    id: `${projectId}-${workspaceId}`, projectId, runnerId, workspaceId, name: workspaceId, path: `/repos/${workspaceId}`,
    source: "managed", availability: "available", isDefault: false, createdAt: 1, updatedAt: 1, ...options,
  };
}

function project(id: string, name: string, locations: ProjectLocationView[], options: Partial<ProjectView> = {}): ProjectView {
  return {
    id, name, hidden: false, locations, activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0,
    createdAt: 1, updatedAt: 1, ...options,
  };
}

test("the count line names projects, machines, sessions and, while any is, how many are running", () => {
  const projects = [
    project("a", "Alpha", [location("a", "build", "w-alpha"), location("a", "studio", "w-docs")], { unarchivedSessionCount: 20, activeSessionCount: 2 }),
    project("b", "Beta", [location("b", "build", "w-beta")], { unarchivedSessionCount: 12 }),
    ...Array.from({ length: 7 }, (_, index) => project(`e${index}`, `Empty ${index}`, [])),
  ];
  assert.equal(projectsOverviewSummary(projects), "9 projects on 2 machines, with 32 sessions. 2 are running now.");
  assert.equal(projectsOverviewSummary([{ ...projects[1]!, activeSessionCount: 1, unarchivedSessionCount: 1 }]),
    "1 project on 1 machine, with 1 session. 1 is running now.");
  assert.equal(projectsOverviewSummary([projects[1]!]), "1 project on 1 machine, with 12 sessions.", "nothing running says nothing");
  assert.equal(projectsOverviewSummary(projects.slice(2, 4)), "2 projects, with 0 sessions.", "no locations names no machines");
});

test("a project with every location out of reach is one row naming the offline machines, with the list's badge", () => {
  const items = projectsOverviewAttention([
    project("docs", "Docs Site", [location("docs", "studio", "w-docs", { availability: "runner_offline", isDefault: true })]),
    project("two", "Two Machines", [
      location("two", "studio", "w-docs-2", { availability: "runner_offline" }),
      location("two", "laptop", "w-docs-3", { availability: "runner_offline", isDefault: true }),
    ]),
    // The server still calls it available, but its machine has gone offline since.
    project("stale", "Stale", [location("stale", "studio", "w-docs")]),
    // Online, but the folder is gone.
    project("gone", "Gone", [location("gone", "build", "w-gone", { availability: "workspace_missing" })]),
    // One reachable location is enough.
    project("alpha", "Alpha", [location("alpha", "studio", "w-docs", { availability: "runner_offline" }), location("alpha", "build", "w-alpha")]),
  ], runners, machineName);
  assert.deepEqual(items.map((item) => item.kind === "unavailable" ? [item.project.name, item.status, item.reason] : item.kind), [
    ["Docs Site", "runner_offline", "Studio Mac is offline, so this project can't start sessions."],
    ["Gone", "workspace_missing", "None of its folders can be reached, so this project can't start sessions."],
    ["Stale", "runner_offline", "Studio Mac is offline, so this project can't start sessions."],
    ["Two Machines", "runner_offline", "Studio Mac and Laptop are offline, so this project can't start sessions."],
  ]);
});

test("a project with no locations, then names shared ignoring case, follow the unreachable projects", () => {
  const items = projectsOverviewAttention([
    project("docs-2", "docs site", [location("docs-2", "build", "w-beta")], { canManage: false }),
    project("edge", "Edge Proxy", []),
    project("docs-1", "Docs Site", [location("docs-1", "studio", "w-docs", { availability: "runner_offline" })], { canManage: false }),
    project("docs-3", "DOCS SITE ", [location("docs-3", "build", "w-alpha")]),
    project("alpha", "Alpha", [location("alpha", "build", "w-alpha")]),
  ], runners, machineName);
  assert.deepEqual(items.map((item) => item.kind), ["unavailable", "no-locations", "duplicate-name"]);
  assert.equal(items[1]!.kind === "no-locations" && items[1]!.reason, "No locations yet, so it can't start sessions.");
  const duplicate = items[2]!;
  assert.ok(duplicate.kind === "duplicate-name");
  assert.deepEqual(duplicate.projects.map((candidate) => candidate.id), ["docs-2", "docs-1", "docs-3"]);
  assert.equal(duplicate.name, "docs site", "the first one's name");
  assert.equal(duplicate.target.id, "docs-3", "Rename… opens the first one the person may rename");
  assert.equal(duplicate.reason, "Rename one so they're easy to tell apart in lists and pickers.");
});

test("Most Active is at most five projects with sessions, most first, ties by name", () => {
  const projects = [3, 9, 0, 9, 1, 7, 5, 2].map((count, index) =>
    project(`p${index}`, `Project ${String.fromCharCode(72 - index)}`, [], { unarchivedSessionCount: count }));
  assert.deepEqual(projectsMostActive(projects).map((candidate) => [candidate.name, candidate.unarchivedSessionCount]), [
    ["Project E", 9], ["Project G", 9], ["Project C", 7], ["Project B", 5], ["Project H", 3],
  ]);
  assert.deepEqual(projectsMostActive([project("q", "Quiet", [])]), [], "a project with no sessions is not active");
  assert.equal(projectActivitySummary(project("a", "A", [], { unarchivedSessionCount: 12, activeSessionCount: 2 })), "12 sessions, 2 running");
  assert.equal(projectActivitySummary(project("a", "A", [], { unarchivedSessionCount: 1 })), "1 session");
});
