import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../api.js";
import { statusMeta } from "../status-meta.js";
import {
  agentAvailabilityLabel,
  availableAgentCount,
  lifecycleConflictPresentation,
} from "./RunnersView.js";

test("Connections counts only verified runnable agents and labels legacy rows unverified", () => {
  const base = { name: "Agent", command: "agent", args: [], env: {} };
  const agents = [
    { ...base, id: "verified", available: true },
    { ...base, id: "unavailable", available: false },
    { ...base, id: "legacy" },
  ];
  assert.equal(availableAgentCount(agents), 1);
  assert.equal(agentAvailabilityLabel(agents[0]!), "Available");
  assert.equal(agentAvailabilityLabel(agents[1]!), "Unavailable");
  assert.equal(agentAvailabilityLabel(agents[2]!), "Unverified");
});

test("runner lifecycle conflicts list every named session as a confirmation detail row", () => {
  const error = new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", {
    activeSessionCount: 8,
    activeSessions: [
      { title: "  # AGENTS.md\n\n   Review   the project  ", status: "idle" },
      { title: "Ship <unsafe> markup", status: "input_required" },
      { title: "", status: "running" },
      { title: 42, status: null },
      { title: "A newer server's state", status: "hibernating" },
      { title: "The sixth row is listed; the dialog counts it in \"and N more\"", status: "idle" },
    ],
  });

  const conflict = lifecycleConflictPresentation(error, "update");
  assert.equal(conflict.message, "Updating this runner will interrupt 8 active sessions.");
  assert.deepEqual(conflict.detailRows, [
    { label: "# AGENTS.md Review the project", status: statusMeta("session", "idle") },
    { label: "Ship <unsafe> markup", status: statusMeta("session", "input_required") },
    { label: "Untitled Session", status: statusMeta("session", "running") },
    { label: "Untitled Session" },
    { label: "A newer server's state", status: statusMeta("session", "hibernating") },
    { label: "The sixth row is listed; the dialog counts it in \"and N more\"", status: statusMeta("session", "idle") },
  ]);
  // The status reads from the one vocabulary, never the raw wire value.
  assert.deepEqual(conflict.detailRows.map((row) => row.status?.label), [
    "Awaiting Prompt", "Awaiting Input", "Running", undefined, "Status Unavailable", "Awaiting Prompt",
  ]);
  // Two sessions were counted but not listed (beyond the server's limit, or not visible here).
  assert.equal(conflict.detailRowsOverflow, 2);
});

test("runner lifecycle conflicts stay useful when the server omits session details", () => {
  const conflict = lifecycleConflictPresentation(
    new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS"),
    "reconnect",
  );
  assert.equal(conflict.message, "Reconnecting this runner will interrupt active work.");
  assert.deepEqual(conflict.detailRows, []);
  assert.equal(conflict.detailRowsOverflow, 0);
});

test("legacy adoption conflict copy preserves the explicit migration action", () => {
  const conflict = lifecycleConflictPresentation(
    new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", { activeSessionCount: 1 }),
    "adopt",
  );
  assert.equal(conflict.message, "Adopting legacy data for this runner will interrupt 1 active session.");
});
