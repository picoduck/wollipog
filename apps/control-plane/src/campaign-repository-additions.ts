import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CAMPAIGN_REPOSITORY_ADDITION_LIMITS, campaignBoundaryRepositories, isTerminal, runnerSupportsProtocol, sessionRole,
  type CampaignBoundaryRepository, type CampaignRepositoryAdditionRequest, type CampaignRepositoryAdditionSnapshot,
  type ProjectLocationInspection, type ProjectLocationView, type SessionView, type WorkflowDecisionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import type { ServiceResult, SessionsService } from "./sessions.js";

type Inspector = (locationId: string, options: { projectId: string; joinsCampaign?: boolean }) => Promise<ProjectLocationInspection>;

const fail = <T>(error: string, status = 409): ServiceResult<T> => ({ ok: false, status, error });
const ok = <T>(data: T, status = 200): ServiceResult<T> => ({ ok: true, status, data });
// No control characters, and no Unicode line or paragraph separators (U+2028, U+2029).
const LINE_OR_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "u");
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= max && !LINE_OR_CONTROL.test(value);

/** The repository this campaign already covers, and its Locations, in either mode. */
function campaignRepositories(root: SessionView): CampaignBoundaryRepository[] | null {
  const policy = root.orchestratorPolicy;
  const control = policy?.control;
  if (control?.mode === "full_control") return control.boundary.repositories ? campaignBoundaryRepositories(control.boundary) : null;
  return policy?.repositories ?? null;
}

/** An Orchestrator asks its campaign's owner to add one Project Location's repository (#4117).
 * The server inspects the Location before the owner sees anything, the decision is always the
 * owner's, and the Orchestrator carries out only the exact Location the owner approved. Agent text
 * (the reason, a child's report, an issue) never adds a repository on its own. */
export class CampaignRepositoryAdditions {
  private readonly executing = new Set<string>();

  constructor(private readonly deps: {
    db: ControlPlaneDb; hub: Hub; sessions: SessionsService; inspect: Inspector;
    synchronize: (rootId: string) => Promise<unknown>;
  }) {}

  /** The live campaign root this credential belongs to, its owner and that owner's principal. */
  private root(principal: AgentPrincipal, rootId: string): ServiceResult<{ root: SessionView; owner: HumanPrincipal }> {
    const { db } = this.deps;
    if (principal.credentialSessionId !== rootId || principal.orchestrator !== true || !db.canAccessSession(principal, rootId)) {
      return fail("a matching campaign root Orchestrator credential is required", 403);
    }
    const root = db.getSession(rootId);
    if (!root || root.archived || isTerminal(root.status)) return fail("A live campaign is required to add a repository");
    if (root.parentSessionId || sessionRole(root) !== "orchestrator" || !root.orchestratorPolicy) {
      return fail("Only a campaign's root Orchestrator asks its owner to add a repository", 403);
    }
    if (!runnerSupportsProtocol(db.getRunner(root.runnerId)?.protocolVersion, "campaignRepositoryAddition")) {
      return fail("Update this campaign's machine before asking to add a repository");
    }
    const control = root.orchestratorPolicy.control;
    const scope = db.sessionScope(rootId);
    const ownerId = control?.mode === "full_control" ? control.boundary.authorizedByUserId
      : scope?.owner.kind === "user" ? scope.owner.userId : null;
    const owner = ownerId && scope ? db.operatingHumanPrincipal(ownerId, scope.organizationId) : null;
    if (!owner) return fail("This campaign has no owner who can approve adding a repository");
    if (!root.projectId) {
      return fail("This campaign is not in a Project, so it has no Project Locations to add. Ask its owner to start it in a Project.");
    }
    return ok({ root, owner });
  }

  /** The Location, if it is still the same active Location of the campaign's Project (same runner,
   * workspace and path as when it was read) and the owner can still reach it. Inspections run on
   * another machine, so this is checked again after each one. */
  private stillBound(before: ProjectLocationView, projectId: string, owner: HumanPrincipal): ProjectLocationView | null {
    const { db } = this.deps;
    const now = db.getProjectLocation(before.id);
    return now && now.projectId === projectId && now.availability !== "runner_removed" && now.runnerId === before.runnerId &&
      now.workspaceId === before.workspaceId && now.path === before.path && db.canAccessProject(owner, projectId) &&
      db.canAccessWorkspace(owner, now.runnerId, now.workspaceId) ? now : null;
  }

  async request(rootId: string, input: CampaignRepositoryAdditionRequest, principal: AgentPrincipal): Promise<ServiceResult<WorkflowDecisionView>> {
    const { db } = this.deps;
    const checked = this.root(principal, rootId);
    if (!checked.ok) return fail(checked.error!, checked.status);
    const { root, owner } = checked.data!;
    const work = input?.work as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["requestId", "locationId", "reason", "work"].includes(key)) ||
        !bounded(input.requestId, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.requestId) || !bounded(input.locationId, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.id) ||
        !bounded(input.reason, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.reason) || !work || typeof work !== "object" || Array.isArray(work) ||
        Object.keys(work).some((key) => key !== "kind" && key !== "id") || (work.kind !== "follow_up" && work.kind !== "work_item") ||
        !bounded(work.id, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.id)) {
      return fail(`requestId, a Project locationId, a one-line reason of at most ${CAMPAIGN_REPOSITORY_ADDITION_LIMITS.reason} characters ` +
        "and the work that needs it ({ kind: \"follow_up\" | \"work_item\", id }) are required", 400);
    }
    const workKind = work.kind as "follow_up" | "work_item";
    const workId = work.id as string;
    const canAccess = (id: string) => db.canAccessSession(principal, id);
    const trusted = { trustedRepositoryAddition: true };
    const existing = db.workflowDecisionByRequestId(rootId, input.requestId);
    if (existing) {
      const s = existing.resourceSnapshot;
      if (s.category !== "campaign_repository_addition" || s.locationId !== input.locationId || s.reason !== input.reason ||
          s.work.kind !== workKind || s.work.id !== workId) return fail("requestId was already used for a different repository addition");
      return ok(existing);
    }
    const location = db.getProjectLocation(input.locationId);
    if (!location || location.projectId !== root.projectId || location.availability === "runner_removed") {
      return fail("That Location isn't an active Location of this campaign's Project. The Orchestrator can't create one: " +
        "report that the work needs a repository with no Location in this Project, so its owner can add one.", 404);
    }
    const covered = campaignRepositories(root);
    if (covered?.some((entry) => entry.locationIds.includes(location.id))) return fail("That Location is already part of this campaign");
    const title = db.campaignRepositoryAdditionWork(rootId, workKind, workId);
    if (!title) return fail(`This campaign has no recorded ${workKind === "follow_up" ? "follow-up" : "work item"} ${workId}`, 404);
    if (!db.canAccessProject(owner, root.projectId!) || !db.canAccessWorkspace(owner, location.runnerId, location.workspaceId)) {
      return fail("The campaign's owner can't reach that Location, so it can't join the campaign");
    }
    // The same inspection as a launch, in the Location's own path, before the owner sees anything.
    const inspection = await this.deps.inspect(location.id, { projectId: root.projectId!, joinsCampaign: true });
    if (!inspection.ok) return fail(`That Location failed inspection, so it can't be added: ${inspection.reason}`);
    const repository = inspection.location.repository.toLowerCase();
    // A one-entry Custom list exists only to show an old runner's exclusion (#4319), and adding a Location
    // of its repository has no other route in Custom, just as with no list at all.
    const onlyListedForAnExclusion = root.orchestratorPolicy?.control?.mode !== "full_control" && covered?.length === 1;
    if (!onlyListedForAnExclusion && covered?.some((entry) => entry.repository.toLowerCase() === repository)) {
      return fail(`${repository} is already one of this campaign's repositories; that Location joins it through its owner, not an addition`);
    }
    // The inspection ran on another machine; the campaign or the Location may have changed meanwhile.
    // Access is checked with the owner as they are now: a role can change while a runner inspects.
    const still = this.root(principal, rootId);
    if (!still.ok) return fail(still.error!, still.status);
    if (still.data!.owner.userId !== owner.userId || still.data!.root.projectId !== root.projectId ||
        !this.stillBound(location, root.projectId!, still.data!.owner)) {
      return fail("That Location changed while it was being inspected; ask again");
    }
    const resourceKey = `campaign_repository_addition:${repository}`;
    const latest = db.latestCampaignRepositoryAddition(rootId, resourceKey);
    // One request per repository: a pending one is reused, and a declined one isn't asked again for the same work.
    if (latest?.status === "pending") return ok(latest);
    if (db.campaignRepositoryAdditionDeclined(rootId, resourceKey, workKind, workId)) {
      return fail("The campaign's owner declined adding this repository for this work. Record the work as blocked on the owner; " +
        "ask again only for new work that needs it");
    }
    const snapshot: CampaignRepositoryAdditionSnapshot = { category: "campaign_repository_addition", locationId: location.id,
      locationName: location.name.slice(0, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.title), repository, reason: input.reason,
      work: { kind: workKind, id: workId, title: title.slice(0, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.title) } };
    return this.deps.sessions.createWorkflowDecision(rootId, { requestId: input.requestId, resourceKey, resourceSnapshot: snapshot },
      canAccess, trusted);
  }

  get(rootId: string, occurrenceId: string, principal: AgentPrincipal): ServiceResult<WorkflowDecisionView> {
    if (principal.credentialSessionId !== rootId || !this.deps.db.canAccessSession(principal, rootId)) return fail("session not found", 404);
    const decision = this.deps.db.workflowDecisionByOccurrence(occurrenceId);
    return decision?.sessionId === rootId && decision.category === "campaign_repository_addition" ? ok(decision)
      : fail("repository addition not found", 404);
  }

  /** Carry out exactly the Location the owner approved, after inspecting it again. */
  async execute(rootId: string, occurrenceId: string, digest: string, principal: AgentPrincipal): Promise<ServiceResult<WorkflowDecisionView>> {
    const { db } = this.deps;
    const read = this.get(rootId, occurrenceId, principal);
    if (!read.ok) return read;
    const decision = read.data!;
    if (decision.resourceDigest !== digest) return fail("repository addition digest does not match");
    if (decision.status === "consumed" && decision.campaignRepositoryAdditionResult) return ok(decision);
    const snapshot = decision.resourceSnapshot;
    if (snapshot.category !== "campaign_repository_addition" || decision.status !== "approved" || decision.authority !== "human") {
      return fail("This repository addition needs a current approval from the campaign's owner");
    }
    const checked = this.root(principal, rootId);
    if (!checked.ok) return fail(checked.error!, checked.status);
    const { root, owner } = checked.data!;
    if (db.campaignRepositoryAdditionApprover(occurrenceId) !== owner.userId) {
      return fail("Only the campaign's owner's approval adds a repository");
    }
    const location = db.getProjectLocation(snapshot.locationId);
    if (!location || location.projectId !== root.projectId || location.availability === "runner_removed" ||
        !db.canAccessWorkspace(owner, location.runnerId, location.workspaceId)) {
      return fail("That Location is no longer an active Location of this campaign's Project that its owner can reach; ask again");
    }
    if (this.executing.has(occurrenceId)) return fail("This repository addition is already being carried out");
    this.executing.add(occurrenceId);
    try {
      const inspection = await this.deps.inspect(location.id, { projectId: root.projectId!, joinsCampaign: true });
      if (!inspection.ok || inspection.location.repository.toLowerCase() !== snapshot.repository) {
        return fail("That Location no longer verifies as the approved repository; ask again for a fresh approval");
      }
      // A Custom campaign's list starts from its own Location's repository.
      let customBase: CampaignBoundaryRepository | undefined;
      let ownBefore: ProjectLocationView | null = null;
      if (root.orchestratorPolicy?.control?.mode !== "full_control" && !root.orchestratorPolicy?.repositories) {
        ownBefore = root.projectLocationId ? db.getProjectLocation(root.projectLocationId) : null;
        const own = ownBefore ? await this.deps.inspect(ownBefore.id, { projectId: root.projectId! }) : null;
        if (!own?.ok) return fail("This campaign's own Location could not be verified, so its repositories can't be extended yet");
        customBase = { repository: own.location.repository.toLowerCase(), locationIds: [own.location.locationId] };
      }
      // Every inspection ran on another machine: record only if the campaign, its owner, the
      // approved Location and the owner's access are all still what was checked.
      const still = this.root(principal, rootId);
      if (!still.ok) return fail(still.error!, still.status);
      const current = still.data!.root;
      const currentOwner = still.data!.owner;
      const fullControl = (session: SessionView) => session.orchestratorPolicy?.control?.mode === "full_control";
      // The owner as they are now (a role can change meanwhile), and the campaign still in the same Project.
      if (currentOwner.userId !== owner.userId || current.projectId !== root.projectId ||
          !this.stillBound(location, root.projectId!, currentOwner) ||
          (ownBefore && !this.stillBound(ownBefore, root.projectId!, currentOwner))) {
        return fail("That Location or the campaign's access to it changed while it was being inspected; ask again for a fresh approval");
      }
      if (fullControl(current) !== fullControl(root) || current.projectLocationId !== root.projectLocationId ||
          !current.orchestratorPolicy?.repositories !== !root.orchestratorPolicy?.repositories) {
        return fail("The campaign's control changed while the Location was being inspected; carry out the addition again");
      }
      const now = Date.now();
      const recorded = db.recordCampaignLocations(rootId, owner.userId, {
        joins: [{ locationId: location.id, name: location.name, repository: snapshot.repository, source: "addition_approved" }],
        excluded: [], pending: [],
      }, now, { consume: { occurrenceId, resourceDigest: digest }, ...(customBase ? { customBase } : {}) });
      if (!recorded.ok) return fail(recorded.error, recorded.status);
      if (recorded.joined && fullControl(current)) {
        // Like any join, what the new revision revoked leaves its pauses before members re-sync.
        this.deps.sessions.settleCampaignBoundaryChange(current, recorded.revoked, owner.userId, now);
        await this.deps.synchronize(rootId);
      }
      this.deps.hub.sessionChangedById(rootId);
      return ok(db.workflowDecisionByOccurrence(occurrenceId)!, 201);
    } finally {
      this.executing.delete(occurrenceId);
    }
  }
}

/** The campaign root's own repository-addition routes (#4117), with its own credential only. */
export function registerCampaignRepositoryAdditionRoutes(app: FastifyInstance, deps: {
  additions: CampaignRepositoryAdditions;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
}): void {
  const base = "/api/sessions/:id/orchestrator-campaign/repository-additions";
  for (const [method, suffix] of [["POST", ""], ["GET", "/:occurrenceId"], ["POST", "/:occurrenceId/execute"]] as const) {
    app.route({ method, url: base + suffix, handler: async (req, reply) => {
      const { id, occurrenceId } = req.params as { id: string; occurrenceId?: string };
      const principal = deps.requestPrincipal(req);
      if (principal?.kind !== "agent" || principal.credentialSessionId !== id) {
        return reply.code(403).send({ error: "a matching campaign root Orchestrator credential is required" });
      }
      if (occurrenceId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(occurrenceId)) return reply.code(400).send({ error: "invalid occurrenceId" });
      reply.header("cache-control", "no-store");
      const result = suffix === ""
        ? await deps.additions.request(id, req.body as CampaignRepositoryAdditionRequest, principal)
        : method === "GET" ? deps.additions.get(id, occurrenceId!, principal)
        : await (async () => {
          const body = req.body as { resourceDigest?: unknown } | null;
          if (!body || Object.keys(body).some((key) => key !== "resourceDigest") ||
              typeof body.resourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.resourceDigest)) {
            return fail<WorkflowDecisionView>("an exact resourceDigest is required; the Location comes only from the approval", 400);
          }
          return deps.additions.execute(id, occurrenceId!, body.resourceDigest, principal);
        })();
      req.log.info({ event: "campaign_repository_addition", requestId: req.id, sessionId: id, step: suffix || "request",
        occurrenceId: result.data?.occurrenceId ?? occurrenceId, status: result.status }, "Campaign repository addition handled");
      return reply.code(result.status).send(result.ok ? result.data : { error: result.error });
    } });
  }
}
