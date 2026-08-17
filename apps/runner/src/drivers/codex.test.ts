import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import { CodexDriver } from "./codex.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

/**
 * Unit tests for the codex `exec --json` -> SessionEventPayload mapping.
 * These exercise the private `handleEvent` / `handleItem` mappers directly,
 * with NO process spawned. We construct a CodexDriver with minimal options and
 * a fake callbacks object that records every onEvent payload.
 */

function makeDriver(): { driver: CodexDriver; events: SessionEventPayload[]; stderr: string[]; authenticationFailures: () => number } {
  const events: SessionEventPayload[] = [];
  const stderr: string[] = [];
  let authenticationFailures = 0;
  const cb: DriverCallbacks = {
    onEvent: (payload) => events.push(payload),
    onStderr: (text) => stderr.push(text),
    onAuthenticationFailure: () => { authenticationFailures += 1; },
    onExit: () => {},
  };
  const opts: DriverOptions = {
    command: "codex",
    args: [],
    cwd: "/tmp/work",
    env: {},
    config: {},
    context: { kind: "native" },
  };
  return { driver: new CodexDriver(opts, cb), events, stderr, authenticationFailures: () => authenticationFailures };
}

// Convenience accessors for the private mappers.
const handleEvent = (d: CodexDriver, msg: unknown) => (d as any).handleEvent(msg) as string | null;
const handleItem = (d: CodexDriver, phase: string, item: unknown) => (d as any).handleItem(phase, item);
const threadIdOf = (d: CodexDriver) => (d as any).threadId as string | null;

test("thread.started sets the threadId and returns null", () => {
  const { driver } = makeDriver();
  assert.equal(threadIdOf(driver), null);
  const r = handleEvent(driver, { type: "thread.started", thread_id: "thread-abc" });
  assert.equal(r, null);
  assert.equal(threadIdOf(driver), "thread-abc");
});

test("provider 401 emits an auth signal without exposing the raw error", () => {
  const h = makeDriver();
  const raw = "401 Unauthorized: missing bearer token secret-value";
  assert.equal(handleEvent(h.driver, { type: "error", message: raw }), "refusal");
  assert.equal(h.authenticationFailures(), 1);
  assert.deepEqual(h.events, []);
  assert.equal(h.stderr.join("\n").includes(raw), false);
});

test("resumeId pre-seeds the threadId so the next turn resumes (Phase 2)", () => {
  const cb: DriverCallbacks = { onEvent: () => {}, onStderr: () => {}, onExit: () => {} };
  const opts: DriverOptions = {
    command: "codex",
    args: [],
    cwd: "/tmp/work",
    env: {},
    config: {},
    context: { kind: "native" },
    resumeId: "thread-resumed",
  };
  const driver = new CodexDriver(opts, cb);
  assert.equal(threadIdOf(driver), "thread-resumed");
  assert.equal(driver.agentSessionId(), "thread-resumed");
});

test("thread.started without thread_id leaves threadId unchanged", () => {
  const { driver } = makeDriver();
  handleEvent(driver, { type: "thread.started", thread_id: "first" });
  handleEvent(driver, { type: "thread.started" }); // missing thread_id
  assert.equal(threadIdOf(driver), "first");
});

test("turn.started returns null and emits nothing", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "turn.started" });
  assert.equal(r, null);
  assert.equal(events.length, 0);
});

test("Codex exec cancel settles an active child as cancelled", async () => {
  const events: SessionEventPayload[] = [];
  const driver = new CodexDriver({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: {},
    config: {},
    context: { kind: "native" },
  }, {
    onEvent: (payload) => events.push(payload),
    onStderr: () => {},
    onExit: () => {},
  });
  try {
    const turn = driver.prompt("cancel this turn");
    for (let attempt = 0; attempt < 200 && driver.pid == null; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(driver.pid, "the fake Codex exec child started");
    driver.cancel();
    assert.equal(await turn, "cancelled");
    assert.equal(events.some((event) => event.kind === "error"), false);
  } finally {
    driver.dispose();
  }
});

test("item.completed agent_message -> agent_message event", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, {
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "hello world" },
  });
  assert.equal(r, null);
  assert.deepEqual(events, [{ kind: "agent_message", text: "hello world", messageId: "i1", final: true }]);
});

test("agent_message only emits on item.completed, not item.started", () => {
  const { driver, events } = makeDriver();
  handleEvent(driver, {
    type: "item.started",
    item: { id: "i1", type: "agent_message", text: "partial" },
  });
  assert.equal(events.length, 0, "no event on item.started");
  handleEvent(driver, {
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "" },
  });
  assert.equal(events.length, 0, "empty text is guarded out even on completed");
});

test("reasoning emits only the observed authoritative item.completed boundary", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.started", { id: "r1", type: "reasoning", text: "partial" });
  handleItem(driver, "item.updated", { id: "r1", type: "reasoning", text: "partial update" });
  assert.equal(events.length, 0, "pre-completion reasoning never creates an old-client duplicate");
  handleItem(driver, "item.completed", { id: "r1", type: "reasoning", text: "thinking complete" });
  assert.deepEqual(events, [{ kind: "agent_thought", text: "thinking complete", messageId: "r1", final: true }]);
});

test("a failed turn does not publish hypothetical pre-completion reasoning", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.started", { id: "r1", type: "reasoning", text: "partial" });
  const result = handleEvent(driver, { type: "turn.failed", error: { message: "provider failure" } });
  assert.equal(result, "refusal");
  assert.deepEqual(events, [{ kind: "error", message: "provider failure" }]);
});

test("distinct completed Codex exec items retain distinct provider identities", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", { id: "first", type: "agent_message", text: "First." });
  handleItem(driver, "item.completed", { id: "second", type: "agent_message", text: "Second." });
  assert.deepEqual(events.map((event) => event.kind === "agent_message" ? event.messageId : null), ["first", "second"]);
  assert.equal(events.every((event) => event.kind === "agent_message" && event.final === true), true);
});

test("malformed Codex exec item identity cannot escape into normalized message metadata", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", { id: 17, type: "agent_message", text: "answer" });
  assert.deepEqual(events, [{ kind: "agent_message", text: "answer", messageId: "item-17", final: true }]);
});

test("distinct numeric Codex exec item identities remain distinct tool calls", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.started", { id: 17, type: "command_execution", command: "first" });
  handleItem(driver, "item.started", { id: 18, type: "command_execution", command: "second" });
  assert.deepEqual(events.filter((event) => event.kind === "tool_call").map((event) => event.toolCallId), [
    "item-17",
    "item-18",
  ]);
});

test("command_execution: started -> tool_call, completed (same id) -> tool_call_update", () => {
  const { driver, events } = makeDriver();

  // First sighting: item.started -> a single tool_call.
  handleItem(driver, "item.started", {
    id: "cmd-1",
    type: "command_execution",
    command: "ls -la",
  });
  assert.deepEqual(events, [
    {
      kind: "tool_call",
      toolCallId: "cmd-1",
      title: "$ ls -la",
      toolKind: "execute",
      status: "in_progress",
    },
  ]);

  // Later sighting for SAME id: item.completed -> tool_call_update (dedup).
  events.length = 0;
  handleItem(driver, "item.completed", {
    id: "cmd-1",
    type: "command_execution",
    command: "ls -la",
    exit_code: 0,
    aggregated_output: "file1\nfile2",
  });
  assert.deepEqual(events, [
    { kind: "tool_call_update", toolCallId: "cmd-1", status: "completed" },
    { kind: "command_output", text: "file1\nfile2" },
  ]);
});

test("command_execution completed status: failed when exit_code !== 0 and status !== completed", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", {
    id: "cmd-f",
    type: "command_execution",
    command: "false",
    exit_code: 1,
  });
  // First sighting => tool_call (not update) with failed status.
  assert.equal(events[0].kind, "tool_call");
  assert.equal((events[0] as any).status, "failed");
});

test("command_execution completed: status 'completed' overrides nonzero exit_code", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", {
    id: "cmd-s",
    type: "command_execution",
    command: "x",
    exit_code: 7,
    status: "completed",
  });
  assert.equal((events[0] as any).status, "completed");
});

test("file_change -> one file_edit per change plus a tool_call", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", {
    id: "fc-1",
    type: "file_change",
    changes: [
      { path: "a.ts", diff: "@@ a" },
      { path: "b.ts", diff: "@@ b" },
      { /* no path */ diff: "ignored" },
    ],
  });
  assert.deepEqual(events, [
    { kind: "file_edit", path: "a.ts", diff: "@@ a" },
    { kind: "file_edit", path: "b.ts", diff: "@@ b" },
    {
      kind: "tool_call",
      toolCallId: "fc-1",
      title: "edit 3 file(s)",
      toolKind: "edit",
      status: "completed",
    },
  ]);
});

test("file_change dedup: second sighting of same id -> tool_call_update", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.started", { id: "fc-2", type: "file_change", changes: [{ path: "a.ts" }] });
  // first => tool_call (in_progress)
  const firstToolCall = events.find((e) => e.kind === "tool_call");
  assert.ok(firstToolCall);
  assert.equal((firstToolCall as any).status, "in_progress");

  events.length = 0;
  handleItem(driver, "item.completed", { id: "fc-2", type: "file_change", changes: [{ path: "a.ts" }] });
  assert.ok(events.some((e) => e.kind === "file_edit"));
  const upd = events.find((e) => e.kind === "tool_call_update");
  assert.ok(upd);
  assert.equal((upd as any).status, "completed");
  assert.ok(!events.some((e) => e.kind === "tool_call"), "no second tool_call for same id");
});

test("todo_list -> plan event with mapped statuses", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", {
    id: "t1",
    type: "todo_list",
    items: [
      { text: "done item", completed: true },
      { content: "running", status: "in_progress" },
      { text: "future", status: "pending" },
      { text: "also done", status: "completed" },
    ],
  });
  assert.deepEqual(events, [
    {
      kind: "plan",
      entries: [
        { content: "done item", status: "completed" },
        { content: "running", status: "in_progress" },
        { content: "future", status: "pending" },
        { content: "also done", status: "completed" },
      ],
    },
  ]);
});

test("todo_list with no items emits nothing", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", { id: "t2", type: "todo_list", items: [] });
  assert.equal(events.length, 0);
});

test("turn.completed -> token_usage with input/output/cached tokens, returns end_turn", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, {
    type: "turn.completed",
    usage: { input_tokens: 100, output_tokens: 42, cached_input_tokens: 10 },
  });
  assert.equal(r, "end_turn");
  assert.deepEqual(events, [
    { kind: "token_usage", inputTokens: 100, outputTokens: 42, cachedInputTokens: 10 },
  ]);
});

test("turn.completed without usage still emits a token_usage with undefined fields", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "turn.completed" });
  assert.equal(r, "end_turn");
  assert.deepEqual(events, [
    { kind: "token_usage", inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined },
  ]);
});

test("error event -> error payload + returns refusal", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "error", message: "boom" });
  assert.equal(r, "refusal");
  assert.deepEqual(events, [{ kind: "error", message: "boom" }]);
});

test("error event without message falls back to default text", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "error" });
  assert.equal(r, "refusal");
  assert.deepEqual(events, [{ kind: "error", message: "codex error" }]);
});

test("turn.failed -> error payload (when error.message present) + returns refusal", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "turn.failed", error: { message: "model refused" } });
  assert.equal(r, "refusal");
  assert.deepEqual(events, [{ kind: "error", message: "model refused" }]);
});

test("turn.failed without error.message still returns refusal but emits nothing", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "turn.failed" });
  assert.equal(r, "refusal");
  assert.equal(events.length, 0);
});

test("unknown event type returns null and emits nothing", () => {
  const { driver, events } = makeDriver();
  const r = handleEvent(driver, { type: "something.else" });
  assert.equal(r, null);
  assert.equal(events.length, 0);
});

test("handleItem with null item is a no-op", () => {
  const { driver, events } = makeDriver();
  handleItem(driver, "item.completed", null);
  assert.equal(events.length, 0);
});

test("command_execution title truncates long commands", () => {
  const { driver, events } = makeDriver();
  const longCmd = "x".repeat(200);
  handleItem(driver, "item.started", { id: "c", type: "command_execution", command: longCmd });
  const title = (events[0] as any).title as string;
  // "$ " prefix + 80 chars + ellipsis
  assert.ok(title.startsWith("$ "));
  assert.ok(title.endsWith("…"));
  assert.equal(title.length, "$ ".length + 80 + 1);
});

test("dedup is keyed by item id (default 'item' when id missing)", () => {
  const { driver, events } = makeDriver();
  // Two items with no id collapse onto the same default key "item".
  handleItem(driver, "item.started", { type: "command_execution", command: "a" });
  handleItem(driver, "item.started", { type: "command_execution", command: "b" });
  const kinds = events.filter((e) => e.kind === "tool_call" || e.kind === "tool_call_update").map((e) => e.kind);
  assert.deepEqual(kinds, ["tool_call", "tool_call_update"]);
});

test("disposed driver: handleEvent short-circuits to null", () => {
  const { driver, events } = makeDriver();
  driver.dispose();
  const r = handleEvent(driver, { type: "thread.started", thread_id: "x" });
  assert.equal(r, null);
  assert.equal(threadIdOf(driver), null, "thread id not set when disposed");
  assert.equal(events.length, 0);
});
