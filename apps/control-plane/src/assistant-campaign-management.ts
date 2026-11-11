import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { validParentControlCoordinate } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";
import type { OwnerManagement } from "./owner-management.js";
import { AssistantRefusal, type AssistantOperation, type AssistantOperations, type AssistantTarget } from "./assistant-connections.js";
import { AssistantCommandReceipts, assistantRequestDigest } from "./assistant-command-receipts.js";
import { AssistantCommandConfirmations } from "./assistant-command-confirmations.js";

export const ASSISTANT_CAMPAIGN_MANAGEMENT = [
  ["campaign_summary", "GET /api/sessions/:id/campaign/summary"],
  ["campaign_decisions", "GET /api/sessions/:id/campaign/decisions"],
  ["campaign_scope", "GET /api/sessions/:id/campaign/issue-scope"],
  ["campaign_recs", "GET /api/sessions/:id/campaign/recommendations"],
  ["campaign_items", "GET /api/sessions/:id/campaign/work-items"],
  ["campaign_item", "GET /api/sessions/:id/campaign/work-items/:itemId"],
  ["campaign_forge_refresh", "POST /api/sessions/:id/campaign/work-items/:itemId/forge-refresh"],
  ["desc_request_list", "GET /api/sessions/:id/descendant-requests"],
  ["campaign_behavior", "GET /api/sessions/:id/orchestrator-campaign/behavior"],
  ["campaign_branch_clean", "POST /api/sessions/:id/orchestrator-campaign/cleanup/delete-merged-branches"],
  ["review_find_list", "GET /api/sessions/:id/review-findings"],
  ["review_find_add", "POST /api/sessions/:id/review-findings"],
  ["review_find_set", "PATCH /api/sessions/:id/review-findings/:findingId"],
  ["review_find_send", "POST /api/sessions/:id/review-findings/bundle"],
  ["review_list", "GET /api/sessions/:id/review-sessions"],
  ["review_get", "GET /api/sessions/:id/review-sessions/:reviewSessionId"],
  ["decision_list", "GET /api/sessions/:id/workflow-decisions"],
  ["decision_get", "GET /api/sessions/:id/workflow-decisions/:occurrenceId"],
] as const;

const str = {type: "string"}, obj = {type: "object"};
const descriptions: Record<string, string> = {
  campaign_summary: "Read campaign progress, obligations and visible cost totals. Requires access to every Project represented in the aggregate.",
  campaign_decisions: "Read campaign decision verdicts and their separate usage without resolving or classifying them.",
  campaign_scope: "Inspect authorized campaign issues and bounded forge candidates. This cannot propose or expand human scope authority.",
  campaign_recs: "List campaign follow-up recommendations with the owner's visibility and bounded query filters.",
  campaign_items: "List campaign work items with revisioned pagination, visible attempts, costs and forge dependencies.",
  campaign_item: "Read one exact campaign work item and its visible attempt and verification history.",
  campaign_forge_refresh: "Refresh one work item's authorized forge observations using its existing observing runner. This approves no forge action.",
  desc_request_list: "Inspect visible descendant requests and recovery advice. Listing requests grants no answering or approval authority.",
  campaign_behavior: "Read campaign Child Harness, Model, Effort, Follow-Ups and Completion. Changes remain on human settings paths.",
  campaign_branch_clean: "Perform only already-approved campaign branch deletions. Requires a commandId and any configured destructive confirmation; existing forge safety checks still apply.",
  review_find_list: "Read current inline review findings and their status summary.",
  review_find_add: "Create an inline review finding. Supply commandId and payload scope, diffHash, filePath, side, line, body, severity and required, with optional anchorText.",
  review_find_set: "Update a local finding using payload status and expectedUpdatedAt. Resolve/dismiss honors destructive confirmation. Remote-owned findings require the forge's own thread update.",
  review_find_send: "Send unresolved findings to the session as ordinary review instructions. Supply commandId and payload findings containing findingId and expectedUpdatedAt. This approves no action.",
  review_list: "List controlled review sessions for a session with bounded query pagination.",
  review_get: "Read one controlled review session, its state, validated verdict and findings.",
  decision_list: "List a session's nonterminal workflow decisions. Reading them grants no resolution or consumption authority.",
  decision_get: "Read one exact workflow decision, including its authoritative terminal state and owner.",
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssistantRefusal("Supply an object of arguments.");
  return value as Record<string, unknown>;
}
function coordinate(value: unknown, key: string): string {
  if (!validParentControlCoordinate(value)) throw new AssistantRefusal(`${key} must be a valid resource coordinate.`);
  return value as string;
}

/** Transport-independent operations. No session credential is minted, selected or impersonated. */
export function registerAssistantCampaignManagement(operations: AssistantOperations, deps: {
  db: ControlPlaneDb; svc: SessionsService; receipts: AssistantCommandReceipts; services: OwnerManagement<AuthPrincipal>[];
}): void {
  const {db, receipts} = deps;
  AssistantCommandConfirmations.install(db.raw());
  const confirmations = new AssistantCommandConfirmations(db.raw());
  type Context = Parameters<AssistantOperation["execute"]>[1];
  const target = (value: unknown): AssistantTarget => {
    const args = object(value), session = db.getSession(coordinate(args.sessionId, "sessionId"));
    if (!session) throw new AssistantRefusal("Session not found.");
    return {kind: "session", id: session.id, ...(session.projectId ? {projectId: session.projectId} : {})};
  };
  // A campaign view can embed other sessions and detached ledger attempts. Refuse an aggregate
  // across excluded Projects rather than releasing unfiltered subjects, costs or recommendations.
  // The shared service still applies the owner's narrower row/forge/cost visibility projections.
  const scope = (args: Record<string, unknown>, ctx: Context, name: string, owner: HumanPrincipal) => {
    const id = coordinate(args.sessionId, "sessionId"), root = db.campaignRootForMember(id) ?? id;
    const grant = db.assistantConnections.get(ctx.connection.id)!.grant;
    if (grant.projects !== "all") {
      const ids = new Set([id, root, ...db.campaignDescendantIds(root),
        ...[...db.campaignWorkLedger.attemptSessionIdsByItem(root).values()].flat().filter((value): value is string => value !== null)]);
      if ([...ids].some(sessionId => {
        const project = db.getSession(sessionId)?.projectId;
        return !project || !grant.projects.includes(project);
      })) throw new AssistantRefusal("The campaign includes resources outside this connection's granted Projects. Use an authorized connection or the owner's Campaign Status.");
    }
    if (name === "campaign_branch_clean") {
      for (const item of db.campaignLeftovers(root)?.cleanup ?? []) {
        if (item.kind !== "merged_branch" || item.action.kind !== "delete_merged_branches") continue;
        const decision = db.workflowDecisionByOccurrence(item.action.occurrenceId);
        if (decision && !db.canAccessSession(owner, decision.sessionId)) throw new AssistantRefusal("Campaign cleanup includes resources the granting owner cannot manage.");
      }
    }
  };
  for (const [name, route] of ASSISTANT_CAMPAIGN_MANAGEMENT) {
    const service = deps.services.find(candidate => candidate.keys().includes(route));
    if (!service) throw new Error(`Missing shared campaign operation ${route}`);
    const mutation = name === "campaign_branch_clean" || name === "review_find_add" || name === "review_find_set" || name === "review_find_send";
    const parameters = [...route.matchAll(/:([A-Za-z]+)/g)].map(match => match[1]!).filter(key => key !== "id");
    const properties: Record<string, unknown> = {sessionId: str, ...Object.fromEntries(parameters.map(key => [key, str])),
      ...(mutation ? {commandId: str, confirmationId: str, ...(name === "campaign_branch_clean" ? {} : {payload: obj})} : {query: obj})};
    operations.register({name, description: descriptions[name]!,
      inputSchema: {type: "object", additionalProperties: false, properties,
        required: ["sessionId", ...parameters, ...(mutation ? ["commandId", ...(name === "campaign_branch_clean" ? [] : ["payload"])] : [])]},
      resolveTarget: target,
      ownerCanAccess: (owner, resource) => resource.kind === "session" && db.canAccessSession(owner, resource.id),
      execute: async (value, ctx) => {
        const args = object(value);
        if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new AssistantRefusal("Unknown campaign-management argument.");
        const params = {id: coordinate(args.sessionId, "sessionId"), ...Object.fromEntries(parameters.map(key => [key, coordinate(args[key], key)]))};
        const body = mutation && name !== "campaign_branch_clean" ? object(args.payload) : {};
        const query = args.query === undefined ? {} : object(args.query);
        let owner = await ctx.recheck();
        scope(args, ctx, name, owner);
        const revision = db.assistantConnections.get(ctx.connection.id)!.revision;
        const recheck = async () => {
          owner = await ctx.recheck();
          if (db.assistantConnections.get(ctx.connection.id)?.revision !== revision) throw new AssistantRefusal("The connection changed during this operation. Reconcile under current authority.");
          scope(args, ctx, name, owner);
          return owner;
        };
        const currentOwner = () => {
          const connection = db.assistantConnections.get(ctx.connection.id);
          if (!connection || connection.revoked || connection.revision !== revision) return null;
          const principal = db.operatingHumanPrincipal(connection.ownerUserId, connection.organizationId);
          return principal?.role === "owner" ? principal : null;
        };
        const access = {
          session: (id: string) => {
            const principal = currentOwner(), session = db.getSession(id), grant = db.assistantConnections.get(ctx.connection.id)?.grant;
            return !!principal && !!session && !!grant && db.canAccessSession(principal, id) &&
              (grant.projects === "all" || !!session.projectId && grant.projects.includes(session.projectId));
          },
          runner: (id: string) => {
            const principal = currentOwner(), grant = db.assistantConnections.get(ctx.connection.id)?.grant;
            return !!principal && !!grant && db.canAccessRunner(principal, id) && (grant.projects === "all" ||
              db.listProjectsForPrincipal(principal, true).some(project => grant.projects.includes(project.id) && project.locations.some(location => location.runnerId === id && location.availability !== "runner_removed")));
          },
        };
        const execute = () => service.execute(route, {principal: owner, params, body, query, recheck, access});
        if (!mutation) {
          const result = await execute();
          await recheck();
          return result;
        }
        const commandId = coordinate(args.commandId, "commandId"), {confirmationId, ...request} = args;
        const identity = {controlPlaneId: db.instanceId(), connectionId: ctx.connection.id, operationId: commandId, operation: name,
          argumentsDigest: assistantRequestDigest(request), grantRevision: revision, target: target(args)};
        if (receipts.get(ctx.connection.id, commandId)) return {receipt: receipts.reserve(identity).receipt};
        const impact = name === "review_find_set" ? db.listReviewFindings(params.id).filter(finding => finding.findingId === args.findingId)
          .map(({findingId, updatedAt, status, required}) => ({findingId, updatedAt, status, required}))
          : name === "campaign_branch_clean" ? (db.campaignLeftovers(params.id)?.cleanup ?? []).flatMap(item => {
            if (item.kind !== "merged_branch" || item.action.kind !== "delete_merged_branches") return [];
            const decision = db.workflowDecisionByOccurrence(item.action.occurrenceId);
            return decision ? [{occurrenceId: decision.occurrenceId, sessionId: decision.sessionId, digest: decision.resourceDigest,
              status: decision.status, resource: decision.resourceSnapshot}] : [];
          }) : undefined;
        const destructive = name === "campaign_branch_clean" || name === "review_find_set" && (body.status === "resolved" || body.status === "dismissed");
        const binding = {connectionId: ctx.connection.id, grantRevision: revision, operation: name,
          argumentsDigest: identity.argumentsDigest, targetDigest: assistantRequestDigest({target: identity.target, impact: impact ?? null})};
        const confirm = destructive && db.assistantConnections.destructiveConfirmation(ctx.connection.id) === "confirm";
        if (confirm && confirmationId === undefined) return {confirmationRequired: true, ...confirmations.issue(binding),
          operation: name, target: identity.target, impact, recovery: "Review the affected scope and repeat unchanged arguments and commandId with confirmationId before expiry."};
        const reservation = receipts.reserve(identity, () => {
          operations.authorize(ctx.connection.id, name, target(args));
          scope(args, ctx, name, owner);
          if (confirm) confirmations.consume(coordinate(confirmationId, "confirmationId"), binding);
        });
        if (!reservation.created) return {receipt: reservation.receipt};
        try {
          const result = await execute();
          const receipt = receipts.settle(ctx.connection.id, commandId, result.status < 400 ? "succeeded" : result.status >= 500 ? "uncertain" : "failed");
          await recheck();
          return {receipt, ...result, meaning: "Application service accepted or refused the command; inspect current state. Never redispatch an accepted or uncertain receipt."};
        } catch {
          return {receipt: receipts.settle(ctx.connection.id, commandId, "uncertain"), recovery: "Result unavailable or outcome uncertain. Inspect command_get under current authority; do not replay."};
        }
      }});
  }
}
