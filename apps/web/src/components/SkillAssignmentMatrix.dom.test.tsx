import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ExecutionTargetDefinition, RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { SkillAssignmentMatrix } from "./SkillAssignmentMatrix.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function target(id: string, name: string, adapter: ExecutionTargetDefinition["adapter"]): ExecutionTargetDefinition {
  return {
    id, runnerId: "runner", name, kind: adapter === "host" ? "local" : adapter, workspaceStrategy: "worktree", adapter,
    boundaries: { filesystem: adapter === "host" ? "worktree" : adapter === "cloud" ? "snapshot" : "container", network: "deny", secrets: "none", billing: "none" },
    available: true,
  } as ExecutionTargetDefinition;
}

function machine(runnerId: string, displayName: string, executionTargets?: ExecutionTargetDefinition[]): RunnerView {
  return {
    runnerId, hostname: runnerId, displayName, os: "linux", version: "1", status: "online",
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
    workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 1,
    ...(executionTargets ? { executionTargets } : {}),
  } as RunnerView;
}

async function renderNotes(runners: RunnerView[]): Promise<Record<string, string | null>> {
  const client = { ...api, getMachineSkillVersionPolicy: async () => ({ policy: null }) } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <SkillAssignmentMatrix skillId="skill-1" skillName="code-review" runners={runners}
          machineLabels={new Map(runners.map((runner) => [runner.runnerId, runner.displayName!]))}
          machineSkills={{}} onManageVersion={() => {}} />
      </ApiProvider>,
    ));
    return Object.fromEntries(runners.map((runner) => {
      const article = container.querySelector(`[aria-label="Assignments on ${runner.displayName}"]`);
      const note = article?.querySelector('[role="note"]');
      assert.equal(note?.getAttribute("aria-label") ?? "Skills Unavailable on Container and Cloud Targets",
        "Skills Unavailable on Container and Cloud Targets");
      return [runner.displayName!, note?.textContent ?? null];
    }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("Machines with container or cloud targets say assigned skills are unavailable there", async () => {
  const notes = await renderNotes([
    machine("runner-1", "Build Machine", [
      target("host", "Runner Host", "host"),
      target("container", "Offline Container", "container"),
      target("cloud", "Cloud Sandbox", "cloud"),
    ]),
    machine("runner-2", "Container Machine", [target("host", "Runner Host", "host"), target("c", "Offline Container", "container")]),
  ]);
  assert.match(notes["Build Machine"] ?? "", /^Managed skills from this Machine are unavailable on container and cloud targets, because only the workspace is mounted\. Assigned skills load only for host sessions\. Affected targets: Offline Container, Cloud Sandbox\.$/u);
  assert.match(notes["Container Machine"] ?? "", /Affected target: Offline Container\.$/u);
});

test("host-only Machines and runners without advertised targets show no note", async () => {
  const notes = await renderNotes([
    machine("runner-1", "Host Machine", [target("host", "Runner Host", "host")]),
    machine("runner-2", "Older Machine"),
  ]);
  assert.deepEqual(notes, { "Host Machine": null, "Older Machine": null });
});
