import { campaignEvidenceAuthorityBound, validCampaignEvidenceAuthority,
  type CampaignAuthorityBoundary, type CampaignEvidenceAuthority } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";

export interface EvidenceAuthorityProposal {
  destinationConfigurationId: string;
  destinationDisclosureRevision: number;
  providers: Array<{ providerId: string; disclosureRevision: number;
    reviewers: CampaignEvidenceAuthority["providers"][number]["reviewers"] }>;
}
export interface EvidenceAuthorityDisclosures {
  destination(id: string): { organizationId: string; privacy: "private" | "public";
    disclosureRevision: number } | null;
  provider(id: string): { disclosureRevision: number; retentionDisclosure: string;
    reviewers: CampaignEvidenceAuthority["providers"][number]["reviewers"] } | null;
}

/** Called only inside an authenticated human campaign CAS admission. All provenance comes from
 * that principal and boundary; destination and retention disclosures come from server config.
 * Neither a prompt nor a proposal can authorize provider delivery, mint a new policy revision,
 * or turn a public/unknown upload destination private. */
export function mintCampaignEvidenceAuthority(
  principal: AuthPrincipal,
  boundary: CampaignAuthorityBoundary,
  campaignRootSessionId: string,
  proposal: EvidenceAuthorityProposal,
  disclosures: EvidenceAuthorityDisclosures,
): CampaignEvidenceAuthority | null {
  if (principal.kind !== "human" || principal.userId !== boundary.authorizedByUserId ||
    !campaignRootSessionId || !proposal || typeof proposal !== "object" || Array.isArray(proposal) ||
    Object.keys(proposal).some((key) => !["destinationConfigurationId", "destinationDisclosureRevision", "providers"].includes(key)) ||
    typeof proposal.destinationConfigurationId !== "string" || !Array.isArray(proposal.providers) ||
    proposal.providers.length === 0 || proposal.providers.length > 8) return null;
  const destination = disclosures.destination(proposal.destinationConfigurationId);
  if (!destination || destination.privacy !== "private" || destination.organizationId !== principal.organizationId ||
    destination.disclosureRevision !== proposal.destinationDisclosureRevision) return null;
  const providers: CampaignEvidenceAuthority["providers"] = [];
  for (const requested of proposal.providers) {
    if (!requested || typeof requested !== "object" || Array.isArray(requested) ||
      Object.keys(requested).some((key) => !["providerId", "disclosureRevision", "reviewers"].includes(key)) ||
      typeof requested.providerId !== "string") return null;
    const disclosed = disclosures.provider(requested.providerId);
    if (!disclosed || disclosed.disclosureRevision !== requested.disclosureRevision ||
      !Array.isArray(requested.reviewers) || !requested.reviewers.length ||
      requested.reviewers.some((r) => !r || typeof r !== "object" || !disclosed.reviewers.some((offered) =>
        offered.driver === r.driver && offered.modelId === r.modelId))) return null;
    providers.push({ providerId: requested.providerId, disclosureRevision: disclosed.disclosureRevision,
      retentionDisclosure: disclosed.retentionDisclosure, reviewers: structuredClone(requested.reviewers) });
  }
  const authority: CampaignEvidenceAuthority = {
    version: 1, revision: boundary.revision, authorizedByUserId: principal.userId,
    authorizedAt: boundary.authorizedAt, campaignRootSessionId, repository: boundary.repository,
    objective: boundary.objective, issueScopeRevision: boundary.issueScopeRevision,
    scope: "relevant_task_evidence_only", destination: { kind: "session_artifacts",
      configurationId: proposal.destinationConfigurationId, organizationId: destination.organizationId,
      privacy: "private", disclosureRevision: destination.disclosureRevision }, providers,
  };
  return validCampaignEvidenceAuthority(authority) && campaignEvidenceAuthorityBound(authority, boundary)
    ? structuredClone(authority) : null;
}
