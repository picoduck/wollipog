import React from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  PROTOCOL_VERSION,
  type AgentHarnessDefaultsView,
  type OrchestratorSettingsView,
  type CreateSessionRequest,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  type UiSnapshotMessage,
  type WorkflowDefinition,
} from "@wollipog/protocol";
import { saveAgentDefault } from "../agent-defaults.js";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { NewRunDialog } from "../components/NewRunDialog.js";
import { NewSessionDialog } from "../components/NewSessionDialog.js";
import { Select } from "../components/ui/ChoiceControls.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The REAL New Session dialog, so there is no second description of its hierarchy to drift.
 *
 * #832 was a layout defect: the Permission Preset menu asked for 76px while the coarse-pointer
 * stylesheet drew 98px of touch targets inside it, clipping the second of two options. Nothing in
 * a jsdom suite can see that — happy-dom has no layout engine, so every box is zero — and nothing
 * in the stylesheet's own tests can either, because the disagreement was between a CSS rule and a
 * number in TypeScript.
 *
 * Mounting the primitives standalone would not have been enough for the reason `settings-rows`
 * records: a rule scoped to a wrapper the fixture omitted would break production while the fixture
 * stayed green. So this imports the dialog the app renders, and supplies only what the shell holds
 * state for — the snapshot and the saved harness defaults.
 */

const fixtureParams = new URLSearchParams(window.location.search);

/** The runner decides which presets are offered, which is the whole subject of the spec. */
const orchestratorCapable = fixtureParams.get("orchestrator") !== "0";

/**
 * #2955: the saved Orchestrator defaults the policy row and the Orchestrator Policy dialog start
 * from. `?policy=1` answers with defaults that execute approved follow-ups and two child harnesses;
 * `?policy=error` fails the request the way a dropped connection does. Without it the request goes
 * to the network, as the Full Control spec intercepts it.
 */
const policyFixture = fixtureParams.get("policy");
const policyView: OrchestratorSettingsView = {
  defaults: {
    ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS),
    behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, maximumConcurrentChildren: 6, followUps: "execute_approved" },
  },
  source: "user_default",
  controlModeSupported: true,
  capabilities: {
    harnesses: [
      {
        agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude Code",
        models: [{ id: "claude-opus", displayName: "Claude Opus", efforts: ["high", "medium"] }], effortLevels: ["high", "medium"],
        supportedPairs: [{ modelId: "claude-opus", effortLevels: ["high", "medium"] }], installations: 1,
      },
      {
        agentId: "codex", driver: "codex-app-server", context: { kind: "native" }, name: "Codex App Server",
        models: [{ id: "gpt-sol", displayName: "GPT Sol", efforts: ["high"] }], effortLevels: ["high"],
        supportedPairs: [{ modelId: "gpt-sol", effortLevels: ["high"] }], installations: 1,
      },
    ],
    models: [{ id: "claude-opus", displayName: "Claude Opus", efforts: ["high", "medium"] }, { id: "gpt-sol", displayName: "GPT Sol", efforts: ["high"] }],
    effortLevels: ["high", "medium"], installations: 2, compatibleInstallations: 2, status: "available",
  },
};

/** #1648: accounts people named after their email, which the picker must mask by default. */
const emailAccounts = fixtureParams.get("emailAccounts") === "1";

/** #1695: host and container execution targets, so target-specific copy can be inspected. */
const containerTargets = fixtureParams.get("containerTargets") === "1";

/** #2954: a cloud target with a budget policy, beside the host and container targets. */
const cloudTargets = fixtureParams.get("cloudTargets") === "1";

/**
 * #1360: an available ACP agent (machine-management-main.tsx's fixture shape), so the ACP-specific
 * New Session copy has browser coverage. It offers the Orchestrator preset, and its workspace grants
 * the Extra Folders an ACP agent may also use. `?savedAgent=gemini` makes it the chosen agent.
 */
const acpAgent = fixtureParams.get("acp") === "1";

/**
 * #2365: the saved permission defaults' three states under Session Role. `error` shows the field's
 * `span.form-error`, `pending` its "Loading…" `span.muted`, and `orchestrator` the `span.muted` that
 * names a saved Orchestrator default.
 */
const savedDefaults = fixtureParams.get("defaults");

/**
 * #2365: `?dialog=run` mounts the real New Multi-Agent Run dialog on the same snapshot, plus three
 * Projects whose Location field shows each of its notes: no Locations, none available, and two to
 * choose between.
 */
const runDialog = fixtureParams.get("dialog") === "run";

/**
 * #3224: `?codexDiscovery=1` gives the Codex rows the shape discovery reports, so the exec row is
 * the restart-only one rather than a configured agent. `?appServerCheck=timeout` makes App Server's
 * check time out, and `?savedAgent=<id>` saves that agent as this runner's New Session default.
 */
const codexDiscovery = fixtureParams.get("codexDiscovery") === "1";
const appServerCheckTimedOut = fixtureParams.get("appServerCheck") === "timeout";
const savedAgent = fixtureParams.get("savedAgent");
/**
 * #2953: `?agentSetup=1` adds two agents that need setup (Gemini, not installed; OpenCode, signed
 * out) beside the three that can start, on a machine named Studio Workstation. `?noPreset=1` opens
 * New Session with nothing chosen, so Agent waits for a location.
 */
const agentSetup = fixtureParams.get("agentSetup") === "1";
const noPreset = fixtureParams.get("noPreset") === "1";
if (savedAgent) saveAgentDefault({}, "runner-1", savedAgent);

/**
 * #2955: a current control plane and a single account, the plain state New Session's 700px budget is
 * measured in. `?role=1` takes the Orchestrator role, `?nativeTui=1` launches Native TUI, and
 * `?oneAccount=1` leaves only Work, so New Session draws no Account field.
 */
const currentRole = fixtureParams.get("role") === "1";
const currentNativeTui = fixtureParams.get("nativeTui") === "1";
const oneAccount = fixtureParams.get("oneAccount") === "1";

/** `?theme=light|dark` pins the theme; without it the page keeps the app's own default. */
const fixtureTheme = fixtureParams.get("theme");
if (fixtureTheme === "light" || fixtureTheme === "dark") document.documentElement.setAttribute("data-theme", fixtureTheme);

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "fixture-runner",
  ...(agentSetup ? { displayName: "Studio Workstation" } : {}),
  os: "linux",
  version: "1",
  status: "online",
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      defaultProviderAccountId: "claude-work",
      available: true,
      capabilities: {
        models: [],
        effortLevels: [],
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: true,
        permissionModes: orchestratorCapable ? ["default", "orchestrator"] : ["default"],
      },
    },
    {
      id: "codex-app",
      name: "Codex",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      available: fixtureParams.get("agentUnavailable") !== "1" && !appServerCheckTimedOut,
      authStatus: fixtureParams.get("agentUnavailable") === "1" ? "unauthenticated" : undefined,
      ...(codexDiscovery ? { source: "discovered" as const } : {}),
      ...(appServerCheckTimedOut ? { codexAppServer: {
        status: "unsupported" as const,
        appServerAvailable: false,
        failure: {
          code: "probe_timeout" as const,
          message: "Wollipog couldn't check this Codex installation in time. Rediscover to try again.",
          retryable: true,
        },
      } } : {}),
    },
    {
      id: "codex-exec",
      name: "Codex",
      command: "codex",
      args: ["exec"],
      env: {},
      driver: "codex",
      available: true,
      ...(codexDiscovery ? { source: "discovered" as const } : {}),
    },
    {
      id: "pi",
      name: "Pi",
      command: "pi",
      args: [],
      env: {},
      driver: "pi",
      available: true,
      authStatus: "authenticated",
      capabilities: {
        models: [{ id: "anthropic/sonnet", displayName: "Sonnet", default: true, efforts: ["off", "high"] }],
        effortLevels: ["off", "high"],
        slashCommands: [{ name: "skill:review", description: "Review code", source: "user" }],
        supportsImages: true,
        supportsApprovals: false,
        supportsSteering: true,
        permissionModes: [],
      },
    },
    ...(agentSetup ? [
      { id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp" as const, available: false },
      {
        id: "opencode", name: "OpenCode", command: "opencode", args: [], env: {}, driver: "acp" as const,
        available: false, authStatus: "unauthenticated" as const,
      },
    ] : []),
    ...(acpAgent ? [{
      id: "gemini",
      name: "Gemini",
      command: "gemini",
      args: ["--experimental-acp"],
      env: {},
      driver: "acp" as const,
      context: { kind: "native" as const },
      source: "config" as const,
      available: true,
      authStatus: "authenticated" as const,
      capabilities: {
        models: [],
        effortLevels: [],
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: true,
        permissionModes: ["default", "orchestrator"],
      },
      acp: { logout: false, loadSession: false, sessionList: false, sessionDelete: false, sessionResume: false, sessionClose: false },
    }] : []),
  ],
  providerAccounts: [
    {
      id: "claude-work",
      label: emailAccounts ? "work.me@example.com" : "Work",
      provider: "claude",
      authStatus: "authenticated",
    },
    ...(oneAccount ? [] : [{
      id: "claude-personal",
      label: emailAccounts ? "work.me@example.org" : "Personal",
      provider: "claude" as const,
      authStatus: "unauthenticated" as const,
    }]),
  ],
  workspaces: [{
    id: "workspace-1",
    name: "Wollipog",
    path: "/repos/wollipog",
    ...(acpAgent ? { additionalDirectoryGrants: ["/shared/reference-docs", "/shared/design-assets"] } : {}),
  }],
  // A bubblewrap runner, as an ACP Orchestrator's Strict Project Isolation needs.
  ...(acpAgent ? { runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
    executionIsolation: { mode: "bwrap" as const, network: "inherit" as const } } } : {}),
  connectedAt: 1,
  lastSeen: 1,
  // A current runner, so `sessionOrchestration` is advertised and the Orchestrator preset is a real
  // choice rather than a disabled card. The disabled path is covered by `?orchestrator=0`.
  protocolVersion: PROTOCOL_VERSION,
  // An ACP agent's Extra Folders are offered on a host target, so its fixture advertises the two.
  ...(containerTargets || cloudTargets || acpAgent ? {
    executionTargets: [
      {
        id: "host-in-place", runnerId: "runner-1", name: "Runner Host · in place",
        kind: "local", workspaceStrategy: "in_place", adapter: "host",
        boundaries: { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      {
        id: "host-worktree", runnerId: "runner-1", name: "Runner Host · worktree",
        kind: "local", workspaceStrategy: "worktree", adapter: "host",
        boundaries: { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      ...(containerTargets || cloudTargets ? [{
        id: "container", runnerId: "runner-1", name: "Offline Container",
        kind: "container" as const, workspaceStrategy: "worktree" as const, adapter: "container" as const,
        boundaries: { filesystem: "container" as const, network: "deny" as const, secrets: "none" as const, billing: "none" as const },
        available: true,
      }] : []),
      ...(cloudTargets ? [{
        id: "cloud", runnerId: "runner-1", name: "Cloud Sandbox",
        kind: "cloud" as const, workspaceStrategy: "snapshot" as const, adapter: "cloud" as const,
        boundaries: { filesystem: "snapshot" as const, network: "policy" as const, secrets: "references" as const, billing: "target_metered" as const },
        policy: {
          cost: { currency: "USD" as const, estimatedHourlyRateUsd: 0.4, minimumBudgetUsd: 1, maximumBudgetUsd: 50 },
          admission: { maxConcurrentSessions: 2, queue: "fifo" as const },
        },
        available: true,
      }] : []),
    ],
  } satisfies Partial<RunnerView> : {}),
};

function fixtureLocation(
  projectId: string,
  id: string,
  overrides: Partial<ProjectLocationView> = {},
): ProjectLocationView {
  return {
    id,
    projectId,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Wollipog",
    path: "/repos/wollipog",
    source: "managed",
    availability: "available",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixtureProject(id: string, name: string, locations: ProjectLocationView[]): ProjectView {
  return {
    id,
    name,
    hidden: false,
    locations,
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

const project = fixtureProject("project-1", "Wollipog", [fixtureLocation("project-1", "location-1")]);

const runProjects: ProjectView[] = runDialog ? [
  fixtureProject("project-empty", "No Locations Yet", []),
  fixtureProject("project-offline", "Offline Location", [
    fixtureLocation("project-offline", "location-offline", { availability: "runner_offline" }),
  ]),
  fixtureProject("project-two", "Two Locations", [
    fixtureLocation("project-two", "location-two-a", { isDefault: false }),
    fixtureLocation("project-two", "location-two-b", { isDefault: false, name: "Docs", path: "/repos/docs" }),
  ]),
] : [];

const snapshot: UiSnapshotMessage = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: true,
    // The saved Orchestrator default's note appears only when the control plane takes the role.
    ...(savedDefaults === "orchestrator" || currentRole ? { orchestratorRole: true } : {}),
    ...(currentNativeTui ? { nativeTuiLaunch: true } : {}),
  },
  runners: [runner],
  boxes: [],
  projects: [project, ...runProjects],
  sessions: [],
  runs: [],
  pods: [],
};

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "new-session-choices-e2e",
  runtimeKey: "new-session-choices-e2e:1",
  createSocket: () => new FakeSocket(),
  close() {},
};

// `openedView=1` lets a spec observe where a successful creation navigated.
const openedSessionListeners = new Set<(id: string) => void>();
const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push(view) {
    if (fixtureParams.get("openedView") === "1" && view.name === "session") openedSessionListeners.forEach((listener) => listener(view.id));
  },
  listen: () => () => {},
};

const defaults: AgentHarnessDefaultsView = {
  defaults: savedDefaults === "orchestrator" ? [{
    agentId: "claude",
    driver: "claude-code",
    context: { kind: "native" },
    name: "Claude Code",
    installations: [],
    compatibleInstallations: 1,
    preference: { permissionMode: "orchestrator" },
  }] : [],
};

const client = {
  ...api,
  agentHarnessDefaults: () => savedDefaults === "error"
    ? Promise.reject(new Error("Saved defaults are unavailable."))
    : savedDefaults === "pending" ? new Promise<AgentHarnessDefaultsView>(() => undefined) : Promise.resolve(defaults),
  workflowDefinitions: async (): Promise<WorkflowDefinition[]> => [],
  ...(policyFixture ? {
    orchestratorSettings: () => policyFixture === "error"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(structuredClone(policyView)),
  } : {}),
  // The skills assigned to Claude Code on this machine, which a container or cloud target can't see.
  runnerSkills: async () => ({
    desired: [
      { name: "review-pr", versionDigest: "a", targets: [{ agentId: "claude" }] },
      { name: "release-notes", versionDigest: "b", targets: [{ agentId: "claude" }] },
    ],
    reported: null,
  }) as Awaited<ReturnType<ApiClient["runnerSkills"]>>,
  createSession: async (request: CreateSessionRequest) => {
    const documentRoot = document.documentElement;
    const count = Number(documentRoot.dataset.createSessionCount ?? "0") + 1;
    documentRoot.dataset.createSessionCount = String(count);
    documentRoot.dataset.createSessionRequest = JSON.stringify(request);
    const delay = Number(fixtureParams.get("createDelay") ?? "0");
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    return { id: `session-${count}` };
  },
} as unknown as ApiClient;

/**
 * A bare two-option Select, kept because migrating Permission Preset off it removed the app's only
 * way to reproduce #832's actual arithmetic in a browser.
 *
 * Without this the spec's Select assertions pass vacuously — the dialog renders no `.ui-select-
 * trigger` any more — and the class of defect stays live in every OTHER Select the app has: the
 * archive filter, the agent-defaults rows, the colour-scheme picker. AC4 asks for a guard on the
 * class, not on the one control that hit it.
 *
 * A standalone mount is sound HERE, unlike the dialog itself, for a structural reason rather than
 * convenience: the `.menu.listbox` list is `position: fixed` and sized by the inline style the
 * anchored-menu helper computes, so its geometry does not depend on any ancestor. What it does depend on is
 * the coarse-pointer touch floor in `styles.css`, which this page loads in full.
 */
function SelectProbe() {
  const [value, setValue] = React.useState<"first" | "second">("first");
  return (
    <div className="modal">
      <div className="form">
        <div className="field">
          <span>Two Option Probe</span>
          <Select<"first" | "second">
            label="Two Option Probe"
            value={value}
            onChange={setValue}
            options={[
              // Deliberately undescribed: a described option is budgeted at 52px and would have
              // cleared the 44px floor by accident, hiding the disagreement this exists to catch.
              { value: "first", label: "First Option" },
              { value: "second", label: "Second Option" },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function Harness() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  const keyboardFixture = fixtureParams.get("keyboard") === "1";
  const [dialogOpen, setDialogOpen] = React.useState(!keyboardFixture);
  const [openedSession, setOpenedSession] = React.useState<string | null>(null);
  React.useEffect(() => {
    openedSessionListeners.add(setOpenedSession);
    return () => { openedSessionListeners.delete(setOpenedSession); };
  }, []);
  if (!ready) return null;
  if (openedSession) return <main className="section"><h1 className="section-title">Session Opened</h1><p role="status">{openedSession}</p></main>;
  if (fixtureParams.get("probe") === "select") return <SelectProbe />;
  if (runDialog) return <NewRunDialog onClose={() => undefined} />;
  if (keyboardFixture) return (
    <>
      <button type="button" onClick={() => setDialogOpen(true)}>New Session</button>
      {dialogOpen && (
        <NewSessionDialog onClose={() => setDialogOpen(false)} />
      )}
    </>
  );
  return (
    <NewSessionDialog
      onClose={() => undefined}
      preset={noPreset ? undefined : { projectId: project.id, projectLocationId: project.locations[0]!.id }}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <Harness />
    </StoreProvider>
  </ApiProvider>,
);
