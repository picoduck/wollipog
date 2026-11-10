/** The lowest runner protocol that can perform every gate a campaign routes through a Location
 * (#4319): the highest of `locationIssueClosure`, `locationForgeObservation` and
 * `locationIssuePublication`. A Location on an older runner doesn't join a campaign. Raise this when a
 * new gate raises that highest floor; a protocol test holds the two together. */
export const CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL = 327;

/** Why one Project Location could not be verified (#4117, #4138). Each reason is a fixed,
 * non-sensitive sentence: no local path, origin URL or command output ever reaches it. */
export const PROJECT_LOCATION_INSPECTION_FAILURES = {
  runner_offline: "The Location's machine is offline.",
  runner_too_old: "The Location's runner is too old to verify it; update the runner.",
  runner_below_gates: `The Location's runner can't perform this campaign's gates. Update and restart it to protocol version ${CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL} or newer.`,
  unknown_location: "The Location is not an active Location of this Project.",
  path_missing: "The Location's folder is missing or unavailable on its machine.",
  not_repository: "The Location's folder is not a git repository with a valid HEAD.",
  unsupported_origin: "The Location's repository origin is unsupported; a github.com or GitLab origin is required.",
  read_failed: "The Location could not be read on its machine.",
} as const;
export type ProjectLocationInspectionFailure = keyof typeof PROJECT_LOCATION_INSPECTION_FAILURES;

/** One Project Location a runner verified in its own resolved path. The Location id, not its name
 * or path, is the identity; `repository` is the forge repository its origin names. */
export interface VerifiedProjectLocation {
  locationId: string;
  projectId: string;
  runnerId: string;
  workspaceId: string;
  repository: string;
  /** Runner digest of the inspected path, repository and HEAD. */
  digest: string;
  verifiedAt: number;
}

/** A Project Location left out of a campaign's repository boundary (#4117), with its fixed reason. */
export interface CampaignExcludedLocation {
  locationId: string;
  /** The Location's name when it was inspected. */
  name: string;
  failure: ProjectLocationInspectionFailure;
  reason: string;
  /** A Custom campaign only (#4319): this exclusion began as `runner_below_gates`, so a reconnect still
   * retries it whatever the last read found. Full Control retries by `failure` alone. */
  rejoinsOnReconnect?: true;
  /** A Custom campaign only (#4319): this Location was left out for another reason at creation, such
   * as its machine being offline. A reconnect reads it only to name its repository, so that repository
   * can be refused. It never joins on a reconnect, as a Location offline at creation never has. */
  nameOnly?: true;
  /** What a `runner_below_gates` Location verified as, when its runner can still read one (v288+):
   * while it is left out, that repository's gates refuse by this Location's name (#4319). */
  repository?: string;
}

/** A repository a read found behind a Location whose runner can't perform the campaign's gates
 * (#4319). Server-owned. Its gates refuse by that Location's name until the repository holds an
 * entry, which only a join or an approved addition gives it, each revoking what was approved
 * meanwhile. Nothing else clears it: not a later read that fails, a move to waiting, a revoke, a
 * re-authorization, nor the Location leaving the Project. */
export interface CampaignRefusedRepository {
  repository: string;
  locationId: string;
  /** The Location's name when it was read. */
  name: string;
}

/** A launch Location kept in the boundary although its root runner can't create issues through a
 * Location, so a follow-up routed to its repository from another of the campaign's can't be created
 * (#4319). Its repository's other gates run in the root's own checkout and aren't affected. */
export interface CampaignLimitedLocation {
  locationId: string;
  name: string;
  reason: string;
}

export const CAMPAIGN_LIMITED_LOCATION_REASON = `Follow-ups from this campaign's other repositories can't be created in this Location's repository until its runner is on protocol version ${CAMPAIGN_LOCATION_GATES_MIN_PROTOCOL} or newer.`;

/** Why a Project Location waits for the owner's Include in Campaign (#4312):
 * - `added_by_other`: someone other than the campaign's owner added it to the Project;
 * - `no_recorded_adder`: nobody is recorded as having added it, as for one added before adders were
 *   recorded, or by no person;
 * - `owner_added`: the owner added it, but it couldn't join on its own;
 * - `repository_added`: the owner approved adding another Location of its repository, and this one
 *   wasn't part of that approval. */
export type CampaignPendingCause = "added_by_other" | "no_recorded_adder" | "owner_added" | "repository_added";

export const CAMPAIGN_PENDING_CAUSES: readonly CampaignPendingCause[] = ["added_by_other", "no_recorded_adder", "owner_added", "repository_added"];

/** A Project Location that waits for the owner's Include in Campaign (#4117). It joins only then. */
export interface CampaignPendingLocation {
  locationId: string;
  name: string;
  /** Kept as stored for older readers: it never said why, despite its name. `cause` does. */
  reason: "added_by_other";
  /** Why it waits (#4312). An entry stored before has none, and Campaign Status claims nothing then. */
  cause?: CampaignPendingCause;
}

/** Why a Location waits, from who is recorded as having added it and who owns the campaign (#4312). */
export function campaignPendingCause(addedBy: string | null | undefined, owner: string | null | undefined): CampaignPendingCause {
  if (!addedBy) return "no_recorded_adder";
  return owner && addedBy === owner ? "owner_added" : "added_by_other";
}

/** A Project Location of a repository the owner's first message left out of the campaign (#4117).
 * It is available but doesn't join: only an approved `campaign_repository_addition` brings its
 * repository in. `repository` is what the Location verified as. */
export interface CampaignAvailableLocation {
  locationId: string;
  name: string;
  repository: string;
}

/** One Location that joined a campaign's boundary after launch, and the boundary revision it
 * joined at. */
export interface CampaignLocationJoin {
  locationId: string;
  name: string;
  repository: string;
  revision: number;
  at: number;
  source: "owner_added" | "runner_reconnected" | "owner_included" | "addition_approved";
}

export const CAMPAIGN_LOCATION_JOINS_MAX = 50;

/** Campaign Status's view of the repository boundary (#4117): each boundary repository with its
 * Locations, the Locations left out with their reasons, those waiting for the owner, those the
 * owner's first message left out, and the Locations that joined after launch. Names only; no path
 * or origin. */
export interface CampaignRepositoryBoundaryView {
  revision: number;
  repositories: Array<{ repository: string; locations: Array<{ locationId: string; name: string;
    availability: import("./index.js").ProjectLocationAvailability | "removed"; isDefault: boolean }> }>;
  excludedLocations: CampaignExcludedLocation[];
  /** Read live from the root's runner, so it clears when that runner updates. Absent with none. */
  limitedLocations?: CampaignLimitedLocation[];
  pendingLocations: CampaignPendingLocation[];
  /** Absent from a control plane before v320. */
  availableLocations?: CampaignAvailableLocation[];
  /** The repositories the owner's first message limits the campaign to; absent with no limit. */
  repositoryLimits?: string[];
  joins: CampaignLocationJoin[];
}

export type ProjectLocationInspection =
  | { ok: true; location: VerifiedProjectLocation; issueFacts?: import("./index.js").CampaignIssueFacts[];
    /** The asked-for epic and its members, all in `location.repository`. */
    candidates?: NonNullable<import("./index.js").CampaignIssueScopeView["candidates"]> }
  | { ok: false; locationId: string; failure: ProjectLocationInspectionFailure; reason: string; repository?: string };
