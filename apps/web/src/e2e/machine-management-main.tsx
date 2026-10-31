import React from "react";
import { createRoot } from "react-dom/client";
import {
  PERSONAL_ORGANIZATION_ID,
  PROTOCOL_VERSION,
  isProviderHomeRecoveryCause,
  type AddBoxRequest,
  type BoxView,
  type ControlPlaneToUi,
  type ProviderHomeLeaseInspection,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RunnersView } from "../components/RunnersView.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import type { MachineAccountsIntent, View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

const requestedRole = new URLSearchParams(window.location.search).get("role");
const identityRole = requestedRole === "viewer"
  ? "viewer" as const
  : requestedRole === "machine-owner" ? "operator" as const : "owner" as const;

let runner: RunnerView | null = {
  runnerId: "native-t14s",
  displayName: "Design Workstation",
  hostname: "Misko-T14s-G6",
  os: "windows",
  version: "1",
  status: "online",
  agents: [
    {
      id: "custom-acp",
      name: "Custom ACP",
      command: "custom-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
      available: true,
      authStatus: "authenticated",
      acp: {
        logout: false,
        loadSession: false,
        sessionList: false,
        sessionDelete: false,
        sessionResume: false,
        sessionClose: false,
      },
    },
    {
      id: "missing-acp",
      name: "Missing ACP",
      command: "missing-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
      available: false,
      unavailableReason: "The configured command was not found or could not be started in this execution context.",
    },
    {
      id: "legacy-acp",
      name: "Legacy Unverified ACP",
      command: "legacy-acp",
      args: [],
      env: {},
      driver: "acp",
      context: { kind: "native" },
      source: "config",
    },
  ],
  providerAccounts: [
    {
      id: "claude-work",
      label: new URLSearchParams(window.location.search).has("emailLabels") ? "work@example.com" : "Work",
      provider: "claude",
      authStatus: "authenticated",
    },
    {
      id: "claude-personal",
      label: "Personal",
      provider: "claude",
      authStatus: "unauthenticated",
    },
    { id: "codex-team", label: "Codex Team", provider: "codex", authStatus: "authenticated" },
    { id: "codex-solo", label: "Codex Solo", provider: "codex", authStatus: "authenticated" },
  ],
  providerAccountDefaults: [],
  workspaces: [{ id: "home", name: "Home", path: "C:\\Users\\misko" }],
  connectedAt: 1,
  // Seen moments ago, as a connected runner is: Connection Details reads its Last Seen (#2988).
  lastSeen: Date.now() - 30_000,
  protocolVersion: PROTOCOL_VERSION,
  agentsRefreshed: true,
  canManage: identityRole !== "viewer",
  automaticAccountSwitching: { enabled: false, revision: 0 },
  capacity: {
    configuredUnits: 16,
    revision: 2,
    authority: "control_plane",
    usedUnits: 12,
    availableUnits: 4,
    queuedSessions: 3,
    dimensions: {
      activeTurns: { used: 4, limit: 4, available: 0 },
      residentProcessUnits: { used: 12, limit: 16, available: 4 },
      retainedSessions: { used: 9, limit: null, available: null },
      parkedSessions: 2,
      idleProcessPolicy: "park_when_needed",
    },
    blockers: [{
      kind: "agent_quota",
      description: "claude is using 4 of 4 provider slots",
      usedUnits: 4,
      limitUnits: 4,
      requiredUnits: 1,
      waitingSessions: 3,
      agentId: "claude",
    }],
  },
};
// Provider Accounts (#2995), with `?signingIn`: Codex Team's sign-in is running, so the section shows
// Signed In, Sign-In Required and Signing In rows at once.
if (new URLSearchParams(window.location.search).has("signingIn")) {
  runner.providerLogins = [{
    operationId: "login_fixture_team", accountId: "codex-team", label: "Codex Team", provider: "codex",
    status: "waiting_for_provider", expectsCode: false, verificationUrl: "https://auth.openai.com/device",
    userCode: "WOLL-IPOGS", startedAt: Date.now(),
  }];
}
// A provider sign-in in each state (#2996), with `?signIn=`: `device` (Codex Team's device code),
// `code` (Work's pasted code), `rejected` (the same, and the runner rejects any code), `failed`,
// `timed-out` (both Work's), and `duplicate` (a new account, Work 2, that is already on the
// machine). With `?emailLabels` the signing-in accounts are named by email. `?theme=light|dark`.
const signInFixture = new URLSearchParams(window.location.search).get("signIn");
const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
if (signInFixture && runner.providerAccounts) {
  const emailLabels = new URLSearchParams(window.location.search).has("emailLabels");
  const team = runner.providerAccounts.find((account) => account.id === "codex-team")!;
  if (emailLabels) team.label = "team@example.com";
  const work = runner.providerAccounts.find((account) => account.id === "claude-work")!;
  const claude = {
    operationId: "login_fixture_work", accountId: work.id, label: work.label, provider: "claude" as const, startedAt: Date.now(),
  };
  runner.providerLogins = [
    signInFixture === "device" ? {
      operationId: "login_fixture_team", accountId: team.id, label: team.label, provider: "codex", status: "waiting_for_provider",
      expectsCode: false, verificationUrl: "https://auth.openai.com/device", userCode: "WOLL-IPOGS", startedAt: Date.now(),
    } : signInFixture === "code" || signInFixture === "rejected" ? {
      ...claude, status: "awaiting_code", expectsCode: true, verificationUrl: "https://claude.ai/oauth/authorize?fixture=machine",
    } : signInFixture === "failed" ? {
      ...claude, status: "failed", error: "The provider did not confirm authentication.",
    } : signInFixture === "timed-out" ? {
      ...claude, status: "timed_out", error: "Sign-in timed out before the provider confirmed authentication.",
    } : {
      operationId: "login_fixture_duplicate", accountId: "work-2-1a2b3c4d", label: emailLabels ? "work.two@example.com" : "Work 2",
      provider: "claude", status: "failed", startedAt: Date.now(),
      error: "This Claude account is already on this Machine. The duplicate sign-in was discarded.",
      failureCode: "account_already_on_machine",
    },
  ];
}
// Provider profiles (#3239): one account in each access state, and Codex Solo left a legacy HOME.
if (new URLSearchParams(window.location.search).has("profiles") && runner.providerAccounts) {
  // A Windows runner refuses every adoption, so the Machine that adopts is a Linux one (#3240).
  runner.os = "linux";
  runner.workspaces = [{ id: "home", name: "Home", path: "/home/misko" }];
  const access = { "claude-work": "granted", "claude-personal": "pending", "codex-team": "not_granted" } as const;
  for (const account of runner.providerAccounts) {
    const state = access[account.id as keyof typeof access];
    if (state) account.profile = { id: `profile-${account.id}`, access: state };
  }
}
// Stale lease recovery (#3241), with `?leases`: Personal's HOME holds a stale lease that can be
// recovered, and Codex Team's one was recorded during the current boot without process evidence.
const leases: Record<string, ProviderHomeLeaseInspection> = new URLSearchParams(window.location.search).has("leases") ? {
  "claude-personal": { state: "stale", tipHash: "c".repeat(64), createdAt: "2026-10-14T16:20:00.000Z", sameHost: true, hasEvidence: false, refusal: null },
  "codex-team": { state: "stale", tipHash: "d".repeat(64), createdAt: "2026-10-18T09:05:00.000Z", sameHost: true, hasEvidence: false, refusal: "NO_REBOOT_PROOF" },
} : {};
const recoveryCause = new URLSearchParams(window.location.search).get("lease-cause");
if (isProviderHomeRecoveryCause(recoveryCause) && leases["codex-team"]) {
  Object.assign(leases["codex-team"], {
    cause: recoveryCause,
    blockingProcess: { pid: 4242, startTime: "987654", kind: "uninspectable", cgroupMembership: "unavailable" },
  });
}
// A Windows runner answers no lease inspection, so the lease scenario is a Linux Machine.
if (Object.keys(leases).length && runner) {
  runner.os = "linux";
  runner.workspaces = [{ id: "home", name: "Home", path: "/home/misko" }];
}
const fixtureParams = new URLSearchParams(window.location.search);
// `machines=0` opens on the empty Machines tab (#2984).
if (fixtureParams.get("machines") === "0") runner = null;
// `identity=fail` fails every permission load until `restoreIdentity()`, so Retry can recover (#2984).
let identityFails = fixtureParams.get("identity") === "fail";
// `local=setup` stands in for the desktop app's bundled runner, available and not yet set up, so
// This Machine is offered (#2984).
if (fixtureParams.get("local") === "setup") {
  Object.assign(globalThis, { isTauri: true });
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        if (command === "local_runner_status") return { available: true, enabled: false, running: false, runnerId: null };
        throw new Error(`${command} is not part of this fixture`);
      },
    },
  });
}
/**
 * `machines=N` adds machines beside Design Workstation, one of each status first, so the list sorts,
 * groups past eight and filters (#2985). They are view-only: the scenarios act on Design Workstation.
 */
const extraMachineCount = Math.max(0, Number(fixtureParams.get("machines") ?? "1") - 1);
function extraRunner(runnerId: string, displayName: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId, displayName, hostname: `${runnerId}.local`, os: "linux", version: "1", status: "online",
    agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION, ...overrides,
  };
}
const statusMachines: Array<{ runner?: RunnerView; box?: BoxView }> = [
  { runner: extraRunner("build-server", "Build Server", { protocolVersion: PROTOCOL_VERSION - 1 }) },
  // Last seen a few minutes before the page opened, as the overview's reason reads it (#2986).
  { runner: extraRunner("gpu-box", "GPU Box", { status: "offline", lastSeen: Date.now() - 4 * 60_000 }) },
  { box: { boxId: "box-golf", runnerId: "golf-sim", displayName: "Golf Simulator", sshTarget: "me@golf-sim", status: "bootstrapping" as const, lastError: null, createdAt: 1 } },
  { box: { boxId: "box-archive", runnerId: "archive-nas", displayName: "Archive NAS", sshTarget: "admin@archive", status: "failed" as const, lastError: "Permission denied (publickey).", createdAt: 1 } },
  { runner: extraRunner("studio-mac", "Studio Mac", { os: "macos", capacity: { configuredUnits: 40, usedUnits: 29, revision: 1, authority: "control_plane" } }) },
  { runner: extraRunner("media-pc", "Media PC", {
    agents: [{ id: "gemini", name: "Gemini", command: "npx", args: [], env: {}, driver: "acp", available: true,
      registry: { installStatus: "approval-required" } as RunnerView["agents"][number]["registry"] }],
  }) },
  { runner: extraRunner("travel-laptop", "Travel Laptop", {
    providerAccounts: [{ id: "personal", label: "Personal", provider: "claude", authStatus: "unauthenticated" }],
  }) },
];
/**
 * `fleet=ready` leaves out the machines that need the person, and signs Design Workstation's last
 * account in: the overview's calm state (#2986).
 */
const readyFleet = fixtureParams.get("fleet") === "ready";
if (readyFleet) for (const account of runner?.providerAccounts ?? []) account.authStatus = "authenticated";
const extraMachines: Array<{ runner?: RunnerView; box?: BoxView }> = [
  ...readyFleet ? [] : statusMachines,
  ...Array.from({ length: 12 }, (_, index) => ({
    runner: extraRunner(`ci-runner-${index + 1}`, `CI Runner ${index + 1}`, {
      capacity: { configuredUnits: 8, usedUnits: index % 9, revision: 1, authority: "control_plane" },
    }),
  })),
].slice(0, extraMachineCount);
// `snapshot=hold` never delivers the first snapshot: the tab stays loading.
const holdSnapshot = fixtureParams.get("snapshot") === "hold";
/** After `disconnect()` the connection stays down, so the last-known rows stay on screen. */
let connectionHeld = false;
let socket: FixtureSocket | null = null;
let box: BoxView | null = null;
// `outdated` gives Design Workstation an older runner protocol (#2988's Runner Update Required).
if (fixtureParams.has("outdated") && runner) runner.protocolVersion = PROTOCOL_VERSION - 1;
// `credentialImport` (#3719) makes Design Workstation a Linux machine whose runner can copy an
// existing Codex API-key sign-in into a new managed profile. `credentialImport=unsupported` is a
// Linux runner that reports no such capability (one inside WSL or a container).
if (fixtureParams.has("credentialImport") && runner) {
  runner.os = "linux";
  runner.workspaces = [{ id: "home", name: "Home", path: "/home/misko" }];
  runner.runtime = { dataDir: "/home/misko/.agent-manager", worktreeRoot: "/home/misko/.agent-manager/worktrees", maxConcurrentSessions: 8,
    ...(fixtureParams.get("credentialImport") === "unsupported" ? {} : { providerCredentialImport: { version: 1 as const, providers: ["codex" as const] } }) };
}
// `capacity=waiting` is Design Workstation before its first live report (#2989).
if (fixtureParams.get("capacity") === "waiting" && runner?.capacity) {
  runner.capacity = { configuredUnits: runner.capacity.configuredUnits, revision: runner.capacity.revision, authority: "control_plane" };
}
// `workspaces=0` leaves Design Workstation without workspaces; `workspaces=long` adds deep paths (#2989).
if (fixtureParams.get("workspaces") === "0" && runner) runner.workspaces = [];
if (fixtureParams.get("workspaces") === "long" && runner) {
  runner.workspaces.push(
    { id: "storefront", name: "Acme Storefront", path: "C:\\Users\\misko\\src\\clients\\acme\\retail\\web\\packages\\acme-storefront" },
    { id: "notes", name: "Research Notes With a Long Name for a Narrow Row", path: "D:\\archive\\2026\\research\\notes" },
  );
}
/**
 * `skills=empty` reports nothing unmanaged and no removals; `skills=fail` fails the first read only, so Retry recovers (#2989).
 * `skills=long` adds a name that fits a phone row once the agent gives way, and one that never fits (#3526).
 */
const skillsScenario = fixtureParams.get("skills");
let skillsFailures = skillsScenario === "fail" ? 1 : 0;
/**
 * `ssh=<state>` makes Design Workstation an SSH machine in one lifecycle state (#2988): `online`,
 * `connecting` (bootstrapping), `failed` (its key refused), `ended` (an SSH session that simply
 * ended) or `legacy` (older runner data found).
 */
const sshState = fixtureParams.get("ssh");
if (sshState && runner) {
  box = {
    boxId: "demo-box", runnerId: runner.runnerId, displayName: "Design Workstation", sshTarget: "misko@design-workstation",
    status: sshState === "connecting" ? "bootstrapping" : sshState === "failed" ? "failed" : sshState === "ended" ? "offline" : "online",
    lastError: sshState === "failed" ? "misko@design-workstation: Permission denied (publickey)." : null,
    createdAt: 1, deployedVersion: "0.42.0+fixture", triple: "x86_64-pc-windows-msvc",
    ...(sshState === "legacy" ? { runnerDataLayout: "legacy" as const, legacyDataAccountStatus: "unclaimed" as const } : {}),
  };
  if (sshState === "connecting") runner = null;
  else if (sshState !== "online" && sshState !== "legacy") Object.assign(runner, { status: "offline", lastSeen: Date.now() - 4 * 60_000 });
}
/** A Machine Settings field whose saves fail until cleared: a partial save (#2991). */
let failingSettingsSave: "capacity" | null = null;
/** How many lifecycle requests the busy machine refuses before it is forced (`busy` in the URL). */
const busyMachine = fixtureParams.has("busy");
/** `reconnect=hold` leaves Reconnect's request unanswered; `reconnect=fail` never reaches the server (#3525). */
const reconnectOutcome = fixtureParams.get("reconnect");
let reconnectRequests = 0;
const activeSessionsConflict = () => new ApiError("this machine has 2 active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", {
  activeSessions: [
    { id: "s1", title: "Fix the half-cent rounding bug", status: "running" },
    { id: "s2", title: "Draft the release notes", status: "idle" },
  ],
  activeSessionCount: 2,
});
let lastRegisteredWorkspace: { name: string; path: string } | null = null;
let lastAddBoxRequest: AddBoxRequest | null = null;
/** How Connect via SSH's request answers (#2987): accepted, refused with this message, or held open. */
let addBoxOutcome: { kind: "accept" } | { kind: "refuse"; message: string; status: number } | { kind: "hold" } = { kind: "accept" };

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      createProjectLocations: true,
    },
    runners: [
      ...(runner ? [structuredClone(runner)] : []),
      ...extraMachines.flatMap((machine) => machine.runner ? [structuredClone(machine.runner)] : []),
    ],
    boxes: [
      ...(box ? [structuredClone(box)] : []),
      ...extraMachines.flatMap((machine) => machine.box ? [structuredClone(machine.box)] : []),
    ],
    projects: [],
    sessions: [],
    runs: [],
    pods: [],
  };
}

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    if (holdSnapshot || connectionHeld) return;
    window.setTimeout(() => {
      this.onopen?.();
      this.push(snapshot());
    }, 0);
  }
  send() {}
  close() {}
  push(message: ControlPlaneToUi): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connection: UiConnectionRuntime = {
  instanceId: "machine-management-e2e",
  runtimeKey: "machine-management-e2e:1",
  createSocket() {
    socket = new FixtureSocket();
    return socket;
  },
  close() {},
};

// `machine=<runnerId>` opens that machine's route, as a link or a reload does (#2985).
const initialMachine = fixtureParams.get("machine");
// Set Up Managed Profile and Recover Existing Profile from a refused session (#3240), with
// `accounts=add-<provider>` or `accounts=recover-<accountId>`: the intent the session notice sends.
const accountsParam = fixtureParams.get("accounts");
const accountsIntent: MachineAccountsIntent | undefined = accountsParam?.startsWith("add-")
  ? { kind: "add_account", provider: accountsParam.slice(4) === "codex" ? "codex" : "claude", activationId: 1 }
  : accountsParam?.startsWith("recover-")
    ? { kind: "recover_profile", accountId: accountsParam.slice(8), activationId: 1 }
    : undefined;
const initialView: View = initialMachine
  ? { name: "runners", section: "machines", machineId: initialMachine, ...(accountsIntent ? { accounts: accountsIntent } : {}) }
  : { name: "runners", section: "machines" };
const navigation: ViewNavigation = {
  current: () => initialView,
  push() {},
  listen: () => () => {},
};

/** The machine's skills report: an unmanaged skill on the Work account, and two link removals. */
const skillsReport = () => ({
  removalReporting: "supported" as const,
  desired: [],
  reported: {
    unmanaged: [{ agentId: "custom-acp", name: "local-notes", description: "Scratch notes kept outside Wollipog",
      providerAccountId: "claude-work" },
    ...(skillsScenario === "long" ? [
      { agentId: "custom-acp", name: "design-review", providerAccountId: "claude-work" },
      { agentId: "custom-acp", name: "frontend-design-review-for-every-storefront-page", providerAccountId: "claude-work" },
    ] : [])],
    removals: [
      { path: "~/.claude/skills/code-review", reason: "No longer in the desired skill list." },
      { path: "~/.codex/skills/retired-skill-with-a-long-name-that-wraps", reason: "The canonical location it routes through is conflicted." },
    ],
    // Four minutes before the newer inventory: the removals show their own time (#2989).
    removalsUpdatedAt: Date.now() - 4 * 60_000,
    updatedAt: Date.now() - 60_000,
  },
});

const client = {
  ...api,
  // Skills on This Machine (#1981): the machine's own skills diagnostics, read when opened.
  runnerSkills: async () => {
    if (skillsFailures > 0) {
      skillsFailures -= 1;
      throw new ApiError("the runner did not answer", 503);
    }
    return skillsScenario === "empty"
      ? { removalReporting: "supported", desired: [], reported: { unmanaged: [], removals: [], updatedAt: Date.now() - 4 * 60_000 } }
      : skillsReport();
  },
  sshConfigHosts: async () => ({
    hosts: [
      { host: "golf-sim", hostName: "100.64.0.10", user: "misko", port: 2222 },
      { host: "build-box", hostName: "build.internal", user: "builder" },
    ],
  }),
  addBox: async (body: AddBoxRequest) => {
    lastAddBoxRequest = structuredClone(body);
    if (addBoxOutcome.kind === "hold") return new Promise<never>(() => undefined);
    if (addBoxOutcome.kind === "refuse") {
      if (addBoxOutcome.status === 0) throw new TypeError(addBoxOutcome.message);
      throw new ApiError(addBoxOutcome.message, addBoxOutcome.status);
    }
    return {
      box: {
        boxId: "box-created",
        runnerId: "box-created",
        displayName: body.displayName,
        sshTarget: body.sshTarget,
        status: "bootstrapping" as const,
        lastError: null,
        createdAt: 1,
      },
    };
  },
  getIdentity: async () => {
    if (identityFails) throw new Error("GET /api/identity failed: 503 Service Unavailable");
    return {
      context: {
        userId: "owner",
        userName: "Owner",
        organizationId: PERSONAL_ORGANIZATION_ID,
        organizationName: "Organization",
        role: identityRole,
        deviceId: null,
        localBootstrap: true,
      },
      organizations: [{ organizationId: PERSONAL_ORGANIZATION_ID, name: "Organization", createdAt: 1 }],
      memberships: [],
      teams: [],
    };
  },
  updateMachine: async (_runnerId: string, body: { displayName: string }) => {
    if (!runner) throw new Error("runner not found");
    runner.displayName = body.displayName;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { ok: true as const };
  },
  selectHarnessInstallation: async (_runnerId: string, agentId: string, installationId: string) => {
    if (!runner) throw new Error("runner not found");
    const agent = runner.agents.find((candidate) => candidate.id === agentId);
    if (!agent?.installation || agent.installation.id !== installationId) throw new Error("installation not found");
    const selection = {
      family: agent.driver === "claude-code" ? "claude" as const : agent.driver === "pi" ? "pi" as const : "codex" as const,
      context: agent.context ?? { kind: "native" as const },
      installationId: agent.installation.id,
      path: agent.installation.path,
      via: agent.installation.via,
      version: agent.version,
      agentId,
    };
    runner.harnessSelections = [...(runner.harnessSelections ?? []).filter((item) =>
      item.family !== selection.family || JSON.stringify(item.context) !== JSON.stringify(selection.context)), selection];
    runner.agents = runner.agents.map((candidate) => ({ ...candidate,
      installation: candidate.installation ? { ...candidate.installation,
        selection: candidate.installation.id === selection.installationId ? "selected" as const : "other" as const } : undefined,
    }));
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { selection };
  },
  selectTargetHarnessInstallation: async (_runnerId: string, targetId: string, agentId: string, installationId: string) => {
    if (!runner) throw new Error("runner not found");
    const target = runner.executionTargets?.find((candidate) => candidate.id === targetId);
    const installation = target?.harnessInstallations?.find((candidate) =>
      candidate.agentId === agentId && candidate.id === installationId && candidate.available);
    if (!target || !installation) throw new Error("target installation not found");
    const selection = { targetId, targetName: target.name, agentId, installationId,
      path: installation.path, version: installation.version, available: true };
    runner.targetHarnessSelections = [...(runner.targetHarnessSelections ?? []).filter((item) =>
      !(item.targetId === targetId && item.agentId === agentId)), selection];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { selection };
  },
  updateMachineCapacity: async (_runnerId: string, body: { configuredUnits: number; expectedRevision: number }) => {
    if (!runner?.capacity) throw new Error("runner not found");
    if (failingSettingsSave === "capacity") throw new Error("The control plane could not reach its database. Try again.");
    if (body.expectedRevision !== runner.capacity.revision) throw new Error("Runner Capacity changed in another client");
    runner.capacity = {
      ...runner.capacity,
      configuredUnits: body.configuredUnits,
      revision: body.expectedRevision + 1,
      availableUnits: Math.max(0, body.configuredUnits - (runner.capacity.usedUnits ?? 0)),
      ...(runner.capacity.dimensions ? {
        dimensions: {
          ...runner.capacity.dimensions,
          residentProcessUnits: {
            used: runner.capacity.dimensions.residentProcessUnits.used,
            limit: body.configuredUnits,
            available: Math.max(0,
              body.configuredUnits - runner.capacity.dimensions.residentProcessUnits.used),
          },
        },
      } : {}),
    };
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { capacity: { configuredUnits: runner.capacity.configuredUnits, revision: runner.capacity.revision } };
  },
  updateMachineAutomaticAccountSwitching: async (
    _runnerId: string,
    body: { enabled: boolean; expectedRevision: number },
  ) => {
    if (!runner?.automaticAccountSwitching) throw new Error("runner not found");
    if (body.expectedRevision !== runner.automaticAccountSwitching.revision) {
      throw new Error("Automatic Account Switching changed in another client");
    }
    runner.automaticAccountSwitching = {
      enabled: body.enabled,
      revision: body.expectedRevision + 1,
    };
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { automaticAccountSwitching: structuredClone(runner.automaticAccountSwitching) };
  },
  updateMachineProviderAccountDefault: async (
    _runnerId: string,
    provider: "claude" | "codex",
    body: { accountId: string | null; expectedRevision: number },
  ) => {
    if (!runner) throw new Error("runner not found");
    const current = runner.providerAccountDefaults?.find((choice) => choice.provider === provider);
    if (body.expectedRevision !== (current?.revision ?? 0)) throw new Error("Default Provider Account changed in another client");
    if (body.accountId && !runner.providerAccounts?.some((account) =>
      account.provider === provider && account.id === body.accountId)) throw new Error("Account unavailable");
    const providerAccountDefault = {
      provider, accountId: body.accountId, revision: body.expectedRevision + 1,
    };
    runner.providerAccountDefaults = [
      ...(runner.providerAccountDefaults ?? []).filter((choice) => choice.provider !== provider),
      providerAccountDefault,
    ];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { providerAccountDefault };
  },
  listDirectory: async (_runnerId: string, path: string) => {
    if (!path) {
      return {
        path: "C:\\Users\\misko",
        parent: "C:\\Users",
        entries: [{ name: "repo", path: "C:\\Users\\misko\\repo", isDir: true }],
      };
    }
    return { path, parent: "C:\\Users\\misko", entries: [] };
  },
  registerMachineWorkspace: async (_runnerId: string, body: { name: string; path: string }) => {
    if (!runner) throw new Error("runner not found");
    lastRegisteredWorkspace = structuredClone(body);
    const workspace = { id: "registered-workspace", ...body };
    runner.workspaces.push(workspace);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { workspace };
  },
  startProviderLogin: async (
    _runnerId: string,
    body: { provider: "claude" | "codex"; label: string } | { accountId: string },
  ) => {
    if (!runner) throw new Error("runner not found");
    // Add Account's request failure (#2995): a label of "Unreachable" is refused as a timeout.
    if ("label" in body && body.label === "Unreachable") throw new ApiError("The runner did not answer in time.", 504);
    const existing = "accountId" in body
      ? runner.providerAccounts?.find((account) => account.id === body.accountId)
      : undefined;
    const provider = existing?.provider ?? ("provider" in body ? body.provider : "claude");
    const label = existing?.label ?? ("label" in body ? body.label : "Account");
    const accountId = existing?.id ?? `fixture-${provider}`;
    const login = {
      operationId: `login_fixture_${provider}`,
      accountId,
      label,
      provider,
      status: provider === "claude" ? "awaiting_code" as const : "waiting_for_provider" as const,
      expectsCode: provider === "claude",
      verificationUrl: provider === "claude"
        ? "https://claude.ai/oauth/authorize?fixture=machine"
        : "https://auth.openai.com/device",
      ...(provider === "codex" ? { userCode: "WOLL-IPOGS" } : {}),
      startedAt: Date.now(),
    };
    runner.providerLogins = [login];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login };
  },
  submitProviderLoginCode: async (_runnerId: string, operationId: string) => {
    if (!runner) throw new Error("runner not found");
    if (signInFixture === "rejected") {
      throw new ApiError("The provider rejected this code. Copy the whole code from the sign-in page and paste it again.", 409);
    }
    const login = runner.providerLogins?.find((candidate) => candidate.operationId === operationId);
    if (!login) throw new Error("login not found");
    const completed = { ...login, status: "succeeded" as const, expectsCode: false };
    runner.providerLogins = [completed];
    // The runner records a new account when its sign-in succeeds; Add Account's is a managed profile.
    if (!runner.providerAccounts?.some((account) => account.id === login.accountId)) {
      runner.providerAccounts = [...(runner.providerAccounts ?? []), {
        id: login.accountId, label: login.label, provider: login.provider, authStatus: "authenticated",
        profile: { id: `profile-${login.accountId}`, access: "granted" },
      }];
    }
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login: completed };
  },
  cancelProviderLogin: async (_runnerId: string, operationId: string) => {
    if (!runner) throw new Error("runner not found");
    const login = runner.providerLogins?.find((candidate) => candidate.operationId === operationId);
    if (!login) throw new Error("login not found");
    const cancelled = { ...login, status: "cancelled" as const, expectsCode: false };
    runner.providerLogins = [cancelled];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { login: cancelled };
  },
  // The control plane leaves a dismissed sign-in out of this person's snapshots (#2487).
  dismissProviderLoginNotice: async (_runnerId: string, operationId: string) => {
    if (!runner) throw new Error("runner not found");
    runner.providerLogins = runner.providerLogins?.filter((candidate) => candidate.operationId !== operationId);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { dismissed: true as const };
  },
  // Removal (#2995): Codex Solo is Custom ACP's default, so the runner refuses it. Current runners keep
  // the stored sign-in (#3157) and report it; Work stands in for an older runner that doesn't.
  removeProviderAccount: async (_runnerId: string, accountId: string) => {
    if (!runner) throw new Error("runner not found");
    if (accountId === "codex-solo") {
      throw new ApiError("Agent 'custom-acp' uses this account as its default in the runner configuration. " +
        "Change that setting before removing the account.", 409);
    }
    runner.providerAccounts = runner.providerAccounts?.filter((account) => account.id !== accountId);
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { removed: true as const, credentialsRetained: accountId !== "claude-work" };
  },
  // #3719, with `?credentialImport`: a label of "ChatGPT" is refused as an OAuth sign-in would be;
  // any other copy records a managed profile account.
  importProviderCredential: async (_runnerId: string, body: { provider: "codex"; label: string }) => {
    if (!runner) throw new Error("runner not found");
    if (body.label === "ChatGPT") {
      throw new ApiError("Only a Codex sign-in that uses an API key stored in auth.json can be copied. A ChatGPT sign-in, or one kept in the keyring, can't be shared safely; sign in instead.", 409, "SOURCE_UNSUPPORTED");
    }
    const accountId = `copied-${runner.providerAccounts?.length ?? 0}`;
    runner.providerAccounts = [...runner.providerAccounts ?? [],
      { id: accountId, label: body.label, provider: "codex", authStatus: "authenticated", profile: { id: `profile-${accountId}`, access: "granted" } }];
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { accountId, profileId: `profile-${accountId}`, grantId: `grant-${accountId}` };
  },
  // Provider profiles (#3239), with `?profiles`: adoption succeeds, and the first revocation of an
  // account with sessions is refused so the force confirmation can be exercised.
  adoptProviderProfile: async (_runnerId: string, accountId: string) => {
    const account = runner?.providerAccounts?.find((candidate) => candidate.id === accountId);
    if (!runner || !account) throw new Error("runner not found");
    account.profile = { id: account.profile?.id ?? `profile-${accountId}`, access: "granted" };
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { status: "active" as const, profileId: account.profile.id, grantId: `grant-${accountId}` };
  },
  revokeProviderProfileAccess: async (_runnerId: string, accountId: string, force = false) => {
    const account = runner?.providerAccounts?.find((candidate) => candidate.id === accountId);
    if (!runner || !account) throw new Error("runner not found");
    if (!force && accountId === "claude-work") {
      throw new ApiError("this provider profile has 3 active sessions", 409, "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS", {
        activeSessions: [
          { id: "s1", title: "Fix the half-cent rounding bug", status: "running" },
          { id: "s2", title: "Draft the release notes", status: "idle" },
        ],
        activeSessionCount: 3,
      });
    }
    delete account.profile;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
    return { revoked: true as const, grantIds: [`grant-${accountId}`], markerUpdated: true, runnerNotified: true, forced: force };
  },
  inspectProviderHomeLease: async (_runnerId: string, accountId: string) => leases[accountId] ?? { state: "released" },
  recoverProviderHomeLease: async (_runnerId: string, accountId: string, staleTipHash: string) => {
    if (leases[accountId]?.tipHash !== staleTipHash) throw new ApiError("lease changed", 409, "TIP_CHANGED");
    leases[accountId] = { state: "released" };
    return { status: "recovered" as const, authorizationId: "authorization-1" };
  },
  removeRunner: async () => {
    if (!runner) throw new Error("runner not found");
    const runnerId = runner.runnerId;
    runner = null;
    socket?.push({ type: "runner_removed", runnerId });
  },
  removeBox: async (boxId: string) => {
    box = null;
    socket?.push({ type: "box_removed", boxId });
  },
  // The machine's lifecycle actions (#2988). With `busy`, each refuses first for its active sessions.
  rediscover: async () => ({ ok: true as const }),
  reconnectBox: async (_boxId: string, force = false) => {
    if (busyMachine && !force) throw activeSessionsConflict();
    reconnectRequests += 1;
    if (reconnectOutcome === "fail") throw new TypeError("Failed to fetch");
    if (reconnectOutcome === "hold") await new Promise(() => {});
    return { ok: true as const };
  },
  updateBoxRunner: async (_boxId: string, force = false) => {
    if (busyMachine && !force) throw activeSessionsConflict();
    return { ok: true as const, status: "started" as const, expectedVersion: "0.43.0", source: "release-cache" as const,
      triple: "x86_64-pc-windows-msvc", releaseTag: "v0.43.0" };
  },
  adoptLegacyBoxData: async (_boxId: string, force = false) => {
    if (busyMachine && !force) throw activeSessionsConflict();
    return { ok: true as const, status: "started" as const };
  },
} as ApiClient;

declare global {
  interface Window {
    __WOLLIPOG_MACHINE_E2E__: {
      lastRegisteredWorkspace(): { name: string; path: string } | null;
      lastAddBoxRequest(): AddBoxRequest | null;
      /** How many Reconnect requests reached the fixture's API (#3525). */
      reconnectRequests(): number;
      /** status 0 is a request that never reached the server (the browser's TypeError). */
      setAddBoxOutcome(outcome: { kind: "accept" } | { kind: "refuse"; message: string; status: number } | { kind: "hold" }): void;
      setAgentAvailabilityScenario(scenario: "legacy-unverified" | "verified-unavailable" |
        "multiple-installations" | "harness-states" | "harness-states-ssh" |
        "target-installations" | "batch-wrapper" | "extensionless-batch-wrapper" | "dotted-batch-wrapper" |
        "explicit-interpreter" | "older-interpreter-guidance" | "agent-states" | "ownership-before" | "ownership-blocked" |
        "selected-installation-unavailable" | "ssh-installations"): void;
      /** Fails every save of this Machine Settings field until called with null (#2991). */
      setSettingsSaveFailure(field: "capacity" | null): void;
      setRunnerStatus(status: RunnerView["status"]): void;
      /** A host name long enough that the detail's meta line has to truncate (#2988). */
      setRunnerHostname(hostname: string): void;
      restoreIdentity(): void;
      /** Drops the connection and keeps it down: the list shows its last-known rows (#2985). */
      disconnect(): void;
    };
  }
}

window.__WOLLIPOG_MACHINE_E2E__ = {
  lastRegisteredWorkspace: () => structuredClone(lastRegisteredWorkspace),
  lastAddBoxRequest: () => structuredClone(lastAddBoxRequest),
  reconnectRequests: () => reconnectRequests,
  setAddBoxOutcome: (outcome) => { addBoxOutcome = outcome; },
  setAgentAvailabilityScenario: (scenario) => {
    if (!runner) return;
    if (scenario === "ownership-before" || scenario === "ownership-blocked") {
      runner.os = "linux";
      const before = scenario === "ownership-before";
      const failure = { code: "probe_failed" as const, retryable: true,
        message: "Provider HOME ownership blocked discovery. The previous provider process cannot be inspected safely. Preserve the lease and retry after the previous owner exits." };
      runner.harnessSelections = [];
      runner.agents = [
        { id: "claude", name: "Claude Code", command: "/opt/claude", args: [], env: {}, available: false,
          driver: "claude-code", context: { kind: "native" }, source: "discovered", unavailableReason: failure.message,
          installation: { id: "claude", path: "/opt/claude", via: "path", selection: "selected" },
          claudeCode: { status: before ? "unavailable" : "unsupported", failure: before ? { code: "claude_unavailable", message: "Claude Code was not found." } : failure,
            effortLevels: [], permissionModes: [], streamJsonInput: false, streamJsonImages: false,
            controlProtocol: false, forkSession: false, replayUserMessages: false, auth: { status: "unknown", billingSource: "unknown" } } },
        { id: "codex", name: "Codex App Server", command: "/opt/codex", args: [], env: {}, available: false,
          driver: "codex-app-server", context: { kind: "native" }, source: "discovered", unavailableReason: failure.message,
          installation: { id: "codex", path: "/opt/codex", via: "path", selection: "selected" },
          codexAppServer: { status: before ? "unavailable" : "unsupported", appServerAvailable: false,
            failure: before ? { code: "codex_unavailable", message: "Codex was not found." } : failure } },
      ];
    } else if (scenario === "legacy-unverified") {
      runner.protocolVersion = 153;
      runner.agents = [{
        id: "legacy-acp",
        name: "Legacy Unverified ACP",
        command: "legacy-acp",
        args: [],
        env: {},
        driver: "acp",
        context: { kind: "native" },
        source: "config",
      }];
    } else if (scenario === "target-installations") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.agents = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
        driver: "codex-app-server", context: { kind: "native" }, available: true }];
      const image = `example/agent@sha256:${"a".repeat(64)}`;
      const target = (id: string, name: string, installationId: string, path: string) => ({
        id: `runner:${runner!.runnerId}:container:${id}`, runnerId: runner!.runnerId, name,
        kind: "container" as const, adapter: "container" as const, workspaceStrategy: "worktree" as const,
        boundaries: { filesystem: "container" as const, network: "deny" as const,
          secrets: "none" as const, billing: "none" as const },
        environment: { id, revision: 1, image, setupCheckDigest: "b".repeat(64) },
        compatibleAgentIds: ["codex"], available: true,
        harnessInstallations: [{ agentId: "codex", id: installationId, path, version: "1.2.3",
          provenance: "container-image" as const,
          authentication: id === "alpha" ? "authenticated" as const : "unknown" as const,
          ...(id === "alpha" ? { authenticationEvidence: "codex-login-status" as const } : {}),
          capability: id === "alpha" ? "verified" as const : "unknown" as const,
          ...(id === "alpha" ? { capabilityEvidence: "codex-app-server-help" as const } : {}),
          available: true }],
      });
      runner.executionTargets = [target("alpha", "Alpha Image", "a".repeat(24), "/usr/bin/codex"),
        target("beta", "Beta Image", "b".repeat(24), "/usr/bin/codex")];
      runner.targetHarnessSelections = [{ targetId: runner.executionTargets[0]!.id, targetName: "Alpha Image",
        agentId: "codex", installationId: "a".repeat(24), path: "/usr/bin/codex",
        version: "1.2.3", available: true }];
    } else if (scenario === "multiple-installations") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.agents = [
        {
          id: "codex",
          name: "Codex",
          command: "/usr/bin/codex",
          args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
          source: "discovered", available: true, authStatus: "authenticated", version: "0.199.0",
          installation: { id: "system", path: "/usr/bin/codex", via: "path", selection: "selected" },
          update: { status: "update_available", installedVersion: "0.199.0",
            latestKnownCompatibleVersion: "0.199.0", latestPublishedVersion: "0.210.0",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable",
            evidenceSource: "npm dist-tags for @openai/codex", managedExternally: true,
            guidance: "A newer release is published, but compatibility with this Machine has not been verified. This launch target is inside the @openai/codex package tree. Use the package or version manager that installed this exact copy in the same execution context. Stop sessions using this executable before upgrading. Restart and Rediscover before treating the new version as ready." },
        },
        {
          id: "codex-installation-local", name: "Codex",
          command: "/home/example/.local/bin/codex",
          args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
          source: "discovered", available: true, authStatus: "authenticated", version: "0.210.0",
          installation: { id: "local", path: "/home/example/.local/bin/codex", via: "common-dir", selection: "other" },
          update: { status: "managed_externally", installedVersion: "0.210.0",
            latestKnownCompatibleVersion: "0.210.0",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable",
            evidenceSource: "Executable installation provenance", managedExternally: true,
            guidance: "This installation advertises its built-in `codex update` command. Run `'/home/example/.local/bin/codex' 'update'` in a POSIX shell on this Machine after stopping sessions using this executable. A bare `codex` on PATH may be another installation. Restart and Rediscover before treating the new version as ready." },
        },
      ];
      runner.harnessSelections = [{ family: "codex", context: { kind: "native" },
        installationId: "system", path: "/usr/bin/codex", via: "path", version: "0.199.0", agentId: "codex" }];
    } else if (scenario === "batch-wrapper" || scenario === "extensionless-batch-wrapper" ||
      scenario === "dotted-batch-wrapper" || scenario === "explicit-interpreter" ||
      scenario === "older-interpreter-guidance") {
      runner.protocolVersion = scenario === "older-interpreter-guidance" ? 179 : PROTOCOL_VERSION;
      const interpreter = scenario === "explicit-interpreter" || scenario === "older-interpreter-guidance";
      runner.agents = [{
        id: "batch-codex", name: interpreter ? "Interpreter Codex" : "Batch Codex",
        command: interpreter ? "C:\\Windows\\System32\\cmd.exe" : scenario === "batch-wrapper"
          ? "C:\\Program Files\\Codex Tools\\codex.cmd" : scenario === "dotted-batch-wrapper"
            ? "codex.v2" : "codex",
        args: interpreter ? ["/d", "/c", "echo", "%PATH%"]
          : ["--profile", 'Team "Research"', "%PATH%"], env: {}, driver: "codex-app-server",
        context: { kind: "native" }, source: "discovered", available: true,
        installation: { id: "batch", path: interpreter ? "C:\\Windows\\System32\\cmd.exe" : scenario === "dotted-batch-wrapper"
          ? "C:\\Program Files\\Codex Tools\\codex.v2.cmd" : "C:\\Program Files\\Codex Tools\\codex.cmd", via: "path" },
        update: { status: "managed_externally", checkedAt: Date.UTC(2026, 8, 22),
          channel: "unknown", evidenceSource: "Executable installation provenance", managedExternally: true,
          guidance: scenario === "older-interpreter-guidance"
            ? "This installation advertises its built-in `codex update` command. Run `& 'C:\\Windows\\System32\\cmd.exe' '/d' '/c' 'echo' '%PATH%' 'update'` in PowerShell 7.3 or later on this Machine after stopping sessions. Restart and Rediscover before treating the new version as ready."
            : scenario === "explicit-interpreter"
            ? "This launch uses PowerShell legacy argument passing. Use the package or version manager that installed this exact copy."
            : "This installation uses a Windows batch wrapper. Use the package or version manager that installed this exact copy." },
      }];
      runner.harnessSelections = [];
    } else if (scenario === "selected-installation-unavailable") {
      // The Machine's chosen Codex fails its check while another installation works (#2990).
      runner.protocolVersion = PROTOCOL_VERSION;
      const codex = (id: string, path: string, version: string, selection: "selected" | "other"): RunnerView["agents"][number] => ({
        id, name: "Codex", command: path, args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
        source: "discovered", authStatus: "authenticated", version,
        installation: { id, path, via: "path", selection },
        ...(selection === "selected"
          ? { available: false, codexAppServer: { status: "unsupported" as const, appServerAvailable: false,
              failure: { code: "probe_failed" as const, message: "Codex exited before it answered the check." } } }
          : { available: true, codexAppServer: { status: "supported" as const, appServerAvailable: true } }),
      });
      runner.agents = [
        codex("codex-broken", "C:\\Broken\\codex.exe", "0.155.1", "selected"),
        codex("codex-working", "C:\\Program Files\\Codex\\codex.exe", "0.160.0", "other"),
      ];
      runner.harnessSelections = [{ family: "codex", context: { kind: "native" }, installationId: "codex-broken",
        path: "C:\\Broken\\codex.exe", via: "path", version: "0.155.1", agentId: "codex-broken" }];
    } else if (scenario === "agent-states") {
      // One agent in each status the Agents section shows (#2990), and three that are not installed.
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.harnessSelections = [];
      const discovered = { args: [], env: {}, context: { kind: "native" as const }, source: "discovered" as const };
      const claudeCode = (status: "ready" | "unavailable"): NonNullable<RunnerView["agents"][number]["claudeCode"]> => ({
        status, effortLevels: [], permissionModes: [], streamJsonInput: status === "ready", streamJsonImages: status === "ready",
        controlProtocol: status === "ready", forkSession: status === "ready", replayUserMessages: status === "ready",
        auth: status === "ready" ? { status: "authenticated", billingSource: "subscription" } : { status: "unknown", billingSource: "unknown" },
        ...(status === "unavailable"
          ? { failure: { code: "claude_unavailable" as const, message: "Claude Code was not found in this runner context." } }
          : {}),
      });
      const registry = (id: string, adapterVersion: string, installStatus: "approval-required" | "approved") => ({
        id, schemaVersion: "1", adapterVersion, description: `${id === "gemini" ? "Google" : "Block"}'s open-source coding agent`,
        transport: "stdio" as const, distribution: "npx" as const,
        installPreview: id === "gemini" ? `npx --yes @google/gemini-cli@${adapterVersion} --experimental-acp` : `npx --yes goose-acp@${adapterVersion}`,
        installStatus, authentication: "required-live-verification" as const,
      });
      const missing: RunnerView["agents"] = [
        { ...discovered, id: "claude-wsl", name: "Claude Code", command: "claude", driver: "claude-code",
          context: { kind: "wsl", distro: "Ubuntu" }, available: false, claudeCode: claudeCode("unavailable") },
        { ...discovered, id: "codex-wsl", name: "Codex", command: "codex", driver: "codex-app-server",
          context: { kind: "wsl", distro: "Ubuntu" }, available: false,
          codexAppServer: { status: "unavailable", appServerAvailable: false,
            failure: { code: "codex_unavailable", message: "Codex is not installed in this runner context.", retryable: false } } },
        { ...discovered, id: "pi", name: "Pi", command: "pi", driver: "pi", available: false,
          unavailableReason: "Pi is not installed. Install @earendil-works/pi-coding-agent, then rediscover." },
      ];
      runner.agents = [
        { ...discovered, id: "claude", name: "Claude Code", command: "C:\\Users\\example\\.local\\bin\\claude.exe",
          driver: "claude-code", available: true, authStatus: "authenticated", version: "2.1.4", claudeCode: claudeCode("ready"),
          installation: { id: "claude-local", path: "C:\\Users\\example\\.local\\bin\\claude.exe", via: "common-dir" },
          update: { status: "up_to_date", installedVersion: "2.1.4", latestKnownCompatibleVersion: "2.1.4",
            latestPublishedVersion: "2.1.4", checkedAt: Date.now() - 2 * 3_600_000, channel: "stable",
            evidenceSource: "npm dist-tags for @anthropic-ai/claude-code", managedExternally: true,
            guidance: "This installation is up to date." } },
        { ...discovered, id: "codex", name: "Codex", command: "C:\\Program Files\\Codex\\codex.exe", driver: "codex-app-server",
          available: true, authStatus: "unauthenticated", version: "0.155.1",
          installation: { id: "codex-current", path: "C:\\Program Files\\Codex\\codex.exe", via: "path" },
          codexAppServer: { status: "supported", appServerAvailable: true } },
        { ...discovered, id: "codex-old", name: "Codex", command: "C:\\Legacy Tools\\codex.exe", driver: "codex-app-server",
          available: false, authStatus: "authenticated", version: "0.140.0",
          installation: { id: "codex-old", path: "C:\\Legacy Tools\\codex.exe", via: "path" },
          codexAppServer: { status: "unsupported", installedVersion: "0.140.0", appServerAvailable: true,
            failure: { code: "version_unverified", message: "Codex 0.140.0 is older than the supported version 0.147.0.", retryable: false } } },
        { ...discovered, id: "gemini", name: "Gemini CLI", command: "npx", source: "registry", driver: "acp", available: false,
          registry: registry("gemini", "1.2.0", "approval-required") },
        { ...discovered, id: "goose", name: "Goose", command: "npx", source: "registry", driver: "acp", available: true,
          authStatus: "authenticated", registry: registry("goose", "1.8.0", "approved") },
        ...missing,
      ];
    } else if (scenario === "ssh-installations") {
      // An SSH machine with two Codex installations and a Claude Code choice it no longer finds (#2991).
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.os = "linux";
      runner.agents = [
        { id: "codex", name: "Codex", command: "/usr/local/bin/codex", args: [], env: {}, driver: "codex-app-server",
          context: { kind: "native" }, source: "discovered", available: true, authStatus: "authenticated", version: "0.155.1",
          installation: { id: "system", path: "/usr/local/bin/codex", via: "path", selection: "selected" } },
        { id: "codex-local", name: "Codex", command: "/home/misko/.local/bin/codex", args: [], env: {}, driver: "codex-app-server",
          context: { kind: "native" }, source: "discovered", available: false, authStatus: "unauthenticated", version: "0.150.0",
          installation: { id: "local", path: "/home/misko/.local/bin/codex", via: "common-dir", selection: "other" } },
        { id: "claude", name: "Claude Code", command: "/usr/local/bin/claude", args: [], env: {}, driver: "claude-code",
          context: { kind: "native" }, source: "discovered", available: true, authStatus: "authenticated", version: "2.1.4",
          installation: { id: "claude-path", path: "/usr/local/bin/claude", via: "path" } },
      ];
      runner.harnessSelections = [
        { family: "codex", context: { kind: "native" }, installationId: "system", path: "/usr/local/bin/codex",
          via: "path", version: "0.155.1", agentId: "codex" },
        { family: "claude", context: { kind: "native" }, installationId: "old-claude", path: "/opt/claude/bin/claude",
          via: "common-dir", version: "2.0.1", agentId: null },
      ];
    } else if (scenario === "harness-states" || scenario === "harness-states-ssh") {
      runner.protocolVersion = PROTOCOL_VERSION;
      runner.hostname = "demo-workstation";
      runner.workspaces = [{ id: "demo", name: "Demo", path: "C:\\Users\\example" }];
      const legacyCodex: RunnerView["agents"][number] = {
        id: "legacy-codex", name: "Legacy Codex", command: "C:\\Legacy Tools\\codex.exe",
        args: [], env: {}, driver: "codex-app-server", context: { kind: "native" }, source: "discovered",
        available: false, authStatus: "authenticated", version: "0.140.0",
        installation: { id: "legacy", path: "C:\\Legacy Tools\\codex.exe", via: "path" },
        codexAppServer: { status: "unsupported", installedVersion: "0.140.0", appServerAvailable: true,
          failure: { code: "version_unverified", message: "Codex 0.140.0 is older than the supported version 0.147.0. Update Codex, then rediscover.", retryable: false } },
        update: { status: "update_available", installedVersion: "0.140.0", latestPublishedVersion: "0.210.0",
          checkedAt: Date.UTC(2026, 8, 22), channel: "stable", evidenceSource: "npm dist-tags for @openai/codex",
          managedExternally: true,
          guidance: "A newer release is published, but compatibility with this Machine has not been verified. Use the package or version manager that installed this exact copy in the same execution context. Stop sessions using this executable before upgrading. Restart and Rediscover before treating the new version as ready." },
      };
      runner.agents = [
        {
          id: "pinned-codex", name: "Pinned Codex", command: "C:\\Program Files\\Codex Tools\\codex.exe",
          args: ["--profile", "Team's Profile"], env: {}, driver: "codex-app-server",
          context: { kind: "native" }, source: "discovered", available: true, version: "0.155.1",
          installation: { id: "pinned", path: "C:\\Program Files\\Codex Tools\\codex.exe", via: "path" },
          update: { status: "managed_externally", installedVersion: "0.155.1", latestKnownCompatibleVersion: "0.155.1",
            checkedAt: Date.UTC(2026, 8, 22), channel: "stable", evidenceSource: "Machine pinned-version policy",
            managedExternally: true, guidance: "This harness installation is pinned by Machine policy. Release checks are suppressed, so no current release status was established. Ask the Machine operator to change the pin before planning an upgrade." },
        },
        {
          id: "policy-claude", name: "Policy Claude", command: "C:\\Tools\\Claude\\claude.exe",
          args: [], env: {}, driver: "claude-code", context: { kind: "native" }, source: "discovered",
          available: true, version: "1.2.3", installation: { id: "policy", path: "C:\\Tools\\Claude\\claude.exe", via: "path" },
          update: { status: "managed_externally", installedVersion: "1.2.3", checkedAt: Date.UTC(2026, 8, 22),
            channel: "stable", evidenceSource: "Machine update-check policy", managedExternally: true,
            guidance: "Release checks are disabled by this Machine's policy. Ask the Machine operator whether manual upgrades are permitted." },
        },
        {
          id: "failed-pi", name: "Failed Pi", command: "C:\\Tools\\Pi\\pi.exe",
          args: [], env: {}, driver: "pi", context: { kind: "native" }, source: "discovered",
          available: true, version: "0.8.0", installation: { id: "failed", path: "C:\\Tools\\Pi\\pi.exe", via: "path" },
          update: { status: "check_failed", installedVersion: "0.8.0", checkedAt: Date.UTC(2026, 8, 22),
            channel: "stable", evidenceSource: "npm dist-tags for @earendil-works/pi-coding-agent", managedExternally: true,
            guidance: "The release check could not complete, so no current release status was established. The Machine may be offline, behind a proxy, or rate limited. After resolving the problem, have an organization owner or admin rediscover this installation in Connections. Select Rediscover for a native Machine, or Reconnect for an SSH Machine after active sessions finish." },
        },
        legacyCodex,
        { ...legacyCodex, id: "legacy-codex-exec", name: "Legacy Codex (Non-Interactive)", driver: "codex", available: true },
      ];
      runner.harnessSelections = [];
    } else {
      runner.protocolVersion = 154;
      runner.agents = [{
        id: "missing-acp",
        name: "Missing ACP",
        command: "missing-acp",
        args: [],
        env: {},
        driver: "acp",
        context: { kind: "native" },
        source: "config",
        available: false,
        unavailableReason: "The configured command was not found or could not be started in this execution context.",
      }];
    }
    if (scenario === "harness-states-ssh" || scenario === "ssh-installations") {
      box = { boxId: "demo-box", runnerId: runner.runnerId, displayName: "Design Workstation",
        sshTarget: "demo-workstation", status: "online", lastError: null, createdAt: 1 };
      socket?.push({ type: "box_upsert", box: structuredClone(box) });
    }
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
  setSettingsSaveFailure: (field) => { failingSettingsSave = field; },
  setRunnerStatus: (status) => {
    if (!runner) return;
    runner.status = status;
    // An offline machine says when it was last seen (#2988): a few minutes ago, as a real one would.
    if (status === "offline") runner.lastSeen = Date.now() - 4 * 60_000;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
  setRunnerHostname: (hostname) => {
    if (!runner) return;
    runner.hostname = hostname;
    socket?.push({ type: "runner_upsert", runner: structuredClone(runner) });
  },
  restoreIdentity: () => { identityFails = false; },
  disconnect: () => {
    connectionHeld = true;
    socket?.onclose?.({ code: 1006 });
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <InstanceScopeProvider instanceScope="machine-management-e2e">
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            {/* The app's main column: its height for the fill page, and the `app` size container
                the compact tier answers to (#2985). */}
            <div className="app">
              <main className="main">
                <div className="main-body">
                  <RunnersView />
                </div>
              </main>
            </div>
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  </React.StrictMode>,
);
