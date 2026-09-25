import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { SkillsView } from "./SkillsView.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
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
      deployed: [{ name: "code-review", digest: "d1", providerAccountId: "work",
        links: [{ agentId: "claude", status: "linked" }] }],
      unmanaged: [{ agentId: "claude", name: "local-notes", description: "Scratch skill",
        providerAccountId: "work" }],
      removals: [{
        path: "~/.codex/skills/retired-skill",
        reason: "No longer in the desired skill list.",
        providerAccountId: "work",
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
  assert.match(pageText(), /Work/, "account-scoped inventory names the credential home without exposing its path");
  assert.match(pageText(), /can then be adopted with an explicit recovery-aware confirmation/);
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

test("SkillsView shows Drift for an edited deployed copy and resolves it by import or confirmed restore", async () => {
  const digest = "d".repeat(64);
  const observedDigest = "e".repeat(64);
  const drifted: RunnerSkillsResponse = {
    removalReporting: "supported",
    driftReporting: "supported",
    desired: [{ name: "code-review", versionDigest: digest, targets: [{ agentId: "claude", invocation: "agent" }] }],
    reported: {
      deployed: [{ name: "code-review", digest, links: [{ agentId: "claude", status: "conflict", detail: "Held." }] }],
      unmanaged: [],
      drift: [{ name: "code-review", digest, variant: "agent", observedDigest, held: true,
        detail: "Updates and removals for this skill are held until the edit is imported as a new version or the library version is restored." }],
      updatedAt: 1_700_000_000_000,
    },
  };
  let current = drifted;
  const calls: string[] = [];
  const confirmations: string[] = [];
  const skillMd = "---\nname: code-review\n---\nReview.\n";
  const client = {
    ...api,
    listSkills: async () => ({ skills: [{ id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest } }] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill: { id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest } },
      latestVersion: { id: "v1", digest, files: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" as const }] } }),
    listSkillAssignments: async () => ({ assignments: [] }),
    listSkillVersions: async () => ({ versions: [], nextCursor: null }),
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    runnerSkills: async () => current,
    syncRunnerSkills: async () => current.reported!,
    previewSkillDrift: async (runnerId: string, copy: { name: string; digest: string; variant: string }) => {
      calls.push(`preview:${runnerId}:${copy.name}:${copy.variant}`);
      return {
        previewId: "review-1", drift: { ...copy, observedDigest },
        files: [{ path: "SKILL.md", content: `${skillMd}Hand edit.\n`, encoding: "utf8" }],
        previousFiles: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" }],
        digest: "f".repeat(64), importable: true, disposition: "update", publishedFromLatest: true,
        pinned: false, assignmentCount: 1,
      };
    },
    discardSkillDriftPreview: async () => { calls.push("discard"); },
    importSkillDrift: async (previewId: string, acceptUpdate: boolean) => {
      calls.push(`import:${previewId}:${acceptUpdate}`);
      current = { ...drifted, reported: { ...drifted.reported!, drift: [] } };
      return { released: false, pinMoved: false, state: current.reported };
    },
    restoreSkillDrift: async (runnerId: string, copy: { digest: string }, fence: string | null) => {
      calls.push(`restore:${runnerId}:${copy.digest === digest}:${fence === observedDigest}`);
      current = { ...drifted, reported: { ...drifted.reported!, drift: [] } };
      return { status: "restored", state: current.reported };
    },
  } as unknown as ApiClient;
  const feedback = {
    confirm: async (options: { title: string; confirmLabel?: string }) => {
      confirmations.push(`${options.title}|${options.confirmLabel}`);
      return true;
    },
    showToast: () => -1,
    showUndo: () => -1,
    dismissToast: () => undefined,
  };

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "skills-drift", runtimeKey: "skills-drift:1", createSocket: () => socket, close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SkillsWhenReady />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  const item = container.querySelector<HTMLButtonElement>(".skills-item");
  assert.match(item?.textContent ?? "", /Drift/, "the skill list marks a skill with an edited copy");
  await act(async () => { item!.click(); });
  await act(settle);
  const machine = container.querySelector(".skills-machine");
  assert.match(machine?.querySelector(".status-badge")?.textContent ?? "", /^Drift$/);
  assert.match(machine?.textContent ?? "", /Edited Copies/);
  assert.match(machine?.textContent ?? "", /Agent Invocable Copy/);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);

  await act(async () => { button("Import Edit as New Version")!.click(); });
  await act(settle);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "Import Edit as New Version opens a review dialog");
  assert.match(dialog!.textContent ?? "", /Hand edit\./);
  const importButton = [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "Import Edit as New Version");
  assert.equal(importButton!.disabled, true, "the version diff must be accepted first");
  await act(async () => { dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  assert.equal(importButton!.disabled, false);
  await act(async () => { importButton!.click(); });
  await act(settle);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.doesNotMatch(container.querySelector(".skills-machine")?.textContent ?? "", /Edited Copies/);

  current = drifted;
  await act(async () => { button("Sync Now")?.click(); });
  await act(settle);
  await act(async () => { button("Restore Library Version")!.click(); });
  await act(settle);
  assert.deepEqual(confirmations, ["Restore the library version of “code-review”?|Restore Library Version"]);
  assert.deepEqual(calls, [
    "preview:runner-1:code-review:agent",
    "import:review-1:true",
    "restore:runner-1:true:true",
  ]);
  assert.doesNotMatch(container.querySelector(".skills-machine")?.textContent ?? "", /Edited Copies/);

  await act(async () => root.unmount());
  container.remove();
});

test("SkillsView lists orphaned copies per machine and resolves them by review and import or fenced discard", async () => {
  const keptId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const unreadableId = "1f0e0d0c-0b0a-4908-8706-050403020100";
  const digest = "d".repeat(64);
  const orphaned: RunnerSkillsResponse = {
    removalReporting: "supported",
    driftReporting: "supported",
    keptAsideReporting: "supported",
    desired: [],
    reported: { deployed: [], unmanaged: [], keptAsideOmitted: 2, updatedAt: 1_700_000_000_000 },
    orphaned: [
      { kind: "kept_aside", id: keptId, name: "notes", digest, variant: "manual", keptAsideAt: 1_700_000_000_000,
        observedDigest: "e".repeat(64), observedFingerprint: "c".repeat(64), detail: "A restore kept this edited copy aside in the skill store instead of deleting it." },
      { kind: "kept_aside", id: unreadableId, observedFingerprint: "f".repeat(64),
        detail: "An earlier runner kept this edited copy aside without recording the skill version it came from." },
      { kind: "deleted_skill", name: "retired", digest, variant: "agent", observedDigest: "a".repeat(64), held: true },
    ],
  };
  let current = orphaned;
  const calls: string[] = [];
  const confirmations: string[] = [];
  const skillMd = "---\nname: notes\n---\nKeep notes.\n";
  const client = {
    ...api,
    listSkills: async () => ({ skills: [{ id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest } }] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill: { id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest } },
      latestVersion: { id: "v1", digest, files: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" as const }] } }),
    listSkillAssignments: async () => ({ assignments: [] }),
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    runnerSkills: async () => current,
    syncRunnerSkills: async () => current.reported!,
    previewOrphanedSkillCopy: async (runnerId: string, copy: { kind: string; id?: string }) => {
      calls.push(`preview:${runnerId}:${copy.kind}:${copy.id}`);
      return {
        previewId: "review-1", copy: { ...copy, observedDigest: "e".repeat(64) }, name: "notes",
        files: [{ path: "SKILL.md", content: `${skillMd}Recovered edit.\n`, encoding: "utf8" }],
        previousFiles: [], digest: "e".repeat(64), importable: true, disposition: "new", assignmentCount: 0,
      };
    },
    discardOrphanedSkillCopyPreview: async () => { calls.push("discard-preview"); },
    importOrphanedSkillCopy: async (previewId: string, acceptUpdate: boolean) => {
      calls.push(`import:${previewId}:${acceptUpdate}`);
      current = { ...orphaned, orphaned: orphaned.orphaned!.slice(1) };
      return { released: true, state: current.reported };
    },
    discardOrphanedSkillCopy: async (runnerId: string, copy: { kind: string; id?: string; name?: string }, observation: object) => {
      calls.push(`discard:${runnerId}:${copy.kind}:${copy.id ?? copy.name}:${JSON.stringify(observation)}`);
      current = { ...orphaned, reported: { ...orphaned.reported!, keptAsideOmitted: 0 }, orphaned: [] };
      return { status: "discarded", state: current.reported };
    },
  } as unknown as ApiClient;
  const feedback = {
    confirm: async (options: { title: string; message: string; confirmLabel?: string }) => {
      confirmations.push(`${options.title}|${options.confirmLabel}`);
      return true;
    },
    showToast: () => -1,
    showUndo: () => -1,
    dismissToast: () => undefined,
  };

  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "skills-orphans", runtimeKey: "skills-orphans:1", createSocket: () => socket, close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SkillsWhenReady />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((candidate) => candidate.textContent?.trim() === label);
  const entry = [...container.querySelectorAll<HTMLButtonElement>(".skills-item")]
    .find((candidate) => candidate.textContent?.includes("Orphaned Copies"));
  assert.ok(entry, "the skill list offers the orphaned copies independent of any library skill");
  assert.match(entry!.textContent ?? "", /Orphaned Copies5/, "copies beyond the runner's bound are counted");
  await act(async () => { entry!.click(); });
  await act(settle);
  const machine = container.querySelector('[aria-label="Orphaned Copies"] .skills-machine');
  assert.match(machine?.textContent ?? "", /Build Machine/);
  const items = [...machine!.querySelectorAll(".skills-orphans li")];
  assert.equal(items.length, 3);
  assert.match(items[0]!.textContent ?? "", /notes.*Kept Aside.*Manual Only.*dddddddddddd.*Readable.*\.drift-0f0e0d0c/);
  assert.match(items[1]!.textContent ?? "", /Unidentified Copy.*Kept Aside.*Unknown.*Unreadable/);
  assert.match(items[2]!.textContent ?? "", /retired.*Deleted Skill.*Agent Invocable.*links still serve the copy/);
  assert.match(machine!.textContent ?? "", /2 more kept-aside copies are not listed\./);
  assert.equal(button("Review and Import")[1]!.disabled, true, "an unreadable copy cannot be reviewed");
  assert.equal(button("Discard Copy")[1]!.disabled, false, "a fingerprinted unreadable copy can be discarded");

  await act(async () => { button("Review and Import")[0]!.click(); });
  await act(settle);
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, "Review and Import opens a review dialog");
  assert.match(dialog!.textContent ?? "", /Recovered edit\./);
  assert.match(dialog!.textContent ?? "", /creates it with no assignments/);
  const importButton = [...dialog!.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "Import as New Skill");
  assert.equal(importButton?.disabled, false, "a new skill needs no diff acceptance");
  await act(async () => { importButton!.click(); });
  await act(settle);
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(container.querySelectorAll(".skills-orphans li").length, 2);

  await act(async () => { button("Discard Copy")[0]!.click(); });
  await act(settle);
  assert.deepEqual(confirmations, ["Discard this unidentified kept-aside copy?|Discard Copy"]);
  assert.deepEqual(calls, [
    `preview:runner-1:kept_aside:${keptId}`,
    "import:review-1:false",
    `discard:runner-1:kept_aside:${unreadableId}:{"observedFingerprint":"${"f".repeat(64)}"}`,
  ]);
  assert.match(container.querySelector('[aria-label="Orphaned Copies"]')?.textContent ?? "", /No orphaned copies are reported\./);

  await act(async () => root.unmount());
  container.remove();
});

test("SkillsView keeps the orphaned copies entry reachable for a runner that cannot report kept-aside copies", async () => {
  const older: RunnerSkillsResponse = {
    removalReporting: "supported", driftReporting: "supported", keptAsideReporting: "unsupported",
    desired: [], reported: { deployed: [], unmanaged: [], updatedAt: 1_700_000_000_000 }, orphaned: [],
  };
  const client = {
    ...api,
    listSkills: async () => ({ skills: [] }),
    listSkillGroups: async () => ({ groups: [] }),
    runnerSkills: async () => older,
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "skills-older", runtimeKey: "skills-older:1", createSocket: () => socket, close() {},
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
      runners: [{ ...runner, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift }], boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  const entry = [...container.querySelectorAll<HTMLButtonElement>(".skills-item")]
    .find((candidate) => candidate.textContent?.includes("Orphaned Copies"));
  assert.ok(entry, "an older runner's unreported copies are not hidden behind an empty list");
  assert.equal(entry!.querySelector(".status-badge"), null, "no count is claimed");
  await act(async () => { entry!.click(); });
  await act(settle);
  assert.match(container.querySelector('[aria-label="Orphaned Copies"]')?.textContent ?? "",
    /This runner version cannot report copies a restore kept aside\. Update it to list them here\./);

  await act(async () => root.unmount());
  container.remove();
});

/** Mount the Skills view against a client and deliver a one-runner snapshot. */
async function mountSkills(client: ApiClient, instanceId: string) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId, runtimeKey: `${instanceId}:1`, createSocket: () => socket, close() {},
  };
  const feedback = { confirm: async () => true, showToast: () => -1, showUndo: () => -1, dismissToast: () => undefined };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <SkillsWhenReady />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  const button = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  const listItem = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".skills-item")]
    .find((candidate) => candidate.querySelector(".skills-item-name")?.firstChild?.textContent === name);
  return {
    container, button, listItem,
    async click(target: HTMLElement | undefined) {
      assert.ok(target);
      await act(async () => { target.click(); });
      await act(settle);
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("SkillsView marks built-in skills recommended, assigns one in a step, and dismisses the recommendation", async () => {
  const skillMd = "---\nname: using-wollipog\ndescription: Operate Wollipog sessions.\n---\nUse the CLI.\n";
  const skill = {
    id: "skill-builtin", name: "using-wollipog", description: "Operate Wollipog sessions.", source: "builtin",
    builtIn: { release: "0.28.0", heldUpdate: null as { release: string; digest: string } | null },
    recommendation: { dismissed: false },
    assignmentCount: 0,
    latestVersion: { id: "v1", digest: "d1", createdAt: 1 },
  };
  const assignments: unknown[] = [];
  const calls: unknown[] = [];
  const client = {
    ...api,
    listSkills: async () => ({ skills: [structuredClone(skill)] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill: structuredClone(skill),
      latestVersion: { id: "v1", digest: "d1", files: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" as const }] } }),
    listSkillAssignments: async () => ({ assignments }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    createSkillAssignment: async (body: Record<string, unknown>) => {
      calls.push(body);
      skill.assignmentCount += 1;
      const assignment = { id: `assignment-${skill.assignmentCount}`, enabled: true, ...body };
      assignments.push(assignment);
      return { assignment };
    },
    deleteSkillAssignment: async () => {
      assignments.length = 0;
      skill.assignmentCount = 0;
    },
    setSkillRecommendationDismissed: async (id: string, dismissed: boolean) => {
      calls.push({ id, dismissed });
      skill.recommendation = { dismissed };
      return { skill: structuredClone(skill) };
    },
  } as unknown as ApiClient;
  const view = await mountSkills(client, "skills-built-in");
  const badges = () => [...view.listItem("using-wollipog")!.querySelectorAll(".status-badge")].map((badge) => badge.textContent);
  assert.deepEqual(badges(), ["Built-In", "Recommended"]);

  await view.click(view.listItem("using-wollipog"));
  const section = () => view.container.querySelector('[aria-label="Built-In Skill"]');
  assert.match(section()?.textContent ?? "", /Ships with Wollipog 0\.28\.0/);
  assert.match(section()?.textContent ?? "", /It is not deployed until you assign it/);

  await view.click(view.button("Assign to All Machines"));
  assert.deepEqual(calls.at(-1), { skillId: "skill-builtin", scopeKind: "instance", agentSelector: { kind: "all" }, invocation: "agent" });
  assert.deepEqual(badges(), ["Built-In"], "an assigned built-in skill is no longer recommended");
  assert.equal(view.button("Assign to All Machines"), undefined);

  // Removing the assignment brings the recommendation back; a machine can be chosen instead.
  await view.click(view.button("Delete"));
  assert.deepEqual(badges(), ["Built-In", "Recommended"]);
  await view.click(view.button("Assign to Machine"));
  assert.deepEqual(calls.at(-1), {
    skillId: "skill-builtin", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "all" }, invocation: "agent",
  });

  await view.click(view.button("Delete"));
  await view.click(view.button("Dismiss Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: true });
  assert.deepEqual(badges(), ["Built-In"], "a dismissed recommendation is hidden and the library entry stays");
  assert.match(section()?.textContent ?? "", /You dismissed this recommendation\./);
  // Release content held by local library changes waits for review.
  skill.builtIn.heldUpdate = { release: "0.29.0", digest: "d2" };
  await view.click(view.button("Show Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: false });
  assert.deepEqual(badges(), ["Built-In", "Recommended"]);
  assert.match(section()?.textContent ?? "", /Wollipog 0\.29\.0 includes an updated version/);
  assert.ok(view.button("Review Built-In Update"));
  await view.unmount();
});

test("SkillsView offers a same-name skill the built-in version and adopts it after explicit diff acceptance", async () => {
  const mine = "---\nname: orchestrate-issues\n---\nMine.\n";
  const release = "---\nname: orchestrate-issues\n---\nRelease.\n";
  let skill: Record<string, unknown> = {
    id: "skill-mine", name: "orchestrate-issues", source: "git", assignmentCount: 2,
    builtInOffer: { release: "0.28.0", digest: "r1" },
    gitAutoUpdate: { enabled: true },
    latestVersion: { id: "v1", digest: "m1" },
  };
  const accepted: unknown[] = [];
  const client = {
    ...api,
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill, latestVersion: { id: "v1", digest: "m1", files: [{ path: "SKILL.md", content: mine, encoding: "utf8" as const }] } }),
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    getBuiltInSkillVersion: async () => ({
      kind: "adopt", release: "0.28.0", digest: "r1",
      files: [{ path: "SKILL.md", content: release, encoding: "utf8" }],
      currentVersion: { id: "v1", digest: "m1", files: [{ path: "SKILL.md", content: mine, encoding: "utf8" }] },
      expectedLatestVersionId: "v1", assignmentCount: 2, gitAutoUpdate: true,
    }),
    acceptBuiltInSkillVersion: async (id: string, body: unknown) => {
      accepted.push({ id, body });
      skill = { ...skill, source: "builtin", builtInOffer: undefined, gitAutoUpdate: { enabled: false },
        builtIn: { release: "0.28.0", heldUpdate: null }, recommendation: { dismissed: false } };
      return { skill };
    },
  } as unknown as ApiClient;
  const view = await mountSkills(client, "skills-built-in-offer");
  assert.equal(view.listItem("orchestrate-issues")!.querySelector(".status-badge"), null, "a user-managed skill is not marked built-in");
  await view.click(view.listItem("orchestrate-issues"));
  const offer = view.container.querySelector('[aria-label="Built-In Version Available"]');
  assert.match(offer?.textContent ?? "", /This library skill stays exactly as it is unless you review and accept the built-in version/);
  assert.match(offer?.textContent ?? "", /Accepting also turns off this skill's automatic Git updates\./);

  await view.click(view.button("Review Built-In Version"));
  const dialog = view.container.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent ?? "", /2 existing assignments and every machine pin stay as they are/);
  assert.match(dialog.textContent ?? "", /Accepting turns off this skill's automatic Git updates\./);
  assert.match(dialog.textContent ?? "", /SKILL\.md · Changed/);
  const acceptButton = view.button("Accept Built-In Version", dialog)!;
  assert.equal(acceptButton.disabled, true, "the version diff must be accepted first");
  await act(async () => { dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  assert.equal(acceptButton.disabled, false);
  await view.click(acceptButton);
  assert.deepEqual(accepted, [{ id: "skill-mine", body: { digest: "r1", expectedLatestVersionId: "v1" } }]);
  assert.equal(view.container.querySelector('[role="dialog"]'), null);
  assert.equal(view.container.querySelector('[aria-label="Built-In Version Available"]'), null);
  assert.ok(view.container.querySelector('[aria-label="Built-In Skill"]'));
  await view.unmount();
});

test("SkillsView follows the route's selected skill, including back to no selection", async () => {
  const skill = { id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest: "d1" } };
  let hold: Promise<void> | null = null;
  const client = {
    ...api,
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => {
      await hold;
      return { skill, latestVersion: { id: "v1", digest: "d1", files: [] } };
    },
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
  } as unknown as ApiClient;
  let route!: (id: string | undefined) => void;
  function Routed() {
    const [id, setId] = React.useState<string | undefined>("skill-1");
    route = setId;
    const ready = useStoreSelector((state) => state.snapshotLoaded);
    return ready ? <SkillsView selectedSkillId={id} /> : null;
  }
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={{ instanceId: "skills-route", runtimeKey: "skills-route:1", createSocket: () => socket, close() {} }}
          navigation={navigation}>
          <Routed />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review", "the deep link selects its skill");
  await act(async () => { route(undefined); });
  await act(settle);
  assert.equal(container.querySelector(".skills-detail-head"), null, "the bare Skills route clears the selection");
  assert.match(container.querySelector(".skills-empty")?.textContent ?? "", /Select a skill/);

  // A detail load still pending when the route clears never repopulates the pane.
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  await act(async () => { route("skill-1"); });
  await act(async () => { route(undefined); });
  await act(async () => { release(); await hold; });
  await act(settle);
  assert.equal(container.querySelector(".skills-detail-head"), null, "a stale detail load is discarded");
  await act(async () => root.unmount());
  container.remove();
});
