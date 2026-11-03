import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, ProjectView, RunnerView, WorkflowDefinition } from "@wollipog/protocol";
import {
  defaultRunAgentIds,
  folderName,
  newRunBlockedReason,
  runLocationOptions,
  selectableRunAgentIds,
  workflowHumanRoles,
  workflowRoleFields,
  type NewRunBlockInput,
} from "./run-dialog-choices.js";
import { bindableAgents, defaultAgentId, installationFor } from "./automation-installations.js";

const agent = (id: string, driver: AgentDefinition["driver"], overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id, name: id, command: id, args: [], env: {}, driver, available: true, ...overrides,
});

test("automatic run and automation choices use the effective default without selecting ready B implicitly", () => {
  const a = agent("claude", "claude-code", { authStatus: "authenticated", defaultProviderAccountId: "a",
    installation: { id: "cli", path: "/fixture/claude", via: "path" },
    providerAccountReadiness: { defaultAccountId: "a", defaultAuthStatus: "unauthenticated", readyAccountIds: ["b"] } });
  const runner = { agents: [a], protocolVersion: 279 } as RunnerView;
  assert.deepEqual(defaultRunAgentIds([a]), []);
  assert.equal(defaultAgentId([a]), "");
  assert.deepEqual(bindableAgents(runner), []);
  assert.equal(installationFor(runner, a.id), null);
  const defaults = [{ provider: "claude" as const, accountId: "b", revision: 1 }];
  runner.providerAccountDefaults = defaults;
  assert.deepEqual(defaultRunAgentIds([a], defaults), [a.id]);
  assert.equal(defaultAgentId([a], defaults), a.id);
  assert.equal(bindableAgents(runner).length, 1);
  assert.equal(installationFor(runner, a.id)?.installationId, "cli");
  assert.equal(a.defaultProviderAccountId, "a");
  const implicit = { ...a, defaultProviderAccountId: undefined, providerAccountReadiness: {
    defaultAccountId: "b", defaultAuthStatus: "authenticated" as const, readyAccountIds: ["b"],
  } };
  assert.deepEqual(defaultRunAgentIds([implicit]), [implicit.id], "the first granted implicit account can run");
  assert.equal(defaultAgentId([implicit]), implicit.id);
});

test("defaultRunAgentIds picks at most three, one per driver before a second of any", () => {
  const agents = [
    agent("claude", "claude-code"),
    agent("claude-wsl", "claude-code", { context: { kind: "wsl", distro: "Ubuntu" } }),
    agent("codex", "codex-app-server"),
    agent("gemini", "acp", { name: "Gemini" }),
    agent("opencode", "acp", { name: "OpenCode" }),
  ];
  assert.deepEqual(defaultRunAgentIds(agents), ["claude", "codex", "gemini"]);
  // With two drivers, the third choice is the next agent in the list's order.
  assert.deepEqual(defaultRunAgentIds(agents.slice(0, 3)), ["claude", "claude-wsl", "codex"]);
  assert.deepEqual(defaultRunAgentIds([agents[0]!]), ["claude"]);
  assert.deepEqual(defaultRunAgentIds([]), []);
});

test("a signed-out or unavailable agent is never chosen, nor selectable", () => {
  const agents = [
    agent("claude", "claude-code", { claudeCode: { status: "unauthenticated" } as AgentDefinition["claudeCode"] }),
    agent("codex", "codex-app-server", { authStatus: "unauthenticated" }),
    agent("gemini", "acp", { name: "Gemini", available: false }),
    agent("opencode", "acp", { name: "OpenCode" }),
  ];
  assert.deepEqual(selectableRunAgentIds(agents), ["opencode"]);
  assert.deepEqual(defaultRunAgentIds(agents), ["opencode"]);
});

test("an unverified agent is never selectable, and an available native harness replaces its ACP duplicate", () => {
  assert.deepEqual(selectableRunAgentIds([
    agent("claude", "claude-code"),
    agent("config", "acp", { name: "Config agent", available: undefined }),
  ]), ["claude"]);
  assert.deepEqual(selectableRunAgentIds([
    agent("claude-acp", "acp", { name: "Claude Code (ACP)" }),
    agent("claude-native", "claude-code", { name: "Claude Code" }),
  ]), ["claude-native"]);
});

const definition = (nodes: WorkflowDefinition["nodes"]): WorkflowDefinition => ({
  workflowId: "wf", version: 3, source: "custom", name: "Build", maxTransitions: 4, edges: [],
  createdBy: { kind: "system" }, createdAt: 1, nodes,
});
const node = (nodeId: string, kind: WorkflowDefinition["nodes"][number]["kind"], role: string, agentId?: string) => ({
  nodeId, kind, role, ...(agentId ? { agentId } : {}), inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1,
});

test("workflowRoleFields labels each bound agent by the roles of its steps, in Title Case", () => {
  const built = definition([
    node("build", "agent", "builder", "claude"),
    node("review", "agent", "code_reviewer", "codex"),
    node("address", "agent", "remediator", "claude"),
    node("gate", "human_gate", "approver"),
    node("lint", "agent", "", "lint-agent"),
  ]);
  assert.deepEqual(workflowRoleFields(built), [
    { key: "claude", label: "Builder and Remediator Agent" },
    { key: "codex", label: "Code Reviewer Agent" },
    // No role on its steps: the key names it, without a second "Agent".
    { key: "lint-agent", label: "Lint Agent" },
  ]);
  assert.deepEqual(workflowHumanRoles(built), ["Approver"]);
  assert.deepEqual(workflowRoleFields(undefined), []);
});

test("Location options name the folder on its Machine and never a connection id", () => {
  const runners = new Map<string, RunnerView>([
    ["runner-a", { runnerId: "runner-a", status: "online", workspaces: [{ id: "w1", name: "app", path: "/src/app" }] } as unknown as RunnerView],
  ]);
  const project = {
    id: "p", name: "App",
    locations: [
      { id: "l1", runnerId: "runner-a", workspaceId: "w1", path: "/src/app", availability: "available" },
      { id: "l2", runnerId: "runner-a", workspaceId: "gone", path: "C:\\src\\old-app\\", availability: "available" },
      { id: "l3", runnerId: "runner-z", workspaceId: "w9", path: "/x/docs", availability: "runner_removed" },
    ],
  } as unknown as ProjectView;
  assert.deepEqual(runLocationOptions(project, runners, new Map([["runner-a", "Studio Mac"]])), [
    { value: "l1", label: "app on Studio Mac", description: "/src/app" },
    { value: "l2", label: "old-app on Studio Mac", description: "C:\\src\\old-app\\", disabled: true, disabledReason: "Studio Mac no longer has this folder." },
    { value: "l3", label: "docs", description: "/x/docs", disabled: true, disabledReason: "Its machine was removed." },
  ]);
  assert.equal(folderName("/"), "/");
});

test("newRunBlockedReason follows the fields' order and names the fix", () => {
  const runners = new Map<string, RunnerView>([
    ["r", { runnerId: "r", status: "online", workspaces: [{ id: "w", name: "w", path: "/w" }] } as unknown as RunnerView],
  ]);
  const location = { id: "l", runnerId: "r", workspaceId: "w", path: "/w", availability: "available" } as ProjectView["locations"][number];
  const project = { id: "p", name: "P", locations: [location] } as unknown as ProjectView;
  const ready: NewRunBlockInput = {
    task: "Do it", machinesOnline: true, placedByMachine: false, projectChosen: true, project, location, runners,
    runnerId: "r", workspaceId: "w", mode: "parallel", agentCount: 2, workflowChosen: false, workflowBound: false,
  };
  assert.equal(newRunBlockedReason(ready), null);
  assert.equal(newRunBlockedReason({ ...ready, machinesOnline: false }), "Bring a machine online to continue.");
  assert.equal(newRunBlockedReason({ ...ready, task: "  " }), "Enter a task to continue.");
  assert.equal(newRunBlockedReason({ ...ready, projectChosen: false, project: null, location: null }), "Choose a project to continue.");
  assert.equal(newRunBlockedReason({ ...ready, project: { ...project, locations: [] }, location: null }),
    "Add a location to this project to continue.");
  assert.equal(newRunBlockedReason({ ...ready, runners: new Map() }), "Bring one of this project's machines online to continue.");
  assert.equal(newRunBlockedReason({ ...ready, location: null }), "Choose a location to continue.");
  assert.equal(newRunBlockedReason({ ...ready, agentCount: 0 }), "Choose at least one agent.");
  assert.equal(newRunBlockedReason({ ...ready, mode: "workflow" }), "Choose a workflow to continue.");
  assert.equal(newRunBlockedReason({ ...ready, mode: "workflow", workflowChosen: true }), "Choose an agent for every role.");
  assert.equal(newRunBlockedReason({ ...ready, mode: "workflow", workflowChosen: true, workflowBound: true }), null);
  assert.equal(newRunBlockedReason({ ...ready, placedByMachine: true, runnerId: "" }), "Choose a machine to continue.");
  assert.equal(newRunBlockedReason({ ...ready, placedByMachine: true, workspaceId: "" }), "Choose a folder to continue.");
});
