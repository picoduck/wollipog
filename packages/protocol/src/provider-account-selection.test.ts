import assert from "node:assert/strict";
import test from "node:test";
import {
  agentAvailableForRunnerDefault,
  parseProviderAccountPolicyWrite,
  providerAccountChoiceRequired,
  providerAccountChoiceRequiredSentence,
  providerAccountIneligibility,
  providerAccountLaunchIneligibility,
  providerAccountSelectionRecord,
  providerAccountSelectionSentence,
  resolveProviderAccountSelection,
  type AgentDefinition,
  type ProviderAccountDefinition,
  type ProviderAccountSelectionInput,
  type RunnerProviderAccountDefault,
  type SubscriptionUsageSnapshot,
} from "./index.js";

const NOW = 1_800_000_000_000;

function account(id: string, overrides: Partial<ProviderAccountDefinition> = {}): ProviderAccountDefinition {
  return { id, label: `${id}@example.com`, provider: "claude", authStatus: "authenticated", billing: "subscription", ...overrides };
}

function usage(id: string, overrides: Partial<SubscriptionUsageSnapshot> = {}): SubscriptionUsageSnapshot {
  return { sourceId: `source-${id}`, runnerId: "runner", agentId: "claude", provider: "claude", state: "available",
    fetchedAt: NOW, buckets: [], providerAccountId: id, ...overrides };
}

const priority = (...ids: string[]): RunnerProviderAccountDefault =>
  ({ provider: "claude", accountId: null, revision: 3, mode: "priority", schemaVersion: 1, fixedAccountId: null, priorityAccountIds: ids });

function resolve(overrides: Partial<ProviderAccountSelectionInput> = {}) {
  return resolveProviderAccountSelection({
    provider: "claude", policy: null, accounts: [], agent: undefined, native: true, usage: [], policySupported: true, now: NOW, ...overrides,
  });
}

test("Priority Order selects the first eligible account and reports each one it passed over", () => {
  const result = resolve({
    policy: priority("signed-out", "at-limit", "ready", "also-ready"),
    accounts: [
      account("ready"), account("also-ready"),
      account("signed-out", { authStatus: "unauthenticated" }),
      account("at-limit"), account("unranked"),
    ],
    usage: [usage("at-limit", { buckets: [{ id: "5h", label: "5 hours", status: "exhausted", resetsAt: NOW + 60_000 }] })],
  });
  assert.equal(result.status, "selected");
  assert.equal(result.source, "priority");
  assert.equal(result.accountId, "ready");
  assert.deepEqual(result.candidates, [
    { accountId: "signed-out", position: 1, eligible: false, reason: "signed_out" },
    { accountId: "at-limit", position: 2, eligible: false, reason: "usage_exhausted", retryAt: NOW + 60_000 },
    { accountId: "ready", position: 3, eligible: true, selected: true },
    { accountId: "also-ready", position: 4, eligible: true },
    { accountId: "unranked", position: null, eligible: false, reason: "not_ranked" },
  ]);
});

test("every eligibility rule passes over an account for its own reason", () => {
  const expectReason = (candidate: ProviderAccountDefinition, reason: string, extra: Parameters<typeof providerAccountIneligibility>[1] = { now: NOW }) =>
    assert.equal(providerAccountIneligibility(candidate, extra)?.reason, reason);
  const profile = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  expectReason(account("a", { profile: { id: profile, access: "not_granted" } }), "access_not_granted");
  expectReason(account("a", { profile: { id: profile, access: "pending" } }), "access_pending");
  expectReason(account("a"), "access_refused", { accessRefused: true, now: NOW });
  expectReason(account("a", { authStatus: "unauthenticated" }), "signed_out");
  expectReason(account("a", { authStatus: "unknown" }), "sign_in_unknown");
  expectReason(account("a"), "context_incompatible", { now: NOW, agent: { providerAccountReadiness: { defaultAuthStatus: "unknown", readyAccountIds: [] } } });
  expectReason(account("a", { billing: "api" }), "api_billing");
  expectReason(account("a", { billing: undefined }), "api_billing", { now: NOW, usage: usage("a", { state: "not_applicable" }) });
  expectReason(account("a"), "api_billing", { now: NOW, agent: { codexBillingSource: "api" } });
  expectReason(account("a", { billing: "unknown" }), "billing_unknown");
  expectReason(account("a", { selectionCooldownUntil: NOW + 1 }), "cooldown");
  expectReason(account("a"), "usage_exhausted", { now: NOW, usage: usage("a", { buckets: [{ id: "w", label: "Week", remainingPercent: 0 }] }) });
  expectReason(account("a"), "spend_limit_reached", { now: NOW, usage: usage("a", { spendControls: [{ id: "s", label: "Spend", reached: true }] }) });
});

test("an agent's own billing route disqualifies every account, but one account's console sign-in doesn't (#4353)", () => {
  const claudeCode = (auth: Partial<NonNullable<AgentDefinition["claudeCode"]>["auth"]>) =>
    ({ auth: { status: "authenticated", billingSource: "unknown", ...auth } }) as NonNullable<AgentDefinition["claudeCode"]>;
  const reason = (auth: Partial<NonNullable<AgentDefinition["claudeCode"]>["auth"]>) =>
    providerAccountIneligibility(account("a"), { now: NOW, agent: { claudeCode: claudeCode(auth) } })?.reason;
  assert.equal(reason({ method: "api_key", billingSource: "api" }), "api_billing");
  assert.equal(reason({ provider: "bedrock", billingSource: "bedrock" }), "api_billing");
  assert.equal(reason({ provider: "vertex", billingSource: "vertex" }), "api_billing");
  assert.equal(reason({ method: "console", billingSource: "api" }), undefined, "that account reports its own billing");
  assert.equal(reason({ method: "claude.ai", billingSource: "subscription" }), undefined);
});

test("a limit that has passed no longer disqualifies, and missing usage never does", () => {
  const eligible = (extra: Partial<Parameters<typeof providerAccountIneligibility>[1]>, candidate = account("a")) =>
    assert.equal(providerAccountIneligibility(candidate, { now: NOW, ...extra }), null);
  eligible({}, account("a", { selectionCooldownUntil: NOW }));
  eligible({ usage: usage("a", { buckets: [{ id: "w", label: "Week", status: "exhausted", resetsAt: NOW }] }) });
  eligible({ usage: usage("a", { spendControls: [{ id: "s", label: "Spend", reached: true, resetsAt: NOW }] }) });
  // A last-known reading that isn't used up is not evidence against the account.
  eligible({ usage: usage("a", { state: "unavailable", buckets: [] }) });
  // A subscription verified by a usage reading needs no billing report from the status check.
  eligible({ usage: usage("a") }, account("a", { billing: undefined }));
});

test("a reading with no reset time stays used up until a newer one says otherwise", () => {
  assert.equal(providerAccountIneligibility(account("a"), { now: NOW, usage: usage("a", {
    buckets: [{ id: "w", label: "Week", usedPercent: 100 }], fetchedAt: 1,
  }) })?.reason, "usage_exhausted");
});

test("no eligible account requires an explicit choice, with a structured way forward and no names", () => {
  const result = resolve({
    policy: priority("signed-out", "at-limit", "gone"),
    accounts: [account("signed-out", { authStatus: "unauthenticated" }), account("at-limit")],
    usage: [usage("at-limit", { buckets: [{ id: "5h", label: "5 hours", status: "exhausted", resetsAt: NOW + 5 }] })],
  });
  assert.equal(result.status, "choice_required");
  assert.equal(result.refusal, "no_eligible_account");
  assert.equal(result.accountId, undefined);
  const structured = providerAccountChoiceRequired(result);
  assert.deepEqual(structured.actions, ["choose_account", "sign_in", "wait", "review_provider_accounts"]);
  assert.equal(structured.retryAt, NOW + 5);
  const sentence = providerAccountChoiceRequiredSentence("claude", "no_eligible_account", result.candidates);
  assert.match(sentence, /No Claude account .* Priority Order/u);
  assert.match(sentence, /one needs sign-in/u);
  for (const name of ["signed-out", "at-limit", "gone", "example.com"]) assert.ok(!sentence.includes(name), sentence);
});

test("the stored reason counts accounts ahead of the choice and names none of them", () => {
  const record = providerAccountSelectionRecord(resolve({
    policy: priority("signed-out", "ready", "also-signed-out"),
    accounts: [account("signed-out", { authStatus: "unauthenticated" }), account("ready"), account("also-signed-out", { authStatus: "unauthenticated" })],
  }));
  assert.deepEqual(record, { schemaVersion: 1, source: "priority", mode: "priority", policyRevision: 3,
    skipped: { signed_out: 1 }, revalidateAtLaunch: true });
  const sentence = providerAccountSelectionSentence(record);
  assert.match(sentence, /first eligible account/u);
  assert.match(sentence, /one needs sign-in/u);
  assert.ok(!JSON.stringify(record).includes("signed-out"));
});

test("an older record and a fixed default keep their meaning, and legacy fallback keeps its provenance", () => {
  const accounts = [account("a"), account("b")];
  const fixed = resolve({ policy: { provider: "claude", accountId: "b", revision: 2 }, accounts });
  assert.deepEqual([fixed.status, fixed.source, fixed.accountId, fixed.mode], ["selected", "fixed_default", "b", "fixed"]);
  const cleared = resolve({ policy: { provider: "claude", accountId: null, revision: 2 }, accounts, agent: { defaultProviderAccountId: "b" } });
  assert.deepEqual([cleared.source, cleared.accountId], ["agent_default", "b"]);
  const first = resolve({ policy: null, accounts, agent: {} });
  assert.deepEqual([first.source, first.accountId], ["first_available", "a"]);
  assert.match(providerAccountSelectionSentence(providerAccountSelectionRecord(first)), /first available account/u);
  assert.match(providerAccountSelectionSentence(providerAccountSelectionRecord(cleared)), /agent's configured account/u);
});

test("an unavailable default is reported and never replaced by another account", () => {
  const accounts = [account("a")];
  const missing = resolve({ policy: { provider: "claude", accountId: "gone", revision: 1 }, accounts });
  assert.deepEqual([missing.status, missing.refusal, missing.accountId], ["choice_required", "default_missing", "gone"]);
  const notReady = resolve({ policy: { provider: "claude", accountId: "a", revision: 1 }, accounts,
    agent: { providerAccountReadiness: { defaultAuthStatus: "unknown", readyAccountIds: [] } } });
  assert.deepEqual([notReady.status, notReady.refusal, notReady.accountId], ["choice_required", "default_unavailable", "a"]);
});

test("a fixed default keeps its account through usage and billing a person accepted", () => {
  const result = resolve({ policy: { provider: "claude", accountId: "a", revision: 1 },
    accounts: [account("a", { billing: "api", selectionCooldownUntil: NOW + 10 })],
    usage: [usage("a", { buckets: [{ id: "w", label: "Week", status: "exhausted" }] })] });
  assert.deepEqual([result.status, result.accountId], ["selected", "a"]);
});

test("policy never reaches WSL, which keeps its context-local account", () => {
  const result = resolve({ native: false, policy: priority("a"), accounts: [account("a")], agent: { defaultProviderAccountId: "wsl-account" } });
  assert.deepEqual([result.source, result.accountId, result.mode], ["agent_default", "wsl-account", "fixed"]);
  const none = resolve({ native: false, policy: priority("a"), accounts: [account("a")], agent: {} });
  assert.equal(none.status, "none");
});

test("modes this release can't enforce fail closed", () => {
  const accounts = [account("a")];
  const newer = resolve({ policy: { ...priority("a"), mode: "unsupported" }, accounts });
  assert.deepEqual([newer.status, newer.refusal, newer.accountId], ["choice_required", "unsupported_mode", undefined]);
  const oldRunner = resolve({ policy: priority("a"), accounts, policySupported: false });
  assert.deepEqual([oldRunner.status, oldRunner.refusal, oldRunner.accountId], ["choice_required", "runner_update_required", undefined]);
  assert.ok(providerAccountChoiceRequired(oldRunner).actions.includes("update_runner"));
  const memory = resolve({ policy: priority("a"), accounts, accountSpecificMemory: true });
  assert.equal(memory.refusal, "account_memory");
});

test("the runner's recheck refuses only on positive evidence", () => {
  assert.equal(providerAccountLaunchIneligibility(undefined, { now: NOW }), "missing");
  assert.equal(providerAccountLaunchIneligibility(account("a", { authStatus: "unauthenticated" }), { now: NOW }), "signed_out");
  assert.equal(providerAccountLaunchIneligibility(account("a", { selectionCooldownUntil: NOW + 1 }), { now: NOW }), "cooldown");
  assert.equal(providerAccountLaunchIneligibility(account("a", { billing: "api" }), { now: NOW }), "api_billing");
  assert.equal(providerAccountLaunchIneligibility(account("a", { authStatus: "unknown" }), { now: NOW }), null);
  assert.equal(providerAccountLaunchIneligibility(account("a", { billing: "unknown" }), { now: NOW }), null);
  assert.equal(providerAccountLaunchIneligibility(account("a"), { now: NOW, usage: usage("a", {
    buckets: [{ id: "w", label: "Week", status: "exhausted", resetsAt: NOW + 1 }] }) }), "usage_exhausted");
});

test("a policy write is checked for shape and keeps what it doesn't name", () => {
  const current = { ...priority("a", "b"), fixedAccountId: "a" };
  const keep = parseProviderAccountPolicyWrite({ mode: "fixed", expectedRevision: 3 }, current);
  assert.deepEqual(keep, { ok: true, mode: "fixed", fixedAccountId: "a", priorityAccountIds: ["a", "b"], expectedRevision: 3 });
  const bad = (body: unknown) => assert.equal(parseProviderAccountPolicyWrite(body, null).ok, false, JSON.stringify(body));
  bad({ mode: "automatic_balance", expectedRevision: 0 });
  bad({ mode: "balance", expectedRevision: 0 });
  bad({ mode: "priority", priorityAccountIds: ["a"] });
  bad({ mode: "priority", expectedRevision: -1, priorityAccountIds: ["a"] });
  bad({ mode: "priority", expectedRevision: 0, priorityAccountIds: [] });
  bad({ mode: "priority", expectedRevision: 0 });
  bad({ mode: "priority", expectedRevision: 0, priorityAccountIds: ["a", "a"] });
  bad({ mode: "priority", expectedRevision: 0, priorityAccountIds: ["../secret"] });
  bad({ mode: "fixed", expectedRevision: 0, fixedAccountId: "not valid" });
  bad({ mode: "priority", expectedRevision: 0, priorityAccountIds: Array.from({ length: 33 }, (_, index) => `a${index}`) });
});

test("harness availability under Priority Order counts only ranked accounts that could be chosen", () => {
  const agent = (ready: string[]): Pick<AgentDefinition, "available" | "providerAccountReadiness" | "driver" | "context"> =>
    ({ available: true, driver: "claude-code", providerAccountReadiness: { defaultAuthStatus: "unknown", readyAccountIds: ready } });
  const defaults = [priority("a", "b")];
  assert.equal(agentAvailableForRunnerDefault(agent(["b"]), defaults), true);
  assert.equal(agentAvailableForRunnerDefault(agent(["c"]), defaults), false, "an unranked account is never chosen automatically");
  assert.equal(agentAvailableForRunnerDefault({ ...agent(["b"]), available: false }, defaults), false);
  assert.equal(agentAvailableForRunnerDefault(agent(["a"]), [{ ...priority("a"), mode: "unsupported" }]), false);
  assert.equal(agentAvailableForRunnerDefault({ ...agent([]), context: { kind: "wsl", distro: "Ubuntu" },
    providerAccountReadiness: { defaultAuthStatus: "authenticated", defaultAccountId: "w", readyAccountIds: ["w"] } }, defaults), true,
  "WSL keeps its own default");
});
