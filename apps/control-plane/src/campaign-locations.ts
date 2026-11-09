import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  CampaignExcludedLocation, CampaignLocationJoin, CampaignPendingLocation, ProjectLocationInspection, ProjectLocationView, SessionView, WorkflowDecisionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { inspectProjectLocation } from "./project-location-inspection.js";

/** Exclusions that a reconnecting runner may have cleared. The others describe the folder itself. A
 * runner's protocol version changes only by registering again, so an update is a reconnect (#4319). */
const RETRIED_ON_RECONNECT: ReadonlySet<string> = new Set(["runner_offline", "read_failed", "runner_too_old", "runner_below_gates"]);
/** A Custom campaign retries only what #4319 excludes there: one that was offline when it was created
 * stays out, as it always has, until an approved repository addition. */
const RETRIED_ON_CUSTOM_RECONNECT: ReadonlySet<string> = new Set(["runner_below_gates"]);

type Outcome = { ok: true; data: { joined: boolean; revision: number } } | { ok: false; status: number; error: string };

/** A campaign's boundary follows its Project after launch (#4117). Every widening has one of three
 * human provenances, each checked here before a runner is asked anything:
 * - a Location the campaign's owner added to the Project, through the owner's own request;
 * - a Location the owner added, excluded only because its runner was offline or unreadable, once
 *   that runner reconnects;
 * - the owner's Include in Campaign of a Location someone else added, or one with no recorded adder.
 *   Reconnecting never adds one of those: nobody has seen which repository it is, so it waits.
 * Agents have no route that reaches any of these, and a Location nobody added never joins on its
 * own. Every join is inspected in the Location's own path first, and a runner that can't perform the
 * campaign's gates there is excluded with the version it needs, then retried when it registers again
 * (#4319). While the owner's first message limits the campaign, recording a join of a repository with
 * no entry leaves the Location available instead, whichever of these it came from: only an approved
 * repository addition adds that entry.
 *
 * A Custom campaign's list follows its Project in one case only (#4319): the owner's own Location its
 * creation excluded for its runner's version joins once that runner updates, which restores what its
 * creation would have listed. Its list grants nothing, and a person still approves every scope change. */
export class CampaignLocations {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: {
    db: ControlPlaneDb; hub: Hub;
    /** Sends each member's runner its re-minted boundary. */
    synchronize: (rootId: string) => Promise<unknown>;
    /** Settles the decisions a boundary change revoked and publishes every member (Sessions). */
    settle: (before: SessionView, revoked: WorkflowDecisionView[], ownerUserId: string, now: number) => void;
    log: { warn(message: string): void };
    inspectionTimeoutMs?: number;
  }) {}

  /** A person added (or moved) this Location into its Project. */
  locationAdded(locationId: string, principal: HumanPrincipal): Promise<void> {
    const location = this.deps.db.getProjectLocation(locationId);
    if (!location) return Promise.resolve();
    return this.forRoots(this.deps.db.campaignRepositoryRoots({ projectId: location.projectId }), (root) => {
      // A Location keeps its id when it is removed and added again. Whatever was recorded about it
      // before (an exclusion a reconnect would retry, or a pending entry) is replaced by this
      // addition's own provenance; only a Location already in the boundary stays as it is.
      if (this.inBoundary(root, locationId)) return Promise.resolve();
      const owner = this.owner(root);
      // Only the owner's own addition, by the owner's own request, joins on its own.
      if (principal.userId !== owner || this.deps.db.projectLocationAddedBy(locationId) !== owner ||
          !this.deps.db.canAccessWorkspace(principal, location.runnerId, location.workspaceId)) {
        return this.record(root, { joins: [], excluded: [], pending: [{ locationId, name: location.name, reason: "added_by_other" }] });
      }
      return this.inspectAndRecord(root, [location], "owner_added");
    }).then(() => undefined);
  }

  /** A runner reconnected: retry its Locations that were excluded only because it was away. */
  runnerReconnected(runnerId: string): Promise<void> {
    const { db } = this.deps;
    return this.forRoots([...db.campaignRepositoryRoots({ runnerId }), ...db.customCampaignRepositoryRoots(runnerId)], (root) => {
      const custom = root.orchestratorPolicy?.control?.mode !== "full_control";
      const owner = this.owner(root);
      const principal = custom && owner ? db.operatingHumanPrincipal(owner, db.sessionScope(root.id)?.organizationId ?? "") : null;
      const retry = (root.orchestratorPolicy?.excludedLocations ?? []).filter((item) => (custom ? RETRIED_ON_CUSTOM_RECONNECT : RETRIED_ON_RECONNECT).has(item.failure))
        .map((item) => db.getProjectLocation(item.locationId))
        .filter((location): location is ProjectLocationView => Boolean(location && location.runnerId === runnerId &&
          location.projectId === root.projectId && location.availability !== "runner_removed" &&
          // Nobody reviews a Custom campaign's list, so only what its survey would list joins it.
          (!custom || Boolean(principal && db.projectLocationAddedBy(location.id) === owner &&
            db.canAccessWorkspace(principal, location.runnerId, location.workspaceId)))));
      return retry.length ? this.inspectAndRecord(root, retry, "runner_reconnected") : Promise.resolve();
    }).then(() => undefined);
  }

  /** The campaign owner's Include in Campaign of a Location in its Project. */
  async include(rootId: string, locationId: string, principal: HumanPrincipal): Promise<Outcome> {
    const root = this.deps.db.getSession(rootId);
    if (!root || root.parentSessionId || root.orchestratorPolicy?.control?.mode !== "full_control" ||
        !root.orchestratorPolicy.control.boundary.repositories) {
      return { ok: false, status: 409, error: "Only a Full Control campaign with a repository boundary can include Project Locations." };
    }
    if (principal.userId !== this.owner(root) || !this.deps.db.isSessionOwner(principal, rootId)) {
      return { ok: false, status: 403, error: "Only the campaign's owner can include a Location in it." };
    }
    const location = this.deps.db.getProjectLocation(locationId);
    if (!location || location.projectId !== root.projectId || location.availability === "runner_removed" ||
        !this.deps.db.canAccessWorkspace(principal, location.runnerId, location.workspaceId)) {
      return { ok: false, status: 404, error: "That Location isn't an active Location of this campaign's Project." };
    }
    return this.enqueue(rootId, () => {
      const fresh = this.deps.db.getSession(rootId);
      if (!fresh || this.owner(fresh) !== principal.userId) return Promise.resolve({ ok: false as const, status: 409, error: "This campaign's authority changed; try again." });
      if (this.inBoundary(fresh, locationId)) return Promise.resolve({ ok: true as const, data: { joined: false, revision: this.revision(fresh) } });
      return this.inspectAndRecord(fresh, [location], "owner_included", principal);
    });
  }

  private owner(root: SessionView): string | null {
    const control = root.orchestratorPolicy?.control;
    if (control?.mode === "full_control") return control.boundary.authorizedByUserId;
    const scope = root.orchestratorPolicy?.repositories ? this.deps.db.sessionScope(root.id) : null;
    return scope?.owner.kind === "user" ? scope.owner.userId : null;
  }

  private revision(root: SessionView): number {
    const control = root.orchestratorPolicy?.control;
    return control?.mode === "full_control" ? control.boundary.revision : 0;
  }

  private inBoundary(root: SessionView, locationId: string): boolean {
    const control = root.orchestratorPolicy?.control;
    const listed = control?.mode === "full_control" ? control.boundary.repositories : root.orchestratorPolicy?.repositories;
    return Boolean(listed?.some((entry) => entry.locationIds.includes(locationId)));
  }

  private async inspectAndRecord(root: SessionView, locations: ProjectLocationView[], source: CampaignLocationJoin["source"],
    includer?: HumanPrincipal): Promise<Outcome> {
    const { db } = this.deps;
    const before = new Map(locations.map((location) => [location.id, { runnerId: location.runnerId, workspaceId: location.workspaceId,
      addedBy: db.projectLocationAddedBy(location.id) }]));
    const results = await Promise.all(locations.map((location) => inspectProjectLocation(this.deps, location.id, {
      projectId: root.projectId ?? undefined, timeoutMs: this.deps.inspectionTimeoutMs, joinsCampaign: true })));
    // The inspections ran on other machines. Everything the provenance rested on is read again here,
    // and nothing is awaited between this check and the record below: a Location removed, moved
    // away and back, re-added by someone else, or no longer reachable meanwhile is not recorded.
    const fresh = db.getSession(root.id);
    if (!fresh) return { ok: false, status: 409, error: "This campaign ended." };
    const owner = this.owner(fresh);
    const joins: Array<{ locationId: string; name: string; repository: string; source: CampaignLocationJoin["source"] }> = [];
    const excluded: CampaignExcludedLocation[] = [];
    const pending: CampaignPendingLocation[] = [];
    let changed = false;
    results.forEach((result: ProjectLocationInspection, index) => {
      const location = locations[index]!;
      const was = before.get(location.id)!;
      const now = db.getProjectLocation(location.id);
      const eligible = Boolean(owner && now && now.projectId === fresh.projectId && now.availability !== "runner_removed" &&
        now.runnerId === was.runnerId && now.workspaceId === was.workspaceId && db.projectLocationAddedBy(location.id) === was.addedBy &&
        !this.inBoundary(fresh, location.id) &&
        (source !== "owner_added" || was.addedBy === owner) &&
        (source !== "runner_reconnected" || fresh.orchestratorPolicy?.excludedLocations?.some((item) =>
          item.locationId === location.id && RETRIED_ON_RECONNECT.has(item.failure))) &&
        (source !== "owner_included" || Boolean(includer && includer.userId === owner &&
          db.canAccessWorkspace(includer, now.runnerId, now.workspaceId))));
      if (!eligible) { changed = true; return; }
      // Only the owner's own Location joins on a reconnect. Anyone else's, or one with no recorded
      // adder, waits for Include in Campaign however it read: nobody has seen its repository.
      if (source === "runner_reconnected" && was.addedBy !== owner) {
        pending.push({ locationId: location.id, name: location.name, reason: "added_by_other" });
        return;
      }
      if (result.ok) joins.push({ locationId: location.id, name: location.name, repository: result.location.repository, source });
      else excluded.push({ locationId: location.id, name: location.name, failure: result.failure, reason: result.reason });
    });
    if (changed && source === "owner_included") return { ok: false, status: 409, error: "That Location changed while it was inspected; try again." };
    return this.record(fresh, { joins, excluded, pending });
  }

  private async record(root: SessionView, update: { joins: Array<{ locationId: string; name: string; repository: string;
    source: CampaignLocationJoin["source"] }>; excluded: CampaignExcludedLocation[]; pending: CampaignPendingLocation[] }): Promise<Outcome> {
    const owner = this.owner(root);
    if (!owner) return { ok: false, status: 409, error: "This campaign has no Full Control owner." };
    if (!update.joins.length && !update.excluded.length && !update.pending.length) {
      return { ok: true, data: { joined: false, revision: this.revision(root) } };
    }
    const now = Date.now();
    const result = this.deps.db.recordCampaignLocations(root.id, owner, update, now);
    if (!result.ok) {
      this.deps.log.warn(JSON.stringify({ event: "campaign_locations_not_recorded", sessionId: root.id, status: result.status }));
      return result;
    }
    // A Custom campaign's list has no boundary to re-mint and revokes nothing.
    if (result.joined && root.orchestratorPolicy?.control?.mode === "full_control") {
      // A join is an owner-authorized boundary change: what it revoked leaves its pauses, and every
      // member's runner gets the new boundary.
      this.deps.settle(root, result.revoked, owner, now);
      await this.deps.synchronize(root.id);
    } else {
      this.deps.hub.sessionChangedById(root.id);
    }
    return { ok: true, data: { joined: result.joined, revision: result.revision } };
  }

  /** One campaign's Location changes apply in order, so two additions never race a revision. */
  private enqueue<T>(rootId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(rootId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      // Work reads the campaign fresh: an earlier change may have moved its revision.
      return work();
    });
    this.queues.set(rootId, next);
    void next.finally(() => { if (this.queues.get(rootId) === next) this.queues.delete(rootId); }).catch(() => undefined);
    return next;
  }

  private forRoots(roots: SessionView[], work: (root: SessionView) => Promise<unknown>): Promise<unknown[]> {
    return Promise.all(roots.map((root) => this.enqueue(root.id, () => {
      const fresh = this.deps.db.getSession(root.id);
      return fresh ? work(fresh) : Promise.resolve();
    }).catch((error: unknown) => {
      this.deps.log.warn(JSON.stringify({ event: "campaign_locations_failed", sessionId: root.id, error: String(error) }));
    })));
  }
}

/** Include in Campaign (#4117): the campaign owner's own request, never an agent's. */
export function registerCampaignLocationRoutes(app: FastifyInstance, dependencies: {
  campaignLocations: CampaignLocations; requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null;
}): void {
  app.post("/api/sessions/:id/orchestrator-campaign/locations/:locationId/include", async (request, reply) => {
    const principal = dependencies.requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "Only the campaign's owner can include a Location in it." });
    const { id, locationId } = request.params as { id: string; locationId: string };
    const result = await dependencies.campaignLocations.include(id, locationId, principal);
    return result.ok ? result.data : reply.code(result.status).send({ error: result.error });
  });
}
