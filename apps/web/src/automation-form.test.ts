import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationSpec } from "@wollipog/protocol";
import {
  buildSpec, defaults, formFrom, sharedCapabilities, withAgent, withCapabilities, withModel,
} from "./automation-form.js";

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

const CAPS = {
  models: [
    { id: "opus[1m]", displayName: "Opus 5", efforts: ["low", "medium", "high"] },
    { id: "haiku", displayName: "Haiku 4.5", efforts: ["low"] },
  ],
  effortLevels: ["low", "medium", "high"],
  permissionModes: ["default", "auto"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
};

test("changing agent clears every agent-scoped selection", () => {
  const form = { ...defaults(), agentId: "claude-native", model: "opus[1m]", effort: "high", permissionMode: "auto" };
  const moved = withAgent(form, "codex-native");
  // Carrying these would save a spec that `capabilityConfigError` rejects at fire time, so the
  // automation would fail on every scheduled run rather than at the moment of the choice.
  assert.deepEqual(
    { agentId: moved.agentId, model: moved.model, effort: moved.effort, permissionMode: moved.permissionMode },
    { agentId: "codex-native", model: "", effort: "", permissionMode: "" },
  );
});

test("changing model drops an effort the new model does not advertise", () => {
  const form = { ...defaults(), model: "opus[1m]", effort: "high", permissionMode: "auto" };
  const narrowed = withModel(form, "haiku", CAPS);
  assert.equal(narrowed.effort, "");
  // Permission mode is agent-scoped, so a model change must not disturb it.
  assert.equal(narrowed.permissionMode, "auto");
});

test("changing model keeps an effort the new model still advertises", () => {
  const form = { ...defaults(), model: "opus[1m]", effort: "low" };
  assert.equal(withModel(form, "haiku", CAPS).effort, "low");
});

test("returning to the agent default validates effort against the agent's levels", () => {
  const form = { ...defaults(), model: "haiku", effort: "low" };
  const cleared = withModel(form, "", CAPS);
  assert.equal(cleared.model, "");
  assert.equal(cleared.effort, "low");
});

test("an unknown agent with no advertised capabilities clears effort rather than guessing", () => {
  const form = { ...defaults(), model: "opus[1m]", effort: "high" };
  assert.equal(withModel(form, "opus[1m]", undefined).effort, "");
});

test("a retargeted prompt session drops the previous session's config", () => {
  const spec = baseSpec({
    kind: "prompt_session", sessionId: "s_old",
    request: { text: "continue", slashCommand: "/review", config: { model: "opus[1m]" } },
  });
  const retargeted = { ...formFrom(spec), sessionId: "s_new" };
  const saved = buildSpec(retargeted, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "prompt_session");
  // The prompt path validates config against the TARGET session's agent.
  assert.equal(saved.action.request.config, undefined);
  assert.equal(saved.action.request.slashCommand, "/review");
});

test("moving a workflow automation to another machine drops runner-scoped carry-overs", () => {
  const spec = baseSpec({
    kind: "workflow_run",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", workflowId: "build-review", task: "Go.",
      config: { model: "opus[1m]" }, agentBindings: { build: "claude-native" },
      orchestratorAgentId: "claude-native", costBudgetUsd: 12,
    },
  });
  const moved = { ...formFrom(spec), runnerId: "other-machine" };
  const saved = buildSpec(moved, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "workflow_run");
  assert.equal(saved.action.request.config, undefined);
  assert.equal(saved.action.request.agentBindings, undefined);
  assert.equal(saved.action.request.orchestratorAgentId, undefined);
  assert.equal(saved.action.request.costBudgetUsd, 12);
});

test("an omitted useWorktree stays omitted when the control is untouched", () => {
  assertRoundTrips(baseSpec({
    kind: "create_session",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native", prompt: "Sweep.",
    },
  }));
});

test("touching the worktree control makes the choice explicit", () => {
  const spec = baseSpec({
    kind: "create_session",
    request: { runnerId: "local-dev", workspaceId: "wollipog", agentId: "claude-native", prompt: "Sweep." },
  });
  const saved = buildSpec({ ...formFrom(spec), useWorktree: true }, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "create_session");
  assert.equal(saved.action.request.useWorktree, true);
});

const CODEX_CAPS = {
  models: [{ id: "haiku", displayName: "Haiku", efforts: ["low"] }, { id: "gpt", displayName: "GPT" }],
  effortLevels: ["low"],
  permissionModes: ["default"],
  slashCommands: [], supportsImages: true, supportsApprovals: true,
};

test("an alternate agent narrows the honourable config to what both agents advertise", () => {
  const shared = sharedCapabilities(CAPS, CODEX_CAPS);
  assert.deepEqual(shared?.models.map((model) => model.id), ["haiku"]);
  assert.deepEqual(shared?.models[0]?.efforts, ["low"]);
  assert.deepEqual(shared?.permissionModes, ["default"]);
  // "auto" is primary-only and must not remain selectable once a Codex alternate is configured.
  assert.equal(shared?.permissionModes?.includes("auto"), false);
});

test("configuring an alternate clears selections it cannot honour", () => {
  const form = { ...defaults(), model: "opus[1m]", effort: "high", permissionMode: "auto" };
  const narrowed = withCapabilities(form, sharedCapabilities(CAPS, CODEX_CAPS));
  assert.deepEqual(
    { model: narrowed.model, effort: narrowed.effort, permissionMode: narrowed.permissionMode },
    { model: "", effort: "", permissionMode: "" },
  );
});

test("with no alternate configured the primary capabilities stand unchanged", () => {
  assert.equal(sharedCapabilities(CAPS, undefined), CAPS);
});
