import {
  ASSISTANT_EVIDENCE_INSPECT,
  ASSISTANT_EVIDENCE_PREPARE,
  ASSISTANT_EVIDENCE_GET,
  DELEGATED_IMAGE_REVIEW_BRIEF_MAX_CHARS,
  assistantDecisionCategory,
  isOwnerQuestionSnapshot,
  type AssistantConnection,
  type AssistantDecisionResolution,
  type ResolveWorkflowDecisionRequest,
  type WorkflowDecisionView,
} from "@wollipog/protocol";
import { AssistantRefusal, type AssistantOperations } from "./assistant-connections.js";
import { threadDecisionDelegation } from "./assistant-thread-store.js";
import { assistantThreadDisplayTitle } from "./assistant-threads.js";
import type { ControlPlaneDb } from "./db.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HumanPrincipal } from "./identity.js";
import { isReservedOwnerQuestion, type SessionsService } from "./sessions.js";

const coordinate = { type: "string", minLength: 1, maxLength: 128 };
const sessionProperties = { sessionId: coordinate };
const occurrenceProperties = { ...sessionProperties, occurrenceId: coordinate };
const reviewReferenceProperties = { reviewId: coordinate, reviewerSessionId: coordinate, verdictId: coordinate };
const reviewReferenceSchema = { type: "object", additionalProperties: false,
  properties: reviewReferenceProperties, required: Object.keys(reviewReferenceProperties) };
const resolutionProperties = {
  ...occurrenceProperties,
  resourceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  outcome: { type: "string", enum: ["approve", "deny"] },
  reason: { type: "string", minLength: 1, maxLength: 1000 },
  selectedOptionId: coordinate,
  answer: { type: "string", minLength: 1, maxLength: 4000 },
  delegatedImageReview: reviewReferenceSchema,
};
const inspectionProperties = { ...occurrenceProperties,
  resourceDigest: resolutionProperties.resourceDigest, evidenceId: { ...coordinate, maxLength: 256 } };
/** Only the runner-facing MCP method can supply acknowledgement parameters. */
export const ASSISTANT_EVIDENCE_ACKNOWLEDGEMENT = Symbol("runner evidence acknowledgement");

function parseArgs(value: unknown, properties: object): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !Object.hasOwn(properties, key))) {
    throw new AssistantRefusal("Supply only the registered operation arguments.");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0")) {
    throw new AssistantRefusal(`${name} is required and must be at most ${limit} characters.`);
  }
  return value;
}

/**
 * Re-read the grant and all placement from the control plane. Only the resolver's own active
 * thread credential may use this route. It never accepts a grant, thread ID or snapshot to apply.
 * After the registry's live credential check, this and the storage write run synchronously.
 */
export function registerAssistantDecisionOperations(operations: AssistantOperations, db: ControlPlaneDb, svc: SessionsService): void {
  const target = (value: unknown) => {
    const sessionId = requiredText((value as { sessionId?: unknown } | null)?.sessionId, "sessionId", 128);
    const session = db.getSession(sessionId);
    return { kind: "session" as const, id: sessionId, ...(session?.projectId ? { projectId: session.projectId } : {}) };
  };
  const ownerCanAccess = (owner: HumanPrincipal, resource: { id: string }) =>
    db.canAccessSession(owner, resource.id) && db.isSessionOwner(owner, resource.id);
  const liveGrant = (owner: HumanPrincipal, connection: AssistantConnection) => {
    const thread = connection.threadId ? db.assistantThreads.get(connection.threadId) : null;
    const session = thread?.session_id ? db.getSession(thread.session_id) : null;
    if (!thread || thread.state !== "active" || thread.connection_id !== connection.id ||
        thread.owner_user_id !== owner.userId || thread.organization_id !== owner.organizationId ||
        session?.archived !== false || session.role !== "assistant") {
      throw new AssistantRefusal("Decision delegation requires a grant on an active Wollipog Assistant thread.");
    }
    const { grant, revision } = threadDecisionDelegation(thread);
    if (!grant) throw new AssistantRefusal("This Assistant thread has no decision delegation grant. Its owner can enable one in the thread menu.");
    if (grant.expiresAt !== null && Date.now() >= grant.expiresAt) throw new AssistantRefusal("This Assistant thread's decision delegation grant has expired.");
    return { grant, revision, threadId: thread.id, threadTitle: assistantThreadDisplayTitle(thread, session) };
  };
  const check = (decision: WorkflowDecisionView, owner: HumanPrincipal, connection: AssistantConnection,
    name: string, { grant }: ReturnType<typeof liveGrant>, evidenceOutcome?: "approve" | "deny") => {
    const category = assistantDecisionCategory(decision.resourceSnapshot);
    if (!category) throw new AssistantRefusal("This decision has no supported typed Assistant resolution path. Generic permissions, CI reruns and release commands require the owner.");
    const mayAct = category === "ui_evidence_approval"
      ? (evidenceOutcome !== "approve" && grant.categories.includes(category)) ||
        (evidenceOutcome !== "deny" && grant.categories.includes("ui_evidence_review"))
      : grant.categories.includes(category);
    if (!mayAct) throw new AssistantRefusal("This category is outside the thread's decision delegation grant.");
    if (decision.authority !== "human") throw new AssistantRefusal("Only owner-held decisions are eligible for Assistant delegation.");
    if (isReservedOwnerQuestion(decision)) throw new AssistantRefusal("This occurrence requires a direct human response.");
    const controller = db.getSession(decision.controllingSessionId);
    const requester = db.getSession(decision.sessionId);
    if (!controller || !requester || !db.campaignOwnerUser(controller.id, owner.userId) ||
        !ownerCanAccess(owner, requester) || !ownerCanAccess(owner, controller)) {
      throw new AssistantRefusal("The decision is outside this owner's sessions.");
    }
    if (db.assistantThreads.forSession(controller.id)?.id === connection.threadId ||
        db.assistantThreads.forSession(requester.id)?.id === connection.threadId) {
      throw new AssistantRefusal("A thread cannot resolve a decision it requested.");
    }
    operations.authorize(connection.id, name, target({ sessionId: controller.id }));
    const campaign = db.campaignRootForMember(requester.id) ?? controller.id;
    if (grant.campaigns !== "all" && !grant.campaigns.includes(campaign)) {
      throw new AssistantRefusal("This campaign is outside the thread's decision delegation grant.");
    }
    if (grant.projects !== "all" && [requester, controller].some((session) =>
      !session.projectId || !grant.projects.includes(session.projectId))) {
      throw new AssistantRefusal("This project is outside the thread's decision delegation grant.");
    }
    const snapshot = decision.resourceSnapshot;
    if ("repository" in snapshot && (grant.projects !== "all" || connection.grant.projects !== "all") &&
        db.campaignSessionRepository(campaign, requester.id)?.toLowerCase() !== snapshot.repository.toLowerCase()) {
      throw new AssistantRefusal("The decision repository could not be verified in the requesting session's granted project.");
    }
    return { category, campaign };
  };
  const list = "assistant_decisions_list", get = "assistant_decision_get", resolve = "assistant_decision_resolve";
  operations.register({
    name: ASSISTANT_EVIDENCE_INSPECT, threadOnly: true,
    description: "Inspect one private Session screenshot of a pending UI evidence decision. Use the digest from assistant_decision_get. Look at each returned image before approving.",
    inputSchema: { type: "object", additionalProperties: false, properties: inspectionProperties,
      required: ["sessionId", "occurrenceId", "resourceDigest", "evidenceId"] },
    resolveTarget: target, ownerCanAccess,
    execute(value, { owner, connection }) {
      const args = parseArgs(value, inspectionProperties) as Record<string, unknown> & {
        [ASSISTANT_EVIDENCE_ACKNOWLEDGEMENT]?: { receiptId: unknown; sha256: unknown };
      };
      const live = liveGrant(owner, connection);
      const decision = db.workflowDecisionByOccurrence(requiredText(args.occurrenceId, "occurrenceId", 128));
      if (!decision || decision.sessionId !== args.sessionId || decision.resourceSnapshot.category !== "ui_evidence_approval" ||
          decision.resourceDigest !== args.resourceDigest) {
        throw new AssistantRefusal("Read the exact pending UI evidence decision and use its current resource digest.");
      }
      check(decision, owner, connection, ASSISTANT_EVIDENCE_INSPECT, live, "approve");
      const evidenceId = requiredText(args.evidenceId, "evidenceId", 256);
      const acknowledgement = args[ASSISTANT_EVIDENCE_ACKNOWLEDGEMENT];
      const result = acknowledgement
        ? svc.acknowledgeAssistantUiEvidence(decision, live.threadId, evidenceId,
          requiredText(acknowledgement.receiptId, "receiptId", 128), requiredText(acknowledgement.sha256, "sha256", 64))
        : svc.deliverAssistantUiEvidence(decision, live.threadId, evidenceId);
      if (!result.ok) throw new AssistantRefusal(result.error ?? "Wollipog refused the evidence review.");
      return result.data;
    },
  });
  for (const name of [ASSISTANT_EVIDENCE_PREPARE, ASSISTANT_EVIDENCE_GET]) {
    const preparing = name === ASSISTANT_EVIDENCE_PREPARE;
    const properties = preparing
      ? { ...occurrenceProperties, resourceDigest: resolutionProperties.resourceDigest,
        brief: { type: "string", minLength: 1, maxLength: DELEGATED_IMAGE_REVIEW_BRIEF_MAX_CHARS } }
      : { ...occurrenceProperties, resourceDigest: resolutionProperties.resourceDigest, reviewId: coordinate };
    operations.register({
      name, threadOnly: true,
      description: preparing
        ? "Start a restricted managed reviewer for a pending UI evidence decision on this thread’s authorized provider. Charges the target campaign's allowance. State the UI claims and criteria."
        : "Read the exact managed screenshot review for this thread and decision. Use its delegatedImageReview reference to approve only when the verdict approves every image.",
      inputSchema: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
      resolveTarget: target, ownerCanAccess,
      execute(value, { owner, connection }) {
        const args = parseArgs(value, properties);
        const live = liveGrant(owner, connection);
        const decision = db.workflowDecisionByOccurrence(requiredText(args.occurrenceId, "occurrenceId", 128));
        if (!decision || decision.sessionId !== args.sessionId || decision.resourceSnapshot.category !== "ui_evidence_approval" ||
            decision.resourceDigest !== args.resourceDigest) {
          throw new AssistantRefusal("Read the exact pending UI evidence decision and use its current resource digest.");
        }
        check(decision, owner, connection, name, live, "approve");
        const result = preparing
          ? svc.prepareAssistantImageEvidenceReview(decision, live.threadId, requiredText(args.brief, "brief", DELEGATED_IMAGE_REVIEW_BRIEF_MAX_CHARS))
          : svc.assistantImageEvidenceReview(decision, live.threadId, requiredText(args.reviewId, "reviewId", 128));
        if (!result.ok) throw new AssistantRefusal(result.error ?? "Wollipog refused the managed evidence review.");
        return { review: result.data };
      },
    });
  }
  operations.register({
    name: list,
    threadOnly: true,
    description: "List up to 25 owner-held workflow decisions in scope of this thread's grant for a given session. Read an exact occurrence before resolving it.",
    inputSchema: { type: "object", additionalProperties: false, properties: sessionProperties, required: ["sessionId"] },
    resolveTarget: target, ownerCanAccess,
    execute(value, { owner, connection }) {
      const args = parseArgs(value, sessionProperties);
      const grant = liveGrant(owner, connection);
      const authorized = db.pendingWorkflowDecisionsForSession(requiredText(args.sessionId, "sessionId", 128)).flatMap((decision) => {
        try {
          const { category } = check(decision, owner, connection, list, grant);
          return [{ occurrenceId: decision.occurrenceId, category, createdAt: decision.createdAt }];
        } catch (error) {
          if (error instanceof AssistantRefusal) return [];
          throw error;
        }
      });
      return { decisions: authorized.slice(0, 25), hasMore: authorized.length > 25 };
    },
  });
  for (const name of [get, resolve]) {
    const resolving = name === resolve;
    const properties = resolving ? resolutionProperties : occurrenceProperties;
    operations.register({
      name,
      threadOnly: true,
      description: resolving
        ? "Resolve an exact owner-held workflow decision under the current thread grant. Use the digest from assistant_decision_get and state your reason. No generic permissions or owner confirmations."
        : "Read an exact owner-held workflow decision including its binding digest, status and any delegated resolution.",
      inputSchema: { type: "object", additionalProperties: false, properties,
        required: resolving ? ["sessionId", "occurrenceId", "resourceDigest", "outcome", "reason"] : ["sessionId", "occurrenceId"] },
      resolveTarget: target, ownerCanAccess,
      execute(value, { owner, connection }) {
        const args = parseArgs(value, properties);
        const live = liveGrant(owner, connection);
        const decision = db.workflowDecisionByOccurrence(requiredText(args.occurrenceId, "occurrenceId", 128));
        if (!decision || decision.sessionId !== args.sessionId) {
          throw new AssistantRefusal("No typed workflow decision matches this occurrence in the session. Generic permissions, CI reruns and release commands require the owner.");
        }
        const { outcome, resourceDigest } = args;
        const { campaign } = check(decision, owner, connection, name, live,
          outcome === "approve" || outcome === "deny" ? outcome : undefined);
        if (!resolving) return { decision: svc.workflowDecision(decision.sessionId, decision.occurrenceId).data };
        if (outcome !== "approve" && outcome !== "deny") throw new AssistantRefusal("Choose approve or deny.");
        if (resourceDigest !== decision.resourceDigest) throw new AssistantRefusal("The decision snapshot changed. Read the exact occurrence again.");
        const reason = requiredText(args.reason, "reason", 1000).trim();
        const delegation: AssistantDecisionResolution = {
          threadId: live.threadId, threadTitle: live.threadTitle, ownerUserId: owner.userId, organizationId: owner.organizationId,
          grantRevision: live.revision, campaignId: campaign, reason,
        };
        const review = args.delegatedImageReview === undefined ? undefined : parseArgs(args.delegatedImageReview, reviewReferenceProperties);
        const resolution: ResolveWorkflowDecisionRequest = { outcome,
          ...(args.selectedOptionId !== undefined ? { selectedOptionId: requiredText(args.selectedOptionId, "selectedOptionId", 128) } : {}),
          ...(args.answer !== undefined ? { childMessage: requiredText(args.answer, "answer", 4000) } : {}),
          ...(review ? { delegatedImageReview: {
            reviewId: requiredText(review.reviewId, "reviewId", 128),
            reviewerSessionId: requiredText(review.reviewerSessionId, "reviewerSessionId", 128),
            verdictId: requiredText(review.verdictId, "verdictId", 128),
          } } : {}),
        };
        const result = svc.resolveAssistantDecision(decision, resolution, delegation, owner);
        if (!result.ok) throw new AssistantRefusal(result.error ?? "Wollipog refused the delegated decision.");
        return { decision: result.data, question: isOwnerQuestionSnapshot(decision.resourceSnapshot) };
      },
    });
  }
}

export function registerAssistantDecisionHistory(app: FastifyInstance, db: ControlPlaneDb,
  requestHuman: (request: FastifyRequest) => HumanPrincipal | null): void {
  app.get("/api/assistant-decision-history", (request, reply) => {
    const owner = requestHuman(request);
    if (owner?.role !== "owner") return reply.code(403).send({ error: "Only the owner can read their Assistant decision history." });
    const { campaignId, threadId, before } = request.query as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(id);
    const cursor = typeof before === "string" ? /^(\d{1,16}):([a-zA-Z0-9_-]{1,128})$/u.exec(before) : null;
    if ((campaignId !== undefined && !validId(campaignId)) || (threadId !== undefined && !validId(threadId)) ||
        (before !== undefined && !cursor)) return reply.code(400).send({ error: "Invalid decision history filter." });
    reply.header("cache-control", "no-store");
    return db.assistantDecisionHistory(owner, { campaignId, threadId,
      ...(cursor ? { before: { at: Number(cursor[1]), id: cursor[2]! } } : {}),
    });
  });
}
