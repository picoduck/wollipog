import { ASSISTANT_DECISION_DEFAULT_DURATIONS, type AssistantDecisionCategory, type AssistantDecisionDefault, type AssistantDecisionGrant } from "@wollipog/protocol";

export const ASSISTANT_DECISION_GROUPS = [
  { label: "Pull Requests", categories: ["pr_merge", "review_round_extension"] },
  { label: "CI and Releases", categories: ["ci_rerun", "release_tag", "release_publish"] },
  { label: "Issues", categories: ["follow_up_issue_publication", "issue_closure"] },
  { label: "Cleanup", categories: ["merged_branch_deletion"] },
  { label: "Questions", categories: ["owner_question"] },
  { label: "UI Evidence", categories: ["ui_evidence_review", "ui_evidence_approval"] },
] as const satisfies readonly { label: string; categories: readonly AssistantDecisionCategory[] }[];

const hour = 60 * 60_000;
const day = 24 * hour;
const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatAssistantDelegationSummary(grant: AssistantDecisionGrant | null | undefined, now = Date.now()): string {
  if (!grant) return "Ask Me";
  const mode = grant.selectionMode === "all" ? "Delegate All" : "Choose";
  if (grant.expiresAt === null) return `${mode} · Never Expires`;
  const remaining = grant.expiresAt - now;
  if (remaining <= 0) return `${mode} · Expired`;
  if (remaining < 60_000) return `${mode} · Expires in less than a minute`;
  const time = remaining >= day ? relativeTime.format(Math.floor(remaining / day), "day")
    : remaining >= hour ? relativeTime.format(Math.floor(remaining / hour), "hour")
      : relativeTime.format(Math.floor(remaining / 60_000), "minute");
  return `${mode} · Expires ${time}`;
}

export const DELEGATION_EXPIRY_OPTIONS = [
  { value: "hour", label: "1 Hour" },
  { value: "today", label: "Today" },
  { value: "week", label: "7 Days" },
  { value: "month", label: "30 Days" },
  { value: "never", label: "Never" },
  { value: "custom", label: "Custom…" },
] as const;

export type DelegationExpiry = typeof DELEGATION_EXPIRY_OPTIONS[number]["value"];

export function delegationExpiryAt(preset: DelegationExpiry, customTime: string, now: number): number | null {
  switch (preset) {
    case "hour": return now + hour;
    case "today": return new Date(now).setHours(24, 0, 0, 0);
    case "week": return now + 7 * day;
    case "month": return now + 30 * day;
    case "never": return null;
    case "custom": return customTime ? new Date(customTime).getTime() : NaN;
  }
}

export function formatDelegationExpiryHelp(preset: DelegationExpiry, expiresAt: number | null): string {
  if (expiresAt === null) return "Delegation stays active until you revoke it.";
  if (!Number.isFinite(expiresAt)) return "Choose when delegation ends in your device’s local time.";
  if (preset === "today") {
    const end = new Date(expiresAt - 1).toLocaleDateString(undefined, { dateStyle: "medium" });
    return `Delegation ends at midnight at the end of ${end} (local time).`;
  }
  return `Delegation ends on ${localTime.format(expiresAt)} (local time).`;
}

type DefaultExpiry = keyof typeof ASSISTANT_DECISION_DEFAULT_DURATIONS;

export function isDefaultDelegationExpiry(preset: DelegationExpiry): preset is DefaultExpiry {
  return Object.hasOwn(ASSISTANT_DECISION_DEFAULT_DURATIONS, preset);
}

type ExpiryOption = typeof DELEGATION_EXPIRY_OPTIONS[number];
export const DEFAULT_DELEGATION_EXPIRY_OPTIONS = DELEGATION_EXPIRY_OPTIONS.filter(
  (option): option is Extract<ExpiryOption, { value: DefaultExpiry }> => isDefaultDelegationExpiry(option.value),
);

export function defaultDelegationExpiry(duration: AssistantDecisionDefault["expiresAfterMs"]) {
  return DEFAULT_DELEGATION_EXPIRY_OPTIONS.find((option) => ASSISTANT_DECISION_DEFAULT_DURATIONS[option.value] === duration);
}

export function formatAssistantDefaultDelegation(grant: AssistantDecisionDefault | null): string {
  if (!grant) return "Ask Me";
  const mode = grant.selectionMode === "all" ? "Delegate All" : "Choose";
  const expiry = defaultDelegationExpiry(grant.expiresAfterMs);
  return expiry ? `${mode} · ${expiry.label}` : mode;
}
