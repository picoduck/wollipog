import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEventPayload } from "@wollipog/protocol";
import {
  TURN_DIFF_MAX_BYTES,
  boundHistoryPayload,
  boundTurnDiff,
  diffFileCount,
  oversizedTurnDiffSummary,
} from "./history-event-bound.js";
import { HISTORY_PAGE_MAX_BYTES, SessionStore, type SessionMeta } from "./session-store.js";

function fileDiff(path: string, bodyBytes: number): string {
  const line = `+${"x".repeat(99)}\n`;
  const lines = Math.max(1, Math.ceil(bodyBytes / line.length));
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines} @@\n${line.repeat(lines)}`;
}

function meta(sessionId: string): SessionMeta {
  return {
    sessionId, agentId: "codex-native", workspaceId: "repo", repoPath: "/repo", worktreePath: null,
    driver: "codex", command: "codex", args: [], env: {}, context: { kind: "native" },
    agentSessionId: null, status: "idle", title: "Bounded", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, turnCount: 0, seq: 0, createdAt: 1, updatedAt: 1,
  };
}

test("a turn diff within the limit is kept byte for byte", () => {
  const diff = fileDiff("a.txt", 1_000) + fileDiff("b.txt", 1_000);
  assert.equal(boundTurnDiff(diff), diff);
});

test("an oversized turn diff keeps whole files that fit behind a summary naming its size and file count", () => {
  const small = fileDiff("small.txt", 10_000);
  const huge = fileDiff("generated.lock", TURN_DIFF_MAX_BYTES + 1_000);
  const tail = fileDiff("tail.txt", 10_000);
  const diff = small + huge + tail;
  const bounded = boundTurnDiff(diff);
  assert.ok(Buffer.byteLength(bounded) <= TURN_DIFF_MAX_BYTES);
  const total = Buffer.byteLength(diff).toLocaleString("en-US");
  assert.match(bounded, new RegExp(`too large to keep in session history: ${total} bytes across 3 files`));
  assert.match(bounded, /2 of 3 files are shown here/);
  // Whole sections only, in their original order; the oversized file is left out entirely.
  assert.ok(bounded.endsWith(small + tail));
  assert.equal(bounded.includes("generated.lock"), false);
  assert.equal(diffFileCount(bounded), 2);
  // The summary adds no lines a diff viewer would count as added or removed.
  const summaryLines = bounded.slice(0, bounded.indexOf("diff --git ")).split("\n");
  assert.equal(summaryLines.some((line) => /^(\+|-|@@|\\|diff --git )/.test(line)), false);
});

test("an unreadably large diff is summarized with a lower bound and no content", () => {
  const summary = oversizedTurnDiffSummary({ bytes: 64 * 1024 * 1024, atLeast: true, files: 1_234, shownFiles: 0 });
  assert.match(summary, /more than 67,108,864 bytes across 1,234 files/);
  assert.match(summary, /0 of 1,234 files are shown here/);
});

test("the history bound shortens only bulky top-level text and keeps identifiers exact", () => {
  const serialize = (payload: SessionEventPayload) => JSON.stringify({ seq: 1, ts: 1, payload });
  const text = `${"a".repeat(3_000_000)}${"z".repeat(3_000_000)}`;
  const payload: SessionEventPayload = { kind: "command_output", text, parentToolUseId: "tool-1" };
  const bounded = boundHistoryPayload(payload, 2 * 1024 * 1024, serialize);
  assert.ok(bounded && bounded.kind === "command_output");
  assert.ok(Buffer.byteLength(serialize(bounded)) <= 2 * 1024 * 1024);
  assert.equal(bounded.parentToolUseId, "tool-1");
  assert.ok(bounded.text.startsWith("aaaa") && bounded.text.endsWith("zzzz"));
  assert.match(bounded.text, /bytes of 6,000,000 bytes left out/);
  assert.equal(boundHistoryPayload(payload, 32 * 1024 * 1024, serialize), payload, "a fitting record is untouched");
  const unboundable: SessionEventPayload = {
    kind: "plan", entries: [{ content: "p".repeat(3_000_000), priority: "high", status: "pending" }],
  };
  assert.equal(boundHistoryPayload(unboundable, 1024 * 1024, serialize), null);
});

test("the store never writes a record its own reader would refuse", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-history-bound-"));
  try {
    const store = new SessionStore(root);
    store.create(meta("s_bound"));
    store.appendEvent("s_bound", { kind: "agent_message", text: "before" });
    const huge = "y".repeat(HISTORY_PAGE_MAX_BYTES + 1024);
    const stored = store.appendEvent("s_bound", { kind: "command_output", text: huge });
    assert.ok(stored?.payload.kind === "command_output");
    assert.ok(stored.payload.text.length < huge.length);
    // A record with no bulky text to shorten is refused before anything is written.
    assert.throws(
      () => store.appendEvent("s_bound", {
        kind: "plan", entries: [{ content: "q".repeat(HISTORY_PAGE_MAX_BYTES), priority: "high", status: "pending" }],
      }),
      /refused to write a plan record/,
    );
    store.appendEvent("s_bound", { kind: "agent_message", text: "after" });
    store.flush("s_bound");
    // A fresh process pages the whole history, in order and gap-free.
    const page = new SessionStore(root).readEventPage("s_bound", { afterSeq: 0, limit: 10 });
    assert.equal(page.ok, true);
    if (page.ok) {
      assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 3]);
      assert.deepEqual(page.events.map((event) => event.payload.kind), ["agent_message", "command_output", "agent_message"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
