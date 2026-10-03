/** The production session header/dialog over a role API and reconnect fixture. Provider retirement,
 * credential fences, and role authority are exercised by the control-plane and runner tests. */
import { createRoot } from "react-dom/client";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, sessionRole,
  type ControlPlaneToUi, type OrchestratorCampaignPolicy, type OrchestratorSettingsCapabilities, type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { SessionHeader } from "../components/SessionHeader.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import type { ViewNavigation } from "../navigation.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "normal";
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
const policy = { version: 1, ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), sources: {} } as OrchestratorCampaignPolicy;
const capabilities: OrchestratorSettingsCapabilities = {
  models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available",
  harnesses: [{ agentId: "codex-app", driver: "codex-app-server", context: { kind: "native" }, name: "Codex App",
    installations: 1, models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }], effortLevels: ["high"],
    supportedPairs: [{ modelId: "gpt-6.1-sol", effortLevels: ["high"] }] }],
};
if (scenario === "strict") policy.execution.strictProjectIsolation = true;
let pendingPolicy: OrchestratorCampaignPolicy | undefined;
let session = {
  id: "same-session", title: "Session Role Conversion", runnerId: "machine", workspaceId: "workspace",
  agentId: "codex-app", driver: "codex-app-server", role: "normal", status: "idle", adopted: false,
  eventEpoch: 1, archived: false, runId: null, parentSessionId: null, pendingApproval: null,
  createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, tokensIn: 0, tokensOut: 0, costUsd: 0,
  costBudgetUsd: null, maxToolCalls: null, permissionMode: "auto", model: "gpt-6.1-sol", effort: "high",
  providerAccountId: "same-account", providerAccountLabel: "Personal Account", projectId: "same-project",
  useWorktree: true, worktreePath: "/project/session-worktree",
} as SessionView;
if (scenario === "orchestrator" || scenario === "children") session = { ...session, role: "orchestrator", orchestratorPolicy: policy };
if (scenario === "busy") session.status = "running";
let calls = 0;
let push: ((message: ControlPlaneToUi) => void) | undefined;
const snapshot = (): ControlPlaneToUi => ({
  type: "snapshot", capabilities: {
    sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false,
    sessionRoleConversion: scenario !== "older-control-plane",
  }, runners: [], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
});
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    push = (message) => this.onmessage?.({ data: JSON.stringify(message) });
    setTimeout(() => { this.onopen?.(); push?.(snapshot()); }, 0);
  }
  send() {}
  close() {}
}
const connection: UiConnectionRuntime = {
  instanceId: "session-role-e2e", runtimeKey: "session-role-e2e:1", createSocket: () => new FixtureSocket(), close() {},
};
const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };
const reasons: Record<string, string> = {
  busy: "Resume this session and wait until it is idle before changing its role. Finish or stop active work first.",
  children: "Finish or stop the live child sessions before changing this role. Completed children keep their links and remain accessible to you.",
  "older-runner": "Update this Machine's runner to protocol v202 or later before changing the session role.",
  strict: "Strict Project Isolation requires the coupled preset. Disable it here to preserve these provider permissions.",
  viewer: "Your Viewer role is read-only.",
};
const client: ApiClient = {
  ...api,
  listAllSessions: async () => ({ sessions: [session] }),
  getIdentity: async () => ({ context: { userId: "human", userName: "Human", organizationId: "org", organizationName: "Personal", role: "operator", deviceId: null, localBootstrap: true }, organizations: [], memberships: [], teams: [] }),
  session: async () => ({ session, events: [] }),
  sessionRolePreview: async (_id, role) => ({ currentRole: sessionRole(session), targetRole: role,
    permissionMode: session.permissionMode, available: !reasons[scenario],
    ...(reasons[scenario] ? { reason: reasons[scenario] } : {}),
    ...(scenario === "strict" ? { policyError: reasons.strict } : {}),
    ...(scenario === "inherited" ? { policyInherited: true } : {}),
    ...(session.roleConversion ? { canRetry: true } : {}),
    ...(role === "orchestrator" ? { orchestratorPolicy: pendingPolicy ?? policy, orchestratorCapabilities: capabilities } : {}),
  }),
  changeSessionRole: async (id, role, expectedRole, selected) => {
    if (id !== session.id || sessionRole(session) !== expectedRole || (reasons[scenario] && scenario !== "strict")) throw new Error("Session changed; reload before converting.");
    calls++;
    const chosen = pendingPolicy ?? (selected ? { ...policy, ...selected, behavior: { ...policy.behavior, ...selected.behavior },
      delegation: { ...policy.delegation, ...selected.delegation, decisions: { ...policy.delegation.decisions, ...selected.delegation?.decisions } },
      execution: { ...policy.execution, ...selected.execution } } : policy);
    if (scenario === "lost-reply" && !pendingPolicy) {
      pendingPolicy = structuredClone(chosen);
      session = { ...session, roleConversion: { targetRole: role, phase: "preparing" } };
      push?.({ type: "session_upsert", session });
      throw new Error("Reply lost; retry the recorded selection.");
    }
    session = { ...session, role, roleConversion: undefined, orchestratorPolicy: role === "orchestrator" ? chosen : undefined };
    push?.({ type: "session_upsert", session });
    return session;
  },
};
declare global {
  interface Window {
    __WOLLIPOG_ROLE_E2E__: { session(): SessionView; calls(): number; reconnect(): void };
  }
}
window.__WOLLIPOG_ROLE_E2E__ = { session: () => session, calls: () => calls, reconnect: () => push?.(snapshot()) };

function Harness() {
  const current = useStoreSelector((state) => state.sessions.get(session.id));
  const supported = useStoreSelector((state) => state.sessionRoleConversionSupported);
  if (!current) return <p>Connecting…</p>;
  return <div className="session-reading" style={{ minHeight: "100vh" }}>
    <SessionHeader session={current} onBack={() => {}} runnerOnline machineName="Personal Machine"
      runnerProtocolVersion={PROTOCOL_VERSION} providerLogoutSupported={false} stopBeforeArchiveSupported={false}
      sessionRoleConversionSupported={supported}
      exportReady={false} projectName="Project" developmentBuild={false} />
    <div style={{ padding: 24 }}>
      <p><strong>Session Role</strong>: <span data-testid="session-role">{sessionRole(current) === "orchestrator" ? "Orchestrator" : "Standard"}</span></p>
      <p>Conversation history stays in this session.</p>
      <p>Account: Personal Account · Project: Project · Worktree: session-worktree</p>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<ApiProvider client={client}><FeedbackProvider>
  <StoreProvider connection={connection} navigation={navigation}><Harness /></StoreProvider>
</FeedbackProvider></ApiProvider>);
