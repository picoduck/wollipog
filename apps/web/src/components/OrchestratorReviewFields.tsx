import { ORCHESTRATOR_REVIEW_POLICY_KEYS, type OrchestratorBehaviorDefaults, type ReviewSettingsView } from "@wollipog/protocol";
import type { ReactNode } from "react";
import { SelectRow } from "./ui/SettingsRows.js";
import { titleCaseLabel } from "../format.js";

const AUTO = "__automatic__";
const automatic = [{ value: AUTO, label: "Automatic" }];
type ReviewFields = Pick<OrchestratorBehaviorDefaults, typeof ORCHESTRATOR_REVIEW_POLICY_KEYS[number]>;

/** One set of discovered choices for Settings and the per-launch policy editor. */
export function OrchestratorReviewFields({ value, reviewers, problem, onChange, badge }: {
  value: ReviewFields;
  reviewers: ReviewSettingsView["reviewers"];
  problem?: string | null;
  onChange: (patch: ReviewFields) => void;
  badge?: (key: typeof ORCHESTRATOR_REVIEW_POLICY_KEYS[number]) => ReactNode;
}) {
  const candidates = reviewers.filter(r => !value.reviewHarness || r.harness === value.reviewHarness);
  const harnesses = [...new Map(reviewers.map(r => [r.harness, { value: r.harness, label: r.name }])).values()];
  if (value.reviewHarness && !harnesses.some(h => h.value === value.reviewHarness)) {
    harnesses.push({ value: value.reviewHarness, label: `${value.reviewHarness === "codex" ? "Codex" : "Claude Code"} (Unavailable)` });
  }
  const models = new Map(candidates.flatMap(r => r.capabilities.models.filter(m => !m.hidden && m.id !== "default").map(m => [m.id, m])));
  const efforts = [...new Set(candidates.flatMap(r => {
    const model = r.capabilities.models.find(m => m.id === value.reviewModel);
    return model?.efforts?.length ? model.efforts : r.capabilities.effortLevels;
  }))];
  return <>
    <SelectRow title="Review Harness" value={value.reviewHarness ?? AUTO} options={[...automatic, ...harnesses]} badge={badge?.("reviewHarness")}
      description="Automatic follows Reviews settings for each child's harness and project at launch." error={problem}
      onChange={harness => onChange({ reviewHarness: harness === AUTO ? null : harness as "codex" | "claude-code", reviewModel: null, reviewEffort: null })} />
    <SelectRow title="Review Model" value={value.reviewModel ?? AUTO} badge={badge?.("reviewModel")}
      options={[...automatic, ...[...models.values()].map(m => ({ value: m.id, label: m.displayName ?? m.id })),
        ...(value.reviewModel && !models.has(value.reviewModel) ? [{ value: value.reviewModel, label: `${value.reviewModel} (Unavailable)` }] : [])]}
      description="Automatic inherits the selected reviewer's saved model, then its discovered default. A missing fixed model refuses the review."
      onChange={model => onChange({ reviewModel: model === AUTO ? null : model, reviewEffort: null })} />
    <SelectRow title="Review Effort" value={value.reviewEffort ?? AUTO} badge={badge?.("reviewEffort")}
      options={[...automatic, ...efforts.map(e => ({ value: e, label: titleCaseLabel(e) })),
        ...(value.reviewEffort && !efforts.includes(value.reviewEffort) ? [{ value: value.reviewEffort, label: `${titleCaseLabel(value.reviewEffort)} (Unavailable)` }] : [])]}
      description="Automatic inherits the selected reviewer's saved effort, then high effort. Same-family reviews still require explicit consent in Reviews settings."
      onChange={effort => onChange({ reviewEffort: effort === AUTO ? null : effort })} />
    <SelectRow title="Review Round Budget" value={value.reviewRoundBudget == null ? AUTO : String(value.reviewRoundBudget)} badge={badge?.("reviewRoundBudget")}
      options={[...automatic, ...Array.from({ length: 32 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]}
      description="Automatic inherits the project's or user's budget, defaulting to four valid rounds. Children keep their launch snapshot."
      onChange={budget => onChange({ reviewRoundBudget: budget === AUTO ? null : Number(budget) })} />
  </>;
}
