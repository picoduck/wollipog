import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, RunnerView } from "@wollipog/protocol";
import { skillDeployBadge, type RunnerSkillsResponse } from "./skills.js";
import { skillAgentMatrixCell, skillDeploymentErrors, skillManualOnlyErrors, winningSkillRule, type SkillRule } from "./skill-assignment-matrix.js";
const runner = { protocolVersion: 111, os: "linux" } as RunnerView;
const agent = { id: "codex", driver: "codex", name: "Codex" } as AgentDefinition;
const state = (targeted = true): RunnerSkillsResponse => ({ desired: [{ name: "review", versionDigest: "digest", targets: targeted ? [{ agentId: "codex", invocation: "manual" }] : [] }], reported: { deployed: [{ name: "review", digest: "digest", links: [{ agentId: "codex", status: "linked" }] }] } });
test("matrix separates desired invocation from linked or older reported content", () => {
  assert.deepEqual(skillAgentMatrixCell(runner, agent, "review", state()), { desired: "Manual Only", reported: "Linked", detail: undefined });
  const older = state(); older.reported!.deployed![0]!.digest = "older";
  assert.equal(skillAgentMatrixCell(runner, agent, "review", older).reported, "Version Pending");
});
test("untargeted shared links are not reported as removed", () => {
  assert.equal(skillAgentMatrixCell(runner, agent, "review", state(false)).desired, "Not Assigned");
  assert.equal(skillAgentMatrixCell(runner, agent, "review", state(false)).reported, "Linked (Not Targeted)");
  const removed = state(false); removed.reported!.deployed = [];
  assert.equal(skillAgentMatrixCell(runner, agent, "review", removed).reported, "Not Reported");
});
test("missing or failed reads remain unknown, never empty assignments", () => {
  assert.equal(skillAgentMatrixCell(runner, agent, "review").desired, "Unknown");
  assert.equal(skillAgentMatrixCell(runner, agent, "review", { ...state(), loadError: "Request failed" }).reported, "Unknown");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired: undefined, reported: null, skillName: "review", loadError: "Request failed" }).detail, "Request failed");
  assert.equal(skillDeployBadge({ runnerOnline: true, desired: undefined, reported: null, skillName: "review", loading: true }).detail, "Skills status has not loaded.");
});
test("unavailable platforms, contexts and old runners are explicit", () => {
  assert.equal(skillAgentMatrixCell({ ...runner, os: "windows" }, agent, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell({ ...runner, protocolVersion: 1 }, agent, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell(runner, { ...agent, context: { kind: "wsl", distro: "Ubuntu" } }, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell({ ...runner, os: "windows", protocolVersion: 119 }, agent, "review", state()).desired, "Manual Only");
  const wslAgent = { ...agent, context: { kind: "wsl" as const, distro: "Ubuntu" } };
  assert.equal(skillAgentMatrixCell({ ...runner, os: "windows", protocolVersion: 124 }, wslAgent, "review", state()).desired, "Unavailable");
  assert.equal(skillAgentMatrixCell({ ...runner, os: "windows", protocolVersion: 125 }, wslAgent, "review", state()).desired, "Manual Only");
});
test("link errors and conflicts remain visible", () => {
  const failed = state(); failed.reported!.deployed![0]!.links[0] = { agentId: agent.id, status: "conflict", detail: "Unmanaged directory" };
  assert.deepEqual(skillAgentMatrixCell(runner, agent, "review", failed), { desired: "Manual Only", reported: "Conflict", detail: "Unmanaged directory" });
  failed.reported!.error = "Sync failed";
  assert.equal(skillAgentMatrixCell(runner, agent, "review", failed).reported, "Error");
});
test("account-scoped matrix rows aggregate per agent without hiding sibling conflicts", () => {
  const accountRunner = {
    ...runner,
    protocolVersion: 172,
    providerAccounts: [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "codex", authStatus: "authenticated" },
    ],
  } as RunnerView;
  const scoped = state();
  scoped.reported!.deployed = [
    { name: "review", digest: "digest", links: [{ agentId: "claude", status: "linked" }] },
    { name: "review", digest: "digest", providerAccountId: "work",
      links: [{ agentId: agent.id, status: "linked" }] },
    { name: "review", digest: "digest", providerAccountId: "personal",
      links: [{ agentId: agent.id, status: "conflict", detail: "Unmanaged directory" }] },
  ];
  assert.deepEqual(skillAgentMatrixCell(accountRunner, agent, "review", scoped), {
    desired: "Manual Only",
    reported: "Conflict",
    detail: "Personal: Unmanaged directory",
  });

  scoped.reported!.deployed[2]!.links[0] = { agentId: agent.id, status: "linked" };
  assert.deepEqual(skillAgentMatrixCell(accountRunner, agent, "review", scoped), {
    desired: "Manual Only",
    reported: "Linked",
    detail: undefined,
  });
});
test("account-scoped native rows do not make a healthy WSL link look unreported", () => {
  const wslAgent = { ...agent, id: "codex-wsl-Ubuntu",
    context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const accountRunner = {
    ...runner,
    os: "windows",
    protocolVersion: 172,
    providerAccounts: [
      { id: "work", label: "Work", provider: "codex", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "codex", authStatus: "authenticated" },
    ],
  } as RunnerView;
  const scoped: RunnerSkillsResponse = {
    desired: [{ name: "review", versionDigest: "digest",
      targets: [{ agentId: wslAgent.id, invocation: "manual" }] }],
    reported: { deployed: [
      { name: "review", digest: "digest", links: [{ agentId: wslAgent.id, status: "linked" }] },
      { name: "review", digest: "digest", providerAccountId: "work",
        links: [{ agentId: agent.id, status: "linked" }] },
      { name: "review", digest: "digest", providerAccountId: "personal",
        links: [{ agentId: agent.id, status: "linked" }] },
    ] },
  };
  assert.deepEqual(skillAgentMatrixCell(accountRunner, wslAgent, "review", scoped), {
    desired: "Manual Only",
    reported: "Linked",
    detail: undefined,
  });
});
test("unsupported WSL context details pass through to the assignment matrix", () => {
  const failed = state();
  failed.reported!.deployed![0]!.links[0] = {
    agentId: agent.id,
    status: "unsupported",
    detail: "this agent's WSL distribution name is invalid or unsafe",
  };
  assert.deepEqual(skillAgentMatrixCell(runner, agent, "review", failed), {
    desired: "Manual Only",
    reported: "Unsupported",
    detail: "this agent's WSL distribution name is invalid or unsafe",
  });
});

/* --- The rule behind a deployment error (#1972) --- */

const claude = { id: "claude", name: "Claude Code", driver: "claude-code" } as AgentDefinition;
const codex = { id: "codex", name: "Codex", driver: "codex" } as AgentDefinition;
const pi = { id: "pi", name: "Pi", driver: "pi" } as AgentDefinition;
const studio = { runnerId: "studio", agents: [claude, codex, pi], protocolVersion: 200, os: "linux" } as RunnerView;
const laptop = { runnerId: "laptop", agents: [claude, codex], protocolVersion: 200, os: "linux" } as RunnerView;
const rule = (id: string, overrides: Partial<SkillRule> = {}): SkillRule => ({
  id, scopeKind: "instance", runnerId: null, agentSelector: { kind: "all" }, enabled: true, invocation: "manual", updatedAt: 1, ...overrides,
});
const told = (targets: Array<[string, "agent" | "manual"]>): RunnerSkillsResponse => ({
  desired: [{ name: "review", versionDigest: "digest", targets: targets.map(([agentId, invocation]) => ({ agentId, invocation })) }],
  reported: null,
});

test("the winning rule follows the control plane: runner scope, then selector, then the skill's own, then newest", () => {
  const instanceAll = rule("instance-all");
  const instanceDriver = rule("instance-driver", { agentSelector: { kind: "driver", driver: "codex" } });
  const runnerAll = rule("runner-all", { scopeKind: "runner", runnerId: "studio" });
  const otherRunner = rule("other-runner", { scopeKind: "runner", runnerId: "laptop", agentSelector: { kind: "agent", agentId: "codex" } });
  assert.equal(winningSkillRule([instanceAll], "studio", codex)?.id, "instance-all");
  assert.equal(winningSkillRule([instanceAll, instanceDriver], "studio", codex)?.id, "instance-driver");
  assert.equal(winningSkillRule([instanceAll, instanceDriver], "studio", claude)?.id, "instance-all", "a driver rule matches only its driver");
  assert.equal(winningSkillRule([instanceDriver, runnerAll], "studio", codex)?.id, "runner-all", "runner scope beats any instance rule");
  assert.equal(winningSkillRule([instanceAll, otherRunner], "studio", codex)?.id, "instance-all", "another machine's rule never applies");
  const groupAll = rule("group-all", { groupId: "g", updatedAt: 9 });
  assert.equal(winningSkillRule([groupAll, instanceAll], "studio", codex)?.id, "instance-all", "the skill's own rule beats its group's at equal rank");
  const newer = rule("newer", { updatedAt: 5 });
  assert.equal(winningSkillRule([instanceAll, newer], "studio", codex)?.id, "newer");
  assert.equal(winningSkillRule([], "studio", codex), undefined);
});

test("a Manual Only rule names the agents it skips, the machines that skip them and the rule itself", () => {
  const manual = rule("manual");
  const errors = skillManualOnlyErrors("review", [studio, laptop],
    { studio: told([["claude", "manual"], ["codex", "manual"], ["pi", "manual"]]), laptop: told([["claude", "manual"], ["codex", "manual"]]) },
    [manual]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.rule?.id, "manual");
  assert.deepEqual(errors[0]!.runnerIds, ["studio", "laptop"]);
  assert.deepEqual(errors[0]!.agents.map((agent) => agent.name), ["Codex", "Pi", "Codex"], "Claude Code enforces manual-only invocation");

  // Each offending rule is its own entry, in the order its first skipped agent appears.
  const codexOnly = rule("codex-only", { scopeKind: "runner", runnerId: "laptop", agentSelector: { kind: "driver", driver: "codex" } });
  const split = skillManualOnlyErrors("review", [studio, laptop],
    { studio: told([["pi", "manual"]]), laptop: told([["codex", "manual"]]) }, [manual, codexOnly]);
  assert.deepEqual(split.map((entry) => [entry.rule?.id, entry.runnerIds]), [["manual", ["studio"]], ["codex-only", ["laptop"]]]);

  // A group's rule is named as the group's, so the notice can send the person to Groups.
  const groupManual = rule("group-manual", { groupId: "g" });
  assert.equal(skillManualOnlyErrors("review", [studio], { studio: told([["codex", "manual"]]) }, [groupManual])[0]!.rule?.groupId, "g");
});

test("a Manual Only error clears as soon as the rule changes, and an unknown rule is never guessed", () => {
  const manual = rule("manual");
  // Agent Invocable: the machine is told to deploy for every agent normally.
  assert.deepEqual(skillManualOnlyErrors("review", [studio], { studio: told([["claude", "agent"], ["codex", "agent"], ["pi", "agent"]]) },
    [{ ...manual, invocation: "agent" }]), []);
  // Limited to Claude Code: only Claude is targeted.
  assert.deepEqual(skillManualOnlyErrors("review", [studio], { studio: told([["claude", "manual"]]) },
    [{ ...manual, agentSelector: { kind: "driver", driver: "claude-code" } }]), []);
  // The page's rules disagree with what the machine was told (a group the page could not read).
  const stale = skillManualOnlyErrors("review", [studio], { studio: told([["codex", "manual"]]) }, [{ ...manual, invocation: "agent" }]);
  assert.equal(stale[0]!.rule, null);
  assert.deepEqual(skillManualOnlyErrors("review", [studio], { studio: told([["codex", "manual"]]) }, [])[0]!.rule, null);
  // Machines whose state has not loaded, or failed to, say nothing.
  assert.deepEqual(skillManualOnlyErrors("review", [studio], {}, [manual]), []);
  assert.deepEqual(skillManualOnlyErrors("review", [studio], { studio: { ...told([["codex", "manual"]]), loadError: "x" } }, [manual]), []);
});

test("deployment errors are the machines that report an Error for an agent that can receive the skill", () => {
  const healthy = state();
  const failed = state(); failed.reported!.error = "Sync failed";
  const linkError = state(); linkError.reported!.deployed![0]!.links[0] = { agentId: "codex", status: "error", detail: "Permission denied" };
  const machines = [{ ...runner, runnerId: "a", agents: [agent] }, { ...runner, runnerId: "b", agents: [agent] }, { ...runner, runnerId: "c", agents: [agent] }];
  assert.deepEqual(skillDeploymentErrors("review", machines, { a: healthy, b: failed, c: linkError }),
    [{ runnerId: "b", detail: "Sync failed" }, { runnerId: "c", detail: "Permission denied" }]);
  // A machine-wide error belongs to this skill only on a machine that deploys it.
  const unrelated: RunnerSkillsResponse = { desired: [], reported: { deployed: [], error: "Sync failed" } };
  assert.deepEqual(skillDeploymentErrors("review", machines, { a: unrelated }), []);
  // An unsupported link (a manual-only skip) is not a machine error; the manual-only notice owns it.
  const skipped = state(); skipped.reported!.deployed![0]!.links[0] = { agentId: "codex", status: "unsupported", detail: "Manual-only invocation is not supported for this agent." };
  assert.deepEqual(skillDeploymentErrors("review", machines, { a: skipped }), []);
});
