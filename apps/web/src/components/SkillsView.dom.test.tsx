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

  // Detail pane: version metadata, rendered SKILL.md body, assignments, deployment, unmanaged. This
  // control plane predates version numbers, so the meta names the version by its short digest.
  assert.equal(container.querySelector(".skill-detail-meta .mono")?.textContent, "d1");
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

  // New Skill asks for the name and description once: its only editor is the instructions body,
  // with no frontmatter to edit (#1964).
  const newSkill = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === "New Skill");
  await act(async () => { newSkill!.click(); });
  const dialog = domWindow.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "New Skill opens a dialog");
  assert.deepEqual([...dialog!.querySelectorAll("textarea")].map((field) => field.value), ["", ""]);
  assert.doesNotMatch(dialog!.textContent ?? "", /SKILL\.md editor|Folder Upload/);

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
    getSkill: async () => ({ skill: { id: "skill-1", name: "code-review", latestVersion: { id: "v1", digest, versionNumber: 3 } },
      latestVersion: { id: "v1", digest, versionNumber: 3, files: [{ path: "SKILL.md", content: skillMd, encoding: "utf8" as const }] } }),
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
  // The edited copy is the slot's notice; Deployment no longer lists it.
  assert.doesNotMatch(machine?.textContent ?? "", /Edited Copies|Import Edit as New Version/);
  const slot = () => container.querySelector<HTMLElement>(".skill-notice-slot");
  assert.equal(slot()?.dataset.notice, "edited");
  assert.equal(slot()!.querySelector(".notice")?.classList.contains("t-warning"), true);
  assert.equal(slot()!.querySelector(".notice-title")?.textContent, "Build Machine Has an Edited Copy");
  assert.equal(slot()!.querySelector(".notice-body > p")?.textContent,
    "Claude's copy differs from v3. Updates on that machine wait until you import the edit or restore v3.");
  assert.deepEqual([...slot()!.querySelectorAll(".notice-actions > button")].map((action) => action.textContent),
    ["Review Edit…", "Restore Library Version…"]);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);

  await act(async () => { button("Review Edit…")!.click(); });
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
  assertNoDomNode(slot(), "an imported edit needs nothing more");

  current = drifted;
  await act(async () => { button("Sync Now")?.click(); });
  await act(settle);
  await act(async () => { button("Restore Library Version…")!.click(); });
  await act(settle);
  assert.deepEqual(confirmations, ["Restore Library Version|Restore Library Version"]);
  assert.deepEqual(calls, [
    "preview:runner-1:code-review:agent",
    "import:review-1:true",
    "restore:runner-1:true:true",
  ]);
  assertNoDomNode(slot(), "a restored copy needs nothing more");

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
async function mountSkills(client: ApiClient, instanceId: string, runners: RunnerView[] = [runner]) {
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
      runners, boxes: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(settle);
  const button = (label: string, scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  const listItem = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".master-detail-list .row")]
    .find((candidate) => candidate.querySelector(".row-title")?.textContent === name);
  /** The label of the list group a skill's row is in. */
  const groupOf = (name: string) => listItem(name)?.closest(".skill-list-group")?.getAttribute("aria-label");
  /** An open menu's item, named by its label line alone (§9.1). */
  const menuItem = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
    .find((candidate) => candidate.querySelector(".menu-text")?.textContent === label);
  /** The notice slot under the skill detail's header, and which notice it shows. */
  const slot = () => container.querySelector<HTMLElement>(".skill-notice-slot");
  /** A detail section, by its title. */
  const section = (title: string) => [...container.querySelectorAll<HTMLElement>(".skill-detail > section.section")]
    .find((candidate) => candidate.querySelector(".section-title")?.textContent === title);
  /** One of Source's labeled facts, by its label. */
  const fact = (label: string) => [...(section("Source")?.querySelectorAll(".facts dt") ?? [])]
    .find((term) => term.textContent === label)?.nextElementSibling ?? undefined;
  return {
    container, button, listItem, groupOf, menuItem, slot, section, fact,
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

test("SkillsView recommends a built-in skill in the notice slot, assigns it in one step, and dismisses it with the close button", async () => {
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
  const offline = { ...runner, runnerId: "runner-2", displayName: "Laptop", status: "offline" as const };
  const view = await mountSkills(client, "skills-built-in", [runner, offline]);
  const badges = () => [...view.listItem("using-wollipog")!.querySelectorAll(".status")].map((badge) => badge.textContent);
  // Recommended is an offer, not a state: its own group at the top, and the row keeps only the flag.
  assert.deepEqual(badges(), ["Built-In"]);
  assert.equal(view.groupOf("using-wollipog"), "Recommended");

  await view.click(view.listItem("using-wollipog"));
  const source = () => view.section("Source");
  // Source says where it comes from in labeled facts, not prose.
  assert.equal(view.fact("Source")?.textContent, "Built into Wollipog 0.28.0");
  assert.equal(view.fact("Updates")?.textContent, "With each Wollipog release; pinned machines keep their version");
  assert.equal(view.fact("Recommendation")?.textContent, "Shown until you assign or dismiss it");
  assertNoDomNode(view.container.querySelector('[aria-label="Built-In Skill"]'), "no Built-In Skill card remains");
  // The recommendation is the slot's notice, directly under the header, not part of Source.
  assert.equal(view.slot()?.dataset.notice, "recommended");
  assert.equal(view.slot()?.previousElementSibling?.className, "skill-detail-head");
  assert.doesNotMatch(source()?.textContent ?? "", /Assign|recommends/);
  const notice = () => view.slot()!.querySelector<HTMLElement>(".notice")!;
  assert.equal(notice().querySelector(".notice-title")?.textContent, "Recommended by Wollipog");
  assert.match(notice().textContent ?? "", /It isn't on any machine until you assign it; assigning deploys it to every supported agent/);
  // Exactly two actions, and the close button sits in the title row.
  assert.deepEqual([...notice().querySelectorAll(".notice-actions > button")].map((action) => action.textContent),
    ["Assign to All Machines", "Assign to Machine"]);
  const close = notice().querySelector<HTMLButtonElement>(".notice-head .notice-dismiss");
  assert.equal(close?.getAttribute("aria-label"), "Dismiss Recommendation");
  assert.equal(close?.getAttribute("title"), "Dismiss Recommendation");
  assert.equal(view.button("Dismiss Recommendation"), undefined, "no Dismiss Recommendation text button remains");

  await view.click(view.button("Assign to All Machines"));
  assert.deepEqual(calls.at(-1), { skillId: "skill-builtin", scopeKind: "instance", agentSelector: { kind: "all" }, invocation: "agent" });
  assert.equal(view.groupOf("using-wollipog"), "No Group", "an assigned built-in skill is no longer recommended");
  assert.deepEqual(badges(), ["Built-In"]);
  assertNoDomNode(view.slot(), "an assigned skill needs nothing");
  assert.equal(view.fact("Recommendation"), undefined, "an assigned skill is no longer recommended, so Source says nothing of it");

  // Removing the assignment brings the recommendation back; Assign to Machine is a menu of machines.
  await view.click(view.button("Delete"));
  assert.equal(view.groupOf("using-wollipog"), "Recommended");
  const assignToMachine = view.button("Assign to Machine")!;
  assert.equal(assignToMachine.getAttribute("aria-haspopup"), "menu");
  await view.click(assignToMachine);
  const items = [...view.container.querySelectorAll('[role="menu"] [role="menuitem"]')];
  assert.deepEqual(items.map((item) => [item.querySelector(".menu-text")?.textContent, item.querySelector(".menu-desc")?.textContent ?? null]),
    [["Build Machine", "Online"], ["Laptop", "Offline"], ["Choose Agents…", null]]);
  assert.ok(view.container.querySelector('[role="menu"] [role="separator"]'), "a separator before Choose Agents…");
  await view.click(view.menuItem("Build Machine"));
  assert.deepEqual(calls.at(-1), {
    skillId: "skill-builtin", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "all" }, invocation: "agent",
  });

  // Choose Agents… opens Add Assignment for anything narrower.
  await view.click(view.button("Delete"));
  await view.click(view.button("Assign to Machine"));
  await view.click(view.menuItem("Choose Agents…"));
  const dialog = view.container.querySelector('[role="dialog"]');
  assert.match(dialog?.textContent ?? "", /Add Assignment/);
  await view.click(view.button("Cancel", dialog!));

  // The close button dismisses it without asking, and focus moves to the skill's heading.
  const callCount = calls.length;
  await view.click(view.slot()!.querySelector<HTMLButtonElement>(".notice-dismiss")!);
  assert.deepEqual(calls.slice(callCount), [{ id: "skill-builtin", dismissed: true }]);
  assert.equal(document.activeElement?.className, "skill-detail-title");
  assertNoDomNode(view.slot());
  assert.equal(view.groupOf("using-wollipog"), "No Group", "a dismissed recommendation is hidden and the library entry stays");
  assert.equal(view.fact("Recommendation")?.textContent, "DismissedShow Recommendation");
  assert.ok(view.button("Show Recommendation", view.fact("Recommendation")), "the way back sits beside Dismissed");

  // Show Recommendation restores the slot's notice; it leaves with the button, so focus goes to the heading.
  await view.click(view.button("Show Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: false });
  assert.equal(document.activeElement?.className, "skill-detail-title");
  assert.equal(view.slot()?.dataset.notice, "recommended");
  assert.equal(view.fact("Recommendation")?.textContent, "Shown until you assign or dismiss it");

  // A held built-in update outranks the recommendation in the slot.
  await view.click(view.slot()!.querySelector<HTMLButtonElement>(".notice-dismiss")!);
  skill.builtIn.heldUpdate = { release: "0.29.0", digest: "d2" };
  await view.click(view.button("Show Recommendation"));
  assert.deepEqual(calls.at(-1), { id: "skill-builtin", dismissed: false });
  assert.equal(view.groupOf("using-wollipog"), "Recommended");
  assert.deepEqual(badges(), ["Built-In", "Update Held"], "a held built-in update is the row's one status");
  assert.equal(view.slot()?.dataset.notice, "built-in-held");
  assert.equal(view.slot()!.querySelector(".notice-title")?.textContent, "Built-In Update Held");
  assert.match(view.slot()!.textContent ?? "",
    /Wollipog 0\.29\.0 updates this skill, but the latest library version has changes made here, so it waits for your review\./);
  assert.deepEqual([...view.slot()!.querySelectorAll(".notice-actions > button")].map((action) => action.textContent), ["Review Update…"]);
  assert.equal(view.container.querySelectorAll(".skill-notice-slot .notice").length, 1);
  await view.unmount();
});

test("turning off Automatic Updates for a held Git skill clears its Update Held status in the list", async () => {
  const gitSource = { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "c1" };
  const skill = {
    id: "skill-git", name: "lint-rules", description: "Keeps lint rules current", assignmentCount: 1, gitSource,
    gitAutoUpdate: { enabled: true, held: { commit: "c2", reason: "scripts", scriptPaths: ["fix.sh"], heldAt: 1 } } as {
      enabled: boolean; held: { commit: string; reason: string; scriptPaths: string[]; heldAt: number } | null;
    },
    latestVersion: { id: "v1", digest: "d1", createdAt: 1, gitSource },
  };
  const client = {
    ...api,
    listSkills: async () => ({ skills: [structuredClone(skill)] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill: structuredClone(skill), latestVersion: { ...skill.latestVersion, files: [] } }),
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
    // Disabling drops the setting's status, hold included (db.setSkillGitAutoUpdate).
    setSkillGitAutoUpdate: async (_id: string, enabled: boolean) => {
      skill.gitAutoUpdate = { enabled, held: null };
      return skill.gitAutoUpdate;
    },
  } as unknown as ApiClient;
  const view = await mountSkills(client, "skills-git-hold");
  try {
    const status = () => [...view.listItem("lint-rules")!.querySelectorAll(".status")].map((badge) => badge.textContent);
    assert.deepEqual(status(), ["Update Held"]);
    await view.click(view.listItem("lint-rules"));
    const toggle = view.section("Source")!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    assert.equal(toggle.querySelector(".ui-row-title")?.textContent, "Automatic Updates");
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    await view.click(toggle);
    assert.equal(skill.gitAutoUpdate.enabled, false);
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.deepEqual(status(), [], "the list reads the refreshed summary, not the one loaded before the change");
  } finally {
    await view.unmount();
  }
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
  await skillsView.click(skillsView.slot()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss Recommendation"]')!);
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
  assert.equal(reopened.fact("Recommendation")?.textContent, "DismissedShow Recommendation");

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
  const offer = view.container.querySelector<HTMLElement>('[aria-label="Built-In Version Available"]');
  assert.equal(offer?.parentElement?.closest(".section"), view.section("Source"), "the offer is a notice inside Source");
  assert.ok(offer?.classList.contains("t-info"), "an info notice");
  assertNoDomNode(view.slot(), "an offer is not something the skill needs, so the slot stays empty");
  assert.match(offer?.textContent ?? "", /Wollipog 0\.28\.0 includes a built-in skill with this name; this one stays as it is unless you accept that version\./);
  assert.match(offer?.textContent ?? "", /Accepting also turns off this skill's automatic Git updates\./);

  await view.click(view.button("Review Built-In Version…"));
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
  assert.equal(view.fact("Source")?.textContent, "Built into Wollipog 0.28.0");
  await view.unmount();
});

/** Replace the clipboard for one test; returns what was written and a restore. */
function fakeClipboard() {
  const written: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { written.push(text); } },
  });
  return {
    written,
    restore: () => {
      if (previous) Object.defineProperty(domWindow.navigator, "clipboard", previous);
      else delete (domWindow.navigator as unknown as Record<string, unknown>).clipboard;
    },
  };
}

/** A client for one skill whose latest version holds `files`, counting how often the skill is read. */
function filesClient(skill: Record<string, unknown>, files: unknown[], overrides: Record<string, unknown> = {}) {
  const reads = { count: 0 };
  const client = {
    ...api,
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => {
      reads.count += 1;
      return { skill, latestVersion: { ...(skill.latestVersion as object), files } };
    },
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => ({ desired: [], reported: null }),
    ...overrides,
  } as unknown as ApiClient;
  return { client, reads };
}

test("Instructions shows every file, one at a time: chips choose it, Markdown renders, a script is text, and Copy copies it", async () => {
  const skillMd = "---\nname: collect\n---\n\n# Collect\n\nRun **collect** first.\n";
  const script = "#!/bin/sh\n<script>window.ran = true</script>\necho \"**not markdown**\"\n";
  const files = [
    { path: "scripts/collect.sh", content: script, encoding: "utf8" },
    { path: "SKILL.md", content: skillMd, encoding: "utf8" },
    { path: "references/guide.md", content: "## Guide\n\nRead this.\n", encoding: "utf8" },
  ];
  const skill = { id: "skill-files", name: "collect", latestVersion: { id: "v1", digest: "d1", createdAt: 1 } };
  const { client, reads } = filesClient(skill, files);
  const clipboard = fakeClipboard();
  const view = await mountSkills(client, "skills-instructions-files");
  try {
    await view.click(view.listItem("collect"));
    const section = view.section("Instructions")!;
    const chips = () => [...section.querySelectorAll<HTMLButtonElement>(".chips > button.chip")];
    assert.deepEqual(chips().map((chip) => chip.textContent), ["SKILL.md", "references/guide.md", "scripts/collect.sh"],
      "SKILL.md first, then the rest in path order");
    assert.equal(section.querySelector(".chips")?.getAttribute("aria-label"), "Files");
    assert.deepEqual(chips().map((chip) => chip.getAttribute("aria-pressed")), ["true", "false", "false"]);
    const shown = () => section.querySelector<HTMLElement>(".skill-file-view")!;
    assert.equal(shown().getAttribute("aria-label"), "SKILL.md");
    assert.equal(shown().getAttribute("tabindex"), "0", "it scrolls on its own, so the keyboard can reach it");
    assert.equal(shown().querySelector("h1")?.textContent, "Collect", "Markdown renders");
    assert.equal(shown().querySelector("strong")?.textContent, "collect");
    assert.doesNotMatch(shown().textContent ?? "", /name: collect/, "frontmatter is metadata, not instructions");

    // Copy, in the title row, copies the raw file on screen and says which.
    const copy = view.button("Copy", section.querySelector(".section-head")!)!;
    assert.ok(copy.classList.contains("ghost"));
    assert.equal(domWindow.document.getElementById(copy.getAttribute("aria-describedby")!)?.textContent, "Copies SKILL.md");
    await view.click(copy);
    assert.deepEqual(clipboard.written, [skillMd]);

    // A script is text in a code block, never markup and never run.
    await view.click(chips()[2]);
    assert.deepEqual(chips().map((chip) => chip.getAttribute("aria-pressed")), ["false", "false", "true"]);
    assert.equal(shown().getAttribute("aria-label"), "scripts/collect.sh");
    assert.equal(shown().querySelector("pre.skill-file-code > code")?.textContent, script);
    assertNoDomNode(shown().querySelector("script"));
    assertNoDomNode(shown().querySelector("strong"));
    assert.equal((domWindow as unknown as { ran?: boolean }).ran, undefined);
    const copyScript = view.button("Copy", section.querySelector(".section-head")!)!;
    assert.equal(domWindow.document.getElementById(copyScript.getAttribute("aria-describedby")!)?.textContent, "Copies scripts/collect.sh");
    await view.click(copyScript);
    assert.deepEqual(clipboard.written, [skillMd, script]);

    // Another Markdown file renders as Markdown too.
    await view.click(chips()[1]);
    assert.equal(shown().querySelector("h2")?.textContent, "Guide");
    assert.equal(reads.count, 1, "choosing a file shows what the version returned; nothing more is fetched");
  } finally {
    clipboard.restore();
    await view.unmount();
  }
});

test("Instructions with only SKILL.md has no chips, and a binary file says so and can't be copied", async () => {
  const only = { id: "skill-one", name: "one", latestVersion: { id: "v1", digest: "d1", createdAt: 1 } };
  const single = await mountSkills(filesClient(only, [{ path: "SKILL.md", content: "Do one thing.\n", encoding: "utf8" }]).client, "skills-instructions-one");
  try {
    await single.click(single.listItem("one"));
    assertNoDomNode(single.section("Instructions")!.querySelector(".chips"));
    assert.match(single.section("Instructions")!.querySelector(".skill-file-view")?.textContent ?? "", /Do one thing\./);
  } finally {
    await single.unmount();
  }

  const withImage = { id: "skill-image", name: "image", latestVersion: { id: "v1", digest: "d1", createdAt: 1 } };
  const view = await mountSkills(filesClient(withImage, [
    { path: "SKILL.md", content: "Use the logo.\n", encoding: "utf8" },
    { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
  ]).client, "skills-instructions-binary");
  try {
    await view.click(view.listItem("image"));
    const section = view.section("Instructions")!;
    await view.click([...section.querySelectorAll<HTMLButtonElement>("button.chip")].find((chip) => chip.textContent === "assets/logo.png"));
    const reason = section.querySelector(".skill-file-view p");
    assert.equal(reason?.textContent, "This file isn't text, so it can't be shown or copied here.");
    assertNoDomNode(section.querySelector(".skill-file-view pre"));
    const copy = view.button("Copy", section.querySelector(".section-head")!)!;
    assert.equal(copy.disabled, true);
    assert.equal(copy.getAttribute("aria-describedby"), reason?.id, "the disabled Copy says why");
  } finally {
    await view.unmount();
  }
});

test("a Git skill's Source is labeled facts with a 12-character commit whose Copy copies all of it", async () => {
  const commit = "c3d4e5f6a7b8c3d4e5f6a7b8c3d4e5f6a7b8c3d4";
  const source = { url: "https://github.com/example/skills.git", ref: "main", subdirectory: "skills", path: "skills/code-review", commit };
  const skill = { id: "skill-git", name: "code-review", gitSource: source, gitAutoUpdate: { enabled: false },
    latestVersion: { id: "v1", digest: "d1", createdAt: 1, gitSource: source } };
  const clipboard = fakeClipboard();
  const view = await mountSkills(filesClient(skill, [{ path: "SKILL.md", content: "Review.\n", encoding: "utf8" }]).client, "skills-git-facts");
  try {
    await view.click(view.listItem("code-review"));
    const facts = [...view.section("Source")!.querySelectorAll(".facts dt")].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    assert.deepEqual(facts, [
      ["Repository", "https://github.com/example/skills.git"],
      ["Folder", "skills/code-review"],
      ["Branch or Tag", "main"],
      ["Commit", "c3d4e5f6a7b8"],
    ]);
    const copy = view.fact("Commit")!.querySelector<HTMLButtonElement>("button")!;
    assert.equal(copy.getAttribute("aria-label"), "Copy Commit");
    assert.ok(copy.classList.contains("icon-btn"), "an icon button");
    await view.click(copy);
    assert.deepEqual(clipboard.written, [commit]);
    assert.doesNotMatch(view.container.querySelector(".skill-detail")!.outerHTML, new RegExp(commit),
      "the full hash is behind Copy only");
    // Check for Updates… sits in the title row, a quiet button, and opens the check on the tracked ref.
    const check = view.button("Check for Updates…", view.section("Source")!.querySelector(".section-head")!)!;
    assert.ok(check.classList.contains("ghost"));
    await view.click(check);
    assert.ok(view.container.querySelector('[role="dialog"]'));
  } finally {
    clipboard.restore();
    await view.unmount();
  }
});

test("a machine snapshot's Source shows a 12-character fingerprint and no 64-character digest anywhere", async () => {
  const digest = "ab".repeat(32);
  const skill = { id: "skill-machine", name: "notes", latestVersion: { id: "v1", digest, createdAt: 1, machineSource: {
    runnerId: "runner-1", sourceDirectory: "~/.claude/skills", name: "notes", digest, importedAt: Date.UTC(2026, 8, 24, 15, 30),
  } } };
  const view = await mountSkills(filesClient(skill, [{ path: "SKILL.md", content: "Notes.\n", encoding: "utf8" }]).client, "skills-machine-facts");
  try {
    await view.click(view.listItem("notes"));
    const source = view.section("Source")!;
    assert.deepEqual([...source.querySelectorAll(".facts dt")].map((term) => term.textContent), ["Machine", "Folder", "Imported", "Fingerprint"]);
    assert.equal(view.fact("Machine")?.textContent, "Build Machine");
    assert.equal(view.fact("Folder")?.textContent, "~/.claude/skills/notes");
    assert.equal(view.fact("Imported")?.querySelector("time")?.getAttribute("datetime"), "2026-09-24T15:30:00.000Z");
    assert.equal(view.fact("Fingerprint")?.textContent, "abababababab");
    assert.equal(view.fact("Fingerprint")?.querySelector("button")?.getAttribute("aria-label"), "Copy Fingerprint");
    assert.match(source.textContent ?? "", /A copy of the folder was imported; the folder on the machine wasn't changed\./);
    assert.doesNotMatch(view.container.querySelector(".skill-detail")!.outerHTML, /[0-9a-f]{64}/);
    assert.equal(view.button("Check for Updates…", source), undefined, "a snapshot has no source to check");
  } finally {
    await view.unmount();
  }
});

/** A held Git skill, and a machine whose deployment of it either failed or worked. */
function heldClient(deployError: boolean) {
  const source = { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "c1".repeat(20) };
  const skill = {
    id: "skill-held", name: "lint-rules", assignmentCount: 1, gitSource: source,
    gitAutoUpdate: { enabled: true, intervalMs: 3_600_000, checkedAt: Date.now() - 2 * 3_600_000, checkedCommit: "c3d4e5f6a7b8".repeat(3) + "c3d4",
      held: { commit: "0123456789abcdef", reason: "scripts", scriptPaths: ["fix.sh"], heldAt: 1 } },
    latestVersion: { id: "v1", digest: "d1", createdAt: 1, gitSource: source },
  };
  const machine = {
    desired: [{ name: "lint-rules", versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" }] }],
    reported: { deployed: [{ name: "lint-rules", digest: "d1",
      links: [{ agentId: "claude", status: deployError ? "error" : "linked", ...(deployError ? { detail: "Permission denied" } : {}) }] }], updatedAt: 1 },
  };
  return filesClient(skill, [{ path: "SKILL.md", content: "Lint.\n", encoding: "utf8" }], { runnerSkills: async () => machine }).client;
}

test("a held update the slot outranks is a notice in Source, and Review Update… opens Check for Updates", async () => {
  const view = await mountSkills(heldClient(true), "skills-held-in-source");
  try {
    await view.click(view.listItem("lint-rules"));
    assert.equal(view.slot()?.dataset.notice, "deployment-error", "the deployment error takes the slot");
    const held = view.section("Source")!.querySelector<HTMLElement>('.skill-source > [aria-label="Update Held for Review"]');
    assert.ok(held?.classList.contains("t-warning"));
    assert.equal(held?.querySelector(".notice-title")?.textContent, "Update Held for Review");
    assert.match(held?.textContent ?? "", /Commit 0123456789ab adds or changes fix\.sh\. Review it before it deploys\./);
    assert.equal(view.container.querySelectorAll('[aria-label="Update Held for Review"]').length, 1);
    const description = view.section("Source")!.querySelector('[role="switch"] .ui-row-desc')?.textContent ?? "";
    assert.doesNotMatch(description, /held/, "the notice is right there, so the row doesn't repeat it");
    await view.click(view.button("Review Update…", held!));
    assert.ok(view.container.querySelector('[role="dialog"]'));
  } finally {
    await view.unmount();
  }
});

test("a held update the slot shows is not repeated in Source, whose Automatic Updates row still says one waits", async () => {
  const view = await mountSkills(heldClient(false), "skills-held-in-slot");
  try {
    await view.click(view.listItem("lint-rules"));
    assert.equal(view.slot()?.dataset.notice, "git-held");
    assert.equal(view.container.querySelectorAll('[aria-label="Update Held for Review"]').length, 1, "one notice, in the slot");
    assertNoDomNode(view.section("Source")!.querySelector(".notice"));
    assert.equal(view.section("Source")!.querySelector('[role="switch"] .ui-row-desc')?.textContent,
      "Checks main every hour. Last checked 2h ago at commit c3d4e5f6a7b8. An update is held for review.");
  } finally {
    await view.unmount();
  }
});

test("a failed check is a danger notice in Source with Check for Updates… and the server's words behind Show Details", async () => {
  const source = { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "c1".repeat(20) };
  const skill = { id: "skill-failed", name: "lint-rules", gitSource: source,
    gitAutoUpdate: { enabled: true, intervalMs: 3_600_000, checkedAt: Date.now() - 5 * 60_000, checkedCommit: null,
      error: { message: "Could not read the Git source within its limits.", at: Date.now() - 5 * 60_000 }, held: null },
    latestVersion: { id: "v1", digest: "d1", createdAt: 1, gitSource: source } };
  const view = await mountSkills(filesClient(skill, [{ path: "SKILL.md", content: "Lint.\n", encoding: "utf8" }]).client, "skills-failed-check");
  try {
    await view.click(view.listItem("lint-rules"));
    assertNoDomNode(view.slot(), "a failed check is not a slot item");
    const failed = view.section("Source")!.querySelector<HTMLElement>('.skill-source > [aria-label="Couldn\'t Check for Updates"]')!;
    assert.ok(failed.classList.contains("t-danger"));
    assert.equal(failed.querySelector(".notice-title")?.textContent, "Couldn't Check for Updates");
    assert.equal(failed.querySelector(".notice-body")?.textContent,
      "The automatic check failed 5m ago. Existing versions and deployments are unchanged.");
    assert.doesNotMatch(failed.textContent ?? "", /Could not read/, "the server's message waits behind Show Details");
    await view.click(view.button("Show Details", failed));
    assert.match(failed.textContent ?? "", /Could not read the Git source within its limits\./);
    await view.click(view.button("Check for Updates…", failed));
    assert.ok(view.container.querySelector('[role="dialog"]'));
  } finally {
    await view.unmount();
  }
});

test("Automatic Updates is a switch: one click applies it, it shows busy, then Saved, and its description follows", async () => {
  const source = { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "c1".repeat(20) };
  const skill = { id: "skill-auto", name: "lint-rules", gitSource: source,
    gitAutoUpdate: { enabled: false, intervalMs: 3_600_000 } as Record<string, unknown>,
    latestVersion: { id: "v1", digest: "d1", createdAt: 1, gitSource: source } };
  const puts: boolean[] = [];
  let release = () => {};
  const { client } = filesClient(skill, [{ path: "SKILL.md", content: "Lint.\n", encoding: "utf8" }], {
    setSkillGitAutoUpdate: async (_id: string, enabled: boolean) => {
      puts.push(enabled);
      await new Promise<void>((resolve) => { release = resolve; });
      skill.gitAutoUpdate = { enabled, intervalMs: 3_600_000, checkedAt: null, checkedCommit: null, error: null, held: null };
      return skill.gitAutoUpdate;
    },
  });
  const view = await mountSkills(client, "skills-auto-switch");
  try {
    await view.click(view.listItem("lint-rules"));
    const toggle = () => view.section("Source")!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const description = () => toggle().querySelector(".ui-row-desc")?.textContent;
    assertNoDomNode(view.section("Source")!.querySelector('input[type="checkbox"]'), "no checkbox for an instant setting");
    assert.equal(toggle().querySelector(".ui-row-title")?.textContent, "Automatic Updates");
    const byId = (attribute: string) => domWindow.document.getElementById(toggle().getAttribute(attribute)!)?.textContent;
    assert.equal(byId("aria-labelledby"), "Automatic Updates", "named by its title alone");
    assert.equal(byId("aria-describedby"), "Off. Use Check for Updates to review new commits.", "and described by its state");
    assert.equal(toggle().getAttribute("aria-checked"), "false");
    assert.equal(description(), "Off. Use Check for Updates to review new commits.");
    assert.doesNotMatch(toggle().textContent ?? "", /\b(On|Off)$/, "the knob is the state");

    await view.click(toggle());
    assert.deepEqual(puts, [true], "one click, one request");
    assert.equal(toggle().getAttribute("aria-busy"), "true");
    assert.equal(toggle().getAttribute("aria-checked"), "false", "the confirmed value until the server answers");

    await act(async () => { release(); });
    await act(settle);
    assert.equal(toggle().getAttribute("aria-checked"), "true");
    assert.equal(toggle().getAttribute("aria-busy"), null);
    assert.equal(toggle().querySelector(".ui-row-saved")?.textContent, "Saved");
    assert.equal(view.section("Source")!.querySelector('.skill-source > [role="status"]')?.textContent, "Automatic Updates saved");
    assert.equal(description(), "Checks main every hour. Waiting for the first check.");
  } finally {
    await view.unmount();
  }
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
  assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review", "the deep link selects its skill");
  await act(async () => { route(undefined); });
  await act(settle);
  assertNoDomNode(container.querySelector(".skill-detail-head"), "the bare Skills route clears the selection");
  assert.ok(container.querySelector(".master-detail-detail > .skills-overview"), "the default detail is the Library Overview");

  // A detail load still pending when the route clears never repopulates the pane.
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  await act(async () => { route("skill-1"); });
  await act(async () => { route(undefined); });
  await act(async () => { release(); await hold; });
  await act(settle);
  assertNoDomNode(container.querySelector(".skill-detail-head"), "a stale detail load is discarded");
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
  const heading = () => container.querySelector(".skill-detail-title")?.textContent;
  assert.equal(heading(), "using-wollipog");
  const dismiss = container.querySelector<HTMLButtonElement>('.skill-notice-slot [aria-label="Dismiss Recommendation"]')!;
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
async function mountRouted(client: ApiClient, key: string, view: View = { name: "skills" }, strict = false,
  feedback?: { confirm: (options: { title: string; message: string; confirmLabel?: string }) => Promise<boolean> },
  runners: RunnerView[] = [runner]) {
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
          {feedback ? (
            <FeedbackContext.Provider value={{ showToast: () => -1, showUndo: () => -1, dismissToast: () => undefined, ...feedback } as never}>
              {strict ? <React.StrictMode><SkillsWhenReady /></React.StrictMode> : <SkillsWhenReady />}
            </FeedbackContext.Provider>
          ) : strict ? <React.StrictMode><SkillsWhenReady /></React.StrictMode> : <SkillsWhenReady />}
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
      runners, boxes: [], sessions: [], runs: [], pods: [],
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

    const row = container.querySelector<HTMLButtonElement>(".master-detail-list-body .skill-row")!;
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
    assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review");
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
    assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review");
    await act(async () => row("release-notes").click());
    await act(settle);
    assert.ok(container.querySelector(".master-detail-detail .detail-skeleton"), "the pending skill shows its skeleton");
    await act(async () => row("code-review").click());
    await act(settle);
    const detail = container.querySelector(".master-detail-detail")!;
    assert.equal(detail.querySelector(".notice-title")?.textContent, "Couldn't Load This Skill");
    assertNoDomNode(detail.querySelector(".skill-detail-head"), "the cached skill is not shown under its error");
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
    assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review", "the newer load succeeded");
    await act(async () => { rejectFirst(new Error("HTTP 500 from the first request")); });
    await act(settle);
    assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review", "the stale failure is ignored");
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
    assert.equal(container.querySelector(".skill-detail-title")?.textContent, "code-review");
  } finally {
    await view.unmount();
  }
});

/* --- The skill detail header (#1962) --- */

/** A 1,024-character description with line breaks, as long as the protocol allows. */
const LONG_DESCRIPTION = (() => {
  const paragraph = "Coordinate explicitly requested Wollipog child-session issue campaigns through merge, cleanup, recursive follow-ups, and archival.";
  let text = `${paragraph}\nUse only when the user invokes this skill.\n\n`;
  while (text.length < 1024) text += paragraph.slice(0, Math.min(paragraph.length, 1024 - text.length));
  return text;
})();

const gitSource = { url: "https://example.com/skills.git", ref: "main", subdirectory: "", path: "skills/orchestrate-issues", commit: "abc123" };
const skillMdFile = { path: "SKILL.md", content: "---\nname: orchestrate-issues\n---\n\nRun the campaign.\n", encoding: "utf8" as const };

function headerSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: "skill-1", name: "orchestrate-issues", description: LONG_DESCRIPTION, groupId: "group-1",
    gitSource, updatedAt: Date.now() - 4 * 60_000,
    latestVersion: { id: "skillv_3", digest: "0123456789abcdef0123", createdAt: 1, versionNumber: 3 },
    ...overrides,
  };
}

function headerClient(skill: ReturnType<typeof headerSkill>, overrides: Record<string, unknown> = {}) {
  return oneSkillClient({
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [{ id: "group-1", name: "Campaigns", sortOrder: 0 }] }),
    getSkill: async () => ({ skill, latestVersion: { ...skill.latestVersion, files: [skillMdFile, { path: "notes.md", content: "x", encoding: "utf8" as const }] } }),
    ...overrides,
  });
}

/**
 * happy-dom has no layout. The description is `lines` lines tall at the current width, and the
 * clamp shows two of them, so the paragraph reads as truncated exactly when `lines` exceeds two.
 */
function stubDescriptionLayout(initialLines: number) {
  const proto = domWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
  const prior = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
  };
  const layout = { lines: initialLines };
  const isDescription = (element: HTMLElement) => element.classList?.contains("skill-detail-desc");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get(this: HTMLElement) {
    return isDescription(this) ? layout.lines * 20 : 0;
  } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) {
    if (!isDescription(this)) return 0;
    return (this.classList.contains("is-clamped") ? Math.min(layout.lines, 2) : layout.lines) * 20;
  } });
  // Resize delivery on demand: a width change is a new line count and a callback.
  const observers: Array<() => void> = [];
  const priorObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    unobserve() {}
    disconnect() { const index = observers.indexOf(this.callback); if (index >= 0) observers.splice(index, 1); }
  };
  return {
    async resize(lines: number) {
      layout.lines = lines;
      await act(async () => { for (const callback of [...observers]) callback(); });
    },
    restore() {
      for (const [name, descriptor] of Object.entries(prior)) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete proto[name];
      }
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = priorObserver;
    },
  };
}

async function openMoreActions(scope: Element) {
  const more = scope.querySelector<HTMLButtonElement>('button[aria-label="More Actions"]')!;
  assert.equal(more.title, "More Actions");
  await act(async () => more.click());
  return domWindow.document.querySelector('[role="menu"][aria-label="More Actions"]') as unknown as HTMLElement;
}

const menuLabels = (menu: Element) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .map((item) => item.querySelector(".menu-text")?.textContent);

test("the skill header is its name, Add Assignment… and one ⋯ menu; Delete Skill… is last and still deletes", async () => {
  const layout = stubDescriptionLayout(1);
  const deleted: string[] = [];
  const confirmations: string[] = [];
  const view = await mountRouted(headerClient(headerSkill({ description: "Short." }), {
    deleteSkill: async (id: string) => { deleted.push(id); return {}; },
  }), "skills-header", { name: "skills", id: "skill-1" }, false, {
    confirm: async (options) => { confirmations.push(`${options.title}|${options.confirmLabel}|${options.message}`); return true; },
  });
  try {
    const { container } = view;
    const head = container.querySelector(".skill-detail-head")!;
    assert.equal(head.querySelector("h2.skill-detail-title")?.textContent, "orchestrate-issues");
    // The actions row: one secondary and ⋯. Nothing else in the detail is a bar-wide button.
    const actions = [...head.querySelectorAll<HTMLButtonElement>(".skill-detail-title-row > .actions button")];
    assert.deepEqual(actions.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim()), ["Add Assignment…", "More Actions"]);
    assert.equal(actions[0]!.className, "btn");
    for (const gone of ["Version History", "Machine Versions", "Delete Skill", "Add Assignment"]) {
      assert.equal(buttonNamed(container, gone).length, 0, `${gone} is not a button of its own any more`);
    }

    const menu = await openMoreActions(head);
    assert.deepEqual(menuLabels(menu), ["Version History…", "Machine Version…", "Check for Updates…", "Delete Skill…"]);
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.ok(items[3]!.classList.contains("danger"), "Delete Skill… is drawn in danger text");
    assert.equal(items[3]!.previousElementSibling?.getAttribute("role"), "separator", "a separator sits before it");
    assert.equal((items[2] as HTMLButtonElement).disabled, false, "a Git skill checks for updates");

    await act(async () => items[3]!.click());
    await act(settle);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0]!, /^Delete Skill\|Delete Skill\|“orchestrate-issues”, its versions and its assignments are removed/);
    assert.deepEqual(deleted, ["skill-1"]);
    assert.deepEqual(view.pushed.at(-1), { name: "skills" }, "deleting returns to /skills");
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("each ⋯ item opens its dialog, and Add Assignment… opens the existing one", async () => {
  const layout = stubDescriptionLayout(1);
  const view = await mountRouted(headerClient(headerSkill(), {
    listSkillVersions: async () => ({ versions: [], nextCursor: null }),
    getMachineSkillVersionPolicy: async () => ({ policy: null }),
  }), "skills-header-dialogs", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const head = container.querySelector(".skill-detail-head")!;
    const open = async (label: string) => {
      const menu = await openMoreActions(head);
      const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.querySelector(".menu-text")?.textContent === label)!;
      await act(async () => item.click());
      await act(settle);
      const dialog = container.querySelector('[role="dialog"]');
      const title = dialog?.getAttribute("aria-label") ?? dialog?.querySelector("h2")?.textContent;
      const close = dialog && buttonNamed(dialog, "Cancel")[0] || dialog && buttonNamed(dialog, "Close")[0] ||
        dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
      await act(async () => close?.click());
      await act(settle);
      return title;
    };
    assert.equal(await open("Version History…"), "Version History");
    assert.equal(await open("Machine Version…"), "Machine Versions");
    assert.equal(await open("Check for Updates…"), "Check for Skill Updates");
    await act(async () => buttonNamed(head, "Add Assignment…")[0]!.click());
    const dialog = container.querySelector('[role="dialog"]');
    assert.equal(dialog?.getAttribute("aria-label") ?? dialog?.querySelector("h2")?.textContent, "Add Assignment");
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("a built-in skill's Check for Updates… is disabled and says why; a library skill has none", async () => {
  const layout = stubDescriptionLayout(1);
  const builtIn = headerSkill({ gitSource: undefined, builtIn: { release: "0.29.1", heldUpdate: null } });
  let view = await mountRouted(headerClient(builtIn), "skills-header-built-in", { name: "skills", id: "skill-1" });
  try {
    const menu = await openMoreActions(view.container.querySelector(".skill-detail-head")!);
    const check = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][2]!;
    assert.equal(check.querySelector(".menu-text")?.textContent, "Check for Updates…");
    assert.equal(check.disabled, true);
    assert.equal(check.querySelector(".menu-desc")?.textContent, "Built-in skills update with each Wollipog release.");
    assert.equal(view.container.querySelector(".skill-detail-meta")?.textContent?.includes("Built-In"), true);
  } finally {
    await view.unmount();
  }
  view = await mountRouted(headerClient(headerSkill({ gitSource: undefined })), "skills-header-library", { name: "skills", id: "skill-1" });
  try {
    const menu = await openMoreActions(view.container.querySelector(".skill-detail-head")!);
    assert.deepEqual(menuLabels(menu), ["Version History…", "Machine Version…", "Delete Skill…"]);
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("the meta row names the group, v3, when it changed, the file count and the source, in 12px dim facts", async () => {
  const layout = stubDescriptionLayout(1);
  const view = await mountRouted(headerClient(headerSkill()), "skills-header-meta", { name: "skills", id: "skill-1" });
  try {
    const facts = [...view.container.querySelectorAll(".skill-detail-meta > li")];
    assert.deepEqual(facts.map((fact) => fact.textContent), ["Group: Campaigns", "Version: v3", "Updated 4m ago", "2 files", "Source: Git"]);
    for (const fact of facts) assert.equal(fact.querySelector("svg")?.getAttribute("width"), "14", "each fact leads with a 14px icon");
    assert.doesNotMatch(view.container.querySelector(".skill-detail-head")?.textContent ?? "", /skillv_|0123456789abcdef|·/,
      "no version id, digest or middle dot in the header");
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("the description is two lines with Show Full Description, expands to every character, and Show Less collapses it", async () => {
  const layout = stubDescriptionLayout(9);
  const view = await mountRouted(headerClient(headerSkill()), "skills-header-desc", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const paragraph = container.querySelector<HTMLElement>(".skill-detail-desc")!;
    assert.equal(paragraph.textContent, LONG_DESCRIPTION, "every character, line breaks included, is in the text");
    assert.equal(LONG_DESCRIPTION.length, 1024);
    assert.ok(paragraph.classList.contains("is-clamped"));
    const toggle = () => container.querySelector<HTMLButtonElement>(".skill-detail-desc-toggle");
    assert.equal(toggle()?.textContent, "Show Full Description");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "false");
    assert.equal(toggle()?.getAttribute("aria-controls"), paragraph.id);

    await act(async () => toggle()!.click());
    assert.equal(paragraph.classList.contains("is-clamped"), false, "expanded, the clamp is off");
    assert.equal(toggle()?.textContent, "Show Less");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "true");

    await act(async () => toggle()!.click());
    assert.ok(paragraph.classList.contains("is-clamped"));
    assert.equal(toggle()?.textContent, "Show Full Description");
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("a description that fits in two lines has no toggle, including after the pane widens", async () => {
  const layout = stubDescriptionLayout(2);
  const view = await mountRouted(headerClient(headerSkill({ description: "Reviews code before merge." })), "skills-header-fits",
    { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    assertNoDomNode(container.querySelector(".skill-detail-desc-toggle"), "a description that fits has no toggle");
    // Narrowed (900px): three lines, so the toggle appears; widened (1440px): two again, and it goes.
    await layout.resize(3);
    assert.equal(container.querySelector(".skill-detail-desc-toggle")?.textContent, "Show Full Description");
    await layout.resize(2);
    assertNoDomNode(container.querySelector(".skill-detail-desc-toggle"), "widening past the clamp removes the toggle");

    // Measured against the clamp while expanded too: a widening that makes it fit takes Show Less
    // away and hands its focus to the text.
    await layout.resize(4);
    const toggle = container.querySelector<HTMLButtonElement>(".skill-detail-desc-toggle")!;
    await act(async () => toggle.click());
    toggle.focus();
    await layout.resize(2);
    assertNoDomNode(container.querySelector(".skill-detail-desc-toggle"));
    assert.ok(domWindow.document.activeElement === container.querySelector(".skill-detail-desc") as never, "focus stays in the header");
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("the detail sections are Deployment, Assignments, Instructions and Source, as unboxed sections", async () => {
  const layout = stubDescriptionLayout(1);
  const view = await mountRouted(headerClient(headerSkill({ groupId: null })), "skills-sections", { name: "skills", id: "skill-1" });
  try {
    const sections = [...view.container.querySelectorAll(".skill-detail > section.section")];
    assert.deepEqual(sections.map((section) => section.querySelector(":scope > .section-head > h3.section-title")?.textContent),
      ["Deployment", "Assignments", "Instructions", "Source"]);
    for (const section of sections) {
      assert.equal(section.getAttribute("aria-labelledby"), section.querySelector("h3")?.id, "each section is named by its title");
      assertNoDomNode(section.closest(".skills-section"), "no section sits in a card");
    }
    assert.match(sections[2]!.textContent ?? "", /Run the campaign\./);
    assert.deepEqual([...sections[3]!.querySelectorAll(".facts dt")].map((term) => term.textContent),
      ["Repository", "Folder", "Branch or Tag", "Commit"]);
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("on a phone the detail bar's ⋯ holds Add Assignment… and the skill menu, and the header keeps only its text", async () => {
  const restore = stubPhone();
  const layout = stubDescriptionLayout(9);
  const view = await mountRouted(headerClient(headerSkill()), "skills-header-phone", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const bar = container.querySelector(".detail-bar")!;
    assert.equal(bar.querySelector("h1")?.textContent, "orchestrate-issues");
    const menu = await openMoreActions(bar);
    assert.deepEqual(menuLabels(menu), ["Add Assignment…", "Version History…", "Machine Version…", "Check for Updates…", "Delete Skill…"]);
    const head = container.querySelector(".skill-detail-head")!;
    assertNoDomNode(head.querySelector(".skill-detail-title-row"), "the name and actions live in the detail bar");
    assert.equal(head.querySelector(".skill-detail-desc-toggle")?.textContent, "Show Full Description");
    assert.ok(head.querySelector(".skill-detail-meta"));
  } finally {
    await view.unmount();
    layout.restore();
    restore();
  }
});

test("Delete Skill… waits, and says why, while a change to the skill is still saving", async () => {
  const layout = stubDescriptionLayout(1);
  let release!: () => void;
  const view = await mountRouted(headerClient(headerSkill(), {
    listSkillAssignments: async () => ({ assignments: [{
      id: "assignment-1", skillId: "skill-1", scopeKind: "instance" as const,
      agentSelector: { kind: "all" as const }, enabled: true, invocation: "agent" as const,
    }] }),
    updateSkillAssignment: () => new Promise<void>((resolve) => { release = resolve; }),
  }), "skills-header-busy", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    const enabled = container.querySelector<HTMLButtonElement>('.skills-table button[role="switch"]')!;
    await act(async () => enabled.click());
    const head = container.querySelector(".skill-detail-head")!;
    assert.equal(buttonNamed(head, "Add Assignment…")[0]!.disabled, true);
    let menu = await openMoreActions(head);
    const remove = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].at(-1)!;
    assert.equal(remove.querySelector(".menu-text")?.textContent, "Delete Skill…");
    assert.equal(remove.disabled, true, "deleting under a pending update would fail it");
    assert.equal(remove.querySelector(".menu-desc")?.textContent, "Wait for the current change to finish.");
    await act(async () => domWindow.document.body.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never));
    await act(async () => { release(); });
    await act(settle);
    if (!domWindow.document.querySelector('[role="menu"][aria-label="More Actions"]')) menu = await openMoreActions(head);
    const again = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].at(-1)!;
    assert.equal(again.disabled, false, "once the change is saved, Delete Skill… is back");
    assertNoDomNode(again.querySelector(".menu-desc"));
  } finally {
    await view.unmount();
    layout.restore();
  }
});

test("on a phone a failed library load leaves no skill actions behind its error", async () => {
  const restore = stubPhone();
  const layout = stubDescriptionLayout(1);
  const view = await mountRouted(headerClient(headerSkill(), {
    listSkills: async () => { throw new Error("HTTP 503: skill library unavailable"); },
  }), "skills-header-phone-error", { name: "skills", id: "skill-1" });
  try {
    const { container } = view;
    assert.match(container.textContent ?? "", /Couldn't Load Skills/);
    assertNoDomNode(container.querySelector('.detail-bar button[aria-label="More Actions"]'), "the hidden detail offers no Delete Skill…");
  } finally {
    await view.unmount();
    layout.restore();
    restore();
  }
});

/* --- The Library Overview (#1971) --- */

const daysAgo = (days: number) => Date.now() - days * 86_400_000;
const versionAt = (createdAt: number, extra: Record<string, unknown> = {}) => ({ id: `v-${createdAt}`, digest: "d1", createdAt, ...extra });

/** One deployment error, one edited copy, one held Git update and four orphaned copies, plus a
 * healthy skill. */
function attentionClient(overrides: Record<string, unknown> = {}) {
  const skills = [
    { id: "s-broken", name: "broken", description: "Fails to link", latestVersion: versionAt(daysAgo(1)) },
    { id: "s-edited", name: "edited", description: "Edited on a machine", latestVersion: versionAt(daysAgo(2)) },
    { id: "s-held", name: "held", description: "Waits for review", latestVersion: versionAt(daysAgo(3)),
      gitSource: { url: "https://example.test/r.git", ref: "main", subdirectory: "", path: "", commit: "c1" },
      gitAutoUpdate: { enabled: true, held: { commit: "0123456789abcdef", reason: "scripts", scriptPaths: ["run.sh"], heldAt: 1 } } },
    { id: "s-fine", name: "fine", description: "Deployed as assigned", latestVersion: versionAt(daysAgo(4)) },
  ];
  const target = (name: string) => ({ name, versionDigest: "d1", targets: [{ agentId: "claude", invocation: "agent" as const }] });
  const linked = (name: string) => ({ name, digest: "d1", links: [{ agentId: "claude", status: "linked" as const }] });
  const machine: RunnerSkillsResponse = {
    keptAsideReporting: "supported",
    desired: ["broken", "edited", "held", "fine"].map(target),
    reported: {
      deployed: [
        { name: "broken", digest: "d1", links: [{ agentId: "claude", status: "error", detail: "Permission denied" }] },
        linked("edited"), linked("held"), linked("fine"),
      ],
      drift: [{ name: "edited", digest: "d1", variant: "agent", held: false }],
      updatedAt: 1,
    },
    orphaned: [1, 2, 3, 4].map((index) => ({ kind: "deleted_skill" as const, name: `retired-${index}`, digest: `d${index}`, variant: "agent" as const })),
  };
  return {
    ...api,
    listSkills: async () => ({ skills }),
    listSkillGroups: async () => ({ groups: [{ id: "g1", name: "Review" }] }),
    getSkill: async (id: string) => ({ skill: skills.find((entry) => entry.id === id), latestVersion: { id: "v1", digest: "d1", files: [] } }),
    listSkillAssignments: async () => ({ assignments: [] }),
    runnerSkills: async () => machine,
    ...overrides,
  } as unknown as ApiClient;
}

const overviewSection = (container: ParentNode, title: string) =>
  [...container.querySelectorAll<HTMLElement>(".skills-overview > .section")]
    .find((section) => section.querySelector(".section-title")?.firstChild?.textContent === title);

test("/skills shows the Library Overview, top-aligned in the detail, with no centred sentence", async () => {
  const view = await mountRouted(attentionClient(), "skills-overview-desktop");
  try {
    const { container } = view;
    const overview = container.querySelector(".master-detail-detail > .skills-overview")!;
    assert.ok(overview, "the default detail is the overview");
    assert.equal(overview.querySelector("h2.skills-overview-title")?.textContent, "Library Overview");
    assert.equal(overview.querySelector(".skills-overview-summary")?.textContent,
      "4 skills in 1 group, deployed to agents on 1 machine.");
    assert.doesNotMatch(container.textContent ?? "", /Select a skill/);
    assertNoDomNode(container.querySelector(".skill-list-overview"), "the list's overview row is for phones only");
    assert.deepEqual([...overview.querySelectorAll(".section-title")].map((title) => title.firstChild?.textContent),
      ["Needs Attention", "Recently Changed"], "Recommended and Get Started appear only when they apply");
  } finally {
    await view.unmount();
  }
});

test("Needs Attention lists the same skills the list marks, each with its badge and a Review that opens it", async () => {
  const view = await mountRouted(attentionClient(), "skills-overview-attention");
  try {
    const { container } = view;
    const section = overviewSection(container, "Needs Attention")!;
    assert.equal(section.querySelector(".skills-overview-count")?.textContent, "4");
    const rows = [...section.querySelectorAll<HTMLElement>(".surface > .row")];
    assert.deepEqual(rows.map((row) => [
      row.querySelector(".row-title")?.textContent,
      row.querySelector(".status, .count-badge")?.textContent,
      row.querySelector(".row-sub")?.textContent,
    ]), [
      ["broken", "Error", "Claude on Build Machine: Permission denied."],
      ["edited", "Edited", "Build Machine has an edited copy of this skill."],
      ["held", "Update Held", "An update to Git commit 0123456789ab waits for your review."],
      ["Orphaned Copies", "4", "Machines keep 4 edited copies that no library skill shows."],
    ]);
    assert.deepEqual(rows.map((row) => row.querySelector("button")?.textContent), ["Review", "Review", "Review", "Review"]);

    // The list's badges (#1961) mark exactly the same skills.
    const marked = [...container.querySelectorAll(".master-detail-list .skill-row")]
      .filter((row) => row.querySelector(".skill-row-status"))
      .map((row) => [row.querySelector(".row-title")?.textContent, row.querySelector(".skill-row-status")?.textContent]);
    assert.deepEqual(marked, [["broken", "Error"], ["edited", "Edited"], ["held", "Update Held"]]);

    await act(async () => rows[1]!.querySelector("button")!.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills", id: "s-edited" });
  } finally {
    await view.unmount();
  }
  const orphans = await mountRouted(attentionClient(), "skills-overview-orphans");
  try {
    const row = [...overviewSection(orphans.container, "Needs Attention")!.querySelectorAll(".surface > .row")].at(-1)!;
    assert.equal(row.querySelector("button")?.getAttribute("aria-label"), "Review Orphaned Copies");
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
    await act(settle);
    assert.deepEqual(orphans.pushed.at(-1), { name: "skills", pane: "orphans" });
    assert.ok(orphans.container.querySelector('.master-detail-detail [aria-label="Orphaned Copies"]'));
  } finally {
    await orphans.unmount();
  }
});

test("with nothing to review, Needs Attention is one line after a green dot, and names an offline machine", async () => {
  const view = await mountRouted(oneSkillClient(), "skills-overview-healthy");
  try {
    const section = overviewSection(view.container, "Needs Attention")!;
    assert.equal(section.querySelector(".skills-overview-ok")?.textContent, "Every skill is deployed as assigned.");
    assert.ok(section.querySelector(".skills-overview-ok > .skills-overview-dot"));
    assertNoDomNode(section.querySelector(".skills-overview-count"), "no count for nothing");
    assert.equal(buttonNamed(view.container, "Review").length, 0);
  } finally {
    await view.unmount();
  }

  const offline = await mountRouted(oneSkillClient(), "skills-overview-offline", { name: "skills" }, false, undefined,
    [runner, { ...runner, runnerId: "runner-2", displayName: "Laptop", status: "offline" }]);
  try {
    assert.equal(overviewSection(offline.container, "Needs Attention")!.querySelector(".skills-overview-ok")?.textContent,
      "Every skill is deployed as assigned. Laptop is offline; its agents update when it reconnects.");
  } finally {
    await offline.unmount();
  }
});

test("Recommended by Wollipog assigns from a menu or dismisses, and never counts as attention", async () => {
  const skills = [
    { id: "s-using", name: "using-wollipog", description: "Operate Wollipog sessions.", builtIn: { release: "0.29.0", heldUpdate: null },
      recommendation: { dismissed: false }, assignmentCount: 0, latestVersion: versionAt(daysAgo(1)) },
    { id: "s-orchestrate", name: "orchestrate-issues", description: "Coordinate child sessions.", builtIn: { release: "0.29.0", heldUpdate: null },
      recommendation: { dismissed: false }, assignmentCount: 0, latestVersion: versionAt(daysAgo(2)) },
  ];
  const calls: unknown[] = [];
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: structuredClone(skills) }),
    createSkillAssignment: async (body: { skillId: string }) => {
      calls.push(body);
      skills.find((entry) => entry.id === body.skillId)!.assignmentCount += 1;
      return { assignment: { id: "a1", enabled: true, ...body } };
    },
    setSkillRecommendationDismissed: async (id: string, dismissed: boolean) => {
      calls.push({ id, dismissed });
      skills.find((entry) => entry.id === id)!.recommendation = { dismissed };
      return { skill: structuredClone(skills.find((entry) => entry.id === id)) };
    },
  }), "skills-overview-recommended");
  try {
    const { container } = view;
    const section = () => overviewSection(container, "Recommended by Wollipog");
    assert.match(section()!.textContent ?? "", /Built-in skills that teach agents to use Wollipog\. They aren't on any machine until you assign them\./);
    const names = () => [...(section()?.querySelectorAll(".row-title") ?? [])].map((title) => title.textContent);
    assert.deepEqual(names(), ["orchestrate-issues", "using-wollipog"]);
    const row = section()!.querySelector(".row")!;
    assert.deepEqual([...row.querySelectorAll(".status")].map((badge) => badge.textContent), ["Built-In"]);
    assert.deepEqual([...row.querySelectorAll("button")].map((button) => button.textContent), ["View", "Assign"]);
    assertNoDomNode(overviewSection(container, "Needs Attention")!.querySelector(".skills-overview-count"),
      "a recommendation adds nothing to the attention count");
    const sections = [...container.querySelectorAll(".skills-overview > .section .section-title")].map((title) => title.firstChild?.textContent);
    assert.deepEqual(sections.slice(0, 3), ["Needs Attention", "Recommended by Wollipog", "Recently Changed"]);

    // Assign › All Machines: an instance-wide, all-agents, Agent Invocable assignment.
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Assign using-wollipog"]')!;
    await act(async () => trigger.click());
    const items = [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
    assert.deepEqual(items.map((item) => [item.querySelector(".menu-text")?.textContent, item.querySelector(".menu-desc")?.textContent ?? null]), [
      ["All Machines", "Every supported agent on every machine."],
      ["Build Machine", "Its supported agents get it on the next sync."],
      ["Dismiss Recommendation", null],
    ]);
    assert.ok(container.querySelector('[role="menu"] [role="separator"]'), "a separator before Dismiss Recommendation");
    await act(async () => items[0]!.click());
    await act(settle);
    assert.deepEqual(calls.at(-1), { skillId: "s-using", scopeKind: "instance", agentSelector: { kind: "all" }, invocation: "agent" });
    assert.deepEqual(names(), ["orchestrate-issues"], "the assigned skill leaves the section after the refresh");
    assert.notEqual(
      container.querySelector('.skill-list-group[aria-label="Recommended"]')?.textContent?.includes("using-wollipog"), true,
      "and leaves the list's Recommended group");

    // Dismiss Recommendation hides it without assigning.
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Assign orchestrate-issues"]')!.click());
    const dismiss = [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find((item) => item.textContent === "Dismiss Recommendation")!;
    await act(async () => dismiss.click());
    await act(settle);
    assert.deepEqual(calls.at(-1), { id: "s-orchestrate", dismissed: true });
    assert.equal(calls.length, 2, "dismissing assigns nothing");
    assertNoDomNode(section() ?? null, "the section shows only while a skill is recommended");
  } finally {
    await view.unmount();
  }
});

test("a machine whose skill status failed to load is never reported as healthy", async () => {
  const view = await mountRouted(oneSkillClient({
    runnerSkills: async () => { throw new Error("HTTP 503"); },
  }), "skills-overview-unchecked");
  try {
    const section = overviewSection(view.container, "Needs Attention")!;
    assertNoDomNode(section.querySelector(".skills-overview-ok"), "no green line while a machine is unchecked");
    assert.equal(section.querySelector(".skills-hint")?.textContent,
      "Build Machine's skill status could not be loaded, so its skills are not checked.");
  } finally {
    await view.unmount();
  }
});

test("editing an assignment refreshes the library, so Recently Changed sees the change", async () => {
  let listed = 0;
  let changedAt: number | undefined;
  const assignment = { id: "assignment-1", skillId: "skill-1", scopeKind: "instance" as const,
    agentSelector: { kind: "all" as const }, enabled: true, invocation: "agent" as const };
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => {
      listed += 1;
      return { skills: [{ ...oneSkill, ...(changedAt ? { lastAssignmentChangedAt: changedAt } : {}) }] };
    },
    listSkillAssignments: async () => ({ assignments: [assignment] }),
    updateSkillAssignment: async (_id: string, patch: { enabled?: boolean }) => {
      Object.assign(assignment, patch);
      changedAt = Date.now();
      return { assignment };
    },
  }), "skills-overview-assignment-edit", { name: "skills", id: "skill-1" });
  try {
    const before = listed;
    await act(async () => view.container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Enabled"]')!.click());
    await act(settle);
    assert.equal(listed, before + 1, "the toggle reloads the library summaries");
  } finally {
    await view.unmount();
  }
});

test("after a recommendation leaves, focus moves to the next View, then to Needs Attention; a failure keeps it on Assign", async () => {
  const skills = ["orchestrate-issues", "using-wollipog"].map((name) => ({
    id: `s-${name}`, name, builtIn: { release: "0.29.0", heldUpdate: null }, recommendation: { dismissed: false },
    assignmentCount: 0, latestVersion: versionAt(daysAgo(1)),
  }));
  let fail = false;
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: structuredClone(skills) }),
    setSkillRecommendationDismissed: async (id: string, dismissed: boolean) => {
      if (fail) throw new Error("HTTP 500");
      skills.find((entry) => entry.id === id)!.recommendation = { dismissed };
      return { skill: structuredClone(skills.find((entry) => entry.id === id)) };
    },
  }), "skills-overview-focus");
  const { container } = view;
  const dismiss = async (name: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="Assign ${name}"]`)!;
    trigger.focus();
    await act(async () => trigger.click());
    const item = [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find((entry) => entry.textContent === "Dismiss Recommendation")!;
    item.focus();
    await act(async () => item.click());
    await act(settle);
  };
  const focused = () => domWindow.document.activeElement as unknown as HTMLElement | null;
  try {
    await dismiss("orchestrate-issues");
    assert.equal(focused()?.getAttribute("aria-label"), "View using-wollipog", "the next recommendation's View");

    fail = true;
    await dismiss("using-wollipog");
    assert.equal(focused()?.getAttribute("aria-label"), "Assign using-wollipog", "a failed dismissal keeps its row and focus");

    fail = false;
    await dismiss("using-wollipog");
    assert.equal(focused()?.firstChild?.textContent, "Needs Attention", "the last one hands focus to the section heading");
  } finally {
    await view.unmount();
  }
});

test("focus the person moves elsewhere while a recommendation request runs stays where they put it", async () => {
  const skill = { id: "s-using", name: "using-wollipog", builtIn: { release: "0.29.0", heldUpdate: null },
    recommendation: { dismissed: false }, assignmentCount: 0, latestVersion: versionAt(daysAgo(1)) };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: [structuredClone(skill)] }),
    setSkillRecommendationDismissed: async (_id: string, dismissed: boolean) => {
      await held;
      skill.recommendation = { dismissed };
      return { skill };
    },
  }), "skills-overview-focus-claimed");
  const { container } = view;
  try {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Assign using-wollipog"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const item = [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find((entry) => entry.textContent === "Dismiss Recommendation")!;
    await act(async () => item.click());
    await act(settle);
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filter Skills"]')!;
    filter.focus();
    await act(async () => { release(); await held; });
    await act(settle);
    assertNoDomNode(overviewSection(container, "Recommended by Wollipog") ?? null, "the dismissal finished");
    assert.ok(domWindow.document.activeElement === (filter as never), "completion does not take focus from the filter");
  } finally {
    await view.unmount();
  }
});

test("Recommended by Wollipog's Assign › machine assigns to that machine, and View opens the skill", async () => {
  const skill = { id: "s-using", name: "using-wollipog", builtIn: { release: "0.29.0", heldUpdate: null },
    recommendation: { dismissed: false }, assignmentCount: 0, latestVersion: versionAt(daysAgo(1)) };
  const calls: unknown[] = [];
  const view = await mountRouted(oneSkillClient({
    listSkills: async () => ({ skills: [skill] }),
    createSkillAssignment: async (body: unknown) => {
      calls.push(body);
      return { assignment: { id: "a1", enabled: true } };
    },
  }), "skills-overview-assign-machine");
  try {
    const { container } = view;
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Assign using-wollipog"]')!.click());
    const machine = [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
      .find((item) => item.querySelector(".menu-text")?.textContent === "Build Machine")!;
    await act(async () => machine.click());
    await act(settle);
    assert.deepEqual(calls.at(-1), {
      skillId: "s-using", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "all" }, invocation: "agent",
    });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="View using-wollipog"]')!.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills", id: "s-using" });
  } finally {
    await view.unmount();
  }
});

test("Recently Changed shows five skills, newest first, each opening its skill", async () => {
  const skills = [
    { id: "a", name: "alpha", latestVersion: versionAt(Date.now() - 2 * 3_600_000, { note: "Add migration and test-coverage checks" }) },
    { id: "b", name: "beta", latestVersion: versionAt(daysAgo(9)), lastAssignmentChangedAt: Date.now() - 5 * 60_000 },
    { id: "c", name: "gamma", latestVersion: versionAt(daysAgo(1)) },
    { id: "d", name: "delta", latestVersion: versionAt(daysAgo(2)) },
    { id: "e", name: "epsilon", latestVersion: versionAt(daysAgo(3)) },
    { id: "f", name: "zeta", latestVersion: versionAt(daysAgo(4)) },
  ];
  const view = await mountRouted(oneSkillClient({ listSkills: async () => ({ skills }) }), "skills-overview-recent");
  try {
    const { container } = view;
    const rows = [...overviewSection(container, "Recently Changed")!.querySelectorAll<HTMLButtonElement>(".surface > button.row")];
    assert.deepEqual(rows.map((row) => [
      row.querySelector(".row-title")?.textContent, row.querySelector(".row-trail")?.textContent, row.querySelector(".row-sub")?.textContent,
    ]), [
      ["beta", "5m ago", "Assignments changed"],
      ["alpha", "2h ago", "Add migration and test-coverage checks"],
      ["gamma", "1d ago", "New version"],
      ["delta", "2d ago", "New version"],
      ["epsilon", "3d ago", "New version"],
    ]);
    assertNoDomNode(overviewSection(container, "Get Started") ?? null, "a library of three or more skills needs no Get Started");
    await act(async () => rows[1]!.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills", id: "a" });
  } finally {
    await view.unmount();
  }
});

test("a small library offers Get Started: New Skill, Import from Git… and Import from Machine…", async () => {
  const view = await mountRouted(oneSkillClient(), "skills-overview-get-started");
  try {
    const { container } = view;
    const section = overviewSection(container, "Get Started")!;
    assert.deepEqual([...section.querySelectorAll("li")].map((item) => [item.querySelector(".btn")?.textContent, item.querySelector(".skills-hint")?.textContent]), [
      ["New Skill", "Write a skill here, starting from a SKILL.md template."],
      ["Import from Git…", "Copy a skill from a Git repository and keep its source."],
      ["Import from Machine…", "Snapshot a skill that already lives on a connected machine."],
    ]);
    assert.ok([...section.querySelectorAll(".btn")].every((button) => !button.classList.contains("primary")), "secondary buttons");
    await act(async () => buttonNamed(section, "New Skill")[0]!.click());
    await act(settle);
    assert.equal(container.querySelector(".modal .modal-title, .modal h2")?.textContent, "New Skill");
  } finally {
    await view.unmount();
  }
});

test("on a phone the list's first row is Library Overview with the attention count, and opens /skills/overview with Back", async () => {
  const restore = stubPhone();
  const view = await mountRouted(attentionClient(), "skills-overview-phone");
  try {
    const { container } = view;
    const first = container.querySelector<HTMLButtonElement>(".master-detail-list-body > .row")!;
    assert.ok(first.classList.contains("skill-list-overview"));
    assert.equal(first.querySelector(".row-title")?.textContent, "Library Overview");
    assert.equal(first.querySelector(".count-badge")?.textContent, "4", "the same count as Needs Attention");
    const description = container.querySelector(`#${first.getAttribute("aria-describedby")}`);
    assert.equal(description?.textContent, "4 items need attention");

    await act(async () => first.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills", pane: "overview" });
    assert.equal(container.querySelector(".detail-bar h1#page-title")?.textContent, "Library Overview");
    assert.ok(container.querySelector(".master-detail[data-detail-open] .master-detail-detail > .skills-overview"));
    assertNoDomNode(container.querySelector(".skills-overview-title"), "the detail bar already names the route");
    assert.equal(overviewSection(container, "Needs Attention")!.querySelector(".skills-overview-count")?.textContent, "4");

    await act(async () => container.querySelector<HTMLButtonElement>(".detail-bar-back")!.click());
    await act(settle);
    assert.deepEqual(view.pushed.at(-1), { name: "skills" });
    assert.equal(container.querySelector(".master-detail")?.hasAttribute("data-detail-open"), false);
  } finally {
    await view.unmount();
    restore();
  }
});

test("Change Invocation… fixes the offending rule in one request each, and an older server's ignored selector changes nothing", async () => {
  const agents = [
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" as const, available: true },
  ];
  const machine = { ...runner, displayName: "Studio Workstation", agents, providerAccounts: [] };
  const skill = { id: "skill-1", name: "collect", assignmentCount: 1, latestVersion: { id: "v1", digest: "d1", versionNumber: 1 } };
  const manualRule = { id: "rule-1", skillId: "skill-1", scopeKind: "instance" as const, agentSelector: { kind: "all" } as Record<string, string>,
    enabled: true, invocation: "manual" as "manual" | "agent" };
  let rule = manualRule;
  /** Whether this control plane applies `agentSelector` on update (#1972); an older one ignores it. */
  let appliesSelector = false;
  const patches: unknown[] = [];
  const client = {
    ...api,
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [] }),
    getSkill: async () => ({ skill, latestVersion: { ...skill.latestVersion, files: [] } }),
    listSkillAssignments: async () => ({ assignments: [structuredClone(rule)] }),
    runnerSkills: async () => ({
      desired: [{ name: "collect", versionDigest: "d1", targets: agents
        .filter((agent) => rule.agentSelector.kind === "all" || agent.driver === rule.agentSelector.driver)
        .map((agent) => ({ agentId: agent.id, invocation: rule.invocation })) }],
      reported: null,
    }),
    updateSkillAssignment: async (id: string, body: { invocation?: "agent" | "manual"; agentSelector?: Record<string, string> }) => {
      patches.push({ id, ...body });
      rule = { ...rule, ...(body.invocation ? { invocation: body.invocation } : {}),
        ...(body.agentSelector && appliesSelector ? { agentSelector: body.agentSelector } : {}) };
      return { assignment: structuredClone(rule) };
    },
  } as unknown as ApiClient;
  let view = await mountSkills(client, "skills-manual-only", [machine]);
  await view.click(view.listItem("collect"));
  assert.equal(view.slot()?.dataset.notice, "manual-only");
  assert.equal(view.slot()!.querySelector(".notice-title")?.textContent, "Codex Can't Run Manual-Only Skills");

  // An older control plane ignores the selector: the page says so and changes nothing else.
  await view.click(view.button("Change Invocation…"));
  await view.click(view.menuItem("Limit to Claude Code"));
  assert.deepEqual(patches, [{ id: "rule-1", agentSelector: { kind: "driver", driver: "claude-code" } }]);
  const alert = view.container.querySelector('.page > .notice.t-danger[role="alert"]');
  assert.match(alert?.textContent ?? "", /can't change which agents an assignment covers yet, so nothing changed/);
  assert.deepEqual(rule, manualRule);
  assert.equal(view.slot()?.dataset.notice, "manual-only", "the rule is unchanged, so the error stays");

  // Limit to Claude Code: one request, Manual Only stays, and the notice clears after the refresh.
  appliesSelector = true;
  await view.click(view.button("Change Invocation…"));
  await view.click(view.menuItem("Limit to Claude Code"));
  assert.equal(patches.length, 2);
  assert.deepEqual(rule, { ...manualRule, agentSelector: { kind: "driver", driver: "claude-code" } });
  assertNoDomNode(view.slot());
  assertNoDomNode(view.container.querySelector('.page > .notice.t-danger[role="alert"]'), "the newer success clears the error");
  await view.unmount();

  // Switch to Agent Invocable: one request, and the notice clears after the refresh.
  rule = manualRule;
  view = await mountSkills(client, "skills-manual-only-switch", [machine]);
  await view.click(view.listItem("collect"));
  await view.click(view.button("Change Invocation…"));
  await view.click(view.menuItem("Switch to Agent Invocable"));
  assert.deepEqual(patches.slice(2), [{ id: "rule-1", invocation: "agent" }]);
  assertNoDomNode(view.slot());
  await view.unmount();
});

test("a grouped skill's Manual Only error offers no fix until the group's rules are read, then sends the person to Groups", async () => {
  const agents = [
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" as const, available: true },
  ];
  const machine = { ...runner, agents, providerAccounts: [] };
  const skill = { id: "skill-1", name: "collect", groupId: "group-1", assignmentCount: 1, latestVersion: { id: "v1", digest: "d1", versionNumber: 1 } };
  const patches: unknown[] = [];
  let groupRead: "fail" | "ok" = "fail";
  const client = {
    ...api,
    listSkills: async () => ({ skills: [skill] }),
    listSkillGroups: async () => ({ groups: [{ id: "group-1", name: "Platform", sortOrder: 0 }] }),
    getSkill: async () => ({ skill, latestVersion: { ...skill.latestVersion, files: [] } }),
    // The skill's own instance-wide rule; the group's runner-scoped rule outranks it on this machine.
    listSkillAssignments: async () => ({ assignments: [{ id: "direct", skillId: "skill-1", scopeKind: "instance", agentSelector: { kind: "all" },
      enabled: true, invocation: "manual" }] }),
    listSkillGroupAssignments: async () => {
      if (groupRead === "fail") throw new Error("HTTP 503");
      return { assignments: [{ id: "group-rule", groupId: "group-1", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "all" },
        enabled: true, invocation: "manual" }] };
    },
    runnerSkills: async () => ({ desired: [{ name: "collect", versionDigest: "d1", targets: [
      { agentId: "claude", invocation: "manual" }, { agentId: "codex", invocation: "manual" }] }], reported: null }),
    updateSkillAssignment: async (...args: unknown[]) => { patches.push(args); return { assignment: {} }; },
  } as unknown as ApiClient;
  let view = await mountSkills(client, "skills-group-unread", [machine]);
  await view.click(view.listItem("collect"));
  assert.equal(view.slot()?.dataset.notice, "manual-only");
  assert.deepEqual([...view.slot()!.querySelectorAll(".notice-actions > button")], [],
    "the skill's own rule is never blamed while the group's could be the winner");
  await view.unmount();

  groupRead = "ok";
  view = await mountSkills(client, "skills-group-read", [machine]);
  await view.click(view.listItem("collect"));
  assert.deepEqual([...view.slot()!.querySelectorAll(".notice-actions > button")].map((button) => button.textContent), ["Edit in Groups…"]);
  assert.match(view.slot()!.textContent ?? "", /Switch the group's assignment to Agent Invocable/);
  assert.deepEqual(patches, []);
  await view.unmount();
});
