import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  CampaignExcludedLocation, CampaignLocationJoin, CampaignPendingLocation, ProjectLocationInspection, ProjectLocationView, SessionView, WorkflowDecisionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { campaignPendingCause } from "@wollipog/protocol";
import { inspectProjectLocation } from "./project-location-inspection.js";

/** Exclusions that a reconnecting runner may have cleared. The others describe what the folder holds. A
 * runner's protocol version changes only by registering again, so an update is a reconnect (#4319). A
 * missing folder is retried too: until a read names its repository, every repository without an entry
 * is refused, and updating the runner is what that refusal asks for. */
const RETRIED_ON_RECONNECT: ReadonlySet<string> = new Set(["runner_offline", "read_failed", "runner_too_old", "runner_below_gates", "path_missing"]);

/** What a Custom campaign reads again on a reconnect only to name the repository (#4319). */
const NAMED_ON_RECONNECT: ReadonlySet<string> = new Set(["runner_offline", "path_missing"]);

/** Whether a Custom exclusion can join on a reconnect: one #4319 excluded there for its runner's version,
 * and that exclusion's later transient failures. One left out for another reason at creation, such as
 * its machine being offline, stays out, as it always has. */
function customRejoins(item: CampaignExcludedLocation): boolean {
  return item.nameOnly !== true && (item.failure === "runner_below_gates" || item.rejoinsOnReconnect === true);
}

/** Custom reads again what can join, and also what is only read to name its repository, so that a
 * repository behind an old runner is refused by name rather than leaving every repository refused. */
function retriedOnReconnect(item: CampaignExcludedLocation, custom: boolean): boolean {
  return custom ? customRejoins(item) || item.nameOnly === true || NAMED_ON_RECONNECT.has(item.failure) : RETRIED_ON_RECONNECT.has(item.failure);
}

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
    settle: (before: SessionView, revoked: WorkflowDecisionView[], ownerUserId: string | null, now: number) => void;
    /** Reads a Custom campaign's own Location again and records its list (#4319). */
    reestablish?: (rootId: string) => Promise<unknown>;
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
        // Why it waits, by who is on record as adding it, never assumed someone else (#4312).
        return this.record(root, { joins: [], excluded: [], pending: [{ locationId, name: location.name, reason: "added_by_other",
          cause: campaignPendingCause(this.deps.db.projectLocationAddedBy(locationId), owner) }] });
      }
      return this.inspectAndRecord(root, [location], "owner_added");
    }).then(() => undefined);
  }

  /** A runner reconnected: retry its Locations that were excluded only because it was away. */
  runnerReconnected(runnerId: string): Promise<void> {
    const { db } = this.deps;
    // A Custom campaign whose own Location was unread at creation reads it again (#4319).
    const awaiting = this.deps.reestablish ? this.forRoots(db.customRootsAwaitingLaunchRead(runnerId), (root) => this.deps.reestablish!(root.id)) : Promise.resolve([]);
    // What each campaign's ordinary retry reads here, so the unread retry below doesn't read it twice.
    const retriedBy = new Map<string, Set<string>>();
    const retried = this.forRoots([...db.campaignRepositoryRoots({ runnerId }), ...db.customCampaignRepositoryRoots(runnerId)], (root) => {
      const custom = root.orchestratorPolicy?.control?.mode !== "full_control";
      const retry = (root.orchestratorPolicy?.excludedLocations ?? [])
        .filter((item) => retriedOnReconnect(item, custom))
        .map((item) => db.getProjectLocation(item.locationId))
        .filter((location): location is ProjectLocationView => Boolean(location && location.runnerId === runnerId &&
          location.projectId === root.projectId && location.availability !== "runner_removed" &&
          (!custom || this.customSurveyLists(root, location))));
      retriedBy.set(root.id, new Set(retry.map((location) => location.id)));
      return retry.length ? this.inspectAndRecord(root, retry, "runner_reconnected") : Promise.resolve();
    });
    // Then every unread Location on this runner that retry didn't read (#4319): one whose exclusion a
    // revoke, a re-authorization or a revival dropped, a stale record a rollback left, or one of a
    // stopped root whose members still run. Its runner's update and restart is what the refusal asks
    // for, so that is what reads it again.
    const unread = retried.then(() => this.forRoots(db.campaignRootsRereadingUnread(runnerId), (root) =>
      this.rereadUnread(root, runnerId, retriedBy.get(root.id) ?? new Set())));
    return Promise.all([awaiting, unread]).then(() => undefined);
  }

  /** Reads a campaign's unread Locations on one runner only to name their repository (#4319): it never
   * joins one. One already in an entry, as an older control plane may have left it, is resolved
   * without a read. Its own Location is left to `reestablish`, the one way a root's own Location is unread. */
  private async rereadUnread(root: SessionView, runnerId: string, skip: ReadonlySet<string>): Promise<void> {
    const { db } = this.deps;
    const standing = db.unnamedBelowGatesLocations(root)
      .map((item) => db.getProjectLocation(item.locationId))
      // Whatever Project the root or the Location is in now: the record counts it all the same.
      .filter((location): location is ProjectLocationView => Boolean(location && location.runnerId === runnerId && location.id !== root.projectLocationId &&
        location.availability !== "runner_removed" && !skip.has(location.id)));
    if (!standing.length) return;
    const locations = standing.filter((location) => !this.inBoundary(root, location.id));
    const before = locations.map((location) => ({ id: location.id, name: location.name, projectId: location.projectId, runnerId: location.runnerId,
      workspaceId: location.workspaceId, addedBy: db.projectLocationAddedBy(location.id) }));
    const results = await Promise.all(locations.map((location) => inspectProjectLocation(this.deps, location.id, {
      projectId: location.projectId, timeoutMs: this.deps.inspectionTimeoutMs, joinsCampaign: true })));
    const now = Date.now();
    const revoked = db.recordUnreadLocationReads(root.id, before.map((location, index) => ({ location, result: results[index]! })), now);
    // A lift that isn't a join revokes what the refusal covered, and that always leaves its pauses and
    // is audited (#4319). No person's action led to it, only a runner's registration; with no owner to
    // name, the audit names none.
    if (revoked.length) this.deps.settle(root, revoked, this.owner(root) ?? db.campaignOwnerForRoot(root.id, root.orchestratorPolicy), now);
    else this.deps.hub.sessionChangedById(root.id);
  }

  /** Nobody reviews a Custom campaign's list, so only what its survey would list joins it: a Location
   * its owner added and, as they are now, can reach. A role can change while a runner inspects. */
  private customSurveyLists(root: SessionView, location: ProjectLocationView): boolean {
    const { db } = this.deps;
    const owner = this.owner(root);
    const organizationId = db.sessionScope(root.id)?.organizationId;
    const principal = owner && organizationId ? db.operatingHumanPrincipal(owner, organizationId) : null;
    return Boolean(principal && root.projectId && db.projectLocationAddedBy(location.id) === owner &&
      db.canAccessProject(principal, root.projectId) && db.canAccessWorkspace(principal, location.runnerId, location.workspaceId));
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
    const custom = fresh.orchestratorPolicy?.control?.mode !== "full_control";
    const joins: Array<{ locationId: string; name: string; repository: string; source: CampaignLocationJoin["source"] }> = [];
    const excluded: CampaignExcludedLocation[] = [];
    const pending: CampaignPendingLocation[] = [];
    // Locations read on a current runner, whatever is recorded for them: no longer unread (#4319).
    const read: string[] = [];
    let changed = false;
    results.forEach((result: ProjectLocationInspection, index) => {
      const location = locations[index]!;
      const was = before.get(location.id)!;
      const now = db.getProjectLocation(location.id);
      const eligible = Boolean(owner && now && now.projectId === fresh.projectId && now.availability !== "runner_removed" &&
        now.runnerId === was.runnerId && now.workspaceId === was.workspaceId && db.projectLocationAddedBy(location.id) === was.addedBy &&
        !this.inBoundary(fresh, location.id) &&
        (!custom || this.customSurveyLists(fresh, now)) &&
        (source !== "owner_added" || was.addedBy === owner) &&
        // Under the campaign's mode as it is now: one that changed meanwhile applies its own rule.
        (source !== "runner_reconnected" || fresh.orchestratorPolicy?.excludedLocations?.some((item) =>
          item.locationId === location.id && retriedOnReconnect(item, custom))) &&
        (source !== "owner_included" || Boolean(includer && includer.userId === owner &&
          db.canAccessWorkspace(includer, now.runnerId, now.workspaceId))));
      if (!eligible) { changed = true; return; }
      // A Custom Location read only to name its repository never joins (#4319). A read that names it
      // records the repository, which stays refused until an approved addition brings it in, even on a
      // current runner; one that fails records what it found.
      const previous = fresh.orchestratorPolicy?.excludedLocations?.find((item) => item.locationId === location.id);
      if (custom && source === "runner_reconnected" && previous && !customRejoins(previous)) {
        if (result.ok) {
          excluded.push({ locationId: location.id, name: location.name, failure: previous.failure, reason: previous.reason,
            repository: result.location.repository.toLowerCase(), nameOnly: true });
        } else {
          excluded.push({ locationId: location.id, name: location.name, failure: result.failure, reason: result.reason,
            ...(result.repository ? { repository: result.repository } : {}), nameOnly: true });
        }
        return;
      }
      // Only the owner's own Location joins on a reconnect. Anyone else's, or one with no recorded
      // adder, waits for Include in Campaign however it read: nobody has seen its repository.
      // While its runner is still too old, Include in Campaign can't help, so it keeps the reason that says why.
      if (source === "runner_reconnected" && was.addedBy !== owner && (result.ok || result.failure !== "runner_below_gates")) {
        pending.push({ locationId: location.id, name: location.name, reason: "added_by_other", cause: campaignPendingCause(was.addedBy, owner) });
        if (result.ok) read.push(location.id);
        return;
      }
      if (result.ok) joins.push({ locationId: location.id, name: location.name, repository: result.location.repository, source });
      else excluded.push({ locationId: location.id, name: location.name, failure: result.failure, reason: result.reason,
        ...(result.repository ? { repository: result.repository } : {}),
        // A transient read after the update must not end this Location's way back into a Custom list.
        ...(custom && result.failure !== "runner_below_gates" && RETRIED_ON_RECONNECT.has(result.failure) ? { rejoinsOnReconnect: true as const } : {}) });
    });
    if (changed && source === "owner_included") return { ok: false, status: 409, error: "That Location changed while it was inspected; try again." };
    // Include in Campaign is the owner's consent to someone else's Location: left unread, it counts (#4319).
    return this.record(fresh, { joins, excluded, pending, read, ...(source === "owner_included" ? { consented: locations.map((location) => location.id) } : {}) });
  }

  private async record(root: SessionView, update: { joins: Array<{ locationId: string; name: string; repository: string;
    source: CampaignLocationJoin["source"] }>; excluded: CampaignExcludedLocation[]; pending: CampaignPendingLocation[]; read?: string[]; consented?: string[] }): Promise<Outcome> {
    const owner = this.owner(root);
    if (!owner) return { ok: false, status: 409, error: "This campaign has no Full Control owner." };
    if (!update.joins.length && !update.excluded.length && !update.pending.length && !update.read?.length) {
      return { ok: true, data: { joined: false, revision: this.revision(root) } };
    }
    const now = Date.now();
    const result = this.deps.db.recordCampaignLocations(root.id, owner, update, now);
    if (!result.ok) {
      this.deps.log.warn(JSON.stringify({ event: "campaign_locations_not_recorded", sessionId: root.id, status: result.status }));
      return result;
    }
    if (result.joined && root.orchestratorPolicy?.control?.mode === "full_control") {
      // A join is an owner-authorized boundary change: what it revoked leaves its pauses, and every
      // member's runner gets the new boundary.
      this.deps.settle(root, result.revoked, owner, now);
      await this.deps.synchronize(root.id);
    } else if (result.revoked.length) {
      // A Custom list has no boundary to re-mint. Its join revokes only what was approved in a
      // repository it stops refusing (#4319), and that leaves its pauses the same way.
      this.deps.settle(root, result.revoked, owner, now);
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
