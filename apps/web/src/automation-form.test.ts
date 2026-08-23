import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationSpec } from "@wollipog/protocol";
import {
  alternateConfigError, buildSpec, defaults, formFrom, withAgent, withModel,
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

test("saving rejects a config the explicit alternate agent cannot honour", () => {
  assert.equal(alternateConfigError({ model: "opus[1m]" }, CODEX_CAPS),
    "The alternate agent does not support the model opus[1m].");
  assert.equal(alternateConfigError({ model: "haiku", effort: "high" }, CODEX_CAPS),
    "The alternate agent does not support high effort for this model.");
  assert.equal(alternateConfigError({ permissionMode: "auto" }, CODEX_CAPS),
    "The alternate agent does not support the auto permission mode.");
  assert.equal(alternateConfigError({ model: "haiku", effort: "low", permissionMode: "default" }, CODEX_CAPS), null);
});

test("an alternate with unknown capabilities is not second-guessed", () => {
  // Absent capabilities mean discovery has not run, not that nothing is supported. The control
  // plane makes the same call in `capabilityConfigError`.
  assert.equal(alternateConfigError({ model: "opus[1m]" }, undefined), null);
});

test("a shared model with disjoint efforts is rejected rather than silently widened", () => {
  // The defect that sank the intersection approach: an empty per-model effort set read as
  // "unspecified" and fell back to the global levels, offering an effort the alternate rejects.
  const primaryOnly = {
    models: [{ id: "same", displayName: "Same", efforts: ["high"] }],
    effortLevels: ["low", "high"], permissionModes: ["default"],
    slashCommands: [], supportsImages: true, supportsApprovals: true,
  };
  assert.match(alternateConfigError({ model: "same", effort: "low" }, primaryOnly)!, /low effort/);
});

test("an alternate policy blocks the save that would fail on failover", () => {
  const form = {
    ...defaults(), name: "Sweep", runnerId: "local-dev", workspaceId: "wollipog",
    agentId: "claude-native", prompt: "Go.", model: "opus[1m]",
    runnerPolicy: "alternate" as const, fallbackRunnerId: "other", fallbackWorkspaceId: "ws",
    fallbackAgentId: "codex-native",
  };
  assert.throws(() => buildSpec(form, { ...CONTEXT, alternateCapabilities: CODEX_CAPS }),
    /does not support the model/);
  // Without an alternate configured the same config saves cleanly.
  assert.doesNotThrow(() => buildSpec({ ...form, runnerPolicy: "wait" }, CONTEXT));
});

test("empty alternate capability lists reject rather than wave values through", () => {
  // The server guards on `.length` for models only. A guard this client does not share would make
  // it ACCEPT what the server rejects, which is the direction that breaks a failover run.
  const empty = { models: [], effortLevels: [], permissionModes: [], slashCommands: [], supportsImages: true, supportsApprovals: true };
  assert.match(alternateConfigError({ effort: "high" }, empty)!, /high effort/);
  assert.match(alternateConfigError({ permissionMode: "auto" }, empty)!, /auto permission mode/);
  // An empty model catalog stays permissive, because that is what the server does.
  assert.equal(alternateConfigError({ model: "opus[1m]" }, empty), null);
});

test("a workflow automation drops runner-scoped config once an alternate can run it", () => {
  const spec = baseSpec({
    kind: "workflow_run",
    request: {
      runnerId: "local-dev", workspaceId: "wollipog", workflowId: "build-review", task: "Go.",
      config: { model: "opus[1m]" }, costBudgetUsd: 12,
    },
  });
  // Only the runner policy changes; the runner itself is untouched, so `sameRunner` still holds.
  const withAlternate = {
    ...formFrom(spec), runnerPolicy: "alternate" as const,
    fallbackRunnerId: "other", fallbackWorkspaceId: "ws",
  };
  const saved = buildSpec(withAlternate, { ...CONTEXT, base: spec });
  assert(saved.action.kind === "workflow_run");
  // A workflow's agents come from its graph, so the client cannot know which agent runs on the
  // alternate and cannot validate against it. Carrying the config would fail at failover.
  assert.equal(saved.action.request.config, undefined);
  assert.equal(saved.action.request.costBudgetUsd, 12);
});
