import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectLocationView, ProjectView } from "@wollipog/protocol";
import type { InboxSplit } from "./inbox.js";
import {
  sessionsLoadingMessage,
  sessionsSituation,
  sessionsSituationMessage,
  sessionsSituationOffersNewSession,
  sessionsSituationTitle,
  sessionsSkeletonRows,
  sessionsSyncingCount,
  type SessionsSituation,
} from "./sessions-states.js";

const machines: Record<string, string> = { "runner-studio": "Studio", "runner-laptop": "Laptop" };
const machineName = (runnerId: string) => machines[runnerId] ?? "";

function location(id: string, runnerId: string, availability: ProjectLocationView["availability"]): ProjectLocationView {
  return {
    id, projectId: "project-docs", runnerId, workspaceId: `workspace-${id}`, name: "docs", path: "/docs",
    source: "managed", availability, isDefault: false, createdAt: 1, updatedAt: 1,
  };
}

function projectSplit(locations: ProjectLocationView[]): Pick<InboxSplit, "kind" | "name" | "project"> {
  const project: ProjectView = {
    id: "project-docs", name: "Docs Site", hidden: false, locations,
    activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
  };
  return {
    kind: "project",
    name: "Docs Site",
    project: { kind: "durable", project, primaryLocation: null, legacyKeys: [] },
  };
}

const all: Pick<InboxSplit, "kind" | "name" | "project"> = { kind: "all", name: "All", project: null };
const noProject: Pick<InboxSplit, "kind" | "name" | "project"> = { kind: "no_project", name: "No Project", project: null };

function situation(split: Pick<InboxSplit, "kind" | "name" | "project"> | null, options: { mode?: "ordinary" | "snoozed"; snoozed?: number } = {}) {
  return sessionsSituation({ split, mode: options.mode ?? "ordinary", snoozedInGroup: options.snoozed ?? 0, machineName });
}

test("each empty group names its own situation (#2220)", () => {
  assert.deepEqual(situation(all), { kind: "first-run" });
  assert.deepEqual(situation(null), { kind: "first-run" });
  assert.deepEqual(situation(noProject), { kind: "no-project" });
  assert.deepEqual(situation(projectSplit([location("a", "runner-studio", "available")])),
    { kind: "project-empty", project: "Docs Site" });
  assert.deepEqual(situation(projectSplit([])), { kind: "no-location", project: "Docs Site" });
  assert.deepEqual(situation({ kind: "project", name: "Legacy", project: { kind: "legacy", runnerId: "r", workspaceId: "w" } }),
    { kind: "project-empty", project: "Legacy" }, "a legacy group has no Locations to be missing");
});

test("an offline Location names its machine, once per machine", () => {
  assert.deepEqual(situation(projectSplit([location("a", "runner-studio", "runner_offline")])),
    { kind: "location-offline", project: "Docs Site", machines: ["Studio"] });
  assert.deepEqual(situation(projectSplit([
    location("a", "runner-studio", "runner_offline"),
    location("b", "runner-studio", "runner_offline"),
    location("c", "runner-laptop", "runner_offline"),
  ])), { kind: "location-offline", project: "Docs Site", machines: ["Studio", "Laptop"] });
  // A machine the client cannot name falls back to its id rather than an empty name.
  assert.deepEqual(situation(projectSplit([location("a", "runner-gone", "runner_offline")])),
    { kind: "location-offline", project: "Docs Site", machines: ["runner-gone"] });
  // Any available Location means sessions can start here: the group is simply empty.
  assert.equal(situation(projectSplit([
    location("a", "runner-studio", "runner_offline"),
    location("b", "runner-laptop", "available"),
  ])).kind, "project-empty");
  // A missing folder or a removed machine is not "offline": the state does not promise a reconnect.
  assert.deepEqual(situation(projectSplit([
    location("a", "runner-studio", "runner_offline"),
    location("b", "runner-laptop", "workspace_missing"),
  ])), { kind: "location-unavailable", project: "Docs Site" });
});

test("snoozing decides before the group does", () => {
  assert.deepEqual(situation(projectSplit([]), { mode: "snoozed" }), { kind: "snoozed", group: "Docs Site" });
  assert.deepEqual(situation(all, { mode: "snoozed" }), { kind: "snoozed", group: "Sessions" });
  // A group whose every session is snoozed is not "No Sessions Yet".
  assert.deepEqual(situation(all, { snoozed: 2 }), { kind: "all-snoozed", group: "Sessions" });
  assert.deepEqual(situation(noProject, { snoozed: 1 }), { kind: "all-snoozed", group: "No Project" });
});

test("each situation has its issue copy, sentence case, and no success mark", () => {
  const cases: Array<[SessionsSituation, string, RegExp]> = [
    [{ kind: "first-run" }, "No Sessions Yet", /^Pick a project and describe the task\. An agent starts on one of your machines and tells you when it needs a decision\.$/],
    [{ kind: "project-empty", project: "Docs Site" }, "No Sessions Yet", /^Start a session to put an agent to work in Docs Site\.$/],
    [{ kind: "no-location", project: "Docs Site" }, "No Location Yet", /^Sessions run in a folder on one of your machines\. Add one to Docs Site to start sessions here\.$/],
    [{ kind: "location-offline", project: "Docs Site", machines: ["Studio"] }, "Location Offline",
      /^This project's only location is on Studio, which is offline\. Sessions can start here when it reconnects\.$/],
    [{ kind: "location-offline", project: "Docs Site", machines: ["Studio", "Laptop"] }, "Location Offline",
      /^This project's locations are on Studio and Laptop, which are offline\./],
    [{ kind: "location-unavailable", project: "Docs Site" }, "No Location Available", /Manage its locations/],
    [{ kind: "no-project" }, "No Sessions Without a Project", /^Sessions you start without choosing a project collect here\.$/],
    [{ kind: "snoozed", group: "Docs Site" }, "No Snoozed Sessions",
      /^Snooze a session to hide it from Docs Site until a time you choose\. Its work keeps running while it's away\.$/],
    [{ kind: "all-snoozed", group: "Sessions" }, "No Active Sessions", /^Every session is snoozed\./],
  ];
  for (const [value, title, message] of cases) {
    assert.equal(sessionsSituationTitle(value), title);
    assert.match(sessionsSituationMessage(value), message);
    assert.doesNotMatch(`${title} ${sessionsSituationMessage(value)}`, /✓|All Agents Unblocked|Running: \d/);
  }
});

test("only first run, an empty Project and No Project offer New Session", () => {
  const offering = (["first-run", "project-empty", "no-location", "location-offline", "location-unavailable", "no-project", "snoozed", "all-snoozed"] as const)
    .filter((kind) => sessionsSituationOffersNewSession({ kind, project: "P", group: "G", machines: ["M"] } as SessionsSituation));
  assert.deepEqual(offering, ["first-run", "project-empty", "no-project"]);
});

test("a group waits for the sessions its count promises, with 3 to 6 skeleton rows (§12.3)", () => {
  const coming = { count: 8, sessions: [] };
  assert.equal(sessionsSyncingCount(coming, "ordinary", ""), 8);
  assert.equal(sessionsSyncingCount(coming, "snoozed", ""), null, "Snoozed counts only what it holds");
  assert.equal(sessionsSyncingCount(coming, "ordinary", "docs"), null, "a search filters what has arrived");
  assert.equal(sessionsSyncingCount({ count: 0, sessions: [] }, "ordinary", ""), null);
  assert.equal(sessionsSyncingCount(null, "ordinary", ""), null);
  assert.deepEqual([null, 1, 3, 5, 8].map(sessionsSkeletonRows), [6, 3, 3, 5, 6]);
  assert.equal(sessionsLoadingMessage(8), "Loading 8 sessions…");
  assert.equal(sessionsLoadingMessage(1), "Loading 1 session…");
  assert.equal(sessionsLoadingMessage(null), "Loading sessions…");
});
