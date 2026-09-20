import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  CODEX_GUARD_PERMISSION_PROFILE_ID,
  CODEX_PROFILE_RETRY_COOLDOWN_MS,
  type CodexProbeResult,
  type CodexSandboxProjection,
  codexExecutableIdentity,
  codexLegacySandboxMatchesProfile,
  codexPermissionProfileArgsActive,
  codexPermissionProfileBase,
  codexPermissionProfileDefeatedBy,
  codexPermissionProfileEscalationLoss,
  codexPermissionProfileLaunchArgs,
  codexPermissionProfileOverrides,
  decideCodexPermissionProfile,
  provenCodexPermissionProfile,
  readCodexSandboxProjection,
  resetCodexPermissionProfileVerification,
  verifyCodexPermissionProfileDeny,
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
 * Approved escalations — the regression #1464 shipped. Measured on codex-cli 0.155.1 against a
 * real `codex app-server`, a scripted model provider, and a loopback HTTP server standing in for
 * the network (ADR 0012), by `pnpm probe:codex-escalation`:
 *
 *   legacy `sandboxPolicy`, approved escalation  -> reached the server
 *   profile + deny entry, approved escalation    -> blocked, on every approval path
 *   profile + deny entry, no escalation          -> blocked (correct, and preserved)
 *   profile WITHOUT a deny entry, approved       -> reached the server, so the deny is the cause
 *
 * A mode that can reach an approval therefore keeps its legacy policy.
 * ------------------------------------------------------------------------------------------ */

test("every mode that can approve an escalation is withheld from the profile", () => {
  // All five workspace modes and read-only route to an approval-capable approvalPolicy in
  // `buildCodexTurnParams`, so every one of them would lose an approved escalation's network.
  for (const mode of ["auto-review", "on-request", "untrusted", "on-failure", "workspace-write", "read-only"]) {
    assert.match(
      codexPermissionProfileEscalationLoss({ kind: "explicit", permissionMode: mode }) ?? "",
      /without network access/,
      mode,
    );
  }
  // A session that names no mode runs auto-review, which can approve one too.
  for (const mode of [undefined, ""] as const) {
    assert.ok(codexPermissionProfileEscalationLoss({ kind: "explicit", permissionMode: mode }), String(mode));
  }
  // A native TUI and a resumed `codex exec` turn run under Codex's own approval-capable default.
  assert.ok(codexPermissionProfileEscalationLoss({ kind: "implicit" }));
});

test("a mode with no profile equivalent is not reported as an escalation loss", () => {
  // These already keep their legacy policy for their own reasons; the escalation gate must not
  // claim their refusal, or a launch would report the wrong reason for having stayed put.
  for (const mode of ["danger-full-access", "orchestrator", "some-future-mode"]) {
    assert.equal(codexPermissionProfileEscalationLoss({ kind: "explicit", permissionMode: mode }), null, mode);
  }
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
  // Review finding CR-4.1: the attached short spellings codex-cli 0.155.1 accepts.
  assert.deepEqual(codexPermissionProfileDefeatedBy(["-sworkspace-write"]), ["-sworkspace-write"]);
  assert.deepEqual(codexPermissionProfileDefeatedBy(["-s=workspace-write"]), ["-s=workspace-write"]);
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
 * The deny proof. Only a positive denial report counts; every other outcome answers "not enforced".
 * ------------------------------------------------------------------------------------------ */

function fakeRun(result: Partial<CodexProbeResult>) {
  return (async () => ({
    status: result.status === undefined ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  })) as never;
}

const denyLaunch = (dir: string) => ({
  command: "codex", base: ":workspace" as const, hookStateDir: dir, cwd: dir, env: {},
});

test("a positive denial report proves the deny", async () => {
  const dir = tempDir();
  try {
    assert.deepEqual(
      await verifyCodexPermissionProfileDeny(denyLaunch(dir), fakeRun({ status: 0, stdout: "WOLLIPOG_PROBE_DENIED" })),
      { ok: true },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a probe that READ the file is not enforcement, whatever it exits with", async () => {
  const dir = tempDir();
  try {
    let seen: string[] = [];
    const verdict = await verifyCodexPermissionProfileDeny(denyLaunch(dir), (async (_cmd: string, args: string[]) => {
      seen = args;
      // Echo the file's CONTENT, which is what a real read produces. Its name is a DIFFERENT
      // random value, so a refusal that merely prints the path can never look like a read.
      const file = args.find((arg) => /\.profile-probe-[0-9a-f]{32}$/.test(arg)) ?? "";
      return { status: 3, stdout: readFileSync(file, "utf8"), stderr: "" };
    }) as never);
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /read the denied file/);
    // The probe really does go through `codex sandbox -P <profile>`.
    assert.equal(seen[0], "sandbox");
    assert.equal(seen[2], CODEX_GUARD_PERMISSION_PROFILE_ID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a refusal that prints the refused path is still a refusal", async () => {
  // Regression: the probe file's name and its content were once the same random value, so the
  // EACCES message — which names the path — contained the marker and every real denial was read
  // as a successful read. The two are deliberately different values now.
  const dir = tempDir();
  try {
    const verdict = await verifyCodexPermissionProfileDeny(denyLaunch(dir), (async (_cmd: string, args: string[]) => {
      const file = args.find((arg) => /\.profile-probe-[0-9a-f]{32}$/.test(arg)) ?? "";
      return { status: 0, stdout: "WOLLIPOG_PROBE_DENIED", stderr: `cat: ${file}: Permission denied` };
    }) as never);
    assert.deepEqual(verdict, { ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no denial report is not enforcement, at any exit code (an older codex-cli)", async () => {
  // Review finding CR-1.1. Measured on codex-cli 0.155.1: a genuine deny exits 1, an undefined
  // profile exits 1, and an unsupported flag exits 2. A build predating permission profiles lands
  // in the latter cases, and treating "nonzero" as proof would have passed it.
  const dir = tempDir();
  try {
    for (const [status, stderr] of [
      [2, "error: unexpected argument '-P' found"],
      [1, "Error: default_permissions requires a `[permissions]` table"],
      [1, "error: unrecognized subcommand 'sandbox'"],
      [0, ""],
      [null, ""],
    ] as const) {
      const verdict = await verifyCodexPermissionProfileDeny(denyLaunch(dir), fakeRun({ status, stderr }));
      assert.equal(verdict.ok, false, stderr);
      assert.match((verdict as { reason: string }).reason, /no denial/, stderr);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a probe that cannot run is not enforcement", async () => {
  const dir = tempDir();
  try {
    const verdict = await verifyCodexPermissionProfileDeny(denyLaunch(dir), fakeRun({ error: new Error("ENOENT") }));
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe file is removed whatever the outcome", async () => {
  const dir = tempDir();
  try {
    await verifyCodexPermissionProfileDeny(denyLaunch(dir), fakeRun({ status: 0 }));
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".profile-probe-")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the probe script classifies only a permission refusal as a denial", async () => {
  // The in-sandbox script is what emits the report. Run it for real, outside any sandbox, against
  // a readable file, a missing one, and an unreadable one, to pin that it tells them apart.
  const dir = tempDir();
  try {
    let argv: string[] = [];
    await verifyCodexPermissionProfileDeny(denyLaunch(dir), (async (_cmd: string, args: string[]) => {
      argv = args;
      return { status: 1, stdout: "", stderr: "" };
    }) as never);
    // argv ends: "--", "/bin/sh", "-c", <script>, <$0>, <probe file>
    const shellAt = argv.indexOf("/bin/sh");
    assert.ok(shellAt > 0 && argv[shellAt - 1] === "--", "the probe runs /bin/sh after the terminator");
    const script = argv[shellAt + 2]!;
    const probe = (file: string) =>
      String(spawnSync("/bin/sh", ["-c", script, "probe", file], { encoding: "utf8" }).stdout);

    const readable = join(dir, "readable");
    writeFileSync(readable, "CONTENT");
    assert.equal(probe(readable), "WOLLIPOG_PROBE_READ:CONTENT");
    assert.match(probe(join(dir, "missing")), /^WOLLIPOG_PROBE_ERROR:/);
    if (process.getuid?.() !== 0) {
      // root reads a mode-000 file anyway, so this case only means something unprivileged.
      const locked = join(dir, "locked");
      writeFileSync(locked, "SECRET");
      chmodSync(locked, 0o000);
      assert.equal(probe(locked), "WOLLIPOG_PROBE_DENIED");
    }
    // The path travels as an argument, never inside the script text.
    assert.ok(!script.includes(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------------------------------------------
 * The equivalence gate: a launch migrates only when its OWN configured legacy sandbox is exactly
 * what the profile reproduces. Measured: a user's `[sandbox_workspace_write]` network access and
 * extra writable roots are honoured by `-s workspace-write`, by the app-server's explicit
 * `sandboxPolicy`, and by Codex's implicit default — and NOT by a profile extending the built-in.
 * ------------------------------------------------------------------------------------------ */

const WORKSPACE = {
  type: "workspaceWrite", writableRoots: [], networkAccess: false,
  excludeTmpdirEnvVar: false, excludeSlashTmp: false,
};

const projection = (sandbox: unknown, active: CodexSandboxProjection["activePermissionProfile"] = null) =>
  ({ sandbox, activePermissionProfile: active });

test("an explicit launch whose configured sandbox is the plain built-in migrates", () => {
  assert.deepEqual(
    codexLegacySandboxMatchesProfile({ kind: "explicit", permissionMode: "auto-review" }, ":workspace", projection(WORKSPACE)),
    { ok: true },
  );
  assert.deepEqual(
    codexLegacySandboxMatchesProfile({ kind: "explicit", permissionMode: "read-only" }, ":read-only",
      projection({ type: "readOnly", networkAccess: false })),
    { ok: true },
  );
});

test("a user's sandbox_workspace_write grants keep the launch on its legacy policy", () => {
  for (const adjusted of [
    { ...WORKSPACE, networkAccess: true },
    { ...WORKSPACE, writableRoots: ["/extra"] },
    { ...WORKSPACE, excludeSlashTmp: true },
  ]) {
    const verdict = codexLegacySandboxMatchesProfile(
      { kind: "explicit", permissionMode: "workspace-write" }, ":workspace", projection(adjusted),
    );
    assert.equal(verdict.ok, false, JSON.stringify(adjusted));
  }
});

test("an implicit launch migrates only when Codex's own default is the plain :workspace built-in", () => {
  const implicit = { kind: "implicit" } as const;
  assert.deepEqual(
    codexLegacySandboxMatchesProfile(implicit, ":workspace", projection(WORKSPACE, { id: ":workspace", extends: null })),
    { ok: true },
  );
  // A user-selected profile (review finding CR-2.1), even one extending :workspace, may carry
  // entries the projection does not show.
  for (const active of [
    { id: "locked", extends: ":read-only" },
    { id: "mine", extends: ":workspace" },
    null,
  ]) {
    assert.equal(
      codexLegacySandboxMatchesProfile(implicit, ":workspace", projection(WORKSPACE, active)).ok, false,
      JSON.stringify(active),
    );
  }
});

/** A fake `codex app-server` speaking just enough JSON-RPC for the projection reader. */
function fakeAppServer(reply: (request: { id: number; method: string; params: unknown }) => unknown) {
  const spawned: { args?: string[] } = {};
  const spawn = ((_command: string, args: string[]) => {
    spawned.args = args;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
    });
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const response = reply(request);
        if (response !== undefined) child.stdout.write(`${JSON.stringify({ id: request.id, ...response as object })}\n`);
      }
    });
    return child;
  }) as never;
  return { spawn, spawned };
}

test("the projection reader asks an ephemeral thread for the launch's own sandbox", async () => {
  let threadStart: unknown;
  const { spawn, spawned } = fakeAppServer((request) => {
    if (request.method === "initialize") return { result: {} };
    threadStart = request.params;
    return { result: { sandbox: WORKSPACE, activePermissionProfile: { id: ":workspace", extends: null } } };
  });
  const result = await readCodexSandboxProjection(
    { command: "codex", args: ["-c", "model=\"o3\""], cwd: "/repo", env: {}, sandboxMode: "read-only" }, spawn,
  );
  assert.deepEqual(result, {
    ok: true,
    projection: { sandbox: WORKSPACE, activePermissionProfile: { id: ":workspace", extends: null } },
  });
  // The launch's own arguments, then the subcommand; an ephemeral thread so no history is written.
  assert.deepEqual(spawned.args, ["-c", "model=\"o3\"", "app-server"]);
  assert.deepEqual(threadStart, { cwd: "/repo", ephemeral: true, sandbox: "read-only" });
});

test("a projection reader that gets an error or no answer fails closed", async () => {
  const failing = fakeAppServer((request) =>
    request.method === "initialize" ? { result: {} } : { error: { message: "no such profile" } });
  const failed = await readCodexSandboxProjection({ command: "codex", args: [], cwd: "/repo", env: {} }, failing.spawn);
  assert.equal(failed.ok, false);

  const silent = fakeAppServer(() => undefined);
  const timedOut = await readCodexSandboxProjection({ command: "codex", args: [], cwd: "/repo", env: {} }, silent.spawn, 20);
  assert.equal(timedOut.ok, false);
  assert.match((timedOut as { reason: string }).reason, /timed out/);
});

/* ---------------------------------------------------------------------------------------------
 * The proof cache: keyed on everything that resolves the launch, shared while in flight, and
 * never outliving the binary it proved (review findings CR-1.6, CR-2.2, CR-2.4).
 * ------------------------------------------------------------------------------------------ */

function proofLaunch(overrides: Partial<Parameters<typeof provenCodexPermissionProfile>[0]> = {}) {
  return {
    command: "codex", args: [], legacy: { kind: "explicit", permissionMode: "auto-review" } as const,
    base: ":workspace" as const, hookStateDir: HOOK_DIR, cwd: "/repo", env: { CODEX_HOME: "/h1" },
    ...overrides,
  };
}

function countingDeps(identity = "bin:1") {
  const calls = { projection: 0, deny: 0 };
  let clock = 0;
  let currentIdentity = identity;
  return {
    calls,
    advance: (ms: number) => { clock += ms; },
    replaceBinary: (next: string) => { currentIdentity = next; },
    deps: {
      readProjection: async () => { calls.projection++; return { ok: true as const, projection: projection(WORKSPACE) }; },
      verifyDeny: async () => { calls.deny++; return { ok: true as const }; },
      executableIdentity: () => currentIdentity,
      now: () => clock,
    },
  };
}

test("concurrent launches share one proof while it runs", async () => {
  resetCodexPermissionProfileVerification();
  const counter = countingDeps();
  const [a, b] = await Promise.all([
    provenCodexPermissionProfile(proofLaunch(), counter.deps),
    provenCodexPermissionProfile(proofLaunch(), counter.deps),
  ]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.deepEqual(counter.calls, { projection: 1, deny: 1 });
  resetCodexPermissionProfileVerification();
});

test("a different working directory, CODEX_HOME, or argument list is proven separately", async () => {
  resetCodexPermissionProfileVerification();
  const counter = countingDeps();
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  await provenCodexPermissionProfile(proofLaunch({ cwd: "/other" }), counter.deps);
  await provenCodexPermissionProfile(proofLaunch({ env: { CODEX_HOME: "/h2" } }), counter.deps);
  await provenCodexPermissionProfile(proofLaunch({ args: ["-c", "model=\"o3\""] }), counter.deps);
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  assert.equal(counter.calls.deny, 4);
  resetCodexPermissionProfileVerification();
});

test("a replaced binary is proven again, and so is anything older than the cooldown", async () => {
  resetCodexPermissionProfileVerification();
  const counter = countingDeps();
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  counter.replaceBinary("bin:2");
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  assert.equal(counter.calls.deny, 2, "a new executable identity never reuses the old proof");
  counter.advance(CODEX_PROFILE_RETRY_COOLDOWN_MS - 1);
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  assert.equal(counter.calls.deny, 2, "a proof is reused inside the cooldown");
  counter.advance(1);
  await provenCodexPermissionProfile(proofLaunch(), counter.deps);
  assert.equal(counter.calls.deny, 3, "and re-proven after it, since the user's configuration may have changed");
  resetCodexPermissionProfileVerification();
});

test("an executable that cannot be resolved is never proven", async () => {
  resetCodexPermissionProfileVerification();
  const counter = countingDeps();
  const verdict = await provenCodexPermissionProfile(proofLaunch(), { ...counter.deps, executableIdentity: () => null });
  assert.equal(verdict.ok, false);
  assert.deepEqual(counter.calls, { projection: 0, deny: 0 });
});

test("a configured sandbox that differs from the built-in stops the proof before the deny probe", async () => {
  resetCodexPermissionProfileVerification();
  const counter = countingDeps();
  const verdict = await provenCodexPermissionProfile(proofLaunch(), {
    ...counter.deps,
    readProjection: async () => ({ ok: true as const, projection: projection({ ...WORKSPACE, networkAccess: true }) }),
  });
  assert.equal(verdict.ok, false);
  assert.equal(counter.calls.deny, 0);
  resetCodexPermissionProfileVerification();
});

test("an explicit read-only launch asks for the read-only legacy projection; an implicit one asks for none", async () => {
  resetCodexPermissionProfileVerification();
  const asked: unknown[] = [];
  const deps = {
    ...countingDeps().deps,
    readProjection: async (launch: { sandboxMode?: string }) => {
      asked.push(launch.sandboxMode);
      return { ok: true as const, projection: projection({ type: "readOnly", networkAccess: false }) };
    },
  };
  await provenCodexPermissionProfile(
    proofLaunch({ legacy: { kind: "explicit", permissionMode: "read-only" }, base: ":read-only" }), deps as never,
  );
  await provenCodexPermissionProfile(proofLaunch({ legacy: { kind: "implicit" }, cwd: "/x" }), deps as never);
  assert.deepEqual(asked, ["read-only", undefined]);
  resetCodexPermissionProfileVerification();
});

test("the executable identity follows the resolved file, not the command text", () => {
  const dir = tempDir();
  try {
    const bin = join(dir, "codex");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const first = codexExecutableIdentity("codex", { PATH: dir });
    assert.ok(first);
    writeFileSync(bin, "#!/bin/sh\necho replaced\n");
    assert.notEqual(codexExecutableIdentity("codex", { PATH: dir }), first);
    assert.equal(codexExecutableIdentity("codex", { PATH: join(dir, "nowhere") }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------------------------------------------
 * The whole decision.
 * ------------------------------------------------------------------------------------------ */

const proven = (async () => ({ ok: true })) as never;
const decisionBase = {
  command: "codex", args: ["--json"], legacy: { kind: "explicit", permissionMode: "auto-review" } as const,
  cwd: "/repo", env: {}, nativeHostLaunch: true, platform: "linux" as const,
};

test("an approval-capable mode keeps its legacy launch, and is never even probed for it", async () => {
  // Every mode that can migrate can also approve an escalation, and the deny would leave that
  // approval without network access (#1464). Nothing migrates on codex-cli 0.155.1, and a withheld
  // launch spawns no proof, so its timing is what it was before #1336 slice 2 too.
  for (const legacy of [
    { kind: "explicit", permissionMode: "auto-review" },
    { kind: "explicit", permissionMode: "on-request" },
    { kind: "explicit", permissionMode: "read-only" },
    // A TUI and a resumed `codex exec` turn ran under Codex's own approval-capable default.
    { kind: "implicit" },
  ] as const) {
    let probed = false;
    const decision = await decideCodexPermissionProfile(
      { ...decisionBase, legacy, hookStateDir: HOOK_DIR },
      (async () => { probed = true; return { ok: true }; }) as never,
    );
    const label = JSON.stringify(legacy);
    assert.equal(decision.active, false, label);
    assert.match((decision as { reason: string }).reason, /without network access/, label);
    assert.equal(probed, false, label);
  }
});

test("no directory, an unmigrated mode, or a defeating flag each keeps the legacy launch", async () => {
  for (const [label, input, prove, pattern] of [
    ["no directory", { ...decisionBase, hookStateDir: undefined }, proven, /hook state directory/],
    ["unmigrated mode", { ...decisionBase, legacy: { kind: "explicit", permissionMode: "danger-full-access" }, hookStateDir: HOOK_DIR }, proven, /no equivalent profile/],
    ["defeating flag", { ...decisionBase, args: ["-s", "workspace-write"], hookStateDir: HOOK_DIR }, proven, /defeat a permission profile/],
    // Each of these still names its OWN cause rather than the escalation gate that now follows
    // them all, so a launch that stayed put is still diagnosable from its reason. A failed proof
    // is covered against `provenCodexPermissionProfile` directly instead, because the escalation
    // gate settles every launch before the proof is reached.
  ] as const) {
    const decision = await decideCodexPermissionProfile(input as never, prove);
    assert.equal(decision.active, false, label);
    assert.match((decision as { reason: string }).reason, pattern, label);
  }
});

test("a launch that does not run the host binary directly is never proven from the host", async () => {
  // Review finding CR-1.3: a WSL, container, cloud, or runner-sandboxed launch resolves a different
  // binary and filesystem, so a host-side proof would say nothing about it.
  let probed = false;
  const decision = await decideCodexPermissionProfile(
    { ...decisionBase, hookStateDir: HOOK_DIR, nativeHostLaunch: false },
    (async () => { probed = true; return { ok: true }; }) as never,
  );
  assert.equal(decision.active, false);
  // Named by its own cause, not by the escalation gate that would refuse it anyway.
  assert.match((decision as { reason: string }).reason, /not a native host launch/);
  assert.equal(probed, false);
});

test("the deny is only claimed on Linux, the one platform it was measured on", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const decision = await decideCodexPermissionProfile({ ...decisionBase, hookStateDir: HOOK_DIR, platform }, proven);
    assert.equal(decision.active, false, platform);
    assert.match((decision as { reason: string }).reason, new RegExp(platform), platform);
  }
});

/* ---------------------------------------------------------------------------------------------
 * Round-3 review findings.
 * ------------------------------------------------------------------------------------------ */

test("a projection command that exits without reading its input does not crash the runner", async () => {
  // Review finding CR-3.1: the initialize write to a process that has already exited raised an
  // unhandled EPIPE 'error' event, which terminates the whole runner. A real process, on purpose.
  const result = await readCodexSandboxProjection({ command: "/bin/false", args: [], cwd: tmpdir(), env: process.env });
  assert.equal(result.ok, false);
});

test("a projection failure carries the command's own stderr", async () => {
  // Review finding CR-3.4: stderr is drained (a full pipe would stall the reply) and quoted.
  const result = await readCodexSandboxProjection({
    command: "/bin/sh", args: ["-c", "echo 'config parse error' >&2; exit 3", "probe"], cwd: tmpdir(), env: process.env,
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /config parse error/);
});

test("a probe's whole process tree is gone when it settles", async () => {
  // Review finding CR-3.5: the configured command may be a wrapper that starts the real codex as a
  // child without exec. Killing only the wrapper would leak one app-server per proof.
  const dir = tempDir();
  try {
    const wrapper = join(dir, "codex-wrapper");
    const pidFile = join(dir, "child.pid");
    writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(wrapper, 0o755);
    const result = await readCodexSandboxProjection({ command: wrapper, args: [], cwd: dir, env: process.env }, undefined, 500);
    assert.equal(result.ok, false);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), "the wrapper's own child was killed with it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launch arguments that move the configuration's directory keep the legacy launch", async () => {
  // Review finding CR-3.2: `-C`/`--cd` changes where project-scoped configuration resolves, while
  // the proof reads the session's own directory; `--remote` and `--worktree` run elsewhere.
  for (const args of [
    ["-C", "/elsewhere"], ["--cd", "/elsewhere"], ["--cd=/elsewhere"], ["-C/elsewhere"],
    ["--remote", "ws://host:1"], ["--remote=ws://host:1"], ["--worktree"],
  ]) {
    let probed = false;
    const decision = await decideCodexPermissionProfile(
      { ...decisionBase, args, hookStateDir: HOOK_DIR },
      (async () => { probed = true; return { ok: true }; }) as never,
    );
    assert.equal(decision.active, false, args.join(" "));
    assert.equal(probed, false, args.join(" "));
  }
  // A lowercase -c is a config override, not a directory, so it gets past this check and is
  // refused later for the escalation it would cost rather than for its arguments.
  const config = await decideCodexPermissionProfile({ ...decisionBase, args: ["-c", "model=\"o3\""], hookStateDir: HOOK_DIR }, proven);
  assert.equal(config.active, false);
  assert.match((config as { reason: string }).reason, /without network access/);
});
