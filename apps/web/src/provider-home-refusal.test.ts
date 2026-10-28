import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_HOME_LAUNCH_REFUSAL_CODES, PROVIDER_HOME_RECOVERY_CAUSES, PROVIDER_HOME_RECOVERY_CAUSE_CODES } from "@wollipog/protocol";
import { availableProviderHomeRefusalActions, providerHomeRefusalCopy } from "./provider-home-refusal.js";

test("every launch refusal code has its own state, a short sentence-case body and a recovery", () => {
  const titles = new Set<string>();
  for (const code of PROVIDER_HOME_LAUNCH_REFUSAL_CODES) {
    for (const account of ["Work", undefined]) {
      const copy = providerHomeRefusalCopy({ code, provider: "claude" }, account);
      assert.ok(copy.title.length > 0, code);
      assert.ok(/^[A-Z]/.test(copy.body), `${code}: ${copy.body}`);
      const sentences = copy.body.split(/(?<=[.!?])\s+/u).filter(Boolean);
      assert.ok(sentences.length <= 2, `${code}: ${copy.body}`);
      if (account) assert.ok(copy.body.includes(account), `${code} names the account`);
      else {
        assert.ok(copy.body.includes("this Machine's Claude sign-in"), `${code} names the Machine's own HOME`);
        assert.ok(!copy.actions.includes("switch_account"), `${code}: the Machine's own HOME has no account to switch from`);
      }
      // A refusal never shows a path or the runner's technical vocabulary.
      assert.ok(!/[/\\]|HOME|provider-home-leases|quarantine/u.test(copy.body), `${code}: ${copy.body}`);
    }
    titles.add(providerHomeRefusalCopy({ code, provider: "codex" }, "Work").title);
  }
  assert.equal(titles.size, PROVIDER_HOME_LAUNCH_REFUSAL_CODES.length, "each code is a distinct state");
});

test("each refusal offers the action that recovers it", () => {
  const actions = (code: Parameters<typeof providerHomeRefusalCopy>[0]["code"], account?: string) =>
    providerHomeRefusalCopy({ code, provider: "claude" }, account).actions;
  assert.deepEqual(actions("busy", "Work"), ["restart", "switch_account"]);
  assert.deepEqual(actions("busy"), ["restart", "set_up_profile"], "the Machine's shared HOME: a profile of this control plane's own");
  assert.deepEqual(actions("foreign_owner", "Work"), ["recover_profile", "switch_account"], "Recover Existing Profile unlocks it here");
  assert.deepEqual(actions("foreign_owner"), ["set_up_profile"], "the Machine's own HOME needs an account of this control plane");
  assert.deepEqual(actions("foreign_host", "Work"), ["switch_account", "set_up_profile"]);
  assert.deepEqual(actions("foreign_host"), ["set_up_profile"]);
  assert.deepEqual(actions("unavailable", "Work"), ["restart"]);
  assert.deepEqual(actions("profile_not_granted", "Work"), ["recover_profile", "switch_account"], "Recover Existing Profile adopts it");
  assert.deepEqual(actions("profile_changed", "Work"), ["switch_account", "open_accounts"]);
  assert.equal(providerHomeRefusalCopy({ code: "busy", provider: "codex" }, undefined).body.includes("Codex sign-in"), true);
});

test("specific recovery causes explain the problem and next step without implementation jargon", () => {
  const titles = new Set<string>();
  for (const cause of PROVIDER_HOME_RECOVERY_CAUSES) {
    const copy = providerHomeRefusalCopy({ code: PROVIDER_HOME_RECOVERY_CAUSE_CODES[cause], cause, provider: "claude" }, "Work");
    titles.add(copy.title);
    assert.doesNotMatch(copy.title + " " + copy.body, /lease|journal|boundary|cgroup|delegat|fallback|inspectability|ownership|HOME/iu, cause);
    assert.match(copy.body, /another account/iu, cause);
    assert.ok(copy.body.split(/(?<=[.!?])\s+/u).length <= 2, cause);
    assert.doesNotMatch(copy.body, /kill|quarantine|delete|terminate/iu, cause);
    assert.ok(copy.actions.includes("switch_account"), cause);
    if (cause === "process_uninspectable" || cause === "process_uninspectable_not_delegated") {
      assert.match(copy.body, /save your work and restart the machine/);
      assert.deepEqual(copy.actions, ["switch_account", "open_accounts"]);
    }
  }
  assert.equal(titles.size, PROVIDER_HOME_RECOVERY_CAUSES.length);
});

test("the Machine's own HOME refused by a recovery cause offers a managed profile of this control plane (#3240)", () => {
  const holder = providerHomeRefusalCopy({ code: "foreign_owner", cause: "holder_alive", provider: "claude" }, undefined);
  assert.deepEqual(holder.actions, ["restart", "set_up_profile"]);
  const locked = providerHomeRefusalCopy({ code: "foreign_owner", cause: "process_uninspectable", provider: "claude" }, undefined);
  assert.deepEqual(locked.actions, ["set_up_profile"]);
});

test("Set Up Managed Profile and Recover Existing Profile fall back to Open Machine Accounts for a viewer who can't complete them (#3240)", () => {
  const all = { canSetUpProfile: true, canRecoverProfile: true };
  assert.deepEqual(availableProviderHomeRefusalActions(["recover_profile", "switch_account"], all), ["recover_profile", "switch_account"]);
  assert.deepEqual(availableProviderHomeRefusalActions(["recover_profile", "switch_account"], { ...all, canRecoverProfile: false }),
    ["open_accounts", "switch_account"]);
  assert.deepEqual(availableProviderHomeRefusalActions(["restart", "set_up_profile"], { ...all, canSetUpProfile: false }),
    ["restart", "open_accounts"]);
  assert.deepEqual(availableProviderHomeRefusalActions(["switch_account", "set_up_profile", "open_accounts"], { canSetUpProfile: false, canRecoverProfile: false }),
    ["switch_account", "open_accounts"], "the fallback is listed once");
});
