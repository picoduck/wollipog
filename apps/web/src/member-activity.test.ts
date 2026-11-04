import assert from "node:assert/strict";
import { test } from "node:test";
import { memberActivity, memberActivityLabel, memberActivityLine } from "./member-activity.js";
import type { TimelineItem } from "./timeline.js";

let id = 0;
const tool = (toolKind: string | undefined, title: string, children?: TimelineItem[]): TimelineItem => ({
  kind: "tool_call", id: ++id, toolCallId: `tool-${id}`, title, toolKind, status: "completed", text: "",
  ...(children ? { children } : {}),
});

test("a member's commands, edits and file reads are counted from its tool calls (#2975)", () => {
  const items: TimelineItem[] = [
    { kind: "user_message", id: ++id, text: "Refactor the scheduler" },
    tool("execute", "$ npm test"),
    tool("execute", "$ git status"),
    tool("execute", "Bash: npm run lint"),
    tool("edit", "Edit: src/scheduler.ts"),
    // The drivers record a file edit beside the Edit's tool call, and the runner a per-turn diff.
    { kind: "file_edit", id: ++id, path: "src/scheduler.ts" },
    { kind: "file_edit", id: ++id, path: "worktree", diff: "+a" },
    { kind: "agent_message", id: ++id, text: "Done." },
  ];
  assert.deepEqual(memberActivity(items), { commands: 3, edits: 1, reads: 0 });
  assert.equal(memberActivityLabel(memberActivity(items)), "3 commands, 1 edit");
});

test("reads leave out searches, and a subagent's work is the member's", () => {
  const items: TimelineItem[] = [
    tool("read", "Read: src/a.ts"),
    tool("read", "Glob: **/*.ts"),
    tool("read", "Grep: misfire"),
    tool("agent", "Task: explore", [tool("read", "Read: src/b.ts"), tool("execute", "$ ls"), tool("edit", "Write: notes.md")]),
    tool("fetch", "WebFetch: https://example.com"),
    tool(undefined, "custom"),
  ];
  assert.deepEqual(memberActivity(items), { commands: 1, edits: 1, reads: 2 });
  assert.equal(memberActivityLabel(memberActivity(items)), "1 command, 1 edit, 2 files read");
});

test("the label names only the kinds the member did, and nothing when it did none", () => {
  assert.equal(memberActivityLabel({ commands: 5, edits: 0, reads: 1 }), "5 commands, 1 file read");
  assert.equal(memberActivityLabel({ commands: 0, edits: 2, reads: 0 }), "2 edits");
  assert.equal(memberActivityLabel({ commands: 1200, edits: 0, reads: 0 }), "1,200 commands");
  assert.equal(memberActivityLabel({ commands: 0, edits: 0, reads: 0 }), null);
  assert.equal(memberActivityLabel(memberActivity([])), null);
});

test("the meta line says Working… while the member runs, and nothing before its history is known", () => {
  const activity = { commands: 3, edits: 1, reads: 0 };
  assert.equal(memberActivityLine(true, activity), "Working…");
  assert.equal(memberActivityLine(true, null), "Working…");
  assert.equal(memberActivityLine(false, activity), "3 commands, 1 edit");
  assert.equal(memberActivityLine(false, { commands: 0, edits: 0, reads: 0 }), "No commands, edits or files read");
  assert.equal(memberActivityLine(false, null), null);
});
