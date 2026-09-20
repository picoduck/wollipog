import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubscriptionUsageSourceView } from "@wollipog/protocol";
import {
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
