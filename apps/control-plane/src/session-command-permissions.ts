import {
  queueHoldAdviceReader,
  queueHoldRecoveryAction,
  worktreeRecoveryAction,
  type HoldAdviceReader,
  type SessionCommandPermission,
  type SessionCommandPermissions,
  type OrchestratorCampaignProjection,
  type SessionView,
} from "@wollipog/protocol";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import {
  AGENT_UNARCHIVE_ERROR,
  agentCredentialSessionTargetError,
  backgroundJobStopAuthorizationError,
  mutationAuthorizationError,
  orchestratorSelfWorktreeAuthorizationError,
  type AuthPrincipal,
  type HumanPrincipal,
} from "./identity.js";

/** Ownership facts the rules read, looked up by the caller (#1843). */
export interface SessionCommandPermissionFacts {
  /** `isSessionOwner`: the session's ownership scope names this person. Read for people only. */
  ownsSession: boolean;
  /** The session descends from the agent credential's own session. Read for agents only. */
  isDescendant: boolean;
}

const STOP_ROUTE = "/api/sessions/:id/stop";
const RESTART_ROUTE = "/api/sessions/:id/restart";
const STOP_JOB_ROUTE = "/api/sessions/:id/background-jobs/:jobId/stop";
const ARCHIVE_ROUTE = "/api/sessions/:id/archive";
const UNARCHIVE_AND_RESTART_ROUTE = "/api/sessions/:id/unarchive-and-restart";
const PROMPT_ROUTE = "/api/sessions/:id/prompt";
const DELETE_ROUTE = "/api/sessions/:id";
const CANCEL_TURN_ROUTE = "/api/sessions/:id/cancel";
/** Steer, Cancel, Edit, and resolving a delivery or steering attempt apply the same gates (#1857). */
const QUEUE_ROUTES = [
  "/api/sessions/:id/steer",
  "/api/sessions/:id/cancel-queued",
  "/api/sessions/:id/queued/:promptId/edit",
  "/api/sessions/:id/pending-prompts/:commandId/resolve",
  "/api/sessions/:id/steering/:submissionId/resolve",
] as const;
const RENAME_ROUTES = ["/api/sessions/:id/title", "/api/sessions/:id/retitle"] as const;
const CONFIG_ROUTE = "/api/sessions/:id/config";
const RESPOND_ROUTES = ["/api/sessions/:id/answer", "/api/sessions/:id/approve"] as const;
/** Fork, Edit in Fork, handoff and quarantine recovery all create the new session through one route. */
const FORK_ROUTE = "/api/sessions/:id/fork";
const REWIND_ROUTE = "/api/sessions/:id/rewind";
const REVIEW_FINDING_ROUTES = [
  "/api/sessions/:id/review-findings",
  { method: "PATCH", path: "/api/sessions/:id/review-findings/:findingId" },
  "/api/sessions/:id/review-findings/bundle",
] as const;
/** The worktree routes an agent credential's allowlist names; each applies its worktree rules. */
const WORKTREE_ROUTES = [
  "/api/sessions/:id/worktrees",
  "/api/sessions/:id/worktrees/attach",
  "/api/sessions/:id/worktrees/select",
  "/api/sessions/:id/worktrees/discard",
] as const;
const WORKTREE_SETUP_ROUTES = [
  "/api/sessions/:id/worktrees/retry-setup",
  "/api/sessions/:id/worktrees/generate-setup",
] as const;
/** Every Git action, read or write, is a `POST` to this one route. */
const GIT_ROUTE = "/api/sessions/:id/git";

const VIEWER_REASON = "Your Viewer role is read-only.";
const STOP_JOB_OWNER_REASON = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
/** No agent credential's route allowlist includes deleting a session. */
const AGENT_DELETE_REASON = "Session credentials cannot delete sessions.";
/** An agent credential authenticates only on the exact routes its allowlist names (#1857). */
const AGENT_ROUTE_REASON = "Session credentials cannot use this command.";
/** The config service's own rule: on its own session an agent may set only `maxChildSessions`, so
 * none of the configuration this verdict describes (approvals mode, Plan, model, effort) is allowed. */
const AGENT_SELF_CONFIG_REASON = "An agent may change only its own maxChildSessions.";

function sentence(error: string): string {
  const text = error.charAt(0).toUpperCase() + error.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
}

/** The refusal the organization role gate and the agent credential gate give this route, in the
 * order the API applies them, or null when both admit it. */
function routeRefusal(
  routePath: string,
  principal: AuthPrincipal,
  target: { id: string },
  facts: SessionCommandPermissionFacts,
  method = "POST",
): string | null {
  const roleError = mutationAuthorizationError(method, routePath, principal);
  if (roleError) return principal.kind === "human" && principal.role === "viewer" ? VIEWER_REASON : sentence(roleError);
  if (principal.kind !== "agent") return null;
  const targetError = agentCredentialSessionTargetError(routePath, principal, target.id, facts.isDescendant);
  return targetError ? sentence(targetError) : null;
}

/** A `POST` route by its path, or a route with another method. */
type CommandRoute = string | { method: string; path: string };

/** `routeRefusal` for the commands #1857 and later issues added, which also apply the agent credential's
 * route allowlist: a credential outside it is never authenticated for the route. Commands served by
 * several routes take the first refusal, since a surface offers the command only if all admit it. */
function allowlistedRouteRefusal(
  routes: readonly CommandRoute[],
  principal: AuthPrincipal,
  target: { id: string },
  facts: SessionCommandPermissionFacts,
): string | null {
  for (const route of routes) {
    const { method, path } = typeof route === "string" ? { method: "POST", path: route } : route;
    if (principal.kind === "agent" &&
        !isAgentControlApiRouteAllowed(method, path, principal.orchestrator ? "orchestrator" : null)) {
      return AGENT_ROUTE_REASON;
    }
    const refusal = routeRefusal(path, principal, target, facts, method);
    if (refusal) return refusal;
  }
  return null;
}

function nullableSentence(error: string | null): string | null {
  return error === null ? null : sentence(error);
}

function permission(reason: string | null): SessionCommandPermission {
  return reason === null ? { allowed: true } : { allowed: false, reason };
}

/**
 * What `principal` may do to one session it can already see (#1843). Each value is the verdict of
 * the gates the matching route applies, so a surface disables exactly what the server would refuse.
 * Session visibility is not re-checked here: a principal that cannot see the session never
 * receives its view.
 */
export function sessionCommandPermissions(
  principal: AuthPrincipal,
  target: { id: string; parentSessionId?: string | null; orchestratorPolicy?: SessionView["orchestratorPolicy"] },
  facts: SessionCommandPermissionFacts,
): SessionCommandPermissions {
  const stopJobRefusal = routeRefusal(STOP_JOB_ROUTE, principal, target, facts) ??
    (backgroundJobStopAuthorizationError(principal, target, principal.kind === "human" && facts.ownsSession)
      ? STOP_JOB_OWNER_REASON
      : null);
  return {
    stop: permission(routeRefusal(STOP_ROUTE, principal, target, facts)),
    restart: permission(routeRefusal(RESTART_ROUTE, principal, target, facts)),
    stopBackgroundJob: permission(stopJobRefusal),
    archive: permission(routeRefusal(ARCHIVE_ROUTE, principal, target, facts)),
    // Both restore routes refuse every agent credential first; for a person they apply the same
    // role gate, so Unarchive and Unarchive and Restart share one verdict.
    unarchive: permission(principal.kind === "agent"
      ? sentence(AGENT_UNARCHIVE_ERROR)
      : routeRefusal(UNARCHIVE_AND_RESTART_ROUTE, principal, target, facts)),
    prompt: permission(routeRefusal(PROMPT_ROUTE, principal, target, facts)),
    delete: permission(principal.kind === "agent"
      ? AGENT_DELETE_REASON
      : routeRefusal(DELETE_ROUTE, principal, target, facts, "DELETE")),
    cancelTurn: permission(allowlistedRouteRefusal([CANCEL_TURN_ROUTE], principal, target, facts)),
    manageQueue: permission(allowlistedRouteRefusal(QUEUE_ROUTES, principal, target, facts)),
    rename: permission(allowlistedRouteRefusal(RENAME_ROUTES, principal, target, facts)),
    configure: permission(allowlistedRouteRefusal([CONFIG_ROUTE], principal, target, facts) ??
      (principal.kind === "agent" && principal.credentialSessionId === target.id ? AGENT_SELF_CONFIG_REASON : null)),
    respond: permission(allowlistedRouteRefusal(RESPOND_ROUTES, principal, target, facts)),
    fork: permission(allowlistedRouteRefusal([FORK_ROUTE], principal, target, facts)),
    rewind: permission(allowlistedRouteRefusal([REWIND_ROUTE], principal, target, facts)),
    manageReviewFindings: permission(allowlistedRouteRefusal(REVIEW_FINDING_ROUTES, principal, target, facts)),
    // The worktree service then refuses an Orchestrator its own worktrees under Strict Project
    // Isolation, which the session's immutable policy decides.
    manageWorktrees: permission(allowlistedRouteRefusal(WORKTREE_ROUTES, principal, target, facts) ??
      nullableSentence(orchestratorSelfWorktreeAuthorizationError(
        principal,
        target.id,
        target.orchestratorPolicy?.execution.strictProjectIsolation !== false,
      ))),
    worktreeSetup: permission(allowlistedRouteRefusal(WORKTREE_SETUP_ROUTES, principal, target, facts)),
    gitActions: permission(allowlistedRouteRefusal([GIT_ROUTE], principal, target, facts)),
  };
}

/**
 * What the principal reading a held session's advice may do to it: its Stop Job, Restart and
 * Manage Worktrees verdicts, for an agent credential reading its tools (#1863) and for a person
 * alike. The worktree advice names select_worktree and create_worktree, whose routes share
 * `manageWorktrees`' gates (#1864), so the advice and the verdict cannot disagree.
 * `target.orchestratorPolicy` carries Strict Project Isolation, which only an Orchestrator's own
 * session can be refused by. A person's advice is written here too (#1867, #1875): the dashboard
 * can rewrite it only for sessions it has loaded (#1857), Held Children lists campaign children it
 * may not have, and only the server holds every worktree hold's branch and path.
 */
export function sessionHoldReader(
  principal: AuthPrincipal,
  target: Pick<SessionView, "id" | "parentSessionId" | "orchestratorPolicy">,
  facts: SessionCommandPermissionFacts,
): HoldAdviceReader {
  return holdAdviceReader(sessionCommandPermissions(principal, target, facts));
}

/** `sessionHoldReader` from verdicts already computed for the same principal and session. */
function holdAdviceReader(permissions: SessionCommandPermissions): HoldAdviceReader {
  return {
    canStopJobs: permissions.stopBackgroundJob.allowed,
    canRestart: permissions.restart.allowed,
    canManageWorktrees: permissions.manageWorktrees?.allowed === true,
  };
}

/** A copy of `session` whose hold advice is written for `reader` (#1863). Each hold `reader` covers
 * is rewritten from the session's own record of it; without a reader the view is returned
 * unchanged. */
export function withHoldAdviceFor<T extends Pick<SessionView, "holds" | "queueHold" | "worktreeRecovery">>(
  session: T,
  reader: HoldAdviceReader | undefined,
): T {
  if (!reader || !session.holds?.length) return session;
  const { queueHold, worktreeRecovery } = session;
  const queueReader = queueHoldAdviceReader(reader);
  return {
    ...session,
    holds: session.holds.map((hold) => {
      if (hold.kind === "worktree_recovery") {
        return worktreeRecovery?.recoveryId === hold.holdId
          ? { ...hold, recoveryAction: worktreeRecoveryAction(worktreeRecovery, reader) }
          : hold;
      }
      return queueReader && queueHold?.holdId === hold.holdId
        ? { ...hold, recoveryAction: queueHoldRecoveryAction(queueHold, queueReader) }
        : hold;
    }),
  };
}

/** The ownership lookups `withSessionCommandPermissions` needs from the database. */
export interface SessionCommandPermissionSource {
  isSessionOwner(principal: HumanPrincipal, sessionId: string): boolean;
  isSessionDescendant(ancestorId: string, targetId: string): boolean;
  /** Whether `principal` may read the session at all; a campaign lists only such held children. */
  canAccessSession(principal: AuthPrincipal, sessionId: string): boolean;
  /** The records behind a projection's holds, read for every held child it lists. */
  sessionHoldRecords(ids: readonly string[]): Map<string,
    Pick<SessionView, "orchestratorPolicy" | "worktreeRecovery" | "queueHold"> & { parentSessionId: string | null }>;
  /** The root campaign an Orchestrator session resolves to (#2417). Without it, no agent sees a
   * campaign work summary. */
  resolvedCampaignSessionId?(sessionId: string): string | null;
}

/** The campaign work summary is ledger data. An agent may read it only as an Orchestrator of that
 * campaign; any other agent able to read the root session sees the projection without it, as the
 * Campaign Status routes refuse it (docs/campaign-work-ledger.md). It rides only on the root's own
 * view, so the campaign is the session itself. */
export function withCampaignWorkFor<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal,
  session: T,
): T {
  const campaign = session.orchestratorCampaign;
  if (!campaign?.work || principal.kind !== "agent") return session;
  const own = principal.orchestrator && principal.credentialSessionId
    ? source.resolvedCampaignSessionId?.(principal.credentialSessionId) ?? null
    : null;
  if (own === session.id) return session;
  const { work: _hidden, ...withoutWork } = campaign;
  return { ...session, orchestratorCampaign: withoutWork };
}

function isSessionViewWithWork(value: unknown): value is SessionView {
  const candidate = value as Partial<SessionView> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.id === "string" &&
    candidate.orchestratorCampaign?.work !== undefined;
}

/**
 * Apply the campaign-work rule to a whole response body for an agent, the way
 * `withVisibleCampaignChildren` narrows held children: a session view or array of views at the top
 * level or under any first-level key. Session reads already project per principal; mutation
 * responses (config, stop, restart, archive, prompt) return the service's raw view, and an agent may
 * command a campaign root it is an ancestor of, so every agent-bound API body passes through here.
 */
export function withCampaignWorkForResponse(
  source: Pick<SessionCommandPermissionSource, "resolvedCampaignSessionId">,
  principal: AuthPrincipal | null | undefined,
  payload: unknown,
): unknown {
  if (principal?.kind !== "agent") return payload;
  const projectView = (value: unknown): unknown => isSessionViewWithWork(value)
    ? withCampaignWorkFor(source as SessionCommandPermissionSource, principal, value)
    : value;
  const project = (value: unknown): unknown => {
    if (!Array.isArray(value)) return projectView(value);
    const projected = value.map(projectView);
    return projected.some((item, index) => item !== value[index]) ? projected : value;
  };
  const top = project(payload);
  if (typeof top !== "object" || top === null || Array.isArray(top)) return top;
  let result = top as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    const projected = project(value);
    if (projected !== value) result = { ...result, [key]: projected };
  }
  return result;
}

function permissionFacts(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal,
  sessionId: string,
): SessionCommandPermissionFacts {
  const credentialSessionId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
  let ownsSession: boolean | undefined;
  return {
    // Looked up only when a verdict reads it (#1873). Only Stop Job does, behind the role gate, so a
    // Viewer's verdicts never look it up.
    get ownsSession() {
      return ownsSession ??= principal.kind === "human" && source.isSessionOwner(principal, sessionId);
    },
    isDescendant: Boolean(credentialSessionId && source.isSessionDescendant(credentialSessionId, sessionId)),
  };
}

/** `sessionHoldReader` with the ownership facts looked up from the database. */
export function sessionHoldReaderFor(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  target: Pick<SessionView, "id" | "parentSessionId" | "orchestratorPolicy">,
): HoldAdviceReader | undefined {
  return principal ? sessionHoldReader(principal, target, permissionFacts(source, principal, target.id)) : undefined;
}

/** A campaign projection listing only the held children `principal` may open. A campaign's
 * sessions start with one audience, but each can be re-scoped or filed into a Project on its own
 * afterward, so a reader of the Orchestrator need not be a reader of every child. Without a
 * principal (a trusted local connection) the projection is returned unchanged. */
export function withVisibleHeldChildren<T extends Pick<OrchestratorCampaignProjection, "heldChildren">>(
  source: Pick<SessionCommandPermissionSource, "canAccessSession">,
  principal: AuthPrincipal | null | undefined,
  projection: T,
): T {
  if (!principal || !projection.heldChildren?.length) return projection;
  const visible = projection.heldChildren.filter((child) => source.canAccessSession(principal, child.sessionId));
  if (visible.length === projection.heldChildren.length) return projection;
  if (visible.length) return { ...projection, heldChildren: visible };
  const { heldChildren: _hidden, ...rest } = projection;
  return rest as T;
}

/** A route's response with every campaign it embeds narrowed by `withVisibleHeldChildren`, whether
 * it is a campaign projection, a session view, a list of either, or one field of the response
 * (`{ session }`, `{ sessions }`, `{ sideChat }`, `{ campaign }`). A route that returns the view it
 * changed does not write it for the requester, so this is applied to every response. */
export function withVisibleCampaignChildren(
  source: Pick<SessionCommandPermissionSource, "canAccessSession">,
  principal: AuthPrincipal | null | undefined,
  payload: unknown,
): unknown {
  if (!principal) return payload;
  const narrowView = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray((value as Partial<OrchestratorCampaignProjection>).heldChildren)) {
      return withVisibleHeldChildren(source, principal, value as Pick<OrchestratorCampaignProjection, "heldChildren">);
    }
    const campaign = (value as Partial<SessionView>).orchestratorCampaign;
    if (!campaign?.heldChildren?.length) return value;
    const visible = withVisibleHeldChildren(source, principal, campaign);
    return visible === campaign ? value : { ...value, orchestratorCampaign: visible };
  };
  const narrow = (value: unknown): unknown => {
    if (!Array.isArray(value)) return narrowView(value);
    const narrowed = value.map(narrowView);
    return narrowed.some((item, index) => item !== value[index]) ? narrowed : value;
  };
  const top = narrow(payload);
  if (typeof top !== "object" || top === null || Array.isArray(top)) return top;
  let result = top as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    const narrowed = narrow(value);
    if (narrowed !== value) result = { ...result, [key]: narrowed };
  }
  return result;
}

/** A campaign projection listing only the held children the principal reading it may open, each
 * with advice written for them: an agent credential (#1863) or a person (#1867, #1875), who reads
 * it in Held Children whether or not the dashboard has loaded the child. The projection spans every
 * campaign descendant, and only a direct child's jobs are the Orchestrator's to stop. */
export function withCampaignHoldAdviceFor<T extends Pick<OrchestratorCampaignProjection, "heldChildren">>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  campaign: T,
): T {
  const projection = withVisibleHeldChildren(source, principal, campaign);
  if (!principal || !projection.heldChildren?.length) return projection;
  // A child without a record is returned as the projection listed it.
  const records = source.sessionHoldRecords(projection.heldChildren.map((child) => child.sessionId));
  return {
    ...projection,
    heldChildren: projection.heldChildren.map((child) => {
      const record = records.get(child.sessionId);
      if (!record) return child;
      // Of a person's verdicts only Stop Job reads ownership, and their advice reads Stop Job only for
      // a queue hold whose runner can stop jobs, so no other child's ownership is looked up (#1873).
      const facts = principal.kind === "human" && !record.queueHold?.canStopJobs
        ? { ownsSession: false, isDescendant: false }
        : permissionFacts(source, principal, child.sessionId);
      // A nested Orchestrator's campaign can list its own session, where its isolation policy decides
      // whether it may manage its worktrees.
      const reader = sessionHoldReader(principal, { ...record, id: child.sessionId }, facts);
      return { ...child, holds: withHoldAdviceFor({ ...record, holds: child.holds }, reader).holds ?? child.holds };
    }),
  };
}

/** A session view whose hold advice is written for the principal reading it (#1863, #1867,
 * #1875): its own holds for `reader`, and, when it is an Orchestrator's view, its campaign's held
 * children for `principal`. */
export function withSessionHoldAdviceFor<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  session: T,
  reader: HoldAdviceReader | undefined,
): T {
  const view = withHoldAdviceFor(session, reader);
  return view.orchestratorCampaign
    ? { ...view, orchestratorCampaign: withCampaignHoldAdviceFor(source, principal, view.orchestratorCampaign) }
    : view;
}

/** A copy of `session` carrying the requester's command permissions, and hold advice written for
 * them, including its campaign's held children (#1863, #1867, #1875). Without a principal
 * (a trusted local connection) the view is returned unchanged, so every command stays offered. */
export function withSessionCommandPermissions<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  session: T,
): T {
  if (!principal) return session;
  session = withCampaignWorkFor(source, principal, session);
  const commandPermissions = sessionCommandPermissions(principal, session, permissionFacts(source, principal, session.id));
  return withSessionHoldAdviceFor(source, principal, { ...session, commandPermissions },
    session.holds?.length ? holdAdviceReader(commandPermissions) : undefined);
}
