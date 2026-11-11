import type { SessionConfig } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService, ServiceResult } from "./sessions.js";
import { AssistantRefusal, type AssistantOperations, type AssistantTarget, type AssistantOperation } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { OwnerManagement, type OwnerManagementResult } from "./owner-management.js";
import type { createSessionWorktreeManagement } from "./session-worktree-management.js";

const str = {type: "string"};
const obj = {type: "object"};
const configurationSchema = {type: "object", additionalProperties: false, properties: {model: str, effort: str, serviceTier: str},
  description: "Model, effort and service tier only. Permission and guardrail changes require authenticated owner settings."};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an object of arguments.");
  return value as Record<string, unknown>;
}
function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new AssistantRefusal(`${key} is required.`);
  return value;
}

export const ASSISTANT_PROJECT_MANAGEMENT = [
  ["project_create", "POST /api/projects", true, false],
  ["project_update", "PATCH /api/projects/:id", true, false],
  ["project_delete", "DELETE /api/projects/:id", true, true],
  ["location_add", "POST /api/projects/:id/locations", true, false],
  ["location_create", "POST /api/projects/:id/locations/new", true, false],
  ["location_move", "POST /api/projects/:id/locations/move", true, true],
  ["location_remove", "DELETE /api/projects/:id/locations/:locationId", true, true],
  ["location_rename", "PATCH /api/projects/:id/locations/:locationId", true, false],
  ["location_default", "POST /api/projects/:id/locations/:locationId/default", true, false],
  ["location_setup_get", "GET /api/projects/:id/locations/:locationId/worktree-setup", false, false],
  ["location_setup_generate", "POST /api/projects/:id/locations/:locationId/worktree-setup", true, false],
  ["project_notice_dismiss", "PUT /api/projects/:id/worktree-setup-notice/dismiss", true, false],
  ["project_archive_sessions", "POST /api/projects/:id/archive-sessions", true, true],
] as const;

/** Additional owner management through the same services, sharing #4464's receipt namespace. */
export function registerAssistantOwnerManagement(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; svc: SessionsService; receipts: AssistantCommandReceipts;
  projects: OwnerManagement; runners: OwnerManagement;
  worktree: ReturnType<typeof createSessionWorktreeManagement>;
}) {
  const {db, svc, receipts, projects, runners, worktree} = deps;
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  const sessionTarget = (value: unknown): AssistantTarget => {
    const session = db.getSession(text(object(value), "sessionId"));
    if (!session) throw new AssistantRefusal("Session not found. Refresh session_list.");
    return {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
  };
  const access: AssistantOperation["ownerCanAccess"] = (owner, target) => target.kind === "session"
    ? db.canAccessSession(owner, target.id) : target.kind === "project" ? db.canAccessProject(owner, target.id)
      : target.kind === "runner" ? db.canManageRunner(owner, target.id) : target.kind === "inventory" || target.kind === "receipt";
  type Context = Parameters<AssistantOperation["execute"]>[1];
  const define = (name: string, description: string, properties: Record<string, unknown>, required: string[],
    target: (args: unknown) => AssistantTarget, mutate: boolean, destructive: boolean,
    execute: (args: Record<string, unknown>, ctx: Context) => Promise<OwnerManagementResult> | OwnerManagementResult,
    impact?: (args: Record<string, unknown>) => unknown) => {
    operations.register({name, description,
      inputSchema: {type: "object", additionalProperties: false,
        properties: {...properties, ...(mutate ? {commandId: str, confirmationId: str} : {})},
        required: [...required, ...(mutate ? ["commandId"] : [])]},
      resolveTarget: target, ownerCanAccess: access,
      execute: async (value, ctx) => {
        const args = object(value);
        await ctx.recheck();
        if (!mutate) {
          const result = await execute(args, ctx);
          await ctx.recheck();
          return result;
        }
        const commandId = text(args, "commandId");
        const {confirmationId, ...request} = args;
        const current = db.assistantConnections.get(ctx.connection.id)!;
        const resolved = target(args), digest = assistantRequestDigest(request);
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: name,
          argumentsDigest: digest, targetDigest: assistantRequestDigest({target: resolved, impact: impact?.(args) ?? null})};
        const confirm = destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (!receipts.get(current.id, commandId) && confirm && confirmationId === undefined) {
          return {confirmationRequired: true, ...confirmations.issue(binding), operation: name, target: resolved,
            impact: impact?.(args), recovery: "Review the affected scope; repeat unchanged arguments and commandId with confirmationId before expiry."};
        }
        const reservation = receipts.reserve({controlPlaneId: db.instanceId(), connectionId: current.id,
          operationId: commandId, operation: name, argumentsDigest: digest, grantRevision: current.revision, target: resolved}, () => {
          if (confirm) confirmations.consume(text(args, "confirmationId"), binding);
        });
        if (!reservation.created) return {receipt: reservation.receipt, recovery: "Already reserved. Read the resource and receipt; never redispatch an accepted or uncertain command."};
        try {
          const result = await execute(args, ctx);
          const body = result.body as {project?: {id?: string}} | undefined;
          const receipt = receipts.settle(current.id, commandId, result.status < 400 ? "succeeded" : result.status >= 500 ? "uncertain" : "failed", body?.project?.id);
          // Access changes during asynchronous work cannot release private results to stale grants.
          // Destructive success may remove its target: return only the receipt in that case.
          if (destructive && result.status < 400) return {receipt, meaning: "Service accepted; inspect current resource/lifecycle state."};
          await ctx.recheck();
          return {receipt, ...result};
        } catch (error) {
          if (error instanceof AssistantRefusal) return {receipt: receipts.settle(current.id, commandId, "failed"), error: error.message};
          return {receipt: receipts.settle(current.id, commandId, "uncertain"),
            recovery: "Outcome uncertain or access changed. Inspect command_get and current resource under authorized access; do not replay."};
        }
      }});
  };
  const result = (r: ServiceResult<unknown>): OwnerManagementResult => ({status: r.status,
    body: r.ok ? r.data : {error: r.error, capabilityRequirement: r.capabilityRequirement, errorDetails: r.errorDetails}});
  define("session_config_get", "Read current session configuration and its owner-controlled limits before proposing a change.", {sessionId: str}, ["sessionId"], sessionTarget, false, false,
    args => {
      const session = db.getSession(text(args, "sessionId"))!;
      return {status: 200, body: {model: session.model, effort: session.effort, serviceTier: session.serviceTier,
        permissionMode: session.permissionMode, costBudgetUsd: session.costBudgetUsd, maxToolCalls: session.maxToolCalls, maxChildSessions: session.maxChildSessions}};
    });
  define("worktree_get", "Read managed worktrees and the current recovery incident before choosing a recovery operation.", {sessionId: str}, ["sessionId"], sessionTarget, false, false,
    args => {
      const session = db.getSession(text(args, "sessionId"))!;
      return {status: 200, body: {worktreePath: session.worktreePath, worktrees: session.worktrees, recovery: session.worktreeRecovery}};
    });
  define("session_config", "Change session configuration using the owner's service; human authority and campaign restrictions remain enforced.",
    {sessionId: str, config: configurationSchema}, ["sessionId", "config"], sessionTarget, true, false, (args, ctx) => {
      const config = object(args.config);
      if (Object.keys(config).some(key => !["model", "effort", "serviceTier"].includes(key))) {
        throw new AssistantRefusal("Permission, budget and guardrail changes require the owner's authenticated Session settings path. Assistant configuration supports model, effort and serviceTier.");
      }
      return result(svc.setConfig(text(args, "sessionId"), config as SessionConfig, {kind: "agent", id: ctx.connection.id}));
    });
  define("session_title", "Rename a session, including while its runner is offline.", {sessionId: str, title: str}, ["sessionId", "title"], sessionTarget, true, false,
    args => result(svc.setTitle(text(args, "sessionId"), args.title)));
  define("session_retry_stop", "Retry the existing durable Stop operation; preserve runner lifecycle recovery.", {sessionId: str}, ["sessionId"], sessionTarget, true, true,
    args => result(svc.retryStop(text(args, "sessionId"))));
  define("session_cancel", "Cancel the current turn using the owner lifecycle service.", {sessionId: str}, ["sessionId"], sessionTarget, true, true,
    async args => result(await svc.cancelTurn(text(args, "sessionId"))));
  define("session_unarchive", "Restore session visibility through the owner service without restarting it.", {sessionId: str}, ["sessionId"], sessionTarget, true, false,
    args => result(svc.setArchived(text(args, "sessionId"), false)));
  define("session_unarchive_restart", "Restore and restart in one owner-service operation after lifecycle preflight.", {sessionId: str}, ["sessionId"], sessionTarget, true, false,
    args => result(svc.unarchiveAndRestart(text(args, "sessionId"))));
  define("steering_list", "Inspect durable steering submissions before resolving uncertain delivery.", {sessionId: str}, ["sessionId"], sessionTarget, false, false,
    args => ({status: 200, body: {attempts: db.listSteeringAttempts(text(args, "sessionId"))}}));
  define("steering_get", "Read an exact steering submission and its current durable resolution.", {sessionId: str, submissionId: str}, ["sessionId", "submissionId"], sessionTarget, false, false,
    args => {
      const found = db.findSteeringAttemptBySubmission(text(args, "sessionId"), text(args, "submissionId"));
      return found ? {status: 200, body: {attempt: found.attempt}} : {status: 404, body: {error: "steering attempt not found"}};
    });
  define("steering_resolve", "Resolve a specific uncertain steering attempt through its durable owner recovery path. Queue Again can duplicate a previously delivered write; inspect before choosing it.",
    {sessionId: str, submissionId: str, action: {type: "string", enum: ["queue_again", "dismiss"]}}, ["sessionId", "submissionId", "action"], sessionTarget, true, true,
    async args => {
      if (args.action !== "queue_again" && args.action !== "dismiss") throw new AssistantRefusal("action must be queue_again or dismiss.");
      return result(await svc.resolveSteeringAttempt(text(args, "sessionId"), text(args, "submissionId"), args.action));
    });
  define("session_pending_resolve", "Recover a specific pending prompt using its existing durable command ID, without blindly repeating a launch or prompt.",
    {sessionId: str, pendingCommandId: str, action: {type: "string", enum: ["cancel", "dismiss", "retry"]}}, ["sessionId", "pendingCommandId", "action"], sessionTarget, true, true,
    args => {
      const id = text(args, "sessionId"), pending = text(args, "pendingCommandId");
      if (args.action === "cancel") return result(svc.cancelPendingPrompt(id, pending));
      if (args.action === "dismiss") return result(svc.dismissPendingPrompt(id, pending));
      if (args.action === "retry") return result(svc.retryPendingWork(id, pending));
      throw new AssistantRefusal("action must be cancel, dismiss or retry.");
    });
  define("session_job_stop", "Stop one background job on any owner-authorized session.", {sessionId: str, jobId: str}, ["sessionId", "jobId"], sessionTarget, true, true,
    async (args, ctx) => {
      if (!db.isSessionOwner(ctx.owner, text(args, "sessionId"))) throw new AssistantRefusal("Stopping background work requires the session owner's authority.");
      return result(await svc.stopBackgroundJob(text(args, "sessionId"), text(args, "jobId"), {kind: "user", userId: ctx.owner.userId}));
    });
  define("session_hold_release", "Release the exact handoff hold, ending its unfinished jobs through the owner service.", {sessionId: str, holdId: str}, ["sessionId", "holdId"], sessionTarget, true, true,
    async (args, ctx) => {
      if (!db.isSessionOwner(ctx.owner, text(args, "sessionId"))) throw new AssistantRefusal("Releasing a handoff requires the session owner's authority.");
      return result(await svc.releaseQueueHold(text(args, "sessionId"), text(args, "holdId"), {kind: "user", userId: ctx.owner.userId}));
    });
  for (const operation of ["create", "attach", "select", "discard", "retry_setup", "generate_setup"] as const) {
    define(`worktree_${operation}`, "Manage a session worktree using the owner's runner path; dirty-tree, repository and retirement safety checks remain mandatory.",
      {sessionId: str, path: str, branch: str, baseRef: str}, ["sessionId", ...(operation === "create" ? ["branch"] : operation === "generate_setup" ? [] : ["path"])],
      sessionTarget, true, operation === "discard", async (args, ctx) => {
        const input = operation === "create" ? {operation, branch: text(args, "branch"), ...(args.baseRef !== undefined ? {baseRef: text(args, "baseRef")} : {})}
          : operation === "generate_setup" ? {operation} : {operation, path: text(args, "path")};
        if (("path" in input && input.path && input.path.length > 4096) || ("branch" in input && input.branch.length > 255) ||
            ("baseRef" in input && input.baseRef!.length > 1024)) throw new AssistantRefusal("Worktree path, branch or baseRef exceeds the owner API limit.");
        const service = new OwnerManagement();
        service.define("POST", "/worktree", (_req, reply) => worktree(text(args, "sessionId"), input, ctx.owner, reply));
        return service.execute("POST /worktree", {principal: ctx.owner, params: {}, body: {}, query: {}});
      }, args => db.getSession(text(args, "sessionId"))?.worktrees);
  }
  for (const [name, route, mutate, destructive] of ASSISTANT_PROJECT_MANAGEMENT) {
    define(name, `Owner project operation: ${route}. Uses the shared owner service, current grants and durable command identity.`,
      {projectId: str, locationId: str, payload: obj}, route.includes(":id") ? ["projectId"] : [], args => {
        const values = object(args);
        if (!route.includes(":id")) return {kind: "inventory", id: "project-create"};
        const projectId = text(values, "projectId");
        return {kind: "project", id: projectId, projectId};
      }, mutate, destructive, async (args, ctx) => {
        const payload = args.payload === undefined ? {} : object(args.payload);
        if (Object.hasOwn(payload, "owner")) throw new AssistantRefusal("Resource authority selection requires the owner's authenticated access-scope path.");
        if (Object.hasOwn(payload, "childSessionDefaults")) throw new AssistantRefusal("Changing persistent child budget and tool guardrails requires authenticated owner Project settings.");
        if (route.includes(":locationId")) text(args, "locationId");
        if (name === "location_move") {
          const source = db.getProjectLocation(text(payload, "locationId"));
          if (!source) throw new AssistantRefusal("Source Location not found.");
          operations.authorize(ctx.connection.id, name, {kind: "project", id: source.projectId, projectId: source.projectId});
        }
        return projects.execute(route, {principal: ctx.owner, params: {id: args.projectId, locationId: args.locationId}, body: payload, query: {}, recheck: ctx.recheck});
      }, args => db.listSessions({includeArchived: true}).filter(s => s.projectId === args.projectId).map(s => ({id: s.id, projectId: s.projectId, locationId: s.projectLocationId})));
  }
  define("runner_capacity", "Change owner-managed runner capacity with an expected revision; protocol and ownership checks match Machine settings.",
    {runnerId: str, configuredUnits: {type: "integer", minimum: 1, maximum: 256}, expectedRevision: {type: "integer", minimum: 0}},
    ["runnerId", "configuredUnits", "expectedRevision"], args => ({kind: "runner", id: text(object(args), "runnerId")}), true, false,
    (args, ctx) => runners.execute("PUT /api/runners/:id/capacity", {principal: ctx.owner, params: {id: args.runnerId}, body: args, query: {}}));
  define("runner_capacity_get", "Read current owner-managed capacity and revision before a change.", {runnerId: str}, ["runnerId"],
    args => ({kind: "runner", id: text(object(args), "runnerId")}), false, false,
    args => ({status: 200, body: {capacity: db.machineRunnerCapacityConfiguration(text(args, "runnerId"))}}));
}
