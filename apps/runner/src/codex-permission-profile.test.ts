import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CODEX_GUARD_PERMISSION_PROFILE_ID,
  CODEX_PROFILE_RETRY_COOLDOWN_MS,
  codexPermissionProfileArgsActive,
  codexPermissionProfileBase,
  codexPermissionProfileDefeatedBy,
  codexPermissionProfileLaunchArgs,
  codexPermissionProfileOverrides,
  decideCodexPermissionProfile,
  resetCodexPermissionProfileVerification,
  verifiedCodexPermissionProfile,
  verifyCodexPermissionProfileLaunch,
  withoutCodexPermissionProfileArgs,
} from "./codex-permission-profile.js";

const HOOK_DIR = "/data/hooks/abc123";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wollipog-profile-test-"));
}

/* ---------------------------------------------------------------------------------------------
 * Which modes migrate. The "narrowest" scope of #1336 slice 2: exactly the modes whose legacy
 * sandbox policy IS a built-in profile.
 * ------------------------------------------------------------------------------------------ */

test("every mode whose legacy policy is a built-in profile maps to that profile", () => {
  for (const mode of ["auto-review", "on-request", "untrusted", "on-failure", "workspace-write"]) {
    assert.equal(codexPermissionProfileBase(mode), ":workspace", mode);
  }
  assert.equal(codexPermissionProfileBase("read-only"), ":read-only");
  // A session that names no mode runs auto-review, which is :workspace.
  assert.equal(codexPermissionProfileBase(undefined), ":workspace");
  assert.equal(codexPermissionProfileBase(""), ":workspace");
});

test("modes with no exact profile equivalent are left alone rather than downgraded", () => {
  // `:danger-full-access` cannot be extended and has no sandbox to enforce a deny.
  assert.equal(codexPermissionProfileBase("danger-full-access"), null);
  // The Orchestrator preset sends non-default writableRoots, which no projection reads back.
  assert.equal(codexPermissionProfileBase("orchestrator"), null);
  // An unknown mode keeps its legacy policy: the safe direction is "no deny", never a different
  // sandbox from the one the user chose.
  assert.equal(codexPermissionProfileBase("some-future-mode"), null);
});

/* ---------------------------------------------------------------------------------------------
 * The override text. Measured against codex-cli 0.155.1: the bare string form denies, and the
 * table form (`{ access = "deny" }`) parses without error and does NOT.
 * ------------------------------------------------------------------------------------------ */

test("the overrides are the measured spelling: bare string deny, selected by default_permissions", () => {
  const [profile, select] = codexPermissionProfileOverrides(":workspace", HOOK_DIR);
  assert.equal(
    profile,
    `permissions.${CODEX_GUARD_PERMISSION_PROFILE_ID}=` +
      `{extends=":workspace",filesystem={"/data/hooks/abc123"="deny"}}`,
  );
  assert.equal(select, `default_permissions="${CODEX_GUARD_PERMISSION_PROFILE_ID}"`);
  // Never the table form, which parses but does not deny.
  assert.ok(!profile.includes("access"));
});

test("a control character in the directory fails closed instead of being escaped", () => {
  assert.throws(() => codexPermissionProfileOverrides(":workspace", "/data/ho\u0000ks"), /control character/);
});

/* ---------------------------------------------------------------------------------------------
 * Argv placement. The LAST `-c` for a dotted path wins, measured.
 * ------------------------------------------------------------------------------------------ */

test("the runner's overrides go last, after every catalog-supplied -c", () => {
  const overrides = codexPermissionProfileOverrides(":workspace", HOOK_DIR);
  const args = codexPermissionProfileLaunchArgs(["-c", "model=\"o3\""], overrides);
  assert.deepEqual(args, ["-c", "model=\"o3\"", "-c", overrides[0], "-c", overrides[1]]);
  assert.ok(codexPermissionProfileArgsActive(args, overrides));
});

test("a later override of the same dotted path means the profile is NOT active", () => {
  const overrides = codexPermissionProfileOverrides(":workspace", HOOK_DIR);
  const shadowed = [
    ...codexPermissionProfileLaunchArgs([], overrides),
    "-c", `permissions.${CODEX_GUARD_PERMISSION_PROFILE_ID}={extends=":workspace"}`,
  ];
  assert.equal(codexPermissionProfileArgsActive(shadowed, overrides), false);
});

test("re-preparing an argv replaces the runner's own overrides rather than stacking them", () => {
  const overrides = codexPermissionProfileOverrides(":workspace", HOOK_DIR);
  const once = codexPermissionProfileLaunchArgs(["--json"], overrides);
  const twice = codexPermissionProfileLaunchArgs(once, overrides);
  assert.deepEqual(twice, once);
});

test("a user's own -c is preserved, while a user's own default_permissions is superseded", () => {
  const overrides = codexPermissionProfileOverrides(":read-only", HOOK_DIR);
  const stripped = withoutCodexPermissionProfileArgs([
    "-c", "model=\"o3\"", "-c", "default_permissions=\"mine\"",
  ]);
  assert.deepEqual(stripped, ["-c", "model=\"o3\""]);
  assert.ok(codexPermissionProfileArgsActive(
    codexPermissionProfileLaunchArgs(stripped, overrides), overrides,
  ));
});

test("overrides go before a `--` terminator, never into the prompt", () => {
  const overrides = codexPermissionProfileOverrides(":workspace", HOOK_DIR);
  const args = codexPermissionProfileLaunchArgs(["exec", "--", "a prompt"], overrides);
  assert.deepEqual(args, ["exec", "-c", overrides[0], "-c", overrides[1], "--", "a prompt"]);
});

/* ---------------------------------------------------------------------------------------------
 * Argv that silently defeats a profile. Measured: `-s` and the bypass flag each let the denied
 * file be read; `--add-dir` over a strict ancestor and `--approve-for-me` did not.
 * ------------------------------------------------------------------------------------------ */

test("the flags that silently defeat a profile are detected", () => {
  assert.deepEqual(codexPermissionProfileDefeatedBy(["-s", "workspace-write"]), ["-s"]);
  assert.deepEqual(codexPermissionProfileDefeatedBy(["--sandbox", "read-only"]), ["--sandbox"]);
  assert.deepEqual(codexPermissionProfileDefeatedBy(["--sandbox=read-only"]), ["--sandbox=read-only"]);
  assert.deepEqual(
    codexPermissionProfileDefeatedBy(["--dangerously-bypass-approvals-and-sandbox"]),
    ["--dangerously-bypass-approvals-and-sandbox"],
  );
});

test("flags that do NOT defeat a profile are not treated as if they did", () => {
  // A deny entry outranks a writable root, and --approve-for-me changes the reviewer, not the box.
  assert.deepEqual(codexPermissionProfileDefeatedBy(["--add-dir", "/repo", "--approve-for-me"]), []);
});

/* ---------------------------------------------------------------------------------------------
 * The launch proof. Every failure path answers "not enforced".
 * ------------------------------------------------------------------------------------------ */

function fakeSpawn(result: { status?: number | null; stdout?: string; stderr?: string; error?: Error }) {
  return (() => ({
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  })) as never;
}

test("a refusal proves the deny", () => {
  const dir = tempDir();
  try {
    const verdict = verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      fakeSpawn({ status: 1, stderr: "Permission denied" }),
    );
    assert.deepEqual(verdict, { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a probe that READ the file is not enforcement, even at a nonzero exit", () => {
  const dir = tempDir();
  try {
    // The probe writes a random marker and demands it never comes back. A build that ignores the
    // unknown config keys entirely reads the file, which is the mixed-version case.
    let seen: string[] = [];
    const verdict = verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      ((_cmd: string, args: string[]) => {
        seen = args;
        // Echo the file's CONTENT, which is what a real read produces. Its name is a DIFFERENT
        // random value, so a refusal that merely prints the path can never look like a read.
        const file = /"([^"]*\.profile-probe-[0-9a-f]{32})"/.exec(args.join(" "))?.[1] ?? "";
        return { status: 3, stdout: readFileSync(file, "utf8"), stderr: "" };
      }) as never,
    );
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /read the denied file/);
    // The probe really does go through `codex sandbox -P <profile>`.
    assert.equal(seen[0], "sandbox");
    assert.equal(seen[2], CODEX_GUARD_PERMISSION_PROFILE_ID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a refusal that prints the refused path is still a refusal", () => {
  // Regression: the probe file's name and its content were once the same random value, so the
  // EACCES message — which names the path — contained the marker and every real denial was read
  // as a successful read. The two are deliberately different values now.
  const dir = tempDir();
  try {
    const verdict = verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      ((_cmd: string, args: string[]) => {
        const file = /"([^"]*\.profile-probe-[0-9a-f]{32})"/.exec(args.join(" "))?.[1] ?? "";
        return { status: 1, stdout: "", stderr: `EACCES: permission denied, open '${file}'` };
      }) as never,
    );
    assert.deepEqual(verdict, { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a zero exit is not enforcement", () => {
  const dir = tempDir();
  try {
    const verdict = verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      fakeSpawn({ status: 0 }),
    );
    assert.equal(verdict.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a probe that cannot run is not enforcement", () => {
  const dir = tempDir();
  try {
    const verdict = verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      fakeSpawn({ error: new Error("ENOENT") }),
    );
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe file is removed whatever the outcome", () => {
  const dir = tempDir();
  try {
    verifyCodexPermissionProfileLaunch(
      { command: "codex", base: ":workspace", hookStateDir: dir, cwd: dir },
      fakeSpawn({ status: 0 }),
    );
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".profile-probe-")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the proof runs once per command/base/directory, and a failure retries only after a cooldown", () => {
  resetCodexPermissionProfileVerification();
  let calls = 0;
  const ok = () => { calls++; return { ok: true } as const; };
  const launch = { command: "codex", base: ":workspace" as const, hookStateDir: HOOK_DIR, cwd: "/repo" };
  verifiedCodexPermissionProfile(launch, ok as never, 0);
  verifiedCodexPermissionProfile(launch, ok as never, 1);
  assert.equal(calls, 1, "a success is final");

  resetCodexPermissionProfileVerification();
  let failures = 0;
  const bad = () => { failures++; return { ok: false, reason: "no" } as const; };
  verifiedCodexPermissionProfile(launch, bad as never, 0);
  verifiedCodexPermissionProfile(launch, bad as never, CODEX_PROFILE_RETRY_COOLDOWN_MS - 1);
  assert.equal(failures, 1, "a failure is not retried inside the cooldown");
  verifiedCodexPermissionProfile(launch, bad as never, CODEX_PROFILE_RETRY_COOLDOWN_MS);
  assert.equal(failures, 2, "and is retried after it");
  resetCodexPermissionProfileVerification();
});

/* ---------------------------------------------------------------------------------------------
 * The whole decision.
 * ------------------------------------------------------------------------------------------ */

const proven = (() => ({ ok: true })) as never;

test("a migrated mode with a proven deny yields the profile argv", () => {
  const decision = decideCodexPermissionProfile({
    command: "codex", args: ["--json"], permissionMode: "auto-review",
    hookStateDir: HOOK_DIR, cwd: "/repo",
  }, proven);
  assert.equal(decision.active, true);
  assert.equal((decision as { base: string }).base, ":workspace");
});

test("no hook state directory, an unmigrated mode, a defeating flag, or a failed proof all keep the legacy launch", () => {
  const base = { command: "codex", args: ["--json"], permissionMode: "auto-review", cwd: "/repo" };
  for (const [label, input, verify, pattern] of [
    ["no directory", { ...base, hookStateDir: undefined }, proven, /hook state directory/],
    ["unmigrated mode", { ...base, permissionMode: "danger-full-access", hookStateDir: HOOK_DIR }, proven, /no equivalent profile/],
    ["defeating flag", { ...base, args: ["-s", "workspace-write"], hookStateDir: HOOK_DIR }, proven, /defeat a permission profile/],
    ["failed proof", { ...base, hookStateDir: HOOK_DIR }, (() => ({ ok: false, reason: "probe read the denied file" })) as never, /probe read/],
  ] as const) {
    const decision = decideCodexPermissionProfile(input, verify);
    assert.equal(decision.active, false, label);
    assert.match((decision as { reason: string }).reason, pattern, label);
  }
});
