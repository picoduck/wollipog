import { PROTOCOL_VERSION, DEFAULT_ORCHESTRATOR_DEFAULTS, type OrchestratorSettingsView } from "@wollipog/protocol";
import { ControlPlaneDb } from "../../../control-plane/src/db.js";
import { Hub } from "../../../control-plane/src/hub.js";
import { SessionsService } from "../../../control-plane/src/sessions.js";
import { AutomationCreationService } from "../../../control-plane/src/automation-creation.js";
import { SessionRoleConversions } from "../../../control-plane/src/session-role-conversion.js";
import type { AgentPrincipal } from "../../../control-plane/src/identity.js";

/** Isolated, synthetic state. Provider role changes use exact receipts without launching an agent. */
export function automationApprovalExpiration() {
  const db = ControlPlaneDb.open(":memory:");
  const now = Date.now();
  db.registerRunner({ runnerId: "machine", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, available: true,
      driver: "claude-code", context: { kind: "native" }, capabilities: {
        models: [{ id: "opus", default: true, efforts: ["high"] }], effortLevels: ["high"], slashCommands: [],
        permissionModes: ["auto", "default"], supportsApprovals: true, supportsImages: false,
        orchestratorAdditive: true, claudeMutableSystemPromptFlag: "--system-prompt-recording",
      } }],
  }, now, PROTOCOL_VERSION);
  db.createSession({ id: "same-session", title: "Session Role Conversion", runnerId: "machine", workspaceId: "workspace",
    agentId: "claude", driver: "claude-code", config: { permissionMode: "auto", model: "opus", effort: "high" }, useWorktree: true, now });
  db.updateSessionStatus("same-session", "idle", now);
  const hub = new Hub(db);
  hub.isRunnerOnline = () => false;
  hub.sessionChangedById = () => {};
  const sessions = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const service = new AutomationCreationService(db, sessions, hub);
  const scope = db.sessionScope("same-session")!;
  const principal: AgentPrincipal = { kind: "agent", actorId: "same-session", credentialSessionId: "same-session",
    organizationId: scope.organizationId, delegatedScope: scope };
  const proposal = service.request("same-session", { requestId: "expiry", resourceKey: "expiry", spec: {
    name: "Weekly Review", cron: "0 8 * * 2", timezone: "UTC", enabled: false,
    action: { kind: "create_session", request: { runnerId: "machine", workspaceId: "workspace", agentId: "claude", prompt: "Review only." } },
    misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
    limits: { maxCostUsd: 5, maxToolCalls: 50 }, notifications: { pushEvents: [] },
  } }, principal);
  if (!proposal.ok) throw new Error(proposal.error);
  const decision = proposal.data!;
  const approved = sessions.resolveWorkflowDecision("same-session", "same-session", decision.occurrenceId,
    { outcome: "approve" }, "human", { kind: "human", id: db.localIdentityContext().userId }, () => true);
  if (!approved.ok) throw new Error(approved.error);
  hub.isRunnerOnline = () => true;
  hub.requestFromRunner = async (_runnerId, requestId, command) => {
    if (command.type !== "prepare_session_role" && command.type !== "commit_session_role") throw new Error("Unexpected fixture command");
    return { type: "session_role_result", requestId, sessionId: command.sessionId,
      conversionId: command.conversionId, ok: true,
      receipt: { conversionId: command.conversionId, state: command.type === "prepare_session_role" ? "prepared" : "applied" } };
  };
  const defaults = { defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), source: "system_default" } as OrchestratorSettingsView;
  defaults.defaults.execution.strictProjectIsolation = false;
  const conversions = new SessionRoleConversions(db, hub, undefined, () => sessions.expireAutomationCreationDecisions());
  return { db, conversions, defaults, decision,
    expire: () => db.raw().prepare("UPDATE workflow_decisions SET resolved_at=? WHERE occurrence_id=?")
      .run(Date.now() - 30 * 60_000, decision.occurrenceId),
  };
}
