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

test("slash commands and inherited settings are readable before opening full configuration", () => {
  const prompt = structuredClone(fixture);
  prompt.spec.action = { kind: "prompt_session", sessionId: "target", request: { text: "", slashCommand: "/inspect-ci" } };
  prompt.effectiveTargets = [{ runnerId: "machine", workspaceId: "workspace", agentId: "agent", role: "agent",
    config: { model: "current-model", permissionMode: "read-only" } }];
  const promptFacts = renderToStaticMarkup(<AutomationCreationSummary snapshot={prompt} />).split("<details>")[0]!;
  assert.ok(promptFacts.includes("/inspect-ci"));
  assert.ok(promptFacts.includes("Inherit at Run Time"));
  assert.ok(promptFacts.includes("current-model"));
  assert.ok(promptFacts.includes("does not override future session settings"));

});

test("assistant automation preview renders project, location, delegated decisions and campaign allowance", () => {
  const snapshot = structuredClone(fixture);
  if (snapshot.spec.action.kind !== "create_session") assert.fail();
  Object.assign(snapshot.spec.action.request, {
    role: "orchestrator",
    campaign: {
      controlMode: "full_control",
      repository: "picoduck/wollipog",
      tasks: [{ key: "sweep", title: "Weekly Sweep", prompt: "Inspect health without changes." }],
    },
  });
  const html = renderToStaticMarkup(
    <AutomationCreationSummary
      snapshot={snapshot}
      targetDisplay={{
        projectName: "Core Platform",
        locationName: "Main Checkout",
        locationPath: "/srv/wollipog",
        runnerName: "Primary Machine",
        workspaceName: "Main Workspace",
        workspacePath: "/srv/wollipog",
      }}
      campaignDecisions={{
        controlMode: "full_control",
        parentControl: "questions",
        decisions: { pr_merge: "human", implementation_question: "orchestrator" },
        fullControlOperations: ["implementation_question", "follow_up_issue_publication"],
        delegatablePolicyIds: ["policy_readonly"],
        budget: { costUsd: 5, toolCalls: 50, concurrency: 2, acceptedFollowUps: 1 },
      }}
    />,
  ).split("<details>")[0]!;
  for (const expected of [
    "Core Platform (project)",
    "Execution Location",
    "Main Checkout (location)",
    "/srv/wollipog",
    "Primary Machine (machine)",
    "Parent Control",
    "Questions",
    "Decision Owners",
    "PR Merge: Human",
    "Implementation Question: Orchestrator",
    "Delegated Operations",
    "Follow Up Issue Publication",
    "policy_readonly",
    "$5 USD · 50 tool calls · 2 concurrent children · 1 accepted follow-ups",
    "Weekly Sweep",
    "Inspect health without changes.",
  ]) {
    assert.ok(html.includes(expected), `expected summary to include ${expected}`);
  }
});
