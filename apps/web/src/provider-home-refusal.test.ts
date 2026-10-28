import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_HOME_LAUNCH_REFUSAL_CODES, PROVIDER_HOME_RECOVERY_CAUSES, PROVIDER_HOME_RECOVERY_CAUSE_CODES } from "@wollipog/protocol";
import { availableProviderHomeRefusalActions, providerHomeRefusalCopy, providerHomeWaitCopy } from "./provider-home-refusal.js";

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

test("a busy refusal offers Wait for Account instead of Restart Session only when the runner can wait (#3240)", () => {
  const copy = (account: string | undefined, cause?: "holder_alive" | "no_reboot_proof", code: "busy" | "unverifiable" = "busy") =>
    providerHomeRefusalCopy({ code, provider: "claude", ...(cause ? { cause } : {}) }, account, { canWait: true });
  // Waiting starts the session at once when the account is already free, so it replaces Restart.
  assert.deepEqual(copy("Work").actions, ["wait", "switch_account"]);
  assert.deepEqual(copy(undefined).actions, ["wait", "set_up_profile"]);
  assert.deepEqual(copy("Work", "holder_alive").actions, ["wait", "switch_account"], "a specific busy cause waits too");
  assert.match(copy("Work").body, /Wait for the account to start the session as soon as it's free/u);
  assert.ok(!copy("Work", "no_reboot_proof", "unverifiable").actions.includes("wait"), "only a busy HOME frees itself");
  assert.ok(!providerHomeRefusalCopy({ code: "busy", provider: "claude" }, "Work").actions.includes("wait"),
    "an older runner keeps today's actions");
  assert.match(providerHomeRefusalCopy({ code: "busy", provider: "claude" }, "Work").body, /Restart the session once it's free/u);
});

test("a refused fork has the session launch's state and a fork's next step (#3240)", () => {
  for (const code of PROVIDER_HOME_LAUNCH_REFUSAL_CODES) {
    const session = providerHomeRefusalCopy({ code, provider: "claude" }, "Work");
    const fork = providerHomeRefusalCopy({ code, provider: "claude" }, "Work", { launch: "fork", canWait: true });
    assert.equal(fork.title, session.title, `${code}: the same state`);
    assert.ok(!fork.actions.includes("wait"), `${code}: a fork is tried again, never waited for`);
    assert.doesNotMatch(fork.body, /restart the session|this session didn't start|start the session/iu, `${code}: ${fork.body}`);
  }
  assert.match(providerHomeRefusalCopy({ code: "busy", provider: "codex" }, undefined, { launch: "fork" }).body,
    /Codex sign-in, so the fork didn't start\. Try again once it's free\./u);
});

test("a waiting session names the account, the holder and how long it waits (#3240)", () => {
  const base = { provider: "claude" as const, waitingSince: 0, waitUntil: 8 * 3_600_000 };
  const copy = providerHomeWaitCopy(base, "Work");
  assert.equal(copy.title, "Waiting for Account");
  assert.match(copy.body, /^Another runner, provider, helper, or lease publication is using Work\. This session starts as soon as it's free\./u);
  assert.match(copy.body, /after 8 hours/u);
  assert.match(providerHomeWaitCopy({ ...base, cause: "boundary_survivor" }, "Work").body, /earlier session is still using Work/u);
  assert.match(providerHomeWaitCopy({ ...base, provider: "codex", waitUntil: 3_600_000 }, undefined).body,
    /this Machine's Codex sign-in.*after 1 hour,/u);
  assert.ok(!/[/\\]|HOME/u.test(copy.body));
});
