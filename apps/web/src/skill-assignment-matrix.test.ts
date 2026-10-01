import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, RunnerView } from "@wollipog/protocol";
import type { RunnerSkillsResponse } from "./skills.js";
import {
  skillAgentDeployment,
  skillAgentMatrixCell,
  skillAssignedBy,
  skillDeploymentErrorSummary,
  skillMachineDeployment,
  skillManualOnlyErrors,
  skillRuleUnreachableAgents,
  winningSkillRule,
  type SkillRule,
} from "./skill-assignment-matrix.js";
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
  assert.equal(skillAgentDeployment(runner, agent, "review").status, null);
  assert.equal(skillAgentDeployment(runner, agent, "review", { ...state(), loadError: "Request failed" }).status, null);
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

test("a deployment error is the first machine that reports an Error for an agent that can receive the skill (#2293)", () => {
  // Agent Invocable, so Codex can run it: a Manual Only target it can't run is a skip, told apart.
  const invocable = () => { const value = state(); value.desired[0]!.targets[0]!.invocation = "agent"; return value; };
  const healthy = invocable();
  const failed = invocable(); failed.reported!.error = "Sync failed";
  const linkError = invocable(); linkError.reported!.deployed![0]!.links[0] = { agentId: "codex", status: "error", detail: "Permission denied" };
  const machines = [{ ...runner, runnerId: "a", agents: [agent] }, { ...runner, runnerId: "b", agents: [agent] }, { ...runner, runnerId: "c", agents: [agent] }];
  const summary = (machineSkills: Record<string, RunnerSkillsResponse>) =>
    skillDeploymentErrorSummary("review", machines, machineSkills, "machine");
  assert.deepEqual(summary({ a: healthy, b: failed, c: linkError }),
    { runnerId: "b", agents: [agent.name], detail: "Sync failed", otherAgents: 0, moreMachines: 1, manualOnly: false });
  assert.equal(summary({ a: healthy }), null);
  // A machine-wide error belongs to this skill only on a machine that deploys it.
  const unrelated: RunnerSkillsResponse = { desired: [], reported: { deployed: [], error: "Sync failed" } };
  assert.equal(summary({ a: unrelated }), null);
  // An unsupported link (a manual-only skip) is not a machine error; the manual-only notice owns it.
  const skipped = state(); skipped.reported!.deployed![0]!.links[0] = { agentId: "codex", status: "unsupported", detail: "Manual-only invocation is not supported for this agent." };
  assert.equal(summary({ a: skipped }), null);
  assert.deepEqual(skillDeploymentErrorSummary("review", machines, { a: skipped }),
    { runnerId: "a", agents: [agent.name], detail: "Can't run manual-only skills.", otherAgents: 0, moreMachines: 0, manualOnly: true },
    "told on its own and first when no kind is asked for");
  // A machine that also reports an error still skips a Manual Only target Codex can't run (CR-1.1).
  const skippedAndFailed = state(); skippedAndFailed.reported!.error = "Sync failed";
  assert.equal(summary({ b: skippedAndFailed }), null, "the notice tells it as a skip");
  assert.deepEqual(skillDeploymentErrorSummary("review", machines, { a: skipped, b: skippedAndFailed }),
    { runnerId: "a", agents: [agent.name], detail: "Can't run manual-only skills.", otherAgents: 0, moreMachines: 1, manualOnly: true });
  // Any other unsupported link is an Error row, so the notice names its machine too (#1981).
  const unsupported = state(); unsupported.desired[0]!.targets[0]!.invocation = "agent";
  unsupported.reported!.deployed![0]!.links[0] = { agentId: "codex", status: "unsupported", detail: "The WSL distribution name is invalid." };
  assert.equal(summary({ a: unsupported })?.detail, "The WSL distribution name is invalid.");
});

/* --- Deployment rows (#1981) --- */

const linkedTo = (links: Array<[string, "linked" | "error" | "conflict" | "unsupported", string?]>,
  targets: Array<[string, "agent" | "manual"]>, digest = "digest"): RunnerSkillsResponse => ({
  desired: [{ name: "review", versionDigest: "digest", targets: targets.map(([agentId, invocation]) => ({ agentId, invocation })) }],
  reported: { deployed: [{ name: "review", digest, links: links.map(([agentId, status, detail]) => ({ agentId, status, ...(detail ? { detail } : {}) })) }] },
});

test("Claude Code linked beside a Codex it can't run as Manual Only is 1 of 2 Linked, with Error on Codex only", () => {
  const machine = { ...laptop, agents: [claude, codex] };
  const deployment = skillMachineDeployment(machine, "review", linkedTo(
    [["claude", "linked"], ["codex", "unsupported", "Manual-only invocation is not supported for this agent."]],
    [["claude", "manual"], ["codex", "manual"]],
  ));
  assert.deepEqual(deployment.rows.map((row) => [row.agent.id, row.status, row.reason ?? null]), [
    ["claude", "linked", null],
    ["codex", "error", "Can't run manual-only skills."],
  ]);
  assert.deepEqual([deployment.linked, deployment.total], [1, 2]);
  // Before the machine reports, what it was told already makes Codex an Error, as the notice says.
  const told = skillAgentDeployment(machine, codex, "review", linkedTo([], [["claude", "manual"], ["codex", "manual"]]));
  assert.deepEqual([told.status, told.manualOnly], ["error", true]);
});

test("each agent has one status, and anything more specific is its reason", () => {
  const row = (state: RunnerSkillsResponse, who: AgentDefinition = codex) => {
    const result = skillAgentDeployment(laptop, who, "review", state);
    return [result.status, result.reason ?? null];
  };
  assert.deepEqual(row(linkedTo([["codex", "linked"]], [["codex", "agent"]])), ["linked", null]);
  assert.deepEqual(row(linkedTo([["codex", "linked"]], [["codex", "agent"]], "older")),
    ["pending", "An older version is linked. Sync to update it."]);
  assert.deepEqual(row(linkedTo([], [["codex", "agent"]])), ["pending", "Not reported yet."]);
  assert.deepEqual(row({ desired: linkedTo([], [["codex", "agent"]]).desired, reported: null }), ["pending", "Not reported yet."]);
  assert.deepEqual(row(linkedTo([["codex", "conflict", "A local directory blocks this link"]], [["codex", "agent"]])),
    ["error", "A local directory blocks this link"]);
  assert.deepEqual(row(linkedTo([["codex", "unsupported"]], [["codex", "agent"]])), ["error", "This agent can't load this skill."]);
  assert.deepEqual(row(linkedTo([["codex", "error", "Permission denied"]], [["codex", "agent"]])), ["error", "Permission denied"]);
  const failed = linkedTo([["codex", "linked"]], [["codex", "agent"]]); failed.reported!.error = "Sync failed";
  assert.deepEqual(row(failed), ["error", "Sync failed"]);
  // Linked without a target is Linked, with why it is still there.
  assert.equal(row(linkedTo([["codex", "linked"]], []))[0], "linked");
  assert.match(String(row(linkedTo([["codex", "linked"]], []))[1]), /^Not assigned\./);
  // Not targeted and holding no link: nothing to say, even beside a machine-wide error.
  assert.deepEqual(row(linkedTo([], [])), [null, null]);
  const unrelated = linkedTo([], []); unrelated.reported!.error = "Sync failed";
  assert.deepEqual(row(unrelated), [null, null]);
  // An edited copy is Edited, and an error outranks it, as in the notice slot.
  const edited = linkedTo([["codex", "linked"]], [["codex", "agent"]]);
  edited.reported!.drift = [{ name: "review", digest: "digest", variant: "agent", held: true }];
  assert.equal(row(edited)[0], "edited");
  // A held copy's links report as conflicts; the edit is still what the row says.
  edited.reported!.deployed![0]!.links[0]!.status = "conflict";
  assert.equal(row(edited)[0], "edited");
  edited.reported!.deployed![0]!.links[0]!.status = "error";
  assert.equal(row(edited)[0], "error");
  // A Manual Only copy's edit is not an Agent Invocable agent's.
  const manualEdit = linkedTo([["codex", "linked"]], [["codex", "agent"]]);
  manualEdit.reported!.drift = [{ name: "review", digest: "digest", variant: "manual", held: false }];
  assert.equal(row(manualEdit)[0], "linked");
});

test("agents that can't receive managed skills are counted apart, with why", () => {
  const acp = { id: "gemini", name: "Gemini", driver: "acp" } as AgentDefinition;
  const wsl = { ...codex, id: "wsl", name: "WSL Codex", context: { kind: "wsl" as const, distro: "Ubuntu" } };
  const machine = { ...laptop, agents: [claude, acp, wsl] };
  const deployment = skillMachineDeployment(machine, "review", linkedTo([["claude", "linked"]], [["claude", "agent"]]));
  assert.deepEqual(deployment.rows.map((row) => row.agent.id), ["claude"]);
  assert.deepEqual(deployment.ineligible.map((row) => [row.agent.id, row.status, row.reason]), [
    ["gemini", null, "This agent type can't load managed skills."],
    ["wsl", null, "Its execution context can't load managed skills."],
  ]);
  assert.deepEqual([deployment.linked, deployment.total], [1, 1]);
  assert.equal(skillMachineDeployment({ ...machine, protocolVersion: 1 }, "review").ineligible[0]!.reason,
    "Update this machine's runner to deploy skills.");
});

test("Assigned By names the rule that won: Direct, or its group", () => {
  const targeted = { agent: codex, invocation: "agent" as const };
  const groupName = (id: string) => (id === "g" ? "Reviewers" : undefined);
  assert.equal(skillAssignedBy(targeted, "studio", [rule("direct")], true, groupName), "Direct");
  assert.equal(skillAssignedBy(targeted, "studio", [rule("group", { groupId: "g" })], true, groupName), "Reviewers");
  assert.equal(skillAssignedBy({ ...targeted, invocation: null }, "studio", [rule("direct")], true, groupName), null);
  // The group's rules are unread: the direct rule may not be the one that won.
  assert.equal(skillAssignedBy(targeted, "studio", [rule("direct")], false, groupName), null);
  assert.equal(skillAssignedBy(targeted, "studio", [rule("direct", { enabled: false })], true, groupName), null);
});

test("a group's rule that outranks the skill's own is the one blamed, and an unread group blames none (CR-1.1)", () => {
  const direct = rule("direct");
  const groupRunner = rule("group-runner", { groupId: "g", scopeKind: "runner", runnerId: "studio" });
  const machines = { studio: told([["codex", "manual"]]) };
  assert.equal(skillManualOnlyErrors("review", [studio], machines, [direct, groupRunner])[0]!.rule?.id, "group-runner",
    "the group's runner-scoped rule outranks the skill's instance-wide one");
  // The group's rules are still loading or could not be read: the direct rule might not be the winner.
  assert.equal(skillManualOnlyErrors("review", [studio], machines, [direct], false)[0]!.rule, null);
  assert.deepEqual(skillManualOnlyErrors("review", [studio], machines, [direct], false)[0]!.agents.map((agent) => agent.id), ["codex"],
    "the error itself still shows");
});

test("a held edit of one variant holds every agent's link, so each is Edited and no machine error is claimed (CR-1.1)", () => {
  const machine = { ...laptop, agents: [claude, codex] };
  const held = "This skill's deployed copy was edited on this machine. Its links stay on the edited copy until the edit is imported as a new version, the library version is restored, or the edit is undone.";
  const state = linkedTo([["claude", "conflict", held], ["codex", "conflict", held]], [["claude", "manual"], ["codex", "agent"]]);
  state.reported!.drift = [{ name: "review", digest: "digest", variant: "manual", held: true }];
  assert.deepEqual(skillMachineDeployment(machine, "review", state).rows.map((row) => row.status), ["edited", "edited"]);
  assert.equal(skillDeploymentErrorSummary("review", [machine], { [machine.runnerId]: state }), null);
  // An edit that holds nothing leaves the other variant's real conflict an Error.
  state.reported!.drift = [{ name: "review", digest: "digest", variant: "manual", held: false }];
  assert.equal(skillAgentDeployment(machine, codex, "review", state).status, "error");
});

test("an agent with several provider accounts is Linked only once every account reports its link (CR-1.2)", () => {
  const machine = {
    ...laptop,
    agents: [claude],
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "authenticated" },
      { id: "other", label: "Codex Account", provider: "codex", authStatus: "authenticated" },
    ],
  } as RunnerView;
  const state: RunnerSkillsResponse = {
    desired: [{ name: "review", versionDigest: "digest", targets: [{ agentId: "claude", invocation: "agent" }] }],
    reported: { deployed: [{ name: "review", digest: "digest", providerAccountId: "work", links: [{ agentId: "claude", status: "linked" }] }] },
  };
  const row = skillAgentDeployment(machine, claude, "review", state);
  assert.deepEqual([row.status, row.reason], ["pending", "Personal: Not reported yet."]);
  assert.deepEqual([skillMachineDeployment(machine, "review", state).linked, skillMachineDeployment(machine, "review", state).total], [0, 1]);
  state.reported!.deployed!.push({ name: "review", digest: "digest", providerAccountId: "personal", links: [{ agentId: "claude", status: "linked" }] });
  assert.equal(skillAgentDeployment(machine, claude, "review", state).status, "linked", "another provider's account is not required");
});

test("a rule's unreachable agents: the ones it names that can't receive skills, and Manual Only's skipped agents, where it wins", () => {
  const acp = { id: "gemini", name: "Gemini", driver: "acp" } as AgentDefinition;
  const withAcp = { ...studio, agents: [claude, codex, acp] } as RunnerView;
  const names = (result: ReturnType<typeof skillRuleUnreachableAgents>) => ({
    ineligible: result.ineligible.map((entry) => `${entry.agent.id}@${entry.runnerId}`),
    manualOnly: result.manualOnly.map((entry) => `${entry.agent.id}@${entry.runnerId}`),
  });
  // All Agents, Manual Only: every non-Claude agent it reaches is skipped; an ACP agent is never held against it.
  const all = rule("all", { groupId: "g" });
  assert.deepEqual(names(skillRuleUnreachableAgents(all, [all], [withAcp, laptop])),
    { ineligible: [], manualOnly: ["codex@studio", "codex@laptop"] });
  // A rule that names an agent deployment can't reach says so, whatever its invocation.
  const named = rule("named", { groupId: "g", invocation: "agent", agentSelector: { kind: "driver", driver: "acp" } });
  assert.deepEqual(names(skillRuleUnreachableAgents(named, [named], [withAcp])), { ineligible: ["gemini@studio"], manualOnly: [] });
  // Only the machines it covers, and only agents it wins: the skill's own Codex rule decides Codex.
  const studioOnly = rule("studio-only", { groupId: "g", scopeKind: "runner", runnerId: "studio" });
  const ownCodex = rule("own-codex", { scopeKind: "runner", runnerId: "studio", invocation: "agent", agentSelector: { kind: "agent", agentId: "codex" } });
  assert.deepEqual(names(skillRuleUnreachableAgents(studioOnly, [studioOnly, ownCodex], [studio, laptop])),
    { ineligible: [], manualOnly: ["pi@studio"] });
  // A turned-off rule deploys nothing, so nothing is unreachable.
  const off = rule("off", { groupId: "g", enabled: false });
  assert.deepEqual(names(skillRuleUnreachableAgents(off, [off], [studio])), { ineligible: [], manualOnly: [] });
});
