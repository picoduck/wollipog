import { normalizeWorkflowDecisionOwnerRule, type CampaignRuleDelegation } from "@wollipog/protocol";

/** Paths only bound what the person can confirm. They never prove authorship themselves. */
export function personalRuleDelegation(value: unknown): CampaignRuleDelegation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !["rule", "categories"].includes(k))) return null;
  const rule = normalizeWorkflowDecisionOwnerRule(v.rule);
  if (!rule.ok || !rule.rule || !["~/.claude/CLAUDE.md", "~/.codex/AGENTS.md"].includes(rule.rule.source)) return null;
  if (/human[ -]required/iu.test(rule.rule.quote)) return null;
  if (!Array.isArray(v.categories) || !v.categories.length || v.categories.length > 4 ||
      new Set(v.categories).size !== v.categories.length || v.categories.some((c) =>
        !["pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval"].includes(c))) return null;
  return { rule: rule.rule, categories: v.categories as CampaignRuleDelegation["categories"] };
}
