import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { SkillsView } from "./SkillsView.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  displayName: "Build Machine",
  agents: [
    { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
  ],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 96,
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = {
  current: () => ({ name: "skills" }),
  push() {},
  listen: () => () => {},
};

function SkillsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <SkillsView /> : null;
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.resolve();
};

test("SkillsView lists skills, opens a detail with assignments and deployment, and syncs a machine", async () => {
  const skillMd = "---\nname: code-review\ndescription: Reviews code\n---\n\nAlways review the diff.\n";
  const runnerSkills: RunnerSkillsResponse = {
    removalReporting: "supported",
    desired: [{ name: "code-review", versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" }] }],
    reported: {
      deployed: [{ name: "code-review", digest: "d1", links: [{ agentId: "claude", status: "linked" }] }],
      unmanaged: [{ agentId: "claude", name: "local-notes", description: "Scratch skill" }],
      removals: [{
        path: "~/.codex/skills/retired-skill",
        reason: "No longer in the desired skill list.",
      }],
      removalsUpdatedAt: 1_699_999_000_000,
      updatedAt: 1_700_000_000_000,
    },
  };
  const syncedRunnerIds: string[] = [];
  let machineRefresh: Promise<RunnerSkillsResponse> | null = null;
  const client = {
    ...api,
    listSkills: async () => ({ skills: [{
      id: "skill-1", name: "code-review", description: "Reviews code",
      latestVersion: { id: "v1", digest: "d1", createdAt: 1_700_000_000_000 },
    }] }),
    listSkillGroups: async () => ({ groups: [] }),
    // Mirrors the real control-plane detail shape: the version (with files) is a sibling of
    // the skill record, not nested inside it.
    getSkill: async () => ({
      skill: {
        id: "skill-1", name: "code-review", description: "Reviews code",
        latestVersion: { id: "v1", digest: "d1", createdAt: 1_700_000_000_000 },
      },
      latestVersion: {
        id: "v1", digest: "d1", createdAt: 1_700_000_000_000,
        files: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" as const }],
      },
      assignments: [],
    }),
    listSkillAssignments: async () => ({ assignments: [{
      id: "assignment-1", skillId: "skill-1", scopeKind: "instance" as const,
      agentSelector: { kind: "all" as const }, enabled: true, invocation: "agent" as const,
    }] }),
    runnerSkills: async () => machineRefresh ?? runnerSkills,
    syncRunnerSkills: async (runnerId: string) => {
      syncedRunnerIds.push(runnerId);
      return runnerSkills.reported!;
    },
  } as unknown as ApiClient;

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "skills-1",
    runtimeKey: "skills-1:1",
    createSocket: () => socket,
    close() {},
  };

  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SkillsWhenReady />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners: [runner],
      boxes: [],
      sessions: [],
      runs: [],
      pods: [],
    });
  });
  await act(settle);

  const pageText = () => container.textContent ?? "";
  assert.match(pageText(), /Agent Skills/);
  const item = [...container.querySelectorAll<HTMLButtonElement>(".skills-item")]
    .find((candidate) => candidate.textContent?.includes("code-review"));
  assert.ok(item, "the grouped list renders the skill");

  await act(async () => { item!.click(); });
  await act(settle);

  // Detail pane: version metadata, rendered SKILL.md body, assignments, deployment, unmanaged.
  assert.match(pageText(), /Version d1/);
  assert.match(pageText(), /Always review the diff\./);
  assert.doesNotMatch(pageText(), /name: code-review/, "frontmatter stays out of the rendered content");
  assert.match(pageText(), /All Machines/);
  assert.match(pageText(), /All Agents/);
  assert.match(pageText(), /Build Machine/);
  assert.match(pageText(), /Deployed/);
  assert.match(pageText(), /Unmanaged Skills/);
  assert.match(pageText(), /local-notes/);
  assert.match(pageText(), /arrives later/);
  assert.match(pageText(), /Recent Link Removals/);
  assert.match(pageText(), /~\/\.codex\/skills\/retired-skill/);
  assert.match(pageText(), /No longer in the desired skill list\./);
  const removalHistoryText = container.querySelector(".skills-removals")?.textContent ?? "";
  assert.match(removalHistoryText, new RegExp(new Date(1_699_999_000_000).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(
    removalHistoryText,
    new RegExp(new Date(1_700_000_000_000).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "removal history displays its event timestamp rather than the newer inventory timestamp",
  );

  const sync = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "Sync Now");
  assert.ok(sync, "each machine offers Sync Now");

  let resolveMachineRefresh!: (response: RunnerSkillsResponse) => void;
  machineRefresh = new Promise((resolve) => { resolveMachineRefresh = resolve; });
  runnerSkills.removalReporting = "unsupported";
  await act(async () => {
    sync!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  assert.equal(sync!.textContent?.trim(), "Syncing…");
  assert.doesNotMatch(pageText(), /cannot report new managed link removals/,
    "manual sync preserves the last known capability while its inventory refresh is pending");
  assert.match(pageText(), /~\/\.codex\/skills\/retired-skill/,
    "the last removal event remains visible during the pending refresh");
  await act(async () => {
    resolveMachineRefresh(runnerSkills);
    await machineRefresh;
    await Promise.resolve();
  });
  machineRefresh = null;
  await act(settle);
  assert.match(pageText(), /cannot report new managed link removals/);
  assert.match(pageText(), /~\/\.codex\/skills\/retired-skill/,
    "a rollback runner does not hide the last event it reported before rollback");

  runnerSkills.removalReporting = "supported";
  runnerSkills.reported = { ...runnerSkills.reported!, removals: [] };
  await act(async () => { sync!.click(); });
  await act(settle);
  assert.match(pageText(), /No managed link removals have been reported/);

  runnerSkills.removalReporting = "future-value" as never;
  await act(async () => { sync!.click(); });
  await act(settle);
  assert.equal(container.querySelector(".skills-removals"), null,
    "an unknown future capability value degrades to the explicit unknown state");

  delete runnerSkills.removalReporting;
  await act(async () => { sync!.click(); });
  await act(settle);
  assert.equal(container.querySelector(".skills-removals"), null,
    "an older control plane that omits capability state never becomes a false empty-history claim");
  assert.deepEqual(syncedRunnerIds, ["runner-1", "runner-1", "runner-1", "runner-1"]);

  // The New Skill dialog opens with a template whose frontmatter is prefilled.
  const newSkill = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "New Skill");
  await act(async () => { newSkill!.click(); });
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "New Skill opens a dialog");
  assert.match(dialog!.textContent ?? "", /SKILL\.md/);
  assert.match((dialog!.querySelector("textarea") as HTMLTextAreaElement).value, /^---\nname: /);

  await act(async () => root.unmount());
  container.remove();
});
