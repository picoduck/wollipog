import assert from "node:assert/strict";
import { test } from "node:test";
import { isProviderAccountRef } from "@wollipog/protocol";
import { providerAccountRef, withoutProviderAccountNames } from "./agent-account-view.js";

const ACCOUNT = "first-person-example-com-1234";
const LABEL = "first.person@example.com";

test("an agent's view of a session names its account only by reference (#4508)", () => {
  const session = {
    id: "s_child", runnerId: "box", title: "Child", providerAccountId: ACCOUNT, providerAccountLabel: LABEL,
    providerAccountAutomaticallySelected: true,
    providerAccountSelection: { source: "priority", mode: "priority", policyRevision: 2 },
    providerAccountSwitchFailure: { providerAccountId: ACCOUNT, providerAccountLabel: LABEL, reason: "signed_out", detectedAt: 1 },
    providerHomeRefusal: { code: "busy", provider: "claude", providerAccountId: ACCOUNT, providerAccountLabel: LABEL, detectedAt: 2 },
    providerHomeWait: { provider: "claude", providerAccountId: ACCOUNT, providerAccountLabel: LABEL, waitingSince: 3, waitUntil: 4 },
  };
  const before = structuredClone(session);
  const narrowed = withoutProviderAccountNames(session) as Record<string, unknown>;

  assert.ok(!JSON.stringify(narrowed).includes("first"), JSON.stringify(narrowed));
  assert.equal(narrowed.providerAccountRef, providerAccountRef("box", ACCOUNT));
  assert.ok(isProviderAccountRef(narrowed.providerAccountRef as string));
  assert.deepEqual(narrowed.providerAccountSwitchFailure, { reason: "signed_out", detectedAt: 1 });
  assert.deepEqual(narrowed.providerHomeRefusal, { code: "busy", provider: "claude", detectedAt: 2 });
  assert.deepEqual(narrowed.providerHomeWait, { provider: "claude", waitingSince: 3, waitUntil: 4 });
  assert.equal(narrowed.providerAccountAutomaticallySelected, true, "facts that name no account stay");
  assert.deepEqual(narrowed.providerAccountSelection, session.providerAccountSelection);
  assert.deepEqual(session, before, "the shared view a person reads is never changed");
});

test("the reference is the one the selection route lists, per Machine (#4508)", () => {
  const [here, there] = withoutProviderAccountNames([
    { id: "a", runnerId: "box", providerAccountId: ACCOUNT },
    { id: "b", runnerId: "other-box", providerAccountId: ACCOUNT },
  ]) as Array<{ providerAccountRef?: string; providerAccountId?: string }>;
  assert.equal(here!.providerAccountId, undefined);
  assert.notEqual(here!.providerAccountRef, there!.providerAccountRef);
});

test("responses that embed sessions or account events are narrowed wherever they appear (#4508)", () => {
  const payload = {
    run: { id: "run_1", status: "running" },
    sessions: [{ id: "s_1", runnerId: "box", providerAccountId: ACCOUNT, providerAccountLabel: LABEL }],
    events: [{ seq: 4, payload: { kind: "provider_account_switched", providerAccountId: ACCOUNT, providerAccountLabel: LABEL, automatic: true } }],
  };
  const narrowed = withoutProviderAccountNames(payload);
  assert.ok(!JSON.stringify(narrowed).includes("first"), JSON.stringify(narrowed));
  assert.equal(narrowed.run, payload.run, "untouched branches are shared, not copied");
  assert.deepEqual(narrowed.events[0]!.payload, { kind: "provider_account_switched", automatic: true });
});

test("a reference, a payload without accounts, and non-plain values pass through unchanged (#4508)", () => {
  const named = { id: "s_1", runnerId: "box", providerAccountId: "acct:0123456789abcdef" };
  assert.equal(withoutProviderAccountNames(named), named);
  const plain = { sessions: [{ id: "s_1", runnerId: "box", title: "No account" }], count: 1 };
  assert.equal(withoutProviderAccountNames(plain), plain);
  for (const value of [null, undefined, "text", 3, true]) assert.equal(withoutProviderAccountNames(value), value);
  const date = new Date(0);
  assert.equal(withoutProviderAccountNames(date), date);
});
