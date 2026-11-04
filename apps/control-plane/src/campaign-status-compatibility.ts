import { RUNNER_CAPABILITY_MIN_PROTOCOL, type OrchestratorCampaignStatus } from "@wollipog/protocol";

/** What a dashboard older than `campaignHandoffs` reads for `complete_with_handoffs` (#4070). It
 * has no label or status meta for the new value, and it must never read it as active work: the
 * campaign is waiting on its owner's handed-off items, which is what `waiting_human` says. */
export const CAMPAIGN_HANDOFFS_FALLBACK_STATUS: OrchestratorCampaignStatus = "waiting_human";

/** A campaign projection: it carries the status the session's own fields do not. */
function projectionLike(value: Record<string, unknown>): boolean {
  return typeof value.status === "string" && typeof value.decisionOwners === "object" && value.decisionOwners !== null &&
    typeof value.children === "object";
}

/**
 * A copy of a dashboard payload that an older dashboard can read: every session's
 * `fullControlCampaignStatus` and embedded `orchestratorCampaign.status`, and any campaign
 * projection, report `complete_with_handoffs` as the fallback status. Current dashboards and agent
 * principals receive the payload unchanged; so does every payload that has no such status.
 */
export function projectCampaignHandoffsForUi<T>(payload: T, uiProtocolVersion: number | null | undefined, depth = 0): T {
  if ((uiProtocolVersion ?? 0) >= RUNNER_CAPABILITY_MIN_PROTOCOL.campaignHandoffs || depth > 3 ||
      payload == null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    const projected = payload.map((value) => projectCampaignHandoffsForUi(value, uiProtocolVersion, depth + 1));
    return (projected.some((value, index) => value !== payload[index]) ? projected : payload) as T;
  }
  const value = payload as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  if (value.fullControlCampaignStatus === "complete_with_handoffs") {
    (result ??= { ...value }).fullControlCampaignStatus = CAMPAIGN_HANDOFFS_FALLBACK_STATUS;
  }
  const campaign = value.orchestratorCampaign as Record<string, unknown> | null | undefined;
  if (campaign && typeof campaign === "object" && campaign.status === "complete_with_handoffs") {
    (result ??= { ...value }).orchestratorCampaign = { ...campaign, status: CAMPAIGN_HANDOFFS_FALLBACK_STATUS };
  }
  if (projectionLike(value) && value.status === "complete_with_handoffs") {
    (result ??= { ...value }).status = CAMPAIGN_HANDOFFS_FALLBACK_STATUS;
  }
  for (const key of ["session", "sessions", "items", "campaign"]) {
    if (!(key in value)) continue;
    const child = projectCampaignHandoffsForUi(value[key], uiProtocolVersion, depth + 1);
    if (child !== value[key]) (result ??= { ...value })[key] = child;
  }
  return (result ?? payload) as T;
}
