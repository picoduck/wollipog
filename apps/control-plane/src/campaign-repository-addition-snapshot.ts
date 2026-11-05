import {
  CAMPAIGN_REPOSITORY_ADDITION_LIMITS, campaignRepositoryLocation,
  type CampaignRepositoryAdditionSnapshot,
} from "@wollipog/protocol";

// No control characters, and no Unicode line or paragraph separators (U+2028, U+2029).
const LINE_OR_CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "u");
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= max && !LINE_OR_CONTROL.test(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Shape only (#4117). The generic decision route refuses caller-prepared repository additions:
 * only request_campaign_repository_addition creates one, from an inspection the server ran. */
export function normalizeCampaignRepositoryAdditionSnapshot(value: Record<string, unknown>): CampaignRepositoryAdditionSnapshot | null {
  const work = value.work;
  if (Object.keys(value).some((key) => !["category", "locationId", "locationName", "repository", "reason", "work"].includes(key)) ||
      value.category !== "campaign_repository_addition" || !bounded(value.locationId, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.id) ||
      !bounded(value.locationName, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.title) ||
      typeof value.repository !== "string" || campaignRepositoryLocation(value.repository) === null ||
      value.repository !== value.repository.toLowerCase() || !bounded(value.reason, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.reason) ||
      !record(work) || Object.keys(work).some((key) => !["kind", "id", "title"].includes(key)) ||
      (work.kind !== "follow_up" && work.kind !== "work_item") || !bounded(work.id, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.id) ||
      !bounded(work.title, CAMPAIGN_REPOSITORY_ADDITION_LIMITS.title)) return null;
  return { category: "campaign_repository_addition", locationId: value.locationId, locationName: value.locationName,
    repository: value.repository, reason: value.reason, work: { kind: work.kind, id: work.id, title: work.title } };
}
