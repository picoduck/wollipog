import { RUNNER_CAPABILITY_MIN_PROTOCOL, type OrchestratorCampaignStatus } from "@wollipog/protocol";
import { projectScopeDecisionDetailsForUi } from "./scope-decision-details-compatibility.js";

/** What a dashboard older than `campaignHandoffs` reads for `complete_with_handoffs` (#4070). It
 * has no label or status meta for the new value, and it must never read it as active work: the
 * campaign is waiting on its owner's handed-off items, which is what `waiting_human` says. */
export const CAMPAIGN_HANDOFFS_FALLBACK_STATUS: OrchestratorCampaignStatus = "waiting_human";

/**
 * The status a dashboard at `uiProtocolVersion` can read for `status` (#4146). Each fallback is an
 * existing value that never reads as active work: below `campaignActivityStatus`, Complete, Needs
 * Cleanup is the terminal `complete_with_handoffs` (it is finished, with the owner's items left)
 * and Campaign Stuck is `blocked`; below `campaignHandoffs`, `complete_with_handoffs` in turn reads
 * as `waiting_human`. Every other status, and every status for a current dashboard, is unchanged.
 */
export function compatibleCampaignStatus(status: OrchestratorCampaignStatus, uiProtocolVersion: number | null | undefined):
  OrchestratorCampaignStatus {
  const version = uiProtocolVersion ?? 0;
  let compatible = status;
  if (compatible === "paused" && version < RUNNER_CAPABILITY_MIN_PROTOCOL.campaignPause) compatible = "stuck";
  if (version < RUNNER_CAPABILITY_MIN_PROTOCOL.campaignActivityStatus) {
    if (compatible === "complete_needs_cleanup") compatible = "complete_with_handoffs";
    else if (compatible === "stuck") compatible = "blocked";
  }
  if (version < RUNNER_CAPABILITY_MIN_PROTOCOL.campaignHandoffs && compatible === "complete_with_handoffs") {
    compatible = CAMPAIGN_HANDOFFS_FALLBACK_STATUS;
  }
  return compatible;
}

/** Statuses some older dashboard cannot read, so a payload without any is sent unchanged. */
const NEWER_STATUSES: ReadonlySet<unknown> = new Set(["paused", "complete_with_handoffs", "complete_needs_cleanup", "stuck"]);

/** A campaign projection: it carries the status the session's own fields do not. */
function projectionLike(value: Record<string, unknown>): boolean {
  return typeof value.status === "string" && typeof value.decisionOwners === "object" && value.decisionOwners !== null &&
    typeof value.children === "object";
}

/**
 * A copy of a dashboard payload that an older dashboard can read: every session's
 * `fullControlCampaignStatus` and embedded `orchestratorCampaign.status`, and any campaign
 * projection, report the status that dashboard knows (compatibleCampaignStatus). Current dashboards
 * and agent principals receive the payload unchanged; so does every payload that has no such status.
 */
export function projectCampaignStatusForUi<T>(payload: T, uiProtocolVersion: number | null | undefined, depth = 0): T {
  // This delivery boundary is shared by REST responses, snapshots and live session upserts.
  if (depth === 0) payload = projectScopeDecisionDetailsForUi(payload, uiProtocolVersion);
  if ((uiProtocolVersion ?? 0) >= RUNNER_CAPABILITY_MIN_PROTOCOL.campaignPause || depth > 3 ||
      payload == null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    const projected = payload.map((value) => projectCampaignStatusForUi(value, uiProtocolVersion, depth + 1));
    return (projected.some((value, index) => value !== payload[index]) ? projected : payload) as T;
  }
  const value = payload as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  const fallback = (status: unknown) => compatibleCampaignStatus(status as OrchestratorCampaignStatus, uiProtocolVersion);
  if (NEWER_STATUSES.has(value.fullControlCampaignStatus) && fallback(value.fullControlCampaignStatus) !== value.fullControlCampaignStatus) {
    (result ??= { ...value }).fullControlCampaignStatus = fallback(value.fullControlCampaignStatus);
  }
  const campaign = value.orchestratorCampaign as Record<string, unknown> | null | undefined;
  if (campaign && typeof campaign === "object" && NEWER_STATUSES.has(campaign.status) && fallback(campaign.status) !== campaign.status) {
    (result ??= { ...value }).orchestratorCampaign = { ...campaign, status: fallback(campaign.status) };
  }
  if (projectionLike(value) && NEWER_STATUSES.has(value.status) && fallback(value.status) !== value.status) {
    (result ??= { ...value }).status = fallback(value.status);
  }
  for (const key of ["session", "sessions", "items", "campaign"]) {
    if (!(key in value)) continue;
    const child = projectCampaignStatusForUi(value[key], uiProtocolVersion, depth + 1);
    if (child !== value[key]) (result ??= { ...value })[key] = child;
  }
  return (result ?? payload) as T;
}
