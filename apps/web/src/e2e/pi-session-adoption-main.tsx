import React from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type ExternalSessionDescriptor, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { AgentSessionDiscoveryDialog } from "../components/AgentSessionDiscoveryDialog.js";
import "../styles.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
const legacy = new URLSearchParams(location.search).has("legacy");
const descriptor: ExternalSessionDescriptor = {
  agentSessionId: "pi-external-session",
  driver: "pi",
  cwd: "/home/demo/wollipog",
  context: { kind: "native" },
  title: "Finish Pi Session Adoption",
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 30_000,
  messageCount: 12,
  resumable: true,
};
const runner: RunnerView = {
  runnerId: "runner-pi",
  hostname: "pi-workstation",
  os: "linux",
  version: "0.26.0",
  status: "online",
  protocolVersion: legacy ? 155 : PROTOCOL_VERSION,
  connectedAt: 1,
  lastSeen: 1,
  workspaces: [],
  agents: [{
    id: "pi-native",
    name: "Pi",
    command: "pi",
    args: [],
    env: {},
    driver: "pi",
    context: { kind: "native" },
    available: true,
    source: "discovered",
    version: "0.56.1",
  }],
};
const client: ApiClient = {
  ...api,
  listExternalSessions: async (runnerId, agentId) => {
    if (runnerId !== runner.runnerId || agentId !== "pi-native") throw new Error("unexpected discovery coordinates");
    return { sessions: [descriptor] };
  },
  adoptSession: async (runnerId, selected) => {
    if (runnerId !== runner.runnerId || selected.agentSessionId !== descriptor.agentSessionId) {
      throw new Error("unexpected adoption coordinates");
    }
    (window as unknown as { __piAdopted?: boolean }).__piAdopted = true;
    return {
      id: "s_adopted_pi", runnerId, workspaceId: null, workspaceName: null,
      agentId: "pi-native", agentName: "Pi", title: descriptor.title, status: "idle",
      column: "queued", runId: null, useWorktree: false, worktreePath: null, archived: false,
      createdAt: descriptor.createdAt, updatedAt: descriptor.updatedAt, lastEventAt: descriptor.updatedAt,
      messageCount: descriptor.messageCount, preview: null, pendingApproval: null, driver: "pi",
      model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0,
      adopted: true,
    };
  },
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <AgentSessionDiscoveryDialog runner={runner} onClose={() => {}} />
  </ApiProvider>,
);
