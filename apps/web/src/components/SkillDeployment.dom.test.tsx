import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentDefinition, ExecutionTargetDefinition, RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { SkillRule } from "../skill-assignment-matrix.js";
import type { RunnerSkillsResponse, SkillSummary } from "../skills.js";
import { SkillDeployment, type SkillDeploymentProps } from "./SkillDeployment.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const agent = (id: string, name: string, driver: AgentDefinition["driver"]) =>
  ({ id, name, command: id, args: [], env: {}, driver, available: true }) as AgentDefinition;
const claude = agent("claude", "Claude Code", "claude-code");
const codex = agent("codex", "Codex", "codex");

function target(id: string, name: string, adapter: ExecutionTargetDefinition["adapter"]): ExecutionTargetDefinition {
  return {
    id, runnerId: "runner", name, kind: adapter === "host" ? "local" : adapter, workspaceStrategy: "worktree", adapter,
    boundaries: { filesystem: adapter === "host" ? "worktree" : adapter === "cloud" ? "snapshot" : "container", network: "deny", secrets: "none", billing: "none" },
    available: true,
  } as ExecutionTargetDefinition;
}

function machine(runnerId: string, displayName: string, agents: AgentDefinition[], overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId, hostname: runnerId, displayName, os: "linux", version: "1", status: "online",
    agents, workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 200, ...overrides,
  } as RunnerView;
}

const told = (targets: Array<[string, "agent" | "manual"]>, links: Array<[string, "linked" | "unsupported"]> = []): RunnerSkillsResponse => ({
  desired: [{ name: "code-review", versionDigest: "d1", targets: targets.map(([agentId, invocation]) => ({ agentId, invocation })) }],
  reported: { deployed: [{ name: "code-review", digest: "d1", links: links.map(([agentId, status]) => ({ agentId, status })) }] },
});

const rule = (overrides: Partial<SkillRule> = {}): SkillRule => ({
  id: "rule-1", scopeKind: "instance", runnerId: null, agentSelector: { kind: "all" }, enabled: true, invocation: "agent", updatedAt: 1, ...overrides,
});

async function render(props: Partial<SkillDeploymentProps<SkillRule>> & Pick<SkillDeploymentProps<SkillRule>, "runners">, client: Partial<ApiClient> = {}) {
  const apiClient = { ...api, getMachineSkillVersionPolicy: async () => ({ policy: null }), ...client } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const synced: string[] = [];
  const skill: Pick<SkillSummary, "id" | "name" | "builtIn" | "latestVersion"> = { id: "skill-1", name: "code-review", latestVersion: { id: "v3", versionNumber: 3 } };
  await act(async () => root.render(
    <ApiProvider client={apiClient}>
      <SkillDeployment
        skill={skill}
        machineLabels={new Map(props.runners.map((runner) => [runner.runnerId, runner.displayName!]))}
        machineSkills={{}}
        rules={[rule()]}
        rulesComplete
        groupName={() => undefined}
        syncingRunnerId={null}
        onSync={(runnerId) => synced.push(runnerId)}
        onManageVersion={() => {}}
        {...props}
      />
    </ApiProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const group = (name: string) => container.querySelector(`tbody[aria-label="${name}"]`);
  const rowOf = (name: string, agentName: string) => [...group(name)?.querySelectorAll("tr.skill-deployment-agent") ?? []]
    .find((row) => row.querySelector(".skill-deployment-agent-name")?.textContent === agentName);
  return {
    container, synced, group, rowOf,
    cells: (name: string, agentName: string) => [...rowOf(name, agentName)?.children ?? []].map((cell) =>
      [...cell.childNodes].filter((node) => !(node as Element).classList?.contains("cell-label") && !(node as Element).classList?.contains("cell-note"))
        .map((node) => node.textContent).join("")),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("one table with Title Case headers holds every machine, one row group each", async () => {
  const runners = [machine("a", "Build Machine", [claude, codex]), machine("b", "Laptop", [claude])];
  const view = await render({ runners, machineSkills: { a: told([["claude", "agent"]], [["claude", "linked"]]), b: told([["claude", "agent"]]) } });
  try {
    assert.equal(view.container.querySelectorAll("table").length, 1);
    assert.deepEqual([...view.container.querySelectorAll("thead th")].map((th) => th.textContent),
      ["Agent", "Invocation", "Assigned By", "Status"]);
    assert.deepEqual([...view.container.querySelectorAll("tbody")].map((tbody) => tbody.getAttribute("aria-label")), ["Build Machine", "Laptop"]);
    assert.doesNotMatch(view.container.textContent ?? "", /Machine × Agents|Desired invocation is configuration/);
  } finally { await view.unmount(); }
});

test("Claude Code linked and Codex unable to run Manual Only: 1 of 2 Linked, and the machine is not badged Error", async () => {
  const runners = [machine("a", "Build Machine", [claude, codex])];
  const view = await render({
    runners,
    rules: [rule({ invocation: "manual" })],
    machineSkills: { a: told([["claude", "manual"], ["codex", "manual"]], [["claude", "linked"], ["codex", "unsupported"]]) },
  });
  try {
    assert.deepEqual(view.cells("Build Machine", "Claude Code"), ["Claude Code", "Manual Only", "Direct", "Linked"]);
    assert.deepEqual(view.cells("Build Machine", "Codex"), ["Codex", "Manual Only", "Direct", "Error"]);
    assert.equal(view.rowOf("Build Machine", "Codex")?.querySelector(".skill-deployment-reason")?.textContent, "Can't run manual-only skills.");
    const head = view.group("Build Machine")!.querySelector(".skill-deployment-machine")!;
    assert.match(head.textContent ?? "", /1 of 2 Linked/);
    assert.deepEqual([...head.querySelectorAll(".status")].map((badge) => badge.textContent), ["Online"]);
  } finally { await view.unmount(); }
});

test("a skill assigned only through a group names the group, never that nothing targets the machine", async () => {
  const runners = [machine("a", "Build Machine", [claude])];
  const view = await render({
    runners,
    rules: [rule({ id: "group-rule", groupId: "g" })],
    groupName: (id) => (id === "g" ? "Reviewers" : undefined),
    machineSkills: { a: told([["claude", "agent"]], [["claude", "linked"]]) },
  });
  try {
    assert.deepEqual(view.cells("Build Machine", "Claude Code"), ["Claude Code", "Agent Invocable", "Reviewers", "Linked"]);
    assert.doesNotMatch(view.container.textContent ?? "", /No assignment targets this machine/);
  } finally { await view.unmount(); }
});

test("an offline machine updates when back online; an online one has an icon Sync Now", async () => {
  const runners = [machine("a", "Build Machine", [claude]), machine("b", "Laptop", [claude], { status: "offline" })];
  const view = await render({ runners, machineSkills: { a: told([["claude", "agent"]]), b: told([["claude", "agent"]]) } });
  try {
    const online = view.group("Build Machine")!.querySelector<HTMLButtonElement>('button[aria-label="Sync Now"]');
    assert.ok(online);
    assert.equal(online!.textContent, "", "an icon button");
    await act(async () => online!.click());
    assert.deepEqual(view.synced, ["a"]);
    const offline = view.group("Laptop")!;
    assertNoDomNode(offline.querySelector('button[aria-label="Sync Now"]'));
    assert.match(offline.textContent ?? "", /Updates when back online/);
    assert.equal(offline.querySelector(".status")?.classList.contains("hollow"), true, "Offline has the hollow dot");
  } finally { await view.unmount(); }
});

test("agents that can't receive managed skills fold into one row that expands to them", async () => {
  const acp = ["gemini", "goose", "amp", "cursor", "aider", "kiro"].map((id) => agent(id, `Agent ${id}`, "acp"));
  const runners = [machine("a", "Build Machine", [claude, ...acp])];
  const view = await render({ runners, machineSkills: { a: told([["claude", "agent"]], [["claude", "linked"]]) } });
  try {
    const toggle = view.group("Build Machine")!.querySelector<HTMLButtonElement>(".skill-deployment-ineligible button")!;
    assert.equal(toggle.textContent, "6 Agents Can't Receive Managed Skills");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(view.group("Build Machine")!.querySelectorAll("tr.skill-deployment-agent").length, 1);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(view.group("Build Machine")!.querySelectorAll("tr.skill-deployment-agent").length, 7);
    assert.deepEqual(view.cells("Build Machine", "Agent gemini"), ["Agent gemini", "—", "—", ""]);
    assert.match(view.group("Build Machine")!.querySelector(".skill-deployment-machine")!.textContent ?? "", /1 of 1 Linked/,
      "the count is over the agents that can receive it");
  } finally { await view.unmount(); }
});

test("container and cloud targets are one plain sentence on their machine's row", async () => {
  const runners = [
    machine("a", "Build Machine", [claude], { executionTargets: [target("host", "Runner Host", "host"), target("c", "Offline Container", "container"), target("d", "Cloud Sandbox", "cloud")] }),
    machine("b", "Host Machine", [claude], { executionTargets: [target("host", "Runner Host", "host")] }),
  ];
  const view = await render({ runners, machineSkills: { a: told([["claude", "agent"]]), b: told([["claude", "agent"]]) } });
  try {
    assert.equal(view.group("Build Machine")!.querySelector(".skill-deployment-machine .cell-note")?.textContent,
      "Assigned skills load only in host sessions, so they don't reach Offline Container or Cloud Sandbox.");
    assertNoDomNode(view.group("Host Machine")!.querySelector(".skill-deployment-machine .cell-note"));
  } finally { await view.unmount(); }
});

test("a skill deployed nowhere says why; a built-in one says it reaches machines once assigned", async () => {
  const runners = [machine("a", "Build Machine", [claude])];
  const view = await render({
    runners, rules: [], machineSkills: { a: { desired: [], reported: null } },
    skill: { id: "skill-1", name: "code-review", builtIn: { release: "1", heldUpdate: null } },
  });
  try {
    const notice = view.container.querySelector(".notice");
    assert.equal(notice?.classList.contains("t-neutral"), true);
    assert.equal(notice?.querySelector(".notice-title")?.textContent, "Not Deployed Anywhere");
    assert.match(notice?.textContent ?? "", /It isn't assigned yet\. Built-in skills reach a machine only after you assign them\./);
  } finally { await view.unmount(); }
  const deployed = await render({ runners, machineSkills: { a: told([["claude", "agent"]]) } });
  try {
    assertNoDomNode(deployed.container.querySelector(".notice"));
  } finally { await deployed.unmount(); }
});

test("version policy reads Track Latest or Pinned to its version number", async () => {
  const runners = [machine("a", "Build Machine", [claude]), machine("b", "Laptop", [claude])];
  const view = await render({ runners, machineSkills: { a: told([["claude", "agent"]]), b: told([["claude", "agent"]]) } }, {
    getMachineSkillVersionPolicy: async (_skillId: string, runnerId: string) =>
      ({ policy: runnerId === "a" ? { versionId: "skillv_old", revision: "r" } : null }),
    listSkillVersions: async () => ({ versions: [{ id: "skillv_old", versionNumber: 2 }], nextCursor: null }),
  } as Partial<ApiClient>);
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(view.group("Build Machine")!.textContent ?? "", /Pinned to v2/);
    assert.doesNotMatch(view.group("Build Machine")!.textContent ?? "", /skillv_/);
    assert.match(view.group("Laptop")!.textContent ?? "", /Track Latest/);
  } finally { await view.unmount(); }
});

test("a machine lists only this skill's link removals", async () => {
  const runners = [machine("a", "Build Machine", [claude])];
  const state = told([["claude", "agent"]], [["claude", "linked"]]);
  state.reported!.removals = [
    { path: "~/.codex/skills/code-review", reason: "No longer in the desired skill list." },
    { path: "~/.codex/skills/release-notes", reason: "No longer in the desired skill list." },
  ];
  const view = await render({ runners, machineSkills: { a: state } });
  try {
    const notes = [...view.group("Build Machine")!.querySelectorAll(".skill-deployment-machine .cell-note")].map((note) => note.textContent);
    assert.deepEqual(notes, ["Removed ~/.codex/skills/code-review: No longer in the desired skill list."]);
    assert.doesNotMatch(view.container.textContent ?? "", /release-notes/);
  } finally { await view.unmount(); }
});
