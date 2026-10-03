import { randomUUID } from "node:crypto";
import {
  advertisesOrchestratorAdditiveRole, isTerminal, pendingRequests,
  runnerSupportsProtocol, sessionRole, usesOrchestratorPresetPermissions,
  type OrchestratorCampaignPolicy, type OrchestratorSettingsView, type PrepareSessionRoleMessage,
  type SessionRole, type SessionRoleConversionPreview, type SessionSnapshot,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { launchForRestart } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HumanPrincipal } from "./identity.js";
import { withSessionCommandPermissions } from "./session-command-permissions.js";

export function registerSessionRoleRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb;
  conversions: SessionRoleConversions;
  requestHuman: (req: FastifyRequest) => HumanPrincipal | null;
  defaultsFor: (human: HumanPrincipal) => OrchestratorSettingsView;
  validatePolicy: (human: HumanPrincipal, policy: OrchestratorCampaignPolicy) => string | null;
}): void {
  app.get("/api/sessions/:id/role", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const human = deps.requestHuman(req);
    if (!human) return reply.code(403).send({ error: "only an authenticated human may change session roles" });
    if (!deps.db.canAccessSession(human, id)) return reply.code(404).send({ error: "session not found" });
    const role = (req.query as { role?: unknown }).role;
    if (role !== "normal" && role !== "orchestrator") return reply.code(400).send({ error: "role must be normal or orchestrator" });
    const preview = deps.conversions.preview(id, role, deps.defaultsFor(human), (policy) => deps.validatePolicy(human, policy));
    return human.role === "viewer" ? { ...preview, available: false, canRetry: false, reason: "Your Viewer role is read-only." } : preview;
  });
  app.post("/api/sessions/:id/role", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const human = deps.requestHuman(req);
    if (!human || human.role === "viewer") return reply.code(403).send({ error: "only an authenticated human with write access may change session roles" });
    if (!deps.db.canAccessSession(human, id)) return reply.code(404).send({ error: "session not found" });
    const body = req.body as { role?: unknown; expectedRole?: unknown } | undefined;
    if ((body?.role !== "normal" && body?.role !== "orchestrator") ||
        (body.expectedRole !== "normal" && body.expectedRole !== "orchestrator")) {
      return reply.code(400).send({ error: "role and expectedRole must be normal or orchestrator" });
    }
    try {
      await deps.conversions.change(id, body.role, body.expectedRole, deps.defaultsFor(human), (policy) => deps.validatePolicy(human, policy));
      return withSessionCommandPermissions(deps.db, human, deps.db.getSession(id)!);
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
}

/** Human intent is the authority; a runner can only attest preparation of that exact intent. */
export class SessionRoleConversions {
  private readonly advancing = new Map<string, Promise<void>>();
  constructor(private readonly db: ControlPlaneDb, private readonly hub: Hub,
    private readonly log: (event: string, fields: Record<string, unknown>) => void = () => {}) {}

  preview(id: string, targetRole: SessionRole, defaults: OrchestratorSettingsView,
    validate: (policy: OrchestratorCampaignPolicy) => string | null): SessionRoleConversionPreview {
    const session = this.db.getSession(id);
    if (!session) throw new Error("session not found");
    const currentRole = sessionRole(session);
    const result: SessionRoleConversionPreview = {
      currentRole, targetRole, available: false, permissionMode: session.permissionMode,
    };
    const refuse = (reason: string) => ({ ...result, reason });
    const runner = this.db.getRunner(session.runnerId);
    if (!this.hub.isRunnerOnline(session.runnerId)) return refuse("Connect this session's Machine before changing its role.");
    if (!runnerSupportsProtocol(runner?.protocolVersion, "sessionRoleConversion")) {
      return refuse("Update this Machine's runner to protocol v197 or later before changing the session role.");
    }
    const pending = this.db.sessionRoleConversion(id);
    if (pending && pending.state !== "applied") return {
      ...result, canRetry: pending.command.targetRole === targetRole,
      reason: "A role change is already in progress. Retry it to finish reconciliation.",
    };
    if (this.db.roleConversionBlocksSession(id)) return refuse("Wait for the parent session's role change to finish.");
    if (currentRole === targetRole) return refuse("This session already has that role.");
    if (session.archived || session.archiveStatus || this.db.hasSessionStopIntent(id) || session.status !== "idle") {
      return refuse("Resume this session and wait until it is idle before changing its role. Finish or stop active work first.");
    }
    if (session.runId || this.db.sideChatParent(id)) return refuse("Workflow and side-chat sessions cannot change roles. Use a standalone session.");
    if (this.db.listShells(id).some((shell) => shell.kind === "agent_tui" && shell.status !== "exited")) {
      return refuse("Close the Native TUI before changing roles so the previous provider tools can be retired safely.");
    }
    const launch = launchForRestart(this.db, session);
    if (!launch || launch.driver !== session.driver ||
        !["claude-code", "codex", "codex-app-server", "pi"].includes(session.driver) ||
        (launch.context?.kind ?? "native") !== "native" ||
        (session.executionTarget && session.executionTarget.adapter !== "host")) {
      return refuse("Role conversion requires the same supported native Claude Code, Codex, or Pi installation on the host. Update or select a compatible installation.");
    }
    const capabilities = launch.capabilities;
    if (session.driver === "claude-code" && capabilities?.claudeMutableSystemPromptFlag !== "--system-prompt-recording" &&
        capabilities?.claudeMutableSystemPromptFlag !== "--system-prompt-snapshot") {
      return refuse("Update Claude Code and refresh this Machine's installations before converting. This installation must support rebuilding system instructions on the existing conversation.");
    }
    if (!advertisesOrchestratorAdditiveRole(launch.driver, capabilities)) {
      return refuse("This installation does not advertise independent Orchestrator role support. Update the harness and runner.");
    }
    if (usesOrchestratorPresetPermissions(session)) {
      return refuse("The Orchestrator preset couples permissions and isolation to the role. This conversion preserves provider permissions; use an Orchestrator with independent provider permissions instead.");
    }
    if (session.permissionMode && !capabilities?.permissionModes?.includes(session.permissionMode)) {
      return refuse("The selected permission mode is no longer supported by this installation. Choose a compatible mode before changing roles.");
    }
    const descendants = this.db.campaignDescendantIds(id).map((childId) => this.db.getSession(childId)).filter((child) => child !== null);
    if (descendants.some((child) => !isTerminal(child.status))) {
      return refuse("Finish or stop the live child sessions before changing this role. Completed children keep their links and remain accessible to you.");
    }
    if ([session, ...descendants].some((child) => pendingRequests(child.pendingApproval).length > 0) ||
        this.db.unconsumedWorkflowDecisionsForController(id).length ||
        this.db.unconsumedWorkflowDecisionsForSession(id).length) {
      return refuse("Resolve or dismiss pending requests and unconsumed decisions before changing this role. Their current owner remains responsible until they are settled.");
    }
    if (targetRole === "orchestrator") {
      const root = this.db.campaignAncestryRoot(id);
      if (root === "refused") return refuse("The session ancestry is malformed. Repair its parent links before changing roles.");
      const inherited = typeof root === "object" ? this.db.getSession(root.id)?.orchestratorPolicy : undefined;
      const policy = inherited ? structuredClone(inherited)
        : resolveOrchestratorCampaignPolicy(defaults.defaults, defaults.source, {});
      if (policy.execution.strictProjectIsolation) {
        return refuse("Your Orchestrator defaults enable Strict Project Isolation, which requires the coupled preset. Disable it in Orchestrator settings before converting with these provider permissions.");
      }
      const error = validate(policy);
      if (error) return refuse(error);
      result.orchestratorPolicy = policy;
    }
    return { ...result, available: true };
  }

  async change(id: string, role: SessionRole, expectedRole: SessionRole, defaults: OrchestratorSettingsView,
    validate: (policy: OrchestratorCampaignPolicy) => string | null): Promise<void> {
    const existing = this.db.sessionRoleConversion(id);
    if (existing && existing.state !== "applied") {
      if (existing.command.targetRole !== role || existing.command.expectedRole !== expectedRole) {
        throw new Error("Finish the existing role change before requesting another one.");
      }
      await this.advance(id);
      return;
    }
    const preview = this.preview(id, role, defaults, validate);
    if (preview.currentRole !== expectedRole) throw new Error("The session role changed. Reload it before trying again.");
    if (!preview.available) throw new Error(preview.reason);
    const session = this.db.getSession(id)!;
    const launch = launchForRestart(this.db, session)!;
    const conversionId = randomUUID();
    const command: PrepareSessionRoleMessage = {
      type: "prepare_session_role", requestId: randomUUID(), sessionId: id, conversionId,
      expectedRole, targetRole: role, permissionMode: session.permissionMode,
      command: launch.command, args: launch.args,
      ...(session.driver === "claude-code" ? { claudeMutableSystemPromptFlag: launch.capabilities!.claudeMutableSystemPromptFlag } : {}),
      ...(preview.orchestratorPolicy ? { orchestrator: {
        ...preview.orchestratorPolicy.execution,
        ...(preview.orchestratorPolicy.issueNumbers?.length ? { issueNumbers: preview.orchestratorPolicy.issueNumbers } : {}),
      } } : {}),
    };
    this.db.beginSessionRoleConversion(command, preview.orchestratorPolicy, Date.now());
    this.hub.sessionChangedById(id);
    this.log("session_role_conversion_requested", { sessionId: id, conversionId, role, entryPoint: "human_api" });
    await this.advance(id);
  }

  private async advance(id: string): Promise<void> {
    const pending = this.advancing.get(id);
    if (pending) return pending;
    const advancing = this.advanceOnce(id);
    this.advancing.set(id, advancing);
    try { await advancing; }
    finally { if (this.advancing.get(id) === advancing) this.advancing.delete(id); }
  }

  private async advanceOnce(id: string): Promise<void> {
    const intent = this.db.sessionRoleConversion(id);
    const session = this.db.getSession(id);
    if (!intent || !session || intent.state === "applied") return;
    if (!runnerSupportsProtocol(this.db.getRunner(session.runnerId)?.protocolVersion, "sessionRoleConversion")) {
      throw new Error("Update this Machine's runner to protocol v197 or later to finish the role change.");
    }
    const command = intent.state === "preparing" ? { ...intent.command, requestId: randomUUID() }
      : { type: "commit_session_role" as const, requestId: randomUUID(), sessionId: id, conversionId: intent.command.conversionId };
    const result = await this.hub.requestFromRunner(session.runnerId, command.requestId, command, 30_000);
    if (result.type !== "session_role_result" || result.sessionId !== id ||
        result.conversionId !== command.conversionId) throw new Error("The role change reply could not be matched. Retry to reconcile it.");
    if (!result.ok) {
      if (intent.state === "preparing" && !result.pending) this.db.abandonSessionRoleConversion(id, command.conversionId);
      this.hub.sessionChangedById(id);
      this.log("session_role_conversion_refused", { sessionId: id, conversionId: command.conversionId, entryPoint: "runner_reply" });
      throw new Error(result.error ?? "The runner could not change this session's role.");
    }
    if (!result.receipt || result.receipt.conversionId !== command.conversionId) throw new Error("The runner omitted the role conversion receipt. Retry to reconcile it.");
    this.acceptReceipt(session.runnerId, { id, roleConversionReceipt: result.receipt });
    const after = this.db.sessionRoleConversion(id);
    if (after?.state === "committing" && command.type === "prepare_session_role") await this.advanceOnce(id);
  }

  private acceptReceipt(runnerId: string, snapshot: Pick<SessionSnapshot, "id" | "roleConversionReceipt">): void {
    const session = this.db.getSession(snapshot.id);
    const intent = this.db.sessionRoleConversion(snapshot.id);
    const receipt = snapshot.roleConversionReceipt;
    if (!session || session.runnerId !== runnerId || !intent || !receipt ||
        intent.command.conversionId !== receipt.conversionId) return;
    let changed = false;
    if (receipt.state === "prepared" && intent.state === "preparing") {
      this.db.commitSessionRoleConversion(snapshot.id, receipt.conversionId, Date.now());
      changed = true;
      this.log("session_role_conversion_committed", { sessionId: snapshot.id, conversionId: receipt.conversionId, entryPoint: "runner_receipt" });
    } else if (receipt.state === "applied" && intent.state === "committing") {
      this.db.finishSessionRoleConversion(snapshot.id, receipt.conversionId);
      changed = true;
      this.log("session_role_conversion_applied", { sessionId: snapshot.id, conversionId: receipt.conversionId, entryPoint: "runner_receipt" });
    }
    if (changed) this.hub.sessionChangedById(snapshot.id);
  }

  reconcile(runnerId: string, snapshot: Pick<SessionSnapshot, "id" | "roleConversionReceipt">): void {
    const intent = this.db.sessionRoleConversion(snapshot.id);
    if (!intent || intent.state === "applied") return;
    const session = this.db.getSession(snapshot.id);
    if (!session || session.runnerId !== runnerId || !intent ||
        !runnerSupportsProtocol(this.db.getRunner(runnerId)?.protocolVersion, "sessionRoleConversion") ||
        (snapshot.roleConversionReceipt && snapshot.roleConversionReceipt.conversionId !== intent.command.conversionId)) return;
    this.acceptReceipt(runnerId, snapshot);
    if (!this.db.sessionRoleConversionPending(snapshot.id) || this.advancing.has(snapshot.id)) return;
    void this.advance(snapshot.id).catch(() => {
      this.log("session_role_conversion_reconciliation_pending", { sessionId: snapshot.id, entryPoint: "runner_reconnect" });
    });
  }
}
