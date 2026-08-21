import assert from "node:assert/strict";
import test from "node:test";
import { archiveProjectWithFeedback } from "./project-actions.js";

test("durable Project archive offers exact undo only for sessions changed by the server", async () => {
  const restored: Array<[string, boolean]> = [];
  let undo: (() => void | Promise<void>) | undefined;
  const count = await archiveProjectWithFeedback({
    projectId: "p1",
    projectName: "Alpha",
    api: {
      archiveProjectSessions: async () => ({ project: {} as never, sessions: [], archivedSessionIds: ["a", "b"] }),
      setArchived: async (id, archived) => { restored.push([id, archived]); return {} as never; },
    },
    showToast: () => -1,
    showUndo: (_message, action) => { undo = action; return 1; },
  });
  assert.equal(count, 2);
  await undo?.();
  assert.deepEqual(restored, [["a", false], ["b", false]]);
});

test("Project archive undo includes sessions whose stops are still pending", async () => {
  const restored: Array<[string, boolean]> = [];
  const messages: string[] = [];
  let undo: (() => void | Promise<void>) | undefined;
  const count = await archiveProjectWithFeedback({
    projectId: "p1",
    projectName: "Alpha",
    api: {
      archiveProjectSessions: async () => ({
        project: {} as never, sessions: [], archivedSessionIds: ["done"], pendingSessionIds: ["running"],
      }),
      setArchived: async (id, archived) => { restored.push([id, archived]); return {} as never; },
    },
    showToast: () => -1,
    showUndo: (message, action) => { messages.push(message); undo = action; return 1; },
  });
  assert.equal(count, 2);
  assert.match(messages[0] ?? "", /waiting for runtime capacity/i);
  await undo?.();
  assert.deepEqual(restored, [["done", false], ["running", false]]);
});

test("older control planes report success without exposing unsafe broad undo", async () => {
  const messages: string[] = [];
  let undoOffered = false;
  const count = await archiveProjectWithFeedback({
    projectId: "p1",
    projectName: "Alpha",
    api: {
      archiveProjectSessions: async () => ({ project: {} as never, sessions: [] }),
      setArchived: async () => ({} as never),
    },
    showToast: (message) => { messages.push(message); return 1; },
    showUndo: () => { undoOffered = true; return 1; },
  });
  assert.equal(count, null);
  assert.equal(undoOffered, false);
  assert.match(messages[0] ?? "", /Exact undo is unavailable/);
});
