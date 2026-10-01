import React from "react";
import { createRoot } from "react-dom/client";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type ControlPlaneToUi, type ExecutionTargetDefinition, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewFromPath, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { SkillsView } from "../components/SkillsView.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import "../styles.css";

const accountScopes = new URLSearchParams(location.search).has("accountScopes");
const macosAdoption = new URLSearchParams(location.search).has("macosAdoption");
const windowsAdoption = new URLSearchParams(location.search).has("windowsAdoption") ||
  new URLSearchParams(location.search).has("wslAdoption");
const wslAdoption = new URLSearchParams(location.search).has("wslAdoption");
// Drift resolution runs against the real API client so the spec can route and assert each request.
const drift = new URLSearchParams(location.search).has("drift");
// Orphaned-copy resolution does too, on a current runner beside an older one.
const orphans = new URLSearchParams(location.search).has("orphans");
// #1714: Build Machine offers container and cloud targets; Other Machine stays host-only.
const targets = new URLSearchParams(location.search).has("targets");
// `?assignment=1` gives the skill one direct assignment, so its assignments table has a row with an
// Invocation picker.
const assignment = new URLSearchParams(location.search).has("assignment");
// `?builtIn=1` makes the skill a built-in one whose next release waits for review (#2129).
const builtIn = new URLSearchParams(location.search).has("builtIn")
  ? { builtIn: { release: "1.0.0", heldUpdate: { release: "1.1.0", digest: "e".repeat(64) } } }
  : {};
const hostTarget = (runnerId: string): ExecutionTargetDefinition => ({
  id: `${runnerId}-host`, runnerId, name: "Runner Host · worktree", kind: "local", workspaceStrategy: "worktree", adapter: "host",
  boundaries: { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" }, available: true,
});

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: new URLSearchParams(location.search).has("macos") || macosAdoption
    ? "macos"
    : new URLSearchParams(location.search).has("windows") || new URLSearchParams(location.search).has("wslSkills") ||
        windowsAdoption
      ? "windows" : "linux",
  version: "1",
  status: "online",
  // `?longMachine=1` (#1984): a 60-character name, which the Machine select truncates.
  displayName: new URLSearchParams(location.search).has("longMachine")
    ? "Build Machine in the Third-Floor Lab Rack With Two GPU Cards" : "Build Machine",
  agents: [
    {
      id: "claude",
      name: "Claude",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      available: true,
    },
    // `?dialogs=1` (#1964): one agent of each other type, for Add Assignment's lists and its
    // Manual Only warning.
    ...(new URLSearchParams(location.search).has("dialogs") ? [
      { id: "codex-review", name: "Codex Review", command: "codex", args: [], env: {}, driver: "codex" as const, available: true },
      { id: "codex-app", name: "Codex App", command: "codex", args: [], env: {}, driver: "codex-app-server" as const, available: true },
      { id: "pi", name: "Pi Agent", command: "pi", args: [], env: {}, driver: "pi" as const, available: true },
    ] : []),
    ...(new URLSearchParams(location.search).has("matrix") ? [
      { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" as const, available: true },
      { id: "wsl", name: "WSL Codex", command: "codex", args: [], env: {}, driver: "codex" as const, context: { kind: "wsl" as const, distro: "Ubuntu" }, available: true },
    ] : []),
  ],
  ...(accountScopes ? { providerAccounts: [
    { id: "acct-work", label: "Work Account", provider: "claude" as const, authStatus: "authenticated" as const },
    { id: "acct-personal", label: "Personal Account", provider: "claude" as const, authStatus: "authenticated" as const },
  ] } : {}),
  ...(targets ? { executionTargets: [
    hostTarget("runner-1"),
    {
      id: "runner-1-container", runnerId: "runner-1", name: "Offline Container", kind: "container", workspaceStrategy: "worktree",
      adapter: "container", boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" }, available: true,
    },
    {
      id: "runner-1-cloud", runnerId: "runner-1", name: "Cloud Sandbox", kind: "cloud", workspaceStrategy: "worktree",
      adapter: "cloud", boundaries: { filesystem: "snapshot", network: "deny", secrets: "none", billing: "none" }, available: true,
    },
  ] satisfies ExecutionTargetDefinition[] } : {}),
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: orphans
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.skillKeptAsideCopies
    : drift
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift
    : accountScopes
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.accountScopedAgentSkills
    : macosAdoption
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.nativeMacosMachineSkillAdoption
    : wslAdoption
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.wslMachineSkillAdoption
    : windowsAdoption
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.nativeWindowsMachineSkillAdoption
    : new URLSearchParams(location.search).has("legacySkills")
    ? 1
    : new URLSearchParams(location.search).has("legacyRecovery")
      ? RUNNER_CAPABILITY_MIN_PROTOCOL.machineSkillAdoptionRecovery - 1
      : new URLSearchParams(location.search).has("wslSkills")
        ? RUNNER_CAPABILITY_MIN_PROTOCOL.wslMachineSkills
      : new URLSearchParams(location.search).has("windows")
        ? RUNNER_CAPABILITY_MIN_PROTOCOL.nativeWindowsMachineSkillSnapshots
        : new URLSearchParams(location.search).has("macos")
          ? RUNNER_CAPABILITY_MIN_PROTOCOL.nativeMacosMachineSkillSnapshots
        : RUNNER_CAPABILITY_MIN_PROTOCOL.machineSkillAdoptionRecovery,
};

const snapshot: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: false,
  },
  runners: [runner, ...(new URLSearchParams(location.search).has("matrix") ? [{ ...runner, runnerId: "runner-2", displayName: "Other Machine",
    ...(targets ? { executionTargets: [hostTarget("runner-2")] } : {}),
    status: new URLSearchParams(location.search).has("onlineMatrix") ? "online" as const : "offline" as const }] : []),
    // `&orphansOffline=1` (#1974) takes the older machine offline; `&orphansSingle=1` leaves it out,
    // so no runner keeps copies it cannot report.
    ...(orphans && !new URLSearchParams(location.search).has("orphansSingle") ? [{ ...runner, runnerId: "runner-2", hostname: "older-host", displayName: "Older Machine",
      protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift,
      ...(new URLSearchParams(location.search).has("orphansOffline") ? { status: "offline" as const } : {}) }] : [])],
  boxes: [],
  sessions: [],
  runs: [],
  pods: [],
};

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "skill-removals-e2e",
  runtimeKey: "skill-removals-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

// The route is the view's only selection (#1947), so navigation is real history: a row pushes an
// entry and the browser's Back pops it. `?route=/skills/orphans` opens a route directly.
const initialRoute = viewFromPath(new URLSearchParams(location.search).get("route") ?? "/skills") ?? { name: "skills" };
const historyView = (state: unknown): View => (state as { view?: View } | null)?.view ?? initialRoute;
const navigation: ViewNavigation = {
  current: () => historyView(history.state),
  push(view) { history.pushState({ view }, ""); },
  listen(onView) {
    const listener = (event: PopStateEvent) => onView(historyView(event.state));
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  },
};

const reportedAt = 1_700_000_000_000;
const removalsReportedAt = 1_699_999_000_000;
const runnerSkills: RunnerSkillsResponse = {
  removalReporting: "supported",
  desired: [{
    name: "code-review",
    versionDigest: "d1",
    targets: [{ agentId: "claude", invocation: "agent" }],
  }],
  reported: {
    deployed: accountScopes ? [{
      name: "code-review", digest: "d1", providerAccountId: "acct-work",
      links: [{ agentId: "claude", status: "linked" }],
    }, {
      name: "code-review", digest: "d1", providerAccountId: "acct-personal",
      links: [{ agentId: "claude", status: "conflict", detail: "A local directory blocks this link." }],
    }] : [{
      name: "code-review", digest: "d1",
      links: [{ agentId: "claude", status: "linked" }],
    }],
    unmanaged: accountScopes
      ? [{ agentId: "claude", name: "account-notes", description: "Local account skill",
          providerAccountId: "acct-personal" }]
      : [],
    // One removal is this skill's; the others are other skills', which only Connections lists (#1981).
    removals: [
      {
        path: "~/.claude/skills/code-review",
        reason: "The canonical location it routes through is conflicted.",
        ...(accountScopes ? { providerAccountId: "acct-work" } : {}),
      },
      {
        path: "~/.codex/skills/retired-skill-with-a-long-name",
        reason: "No longer in the desired skill list.",
        ...(accountScopes ? { providerAccountId: "acct-work" } : {}),
      },
      {
        path: "~/.claude/skills/conflicted-canonical-skill",
        reason: "The canonical location it routes through is conflicted.",
        ...(accountScopes ? { providerAccountId: "acct-personal" } : {}),
      },
    ],
    removalsUpdatedAt: removalsReportedAt,
    updatedAt: reportedAt,
  },
};

const client = {
  ...api,
  listSkills: async () => ({ skills: [{
    id: "skill-1",
    name: "code-review",
    description: "Reviews code",
    latestVersion: { id: "v1", digest: "d1", createdAt: reportedAt },
    ...builtIn,
  }] }),
  listSkillGroups: async () => ({ groups: [] }),
  getSkill: async () => ({
    skill: {
      id: "skill-1",
      name: "code-review",
      description: "Reviews code",
      gitSource: { url: "https://github.com/example/skills.git", ref: "stable", subdirectory: "skills", path: "skills/code-review", commit: "a".repeat(64) },
      latestVersion: { id: "v1", digest: "d1", createdAt: reportedAt },
      ...builtIn,
    },
    latestVersion: {
      id: "v1",
      digest: "d1",
      machineSource: { runnerId: "runner-1", sourceDirectory: ".codex/skills", name: "code-review",
        digest: "b".repeat(64), importedAt: reportedAt,
        ...(accountScopes ? { providerAccountId: "acct-work" } : {}) },
      createdAt: reportedAt,
      files: [{
        path: "SKILL.md",
        content: "---\nname: code-review\n---\n\nAlways review the diff.\n",
        encoding: "utf8" as const,
      }],
    },
    assignments: [],
  }),
  listSkillAssignments: async () => ({ assignments: assignment ? [{
    id: "assignment-1", skillId: "skill-1", scopeKind: "instance" as const,
    agentSelector: { kind: "all" as const }, enabled: true, invocation: "agent" as const,
  }] : [] }),
  runnerSkills: async () => runnerSkills,
  getMachineSkillVersionPolicy: async () => ({ policy: null }),
  syncRunnerSkills: async () => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    return runnerSkills.reported!;
  },
  ...(new URLSearchParams(location.search).has("groups") ? {
    listSkills: api.listSkills, listSkillGroups: api.listSkillGroups, getSkill: api.getSkill,
  } : {}),
  ...(new URLSearchParams(location.search).has("matrix") ? {
    runnerSkills: api.runnerSkills, getMachineSkillVersionPolicy: api.getMachineSkillVersionPolicy,
  } : {}),
  ...(drift || orphans ? { runnerSkills: api.runnerSkills, syncRunnerSkills: api.syncRunnerSkills } : {}),
  // `?pins=1` (#1973): the machine version policy comes from the spec's routes too, so a review can
  // name the version a machine is pinned to. (The version list always does.)
  ...(new URLSearchParams(location.search).has("pins") ? { getMachineSkillVersionPolicy: api.getMachineSkillVersionPolicy } : {}),
} as unknown as ApiClient;

function SkillsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  const view = useStoreSelector((state) => state.view);
  return ready ? <SkillsView route={view.name === "skills" ? view : undefined} /> : null;
}

const view = (
  <StoreProvider connection={connection} navigation={navigation}>
    <SkillsWhenReady />
  </StoreProvider>
);

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <FeedbackProvider>{view}</FeedbackProvider>
  </ApiProvider>,
);
