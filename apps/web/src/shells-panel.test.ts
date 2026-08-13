import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHELL_INPUT_CHUNK_UNITS,
  appendOrderedShellChunk,
  appendScrollback,
  exitedShellsWithoutTabs,
  markShellScrollbacksIncomplete,
  mergeShellChunks,
  shellStreamMayBeIncomplete,
  shellsRemovedAfterReconnect,
  shellsVisibleAfterClose,
  splitShellInput,
  supportsAgentTui,
  supportsInitialNativeTui,
  sessionHasHookGovernance,
  type ShellScrollback,
} from "./shells-panel.js";

test("splitShellInput: small inputs pass through; big pastes chunk in order under the route cap", () => {
  assert.deepEqual(splitShellInput(""), []);
  assert.deepEqual(splitShellInput("ls\n"), ["ls\n"]);
  const big = "x".repeat(SHELL_INPUT_CHUNK_UNITS * 2 + 500);
  const chunks = splitShellInput(big);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length <= SHELL_INPUT_CHUNK_UNITS));
  assert.equal(chunks.join(""), big, "reassembles exactly, in order");
});

test("agent TUI affordance requires a supported provider and v58 runner", () => {
  assert.equal(supportsAgentTui("claude-code", 58, "windows"), true);
  assert.equal(supportsAgentTui("codex-app-server", 58, "linux"), true);
  assert.equal(supportsAgentTui("codex", 58, "windows"), true);
  assert.equal(supportsAgentTui("acp", 58, "linux"), false);
  assert.equal(supportsAgentTui("claude-code", 57, "linux"), false);
  assert.equal(supportsAgentTui("claude-code", 58, "macos"), false);
  assert.equal(supportsAgentTui(undefined, 58, "windows"), false);
});

test("initial Native TUI launch requires the v67 session-start fence", () => {
  assert.equal(supportsInitialNativeTui("claude-code", 67, "windows"), true);
  assert.equal(supportsInitialNativeTui("codex-app-server", 67, "linux"), true);
  assert.equal(supportsInitialNativeTui("claude-code", 66, "windows"), false);
  assert.equal(supportsAgentTui("claude-code", 66, "windows"), true, "manual attach remains on v58");
});

test("Native TUI governance copy uses session-scoped post-create hook truth", () => {
  assert.equal(sessionHasHookGovernance(undefined), false);
  assert.equal(sessionHasHookGovernance({ elicitation: { acceptEdits: ["hook"] } }), true);
  assert.equal(sessionHasHookGovernance({ elicitation: { acceptEdits: ["stdio-control"] } }), false);
});

test("splitShellInput never splits a surrogate pair", () => {
  // Fill so an emoji (surrogate pair) straddles the chunk boundary.
  const data = "a".repeat(9) + "😀😀";
  const chunks = splitShellInput(data, 10); // boundary would land between the pair's halves
  assert.equal(chunks.join(""), data);
  for (const c of chunks) {
    const first = c.charCodeAt(0);
    const last = c.charCodeAt(c.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "no chunk starts with a lone low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "no chunk ends with a lone high surrogate");
  }
});

test("appendScrollback grows freely under the cap and front-trims on line boundaries over it", () => {
  assert.equal(appendScrollback("a\n", "b\n", 100), "a\nb\n");
  const big = appendScrollback("x".repeat(90) + "\n", "y".repeat(20) + "\n", 100);
  assert.ok(big.length <= 100);
  assert.ok(big.endsWith("y".repeat(20) + "\n"), "newest output kept");
  assert.ok(!big.startsWith("x") || big.indexOf("\n") === big.length - 1, "front partial line dropped");
  // single giant line: cap still enforced even without a newline to trim at
  const oneLine = appendScrollback("", "z".repeat(500), 100);
  assert.equal(oneLine.length, 100);
});

test("slow-client recovery marks retained ephemeral shell tails as incomplete without mutating them", () => {
  const before: ShellScrollback = {
    sessionId: "session-a", text: "tail", total: 4, exited: false, exitCode: null, chunks: [], revision: 0,
  };
  const exited: ShellScrollback = {
    sessionId: "session-a", text: "complete", total: 8, exited: true, exitCode: 0, chunks: [], revision: 0,
  };
  const source = new Map([["shell-a", before], ["shell-complete", exited]]);
  const marked = markShellScrollbacksIncomplete(source);
  assert.equal(source.get("shell-a"), before);
  assert.equal(source.get("shell-a")?.incomplete, undefined);
  assert.deepEqual(marked.get("shell-a"), { ...before, incomplete: true });
  assert.equal(marked.get("shell-complete"), exited, "completed transcript identity is preserved");
  assert.equal(markShellScrollbacksIncomplete(new Map([["shell-complete", exited]])).get("shell-complete"), exited);
});

test("late exit echoes without a visible tab are eligible for cache pruning", () => {
  const live: ShellScrollback = {
    sessionId: "session-a", text: "live", total: 4, exited: false, exitCode: null, chunks: [], revision: 0,
  };
  const exited: ShellScrollback = {
    sessionId: "session-a", text: "done", total: 4, exited: true, exitCode: 0, chunks: [], revision: 0,
  };
  const scrollbacks = new Map([
    ["tabbed-exit", exited],
    ["late-exit", exited],
    ["unknown-live", live],
    ["other-session", { ...exited, sessionId: "session-b" }],
  ]);
  assert.deepEqual(
    exitedShellsWithoutTabs([{ shellId: "tabbed-exit" }], scrollbacks, "session-a"),
    ["late-exit"],
  );
  assert.deepEqual(exitedShellsWithoutTabs(null, scrollbacks, "session-a"), []);
});

test("shell stream gap semantics cover overload and abnormal transport closes only", () => {
  assert.equal(shellStreamMayBeIncomplete(1013), true);
  assert.equal(shellStreamMayBeIncomplete(1011), true);
  assert.equal(shellStreamMayBeIncomplete(1006), true);
  assert.equal(shellStreamMayBeIncomplete(1000), false);
  assert.equal(shellStreamMayBeIncomplete(1008), false);
});

test("shell reconnect reconciliation identifies only registry-absent tabs", () => {
  assert.deepEqual(
    [...shellsRemovedAfterReconnect(
      [{ shellId: "gone" }, { shellId: "kept" }],
      [{ shellId: "kept" }, { shellId: "new" }],
    )],
    ["gone"],
  );
  assert.equal(shellsRemovedAfterReconnect(null, [{ shellId: "new" }]).size, 0);
});

test("registry refreshes cannot resurrect a shell while its explicit close is awaiting exit", () => {
  const registry = [{ shellId: "closing" }, { shellId: "live" }];
  assert.deepEqual(shellsVisibleAfterClose(registry, new Set(["closing"])), [{ shellId: "live" }]);
  assert.deepEqual(registry, [{ shellId: "closing" }, { shellId: "live" }], "registry input is not mutated");
});

test("durable history and live shell chunks merge idempotently by sequence", () => {
  const merged = mergeShellChunks(
    [{ seq: 2, stream: "stdout", data: "two" }],
    [
      { seq: 1, stream: "stdout", data: "one" },
      { seq: 2, stream: "stdout", data: "two" },
      { seq: 3, stream: "stderr", data: "three" },
    ],
  );
  assert.deepEqual(merged.map((chunk) => chunk.seq), [1, 2, 3]);
  assert.equal(merged.map((chunk) => chunk.data).join(""), "onetwothree");
  assert.deepEqual(mergeShellChunks([], merged, 8).map((chunk) => chunk.seq), [2, 3]);
});

test("ordered live chunks append without sorting and retain bounded chars/chunks", () => {
  const first = { seq: 1, stream: "stdout" as const, data: "ab" };
  const second = { seq: 2, stream: "stdout" as const, data: "cd" };
  const originalSort = Array.prototype.sort;
  Array.prototype.sort = function forbiddenSort() { throw new Error("ordered append must not sort"); };
  try {
    const appended = appendOrderedShellChunk(
      [first, second],
      "abcd",
      { seq: 3, stream: "stderr", data: "ef" },
      5,
      3,
    );
    assert.equal(appended.text, "cdef");
    assert.deepEqual(appended.chunks.map((chunk) => chunk.seq), [2, 3]);
    assert.equal(appended.chunks[0], second, "retained chunk identity is preserved");

    let chunks = [] as Array<{ seq: number; stream: "stdout"; data: string }>;
    let text = "";
    for (let seq = 1; seq <= 3_000; seq++) {
      ({ chunks, text } = appendOrderedShellChunk(chunks, text, { seq, stream: "stdout", data: "x" }));
    }
    assert.equal(chunks.length, 2_048);
    assert.equal(chunks[0]?.seq, 953);
    assert.equal(text.length, 2_048);
  } finally {
    Array.prototype.sort = originalSort;
  }
});
