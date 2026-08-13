import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import {
  adoptAction,
  agentInstallHints,
  externalSessionKey,
  formatAdmissionPolicy,
  formatExecutionIsolation,
  machineSettingsMutationError,
  outdatedBoxHint,
  outdatedRunnerTitle,
  nativeRunnerUpdateHint,
  runnerDisplay,
  runnerOutdated,
  sshRunnerLifecycleHint,
  sshTargetHost,
  unknownRunnerTitle,
  machineOptionLabels,
} from "./runners.js";

test("Machine setting errors explain old control-plane routes", () => {
  const legacyNotFound = Object.assign(new Error("Not Found"), { status: 404 });
  assert.match(machineSettingsMutationError(legacyNotFound), /control plane/i);
  assert.match(machineSettingsMutationError(legacyNotFound), /update or restart/i);
  assert.equal(machineSettingsMutationError(new Error("runner is offline")), "runner is offline");
  assert.equal(machineSettingsMutationError(null), "The Machine setting could not be updated.");
});

test("formatAdmissionPolicy presents stable exact-agent quotas and weights", () => {
  const base = { dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 8 };
  assert.equal(formatAdmissionPolicy(base), null);
  assert.equal(formatAdmissionPolicy({ ...base, admission: { agentLimits: {}, agentWeights: {} } }), null);
  assert.equal(formatAdmissionPolicy({
    ...base,
    admission: { agentLimits: { claude: 2 }, agentWeights: { codex: 2, claude: 3 } },
  }), "claude: limit 2, weight 3 · codex: weight 2");
});

test("formatExecutionIsolation distinguishes provider and runner-owned boundaries", () => {
  const base = { dataDir: "/data", worktreeRoot: "/data/worktrees", maxConcurrentSessions: 8 };
  assert.equal(formatExecutionIsolation(base), "Provider sandbox");
  assert.equal(formatExecutionIsolation({
    ...base,
    executionIsolation: { mode: "bwrap", network: "deny", providerStateRetentionDays: 7, providerStateMaxBytes: 5 * 1024 ** 3 },
  }), "Bubblewrap required (Linux/WSL; other native fail closed) · workspace write · Claude/Codex transcript paths isolated per session where applicable · credentials read-only · offline/local models only · owned orphan state 7d / 5GiB max");
  assert.equal(formatExecutionIsolation({
    ...base,
    executionIsolation: { mode: "seatbelt", network: "inherit" },
  }), "Seatbelt required (native macOS; other contexts fail closed) · writes limited to workspace, runner data, temp, and shared provider transcript leaf · same-provider sessions serialized · reads inherited · network inherited");
  assert.equal(formatExecutionIsolation({
    ...base,
    executionIsolation: { mode: "windows-job", network: "inherit" },
  }), "Windows Job Object required (native Windows; other contexts fail closed) · kill-on-close process tree only · filesystem and network inherited");
});

test("sshTargetHost strips user@ and :port, keeps IPv6 brackets", () => {
  assert.equal(sshTargetHost("me@host"), "host");
  assert.equal(sshTargetHost("me@host:2200"), "host");
  assert.equal(sshTargetHost("host"), "host");
  assert.equal(sshTargetHost("host:22"), "host");
  assert.equal(sshTargetHost("git@[2001:db8::1]:22"), "[2001:db8::1]");
});

test("runnerDisplay prefers the user-owned Machine name and never conflates it with hostname", () => {
  const box = { sshTarget: "misko@devbox:22" };
  assert.deepEqual(runnerDisplay(
    { runnerId: "box-1a2b3c4d", hostname: "orange-pi", displayName: "Build Machine" },
    { ...box, displayName: "Older Box Name" },
  ), {
    name: "Build Machine",
    kind: "ssh",
  });
  // An SSH alias is a better identity fallback than its host-reported hostname.
  assert.deepEqual(runnerDisplay({ runnerId: "box-1a2b3c4d", hostname: "orange-pi" }, box), {
    name: "devbox",
    kind: "ssh",
  });
  assert.deepEqual(runnerDisplay(undefined, box, "box-1a2b3c4d"), { name: "devbox", kind: "ssh" });
  // Native runner ids remain distinct even when multiple runners report the same hostname.
  assert.deepEqual(runnerDisplay({ runnerId: "local", hostname: "mac-studio" }, undefined), {
    name: "local",
    kind: "local",
  });
  assert.deepEqual(runnerDisplay({ runnerId: "local", hostname: "  " }, undefined), {
    name: "local",
    kind: "local",
  });
});

test("runnerOutdated flags only a KNOWN older protocol version", () => {
  assert.equal(runnerOutdated(14, 15), true);
  assert.equal(runnerOutdated(15, 15), false);
  // A runner from the future (dashboard behind) is not "outdated" — the runner is fine.
  assert.equal(runnerOutdated(16, 15), false);
  // Unknown (pre-v15 runner / old CP row) shows nothing rather than guessing.
  assert.equal(runnerOutdated(null, 15), false);
  assert.equal(runnerOutdated(undefined, 15), false);
});

test("runnerOutdated defaults its baseline to this build's PROTOCOL_VERSION", () => {
  assert.equal(runnerOutdated(PROTOCOL_VERSION), false);
  assert.equal(runnerOutdated(PROTOCOL_VERSION - 1), true);
});

test("runner update guidance stays concise and end-user focused", () => {
  const hint = outdatedBoxHint();
  assert.equal(hint, "Update this connection to enable the latest features.");
  assert.doesNotMatch(hint, /protocol|binary|(?:MAM|WOLLIPOG)_RUNNER_BIN_DIR|rebuild|release/i);
});

test("outdated runner tooltips explain the action without implementation details", () => {
  const title = outdatedRunnerTitle();
  assert.match(title, /update is available.*enable all current features/i);
  assert.doesNotMatch(title, /protocol|dashboard expects|restart the runner/i);
});

test("unknown/native runner health copy fails closed without developer commands", () => {
  assert.match(unknownRunnerTitle(), /version information is unavailable.*features may remain disabled/i);
  assert.equal(nativeRunnerUpdateHint(29, 29), null);
  assert.equal(nativeRunnerUpdateHint(30, 29), null);
  assert.match(nativeRunnerUpdateHint(28, 29)!, /started outside Wollipog.*cannot be updated here.*same setup method/i);
  assert.doesNotMatch(nativeRunnerUpdateHint(null, 29)!, /protocol|pnpm|config|binary/i);
});

test("SSH lifecycle copy stays plain-language without promising unattended survival", () => {
  assert.match(sshRunnerLifecycleHint(), /reconnects automatically.*work does not continue/i);
  assert.doesNotMatch(sshRunnerLifecycleHint(), /supervised|tunnel|bootstrap/i);
});

test("adoptAction keeps 'Adopt & Continue' unless the runner said resumable === false", () => {
  assert.deepEqual(adoptAction({ driver: "codex", context: { kind: "native" }, resumable: true }), {
    label: "Adopt & Continue",
  });
  // Absent flag = a pre-v15 runner that can't say — keep the optimistic default.
  assert.deepEqual(adoptAction({ driver: "codex", context: { kind: "native" } }), {
    label: "Adopt & Continue",
  });
});

test("adoptAction relabels non-resumable descriptors and explains the driver+context gap", () => {
  const native = adoptAction({ driver: "claude-code", context: { kind: "native" }, resumable: false });
  assert.equal(native.label, "Adopt as Read-Only");
  assert.match(native.title!, /No Claude Code Native agent/);
  assert.match(native.title!, /\(native\)/);
  assert.match(native.title!, /read-only history/);

  const wsl = adoptAction({ driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu" }, resumable: false });
  assert.match(wsl.title!, /WSL: Ubuntu/);
});

test("externalSessionKey scopes opaque ACP ids to their exact adapter", () => {
  assert.notEqual(
    externalSessionKey({ agentId: "provider-a", agentSessionId: "shared" }),
    externalSessionKey({ agentId: "provider-b", agentSessionId: "shared" }),
  );
  assert.notEqual(
    externalSessionKey({ agentId: "provider-a", agentSessionId: "shared" }),
    externalSessionKey({ agentSessionId: "shared" }),
  );
});

test("agentInstallHints gives the per-OS Claude installer plus the Codex npm one-liner", () => {
  const win = agentInstallHints("windows");
  assert.equal(win.length, 2);
  assert.match(win[0]!.command, /^irm https:\/\/claude\.ai\/install\.ps1/);
  assert.equal(win[1]!.command, "npm install -g @openai/codex");

  for (const os of ["linux", "macos"] as const) {
    const hints = agentInstallHints(os);
    assert.match(hints[0]!.command, /^curl -fsSL https:\/\/claude\.ai\/install\.sh/);
    assert.equal(hints[1]!.command, "npm install -g @openai/codex");
  }
});

test("sshTargetHost keeps unbracketed IPv6 literals whole", () => {
  assert.equal(sshTargetHost("user@2001:db8::1"), "2001:db8::1");
  assert.equal(sshTargetHost("2001:db8::1"), "2001:db8::1");
  // one colon = host:port, still stripped
  assert.equal(sshTargetHost("user@10.0.0.5:2222"), "10.0.0.5");
});

test("machineOptionLabels disambiguates only where Machine names collide", () => {
  const runner = (runnerId: string, hostname: string, displayName?: string) =>
    ({ runnerId, hostname, displayName }) as Parameters<typeof machineOptionLabels>[0][number];

  // Distinct names stay clean — no connection metadata bolted onto every option.
  const distinct = machineOptionLabels([
    runner("native-aaaa1111", "WINBOX", "Design Workstation"),
    runner("native-bbbb2222", "linuxbox", "Build Machine"),
  ]);
  assert.equal(distinct.get("native-aaaa1111"), "Design Workstation");
  assert.equal(distinct.get("native-bbbb2222"), "Build Machine");

  // Colliding names would otherwise render two identical options, and picking the wrong one
  // launches work against the wrong host and filesystem. Hostname is the better discriminator.
  const collide = machineOptionLabels([
    runner("native-aaaa1111", "build-a", "Build Machine"),
    runner("native-bbbb2222", "build-b", "Build Machine"),
  ]);
  assert.equal(collide.get("native-aaaa1111"), "Build Machine · build-a");
  assert.equal(collide.get("native-bbbb2222"), "Build Machine · build-b");

  // When hostnames collide too, fall back to the FULL connection id. A truncated one is not a
  // safe discriminator: two native runner ids can share an 8-character prefix, which reintroduces
  // the exact ambiguity this fallback exists to remove.
  const both = machineOptionLabels([
    runner("native-aaaa1111", "same-host", "Build Machine"),
    runner("native-bbbb2222", "same-host", "Build Machine"),
  ]);
  assert.equal(both.get("native-aaaa1111"), "Build Machine · native-aaaa1111");
  assert.equal(both.get("native-bbbb2222"), "Build Machine · native-bbbb2222");

  // A Box's SSH target is the intended fallback identity when no custom name was given, so an
  // unnamed SSH Machine reads as its target rather than an opaque runner id.
  const viaBox = machineOptionLabels(
    [runner("box-7f3a9c21", "")],
    () => ({ sshTarget: "deploy@build-linux", displayName: undefined }),
  );
  assert.equal(viaBox.get("box-7f3a9c21"), "build-linux");
});

test("machineOptionLabels always produces globally unique labels", () => {
  const runner = (runnerId: string, hostname: string, displayName?: string) =>
    ({ runnerId, hostname, displayName }) as Parameters<typeof machineOptionLabels>[0][number];

  // A user-authored name can collide with a label this function GENERATES for another Machine.
  const authored = machineOptionLabels([
    runner("native-1", "build-a", "Build Machine"),
    runner("native-2", "build-b", "Build Machine"),
    runner("native-3", "other", "Build Machine · build-a"),
  ]);
  assert.equal(new Set(authored.values()).size, authored.size, "labels must be globally unique");

  // Native runner ids can share an 8-character prefix, so a truncated id is not a safe tier.
  const sharedPrefix = machineOptionLabels([
    runner("native-aaaa-1", "same-host", "Build Machine"),
    runner("native-aaaa-2", "same-host", "Build Machine"),
  ]);
  assert.equal(new Set(sharedPrefix.values()).size, 2, "same name and host must still disambiguate");
  assert.equal(sharedPrefix.get("native-aaaa-1"), "Build Machine · native-aaaa-1");

  // Degenerate inputs.
  assert.equal(machineOptionLabels([]).size, 0);
  assert.equal(machineOptionLabels([runner("only", "h", "Solo")]).get("only"), "Solo");
});
