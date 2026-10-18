import type { OrchestratorCampaignProjection } from "@wollipog/protocol";

const IMAGE_RETENTION_DISCLOSURE =
  "When Orchestrator review is available, evidence images are sent to its selected model/provider. This includes every derived frame of a short video in an operator-enabled validation campaign. The provider may retain images in provider-local transcripts or media logs. Wollipog's control-plane audit records evidence references, digests, and review receipts, not raw image bytes; provider-local retention is outside those audit guarantees.";

/** Shown beside both human-controlled UI Evidence Approval authority selectors, where no single
 * campaign's video review applies. */
export const DELEGATED_UI_EVIDENCE_RETENTION_DISCLOSURE =
  `${IMAGE_RETENTION_DISCLOSURE} Video evidence otherwise requires human review, including video attached as a Session artifact, unless a Full Control campaign's certified media-only reviewer is available.`;

/** The same disclosure for one campaign. Its video sentence follows the server's
 * `videoEvidenceReview` fact (#1321), the fact the campaign's Video Evidence Review line states, so
 * the two never contradict each other. Without the fact (a Custom campaign or an older server) video
 * stays with a person. */
export function uiEvidenceRetentionDisclosure(video: OrchestratorCampaignProjection["videoEvidenceReview"]): string {
  return video?.status === "available"
    ? `${IMAGE_RETENTION_DISCLOSURE} In this campaign, video evidence attached as a Session artifact goes to the certified media-only reviewer instead, and its provider may retain the frames it receives in the same way.`
    : `${IMAGE_RETENTION_DISCLOSURE} In this campaign, video evidence requires human review, including video attached as a Session artifact.`;
}
