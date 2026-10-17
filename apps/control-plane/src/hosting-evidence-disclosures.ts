import {
  CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION, CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE,
  CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION, campaignSessionArtifactDestinationId,
} from "@wollipog/protocol";
import type { EvidenceAuthorityDisclosures } from "./evidence-authority.js";

type Reviewer = { driver: "codex-app-server" | "claude-code"; modelId: string };
const PROVIDERS = new Set<string>(["claude-code", "codex-app-server"]);

/** Server-authored disclosures for the hosting control plane. The only destination is one
 * organization's private Session artifacts; the only providers are the audited native harnesses,
 * offering the models their registered installations actually advertise. */
export function hostingEvidenceAuthorityDisclosures(source: {
  organizationExists(organizationId: string): boolean;
  listRunners(): Array<{ agents: Array<{ driver?: string; context?: { kind: string }; capabilities?: { models?: Array<{ id: string }> } }> }>;
}): EvidenceAuthorityDisclosures {
  return {
    destination(id) {
      const prefix = campaignSessionArtifactDestinationId("");
      if (!id.startsWith(prefix)) return null;
      const organizationId = id.slice(prefix.length);
      if (!organizationId || campaignSessionArtifactDestinationId(organizationId) !== id || !source.organizationExists(organizationId)) return null;
      return { organizationId, privacy: "private", disclosureRevision: CAMPAIGN_SESSION_ARTIFACT_DISCLOSURE_REVISION };
    },
    provider(id) {
      if (!PROVIDERS.has(id)) return null;
      const reviewers = new Map<string, Reviewer>();
      for (const runner of source.listRunners()) {
        for (const agent of runner.agents) {
          if (agent.driver !== id || (agent.context && agent.context.kind !== "native")) continue;
          for (const model of agent.capabilities?.models ?? []) {
            if (typeof model.id === "string" && model.id && !model.id.includes("*")) {
              reviewers.set(model.id, { driver: id as Reviewer["driver"], modelId: model.id });
            }
          }
        }
      }
      return { disclosureRevision: CAMPAIGN_EVIDENCE_PROVIDER_DISCLOSURE_REVISION,
        retentionDisclosure: CAMPAIGN_EVIDENCE_RETENTION_DISCLOSURE, reviewers: [...reviewers.values()] };
    },
  };
}
