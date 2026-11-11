import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { validParentControlCoordinate } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { SessionsService } from "./sessions.js";
import { failureBody } from "./capability-refusal.js";
import { OwnerManagement, type OwnerManagementInput, type OwnerManagementReply } from "./owner-management.js";

/** Owner HTTP and Assistant adapters share the services and their exact validation/lineage rules.
 * The registry never accepts a credential or an asserted session actor in its arguments. */
export function createCampaignReviewManagement(deps: {
  db: ControlPlaneDb; svc: SessionsService;
  behaviorView(id: string, human: HumanPrincipal): ReturnType<SessionsService["campaignBehaviorView"]>;
  holdReader(principal: AuthPrincipal): Parameters<SessionsService["descendantRequests"]>[4];
}): OwnerManagement<AuthPrincipal> {
  const {db, svc} = deps, management = new OwnerManagement<AuthPrincipal>();
  type Input = OwnerManagementInput<AuthPrincipal>;
  const sessionId = (input: Input) => (input.params as {id: string}).id;
  const canAccess = (input: Input, id: string) => db.canAccessSession(input.principal, id) && (!input.access || input.access.session(id));
  const respond = (reply: OwnerManagementReply, result: {ok: boolean; status: number; data?: unknown; error?: string}) =>
    reply.code(result.status).send(result.ok ? result.data : failureBody(result));
  const visible = (input: Input, reply: OwnerManagementReply) => {
    if (!canAccess(input, sessionId(input))) {reply.code(404).send({error: "session not found"}); return false;}
    return true;
  };
  const reviewsVisible = (input: Input, reply: OwnerManagementReply) => {
    if (input.principal.kind === "agent" && input.principal.credentialSessionId !== sessionId(input)) {
      reply.code(404).send({error: "session not found"}); return false;
    }
    return visible(input, reply);
  };
  const decisionsVisible = (input: Input, reply: OwnerManagementReply) => {
    const principal = input.principal, id = sessionId(input);
    if (principal.kind === "agent" && principal.credentialSessionId !== id &&
        !(principal.orchestrator && principal.credentialSessionId && canAccess(input, principal.credentialSessionId) && db.isSessionDescendant(principal.credentialSessionId, id))) {
      reply.code(404).send({error: "session not found"}); return false;
    }
    return visible(input, reply);
  };
  management.define("GET", "/api/sessions/:id/orchestrator-campaign/behavior", (input, reply) => {
    if (input.principal.kind !== "human") return reply.code(403).send({error: "only an authenticated human may change campaign behavior"});
    if (!visible(input, reply)) return;
    reply.header("cache-control", "no-store");
    return respond(reply, deps.behaviorView(sessionId(input), input.principal));
  });
  management.define("GET", "/api/sessions/:id/descendant-requests", (input, reply) => {
    if (!visible(input, reply)) return;
    const principal = input.principal, id = sessionId(input);
    if (principal.kind === "agent" && principal.credentialSessionId !== id) return reply.code(404).send({error: "session not found"});
    return respond(reply, svc.descendantRequests(id, target => canAccess(input, target), principal.kind === "agent" ? "orchestrator" : "human", true, deps.holdReader(principal)));
  });
  management.define("GET", "/api/sessions/:id/review-sessions", (input, reply) => {
    if (!reviewsVisible(input, reply)) return;
    const query = input.query as {limit?: string; afterReviewSessionId?: string};
    reply.header("cache-control", "no-store");
    return respond(reply, svc.reviewSessionsPage(sessionId(input), {
      ...(query.limit === undefined ? {} : {limit: Number(query.limit)}),
      ...(query.afterReviewSessionId === undefined ? {} : {afterReviewSessionId: query.afterReviewSessionId}),
    }));
  });
  management.define("GET", "/api/sessions/:id/review-sessions/:reviewSessionId", (input, reply) => {
    if (!reviewsVisible(input, reply)) return;
    reply.header("cache-control", "no-store");
    return respond(reply, svc.reviewSessionView(sessionId(input), (input.params as {reviewSessionId: string}).reviewSessionId));
  });
  management.define("GET", "/api/sessions/:id/workflow-decisions", (input, reply) => {
    if (!decisionsVisible(input, reply)) return;
    const query = input.query as {cursor?: string; limit?: string}, limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.cursor !== undefined && !validParentControlCoordinate(query.cursor)) {
      return reply.code(400).send({error: "invalid workflow decision page"});
    }
    reply.header("cache-control", "no-store");
    return respond(reply, svc.workflowDecisions(sessionId(input), query.cursor, limit));
  });
  management.define("GET", "/api/sessions/:id/workflow-decisions/:occurrenceId", (input, reply) => {
    if (!decisionsVisible(input, reply)) return;
    const {occurrenceId} = input.params as {occurrenceId: string};
    if (!validParentControlCoordinate(occurrenceId)) return reply.code(400).send({error: "invalid occurrenceId"});
    reply.header("cache-control", "no-store");
    return respond(reply, svc.workflowDecision(sessionId(input), occurrenceId));
  });
  management.define("GET", "/api/sessions/:id/review-findings", (input, reply) => {
    if (!visible(input, reply)) return;
    return respond(reply, svc.reviewFindings(sessionId(input)));
  });
  for (const [method, path, operation] of [
    ["POST", "/api/sessions/:id/review-findings", "create"],
    ["PATCH", "/api/sessions/:id/review-findings/:findingId", "update"],
    ["POST", "/api/sessions/:id/review-findings/bundle", "bundle"],
  ] as const) management.define(method, path, async (input, reply) => {
    if (!visible(input, reply)) return;
    if (input.principal.kind !== "human" || input.principal.role === "viewer") return reply.code(403).send({error: "human operator identity is required"});
    await input.recheck?.();
    if (!visible(input, reply)) return;
    const id = sessionId(input), actor = {kind: "human" as const, id: input.principal.userId};
    return respond(reply, operation === "create" ? svc.createReviewFinding(id, input.body, actor)
      : operation === "update" ? svc.updateReviewFinding(id, (input.params as {findingId: string}).findingId, input.body, actor)
        : svc.bundleReviewFindings(id, input.body));
  });
  management.define("POST", "/api/sessions/:id/orchestrator-campaign/cleanup/delete-merged-branches", async (input, reply) => {
    if (input.principal.kind !== "human" || input.principal.role === "viewer") return reply.code(403).send({error: "only an authenticated human may ask Wollipog to delete merged branches"});
    if (!visible(input, reply)) return;
    return respond(reply, await svc.deleteApprovedMergedBranches(sessionId(input), id => canAccess(input, id), input.recheck));
  });
  return management;
}
