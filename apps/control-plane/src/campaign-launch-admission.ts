import { createHash } from "node:crypto";
import {
  validCampaignControl,
  type CampaignLaunchPreflight, type CampaignLaunchProposal, type PreparedCampaignLaunch,
  type CampaignLaunchInspectionResult, type RunnerView,
} from "@wollipog/protocol";

const keys = ["repository", "issueNumbers", "objective", "operations", "delegatablePolicyIds", "issueAuthority", "budgetAuthority"];

export function parseCampaignLaunchProposal(value: unknown): CampaignLaunchProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as CampaignLaunchProposal;
  if (Object.keys(p).some((key) => !keys.includes(key)) ||
      !Array.isArray(p.issueNumbers) || p.issueNumbers.length < 1 || p.issueNumbers.length > 100 ||
      p.issueNumbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(p.issueNumbers).size !== p.issueNumbers.length ||
      typeof p.repository !== "string" || p.repository !== p.repository.trim() ||
      !p.issueAuthority || p.issueAuthority.maxIssues < p.issueNumbers.length ||
      !Array.isArray(p.issueAuthority.epics) || !p.issueAuthority.epics.every((n) => p.issueNumbers.includes(n)) ||
      !p.budgetAuthority || p.budgetAuthority.costUsd === undefined || p.budgetAuthority.toolCalls === undefined ||
      p.budgetAuthority.concurrency === undefined || p.budgetAuthority.acceptedFollowUps === undefined ||
      p.budgetAuthority.concurrency > 64) return null;
  // Reuse the foundation's exact schema validation. This temporary validation value is never
  // persisted, returned as authority, or used as a principal or a consumable grant.
  if (!validCampaignControl({ mode: "full_control", boundary: {
    version: 1, revision: 1, issueScopeRevision: 1, authorizedByUserId: "schema_validation", authorizedAt: 1,
    repository: p.repository, objective: p.objective, operations: p.operations,
    delegatablePolicyIds: p.delegatablePolicyIds, issueAuthority: p.issueAuthority, budgetAuthority: p.budgetAuthority,
  } })) return null;
  return structuredClone({ ...p, repository: p.repository.toLowerCase(), issueNumbers: [...p.issueNumbers].sort((a, b) => a - b) });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function campaignLaunchDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Readiness comes from implemented production enforcement. This source has no verified Full
 * execution/media contract; inspection, presets and a native-review descriptor cannot replace it. */
export function campaignLaunchPreflight(
  plan: PreparedCampaignLaunch, proposal: CampaignLaunchProposal, runner: RunnerView,
  inspection?: CampaignLaunchInspectionResult,
): CampaignLaunchPreflight {
  const verified = inspection?.ok === true && inspection.workspaceId === plan.workspaceId &&
    inspection.repository === proposal.repository && inspection.digest?.match(/^[a-f0-9]{64}$/) &&
    canonical(inspection.issueNumbers) === canonical(proposal.issueNumbers);
  const capabilities: CampaignLaunchPreflight["capabilities"] = [
    { capability: "Repository and Issue Scope", state: verified ? "verified" : "unsupported", reason: verified
      ? "The registered workspace's origin and exact selected issues were inspected." : "Repository and exact issue inspection is unavailable or differs from the proposal." },
    { capability: "Complete Execution Enforcement", state: "unsupported", reason: "No trusted current complete Full profile proves built-in tools, resource use, filesystem and API enforcement." },
    { capability: "Native Review and Usage", state: "unsupported", reason: "A reported native-review descriptor is not actual admission, delivery or complete managed usage proof." },
    { capability: "Evidence Delivery and Quality", state: "unsupported", reason: "Complete destination/provider authority, media delivery and quality proof are not integrated." },
  ];
  const humanRequired = ["Secrets and sign-in", "Persistent permission grants", "Governance, budgets and tool guardrails",
    "Unsupported execution and native workers", "Unsupported or externally stored evidence"];
  const view = { plan, proposal, ...(verified ? { inspection: {
    repository: inspection!.repository, issueNumbers: inspection!.issueNumbers, digest: inspection!.digest,
  } } : {}), capabilities, humanRequired };
  return { ...view, supported: false, digest: campaignLaunchDigest({ ...view,
    runnerGeneration: runner.connectedAt, runtime: runner.runtime, protocolVersion: runner.protocolVersion }) };
}
