import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";
import type { Hub } from "./hub.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { OwnerManagement } from "./owner-management.js";
import { AssistantRefusal, type AssistantOperations, type AssistantOperation, type AssistantTarget } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";
import { withVisibleCampaignChildren, withCampaignWorkForResponse } from "./session-command-permissions.js";
import { lookupSessionById } from "./session-lookup-route.js";

/** Exact owner paths; query fields retain the owner's cursor/epoch/revision validation. */
export const ASSISTANT_STATUS_ROUTES = [
  ["session_status", "GET /api/sessions/:id"],
  ["session_lookup", "GET /api/sessions/lookup/by-id"],
  ["session_archive_list", "GET /api/sessions/archive-page"],
  ["session_usage", "GET /api/sessions/:id/usage"],
  ["session_events", "GET /api/sessions/:id/events"],
  ["session_history", "GET /api/sessions/:id/history-preview"],
  ["session_children", "GET /api/sessions/:id/child-sessions"],
  ["worktree_ops", "GET /api/sessions/:id/worktrees/operations"],
  ["reminder_get", "GET /api/sessions/:id/reminder"],
  ["reminder_set", "PUT /api/sessions/:id/reminder"],
  ["reminder_remove", "DELETE /api/sessions/:id/reminder"],
  ["result_ack", "POST /api/sessions/:id/result/acknowledge"],
  ["result_handoff", "POST /api/sessions/:id/result/handoff"],
  ["result_blocked_ack", "POST /api/sessions/:id/background-deliveries/acknowledge-blocked-results"],
  ["result_missing_ack", "POST /api/sessions/:id/background-deliveries/:continuationId/acknowledge-missing-result"],
  ["result_retry_ack", "POST /api/sessions/:id/background-deliveries/:continuationId/acknowledge-retry-exhaustion"],
  ["review_list", "GET /api/sessions/:id/review-sessions"],
  ["review_get", "GET /api/sessions/:id/review-sessions/:reviewSessionId"],
  ["review_findings", "GET /api/sessions/:id/review-findings"],
  ["review_jobs", "GET /api/sessions/:id/cross-model-reviews"],
  ["review_job", "GET /api/sessions/:id/cross-model-reviews/:jobId"],
  ["review_job_artifacts", "GET /api/sessions/:id/cross-model-reviews/:jobId/artifacts"],
  ["decision_list", "GET /api/sessions/:id/workflow-decisions"],
  ["decision_get", "GET /api/sessions/:id/workflow-decisions/:occurrenceId"],
  ["request_list", "GET /api/sessions/:id/descendant-requests"],
  ["campaign_behavior", "GET /api/sessions/:id/orchestrator-campaign/behavior"],
  ["campaign_status", "GET /api/sessions/:id/campaign/summary"],
  ["campaign_decisions", "GET /api/sessions/:id/campaign/decisions"],
  ["campaign_items", "GET /api/sessions/:id/campaign/work-items"],
  ["campaign_item", "GET /api/sessions/:id/campaign/work-items/:itemId"],
  ["campaign_recommendations", "GET /api/sessions/:id/campaign/recommendations"],
  ["campaign_scope", "GET /api/sessions/:id/campaign/issue-scope"],
  ["campaign_get", "GET /api/sessions/:id/orchestrator-campaign"],
  ["campaign_work_items", "GET /api/sessions/:id/orchestrator-campaign/work-items"],
  ["campaign_work_item", "GET /api/sessions/:id/orchestrator-campaign/work-items/:itemId"],
  ["campaign_review_jobs", "GET /api/sessions/:id/orchestrator-campaign/review-jobs"],
  ["campaign_review_job", "GET /api/sessions/:id/orchestrator-campaign/review-jobs/:jobId"],
  ["campaign_review_report", "GET /api/sessions/:id/orchestrator-campaign/review-jobs/:jobId/report"],
] as const;

const string = {type: "string"};
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AssistantRefusal("Supply an object.");
  return v as Record<string, unknown>;
}
function coordinate(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new AssistantRefusal(`${key} must be a bounded visible coordinate.`);
  return value;
}

/** Owner management only: no session impersonation, review launches, approvals or scope changes. */
export function registerAssistantStatusOperations(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; svc: SessionsService; hub: Hub; receipts: AssistantCommandReceipts;
  status: OwnerManagement<AuthPrincipal>; campaign: OwnerManagement<AuthPrincipal>; scope: OwnerManagement<AuthPrincipal>; additional?: OwnerManagement<AuthPrincipal>;
}) {
  const {db, receipts} = deps;
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  const target = (value: unknown): AssistantTarget => {
    const session = db.getSession(coordinate(object(value), "sessionId"));
    if (!session) throw new AssistantRefusal("Session not found. Refresh session_list.");
    return {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
  };
  const canAccess: AssistantOperation["ownerCanAccess"] = (owner, value) => value.kind === "inventory" || db.canAccessSession(owner, value.id);
  for (const [name, route] of ASSISTANT_STATUS_ROUTES) {
    const mutate = !route.startsWith("GET "), inventory = name === "session_archive_list";
    const parameters = [...route.matchAll(/:([A-Za-z]+)/gu)].map(match => match[1]!).filter(key => key !== "id");
    const destructive = mutate;
    const resolveTarget = inventory ? () => ({kind: "inventory", id: "archive"}) : target;
    const properties = { ...(!inventory ? {sessionId: string} : {}),
      ...Object.fromEntries(parameters.map(key => [key, string])),
      query: {type: "object", additionalProperties: {type: "string"}, description: "The owner read API's query fields, including exact paging cursors/epochs. Values are strings."},
      ...(mutate ? {commandId: string, confirmationId: string, payload: {type: "object", description: "The owner API's request fields, including exact revision or reminder compare-and-set fields."}} : {})};
    operations.register({name,
      description: `${mutate ? "Manage" : "Read"} ${name.replaceAll("_", " ")}. ${mutate ? "Use a stable commandId; reconcile command_get after a lost response." : "Uses the owner read service; grants no action authority."}`,
      inputSchema: {type: "object", additionalProperties: false, properties,
        required: [...(!inventory ? ["sessionId"] : []), ...parameters, ...(mutate ? ["commandId"] : [])]},
      ...(inventory ? {metadata: true} : {}), resolveTarget, ownerCanAccess: canAccess,
      execute: async (value, ctx) => {
        const args = object(value);
        if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new AssistantRefusal("Unknown operation argument.");
        const body = args.payload === undefined ? {} : object(args.payload);
        const query = args.query === undefined ? {} : {...object(args.query)};
        if (Object.values(query).some(v => typeof v !== "string")) throw new AssistantRefusal("Query values must be strings.");
        if (name === "reminder_get" && query.protocolVersion === undefined) query.protocolVersion = String(PROTOCOL_VERSION);
        // Lookup uses an opaque query id on HTTP. It must never differ from the authorized target.
        if (name === "session_lookup") {
          if (query.id !== undefined && query.id !== args.sessionId) throw new AssistantRefusal("Lookup id must match sessionId.");
          query.id = coordinate(args, "sessionId");
        }
        const params = {...(!inventory ? {id: coordinate(args, "sessionId")} : {}),
          ...Object.fromEntries(parameters.map(key => [key, coordinate(args, key)]))};
        const authorizeRelated = (sessionId?: string) => {
          if (inventory && !sessionId) return;
          const id = sessionId ?? params.id!;
          // Aggregated campaign/request reads may include sessions from other projects. Refuse
          // before reading any payload when the connection cannot inspect every contributor.
          const root = db.campaignRootForMember(id);
          const related = new Set<string>();
          if ((name.startsWith("campaign_") || name === "session_status" || name === "session_lookup" || inventory) && root) {
            related.add(root);
            db.campaignDescendantIds(root).forEach(s => related.add(s));
            for (const attempts of db.campaignWorkLedger.attemptSessionIdsByItem(root).values()) {
              attempts.forEach(s => {if (s && db.getSession(s)) related.add(s);});
            }
          }
          if (name === "request_list") db.listSessions({includeArchived: true}).filter(s => db.isSessionDescendant(id, s.id)).forEach(s => related.add(s.id));
          if (name === "result_handoff") {
            const controller = db.sessionResultOrchestrator(id);
            if (controller) related.add(controller);
          }
          for (const sessionId of related) operations.authorize(ctx.connection.id, name, target({sessionId}));
        };
        await ctx.recheck();
        if (name === "campaign_get" && db.assistantConnections.get(ctx.connection.id)!.grant.projects !== "all") {
          throw new AssistantRefusal("The full campaign projection includes installation-wide Machine capabilities. Use campaign_status and the scoped campaign reads, or an all-project connection.");
        }
        authorizeRelated();
        const service = [deps.status, deps.campaign, deps.scope, ...(deps.additional ? [deps.additional] : [])].find(s => s.keys().includes(route));
        if (!service && name !== "session_lookup") throw new AssistantRefusal("The shared owner service is unavailable. Upgrade this control plane.");
        const invoke = async () => {
          const result = name === "session_lookup" ? lookupSessionById(db, ctx.owner, params.id, session => deps.hub.withQueue(session, true))
            : await service!.execute(route, {principal: ctx.owner, params, query,
          body,
          projectIds: db.assistantConnections.get(ctx.connection.id)!.grant.projects === "all" ? undefined
            : db.assistantConnections.get(ctx.connection.id)!.grant.projects as string[]});
          // The HTTP owner adapter applies these shared projections before serialization. MCP
          // needs exactly the same reader-specific filtering, without an HTTP/session identity.
          return {...result, body: withCampaignWorkForResponse(db, ctx.owner, withVisibleCampaignChildren(db, ctx.owner, result.body))};
        };
        if (!mutate) {
          const result = await invoke();
          await ctx.recheck();
          authorizeRelated();
          if (inventory && result.status < 400) {
            for (const session of (result.body as {sessions: {id: string}[]}).sessions) authorizeRelated(session.id);
          }
          return result;
        }
        const commandId = coordinate(args, "commandId"), current = db.assistantConnections.get(ctx.connection.id)!;
        const {confirmationId, ...request} = args;
        const digest = assistantRequestDigest(request), resolved = resolveTarget(args);
        const identity = {controlPlaneId: db.instanceId(), connectionId: current.id, operationId: commandId,
          operation: name, argumentsDigest: digest, grantRevision: current.revision, target: resolved};
        if (receipts.get(current.id, commandId)) return {receipt: receipts.reserve(identity).receipt};
        const session = db.getSession(params.id!);
        const impact = {attention: session?.attention, reminder: db.getSessionReminder(params.id!, ctx.owner.userId)};
        const binding = {connectionId: current.id, grantRevision: current.revision, operation: name,
          argumentsDigest: digest, targetDigest: assistantRequestDigest({target: resolved, impact})};
        const confirm = destructive && db.assistantConnections.destructiveConfirmation(current.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...confirmations.issue(binding), target: resolved, impact};
        receipts.reserve(identity, () => {if (confirm) confirmations.consume(coordinate(args, "confirmationId"), binding);});
        try {
          const result = await invoke();
          const receipt = receipts.settle(current.id, commandId, result.status < 400 ? "succeeded" : result.status < 500 ? "failed" : "uncertain");
          await ctx.recheck();
          return {receipt, ...result};
        } catch {
          const receipt = receipts.get(current.id, commandId)!;
          return {receipt: receipt.status === "accepted" ? receipts.settle(current.id, commandId, "uncertain") : receipt,
            recovery: "Read command_get and current session state under authorized access. Never replay this command."};
        }
      }});
  }
}
