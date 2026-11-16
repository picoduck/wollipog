import {randomUUID} from "node:crypto";
import {
 parsePullRequestMergeRequest,
 pullRequestMergeReadiness,
 sessionMergeBlockers,
 type GitActionRequest,
 type PullRequestMergeFacts,
 type PullRequestMergeReadinessResponse,
 type PullRequestMergeResponse,
 type PullRequestMergeSessionFacts,
 type RunnerProtocolCapability,
} from "@wollipog/protocol";
import {mutationAuthorizationError, PULL_REQUEST_MERGE_ROUTE} from "./identity.js";
import {sessionCommandPermissions} from "./session-command-permissions.js";
import type {ControlPlaneDb} from "./db.js";
import type {Hub} from "./hub.js";
import type {SessionsService} from "./sessions.js";
import type {OutboundEventsService} from "./outbound-events.js";
import {OwnerManagement} from "./owner-management.js";
import type {AuthPrincipal} from "./identity.js";
import {AssistantRefusal} from "./assistant-connections.js";
import {capabilityRefusal, failureBody} from "./capability-refusal.js";
import {gitActionAllowed, gitActionCapability, gitActionRequiresLinkedWorktree, parseGitAction} from "./git-route.js";
import {validateForgeReviewSync, validateGitHubReviewSync} from "./review-findings.js";

/** Same owner API operations and runner path; no arbitrary Git verbs or caller filesystem roots. */
export function createSessionGitManagement(deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService; outboundEvents: Pick<OutboundEventsService, "recordChecksFromSummary">;
  runnerCapabilityError(runnerId: string, capability: RunnerProtocolCapability, label: string): ReturnType<typeof capabilityRefusal> | null;
}) {
 const {db, hub, svc, outboundEvents, runnerCapabilityError} = deps;
 const management = new OwnerManagement<AuthPrincipal>();
 management.define("POST", "/api/sessions/:id/git", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.canAccessSession(req.principal, id) ? db.getSession(id) : null;
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });

  const parsed = parseGitAction((req.body ?? {}) as GitActionRequest);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const { action } = parsed;
  if (!session.worktreePath && gitActionRequiresLinkedWorktree(action)) {
    return reply.code(409).send({ error: "this git action requires a linked worktree session" });
  }
  if (!session.worktreePath) {
    const unsupported = runnerCapabilityError(
      session.runnerId,
      "gitVisibility",
      "primary-checkout Git visibility",
    );
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
  }
  const gitCapability = gitActionCapability(action);
  if (gitCapability) {
    const unsupported = runnerCapabilityError(session.runnerId, gitCapability.capability, gitCapability.label);
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
  }

  // Branch-relative diffs (all_branch / last_turn) only make sense on a worktree session; a
  // WSL in-place session has no session branch to diff against. (uncommitted reads are fine —
  // and today the worktreePath gate above already limits every git action to worktree sessions.)
  if (action.kind === "diff" && action.scope !== "uncommitted" && !session.useWorktree) {
    return reply.code(400).send({ error: `the '${action.scope}' diff scope requires a worktree session` });
  }

  // Don't mutate git mid-turn: a commit/PR while the agent is still editing would
  // capture a partial snapshot and can race the post-turn diff capture.
  const gate = gitActionAllowed(action, session.status);
  if (!gate.ok) return reply.code(409).send({ error: gate.error });
  if (!["status", "summary", "diff", "request_diff", "github_review_sync", "forge_review_sync"].includes(action.kind)) {
    const reconciliationBlock = svc.podReconciliationMutationError(id);
    if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
  }

  const requestId = randomUUID();
  // Pushing + calling gh takes longer than a quick status read.
  const timeoutMs = action.kind === "request_diff" ? 180_000
    : action.kind === "open_pr" || action.kind === "github_review_sync" || action.kind === "forge_review_sync"
    ? 60_000
    : 30_000;
  if (req.recheck) {
    await req.recheck();
    // Rechecking authority yields: a new turn or reconciliation may have started meanwhile.
    const current = db.getSession(id);
    if (!current || current.runnerId !== session.runnerId || current.worktreePath !== session.worktreePath) {
      return reply.code(409).send({error: "the Git target changed; inspect the current worktree"});
    }
    const currentGate = gitActionAllowed(action, current.status);
    if (!currentGate.ok) return reply.code(409).send({error: currentGate.error});
    if (!["status", "summary", "diff", "request_diff", "github_review_sync", "forge_review_sync"].includes(action.kind)) {
      const blocked = svc.podReconciliationMutationError(id);
      if (blocked) return reply.code(409).send({error: blocked});
    }
  }
  if (!["status", "summary", "diff", "request_diff", "github_review_sync", "forge_review_sync"].includes(action.kind)) req.beforeEffect?.();
  try {
    const result = await hub.requestFromRunner(
      session.runnerId,
      requestId,
      // timeoutMs rides along so the runner can EXPIRE a queued mutation we've already
      // reported as failed, instead of executing it late (ghost commits).
      {
        type: "git_action",
        requestId,
        sessionId: id,
        ...(session.worktreePath ? { worktreePath: session.worktreePath } : {}),
        action,
        timeoutMs,
      },
      timeoutMs,
    );
    await req.recheck?.();
    if (result.type !== "git_result") return reply.code(502).send({ error: "unexpected runner reply" });
    if (!result.ok) {
      // Typed Git failures are well-formed requests conflicting with current repository state —
      // 409, with the code so callers can distinguish stale/apply/no-repository outcomes.
      const status = result.code === "GIT_STALE" || result.code === "GIT_APPLY_FAILED" || result.code === "GIT_NO_REPOSITORY" ? 409 : 400;
      return reply.code(status).send({ error: result.error ?? "git action failed", ...(result.code ? { code: result.code } : {}) });
    }
    // Version-skew guard: an older runner without the action falls through its switch and
    // replies ok:true with empty data — forwarding that as 200 would render a mutation as a
    // silent no-op "success" in the UI. Every local diff mutation returns {status, diff}.
    if (["stage_hunk", "stage_lines", "discard_file"].includes(action.kind) &&
        (result.data?.status == null || result.data?.diff == null)) {
      return reply.code(502).send({ error: "the runner does not support this diff mutation — update the runner on this box" });
    }
    if (action.kind === "github_review_sync") {
      if (!validateGitHubReviewSync(result.data?.githubReview)) {
        return reply.code(502).send({ error: "the runner did not return GitHub review data — update the runner on this box" });
      }
      req.beforeEffect?.();
      const reconciled = svc.reconcileGitHubReviewFindings(id, result.data.githubReview);
      if (!reconciled.ok || !reconciled.data) {
        return reply.code(reconciled.status).send(failureBody(reconciled, "GitHub reviews could not be reconciled"));
      }
      const { reconciliation, findings, summary } = reconciled.data;
      return {
        ...result.data,
        reviewFindings: { findings, summary },
        reviewReconciliation: reconciliation,
      };
    }
    if (action.kind === "forge_review_sync") {
      if (!validateForgeReviewSync(result.data?.forgeReview)) {
        return reply.code(502).send({ error: "the runner did not return forge review data — update the runner on this box" });
      }
      req.beforeEffect?.();
      const reconciled = svc.reconcileForgeReviewFindings(id, result.data.forgeReview);
      if (!reconciled.ok || !reconciled.data) {
        return reply.code(reconciled.status).send(failureBody(reconciled, "Forge reviews could not be reconciled"));
      }
      const { reconciliation, findings, summary } = reconciled.data;
      return {
        ...result.data,
        reviewFindings: { findings, summary },
        reviewReconciliation: reconciliation,
      };
    }
    if (action.kind === "summary" && result.data?.summary) {
      outboundEvents.recordChecksFromSummary(id, result.data.summary);
    }
    if (action.kind === "open_pr" && result.data?.pr &&
        (result.data.pr.createdWithGh || result.data.pr.created === true)) {
      db.recordOutboundPullRequestOpened({
        sessionId: id,
        branch: result.data.pr.branch,
        pullRequestUrl: result.data.pr.url,
        now: Date.now(),
      });
    }
    return result.data ?? {};
  } catch (err) {
    if (err instanceof AssistantRefusal) throw err;
    return reply.code(504).send({ error: (err as Error).message });
  }

 });
 management.define("GET", "/api/sessions/:id/governance-audit", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!db.canAccessSession(req.principal, id)) return reply.code(404).send({error: "session not found"});
  const query = req.query as { limit?: string; before?: string };
  const rawLimit = query.limit;
  const limit = rawLimit == null ? 200 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return reply.code(400).send({ error: "limit must be an integer between 1 and 500" });
  }
  const before = typeof query.before === "string" && query.before ? query.before : undefined;
  const result = svc.governanceAuditPage(id, limit, before);
  return reply.code(result.status).send(result.ok ? result.data : failureBody(result));
});

 /**
  * #604: the readiness gate for enqueueing or merging the session's pull request. The runner reads
  * the forge facts with its own `gh` login (credentials never leave it); this route adds the
  * person's role, open Required findings and runner support, and returns every blocker. The
  * Review panel's action and #1270's Pull Request view both read it.
  */
 const mergeSessionFacts = (principal: AuthPrincipal, sessionId: string, runnerSupported: boolean): PullRequestMergeSessionFacts => {
  let requiredFindingsOpen: number | null;
  try {
   requiredFindingsOpen = db.reviewFindingSummary(sessionId).requiredUnresolved;
  } catch {
   requiredFindingsOpen = null;
  }
  const permission = sessionCommandPermissions(principal, { id: sessionId }, { ownsSession: false, isDescendant: false }).mergePullRequest;
  return { roleRefusal: permission && !permission.allowed ? permission.reason : null, runnerSupported, requiredFindingsOpen };
 };

 management.define("GET", "/api/sessions/:id/pull-request/merge-readiness", async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const session = db.canAccessSession(req.principal, id) ? db.getSession(id) : null;
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  const supported = !runnerCapabilityError(session.runnerId, "pullRequestMerge", "pull request merging");
  const respond = (facts: PullRequestMergeFacts | null, unavailable?: string): PullRequestMergeReadinessResponse => ({
   facts, ...(unavailable ? { unavailable } : {}),
   readiness: pullRequestMergeReadiness(facts, mergeSessionFacts(req.principal, id, supported), unavailable),
  });
  if (!supported) return respond(null, "This machine's runner can't read merge readiness yet.");
  if (!session.worktreePath) return respond(null, "This session has no worktree with a pull request.");
  const requestId = randomUUID();
  try {
   const result = await hub.requestFromRunner(session.runnerId, requestId, {
    type: "git_action", requestId, sessionId: id, worktreePath: session.worktreePath,
    action: { kind: "merge_readiness" }, timeoutMs: 60_000,
   }, 60_000);
   if (result.type !== "git_result") return reply.code(502).send({ error: "unexpected runner reply" });
   if (!result.ok) return respond(null, "The pull request's merge state could not be read.");
   const info = result.data?.mergeReadiness;
   if (!info) return reply.code(502).send({ error: "the runner did not return merge readiness — update the runner on this box" });
   return respond(info.facts, info.unavailable);
  } catch (err) {
   if (err instanceof AssistantRefusal) throw err;
   return reply.code(504).send({ error: (err as Error).message });
  }
 });

 /**
  * #604: enqueue (merge-queue base) or directly merge the session's pull request. Owner and Admin
  * only, enforced here and by the API's role gate; no session credential may call it. The runner
  * re-reads the forge facts and re-runs the gate immediately before the pinned mutation and reads
  * the pull request back. Both the request and its outcome are recorded in the governance audit.
  */
 management.define("POST", PULL_REQUEST_MERGE_ROUTE, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const principal = req.principal;
  const session = db.canAccessSession(principal, id) ? db.getSession(id) : null;
  if (!session) return reply.code(404).send({ error: "session not found" });
  if (principal.kind !== "human") return reply.code(403).send({ error: "only a person can merge a pull request from Wollipog" });
  const roleError = mutationAuthorizationError("POST", PULL_REQUEST_MERGE_ROUTE, principal);
  if (roleError) return reply.code(403).send({ error: roleError });
  if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
  if (!session.worktreePath) return reply.code(409).send({ error: "this session has no worktree with a pull request" });
  const parsed = parsePullRequestMergeRequest(req.body);
  if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
  const unsupported = runnerCapabilityError(session.runnerId, "pullRequestMerge", "pull request merging");
  if (unsupported) return reply.code(409).send(failureBody(unsupported));
  const blocked = sessionMergeBlockers(mergeSessionFacts(principal, id, true));
  if (blocked.length > 0) return reply.code(409).send({ error: blocked.map((blocker) => blocker.message).join(" ") });
  if (req.recheck) {
   await req.recheck();
   const current = db.getSession(id);
   if (!current || current.runnerId !== session.runnerId || current.worktreePath !== session.worktreePath) {
    return reply.code(409).send({ error: "the session's worktree changed; reload and try again" });
   }
  }
  req.beforeEffect?.();
  const requestId = randomUUID();
  const actor = { kind: "human" as const, id: principal.userId };
  svc.recordPullRequestMergeAudit(session, requestId, "request", "pending", actor, parsed);
  try {
   const result = await hub.requestFromRunner(session.runnerId, requestId, {
    type: "git_action", requestId, sessionId: id, worktreePath: session.worktreePath,
    action: { kind: "merge_pull_request", ...parsed }, timeoutMs: 90_000,
   }, 90_000);
   const merge = result.type === "git_result" && result.ok ? result.data?.mergeResult : undefined;
   if (!merge) {
    svc.recordPullRequestMergeAudit(session, requestId, "resolution", "aborted", actor, parsed, "error");
    if (result.type === "git_result" && !result.ok) return reply.code(409).send({ error: result.error ?? "the merge could not be started" });
    return reply.code(502).send({ error: "the runner did not return a merge result — update the runner on this box" });
   }
   const outcome = merge.outcome === "enqueued" || merge.outcome === "merged" ? "allowed"
     : merge.outcome === "refused" ? "denied" : "aborted";
   svc.recordPullRequestMergeAudit(session, requestId, "resolution", outcome, actor, parsed, merge.outcome);
   const response: PullRequestMergeResponse = { result: merge };
   return response;
  } catch (err) {
   svc.recordPullRequestMergeAudit(session, requestId, "resolution", "aborted", actor, parsed, "error");
   if (err instanceof AssistantRefusal) throw err;
   return reply.code(504).send({ error: `${(err as Error).message}; check the pull request before trying again` });
  }
 });

 return management;
}
