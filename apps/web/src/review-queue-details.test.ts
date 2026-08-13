import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalQueueItem } from "@wollipog/protocol";
import { approvalQueueDetail } from "./review-queue-details.js";

function item(input?: string, toolName?: string): ApprovalQueueItem {
  return {
    sessionId: "session-1",
    requestId: "request-1",
    sessionTitle: "Deploy",
    runnerId: "runner-1",
    runnerOnline: true,
    approval: {
      requestId: "request-1",
      title: "Run deployment command",
      options: [],
      context: { ...(input === undefined ? {} : { input }), ...(toolName === undefined ? {} : { toolName }) },
    },
    provenance: {
      source: "session",
      requestedAt: 1,
      actor: { kind: "agent", id: "codex" },
      scope: { sessionId: "session-1", runnerId: "runner-1", timestamp: 1 },
    },
    bulkActions: ["reject"],
  };
}

test("approval queue detail preserves the exact bounded input", () => {
  const exact = "git diff --cached\n  -- src/file with spaces.ts\n";
  assert.deepEqual(approvalQueueDetail(item(exact, "shell_command")), {
    label: "Exact Command or Tool Input · shell_command",
    input: exact,
  });
});

test("approval queue detail does not invent input for legacy or context-free requests", () => {
  assert.equal(approvalQueueDetail(item()), null);
  assert.equal(approvalQueueDetail(item("")), null);
});
