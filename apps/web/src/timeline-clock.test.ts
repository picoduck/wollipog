import assert from "node:assert/strict";
import { test } from "node:test";
import { isTimelineSessionActive } from "./timeline-clock.js";
import type { SessionStatus } from "@wollipog/protocol";

test("timeline clock activity matches every nonterminal turn status", () => {
  const active = new Set<SessionStatus>(["queued", "starting", "running", "input_required"]);
  const statuses: SessionStatus[] = [
    "queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped",
  ];
  for (const status of statuses) {
    assert.equal(isTimelineSessionActive(status), active.has(status), status);
  }
});
