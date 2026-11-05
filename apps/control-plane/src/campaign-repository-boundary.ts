import {
  CAMPAIGN_BOUNDARY_LOCATIONS_MAX, CAMPAIGN_BOUNDARY_REPOSITORIES_MAX, PROJECT_LOCATION_INSPECTION_FAILURES,
  type CampaignBoundaryRepository, type CampaignExcludedLocation, type ProjectLocationInspection,
} from "@wollipog/protocol";

/** One Location of the campaign's Project, in Project order (its default Location first). */
export interface CampaignProjectLocation { id: string; name: string }

/** The boundary's repositories from one launch (#4117). The launch Location's repository is the
 * first entry; every other verified Location joins the entry for its repository, and entries
 * follow in the Project order of their first Location. Within an entry, Locations keep Project
 * order, so the default Location leads whenever it verified. A failed Location is excluded with
 * its reason and never blocks the launch. Past the boundary's size bounds, the remaining
 * Locations are excluded as unreadable rather than dropped silently. */
export function launchBoundaryRepositories(input: {
  launchRepository: string;
  launchLocationId: string | null;
  locations: readonly CampaignProjectLocation[];
  inspections: ReadonlyMap<string, ProjectLocationInspection>;
}): { repositories: CampaignBoundaryRepository[]; excluded: CampaignExcludedLocation[] } {
  const launch = input.launchRepository.toLowerCase();
  const entries = new Map<string, CampaignBoundaryRepository>([[launch, { repository: launch, locationIds: [] }]]);
  const excluded: CampaignExcludedLocation[] = [];
  let locationCount = 0;
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
    const entry = entries.get(inspection.repository);
    if ((!entry && entries.size >= CAMPAIGN_BOUNDARY_REPOSITORIES_MAX) || locationCount >= CAMPAIGN_BOUNDARY_LOCATIONS_MAX) {
      excluded.push({ locationId: location.id, name: location.name, failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed });
      continue;
    }
    if (entry) entry.locationIds.push(location.id);
    else entries.set(inspection.repository, { repository: inspection.repository, locationIds: [location.id] });
    locationCount += 1;
  }
  return { repositories: [...entries.values()], excluded };
}
