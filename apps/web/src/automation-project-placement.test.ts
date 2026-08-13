import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectLocationView, ProjectView } from "@wollipog/protocol";
import {
  automationProjectPlacement,
  validateAutomationAlternatePlacement,
} from "./automation-project-placement.js";

function location(
  id: string,
  projectId: string,
  runnerId: string,
  workspaceId: string,
): ProjectLocationView {
  return {
    id,
    projectId,
    runnerId,
    workspaceId,
    name: id,
    path: `/${id}`,
    source: "managed",
    availability: "available",
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function project(id: string, locations: ProjectLocationView[], name = "Same Name"): ProjectView {
  return {
    id,
    name,
    hidden: false,
    locations,
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("automation placement uses exact Location IDs and explicit No Project nulls", () => {
  const primary = location("location-primary", "project-one", "runner-one", "workspace");
  const other = location("location-other", "project-two", "runner-two", "workspace");
  const projects = [project("project-one", [primary]), project("project-two", [other])];

  assert.deepEqual(automationProjectPlacement(true, projects, {
    runnerId: "runner-one",
    workspaceId: "workspace",
  }), { projectId: "project-one", projectLocationId: "location-primary" });
  assert.deepEqual(automationProjectPlacement(true, projects, {
    runnerId: "runner-missing",
    workspaceId: "workspace",
  }), { projectId: null, projectLocationId: null });
  assert.deepEqual(automationProjectPlacement(false, projects, {
    runnerId: "runner-one",
    workspaceId: "workspace",
  }), {});
});

test("automation placement fails closed when exact Location ownership is ambiguous", () => {
  const duplicateOne = location("location-one", "project-one", "runner", "workspace");
  const duplicateTwo = location("location-two", "project-two", "runner", "workspace");
  assert.throws(() => automationProjectPlacement(true, [
    project("project-one", [duplicateOne]),
    project("project-two", [duplicateTwo]),
  ], { runnerId: "runner", workspaceId: "workspace" }), /more than one Project/);
});

test("automation alternates must be a different Location in the same Project", () => {
  const primary = { projectId: "project-one", projectLocationId: "location-one" };
  assert.doesNotThrow(() => validateAutomationAlternatePlacement(true, primary, {
    projectId: "project-one",
    projectLocationId: "location-two",
  }));
  assert.throws(() => validateAutomationAlternatePlacement(true, primary, {
    projectId: "project-two",
    projectLocationId: "location-two",
  }), /another Location in the same Project/);
  assert.throws(() => validateAutomationAlternatePlacement(true, primary, primary), /different Location/);
  assert.doesNotThrow(() => validateAutomationAlternatePlacement(true, {
    projectId: null,
    projectLocationId: null,
  }, {
    projectId: null,
    projectLocationId: null,
  }));
  assert.throws(() => validateAutomationAlternatePlacement(true, {
    projectId: null,
    projectLocationId: null,
  }, primary), /primary workspace to be a Project Location/);
  assert.doesNotThrow(() => validateAutomationAlternatePlacement(false, {}, {}));
});
