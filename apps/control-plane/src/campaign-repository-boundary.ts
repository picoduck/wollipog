import {
  CAMPAIGN_BOUNDARY_LOCATIONS_MAX, CAMPAIGN_BOUNDARY_REPOSITORIES_MAX, PROJECT_LOCATION_INSPECTION_FAILURES, campaignBoundaryRepositories,
  type CampaignAvailableLocation, type CampaignBoundaryRepository, type CampaignPendingLocation, type CampaignExcludedLocation, type ProjectLocationInspection, type ProjectLocationView, type SessionView,
} from "@wollipog/protocol";

/** The repository whose listed Location a runner and workspace are, lower-cased, or null: an active
 * Location of the root's Project that one of `entries` lists (#4118, #4119). */
export function campaignLocationRepository(
  db: { getProjectLocation(locationId: string): ProjectLocationView | null },
  root: Partial<Pick<SessionView, "projectId">>,
  entries: readonly CampaignBoundaryRepository[],
  place: { runnerId?: string | null; workspaceId?: string | null },
): string | null {
  if (!root.projectId || !place.runnerId || !place.workspaceId) return null;
  for (const entry of entries) {
    for (const locationId of entry.locationIds) {
      const location = db.getProjectLocation(locationId);
      if (location && location.availability !== "runner_removed" && location.projectId === root.projectId &&
          location.runnerId === place.runnerId && location.workspaceId === place.workspaceId) return entry.repository.toLowerCase();
    }
  }
  return null;
}

/** The boundary repository whose Location a runner and workspace are (#4119), lower-cased, or null.
 * The root's own runner and workspace are always a Location of the first entry, so a boundary that
 * predates the list keeps today's single placement. Any other place must be an active Location of
 * the root's Project that a boundary entry lists. An ad-hoc path (no workspace) is never one. */
export function campaignBoundaryRepositoryAt(
  db: { getProjectLocation(locationId: string): ProjectLocationView | null },
  root: Pick<SessionView, "runnerId" | "workspaceId" | "orchestratorPolicy"> & Partial<Pick<SessionView, "projectId">>,
  place: { runnerId?: string | null; workspaceId?: string | null },
): string | null {
  const control = root.orchestratorPolicy?.control;
  if (control?.mode !== "full_control" || !place.runnerId || !place.workspaceId) return null;
  if (place.runnerId === root.runnerId && place.workspaceId === root.workspaceId) return control.boundary.repository.toLowerCase();
  return campaignLocationRepository(db, root, campaignBoundaryRepositories(control.boundary), place);
}

/** One Location of the campaign's Project, in Project order (its default Location first). */
export interface CampaignProjectLocation { id: string; name: string }

/** The boundary's repositories from one launch (#4117). The launch Location's repository is the
 * first entry; every other verified Location joins the entry for its repository, and entries
 * follow in the Project order of their first Location. Within an entry, Locations keep Project
 * order, so the default Location leads whenever it verified. A failed Location is excluded with
 * its reason and never blocks the launch. Past the boundary's size bounds, the remaining
 * Locations are excluded as unreadable rather than dropped silently.
 *
 * `carried` is what an existing campaign already holds when it is enabled again: the owner already
 * authorized those repositories, so an inspection can add to them but never take one away. A carried
 * Location that can't be read now stays where it is, rather than being listed as excluded, and a
 * repository that lost every Location keeps its entry. The size bounds reserve room for them, so a
 * newly verified Location is the one left out when the boundary is full.
 *
 * `limits` is what the owner's first message limited an existing campaign to: an enable inspects the
 * whole Project, but a verified Location of another repository is available and doesn't join.
 *
 * `waiting` is what an enable never inspected, because its owner didn't add it: unless the campaign
 * already holds it, it keeps waiting for Include in Campaign. */
export function launchBoundaryRepositories(input: {
  launchRepository: string;
  launchLocationId: string | null;
  locations: readonly CampaignProjectLocation[];
  inspections: ReadonlyMap<string, ProjectLocationInspection>;
  carried?: readonly CampaignBoundaryRepository[] | undefined;
  limits?: readonly string[] | undefined;
  waiting?: readonly CampaignProjectLocation[] | undefined;
}): { repositories: CampaignBoundaryRepository[]; excluded: CampaignExcludedLocation[]; available: CampaignAvailableLocation[]; pending: CampaignPendingLocation[] } {
  const launch = input.launchRepository.toLowerCase();
  const entries = new Map<string, CampaignBoundaryRepository>([[launch, { repository: launch, locationIds: [] }]]);
  const excluded: CampaignExcludedLocation[] = [];
  const available: CampaignAvailableLocation[] = [];
  const placed = new Set<string>();
  const carriedEntries = input.carried ?? [];
  const heldRepositories = new Set(carriedEntries.map((entry) => entry.repository.toLowerCase()));
  const heldLocations = new Set(carriedEntries.flatMap((entry) => entry.locationIds));
  // What the campaign holds that isn't placed yet keeps its room in the boundary.
  const reservedRepositories = () => [...heldRepositories].filter((name) => !entries.has(name)).length;
  const reservedLocations = () => [...heldLocations].filter((id) => !placed.has(id)).length;
  for (const location of input.locations) {
    const inspection = location.id === input.launchLocationId
      ? { ok: true as const, repository: launch }
      : (() => {
        const result = input.inspections.get(location.id);
        return result?.ok ? { ok: true as const, repository: result.location.repository.toLowerCase() }
          // A Location nobody inspected is shown as unread, never silently left out.
          : result ?? { ok: false as const, failure: "read_failed" as const, reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed };
      })();
    if (!inspection.ok) {
      excluded.push({ locationId: location.id, name: location.name, failure: inspection.failure, reason: inspection.reason });
      continue;
    }
    if (input.limits?.length && inspection.repository !== launch && !heldRepositories.has(inspection.repository) &&
        !input.limits.includes(inspection.repository)) {
      available.push({ locationId: location.id, name: location.name, repository: inspection.repository });
      continue;
    }
    const entry = entries.get(inspection.repository);
    const noRepository = !entry && !heldRepositories.has(inspection.repository) &&
      entries.size + reservedRepositories() >= CAMPAIGN_BOUNDARY_REPOSITORIES_MAX;
    const noLocation = !heldLocations.has(location.id) && placed.size + reservedLocations() >= CAMPAIGN_BOUNDARY_LOCATIONS_MAX;
    if (noRepository || noLocation) {
      excluded.push({ locationId: location.id, name: location.name, failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed });
      continue;
    }
    if (entry) entry.locationIds.push(location.id);
    else entries.set(inspection.repository, { repository: inspection.repository, locationIds: [location.id] });
    placed.add(location.id);
  }
  for (const carried of carriedEntries) {
    const repository = carried.repository.toLowerCase();
    const entry = entries.get(repository) ?? { repository, locationIds: [] };
    entries.set(repository, entry);
    for (const id of carried.locationIds) {
      // A Location that verified now, as any repository, is already placed by what it verified as.
      if (placed.has(id)) continue;
      entry.locationIds.push(id);
      placed.add(id);
    }
  }
  return { repositories: [...entries.values()], excluded: excluded.filter((item) => !placed.has(item.locationId)),
    available: available.filter((item) => !placed.has(item.locationId)),
    pending: (input.waiting ?? []).filter((location) => !placed.has(location.id))
      .map((location) => ({ locationId: location.id, name: location.name, reason: "added_by_other" as const })) };
}
