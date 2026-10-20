import { randomUUID } from "node:crypto";
import { isTerminal, runnerSupportsProtocol, type AutomationCreationRequest, type AutomationCreationSnapshot,
  type AutomationCreationResult, type AutomationSpec, type AutomationRunnerTarget, type SessionConfig,
  type WorkflowDecisionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { AgentPrincipal, AuthPrincipal } from "./identity.js";
import type { Hub } from "./hub.js";
import { automationCapabilityError, pinAutomationSpec, validateAutomationSpec } from "./automations.js";
import { nextCronFire } from "./automation-schedule.js";
import { auditDigest, capabilityConfigError, claudeModelConfigForValidation, defaultPermissionModeForNewSession, resolveEffectiveModelEffort, type ServiceResult, type SessionsService } from "./sessions.js";

const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
const APPROVAL_TTL_MS = 30 * 60_000;
const fail = <T>(error: string, status = 409): ServiceResult<T> => ({ ok: false, status, error });
const ok = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, status, data });
const identifier = (v: unknown, max: number): v is string => typeof v === "string" &&
  v.trim().length > 0 && v.length <= max && !v.includes("\0");

/** Session credentials propose, humans resolve, and only this service consumes the exact grant.
 * No provider/runner round trip occurs between revalidation and the local atomic commit. */
export class AutomationCreationService {
  constructor(private db: ControlPlaneDb, private sessions: SessionsService, private hub: Hub) {}

  private requester(principal: AgentPrincipal, sessionId: string): string | null {
    if (principal.credentialSessionId !== sessionId || !this.db.canAccessSession(principal, sessionId)) return "session not found";
    const session = this.db.getSession(sessionId);
    if (!session || session.archived || isTerminal(session.status)) return "A live session is required to create an automation";
    if (!runnerSupportsProtocol(this.db.getRunner(session.runnerId)?.protocolVersion, "agentAutomationCreation")) {
      return "Update this session's machine before requesting automation creation";
    }
    return null;
  }

  /** All referenced targets must be in the requester's audience. Runtime admission still applies. */
  private prepare(principal: AuthPrincipal, input: AutomationSpec, requesterId: string): ServiceResult<{ spec: AutomationSpec; targetDigest: string }> {
    const parsed = validateAutomationSpec(input);
    if (!parsed.ok) return fail(parsed.error ?? "Invalid automation configuration", 400);
    const spec = pinAutomationSpec(this.db, structuredClone(parsed.data!));
    const states: unknown[] = [this.db.sessionScope(requesterId)];
    const targets: AutomationRunnerTarget[] = [];
    const action = spec.action;
    if (action.kind !== "prompt_session") action.request.useWorktree ??= action.kind === "workflow_run";
    if (action.kind === "prompt_session") {
      if (!this.db.canAccessSession(principal, action.sessionId)) return fail("Target session is outside this session's audience", 404);
      const target = this.db.getSession(action.sessionId);
      if (!target || target.archived || isTerminal(target.status) || !target.agentId || !target.workspaceId) return fail("Target session is unavailable");
      targets.push({ runnerId: target.runnerId, workspaceId: target.workspaceId, agentId: target.agentId });
      action.request.config = { model: target.model ?? undefined, effort: target.effort ?? undefined,
        permissionMode: target.permissionMode ?? undefined, ...action.request.config };
      states.push({ sessionId: target.id, scope: this.db.sessionScope(target.id), model: target.model,
        effort: target.effort, permissionMode: target.permissionMode, worktreePath: target.worktreePath });
    } else {
      if (action.kind === "workflow_run") {
        const definition = this.db.getWorkflowDefinition(action.request.workflowId, action.request.workflowVersion);
        if (!definition) return fail("Workflow definition is unavailable");
        action.request.workflowVersion = definition.version;
        states.push(definition);
        targets.push({ ...action.request, installationBindings: action.installationBindings });
      } else targets.push({ ...action.request, installationBindings: action.installationBindings });
      if (spec.runnerPolicy.kind === "alternate") targets.push(...spec.runnerPolicy.targets);
    }
    for (const target of targets) {
      if (!this.db.canAccessRunner(principal, target.runnerId) ||
          !this.db.canAccessWorkspace(principal, target.runnerId, target.workspaceId)) return fail("Automation target is outside this session's audience", 404);
      const runner = this.db.getRunner(target.runnerId);
      const workspace = runner?.workspaces.find((w) => w.id === target.workspaceId);
      if (!runner || !workspace || !runnerSupportsProtocol(runner.protocolVersion, "automationCommandReceipts")) return fail("Automation target is unavailable or needs an update");
      if (action.kind !== "prompt_session" && target.projectId === undefined) {
        const locations = this.db.projectLocationsForWorkspace(target.runnerId, target.workspaceId);
        if (locations.length > 1) return fail("Choose the exact Project Location for this automation target");
        const placement = { projectId: locations[0]?.projectId ?? null, projectLocationId: locations[0]?.id ?? null };
        Object.assign(target, placement);
        if (target === targets[0]) Object.assign(action.request, placement);
      }
      if (target.projectId) {
        const location = target.projectLocationId ? this.db.projectLocation(target.projectLocationId) : null;
        if (!this.db.canAccessProject(principal, target.projectId) || !location ||
            location.projectId !== target.projectId || location.runnerId !== target.runnerId || location.workspaceId !== target.workspaceId) {
          return fail("Automation Project Location no longer matches its target");
        }
        states.push(location);
      }
      states.push({ runnerId: target.runnerId, workspace, scope: this.db.workspaceScope(target.runnerId, target.workspaceId),
        locations: this.db.projectLocationsForWorkspace(target.runnerId, target.workspaceId) });
      const ids = action.kind === "workflow_run"
        ? this.db.getWorkflowDefinition(action.request.workflowId, action.request.workflowVersion)!.nodes
          .filter((node) => node.kind === "agent").map((node) => ({ key: `role:${node.agentId!}`,
            id: target.agentBindings?.[node.agentId!] ?? action.request.agentBindings?.[node.agentId!] ?? node.agentId! }))
        : [{ key: "agent", id: target.agentId! }];
      if (action.kind === "workflow_run" && (target.orchestratorAgentId ?? action.request.orchestratorAgentId)) {
        ids.push({ key: "orchestrator", id: target.orchestratorAgentId ?? action.request.orchestratorAgentId! });
      }
      for (const { key, id } of ids) {
        const pin = target.installationBindings?.[key];
        const agentId = pin ? this.db.resolveSavedHarnessInstallation(target.runnerId, pin) : id;
        const agent = runner.agents.find((a) => a.id === agentId && a.available);
        if (!agentId || !agent || !this.db.getAgentLaunch(target.runnerId, agentId)) return fail("The selected agent installation is unavailable");
        const config: SessionConfig = { ...action.request.config };
        const configError = capabilityConfigError(claudeModelConfigForValidation(config, agent.capabilities, agent.driver ?? "acp"), agent.capabilities);
        if (configError) return fail(configError);
        const model = resolveEffectiveModelEffort(config, agent.capabilities, agent.driver ?? "acp");
        if (model.error) return fail(model.error);
        Object.assign(config, model.value);
        config.permissionMode ??= defaultPermissionModeForNewSession(agent.driver ?? "acp", agent.capabilities);
        if (!config.permissionMode && agent.capabilities?.permissionModes?.includes("default")) config.permissionMode = "default";
        if (!config.permissionMode) return fail("Choose an explicit supported permission mode before requesting automation approval");
        // Persist known defaults, so preference changes cannot silently widen an approved action.
        action.request.config = config;
        states.push({ runnerId: target.runnerId, agentId, installation: agent.installation,
          driver: agent.driver, context: agent.context, capabilities: agent.capabilities, config });
      }
    }
    const capabilityError = automationCapabilityError(this.db, this.sessions, spec);
    if (capabilityError) return fail(capabilityError);
    const normalizedSpec = validateAutomationSpec(spec);
    if (!normalizedSpec.ok) return fail(normalizedSpec.error ?? "Prepared automation configuration is invalid", 400);
    return ok({ spec, targetDigest: auditDigest(states)! });
  }

  request(sessionId: string, input: AutomationCreationRequest, principal: AgentPrincipal, now = Date.now()): ServiceResult<WorkflowDecisionView> {
    const refused = this.requester(principal, sessionId);
    if (refused) return fail(refused, 403);
    if (!identifier(input?.requestId, 256) || !identifier(input?.resourceKey, 512)) return fail("requestId and resourceKey are required", 400);
    const requestedSpecDigest = auditDigest(input.spec);
    const existing = this.db.workflowDecisionByRequestId(sessionId, input.requestId);
    if (existing) {
      const s = existing.resourceSnapshot;
      if (s.category !== "automation_creation" || s.requestedSpecDigest !== requestedSpecDigest || existing.resourceKey !== input.resourceKey) return fail("requestId was already used for different proposal content");
      return this.sessions.createWorkflowDecision(sessionId, { requestId: input.requestId, resourceKey: input.resourceKey,
        resourceSnapshot: existing.resourceSnapshot }, (id) => this.db.canAccessSession(principal, id), { trustedAutomationCreation: true });
    }
    const prepared = this.prepare(principal, input.spec, sessionId);
    if (!prepared.ok) return fail(prepared.error!, prepared.status);
    const snapshot: AutomationCreationSnapshot = { category: "automation_creation", ...prepared.data!,
      nextFireAt: nextCronFire(prepared.data!.spec.cron, prepared.data!.spec.timezone, now),
      requestedSpecDigest: requestedSpecDigest!, expiresAt: now + PROPOSAL_TTL_MS };
    return this.sessions.createWorkflowDecision(sessionId, { requestId: input.requestId, resourceKey: input.resourceKey,
      resourceSnapshot: snapshot }, (id) => this.db.canAccessSession(principal, id), { trustedAutomationCreation: true });
  }

  get(sessionId: string, occurrenceId: string, principal: AgentPrincipal): ServiceResult<WorkflowDecisionView> {
    if (principal.credentialSessionId !== sessionId || !this.db.canAccessSession(principal, sessionId)) return fail("session not found", 404);
    const decision = this.db.workflowDecisionByOccurrence(occurrenceId);
    return decision?.sessionId === sessionId && decision.category === "automation_creation" ? ok(decision) : fail("Automation proposal not found", 404);
  }

  execute(sessionId: string, occurrenceId: string, digest: string, principal: AgentPrincipal, now = Date.now()): ServiceResult<WorkflowDecisionView> {
    const read = this.get(sessionId, occurrenceId, principal);
    if (!read.ok) return read;
    const decision = read.data!;
    if (decision.resourceDigest !== digest) return fail("Automation proposal digest does not match");
    if (decision.status === "consumed" && decision.automationCreationResult) return ok(decision);
    const snapshot = decision.resourceSnapshot;
    if (snapshot.category !== "automation_creation" || decision.status !== "approved" || decision.authority !== "human" ||
        !decision.resolvedAt || now >= snapshot.expiresAt || now >= decision.resolvedAt + APPROVAL_TTL_MS) return fail("Automation proposal needs current human approval");
    const refused = this.requester(principal, sessionId);
    if (refused) return fail(refused, 403);
    const scope = this.db.sessionScope(sessionId);
    const approver = this.db.automationCreationApprover(occurrenceId);
    const human = scope && approver ? this.db.automationCreationHuman(approver, scope.organizationId) : null;
    if (!scope || !approver || !human || !this.db.isSessionOwner(human, sessionId)) return fail("Automation approver no longer owns this session");
    const prepared = this.prepare(human, snapshot.spec, sessionId);
    if (!prepared.ok) return fail(prepared.error!, prepared.status);
    if (prepared.data!.targetDigest !== snapshot.targetDigest || auditDigest(prepared.data!.spec) !== auditDigest(snapshot.spec)) return fail("Automation targets or effective settings changed; request fresh approval");
    const automationId = `auto_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const result: AutomationCreationResult = { automationId,
      navigationPath: `/automations/~${Buffer.from(automationId, "utf16le").toString("base64url")}`,
      spec: snapshot.spec, createdAt: now };
    const saved = this.db.createAutomation({ automationId, spec: snapshot.spec,
      nextFireAt: snapshot.spec.enabled ? nextCronFire(snapshot.spec.cron, snapshot.spec.timezone, now) : null,
      actor: { kind: "human", id: approver }, now, approval: { occurrenceId, resourceDigest: digest, result } });
    if (!saved || saved.automationId !== automationId ||
        (Object.keys(snapshot.spec) as Array<keyof AutomationSpec>).some((key) => auditDigest(saved[key]) !== auditDigest(snapshot.spec[key]))) {
      throw new Error("Automation creation readback failed; inspect the durable receipt before retrying");
    }
    this.hub.sessionChangedById(sessionId);
    return ok(this.db.workflowDecisionByOccurrence(occurrenceId)!, 201);
  }
}
