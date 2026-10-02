import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type AgentHarnessDefaultsView,
  type CreateSessionRequest,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  type UiSnapshotMessage,
  type WorkflowDefinition,
} from "@wollipog/protocol";
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

/** #1648: accounts people named after their email, which the picker must mask by default. */
const emailAccounts = fixtureParams.get("emailAccounts") === "1";

/** #1695: host and container execution targets, so target-specific copy can be inspected. */
const containerTargets = fixtureParams.get("containerTargets") === "1";

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

/** `?theme=light|dark` pins the theme; without it the page keeps the app's own default. */
const fixtureTheme = fixtureParams.get("theme");
if (fixtureTheme === "light" || fixtureTheme === "dark") document.documentElement.setAttribute("data-theme", fixtureTheme);

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "fixture-runner",
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
      available: fixtureParams.get("agentUnavailable") !== "1",
      authStatus: fixtureParams.get("agentUnavailable") === "1" ? "unauthenticated" : undefined,
    },
    {
      id: "codex-exec",
      name: "Codex",
      command: "codex",
      args: ["exec"],
      env: {},
      driver: "codex",
      available: true,
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
  ],
  providerAccounts: [
    {
      id: "claude-work",
      label: emailAccounts ? "work.me@example.com" : "Work",
      provider: "claude",
      authStatus: "authenticated",
    },
    {
      id: "claude-personal",
      label: emailAccounts ? "work.me@example.org" : "Personal",
      provider: "claude",
      authStatus: "unauthenticated",
    },
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  // A current runner, so `sessionOrchestration` is advertised and the Orchestrator preset is a real
  // choice rather than a disabled card. The disabled path is covered by `?orchestrator=0`.
  protocolVersion: PROTOCOL_VERSION,
  ...(containerTargets ? {
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
      {
        id: "container", runnerId: "runner-1", name: "Offline Container",
        kind: "container", workspaceStrategy: "worktree", adapter: "container",
        boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
        available: true,
      },
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
    ...(savedDefaults === "orchestrator" ? { orchestratorRole: true } : {}),
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

const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push() {},
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
  createSession: async (request: CreateSessionRequest) => {
    const documentRoot = document.documentElement;
    const count = Number(documentRoot.dataset.createSessionCount ?? "0") + 1;
    documentRoot.dataset.createSessionCount = String(count);
    documentRoot.dataset.createSessionRequest = JSON.stringify(request);
    const delay = Number(fixtureParams.get("createDelay") ?? "0");
    if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
    return { id: `session-${count}` };
  },
} as ApiClient;

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
  if (!ready) return null;
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
      preset={{ projectId: project.id, projectLocationId: project.locations[0]!.id }}
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
