import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveProjectWithFeedback,
  projectArchiveMessage,
  projectArchiveResultMessage,
  projectArchiveResultTone,
} from "./project-actions.js";

test("durable Project archive offers exact undo only for sessions changed by the server", async () => {
  const restored: Array<[string, boolean]> = [];
  const tones: unknown[] = [];
  let undo: (() => void | Promise<void>) | undefined;
  const count = await archiveProjectWithFeedback({
    projectId: "p1",
    projectName: "Alpha",
    api: {
      archiveProjectSessions: async () => ({ project: {} as never, sessions: [], archivedSessionIds: ["a", "b"] }),
      setArchived: async (id, archived) => { restored.push([id, archived]); return {} as never; },
    },
    showToast: () => -1,
    showUndo: (_message, action, tone) => { undo = action; tones.push(tone); return 1; },
  });
  assert.equal(count, 2);
  assert.deepEqual(tones, ["success"]);
  await undo?.();
  assert.deepEqual(restored, [["a", false], ["b", false]]);
});

test("Project archive undo includes sessions whose stops are still pending", async () => {
  const restored: Array<[string, boolean]> = [];
  const messages: string[] = [];
  const tones: unknown[] = [];
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
    showUndo: (message, action, tone) => { messages.push(message); tones.push(tone); undo = action; return 1; },
  });
  assert.equal(count, 2);
  assert.equal(messages[0], "Archiving from Alpha. 1 session is still stopping.");
  assert.deepEqual(tones, ["info"], "a stop still running is not presented as a success (#2333)");
  await undo?.();
  assert.deepEqual(restored, [["done", false], ["running", false]]);
});

test("Project archive reports a failed stop as possibly still running, with Retry Stop", async () => {
  const restored: Array<[string, boolean]> = [];
  const messages: string[] = [];
  const tones: unknown[] = [];
  let undo: (() => void | Promise<void>) | undefined;
  const count = await archiveProjectWithFeedback({
    projectId: "p1",
    projectName: "Alpha",
    api: {
      archiveProjectSessions: async () => ({
        project: {} as never,
        sessions: [],
        archivedSessionIds: ["done"],
        failedSessionIds: ["failed-stop"],
      }),
      setArchived: async (id, archived) => { restored.push([id, archived]); return {} as never; },
    },
    showToast: () => -1,
    showUndo: (message, action, tone) => { messages.push(message); tones.push(tone); undo = action; return 1; },
  });
  assert.equal(count, 2);
  assert.equal(messages[0], "The stop failed for 1 session in Alpha, so it may still be running. Use Retry Stop to try again.");
  assert.deepEqual(tones, ["warning"], "a failed stop is a warning that stays until dismissed (#2333)");
  await undo?.();
  assert.deepEqual(restored, [["done", false], ["failed-stop", false]]);
});

test("older servers report success without exposing unsafe broad undo", async () => {
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
  assert.equal(messages[0], "Sessions archived from Alpha. Undo isn't available for this archive.");
});

test("Project archive results follow the single-session wording in plural forms", () => {
  const result = (archived: number, pending: number, failed: number) =>
    projectArchiveResultMessage("Alpha", { archived, pending, failed });
  assert.equal(result(1, 0, 0), "1 session archived from Alpha.");
  assert.equal(result(3, 0, 0), "3 sessions archived from Alpha.");
  assert.equal(result(1, 2, 0), "Archiving from Alpha. 2 sessions are still stopping.");
  assert.equal(result(0, 0, 2), "The stop failed for 2 sessions in Alpha, so they may still be running. Use Retry Stop to try again.");
  // A failed stop is the outcome to act on, so it outranks sessions that are still stopping.
  assert.equal(result(1, 2, 1), "The stop failed for 1 session in Alpha, so it may still be running. Use Retry Stop to try again.");
});

test("Project archive result tones follow the message's precedence (#2333)", () => {
  assert.equal(projectArchiveResultTone({ pending: 0, failed: 0 }), "success");
  assert.equal(projectArchiveResultTone({ pending: 2, failed: 0 }), "info");
  assert.equal(projectArchiveResultTone({ pending: 0, failed: 1 }), "warning");
  assert.equal(projectArchiveResultTone({ pending: 2, failed: 1 }), "warning");
});

test("Project Archive and Stop confirmations say queued messages are canceled, with no Snooze sentence", () => {
  const message = (count: number, stops: boolean, onProjectPage: boolean) =>
    projectArchiveMessage({ projectName: "Alpha", count, stops, onProjectPage });
  assert.equal(
    message(1, true, false),
    "The session in “Alpha” stops, its queued messages are canceled, and it moves to Archived Sessions. You can restore it later.",
  );
  assert.equal(
    message(3, true, false),
    "All 3 sessions in “Alpha” stop, their queued messages are canceled, and they move to Archived Sessions. You can restore them later.",
  );
  assert.equal(
    message(1, true, true),
    "The unarchived session in “Alpha” stops, its queued messages are canceled, and it moves to Archived Sessions. The Project and its Locations remain, and you can restore the session.",
  );
  assert.equal(
    message(3, true, true),
    "All 3 unarchived sessions in “Alpha” stop, their queued messages are canceled, and they move to Archived Sessions. The Project and its Locations remain, and you can restore the sessions.",
  );
  // Without a stop the copy is unchanged.
  assert.equal(message(3, false, false), "All 3 sessions in “Alpha” move to Archived Sessions. Any that are still running are stopped first.");
  assert.equal(message(1, false, true), "The unarchived session in “Alpha” moves to Archived Sessions. The Project and its Locations remain.");
});
