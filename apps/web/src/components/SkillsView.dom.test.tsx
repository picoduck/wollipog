import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { SkillsView } from "./SkillsView.js";
import { RecommendedSkillsNotice } from "./RecommendedSkillsNotice.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
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

/** The route is the view's only selection, so the harness renders the store's current route. */
function SkillsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  const view = useStoreSelector((state) => state.view);
  return ready ? <SkillsView route={view.name === "skills" ? view : undefined} /> : null;
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

  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  const item = [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list .row")]
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
  // In the narrow table the headers are off screen, so each assignment cell names itself (§14).
  const assignmentLabels = [...container.querySelectorAll(".skills-table tbody tr:first-child .cell-label")]
    .map((label) => label.textContent?.trim());
  assert.deepEqual(assignmentLabels, ["Agents:", "Invocation", "Enabled"]);
  assert.match(pageText(), /Build Machine/);
  // A deployed copy is Linked in the shared skill-deployment vocabulary (docs/design-system.md §11.2).
  assert.match(pageText(), /Linked/);
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
  assertNoDomNode(container.querySelector(".skills-removals"),
    "an unknown future capability value degrades to the explicit unknown state");

  delete runnerSkills.removalReporting;
  await act(async () => { sync!.click(); });
  await act(settle);
  assertNoDomNode(container.querySelector(".skills-removals"),
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
  mountPoint.remove();
});

test("SkillsView shows Edited for an edited deployed copy and resolves it by import or confirmed restore", async () => {
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

  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  const item = container.querySelector<HTMLButtonElement>(".master-detail-list .row");
  assert.match(item?.textContent ?? "", /Edited/, "the skill list marks a skill with an edited copy");
  await act(async () => { item!.click(); });
  await act(settle);
  const machine = container.querySelector(".skills-machine");
  assert.match(machine?.querySelector(".status")?.textContent ?? "", /^Edited$/);
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
  assertNoDomNode(container.querySelector('[role="dialog"]'));
  assert.doesNotMatch(container.querySelector(".skills-machine")?.textContent ?? "", /Edited Copies/);

  current = drifted;
  await act(async () => { button("Sync Now")?.click(); });
  await act(settle);
  await act(async () => { button("Restore Library Version")!.click(); });
  await act(settle);
  assert.deepEqual(confirmations, ["Restore Library Version|Restore Library Version"]);
  assert.deepEqual(calls, [
    "preview:runner-1:code-review:agent",
    "import:review-1:true",
    "restore:runner-1:true:true",
  ]);
  assert.doesNotMatch(container.querySelector(".skills-machine")?.textContent ?? "", /Edited Copies/);

  await act(async () => root.unmount());
  mountPoint.remove();
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

  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  const entry = [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list .row")]
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
  assertNoDomNode(container.querySelector('[role="dialog"]'));
  assert.equal(container.querySelectorAll(".skills-orphans li").length, 2);

  await act(async () => { button("Discard Copy")[0]!.click(); });
  await act(settle);
  assert.deepEqual(confirmations, ["Discard Copy|Discard Copy"]);
  assert.deepEqual(calls, [
    `preview:runner-1:kept_aside:${keptId}`,
    "import:review-1:false",
    `discard:runner-1:kept_aside:${unreadableId}:{"observedFingerprint":"${"f".repeat(64)}"}`,
  ]);
  assert.match(container.querySelector('[aria-label="Orphaned Copies"]')?.textContent ?? "", /No orphaned copies are reported\./);

  await act(async () => root.unmount());
  mountPoint.remove();
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
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  // The library is empty, so one state spans both panes (§6.1); the copies stay one action away.
  assert.match(container.querySelector(".master-detail-state h2")?.textContent ?? "", /Yet$/);
  const review = [...container.querySelectorAll<HTMLButtonElement>(".master-detail-state .notice button")]
    .find((candidate) => candidate.textContent === "Review Orphaned Copies");
  assert.ok(review, "an older runner's unreported copies are not hidden behind an empty library");
  await act(async () => { review!.click(); });
  await act(settle);
  const entry = [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list .row")]
    .find((candidate) => candidate.textContent?.includes("Orphaned Copies"));
  assert.equal(entry?.getAttribute("aria-current"), "true", "/skills/orphans opens the panes on the entry");
  assertNoDomNode(entry!.querySelector(".count-badge"), "no count is claimed");
  assert.match(container.querySelector('[aria-label="Orphaned Copies"]')?.textContent ?? "",
    /This runner version cannot report copies a restore kept aside\. Update it to list them here\./);

  await act(async () => root.unmount());
  mountPoint.remove();
});

/** Mount the Skills view against a client and deliver a one-runner snapshot. */
async function mountSkills(client: ApiClient, instanceId: string) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  const listItem = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list .row")]
    .find((candidate) => candidate.querySelector(".row-title")?.textContent === name);
  /** The label of the list group a skill's row is in. */
  const groupOf = (name: string) => listItem(name)?.closest(".skill-list-group")?.getAttribute("aria-label");
  return {
    container, button, listItem, groupOf,
    async click(target: HTMLElement | undefined) {
      assert.ok(target);
      await act(async () => { target.click(); });
      await act(settle);
    },
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
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
  const badges = () => [...view.listItem("using-wollipog")!.querySelectorAll(".status")].map((badge) => badge.textContent);
  // Recommended is an offer, not a state: its own group at the top, and the row keeps only the flag.
  assert.deepEqual(badges(), ["Built-In"]);
  assert.equal(view.groupOf("using-wollipog"), "Recommended");

  await view.click(view.listItem("using-wollipog"));
  const section = () => view.container.querySelector('[aria-label="Built-In Skill"]');
  assert.match(section()?.textContent ?? "", /Ships with Wollipog 0\.28\.0/);
  assert.match(section()?.textContent ?? "", /It is not deployed until you assign it/);

  await view.click(view.button("Assign to All Machines"));
  assert.deepEqual(calls.at(-1), { skillId: "skill-builtin", scopeKind: "instance", agentSelector: { kind: "all" }, invocation: "agent" });
  assert.equal(view.groupOf("using-wollipog"), "No Group", "an assigned built-in skill is no longer recommended");
  assert.deepEqual(badges(), ["Built-In"]);
  assert.equal(view.button("Assign to All Machines"), undefined);

  // Removing the assignment brings the recommendation back; a machine can be chosen instead.
  await view.click(view.button("Delete"));
  assert.equal(view.groupOf("using-wollipog"), "Recommended");
  await view.click(view.button("Assign to Machine"));
  assert.deepEqual(calls.at(-1), {
    skillId: "skill-builtin", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "all" }, invocation: "agent",
  });

  await view.click(view.button("Delete"));
  await view.click(view.button("Dismiss Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: true });
  assert.equal(view.groupOf("using-wollipog"), "No Group", "a dismissed recommendation is hidden and the library entry stays");
  assert.match(section()?.textContent ?? "", /You dismissed this recommendation\./);
  // Release content held by local library changes waits for review.
  skill.builtIn.heldUpdate = { release: "0.29.0", digest: "d2" };
  await view.click(view.button("Show Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: false });
  assert.equal(view.groupOf("using-wollipog"), "Recommended");
  assert.deepEqual(badges(), ["Built-In", "Update Held"], "a held built-in update is the row's one status");
  assert.match(section()?.textContent ?? "", /Wollipog 0\.29\.0 includes an updated version/);
  assert.ok(view.button("Review Built-In Update"));
  await view.unmount();
});

test("a recommendation dismissed in the Skills view or the Inbox notice is dismissed in both", async () => {
  const skillMd = (name: string) => `---\nname: ${name}\n---\nBody.\n`;
  const skills = ["orchestrate-issues", "using-wollipog"].map((name) => ({
    id: `skill-${name}`, name, source: "builtin", builtIn: { release: "0.28.0", heldUpdate: null },
    assignmentCount: 0, latestVersion: { id: `v-${name}`, digest: "d1", createdAt: 1 },
  }));
  // One user's dismissals, shared by both surfaces as the control plane shares them.
  const dismissed = new Set<string>();
  const view = (skill: (typeof skills)[number]) => ({ ...skill, recommendation: { dismissed: dismissed.has(skill.id) } });
  const client = {
    ...api,
    listSkills: async () => ({ skills: skills.map(view) }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async (id: string) => {
      const skill = skills.find((candidate) => candidate.id === id)!;
      return { skill: view(skill), latestVersion: { id: skill.latestVersion.id, digest: "d1",
        files: [{ path: "SKILL.md", content: skillMd(skill.name), encoding: "utf8" as const }] } };
    },
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    setSkillRecommendationDismissed: async (id: string, value: boolean) => {
      if (value) dismissed.add(id); else dismissed.delete(id);
      return { skill: view(skills.find((candidate) => candidate.id === id)!) };
    },
  } as unknown as ApiClient;
  const mountNotice = async () => {
    const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(mountPoint as never);
    // Dialogs are portalled to <body>, so the test queries the body.
    const container = domWindow.document.body as unknown as HTMLDivElement;
    const root = createRoot(mountPoint);
    await act(async () => {
      root.render(<ApiProvider client={client}><RecommendedSkillsNotice onOpen={() => {}} /></ApiProvider>);
    });
    await act(settle);
    return {
      names: () => [...container.querySelectorAll(".recommended-skills-notice-list a")].map((link) => link.textContent),
      async dismiss(name: string) {
        const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Dismiss ${name}"]`);
        assert.ok(button);
        await act(async () => { button.click(); });
        await act(settle);
      },
      async unmount() { await act(async () => root.unmount()); mountPoint.remove(); },
    };
  };

  // Skills view to Inbox notice.
  const skillsView = await mountSkills(client, "skills-recommendation-surfaces");
  await skillsView.click(skillsView.listItem("using-wollipog"));
  await skillsView.click(skillsView.button("Dismiss Recommendation"));
  await skillsView.unmount();
  let notice = await mountNotice();
  assert.deepEqual(notice.names(), ["orchestrate-issues"]);

  // Inbox notice to Skills view.
  await notice.dismiss("orchestrate-issues");
  assert.deepEqual(notice.names(), []);
  await notice.unmount();
  const reopened = await mountSkills(client, "skills-recommendation-surfaces-2");
  const badges = (name: string) => [...reopened.listItem(name)!.querySelectorAll(".status")].map((badge) => badge.textContent);
  assert.deepEqual(badges("orchestrate-issues"), ["Built-In"]);
  await reopened.click(reopened.listItem("orchestrate-issues"));
  assert.match(reopened.container.querySelector('[aria-label="Built-In Skill"]')?.textContent ?? "", /You dismissed this recommendation\./);

  // Show Recommendation in the Skills view brings it back to the notice.
  await reopened.click(reopened.button("Show Recommendation"));
  await reopened.unmount();
  notice = await mountNotice();
  assert.deepEqual(notice.names(), ["orchestrate-issues"]);
  await notice.unmount();
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
  assert.deepEqual(
    [...view.listItem("orchestrate-issues")!.querySelectorAll(".status")].filter((badge) => badge.textContent === "Built-In"),
    [],
    "a user-managed skill is not marked built-in",
  );
  await view.click(view.listItem("orchestrate-issues"));
  const offer = view.container.querySelector('[aria-label="Built-In Version Available"]');
  assert.match(offer?.textContent ?? "", /This library skill stays exactly as it is unless you review and accept the built-in version/);
  assert.match(offer?.textContent ?? "", /Accepting also turns off this skill's automatic Git updates\./);

  await view.click(view.button("Review Built-In Version"));
  const dialog = view.container.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent ?? "", /2 existing assignments and every machine pin stay as they are/);
  assert.match(dialog.textContent ?? "", /Accepting turns off this skill's automatic Git updates\./);
  const file = dialog.querySelector(".skill-diff-file")!;
  assert.match(file.querySelector(".skill-diff-file-head")?.textContent ?? "", /SKILL\.md.*Changed/);
  assert.equal(file.querySelectorAll(".diff-line-del").length, 1);
  assert.equal(file.querySelectorAll(".diff-line-add").length, 1);
  const acceptButton = view.button("Accept Built-In Version", dialog)!;
  assert.equal(acceptButton.disabled, true, "the deploy consent must be given first");
  const consent = dialog.querySelector<HTMLElement>(".modal-foot .review-consent")!;
  assert.equal(consent.textContent, "Deploy to 2 existing assignments");
  await act(async () => { consent.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  assert.equal(acceptButton.disabled, false);
  await view.click(acceptButton);
  assert.deepEqual(accepted, [{ id: "skill-mine", body: { digest: "r1", expectedLatestVersionId: "v1" } }]);
  assertNoDomNode(view.container.querySelector('[role="dialog"]'));
  assertNoDomNode(view.container.querySelector('[aria-label="Built-In Version Available"]'));
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
    return ready ? <SkillsView route={{ name: "skills", ...(id ? { id } : {}) }} /> : null;
  }
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
  assertNoDomNode(container.querySelector(".skills-detail-head"), "the bare Skills route clears the selection");
  assert.match(container.querySelector(".master-detail-detail")?.textContent ?? "", /Select a skill/);

  // A detail load still pending when the route clears never repopulates the pane.
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  await act(async () => { route("skill-1"); });
  await act(async () => { route(undefined); });
  await act(async () => { release(); await hold; });
  await act(settle);
  assertNoDomNode(container.querySelector(".skills-detail-head"), "a stale detail load is discarded");
  await act(async () => root.unmount());
  mountPoint.remove();
});

test("SkillsView keeps following the selection when a mutation finishes after the user moved on", async () => {
  const builtIn = { id: "skill-a", name: "using-wollipog", builtIn: { release: "0.28.0", heldUpdate: null },
    recommendation: { dismissed: false }, assignmentCount: 0, latestVersion: { id: "va", digest: "da" } };
  const other = { id: "skill-b", name: "code-review", latestVersion: { id: "vb", digest: "db" } };
  let finishDismissal!: () => void;
  const dismissal = new Promise<void>((resolve) => { finishDismissal = resolve; });
  const client = {
    ...api,
    listSkills: async () => ({ skills: [builtIn, other] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async (id: string) => {
      const skill = id === builtIn.id ? builtIn : other;
      return { skill, latestVersion: { ...skill.latestVersion, files: [] } };
    },
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    setSkillRecommendationDismissed: async () => {
      await dismissal;
      return { skill: { ...builtIn, recommendation: { dismissed: true } } };
    },
  } as unknown as ApiClient;
  let route!: (id: string | undefined) => void;
  function Routed() {
    const [id, setId] = React.useState<string | undefined>(builtIn.id);
    route = setId;
    const ready = useStoreSelector((state) => state.snapshotLoaded);
    return ready ? <SkillsView route={{ name: "skills", ...(id ? { id } : {}) }} /> : null;
  }
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={{ instanceId: "skills-late", runtimeKey: "skills-late:1", createSocket: () => socket, close() {} }}
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
  const heading = () => container.querySelector(".skills-detail-head h3")?.textContent;
  assert.equal(heading(), "using-wollipog");
  const dismiss = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "Dismiss Recommendation")!;
  await act(async () => { dismiss.click(); });
  await act(async () => { route(other.id); });
  await act(settle);
  assert.equal(heading(), "code-review");
  await act(async () => { finishDismissal(); await dismissal; });
  await act(settle);
  assert.equal(heading(), "code-review", "the finished mutation does not bring back the skill the user left");
  await act(async () => root.unmount());
  mountPoint.remove();
});

const oneSkill = { id: "skill-1", name: "code-review", description: "Reviews code", latestVersion: { id: "v1", digest: "d1" } };
const oneSkillClient = (overrides: Record<string, unknown> = {}) => ({
  ...api,
  listSkills: async () => ({ skills: [oneSkill] }),
  listSkillGroups: async () => ({ groups: [] }),
  getSkill: async () => ({ skill: oneSkill, latestVersion: { id: "v1", digest: "d1", files: [] } }),
  listSkillAssignments: async () => ({ assignments: [] }),
  runnerSkills: async () => ({ desired: [], reported: null }),
  ...overrides,
}) as unknown as ApiClient;

/** One machine holding one edited copy of a deleted skill. */
const oneOrphan: RunnerSkillsResponse = {
  desired: [], reported: { deployed: [], updatedAt: 1 }, keptAsideReporting: "supported",
  orphaned: [{ kind: "deleted_skill", name: "retired", digest: "d0", variant: "agent", observedDigest: "d9" }],
};

/** A phone viewport for useIsMobile (≤ 760px); every other width query stays false. */
function stubPhone(): () => void {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  return () => { domWindow.matchMedia = prior; };
}

/** Mounts the view on a route through a store whose navigation records every push. */
async function mountRouted(client: ApiClient, key: string, view: View = { name: "skills" }, strict = false) {
  const pushed: View[] = [];
  const routed: ViewNavigation = { current: () => view, push: (next) => { pushed.push(next); }, listen: () => () => {} };
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={{ instanceId: key, runtimeKey: `${key}:1`, createSocket: () => socket, close() {} }} navigation={routed}>
          {strict ? <React.StrictMode><SkillsWhenReady /></React.StrictMode> : <SkillsWhenReady />}
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
  return {
    // Menus and dialogs are portalled to <body>, so queries read the body.
    container: domWindow.document.body as unknown as HTMLElement,
    pushed,
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === name);

test("the Skills header is one row: Manage Groups…, an Import menu, then New Skill", async () => {
  const view = await mountRouted(oneSkillClient(), "skills-header");
  try {
    const { container } = view;
    const actions = [...container.querySelector(".page-actions")!.children];
    assert.deepEqual(actions.map((element) => [element.className, element.textContent]), [
      ["btn ghost page-action", "Manage Groups…"],
      ["btn page-action", "Import"],
      ["overflow-menu page-more", ""],
      ["btn primary page-primary", "New Skill"],
    ]);
    // Below 1100px Manage Groups… is slot 2, the first into ⋯; Import is the last secondary to go.
    assert.deepEqual([...container.querySelectorAll(".page-action")].map((button) => button.getAttribute("data-slot")), ["2", "1"]);
    const importButton = buttonNamed(container, "Import")[0]!;
    assert.equal(importButton.getAttribute("aria-haspopup"), "menu");

    await act(async () => importButton.click());
    const menu = container.querySelector('[role="menu"][aria-label="Import"]')!;
    assert.ok(menu, "Import opens its own menu");
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent), ["Import from Git…", "Import from Machine…"]);
    assert.ok(items.every((item) => item.querySelector(".menu-desc")?.textContent), "each import has a description line");
    await act(async () => items[0]!.click());
    await act(settle);
    assertNoDomNode(container.querySelector('[role="menu"]'), "choosing an import closes the menu");
    assert.match(container.querySelector('[role="dialog"]')?.textContent ?? "", /Import Skills from Git/);
  } finally {
    await view.unmount();
  }
});

test("an empty library is one state across both panes, and the header keeps only Manage Groups…", async () => {
  const view = await mountRouted(oneSkillClient({ listSkills: async () => ({ skills: [] }) }), "skills-empty");
  try {
    const { container } = view;
    assertNoDomNode(container.querySelector(".master-detail"), "no empty list beside a void (§6.1)");
    const state = container.querySelector(".master-detail-state")!;
    assert.equal(state.querySelector("h2.state-title")?.textContent, "No Agent Skills Yet");
    assert.ok(state.querySelector(".state-icon svg"), "the Skills icon tile");
    assert.equal(buttonNamed(container, "New Skill").length, 1, "one New Skill button, in the state");
    assert.equal(buttonNamed(state, "New Skill")[0]!.className, "btn primary lg");
    assert.equal(buttonNamed(state, "Import from Git…").length, 1);
    assert.equal(buttonNamed(state, "Import from Machine…").length, 1);
    assertNoDomNode(container.querySelector(".page-primary"), "the header hides New Skill");
    assert.deepEqual([...container.querySelectorAll(".page-action")].map((button) => button.textContent), ["Manage Groups…"]);
    assert.equal(state.querySelector(".skills-how-title")?.textContent, "How Skills Work");
    const steps = state.querySelector("ol.steps.horizontal")!;
    assert.deepEqual([...steps.querySelectorAll("li > strong")].map((step) => step.textContent), ["Write or Import", "Assign", "Deploy"]);
  } finally {
    await view.unmount();
  }
});

test("a loading library shows skeleton rows in the list and a skeleton detail", async () => {
  const view = await mountRouted(oneSkillClient({ listSkills: () => new Promise(() => {}) }), "skills-loading");
  try {
    const { container } = view;
    const skeletonRows = container.querySelectorAll(".master-detail-list .skill-row-skeleton");
    assert.equal(skeletonRows.length, 5);
    assert.ok([...skeletonRows].every((row) => row.matches(".row.row-2") && row.querySelectorAll(".skeleton-bar").length === 2),
      "each skeleton row is a two-line row holding a title bar and a meta bar");
    assertNoDomNode(container.querySelector(".master-detail-list .list-foot"), "the list shows only its loading state");
    const detail = container.querySelector(".master-detail-detail .detail-skeleton")!;
    assert.ok(detail, "the detail pane holds a skeleton title and two section blocks");
    assert.equal(detail.querySelectorAll(".skeleton-title").length, 1);
    assert.equal(detail.querySelectorAll(".skeleton-block").length, 2);
    assert.equal(detail.getAttribute("role"), null, "the list's skeleton is the one announcement");
  } finally {
    await view.unmount();
  }
});

test("a failed load is a Couldn't Load Skills notice whose Retry reloads the list", async () => {
  let calls = 0;
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 503 from /api/skills");
      return { skills: [oneSkill] };
    },
  }), "skills-error");
  try {
    const { container } = view;
    assertNoDomNode(container.querySelector(".form-error"), "no bare error line");
    assertNoDomNode(container.querySelector(".master-detail"), "the notice replaces both panes");
    const notice = container.querySelector(".master-detail-state .notice.t-danger")!;
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load Skills");
    assert.doesNotMatch(notice.textContent ?? "", /HTTP 503/, "the raw message waits behind Show Details");
    await act(async () => buttonNamed(notice, "Show Details")[0]!.click());
    assert.match(notice.querySelector(".code-well")?.textContent ?? "", /HTTP 503 from \/api\/skills/);
    await act(async () => buttonNamed(notice, "Retry")[0]!.click());
    await act(settle);
    assert.equal(calls, 2);
    assertNoDomNode(container.querySelector(".master-detail-state"), "the retried load replaces the notice");
    assert.match(container.querySelector(".master-detail-list-body")?.textContent ?? "", /code-review/);
  } finally {
    await view.unmount();
  }
});

test("/skills/orphans opens the Orphaned Copies pane from the route, and a row replaces it", async () => {
  const view = await mountRouted(oneSkillClient({ runnerSkills: async () => oneOrphan }), "skills-orphans", { name: "skills", pane: "orphans" });
  try {
    const { container } = view;
    assert.ok(container.querySelector('.master-detail-detail [aria-label="Orphaned Copies"]'));
    const entry = container.querySelector<HTMLButtonElement>(".list-foot .row")!;
    assert.equal(entry.textContent, "Orphaned Copies1");
    assert.equal(entry.getAttribute("aria-current"), "true");
    await act(async () => container.querySelector<HTMLButtonElement>(".master-detail-list-body .skill-row")!.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills", id: "skill-1" }, "a row pushes its route");
    assertNoDomNode(container.querySelector('.master-detail-detail [aria-label="Orphaned Copies"]'), "the route is the only selection");
    assert.notEqual(container.querySelector(".list-foot .row")?.getAttribute("aria-current"), "true");
  } finally {
    await view.unmount();
  }
});

test("on a phone a skill route is its own screen with Back, and Back returns to a list with no selection", async () => {
  const restore = stubPhone();
  const view = await mountRouted(oneSkillClient(), "skills-phone", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    assertNoDomNode(container.querySelector(".page-header"), "the detail bar is the app bar");
    const bar = container.querySelector(".detail-bar")!;
    assert.equal(bar.querySelector("h1#page-title")?.textContent, "code-review");
    const back = bar.querySelector<HTMLButtonElement>(".detail-bar-back")!;
    assert.equal(back.getAttribute("aria-label"), "Back to Agent Skills");
    assert.ok(container.querySelector(".master-detail[data-detail-open]"), "the stylesheet shows only the detail");

    await act(async () => back.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills" });
    assertNoDomNode(container.querySelector(".detail-bar"), "the list route has the page header back");
    assert.equal(container.querySelector(".master-detail")?.hasAttribute("data-detail-open"), false);
    assertNoDomNode(container.querySelector(".master-detail-list .is-selected"), "a phone list shows no selected row (§5.2)");
    assert.ok(domWindow.document.activeElement === container.querySelector("#page-title") as never,
      "the route change moves focus to the new page title");

    const row = container.querySelector<HTMLButtonElement>(".master-detail-list-body .row")!;
    await act(async () => row.click());
    await act(settle);
    assert.equal(container.querySelector(".detail-bar h1")?.textContent, "code-review");
    assert.ok(domWindow.document.activeElement === container.querySelector(".detail-bar #page-title") as never);
  } finally {
    await view.unmount();
    restore();
  }
});

test("the detail pane shows exactly one state: a skill that loads before the library has no skeleton over it", async () => {
  const view = await mountRouted(oneSkillClient({ listSkills: () => new Promise(() => {}) }), "skills-early-detail",
    { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    assert.equal(container.querySelector(".master-detail-list .skeleton")?.getAttribute("role"), "status", "the list still loads");
    assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review");
    assertNoDomNode(container.querySelector(".master-detail-detail .detail-skeleton"), "no skeleton beside the loaded skill");
  } finally {
    await view.unmount();
  }
});

test("a failed reload of a skill seen before shows its error, never its cached content", async () => {
  const other = { id: "skill-2", name: "release-notes", latestVersion: { id: "v2", digest: "d2" } };
  const loads = new Map<string, number>();
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: [oneSkill, other] }),
    getSkill: async (id: string) => {
      const count = (loads.get(id) ?? 0) + 1;
      loads.set(id, count);
      if (id === other.id) return new Promise(() => {});
      if (count > 1) throw new Error("HTTP 500 reading skill-1");
      return { skill: oneSkill, latestVersion: { id: "v1", digest: "d1", files: [] } };
    },
  }), "skills-cached-failure", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list-body .row")]
      .find((candidate) => candidate.querySelector(".row-title")?.textContent === name)!;
    assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review");
    await act(async () => row("release-notes").click());
    await act(settle);
    assert.ok(container.querySelector(".master-detail-detail .detail-skeleton"), "the pending skill shows its skeleton");
    await act(async () => row("code-review").click());
    await act(settle);
    const detail = container.querySelector(".master-detail-detail")!;
    assert.equal(detail.querySelector(".notice-title")?.textContent, "Couldn't Load This Skill");
    assertNoDomNode(detail.querySelector(".skills-detail-head"), "the cached skill is not shown under its error");
    assertNoDomNode(detail.querySelector(".detail-skeleton"), "nor a skeleton");
  } finally {
    await view.unmount();
  }
});

test("a superseded detail request that fails later never replaces the skill a newer request loaded", async () => {
  const other = { id: "skill-2", name: "release-notes", latestVersion: { id: "v2", digest: "d2" } };
  let rejectFirst!: (cause: Error) => void;
  let firstLoad = true;
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: [oneSkill, other] }),
    getSkill: async (id: string) => {
      if (id === other.id) return new Promise(() => {});
      if (firstLoad) {
        firstLoad = false;
        return new Promise((_, reject) => { rejectFirst = reject; });
      }
      return { skill: oneSkill, latestVersion: { id: "v1", digest: "d1", files: [] } };
    },
  }), "skills-stale-detail-failure", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const row = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list-body .row")]
      .find((candidate) => candidate.querySelector(".row-title")?.textContent === name)!;
    await act(async () => row("release-notes").click());
    await act(settle);
    await act(async () => row("code-review").click());
    await act(settle);
    assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review", "the newer load succeeded");
    await act(async () => { rejectFirst(new Error("HTTP 500 from the first request")); });
    await act(settle);
    assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review", "the stale failure is ignored");
    assertNoDomNode(container.querySelector(".master-detail-detail .notice"), "no error for a superseded request");
  } finally {
    await view.unmount();
  }
});

test("an older library load that fails after a newer one succeeded leaves the library on screen", async () => {
  let rejectFirst!: (cause: Error) => void;
  let calls = 0;
  const view = await mountRouted(oneSkillClient({
    // StrictMode mounts the view's effects twice: the first load is superseded by the second.
    listSkills: async () => {
      calls += 1;
      if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return { skills: [oneSkill] };
    },
  }), "skills-stale-list-failure", { name: "skills" }, true);
  try {
    const { container } = view;
    assert.equal(calls, 2, "StrictMode started two loads");
    assert.match(container.querySelector(".master-detail-list-body")?.textContent ?? "", /code-review/);
    await act(async () => { rejectFirst(new Error("HTTP 503 from the first load")); });
    await act(settle);
    assertNoDomNode(container.querySelector(".master-detail-state"), "the stale failure does not replace the library");
    assert.match(container.querySelector(".master-detail-list-body")?.textContent ?? "", /code-review/);
  } finally {
    await view.unmount();
  }
});

/** Creates a group in Manage Groups…, whose change refreshes the library and the selected skill. */
async function createGroupThroughDialog(container: HTMLElement) {
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".page-header button")]
    .find((button) => button.textContent === "Manage Groups…")!.click());
  await act(settle);
  const dialog = container.querySelector('[role="dialog"]')!;
  const input = [...dialog.querySelectorAll<HTMLInputElement>("label.field")]
    .find((field) => field.textContent?.includes("New Group Name"))!.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  // React's change plugin watches the focused input through keyup here, so type as a person would.
  await act(async () => {
    input.focus();
    setter.call(input, "Review Team");
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: "m" }) as never);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: "m" }) as never);
  });
  const create = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Create Group")!;
  assert.equal(create.disabled, false, "the group has a name");
  await act(async () => create.click());
  await act(settle);
}

test("a library that failed to load recovers when a later refresh succeeds, without another Retry", async () => {
  let listCalls = 0;
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error("HTTP 503 from /api/skills");
      return { skills: [oneSkill] };
    },
    createSkillGroup: async ({ name }: { name: string }) => ({ group: { id: "group-1", name } }),
    listSkillGroups: async () => ({ groups: [], creationScope: { organizationId: "demo-org", owner: { kind: "organization", organizationId: "demo-org" } } }),
  }), "skills-list-recovers");
  try {
    const { container } = view;
    assert.equal(container.querySelector(".master-detail-state .notice-title")?.textContent, "Couldn't Load Skills");
    await createGroupThroughDialog(container);
    assertNoDomNode(container.querySelector(".master-detail-state"), "the refreshed library replaces its error");
    assert.match(container.querySelector(".master-detail-list-body")?.textContent ?? "", /code-review/);
  } finally {
    await view.unmount();
  }
});

test("a skill that failed to load recovers when a later refresh of it succeeds, without another Retry", async () => {
  let detailCalls = 0;
  const view = await mountRouted(oneSkillClient({
    getSkill: async () => {
      detailCalls += 1;
      if (detailCalls === 1) throw new Error("HTTP 500 reading skill-1");
      return { skill: oneSkill, latestVersion: { id: "v1", digest: "d1", files: [] } };
    },
    createSkillGroup: async ({ name }: { name: string }) => ({ group: { id: "group-1", name } }),
    listSkillGroups: async () => ({ groups: [], creationScope: { organizationId: "demo-org", owner: { kind: "organization", organizationId: "demo-org" } } }),
  }), "skills-detail-recovers", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    assert.equal(container.querySelector(".master-detail-detail .notice-title")?.textContent, "Couldn't Load This Skill");
    await createGroupThroughDialog(container);
    assert.ok(detailCalls >= 2, "the group change refreshed the selected skill");
    assertNoDomNode(container.querySelector(".master-detail-detail .notice"), "the refreshed skill replaces its error");
    assert.equal(container.querySelector(".skills-detail-head h3")?.textContent, "code-review");
  } finally {
    await view.unmount();
  }
});
