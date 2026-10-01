import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionUsageSourceView } from "@wollipog/protocol";
import {
  providerAccountSwitchChoices,
  providerAccountSwitchOptions,
  providerForSessionAccountSwitch,
} from "./provider-account-switch.js";

const accounts = [
  { id: "work", label: "Work", provider: "codex" as const, authStatus: "authenticated" as const },
  { id: "personal", label: "Personal", provider: "codex" as const, authStatus: "authenticated" as const },
  { id: "spent", label: "Spent", provider: "codex" as const, authStatus: "authenticated" as const },
  { id: "signed-out", label: "Signed Out", provider: "codex" as const, authStatus: "unauthenticated" as const },
  { id: "claude", label: "Claude", provider: "claude" as const, authStatus: "authenticated" as const },
];

function source(
  providerAccountId: string,
  remainingPercent: number,
  runnerId = "runner-1",
): SubscriptionUsageSourceView {
  return {
    sourceId: `source-${providerAccountId}`,
    runnerId,
    runnerName: runnerId,
    runnerStatus: "online",
    agentId: "codex",
    agentName: "Codex",
    provider: "codex",
    providerAccountId,
    accountLabel: providerAccountId,
    state: "available",
    freshness: "fresh",
    fetchedAt: 1,
    buckets: [{ id: "five-hour", label: "5 Hour", remainingPercent }],
  };
}

test("account switch options require the same Machine, provider, authentication, and headroom", () => {
  const options = providerAccountSwitchOptions({
    runnerId: "runner-1",
    driver: "codex-app-server",
    providerAccountId: "work",
  }, accounts, [
    source("personal", 45),
    source("spent", 0),
    source("signed-out", 80),
    source("claude", 80),
    source("other-machine", 80, "runner-2"),
  ]);
  assert.deepEqual(options.map((option) => option.id), ["personal"]);
  assert.equal(providerForSessionAccountSwitch("claude-code"), "claude");
  assert.equal(providerForSessionAccountSwitch("acp"), null);
});

test("a parked failure may retry its selected account when usage still has headroom", () => {
  const options = providerAccountSwitchOptions({
    runnerId: "runner-1",
    driver: "codex-app-server",
    providerAccountId: "personal",
    providerAccountSwitchFailure: {
      providerAccountId: "personal",
      providerAccountLabel: "Personal",
      reason: "resume failed",
      detectedAt: 1,
    },
  }, accounts, [source("personal", 40)]);
  assert.deepEqual(options.map((option) => option.id), ["personal"]);
});

test("accounts a switch cannot choose are returned with a typed reason, and offered ones are unchanged", () => {
  const session = { runnerId: "runner-1", driver: "codex-app-server" as const, providerAccountId: "work" };
  const machine = [
    ...accounts,
    { id: "unknown", label: "Unknown", provider: "codex" as const, authStatus: "unknown" as const },
    { id: "unread", label: "Unread", provider: "codex" as const, authStatus: "authenticated" as const },
    { id: "failing", label: "Failing", provider: "codex" as const, authStatus: "authenticated" as const },
    { id: "used", label: "Used", provider: "codex" as const, authStatus: "authenticated" as const },
  ];
  const sources = [
    source("work", 0),
    source("personal", 45),
    source("spent", 0),
    source("signed-out", 80),
    source("unknown", 80),
    { ...source("failing", 80), state: "unavailable" as const },
    source("unread", 80, "runner-2"),
    { ...source("used", 30), buckets: [
      { id: "five-hour", label: "5-Hour", remainingPercent: 30, resetsAt: 1_000 },
      { id: "weekly", label: "Weekly", usedPercent: 100, resetsAt: 9_000 },
      { id: "monthly", label: "Monthly", status: "exhausted" as const, resetsAt: 5_000 },
    ] },
  ];
  const choices = providerAccountSwitchChoices(session, machine, sources);
  assert.deepEqual(choices.accounts, providerAccountSwitchOptions(session, machine, sources));
  assert.deepEqual(choices.accounts.map((option) => option.id), ["personal"]);
  assert.deepEqual(choices.unavailable.map(({ id, reason, exhaustedWindow }) => [id, reason, exhaustedWindow?.id]), [
    ["spent", "usage_exhausted", "five-hour"],
    ["signed-out", "signed_out", undefined],
    ["unknown", "sign_in_unknown", undefined],
    ["unread", "usage_unknown", undefined],
    ["failing", "usage_unknown", undefined],
    ["used", "usage_exhausted", "weekly"],
  ], "the session's own account and another provider's account are never listed");
  assert.equal(choices.unavailable.find((account) => account.id === "spent")?.label, "Spent");
});

test("an exhausted window without a reset time is the one named, since nothing says when it ends", () => {
  const machine = [{ id: "used", label: "Used", provider: "claude" as const, authStatus: "authenticated" as const }];
  const used = { ...source("used", 0), provider: "claude" as const, buckets: [
    { id: "weekly", label: "Weekly", remainingPercent: 0, resetsAt: 9_000 },
    { id: "five-hour", label: "5-Hour", remainingPercent: 0 },
  ] };
  const choices = providerAccountSwitchChoices(
    { runnerId: "runner-1", driver: "claude-code", providerAccountId: "current" }, machine, [used]);
  assert.deepEqual(choices.unavailable, [{
    id: "used", label: "Used", reason: "usage_exhausted",
    exhaustedWindow: { id: "five-hour", label: "5-Hour", remainingPercent: 0 },
  }]);
});

test("a session whose driver cannot switch has no choices at all", () => {
  assert.deepEqual(
    providerAccountSwitchChoices({ runnerId: "runner-1", driver: "acp", providerAccountId: "work" }, accounts, []),
    { accounts: [], unavailable: [] });
});

test("the session's own account is never unavailable, even while a retry of it is not offered", () => {
  const choices = providerAccountSwitchChoices({
    runnerId: "runner-1",
    driver: "codex-app-server",
    providerAccountId: "spent",
    providerAccountSwitchFailure: {
      providerAccountId: "spent",
      providerAccountLabel: "Spent",
      reason: "resume failed",
      detectedAt: 1,
    },
  }, accounts, [source("spent", 0), source("personal", 45)]);
  assert.deepEqual(choices.accounts.map((option) => option.id), ["personal"]);
  assert.equal(choices.unavailable.some((account) => account.id === "spent"), false);
});

test("a requester who cannot see the Machine's inventory gets no unavailable accounts, and the same offers", () => {
  const session = { runnerId: "runner-1", driver: "codex-app-server" as const, providerAccountId: "work" };
  const sources = [source("personal", 45), source("spent", 0)];
  const hidden = providerAccountSwitchChoices(session, accounts, sources, { listUnavailable: false });
  assert.deepEqual(hidden, { accounts: providerAccountSwitchOptions(session, accounts, sources), unavailable: [] });
  assert.equal(providerAccountSwitchChoices(session, accounts, sources).unavailable.length, 2);
});
