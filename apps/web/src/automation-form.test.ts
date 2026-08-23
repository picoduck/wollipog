import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationSpec } from "@wollipog/protocol";
import { buildSpec, defaults, formFrom } from "./automation-form.js";

const CONTEXT = { projectsSupported: false, projects: [] };

function baseSpec(action: AutomationSpec["action"]): AutomationSpec {
  return {
    name: "Nightly Sweep",
    cron: "10 6 * * 1",
    timezone: "America/Chicago",
    enabled: true,
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "expire", afterMinutes: 720 },
    concurrencyPolicy: "skip",
    limits: { maxCostUsd: 8, maxToolCalls: 600 },
    notifications: { pushEvents: ["failed", "expired"] },
    action,
  };
}

/** Loading a stored spec into the form and saving it unchanged must return that exact spec. */
function assertRoundTrips(spec: AutomationSpec): void {
  assert.deepEqual(buildSpec(formFrom(spec), { ...CONTEXT, base: spec }), spec);
}

test("a create-session spec survives an unchanged edit", () => {
  assertRoundTrips(baseSpec({
    kind: "create_session",
    request: {
      runnerId: "local-dev",
      workspaceId: "wollipog",
      agentId: "claude-native",
      prompt: "Run the dead-code sweep.",
      useWorktree: false,
      title: "Maintenance: Dead Code Sweep",
      config: { model: "opus[1m]", effort: "high", permissionMode: "auto", costBudgetUsd: 4, maxToolCalls: 200 },
    },
  }));
});

test("a prompt-session spec keeps its slash command and config", () => {
  assertRoundTrips(baseSpec({
    kind: "prompt_session",
    sessionId: "s_abc123",
    request: { text: "continue", slashCommand: "/review", config: { model: "sonnet" } },
  }));
});

test("a workflow-run spec keeps every field the form does not render", () => {
  assertRoundTrips(baseSpec({
    kind: "workflow_run",
    request: {
      runnerId: "local-dev",
      workspaceId: "wollipog",
      workflowId: "build-review",
      workflowVersion: 1,
      task: "Fix the failing test.",
      title: "Nightly",
      useWorktree: true,
      config: { model: "opus[1m]" },
      costBudgetUsd: 12,
      maxToolCalls: 900,
      agentBindings: { build: "claude-native", review: "codex-native" },
      orchestratorAgentId: "claude-native",
    },
  }));
});

test("an unrelated edit does not disturb config or worktree placement", () => {
  const spec = baseSpec({
    kind: "create_session",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native",
      prompt: "Run the docs freshness sweep.", useWorktree: false,
      config: { permissionMode: "auto" },
    },
  });
  const renamed = { ...formFrom(spec), name: "Docs Freshness" };
  const saved = buildSpec(renamed, { ...CONTEXT, base: spec });
  assert.equal(saved.name, "Docs Freshness");
  assert.equal(saved.action.kind, "create_session");
  assert(saved.action.kind === "create_session");
  assert.deepEqual(saved.action.request.config, { permissionMode: "auto" });
  assert.equal(saved.action.request.useWorktree, false);
});

test("clearing a model selection removes it instead of restoring the stored value", () => {
  const spec = baseSpec({
    kind: "create_session",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native",
      prompt: "Sweep.", useWorktree: false,
      config: { model: "opus[1m]", effort: "high", costBudgetUsd: 4 },
    },
  });
  const cleared = { ...formFrom(spec), model: "", effort: "" };
  const saved = buildSpec(cleared, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "create_session");
  // The ceilings have no control and survive; the rendered knobs are cleared outright.
  assert.deepEqual(saved.action.request.config, { costBudgetUsd: 4 });
});

test("a create-session automation with no selections stores no config", () => {
  const form = {
    ...defaults(),
    name: "New", runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native", prompt: "Go.",
  };
  const saved = buildSpec(form, CONTEXT);
  assert(saved.action.kind === "create_session");
  assert.equal(saved.action.request.config, undefined);
  assert.equal(saved.action.request.useWorktree, true);
});

test("switching the selected workflow drops bindings that belonged to the old graph", () => {
  const spec = baseSpec({
    kind: "workflow_run",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", workflowId: "build-review", workflowVersion: 3,
      task: "Go.", agentBindings: { build: "claude-native" }, orchestratorAgentId: "claude-native",
      costBudgetUsd: 12,
    },
  });
  const switched = { ...formFrom(spec), workflowId: "other-workflow" };
  const saved = buildSpec(switched, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "workflow_run");
  assert.equal(saved.action.request.workflowVersion, undefined);
  assert.equal(saved.action.request.agentBindings, undefined);
  assert.equal(saved.action.request.orchestratorAgentId, undefined);
  // Workflow-independent ceilings still survive the switch.
  assert.equal(saved.action.request.costBudgetUsd, 12);
});

test("switching action kind does not carry the previous action's fields", () => {
  const spec = baseSpec({
    kind: "create_session",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native",
      prompt: "Sweep.", title: "Maintenance", config: { model: "opus[1m]" },
    },
  });
  const switched = { ...formFrom(spec), actionKind: "prompt_session" as const, sessionId: "s_abc123" };
  const saved = buildSpec(switched, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "prompt_session");
  assert.deepEqual(saved.action.request, { text: "Sweep." });
});
