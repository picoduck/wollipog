import type {ExternalSessionDescriptor, SessionRole} from "@wollipog/protocol";
import {AssistantRefusal, type AssistantOperations} from "./assistant-connections.js";
import type {AssistantCommandReceipts} from "./assistant-command-receipts.js";
import type {ControlPlaneDb} from "./db.js";
import type {SessionsService, ServiceResult} from "./sessions.js";
import {AssistantSessionManagement, sessionArgumentObject as obj, sessionArgumentText as text, type SessionManagementContext} from "./assistant-session-management.js";
import {OwnerManagement, type OwnerManagementReply, type OwnerManagementResult} from "./owner-management.js";
import type {createSessionLifecycleManagement} from "./session-lifecycle-management.js";
import type {SessionRoleConversions} from "./session-role-conversion.js";
import {OrchestratorSettings} from "./orchestrator-settings.js";
import {failureBody} from "./capability-refusal.js";

const str = {type: "string"}, bool = {type: "boolean"}, nullable = {type: ["string", "null"]};
export const ASSISTANT_SESSION_LIFECYCLE_ROUTES = {
  "POST /api/sessions/:id/project": "session_project",
  "POST /api/sessions/:id/workspace": "session_workspace",
  "POST /api/sessions/:id/column": "session_column",
  "POST /api/sessions/:id/retitle": "session_retitle",
  "POST /api/sessions/:id/rewind": "session_rewind",
  "POST /api/sessions/:id/fork": "session_fork",
  "POST /api/sessions/:id/reprocess": "session_reprocess",
  "DELETE /api/sessions/:id": "session_delete",
  "POST /api/sessions/adopt": "session_adopt",
  "GET /api/sessions/:id/role": "session_role_get",
  "POST /api/sessions/:id/role": "session_role",
} as const;

export function registerAssistantSessionLifecycle(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; svc: SessionsService; receipts: AssistantCommandReceipts;
  lifecycle: ReturnType<typeof createSessionLifecycleManagement>; roles: SessionRoleConversions;
}) {
  const {db, svc, receipts, lifecycle, roles} = deps;
  const adapter = new AssistantSessionManagement(operations, db, receipts), settings = new OrchestratorSettings(db);
  const response = (r: ServiceResult<unknown>): OwnerManagementResult => ({status: r.status, body: r.ok ? r.data : failureBody(r)});
  const invoke = (ctx: SessionManagementContext, handler: (reply: OwnerManagementReply) => unknown) => {
    const service = new OwnerManagement();
    service.define("POST", "/operation", (_input, reply) => handler(reply));
    return service.execute("POST /operation", {principal: ctx.owner, params: {}, body: {}, query: {}});
  };
  const authorizedSession = (id: string, operation: string, ctx: SessionManagementContext) => {
    const s = db.getSession(id);
    if (!s) throw new AssistantRefusal("Affected session is unavailable.");
    operations.authorize(ctx.connection.id, operation, {kind: "session", id, ...(s.projectId ? {projectId: s.projectId} : {})});
    return s;
  };
  const placement = (operation: string, destination: string | null, ctx: SessionManagementContext) => {
    const grant = db.assistantConnections.get(ctx.connection.id)!.grant;
    if (destination === null) {
      if (grant.projects !== "all") throw new AssistantRefusal("Moving work outside Projects requires an all-project grant.");
    } else {
      if (grant.projects !== "all" && !grant.projects.includes(destination)) throw new AssistantRefusal("Destination project is excluded by this connection.");
      if (!db.canAccessProject(ctx.owner, destination)) throw new AssistantRefusal("Destination project is unavailable.");
    }
  };
  adapter.register({name: "session_project", description: "Move session grouping to an exact Project using the owner service. Checks source and destination; preserves execution directory and owner Location-link rules.",
    properties: {projectId: nullable, linkLocation: bool}, required: ["projectId"], mutate: true,
    check: (a, ctx) => {
      if (a.projectId !== null && typeof a.projectId !== "string") throw new AssistantRefusal("projectId must be a string or null.");
      placement("session_project", a.projectId as string | null, ctx);
      if (a.linkLocation && db.assistantConnections.get(ctx.connection.id)!.grant.projects !== "all") {
        const s = db.getSession(text(a, "sessionId"))!;
        const workspace = db.resolveAdoptedSessionLinkWorkspace(s.id)?.workspaceId;
        const grant = db.assistantConnections.get(ctx.connection.id)!.grant.projects;
        if (!workspace || !db.listProjectsForPrincipal(ctx.owner, true).some(p => (grant === "all" || grant.includes(p.id)) && p.locations.some(l => l.runnerId === s.runnerId && l.workspaceId === workspace && l.availability !== "runner_removed"))) {
          throw new AssistantRefusal("Linking an ungranted Machine folder requires an all-project grant. Ask the owner to link the Location first.");
        }
      }
    },
    run: (a, ctx) => invoke(ctx, reply => lifecycle.project(text(a, "sessionId"), {projectId: a.projectId, linkLocation: a.linkLocation}, ctx.owner, reply, ctx.recheck))});
  adapter.register({name: "session_workspace", description: "Use the owner's legacy workspace grouping adapter. This preserves the launch directory; both resulting Project and workspace access must be granted.",
    properties: {workspaceId: nullable}, required: ["workspaceId"], mutate: true,
    check: (a, ctx) => {
      if (a.workspaceId !== null && typeof a.workspaceId !== "string") throw new AssistantRefusal("workspaceId must be a string or null.");
      const s = db.getSession(text(a, "sessionId"))!;
      if (a.workspaceId && !db.canAccessWorkspace(ctx.owner, s.runnerId, a.workspaceId as string)) throw new AssistantRefusal("Workspace is unavailable.");
      placement("session_workspace", a.workspaceId ? db.findProjectLocation(s.runnerId, a.workspaceId as string)?.projectId ?? null : null, ctx);
    }, run: (a, ctx) => invoke(ctx, reply => lifecycle.workspace(text(a, "sessionId"), {workspaceId: a.workspaceId}, ctx.owner, reply, ctx.recheck))});
  adapter.register({name: "session_column", description: "Move a session's board column through the owner service; lifecycle constraints remain enforced.",
    properties: {column: {type: "string", enum: ["queued", "running", "input_required", "review", "done"]}}, required: ["column"], mutate: true,
    check: a => {if (!["queued", "running", "input_required", "review", "done"].includes(a.column as string)) throw new AssistantRefusal("column must be queued, running, input_required, review or done.");},
    run: a => response(svc.setColumn(text(a, "sessionId"), a.column as Parameters<SessionsService["setColumn"]>[1]))});
  adapter.register({name: "session_retitle", description: "Regenerate the display title using the owner's naming service. Does not send a prompt into the execution session.", mutate: true,
    run: async a => response(await svc.retitleSession(text(a, "sessionId")))});
  adapter.register({name: "session_rewind", description: "Restore files from a turn checkpoint, preserving the conversation. Requires an idle worktree and owner-selected destructive confirmation.",
    properties: {turn: {type: "integer", minimum: 1}}, required: ["turn"], mutate: true, destructive: true,
    impact: a => {const s = db.getSession(text(a, "sessionId"))!; return {sessionId: s.id, projectId: s.projectId, worktreePath: s.worktreePath, turn: a.turn, eventEpoch: s.eventEpoch, status: s.status};},
    run: (a, ctx) => invoke(ctx, reply => lifecycle.rewind(text(a, "sessionId"), {turn: a.turn}, ctx.owner, reply, ctx.recheck))});
  adapter.register({name: "session_fork", description: "Fork a safe conversation checkpoint or use the recorded quarantine recovery. Handoff may choose an already available harness and model/effort/serviceTier only; standing permission and budget grants cannot change.",
    properties: {turn: {type: "integer", minimum: 1}, recovery: bool, handoff: {type: "object", additionalProperties: false, properties: {agentId: str, config: {type: "object", additionalProperties: false, properties: {model: str, effort: str, serviceTier: str}}}, required: ["agentId", "config"]}}, required: ["turn"], mutate: true,
    check: a => {
      if (a.handoff !== undefined) {
        const handoff = obj(a.handoff), config = obj(handoff.config);
        if (Object.keys(handoff).some(k => !["agentId", "config"].includes(k)) || Object.keys(config).some(k => !["model", "effort", "serviceTier"].includes(k))) throw new AssistantRefusal("Handoff cannot change permission, budget, guardrails or provider access. Use owner settings for those grants.");
      }
    }, run: (a, ctx) => invoke(ctx, reply => lifecycle.fork(text(a, "sessionId"), {turn: a.turn, recovery: a.recovery, handoff: a.handoff}, ctx.owner, reply, ctx.recheck))});
  adapter.register({name: "session_reprocess", description: "Re-import an idle adopted session's transcript through the owner service. Replaces history, so destructiveConfirmation applies.", mutate: true, destructive: true,
    impact: a => {const s = db.getSession(text(a, "sessionId"))!, history = db.getRunnerHistoryState(s.id), cached = db.sessionEventSnapshot(s.id); return {sessionId: s.id, eventEpoch: s.eventEpoch, status: s.status, adopted: s.adopted, tailSeq: history?.tailSeq, logEpoch: history?.historyEpoch, cachedThroughSeq: cached.throughSeq, cachedEventCount: cached.eventCount};},
    run: async (a, ctx) => response(await svc.reprocessSession(text(a, "sessionId"), ctx.recheck))});
  adapter.register({name: "session_delete", description: "Delete a session and its side chat using owner lifecycle/tombstone and terminal cleanup. Requires current access to every affected session and destructive confirmation.", mutate: true, destructive: true, deletesTarget: true,
    check: (a, ctx) => {const child = db.getSideChat(text(a, "sessionId"))?.childSessionId; if (child) authorizedSession(child, "session_delete", ctx);},
    impact: (a, ctx) => [text(a, "sessionId"), db.getSideChat(text(a, "sessionId"))?.childSessionId].filter((id): id is string => !!id).map(id => {
      const s = authorizedSession(id, "session_delete", ctx); return {id, projectId: s.projectId, runnerId: s.runnerId, status: s.status, worktreePath: s.worktreePath};
    }), run: (a, ctx) => invoke(ctx, reply => lifecycle.remove(text(a, "sessionId"), reply))});
  adapter.register({name: "session_adopt", description: "Adopt an external provider session on an owner-managed runner, using its authoritative descriptor/snapshot. Requires all-project authority because imported placement is runner-owned.",
    target: value => ({kind: "runner", id: text(obj(value), "runnerId")}), properties: {runnerId: str, descriptor: {type: "object"}, backfill: bool}, required: ["runnerId", "descriptor"], mutate: true,
    check: a => {const descriptor = obj(a.descriptor); if (typeof descriptor.agentSessionId !== "string" || !descriptor.agentSessionId.trim()) throw new AssistantRefusal("descriptor.agentSessionId is required."); if (a.backfill !== undefined && typeof a.backfill !== "boolean") throw new AssistantRefusal("backfill must be a boolean.");},
    run: async (a, ctx) => response(await svc.adoptSession(text(a, "runnerId"), a.descriptor as ExternalSessionDescriptor, a.backfill !== false, ctx.recheck))});
  const role = {type: "string", enum: ["normal", "orchestrator"]};
  const roleValue = (v: unknown): SessionRole => {if (v !== "normal" && v !== "orchestrator") throw new AssistantRefusal("role must be normal or orchestrator."); return v;};
  const preview = (a: Record<string, unknown>, ctx: SessionManagementContext) => roles.preview(text(a, "sessionId"), roleValue(a.role), settings.view(ctx.owner), policy => settings.compatibilityError(ctx.owner, policy));
  const affectedRole = (a: Record<string, unknown>, ctx: SessionManagementContext) => [text(a, "sessionId"), ...db.campaignDescendantIds(text(a, "sessionId"))].map(id => {
    const s = authorizedSession(id, "session_role", ctx); return {id, projectId: s.projectId, role: s.role, status: s.status};
  });
  adapter.register({name: "session_role_get", description: "Preview a role conversion under current saved owner defaults and the existing campaign policy. No standing policy override is accepted.",
    properties: {role}, required: ["role"], run: (a, ctx) => ({status: 200, body: preview(a, ctx)})});
  adapter.register({name: "session_role", description: "Convert a session role using the shared two-phase service and saved owner policy only. Preserves provider permissions, budgets, first-message authority and campaign restrictions; arbitrary Orchestrator overrides require the owner settings path.",
    properties: {role, expectedRole: role}, required: ["role", "expectedRole"], mutate: true, destructive: true,
    check: (a, ctx) => {roleValue(a.role); roleValue(a.expectedRole); affectedRole(a, ctx);},
    impact: (a, ctx) => ({sessions: affectedRole(a, ctx), preview: preview(a, ctx)}),
    run: async (a, ctx) => {
      const id = text(a, "sessionId");
      try {
        await roles.change(id, roleValue(a.role), roleValue(a.expectedRole), settings.view(ctx.owner), policy => settings.compatibilityError(ctx.owner, policy));
        return {status: 200, body: db.getSession(id)};
      } catch (error) {
        const pending = db.sessionRoleConversion(id);
        if (pending && pending.state !== "applied") return {status: 502, body: {error: "Role conversion remains pending. Inspect the durable conversion state before retrying."}};
        return {status: 409, body: {error: error instanceof Error ? error.message : "Role conversion refused."}};
      }
    }});
}
