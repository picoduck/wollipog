import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type AgentHarnessDefaultsView,
  type ProjectView,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
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
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  // A current runner, so `sessionOrchestration` is advertised and the Orchestrator preset is a real
  // choice rather than a disabled card. The disabled path is covered by `?orchestrator=0`.
  protocolVersion: PROTOCOL_VERSION,
};

const project: ProjectView = {
  id: "project-1",
  name: "Wollipog",
  hidden: false,
  locations: [{
    id: "location-1",
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Wollipog",
    path: "/repos/wollipog",
    source: "managed",
    availability: "available",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  }],
  activeSessionCount: 0,
  unarchivedSessionCount: 0,
  totalSessionCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const snapshot: UiSnapshotMessage = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: true,
  },
  runners: [runner],
  boxes: [],
  projects: [project],
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

const defaults: AgentHarnessDefaultsView = { defaults: [] };

const client = {
  ...api,
  agentHarnessDefaults: async () => defaults,
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
 * convenience: `.ui-select-list` is `position: fixed` and sized by the inline style the anchored-
 * menu helper computes, so its geometry does not depend on any ancestor. What it does depend on is
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
  if (!ready) return null;
  if (fixtureParams.get("probe") === "select") return <SelectProbe />;
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
