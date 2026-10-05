import type {
  GovernancePolicy,
  GovernancePolicyConditions,
  GovernancePolicyEffect,
  GovernancePolicyScope,
  GovernanceQuestionRule,
} from "@wollipog/protocol";
import { formatCost } from "./format.js";

/**
 * How Settings › Approvals reads a governance policy (#2158): the order the control plane weighs
 * tool policies in, and their scope, conditions and ask timeout in words. Pure, so the vocabulary
 * is tested without a DOM.
 */

export const POLICY_EFFECT_LABELS: Record<GovernancePolicyEffect, string> = { allow: "Allow", ask: "Ask", deny: "Deny" };

/** At equal priority the control plane fails closed: deny, then ask, then allow. */
const EFFECT_ORDER: Record<GovernancePolicyEffect, number> = { deny: 3, ask: 2, allow: 1 };

/**
 * The policies that decide tool calls — every policy without a question rule — in the order the
 * control plane evaluates them (`evaluateApprovalPolicies`): highest priority first, then deny
 * before ask before allow, then by id. The first one that matches a call decides it.
 */
export function toolPolicies(policies: readonly GovernancePolicy[]): GovernancePolicy[] {
  return policies
    .filter((policy) => !policy.questionRule)
    .sort((a, b) => b.priority - a.priority || EFFECT_ORDER[b.effect] - EFFECT_ORDER[a.effect] || a.policyId.localeCompare(b.policyId));
}

/** Where a policy applies, as one phrase: "every machine", "one machine, one organization, branch main". */
export function policyScopePhrase(scope: GovernancePolicyScope): string {
  const parts = [scope.runnerId ? "one machine" : "every machine"];
  // The control plane enforces it like every other selector, so it is never left unsaid.
  if (scope.organizationId) parts.push("one organization");
  if (scope.workspaceId) parts.push("one workspace");
  if (scope.agentId) parts.push(`agent ${scope.agentId}`);
  if (scope.path) parts.push(`path ${scope.path}`);
  if (scope.branch) parts.push(`branch ${scope.branch}`);
  if (scope.network) parts.push(`network ${scope.network}`);
  return parts.join(", ");
}

/** Each stateful condition as a phrase, in sentence case: "cost at least $5.00", "escalated". */
export function policyConditionPhrases(conditions: GovernancePolicyConditions | undefined): string[] {
  if (!conditions) return [];
  const phrases: string[] = [];
  if (conditions.statuses?.length) {
    phrases.push(`status ${conditions.statuses.map((status) => status.replace(/_/g, " ")).join(" or ")}`);
  }
  if (conditions.minCostUsd !== undefined) phrases.push(`cost at least ${costPhrase(conditions.minCostUsd)}`);
  if (conditions.maxCostUsd !== undefined) phrases.push(`cost at most ${costPhrase(conditions.maxCostUsd)}`);
  if (conditions.minToolCalls !== undefined) phrases.push(`at least ${countPhrase(conditions.minToolCalls)}`);
  if (conditions.maxToolCalls !== undefined) phrases.push(`at most ${countPhrase(conditions.maxToolCalls)}`);
  if (conditions.escalated !== undefined) phrases.push(conditions.escalated ? "escalated" : "not escalated");
  return phrases;
}

function costPhrase(usd: number): string {
  return formatCost(usd) || "$0.00";
}

function countPhrase(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "tool call" : "tool calls"}`;
}

/** An ask timeout in seconds, as "45 s", "10 min" or "1 h 30 min". */
export function formatAskTimeout(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const rest = whole % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** One label-prefixed meta item (§5.2, §11.3): "Scope: every machine". */
export interface PolicyMetaItem {
  label: string;
  value: string;
}

/** A tool policy's row meta, in reading order. Built In is the row's own flag, not a meta item. */
export function toolPolicyMeta(policy: GovernancePolicy): PolicyMetaItem[] {
  const items: PolicyMetaItem[] = [];
  if (!policy.enabled) items.push({ label: "State", value: "off" });
  if (policy.scope.toolName) items.push({ label: "Tool", value: policy.scope.toolName });
  items.push({ label: "Scope", value: policyScopePhrase(policy.scope) });
  const conditions = policyConditionPhrases(policy.conditions);
  if (conditions.length > 0) items.push({ label: "Conditions", value: conditions.join(", ") });
  if (policy.askTimeout !== undefined) items.push({ label: "Timeout", value: formatAskTimeout(policy.askTimeout) });
  return items;
}

/** A custom question policy's rule, as the row's one sentence. */
export function questionRuleDescription(rule: GovernanceQuestionRule): string {
  const answer = "option" in rule.answer ? `Chooses “${rule.answer.option}”` : `Replies “${rule.answer.text}”`;
  const matches = [
    rule.headerPattern ? `the header matches “${rule.headerPattern}”` : null,
    rule.questionPattern ? `the question matches “${rule.questionPattern}”` : null,
  ].filter((part): part is string => part !== null);
  return matches.length === 0 ? `${answer} to every question.` : `${answer} when ${matches.join(" and ")}.`;
}
