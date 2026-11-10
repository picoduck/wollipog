import assert from "node:assert/strict";
import test from "node:test";
import { providerAccountPreviewPlacement } from "./ProviderAccountSelection.js";

test("a preview asks about the project its launch would have (#4353)", () => {
  const workspaceId = "ws";
  assert.deepEqual(providerAccountPreviewPlacement({ projectsSupported: true, projectId: "p", workspaceId }),
    { workspaceId, projectId: "p" }, "a chosen project");
  assert.deepEqual(providerAccountPreviewPlacement({ projectsSupported: true, projectId: null, workspaceId }),
    { workspaceId, noProject: "1" }, "No Project is sent as a choice, because the launch sends it as null");
  assert.deepEqual(providerAccountPreviewPlacement({ projectsSupported: false, projectId: null, workspaceId }),
    { workspaceId }, "a launch that sends no project is inferred from its workspace, so its preview is too");
  assert.deepEqual(providerAccountPreviewPlacement({ projectsSupported: false, projectId: null, workspaceId: undefined }),
    {}, "a browsed path never joins a project by inference");
});
