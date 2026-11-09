import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationCreationSummary } from "./AutomationCreationSummary.js";
import type { AutomationCreationSnapshot } from "@wollipog/protocol";

export const fixture: AutomationCreationSnapshot = { category: "automation_creation", targetDigest: "a".repeat(64),
  effectiveTargets: [],
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

test("campaign approval exposes authority overrides and account placement before collapsed configuration", () => {
  const snapshot = structuredClone(fixture);
  if (snapshot.spec.action.kind !== "create_session") assert.fail();
  Object.assign(snapshot.spec.action.request, { role: "orchestrator", providerAccountId: "selected-account",
    executionTargetId: "selected-target", campaign: { controlMode: "full_control", repository: "example/repo",
      fullControl: { issues: { maxIssues: 7 }, budget: { acceptedFollowUps: 3 } }, tasks: [{ key: "daily", title: "Daily Review", prompt: "Review findings." }] } });
  const facts = renderToStaticMarkup(<AutomationCreationSummary snapshot={snapshot} />).split("<details>")[0]!;
  for (const expected of ["Full Control Overrides", "maxIssues", "acceptedFollowUps", "selected-account", "selected-target", "Review findings."]) {
    assert.ok(facts.includes(expected), expected);
  }
});

test("slash commands, workflow identity and inherited settings are readable before opening full configuration", () => {
  const prompt = structuredClone(fixture);
  prompt.spec.action = { kind: "prompt_session", sessionId: "target", request: { text: "", slashCommand: "/inspect-ci" } };
  prompt.effectiveTargets = [{ runnerId: "machine", workspaceId: "workspace", agentId: "agent", role: "agent",
    config: { model: "current-model", permissionMode: "read-only" } }];
  const promptFacts = renderToStaticMarkup(<AutomationCreationSummary snapshot={prompt} />).split("<details>")[0]!;
  assert.ok(promptFacts.includes("/inspect-ci"));
  assert.ok(promptFacts.includes("Inherit at Run Time"));
  assert.ok(promptFacts.includes("current-model"));
  assert.ok(promptFacts.includes("does not override future session settings"));
  const workflow = structuredClone(fixture);
  workflow.spec.action = { kind: "workflow_run", request: { runnerId: "machine", workspaceId: "workspace", workflowId: "health-workflow", workflowVersion: 3, task: "Inspect CI" } };
  const workflowFacts = renderToStaticMarkup(<AutomationCreationSummary snapshot={workflow} />).split("<details>")[0]!;
  assert.ok(workflowFacts.includes("health-workflow"));
  assert.ok(workflowFacts.includes("Workflow Version"));
  assert.match(workflowFacts, /<dd>3<\/dd>/);
});
