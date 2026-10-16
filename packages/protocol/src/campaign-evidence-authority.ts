/** A narrowing disclosure envelope, never a second evidence-access authority. Only the
 * authenticated human campaign admission may construct it. Agents cannot mint it from prompts. */
export interface CampaignEvidenceAuthority {
  version: 1;
  revision: number;
  authorizedByUserId: string;
  authorizedAt: number;
  campaignRootSessionId: string;
  repository: string;
  objective: string;
  issueScopeRevision: number;
  scope: "relevant_task_evidence_only";
  destination: {
    kind: "session_artifacts";
    configurationId: string;
    organizationId: string;
    privacy: "private";
    disclosureRevision: number;
  };
  providers: Array<{
    providerId: string;
    disclosureRevision: number;
    /** Human-reviewed provider retention disclosure; unknown retention is not inferred as zero. */
    retentionDisclosure: string;
    reviewers: Array<{ driver: "codex-app-server" | "claude-code"; modelId: string }>;
  }>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function validCampaignEvidenceAuthority(value: unknown): value is CampaignEvidenceAuthority {
  if (!record(value) || !exact(value, ["version", "revision", "authorizedByUserId", "authorizedAt",
    "campaignRootSessionId", "repository", "objective", "issueScopeRevision", "scope", "destination", "providers"]) ||
    value.version !== 1 || !positive(value.revision) || !positive(value.authorizedAt) ||
    !positive(value.issueScopeRevision) || !text(value.authorizedByUserId) || !text(value.campaignRootSessionId) ||
    !text(value.repository) || !/^[\w.-]+\/[\w.-]+$/u.test(value.repository) ||
    !text(value.objective, 4000) || value.scope !== "relevant_task_evidence_only") return false;
  const d = value.destination;
  if (!record(d) || !exact(d, ["kind", "configurationId", "organizationId", "privacy", "disclosureRevision"]) ||
    d.kind !== "session_artifacts" || d.privacy !== "private" || !text(d.configurationId) ||
    !text(d.organizationId) || !positive(d.disclosureRevision)) return false;
  const providers = value.providers;
  if (!Array.isArray(providers) || !providers.length || providers.length > 8) return false;
  const providerIds = new Set<string>();
  for (const p of providers) {
    if (!record(p) || !exact(p, ["providerId", "disclosureRevision", "retentionDisclosure", "reviewers"]) ||
      !text(p.providerId) || providerIds.has(p.providerId) || !positive(p.disclosureRevision) ||
      !text(p.retentionDisclosure, 4000) || !Array.isArray(p.reviewers) ||
      !p.reviewers.length || p.reviewers.length > 16) return false;
    providerIds.add(p.providerId);
    const reviewers = new Set<string>();
    for (const r of p.reviewers) {
      if (!record(r) || !exact(r, ["driver", "modelId"]) ||
        !["codex-app-server", "claude-code"].includes(String(r.driver)) || !text(r.modelId) || r.modelId.includes("*")) return false;
      const key = JSON.stringify([r.driver, r.modelId]);
      if (reviewers.has(key)) return false;
      reviewers.add(key);
    }
  }
  return true;
}

/** Binding to the outer human mint prevents a copied envelope from surviving a new objective,
 * scope, authorizer, or policy revision. Missing envelopes never authorize implicit disclosure. */
export function campaignEvidenceAuthorityBound(
  value: CampaignEvidenceAuthority,
  boundary: { revision: number; authorizedByUserId: string; authorizedAt: number;
    repository: string; objective: string; issueScopeRevision: number },
): boolean {
  return validCampaignEvidenceAuthority(value) && value.revision === boundary.revision &&
    value.authorizedByUserId === boundary.authorizedByUserId && value.authorizedAt === boundary.authorizedAt &&
    value.repository.toLowerCase() === boundary.repository.toLowerCase() &&
    value.objective === boundary.objective && value.issueScopeRevision === boundary.issueScopeRevision;
}
