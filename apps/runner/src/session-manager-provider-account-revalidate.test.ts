import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderAccountDefinition, ProviderAccountSelectionRecord, SessionLaunchSpec, SubscriptionUsageSnapshot } from "@wollipog/protocol";
import { bindSessionProviderAccount } from "./provider-accounts.js";
import { SessionManager, type DurableCommandLifecycle, type ProviderAccountResolver } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

// #4353: an account a policy chose at dispatch is rechecked before a new session binds it. The launch
// refuses rather than running on an account that stopped being usable, or quietly choosing another.

const CHOSEN: ProviderAccountDefinition = { id: "person-example-com", label: "person@example.com", provider: "claude", authStatus: "authenticated", billing: "subscription" };
const SELECTION: ProviderAccountSelectionRecord = { schemaVersion: 1, source: "priority", mode: "priority", policyRevision: 2, revalidateAtLaunch: true };

function spec(overrides: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return { sessionId: "s_recheck", workspaceId: "repo", workspacePath: "/repo", agentId: "claude", command: "claude", args: [], env: {},
    useWorktree: false, driver: "claude-code", context: { kind: "native" }, providerAccountId: CHOSEN.id, providerAccountSelection: SELECTION, ...overrides };
}

function harness(accounts: ProviderAccountDefinition[], usage: SubscriptionUsageSnapshot[] = []) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-account-recheck-"));
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, (() => { throw new Error("nothing may spawn"); }) as never, dataDir, 1);
  const internals = manager as unknown as {
    resolveProviderAccount: ProviderAccountResolver;
    providerAccounts: () => ProviderAccountDefinition[];
    subscriptionUsageInventory: () => SubscriptionUsageSnapshot[];
    resolveNewProviderAccountBinding: (launch: SessionLaunchSpec) => { id: string } | undefined;
  };
  // Like the real resolver, this one's errors name the account: the recheck must come first.
  internals.resolveProviderAccount = (launch) => {
    if (!accounts.some((account) => account.id === launch.providerAccountId)) throw new Error(`provider account '${launch.providerAccountId}' is not configured`);
    return { id: launch.providerAccountId!, label: "person@example.com", provider: "claude", credentialHome: "/homes/person" };
  };
  internals.providerAccounts = () => accounts;
  internals.subscriptionUsageInventory = () => usage;
  return { manager, internals, cleanup: () => { manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); }, repo: (() => { const repo = join(root, "repo"); mkdirSync(repo); return repo; })() };
}

test("a policy-chosen account that is still usable binds at launch", () => {
  const { internals, cleanup } = harness([CHOSEN]);
  try {
    assert.equal(internals.resolveNewProviderAccountBinding(spec())?.id, CHOSEN.id);
  } finally { cleanup(); }
});

test("a policy-chosen account refuses at launch once it stops being usable, naming nobody", () => {
  const cases: Array<[string, ProviderAccountDefinition[], SubscriptionUsageSnapshot[], RegExp]> = [
    ["removed", [], [], /is no longer on this machine/u],
    ["signed out", [{ ...CHOSEN, authStatus: "unauthenticated" }], [], /needs sign-in/u],
    ["cooling down", [{ ...CHOSEN, selectionCooldownUntil: Date.now() + 60_000 }], [], /recently hit a usage limit/u],
    ["now on API credits", [{ ...CHOSEN, billing: "api" }], [], /would spend API credits/u],
    ["used up", [CHOSEN], [{ sourceId: "s", runnerId: "runner", agentId: "claude", provider: "claude", state: "available", fetchedAt: 1,
      providerAccountId: CHOSEN.id, buckets: [{ id: "w", label: "Week", status: "exhausted", resetsAt: Date.now() + 60_000 }] }], /is at a usage limit/u],
  ];
  for (const [label, accounts, usage, expected] of cases) {
    const { internals, cleanup } = harness(accounts, usage);
    try {
      assert.throws(() => internals.resolveNewProviderAccountBinding(spec()), (error: Error) => {
        assert.match(error.message, expected, label);
        for (const personal of ["person", "example.com"]) assert.ok(!error.message.includes(personal), error.message);
        return true;
      }, label);
    } finally { cleanup(); }
  }
});

test("an account a person named keeps its recovery path instead of a recheck", () => {
  const { internals, cleanup } = harness([{ ...CHOSEN, authStatus: "unauthenticated" }]);
  try {
    const explicit: ProviderAccountSelectionRecord = { schemaVersion: 1, source: "explicit", mode: "priority", policyRevision: 2 };
    assert.equal(internals.resolveNewProviderAccountBinding(spec({ providerAccountSelection: explicit }))?.id, CHOSEN.id);
    assert.equal(internals.resolveNewProviderAccountBinding(spec({ providerAccountSelection: undefined }))?.id, CHOSEN.id,
      "an older control plane sends no reason, and its launch is unchanged");
  } finally { cleanup(); }
});

test("a refused launch fails its durable command and starts nothing", async () => {
  const { manager, repo, cleanup } = harness([{ ...CHOSEN, authStatus: "unauthenticated" }]);
  try {
    const failures: string[] = [];
    const lifecycle = { commandId: "c", queued() {}, started() {}, completed() {}, uncertain() {},
      failed: (error: string) => { failures.push(error); } } satisfies DurableCommandLifecycle;
    assert.equal(await manager.start(spec({ workspacePath: repo }), undefined, undefined, lifecycle), false);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, /provider account rejected: .*needs sign-in.*Start the session again/u);
  } finally { cleanup(); }
});

test("a retry of an accepted launch keeps its recorded account without another recheck", () => {
  const prior = { providerAccountId: CHOSEN.id, providerAccountLabel: CHOSEN.label, providerAccountProvider: "claude" as const,
    providerCredentialHome: "/homes/person" } as SessionMeta;
  const bound = bindSessionProviderAccount(prior, spec(), () => { throw new Error("an accepted launch never resolves again"); });
  assert.equal(bound?.id, CHOSEN.id);
});
