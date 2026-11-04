import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceRemovalBlockedMessage } from "./workspace-removal.js";

test("a workspace removal refusal names every reference and what to do about it", () => {
  assert.equal(
    workspaceRemovalBlockedMessage([{ kind: "project_location", projectId: "p1", projectName: "Docs" }]),
    "This workspace is still in use. Remove it from the project “Docs” first.",
  );
  assert.equal(
    workspaceRemovalBlockedMessage([
      { kind: "project_location", projectId: "p1", projectName: "Docs" },
      { kind: "project_location", projectId: "p2", projectName: "Site" },
      { kind: "project_location", projectId: "p3", projectName: "API" },
      { kind: "session", count: 2 },
      { kind: "automation", automationId: "a1", automationName: "Nightly" },
    ]),
    "This workspace is still in use. Remove it from the projects “Docs”, “Site” and “API” first. "
      + "Archive the 2 sessions still using it first. Change or delete the automation “Nightly” that runs in it first.",
  );
  assert.equal(
    workspaceRemovalBlockedMessage([{ kind: "session", count: 1 }]),
    "This workspace is still in use. Archive the session still using it first.",
  );
});
