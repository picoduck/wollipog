import type {
  AgentDefinition,
  ProviderAccountDefinition,
  RunnerProviderAccountDefault,
  SubscriptionUsageBucket,
  SubscriptionUsageSnapshot,
} from "./index.js";

/**
 * Which account a new session uses when nobody chose one (#4353). The control plane resolves this at
 * dispatch, the runner rechecks a policy-chosen account at launch, and the browser previews it, all
 * through this one module so they cannot disagree.
 *
 * Selection never crosses providers: callers pass only one provider's accounts. It stores and returns
 * account references and reason codes only, never credentials. Account labels are personal data and
 * account ids are derived from them (`accountSlug`), so nothing logged or persisted beside a session
 * names an account; only `candidates`, returned to a caller who can already read the Machine's
 * inventory, carries ids.
 */

export const PROVIDER_ACCOUNT_POLICY_SCHEMA_VERSION = 1;

/** The modes this release can enforce and write. */
export type ProviderAccountPolicyMode = "fixed" | "priority";
/** A stored mode this release cannot enforce (written by a newer control plane) reads as
 * `unsupported`, which fails closed: launches need an explicit account until it is replaced. */
export type ProviderAccountStoredPolicyMode = ProviderAccountPolicyMode | "unsupported";

export const MAX_PROVIDER_ACCOUNT_PRIORITY_ENTRIES = 32;

/** Why a policy passed over an account. Stable wire values; see `PROVIDER_ACCOUNT_SKIP_TEXT`. */
export type ProviderAccountSkipReason =
  | "not_ranked"
  | "missing"
  | "access_not_granted"
  | "access_pending"
  | "access_refused"
  | "signed_out"
  | "sign_in_unknown"
  | "context_incompatible"
  | "api_billing"
  | "billing_unknown"
  | "cooldown"
  | "usage_exhausted"
  | "spend_limit_reached";

/** Sentence fragments, free of account names, for "Skipped: …" and refusal sentences. */
export const PROVIDER_ACCOUNT_SKIP_TEXT: Readonly<Record<ProviderAccountSkipReason, string>> = {
  not_ranked: "isn't in the Priority Order",
  missing: "is no longer on this machine",
  access_not_granted: "isn't available to this server",
  access_pending: "has server access still being confirmed",
  access_refused: "had its server access revoked",
  signed_out: "needs sign-in",
  sign_in_unknown: "has a sign-in that couldn't be confirmed",
  context_incompatible: "can't run in this agent's environment",
  api_billing: "would spend API credits",
  billing_unknown: "has billing that couldn't be verified",
  cooldown: "recently hit a usage limit",
  usage_exhausted: "is at a usage limit",
  spend_limit_reached: "reached a spend limit",
};

/** A `provider` wins neither here nor anywhere else in this module: it is a parameter of the caller's
 * account list. Non-subscription billing never qualifies for automatic selection. */
export type ProviderAccountBilling = "subscription" | "api" | "unknown";

export type ProviderAccountSelectionSource =
  /** The caller named this account for this session. */
  | "explicit"
  /** The Machine's saved Default Account. */
  | "fixed_default"
  /** The first eligible account in the Machine's Priority Order. */
  | "priority"
  /** No Machine policy: the agent's configured account (legacy fallback). */
  | "agent_default"
  /** No Machine policy or agent account: the first account this server may use (legacy fallback). */
  | "first_available"
  /** No account was bound, as for an agent without provider accounts. */
  | "none";

/** Why this launch used its account, as stored on the session and sent to the runner. Reason codes
 * and counts only: it names no account, so a session's viewers learn nothing about the Machine's
 * other accounts. `revision` 0 means no policy row existed. */
export interface ProviderAccountSelectionRecord {
  schemaVersion: number;
  source: ProviderAccountSelectionSource;
  mode: ProviderAccountStoredPolicyMode;
  policyRevision: number;
  /** How many ranked accounts were passed over, by reason. */
  skipped?: Partial<Record<ProviderAccountSkipReason, number>>;
  /** The runner rechecks eligibility before a new binding. Set only for a policy that chose among
   * accounts: a named account or default was chosen by a person and keeps its recovery path. */
  revalidateAtLaunch?: boolean;
}

export interface ProviderAccountSelectionCandidate {
  accountId: string;
  /** 1-based rank in the Priority Order; null for an account that isn't ranked. */
  position: number | null;
  eligible: boolean;
  /** Set when this is the account the policy picks. */
  selected?: boolean;
  reason?: ProviderAccountSkipReason;
  /** When a time-limited reason should clear, in epoch milliseconds, if known. */
  retryAt?: number;
  /** The provider's name for the usage window or spend control that is used up. */
  limitLabel?: string;
}

/** Why the policy could not pick an account by itself. */
export type ProviderAccountSelectionRefusal =
  | "default_missing"
  | "default_unavailable"
  | "no_eligible_account"
  | "empty_order"
  | "unsupported_mode"
  | "account_memory"
  | "runner_update_required";

export interface ProviderAccountSelectionResult {
  provider: ProviderAccountDefinition["provider"];
  mode: ProviderAccountStoredPolicyMode;
  policyRevision: number;
  /** `selected`: `accountId` is usable. `none`: nothing to bind (no accounts, or a legacy path).
   * `choice_required`: launches without an explicit account must not start. */
  status: "selected" | "none" | "choice_required";
  source: ProviderAccountSelectionSource;
  /** Set for `selected`, and for a saved default that needs replacing, so it can stay visible. */
  accountId?: string;
  refusal?: ProviderAccountSelectionRefusal;
  candidates: ProviderAccountSelectionCandidate[];
}

export type ProviderAccountPolicyEnforcement = "enforced" | "machine_offline" | "runner_update_required";

/** `GET /api/runners/:id/provider-account-selection`: what a launch without a chosen account would
 * do now, resolved by the same code as the launch itself. A preview promises nothing: every launch
 * resolves again. */
export interface ProviderAccountSelectionPreview extends ProviderAccountSelectionResult {
  /** Whether the Machine can honor the saved mode right now. */
  enforcement: ProviderAccountPolicyEnforcement;
  generatedAt: number;
}

export type ProviderAccountChoiceAction = "choose_account" | "sign_in" | "wait" | "review_provider_accounts" | "update_runner";

/** The structured refusal a launch receives under `code: PROVIDER_ACCOUNT_CHOICE_REQUIRED`. An
 * unattended caller can read what to do; an interactive one can offer the same account choice. */
export interface ProviderAccountChoiceRequired {
  provider: ProviderAccountDefinition["provider"];
  mode: ProviderAccountStoredPolicyMode;
  policyRevision: number;
  refusal: ProviderAccountSelectionRefusal;
  candidates: ProviderAccountSelectionCandidate[];
  actions: ProviderAccountChoiceAction[];
  /** The earliest time a time-limited skip should clear, when one is known. */
  retryAt?: number;
}

export const PROVIDER_ACCOUNT_CHOICE_REQUIRED = "PROVIDER_ACCOUNT_CHOICE_REQUIRED";
export const PROVIDER_ACCOUNT_POLICY_NOT_FIXED = "PROVIDER_ACCOUNT_POLICY_NOT_FIXED";

/** A window counts as used up from its latest reading only until its reset time passes, as the
 * runner's automatic switch counts it (#2304); a window with no reset time stays used up until a
 * newer reading says otherwise. */
export function subscriptionUsageBucketExhausted(bucket: SubscriptionUsageBucket, now: number): boolean {
  if (bucket.resetsAt !== undefined && bucket.resetsAt <= now) return false;
  return bucket.status === "exhausted" || bucket.remainingPercent === 0 ||
    (bucket.usedPercent !== undefined && bucket.usedPercent >= 100);
}

/** The used-up window that keeps an account unavailable longest: one with no reset time, else the
 * one that resets last. */
export function longestExhaustedUsageBucket<T extends Pick<SubscriptionUsageBucket, "resetsAt">>(exhausted: readonly T[]): T | undefined {
  return exhausted.reduce<T | undefined>((longest, bucket) =>
    !longest || (longest.resetsAt !== undefined &&
      (bucket.resetsAt === undefined || bucket.resetsAt > longest.resetsAt)) ? bucket : longest, undefined);
}

type ReadinessAgent = Pick<AgentDefinition, "providerAccountReadiness">;
type BillingAgent = Pick<AgentDefinition, "codexBillingSource" | "claudeCode">;

const NON_SUBSCRIPTION_CLAUDE_BILLING: ReadonlySet<string> = new Set(["api", "bedrock", "vertex", "gateway"]);

/** An agent configured with its own key or cloud route bills that route whichever account is bound.
 * A console sign-in is different: discovery reads it from one account's HOME, and it says nothing
 * about the others, each of which reports its own `billing`. */
export function agentUsesNonSubscriptionBilling(agent: BillingAgent | undefined): boolean {
  if (!agent) return false;
  const auth = agent.claudeCode?.auth;
  return agent.codexBillingSource === "api" ||
    (NON_SUBSCRIPTION_CLAUDE_BILLING.has(auth?.billingSource ?? "unknown") && auth?.method !== "console");
}

export interface ProviderAccountEligibilityInput {
  agent?: ReadinessAgent & BillingAgent;
  usage?: SubscriptionUsageSnapshot;
  /** The control plane's own grant ledger refuses this account (#3239). */
  accessRefused?: boolean;
  /** Only what is known counts: an unconfirmed sign-in or billing state doesn't disqualify, and later
   * rules still run. */
  positiveEvidenceOnly?: boolean;
  now: number;
}

/** Why automatic selection must pass over this account, or null when it may use it. The first
 * applicable reason wins, in the order a person would have to fix them. Usage that is missing or old
 * does not disqualify an account: only a reading that says "used up" does. */
export function providerAccountIneligibility(
  account: ProviderAccountDefinition,
  input: ProviderAccountEligibilityInput,
): { reason: ProviderAccountSkipReason; retryAt?: number; limitLabel?: string } | null {
  const { agent, usage, now } = input;
  if (account.profile?.access === "not_granted") return { reason: "access_not_granted" };
  if (account.profile?.access === "pending") return { reason: "access_pending" };
  if (input.accessRefused) return { reason: "access_refused" };
  if (account.authStatus === "unauthenticated") return { reason: "signed_out" };
  const readiness = agent?.providerAccountReadiness;
  if (readiness) {
    if (!Array.isArray(readiness.readyAccountIds) || !readiness.readyAccountIds.includes(account.id)) {
      return { reason: account.authStatus === "authenticated" ? "context_incompatible" : "sign_in_unknown" };
    }
  }
  if (agentUsesNonSubscriptionBilling(agent) || account.billing === "api" || usage?.state === "not_applicable") {
    return { reason: "api_billing" };
  }
  if (!input.positiveEvidenceOnly) {
    if (account.authStatus !== "authenticated") return { reason: "sign_in_unknown" };
    if (account.billing !== "subscription" && usage?.state !== "available") return { reason: "billing_unknown" };
  }
  if (account.selectionCooldownUntil !== undefined && account.selectionCooldownUntil > now) {
    return { reason: "cooldown", retryAt: account.selectionCooldownUntil };
  }
  const exhausted = (usage?.buckets ?? []).filter((bucket) => subscriptionUsageBucketExhausted(bucket, now));
  if (exhausted.length) {
    const limiting = longestExhaustedUsageBucket(exhausted);
    return { reason: "usage_exhausted", ...(limiting?.resetsAt !== undefined ? { retryAt: limiting.resetsAt } : {}),
      ...(limiting?.label ? { limitLabel: limiting.label } : {}) };
  }
  const reached = (usage?.spendControls ?? []).filter((control) =>
    control.reached === true && (control.resetsAt === undefined || control.resetsAt > now));
  if (reached.length) {
    // The control that keeps the account unavailable longest, so its name and reset describe one limit.
    const limiting = longestExhaustedUsageBucket(reached);
    return { reason: "spend_limit_reached", ...(limiting?.resetsAt !== undefined ? { retryAt: limiting.resetsAt } : {}),
      ...(limiting?.label ? { limitLabel: limiting.label } : {}) };
  }
  return null;
}

/** The runner's launch recheck: only positive evidence refuses. An unknown sign-in or billing state
 * passed the control plane's fuller check seconds ago and the runner holds no better answer. */
export function providerAccountLaunchIneligibility(
  account: ProviderAccountDefinition | undefined,
  input: Omit<ProviderAccountEligibilityInput, "agent" | "accessRefused" | "positiveEvidenceOnly">,
): ProviderAccountSkipReason | null {
  if (!account) return "missing";
  return providerAccountIneligibility(account, { ...input, positiveEvidenceOnly: true })?.reason ?? null;
}

export interface ProviderAccountSelectionInput {
  provider: ProviderAccountDefinition["provider"];
  policy: RunnerProviderAccountDefault | null | undefined;
  /** This provider's accounts on the Machine. */
  accounts: readonly ProviderAccountDefinition[];
  agent: (ReadinessAgent & BillingAgent & Pick<AgentDefinition, "defaultProviderAccountId">) | undefined;
  /** A saved policy applies to native execution; WSL keeps its context-local configured account. */
  native: boolean;
  usage: readonly SubscriptionUsageSnapshot[];
  /** Whether the control plane's grant ledger refuses this account. */
  accessRefused?: (account: ProviderAccountDefinition) => boolean;
  /** Provider memory lives in the account's HOME for this launch, so automatic selection between
   * launches would silently change what the session remembers. */
  accountSpecificMemory?: boolean;
  /** The runner can recheck a policy choice at launch. */
  policySupported: boolean;
  now: number;
}

function usageFor(usage: readonly SubscriptionUsageSnapshot[], accountId: string): SubscriptionUsageSnapshot | undefined {
  return usage.find((snapshot) => snapshot.providerAccountId === accountId);
}

/** The policy's stored mode, where a record from before versioned policies is a fixed default. */
export function providerAccountPolicyMode(policy: Pick<RunnerProviderAccountDefault, "mode"> | null | undefined): ProviderAccountStoredPolicyMode {
  return policy?.mode ?? "fixed";
}

/** The account a fixed default names. A record from before versioned policies has only `accountId`. */
export function providerAccountPolicyFixedId(policy: Pick<RunnerProviderAccountDefault, "accountId" | "fixedAccountId"> | null | undefined): string | null {
  return policy?.fixedAccountId !== undefined ? policy.fixedAccountId : policy?.accountId ?? null;
}

/** Picks one of the eligible candidates, which arrive in rank order. A mode is defined by this step:
 * eligibility above is common to every mode and always runs first. */
function chooseEligibleCandidate(
  mode: ProviderAccountPolicyMode,
  eligible: readonly ProviderAccountSelectionCandidate[],
): ProviderAccountSelectionCandidate | undefined {
  switch (mode) {
    case "priority":
    case "fixed":
      return eligible[0];
  }
}

function resolvePriority(input: ProviderAccountSelectionInput, revision: number): ProviderAccountSelectionResult {
  const { provider, policy, accounts } = input;
  const order = policy?.priorityAccountIds ?? [];
  const candidates: ProviderAccountSelectionCandidate[] = order.map((accountId, index) => {
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account) return { accountId, position: index + 1, eligible: false, reason: "missing" as const };
    const refused = providerAccountIneligibility(account, {
      ...(input.agent ? { agent: input.agent } : {}),
      ...(usageFor(input.usage, accountId) ? { usage: usageFor(input.usage, accountId)! } : {}),
      accessRefused: input.accessRefused?.(account) ?? false,
      now: input.now,
    });
    return refused
      ? { accountId, position: index + 1, eligible: false, ...refused }
      : { accountId, position: index + 1, eligible: true };
  });
  for (const account of accounts) {
    if (!order.includes(account.id)) {
      candidates.push({ accountId: account.id, position: null, eligible: false, reason: "not_ranked" });
    }
  }
  const base = { provider, mode: "priority" as const, policyRevision: revision };
  const refuse = (refusal: ProviderAccountSelectionRefusal): ProviderAccountSelectionResult =>
    ({ ...base, status: "choice_required", source: "none", refusal, candidates });
  if (!input.policySupported) return refuse("runner_update_required");
  if (input.accountSpecificMemory) return refuse("account_memory");
  if (order.length === 0) return refuse("empty_order");
  const chosen = chooseEligibleCandidate("priority", candidates.filter((candidate) => candidate.eligible));
  if (!chosen) return refuse("no_eligible_account");
  chosen.selected = true;
  return { ...base, status: "selected", source: "priority", accountId: chosen.accountId, candidates };
}

function resolveFixed(input: ProviderAccountSelectionInput, revision: number): ProviderAccountSelectionResult {
  const { provider, policy, accounts, agent } = input;
  const saved = input.native ? providerAccountPolicyFixedId(policy) : null;
  const base = { provider, mode: "fixed" as const, policyRevision: revision };
  if (saved) {
    const account = accounts.find((candidate) => candidate.id === saved);
    const candidate = (reason?: ProviderAccountSkipReason): ProviderAccountSelectionCandidate => ({
      accountId: saved, position: null, eligible: !reason, ...(reason ? { reason } : { selected: true }),
    });
    if (!account) {
      return { ...base, status: "choice_required", source: "fixed_default", accountId: saved,
        refusal: "default_missing", candidates: [candidate("missing")] };
    }
    // A default was chosen by a person: only what would stop the launch makes it need replacing. Its
    // usage and billing stay that person's call, and sign-in stays recoverable at the session.
    const unavailable: ProviderAccountSkipReason | undefined = account.profile?.access === "not_granted" ? "access_not_granted"
      : input.accessRefused?.(account) ? "access_refused"
      : agent?.providerAccountReadiness && !agent.providerAccountReadiness.readyAccountIds?.includes(saved)
        ? account.authStatus === "unauthenticated" ? "signed_out"
          : account.authStatus === "authenticated" ? "context_incompatible" : "sign_in_unknown"
      : undefined;
    return unavailable
      ? { ...base, status: "choice_required", source: "fixed_default", accountId: saved,
          refusal: "default_unavailable", candidates: [candidate(unavailable)] }
      : { ...base, status: "selected", source: "fixed_default", accountId: saved, candidates: [candidate()] };
  }
  if (agent?.defaultProviderAccountId) {
    return { ...base, status: "selected", source: "agent_default", accountId: agent.defaultProviderAccountId, candidates: [] };
  }
  // The implicit choice skips a profile this control plane may not use (#3240). WSL never inherits
  // an account implicitly: a POSIX path does not identify its owning distribution.
  const implicit = input.native ? accounts.find((account) => account.profile?.access !== "not_granted") : undefined;
  return implicit
    ? { ...base, status: "selected", source: "first_available", accountId: implicit.id, candidates: [] }
    : { ...base, status: "none", source: "none", candidates: [] };
}

/** What a launch without an explicit account uses. Pure and deterministic for one input. */
export function resolveProviderAccountSelection(input: ProviderAccountSelectionInput): ProviderAccountSelectionResult {
  const revision = input.policy?.revision ?? 0;
  const mode = input.native ? providerAccountPolicyMode(input.policy) : "fixed";
  if (mode === "priority") return resolvePriority(input, revision);
  if (mode === "unsupported") {
    return { provider: input.provider, mode, policyRevision: revision, status: "choice_required",
      source: "none", refusal: "unsupported_mode", candidates: [] };
  }
  return resolveFixed(input, revision);
}

/** What the launch stores: the reason, never which accounts were passed over. */
export function providerAccountSelectionRecord(
  result: Pick<ProviderAccountSelectionResult, "source" | "mode" | "policyRevision" | "candidates">,
): ProviderAccountSelectionRecord {
  const skipped: Partial<Record<ProviderAccountSkipReason, number>> = {};
  // Only accounts ranked ahead of the choice were skipped. Those after it were never needed, and an
  // unranked account was never in contention.
  for (const candidate of result.candidates) {
    if (candidate.selected) break;
    if (candidate.reason && candidate.position !== null) skipped[candidate.reason] = (skipped[candidate.reason] ?? 0) + 1;
  }
  return {
    schemaVersion: PROVIDER_ACCOUNT_POLICY_SCHEMA_VERSION,
    source: result.source,
    mode: result.mode,
    policyRevision: result.policyRevision,
    ...(Object.keys(skipped).length ? { skipped } : {}),
    ...(result.source === "priority" ? { revalidateAtLaunch: true } : {}),
  };
}

/** The record of an account the caller named, which overrides the Machine's policy. */
export function providerAccountExplicitRecord(policy: RunnerProviderAccountDefault | null | undefined): ProviderAccountSelectionRecord {
  return {
    schemaVersion: PROVIDER_ACCOUNT_POLICY_SCHEMA_VERSION,
    source: "explicit",
    mode: providerAccountPolicyMode(policy),
    policyRevision: policy?.revision ?? 0,
  };
}

function joinFragments(fragments: readonly string[]): string {
  if (fragments.length <= 1) return fragments[0] ?? "";
  return `${fragments.slice(0, -1).join(", ")} and ${fragments[fragments.length - 1]}`;
}

/** The reasons accounts were passed over, as one clause naming no account. */
export function providerAccountSkipSummary(skipped: Partial<Record<ProviderAccountSkipReason, number>> | undefined): string {
  const entries = Object.entries(skipped ?? {}) as Array<[ProviderAccountSkipReason, number]>;
  return joinFragments(entries.map(([reason, count]) =>
    count === 1 ? `one ${PROVIDER_ACCOUNT_SKIP_TEXT[reason]}` : `${count} accounts ${PROVIDER_ACCOUNT_SKIP_TEXT[reason].replace(/^isn't /u, "aren't ").replace(/^is /u, "are ").replace(/^has /u, "have ").replace(/^needs /u, "need ")}`));
}

/** Why this account, in plain language. Safe for any viewer of the session: it names no account. */
export function providerAccountSelectionSentence(record: Pick<ProviderAccountSelectionRecord, "source" | "skipped">): string {
  switch (record.source) {
    case "explicit": return "This account was chosen for this session.";
    case "fixed_default": return "This is the machine's Default Account.";
    case "priority": {
      const skipped = providerAccountSkipSummary(record.skipped);
      return skipped
        ? `This is the first eligible account in the machine's Priority Order. Skipped ahead of it: ${skipped}.`
        : "This is the first account in the machine's Priority Order.";
    }
    case "agent_default": return "This is the agent's configured account, because the machine has no Default Account.";
    case "first_available": return "This is the first available account, because neither the machine nor the agent names one.";
    case "none": return "No provider account applies to this launch.";
  }
}

const PROVIDER_LABEL = { claude: "Claude", codex: "Codex" } as const;

/** The refusal sentence for a launch or an API caller. Names no account. */
export function providerAccountChoiceRequiredSentence(
  provider: ProviderAccountDefinition["provider"],
  refusal: ProviderAccountSelectionRefusal,
  candidates: readonly ProviderAccountSelectionCandidate[] = [],
): string {
  const name = PROVIDER_LABEL[provider];
  const skipped: Partial<Record<ProviderAccountSkipReason, number>> = {};
  for (const candidate of candidates) {
    if (candidate.reason && candidate.position !== null) skipped[candidate.reason] = (skipped[candidate.reason] ?? 0) + 1;
  }
  const summary = providerAccountSkipSummary(skipped);
  switch (refusal) {
    case "no_eligible_account":
      return `No ${name} account in this machine's Priority Order can start this session${summary ? ` (${summary})` : ""}. ` +
        "Choose an account for this session, or review this machine's Provider Accounts.";
    case "empty_order":
      return `This machine's ${name} Priority Order has no accounts. Choose an account for this session, or add one in this machine's Provider Accounts.`;
    case "unsupported_mode":
      return `This machine's ${name} account policy was saved by a newer server, so this server can't apply it. Choose an account for this session, or replace the policy in this machine's Provider Accounts.`;
    case "account_memory":
      return `This project's memory is stored with each ${name} account on this runner, so Priority Order won't move it between accounts. Choose an account for this session, or update ${name} on this machine.`;
    case "runner_update_required":
      return `This machine's runner can't enforce the ${name} Priority Order. Choose an account for this session, or update the runner.`;
    case "default_missing":
      return "The saved default provider account is unavailable on this Machine. Choose another account or change the default in this Machine's Provider Accounts.";
    case "default_unavailable":
      return "The default provider account is not ready. Choose a ready account or review its sign-in and ownership details.";
  }
}

const SIGN_IN_REASONS: ReadonlySet<ProviderAccountSkipReason> = new Set(["signed_out", "sign_in_unknown"]);

/** The structured form of a refusal: what an unattended caller can do next. */
export function providerAccountChoiceRequired(result: ProviderAccountSelectionResult): ProviderAccountChoiceRequired {
  const refusal = result.refusal ?? "no_eligible_account";
  const ranked = result.candidates.filter((candidate) => candidate.position !== null || result.mode !== "priority");
  const retryTimes = ranked.flatMap((candidate) => candidate.retryAt !== undefined ? [candidate.retryAt] : []);
  const actions: ProviderAccountChoiceAction[] = ["choose_account"];
  if (refusal === "runner_update_required" || refusal === "account_memory") actions.push("update_runner");
  if (ranked.some((candidate) => candidate.reason && SIGN_IN_REASONS.has(candidate.reason))) actions.push("sign_in");
  if (retryTimes.length) actions.push("wait");
  actions.push("review_provider_accounts");
  return {
    provider: result.provider,
    mode: result.mode,
    policyRevision: result.policyRevision,
    refusal,
    candidates: result.candidates,
    actions,
    ...(retryTimes.length ? { retryAt: Math.min(...retryTimes) } : {}),
  };
}

export type ProviderAccountPolicyWriteResult =
  | { ok: true; mode: ProviderAccountPolicyMode; fixedAccountId: string | null; priorityAccountIds: string[]; expectedRevision: number }
  | { ok: false; error: string };

const PROVIDER_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Shape-check a policy write. Whether its accounts exist is the route's question: it needs the
 * Machine's inventory and the record being replaced. */
export function parseProviderAccountPolicyWrite(
  body: unknown,
  current: RunnerProviderAccountDefault | null | undefined,
): ProviderAccountPolicyWriteResult {
  const value = (body ?? {}) as { mode?: unknown; fixedAccountId?: unknown; priorityAccountIds?: unknown; expectedRevision?: unknown };
  if (value.mode !== "fixed" && value.mode !== "priority") {
    return { ok: false, error: "mode must be Default Account (fixed) or Priority Order (priority)" };
  }
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    return { ok: false, error: "expectedRevision must be a non-negative integer" };
  }
  const fixedAccountId = value.fixedAccountId === undefined ? providerAccountPolicyFixedId(current) : value.fixedAccountId;
  if (fixedAccountId !== null && (typeof fixedAccountId !== "string" || !PROVIDER_ACCOUNT_ID.test(fixedAccountId))) {
    return { ok: false, error: "fixedAccountId must be an account id or null" };
  }
  const priorityAccountIds = value.priorityAccountIds === undefined ? current?.priorityAccountIds ?? [] : value.priorityAccountIds;
  if (!Array.isArray(priorityAccountIds) || priorityAccountIds.length > MAX_PROVIDER_ACCOUNT_PRIORITY_ENTRIES ||
      priorityAccountIds.some((id) => typeof id !== "string" || !PROVIDER_ACCOUNT_ID.test(id)) ||
      new Set(priorityAccountIds).size !== priorityAccountIds.length) {
    return { ok: false, error: "priorityAccountIds must be distinct account ids" };
  }
  if (value.mode === "priority" && priorityAccountIds.length === 0) {
    return { ok: false, error: "Priority Order needs at least one account" };
  }
  return { ok: true, mode: value.mode, fixedAccountId, priorityAccountIds: priorityAccountIds as string[],
    expectedRevision: value.expectedRevision as number };
}
