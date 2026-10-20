import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationCreationSummary } from "./AutomationCreationSummary.js";
import type { AutomationCreationSnapshot } from "@wollipog/protocol";

export const fixture: AutomationCreationSnapshot = { category: "automation_creation", targetDigest: "a".repeat(64),
  requestedSpecDigest: "b".repeat(64), nextFireAt: Date.parse("2026-10-21T06:00:00Z"), expiresAt: Date.parse("2026-10-21T05:00:00Z"),
  spec: { name: "Daily CI Review", cron: "0 6 * * *", timezone: "UTC", enabled: true,
    action: { kind: "create_session", request: { runnerId: "machine", workspaceId: "workspace", agentId: "agent",
      projectId: "project", projectLocationId: "location", useWorktree: true,
      config: { model: "example-model", effort: "high", permissionMode: "default" }, prompt: "Inspect CI. <literal>\nKeep every guard." },
      installationBindings: { agent: { driver: "acp", context: { kind: "native" }, installationId: "installation" } } },
    limits: { maxCostUsd: 5, maxToolCalls: 50 }, concurrencyPolicy: "wait", misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" }, notifications: { pushEvents: ["succeeded", "failed"] } } };

test("automation human card exposes exact configuration and escaped prompt", () => {
  const html = renderToStaticMarkup(<AutomationCreationSummary snapshot={fixture} />);
  for (const expected of ["Daily CI Review", "Create Session", "0 6 * * *", "UTC", "2026-10-21T06:00:00.000Z",
    "Enabled", "example-model", "high", "default", "Worktree", "$5", "50", "installation", "location",
    "Inspect CI. &lt;literal&gt;", "Keep every guard.", "Full Configuration", "misfirePolicy", "concurrencyPolicy", "notifications"]) {
    assert.ok(html.includes(expected), expected);
  }
  assert.ok(!html.includes("Inspect CI. <literal>"));
});
