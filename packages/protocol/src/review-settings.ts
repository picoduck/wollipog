import type { AgentCapabilities, AgentHarnessIdentity } from "./index.js";
import type { SessionReviewHarness } from "./session-review-job.js";

/** User-owned, cross-device settings. Project documents replace the whole user document. */
export interface ReviewSettings {
  version: 1;
  roundBudget: number;
  reviewers: ReviewReviewerRule[];
}

export interface ReviewReviewerRule {
  implementer: AgentHarnessIdentity;
  harness: SessionReviewHarness;
  model: string | null;
  effort: string | null;
  allowSameFamily: boolean;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { version: 1, roundBudget: 4, reviewers: [] };

export interface ReviewSettingsView {
  settings: ReviewSettings;
  source: "system_default" | "user_default" | "project_override";
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  implementers: Array<AgentHarnessIdentity & { name: string }>;
  reviewers: Array<{ harness: SessionReviewHarness; name: string; runnerId: string; agentId: string; capabilities: AgentCapabilities }>;
}

/** Present only when the runner advertises reviewSession.configuration. No shell configuration. */
export interface ReviewConfiguration {
  model?: string;
  effort: string;
  allowSameFamily: boolean;
  roundBudget: number;
}

export function reviewModelFamily(driver: string | null | undefined, model?: string | null): string | null {
  // Pi persists provider/model, and routed catalogs may nest another provider prefix. Bedrock
  // qualifies its Claude ids with a region and vendor separated by dots.
  const modelId = model?.split("/").at(-1);
  if (modelId && /(?:^|[.:])(claude|opus|fable|sonnet|haiku)(?:[-[\d.]|$)/iu.test(modelId)) return "claude";
  if (modelId && /^(gpt|codex|o[134])(?:[-\d.]|$)/iu.test(modelId)) return "openai";
  const provider = model?.includes("/") ? model.split("/")[0]?.toLowerCase() : undefined;
  if (provider === "anthropic") return "claude";
  if (["openai", "openai-codex", "azure-openai", "azure-openai-responses"].includes(provider ?? "")) return "openai";
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "openai";
  return model ? model.toLowerCase() : null;
}

export function sameReviewFamily(implementerDriver: string | null | undefined, implementerModel: string | null | undefined,
  reviewer: SessionReviewHarness, reviewerModel?: string | null): boolean {
  const family = reviewModelFamily(implementerDriver, implementerModel);
  return family !== null && family === reviewModelFamily(reviewer, reviewerModel);
}

export function reviewModelSupported(capabilities: AgentCapabilities | undefined, model: string | undefined, effort: string): boolean {
  if (!capabilities) return false;
  const concrete = capabilities.models.filter(entry => entry.id !== "default" && !entry.hidden);
  const selected = model ? concrete.find((entry) => entry.id === model)
    : concrete.find((entry) => entry.default) ?? concrete[0];
  if (!selected) return false;
  return (selected?.efforts?.length ? selected.efforts : capabilities.effortLevels).includes(effort);
}
