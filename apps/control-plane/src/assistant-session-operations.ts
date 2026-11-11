import type { CreateSessionRequest, SessionView } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService, ServiceResult } from "./sessions.js";
import { AssistantOperations, AssistantRefusal, type AssistantOperation, type AssistantTarget } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest, type AssistantCommandReceipt } from "./assistant-command-receipts.js";
import type { AssistantWorkOriginStore, AssistantSessionWorkOrigin, AuthenticatedAssistantWorkOrigin } from "./assistant-work-origin.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { OrchestratorSettings } from "./orchestrator-settings.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an object of tool arguments.");
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new AssistantRefusal(`${key} is required.`);
  return value;
}
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({type: "object", properties, required, additionalProperties: false});
const string = {type: "string"};
const commandProperties = {sessionId: string, workOriginId: {...string, description: "Optional preauthorized work-origin binding; requires the work tracking extension."},
  commandId: {...string, description: "Stable caller command ID. Reconcile before retrying a lost response."}};

export interface AssistantSessionCommandHooks {
  /** Trusted ingress lookup of an authenticated requester envelope for this EXACT command.
   * Must match connection, operation, argumentsDigest and resolved target; no identity from args.
   * The callback is synchronous and runs inside the reservation transaction before any effect. */
  authenticatedOrigin?(receipt: Readonly<AssistantCommandReceipt>): AuthenticatedAssistantWorkOrigin | null;
  /** Trusted synchronous extension on the SAME database/savepoint as receipt reservation.
   * Must validate any client workOriginId against connection/target before writing association.
   * Throwing rolls back both writes; never perform network IO or other external effects here. */
  associateCommand?(args: Readonly<Record<string, unknown>>, receipt: AssistantCommandReceipt): void;
}

/** Same application services as owner API, without fabricated ancestry or campaigns. */
export function registerAssistantSessionOperations(operations: AssistantOperations, db: ControlPlaneDb, svc: SessionsService, hooks: AssistantSessionCommandHooks = {}): AssistantCommandReceipts {
  AssistantCommandReceipts.install(db.raw());
  const receipts = new AssistantCommandReceipts(db.raw());
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  const orchestratorSettings = new OrchestratorSettings(db);
  const workStore = () => (db as ControlPlaneDb & {assistantWork?: AssistantWorkOriginStore}).assistantWork;
  const sessionTarget = (value: unknown): AssistantTarget => {
    const s = db.getSession(text(object(value), "sessionId"));
    if (!s) throw new AssistantRefusal("Session not found. Refresh session_list and select an accessible session.");
    return {kind: "session", id: s.id, ...(s.projectId ? {projectId: s.projectId} : {})};
  };
  const canAccess: AssistantOperation["ownerCanAccess"] = (owner, target) => target.kind === "session"
    ? db.canAccessSession(owner, target.id) : target.kind === "project" ? db.canAccessProject(owner, target.id) : true;
  const allowedProject = (connectionId: string, projectId: string | null | undefined) => {
    const grant = db.assistantConnections.get(connectionId)?.grant;
    return !!grant && (grant.projects === "all" || (!!projectId && grant.projects.includes(projectId)));
  };
  const summary = (s: SessionView) => ({id: s.id, title: s.title, projectId: s.projectId, projectLocationId: s.projectLocationId,
    runnerId: s.runnerId, agentId: s.agentId, status: s.status, archived: s.archived, archiveStatus: s.archiveStatus,
    worktreePath: s.worktreePath, updatedAt: s.updatedAt});
  operations.register({name: "project_list", description: "List authorized projects and local/SSH execution locations.",
    inputSchema: schema({}), metadata: true, resolveTarget: () => ({kind: "inventory", id: "projects"}), ownerCanAccess: () => true,
    execute: (_args, ctx) => ({projects: db.listProjectsForPrincipal(ctx.owner, true).filter(p => allowedProject(ctx.connection.id, p.id))})});
  operations.register({name: "runner_list", description: "Discover authorized runners and actual agent capabilities, including SSH locations. Reconnect offline runners before execution.",
    inputSchema: schema({}), metadata: true, resolveTarget: () => ({kind: "inventory", id: "runners"}), ownerCanAccess: () => true,
    execute: (_args, ctx) => {
      const locations = db.listProjectsForPrincipal(ctx.owner, true).filter(p => allowedProject(ctx.connection.id, p.id)).flatMap(p => p.locations);
      return {runners: db.listRunnersForPrincipal(ctx.owner).filter(r => ctx.connection.grant.projects === "all" || locations.some(l => l.runnerId === r.runnerId)).map(r => ({
        runnerId: r.runnerId, displayName: r.displayName, hostname: r.hostname, os: r.os, status: r.status, protocolVersion: r.protocolVersion,
        locations: locations.filter(l => l.runnerId === r.runnerId),
        agents: r.agents.map(a => ({id: a.id, name: a.name, driver: a.driver, context: a.context, available: a.available,
          authStatus: a.authStatus, capabilities: a.capabilities, version: a.version}))}))};
    }});
  operations.register({name: "session_list", description: "List authorized sessions across projects, including unrelated sessions.",
    inputSchema: schema({archived: {type: "boolean"}}), metadata: true, resolveTarget: () => ({kind: "inventory", id: "sessions"}), ownerCanAccess: () => true,
    execute: (args, ctx) => ({sessions: db.listSessionsForPrincipal(ctx.owner, object(args).archived === true).filter(s => allowedProject(ctx.connection.id, s.projectId)).map(summary)})});
  operations.register({name: "session_get", description: "Read current authorized session status and latest result.",
    inputSchema: schema({sessionId: string}, ["sessionId"]), resolveTarget: sessionTarget, ownerCanAccess: canAccess,
    execute: args => {
      const s = db.getSession(text(object(args), "sessionId"))!;
      return {session: {...summary(s), preview: s.preview, attention: s.attention, holds: s.holds,
        stopOperation: s.stopOperation}};
    }});
  operations.register({name: "session_messages", description: "Read a bounded page of authorized transcript text and response completion boundaries; continue after nextAfterSeq for results.",
    inputSchema: schema({sessionId: string, afterSeq: {type: "integer", minimum: 0}}, ["sessionId"]), resolveTarget: sessionTarget, ownerCanAccess: canAccess,
    execute: value => {
      const args = object(value), after = args.afterSeq ?? 0;
      if (!Number.isSafeInteger(after) || (after as number) < 0) throw new AssistantRefusal("afterSeq must be a nonnegative integer.");
      const id = text(args, "sessionId"), page = db.listCachedEventPage(id, after as number, 100);
      return {...page, events: page.events.filter(e => e.payload.kind === "agent_message" || e.payload.kind === "user_message" || e.payload.kind === "agent_response_completed")
        .filter(e => !('parentToolUseId' in e.payload) || !e.payload.parentToolUseId)
        .map(e => ({seq: e.seq, ts: e.ts, kind: e.payload.kind, ...('text' in e.payload ? {text: e.payload.text} : {})})), eventEpoch: db.getSession(id)?.eventEpoch};
    }});
  const mutation = (name: string, description: string, inputSchema: Record<string, unknown>, resolveTarget: (args: unknown) => AssistantTarget,
    run: (args: Record<string, unknown>, owner: Parameters<SessionsService["promptFromHuman"]>[0], origin?: AssistantSessionWorkOrigin) => ServiceResult<SessionView> | Promise<ServiceResult<SessionView>>) => {
    operations.register({name, description, inputSchema, resolveTarget, ownerCanAccess: canAccess, execute: async (value, context) => {
      const args = object(value), commandId = text(args, "commandId");
      if (args.workOriginId !== undefined && !hooks.authenticatedOrigin && !hooks.associateCommand) throw new AssistantRefusal("Work-origin tracking is not registered on this control plane. Enable the Assistant work tracking extension before submitting correlated commands.");
      const owner = await context.recheck();
      const current = db.assistantConnections.get(context.connection.id)!;
      const {confirmationId, ...requestArgs} = args;
      const argumentsDigest = assistantRequestDigest(requestArgs), target = resolveTarget(args);
      const destructive = name === "session_stop" || name === "session_archive";
      const confirm = destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
      const confirmationBinding = {connectionId: current.id, grantRevision: current.revision, operation: name, argumentsDigest,
        targetDigest: assistantRequestDigest(target)};
      if (!receipts.get(current.id, commandId) && confirm && confirmationId === undefined) {
        return {confirmationRequired: true, ...confirmations.issue(confirmationBinding), operation: name,
          target: summary(db.getSession(target.id)!),
          recovery: "Review this exact target, then repeat the same command ID and arguments with confirmationId before expiry. No command was dispatched."};
      }
      let sessionOrigin: AssistantSessionWorkOrigin | undefined;
      const reserved = receipts.reserve({controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId,
        operation: name, argumentsDigest, grantRevision: current.revision, target},
        receipt => {
          if (confirm) {
            if (typeof confirmationId !== "string") throw new AssistantRefusal("A confirmationId from this exact command's preview is required.");
            confirmations.consume(confirmationId, confirmationBinding);
          }
          const authenticated = hooks.authenticatedOrigin?.(receipt);
          if (authenticated) {
            if (name !== "session_launch" && name !== "session_prompt") throw new AssistantRefusal("Work-origin tracking supports launch and follow-up commands. Use an uncorrelated lifecycle command instead.");
            if (args.workOriginId !== undefined && args.workOriginId !== authenticated.workId) throw new AssistantRefusal("Work origin does not match the authenticated command envelope.");
            const store = workStore();
            if (!store) throw new AssistantRefusal("Assistant work tracking is unavailable. Install the work tracking extension before submitting correlated commands.");
            store.reserveOrigin(current.id, {commandId, ...authenticated, ...(receipt.target.projectId ? {projectId: receipt.target.projectId} : {})});
            sessionOrigin = {connectionId: current.id, commandId};
            if (name === "session_prompt") store.attachAcceptedOrigin(sessionOrigin, receipt.target.id);
          } else if (hooks.authenticatedOrigin && args.workOriginId !== undefined) {
            throw new AssistantRefusal("No authenticated requester envelope matches this command. Submit it through the trusted connector ingress.");
          }
          hooks.associateCommand?.(args, receipt);
        });
      if (!reserved.created) return {receipt: reserved.receipt, recovery: "Command already reserved. Reconcile receipt and target; never dispatch again. Accepted after interruption means uncertain delivery."};
      try {
        const result = await run(args, owner, sessionOrigin);
        return {receipt: receipts.settle(current.id, commandId, result.ok ? "succeeded" : "failed", result.data?.id),
          ...(result.ok ? {sessionId: result.data?.id} : {error: result.error,
            capabilityRequirement: result.capabilityRequirement, errorDetails: result.errorDetails,
            recovery: "Use the reported lifecycle/worktree recovery in this session's Wollipog detail, then submit a new command ID."}),
          meaning: result.ok ? "Application service accepted the command. Read the session for execution/lifecycle completion." : "Service refused the command. Correct the reported cause before submitting a new command."};
      } catch (error) {
        if (error instanceof AssistantRefusal) {
          return {receipt: receipts.settle(current.id, commandId, "failed"), error: error.message};
        }
        return {receipt: receipts.settle(current.id, commandId, "uncertain"), recovery: "Service outcome uncertain. Inspect receipt and target in Wollipog; never blindly repeat this command."};
      }
    }});
  };
  const launchTarget = (value: unknown): AssistantTarget => {
    const location = db.getProjectLocation(text(object(value), "locationId"));
    if (!location) throw new AssistantRefusal("Location not found. Refresh project_list and select a current location.");
    return {kind: "project", id: location.projectId, projectId: location.projectId};
  };
  mutation("session_launch", "Launch work in an authorized project/location using its local or SSH runner. Reconcile commandId before retrying.",
    schema({commandId: commandProperties.commandId, workOriginId: commandProperties.workOriginId, locationId: string, agentId: string, providerAccountId: string, prompt: string, title: string, useWorktree: {type: "boolean"}, config: {type: "object"}}, ["commandId", "locationId", "agentId"]), launchTarget,
    (args, owner, assistantWorkOrigin) => {
      const location = db.getProjectLocation(text(args, "locationId"))!;
      if (!db.canAccessRunner(owner, location.runnerId) || !db.canAccessWorkspace(owner, location.runnerId, location.workspaceId)) throw new AssistantRefusal("The owner cannot access this Location's runner/workspace. Restore access in Project and Machine settings.");
      const request: CreateSessionRequest = {runnerId: location.runnerId, workspaceId: location.workspaceId, projectId: location.projectId,
        projectLocationId: location.id, agentId: text(args, "agentId"),
        ...(typeof args.providerAccountId === "string" ? {providerAccountId: args.providerAccountId} : {}),
        ...(typeof args.prompt === "string" ? {prompt: args.prompt} : {}), ...(typeof args.title === "string" ? {title: args.title} : {}),
        ...(typeof args.useWorktree === "boolean" ? {useWorktree: args.useWorktree} : {}),
        ...(args.config && typeof args.config === "object" && !Array.isArray(args.config) ? {config: args.config} : {})};
      return svc.createSession(request, undefined, db.projectScope(location.projectId) ?? undefined, false, false, false,
        {defaultOwnerUserId: owner.userId, launcherUserId: owner.userId, ...(assistantWorkOrigin ? {assistantWorkOrigin} : {}),
          orchestratorDefaults: orchestratorSettings.view(owner),
          validateOrchestratorDefaults: defaults => orchestratorSettings.compatibilityError(owner, defaults)});
    });
  mutation("session_prompt", "Send a follow-up to any authorized session. Reconcile commandId before retrying a lost response.",
    schema({...commandProperties, text: string}, ["commandId", "sessionId", "text"]), sessionTarget,
    (args, owner) => svc.promptFromUser(owner.userId, text(args, "sessionId"), text(args, "text")));
  mutation("session_stop", "Stop through the owner's lifecycle service. Owner-selected confirm policy returns a preview; repeat unchanged arguments with its confirmationId.", schema({...commandProperties, confirmationId: string}, ["commandId", "sessionId"]), sessionTarget,
    args => svc.stop(text(args, "sessionId")));
  mutation("session_restart", "Restart with existing worktree/provider recovery checks; optionally unarchive or wait for a busy provider home.",
    schema({...commandProperties, unarchive: {type: "boolean"}, waitForProviderHome: {type: "boolean"}}, ["commandId", "sessionId"]), sessionTarget,
    args => svc.restart(text(args, "sessionId"), {unarchive: args.unarchive === true, waitForProviderHome: args.waitForProviderHome === true}));
  mutation("session_archive", "Archive through the owner's stop-before-archive service. Owner-selected confirm policy returns a preview; repeat unchanged arguments with its confirmationId.", schema({...commandProperties, confirmationId: string}, ["commandId", "sessionId"]), sessionTarget,
    args => svc.setArchived(text(args, "sessionId"), true));
  operations.register({name: "command_get", description: "Reconcile caller commandId before retrying. Accepted/uncertain means never blindly replay. Rechecks current source access.",
    inputSchema: schema({commandId: string}, ["commandId"]), metadata: true, resolveTarget: () => ({kind: "inventory", id: "commands"}), ownerCanAccess: () => true,
    execute: (args, ctx) => {
      const receipt = receipts.get(ctx.connection.id, text(object(args), "commandId"));
      if (!receipt) return {receipt: null};
      if (receipt.target.kind === "assistant_connection" && db.assistantConnections.get(receipt.target.id)?.revoked) {
        // Reconcile only the caller's retained verdict, never revoked connection metadata.
        // The original operation still validates its grant, all-project scope and exact owner.
        // This server-only target cannot be selected by ordinary mutation arguments.
        operations.authorize(ctx.connection.id, receipt.operation, {kind: "assistant_connection_receipt", id: receipt.target.id});
        return {resourceRevoked: true, receipt: {operationId: receipt.operationId, operation: receipt.operation,
          status: receipt.status, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt},
          recovery: "The target connection was revoked. This is the retained command verdict only; do not replay the command."};
      }
      if ((receipt.target.kind === "session" && !db.getSession(receipt.target.id)) ||
          (receipt.target.kind === "project" && !db.getProject(receipt.target.id))) {
        // Reconcile only this connection's content-free command verdict after source deletion.
        // Original project access remains mandatory; never substitute a live result or transcript.
        operations.authorize(ctx.connection.id, receipt.operation, receipt.target.kind === "project"
          ? {kind: "receipt", id: receipt.operationId, projectId: receipt.target.id}
          : receipt.target.projectId
            ? {kind: "project", id: receipt.target.projectId, projectId: receipt.target.projectId}
            : {kind: "receipt", id: receipt.operationId});
        return {resourceDeleted: true, receipt: {operationId: receipt.operationId, operation: receipt.operation,
          status: receipt.status, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt},
          recovery: "The source resource was deleted. This is the retained command verdict only; do not replay the original command."};
      }
      const target = receipt.target.kind === "session" ? sessionTarget({sessionId: receipt.target.id}) : receipt.target;
      operations.authorize(ctx.connection.id, receipt.operation, target);
      if (receipt.resourceId && db.getSession(receipt.resourceId)) {
        operations.authorize(ctx.connection.id, receipt.operation, sessionTarget({sessionId: receipt.resourceId}));
      }
      return {receipt, recovery: receipt.status === "accepted" || receipt.status === "uncertain" ? "Inspect target and owner's command/lifecycle recovery paths. Do not repeat." : "Read resulting resource for current state."};
    }});
  return receipts;
}
