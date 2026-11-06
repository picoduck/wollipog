/** The work that needs a Project repository outside a campaign's boundary (#4117): a follow-up the
 * campaign recorded, or one of its work items. Server-resolved from the campaign's own records. */
export interface CampaignRepositoryAdditionWork {
  kind: "follow_up" | "work_item";
  /** The recommendation id of a recorded follow-up, or the work item id. */
  id: string;
  /** Its title as the campaign recorded it. */
  title: string;
}

/** An Orchestrator's request to add one Project Location's repository to its campaign (#4117). */
export interface CampaignRepositoryAdditionRequest {
  requestId: string;
  /** The Project Location, by id. Its repository comes only from inspecting it. */
  locationId: string;
  /** Why the campaign needs this repository, in one line the owner reads as the Orchestrator's words. */
  reason: string;
  /** The recorded follow-up or work item that needs it. */
  work: { kind: CampaignRepositoryAdditionWork["kind"]; id: string };
}

/** Always the campaign owner's decision, in Full Control and Custom alike: adding a repository
 * widens the authority the owner gave. Everything but `reason` is server-established. */
export interface CampaignRepositoryAdditionSnapshot {
  category: "campaign_repository_addition";
  locationId: string;
  locationName: string;
  /** The forge repository the Location verified as when the request was made. */
  repository: string;
  /** The Orchestrator's own words, shown quoted as agent text. Never authority. */
  reason: string;
  work: CampaignRepositoryAdditionWork;
}

/** What an approved addition did, once its requester carried it out. */
export interface CampaignRepositoryAdditionResult {
  repository: string;
  locationId: string;
  /** The boundary revision it joined at; 0 for a Custom campaign, which has no boundary revision. */
  revision: number;
  completedAt: number;
}

export const CAMPAIGN_REPOSITORY_ADDITION_LIMITS = { requestId: 256, id: 256, reason: 1000, title: 300 } as const;
