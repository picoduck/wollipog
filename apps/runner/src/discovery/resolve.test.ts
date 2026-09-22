import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { isProjectLocalExecutable, launchForVersionManagerHit, launchTargetStillMatches, pickWindowsExecutable, resolveNativeCandidates, resolvedLaunchIdentity, run, sortVersionsDesc, wslCandidateScanArgs, wslInspectArgs, wslVersionManagerArgs } from "./resolve.js";
import { interpretCodexAppServerProbe } from "./codex-app-server.js";

test("run preserves a string execFile error code for retryable spawn diagnostics", async () => {
  const result = await run("__wollipog_command_that_does_not_exist__", [], { timeoutMs: 1000 });
  assert.equal(result.code, 1);
  assert.equal(result.errorCode, "ENOENT");
});

test("run distinguishes actual timeouts from max-buffer termination", async () => {
  const timeout = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 25 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.errorCode, undefined);

  const overflow = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { maxBuffer: 32 });
  assert.equal(overflow.timedOut, undefined);
  assert.equal(overflow.errorCode, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(interpretCodexAppServerProbe("0.147.0", overflow).failure?.code, "probe_failed");
});

test("sortVersionsDesc: numeric semver order, not lexicographic", () => {
  assert.deepEqual(sortVersionsDesc(["v9.0.0", "v25.2.1", "v10.1.0"]), ["v25.2.1", "v10.1.0", "v9.0.0"]);
  assert.deepEqual(sortVersionsDesc(["20.11.1", "20.9.0"]), ["20.11.1", "20.9.0"]); // no leading v
  assert.deepEqual(sortVersionsDesc(["v1.0.0", "junk", "v2.0.0"]), ["v2.0.0", "v1.0.0", "junk"]); // non-semver sinks
  assert.deepEqual(sortVersionsDesc([]), []);
});

test("Windows resolution prefers executable shims over adjacent POSIX scripts", () => {
  assert.equal(pickWindowsExecutable("C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n"), "C:\\npm\\claude.cmd");
  assert.equal(pickWindowsExecutable("C:\\tools\\codex.exe\r\nC:\\tools\\codex.cmd"), "C:\\tools\\codex.exe");
  assert.equal(pickWindowsExecutable(""), null);
});

test("an SSH runner started in home keeps user-local installations while rejecting project wrappers", () => {
  const home = join(tmpdir(), "wollipog-home");
  const project = join(home, "project");
  assert.equal(isProjectLocalExecutable(join(home, ".local", "bin", "codex"),
    join(home, ".local", "bin", "codex"), home, home), false);
  assert.equal(isProjectLocalExecutable(join(project, "node_modules", ".bin", "codex"),
    join(project, "bin", "codex"), home, home), true);
  assert.equal(isProjectLocalExecutable(join(project, "node_modules", ".bin", "codex"),
    join(project, "bin", "codex"), project, home), true);
});

test("native discovery keeps system and user installations distinct across PATH reordering and deduplicates aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-harnesses-"));
  const system = join(root, "system");
  const user = join(root, "user");
  const alias = join(root, "alias");
  const oldPath = process.env.PATH;
  const fileName = platform() === "win32" ? "fakeharness.cmd" : "fakeharness";
  try {
    for (const dir of [system, user, alias]) mkdirSync(dir);
    for (const [dir, version] of [[system, "1"], [user, "2"]] as const) {
      const file = join(dir, fileName);
      writeFileSync(file, platform() === "win32" ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\necho ${version}\n`);
      chmodSync(file, 0o755);
    }
    symlinkSync(join(user, fileName), join(alias, fileName));
    process.env.PATH = [system, alias, user, oldPath ?? ""].join(delimiter);
    const first = (await resolveNativeCandidates("fakeharness")).filter((entry) => entry.path.startsWith(root));
    assert.equal(first.length, 2);
    assert.equal(first[0]!.path, join(system, fileName));
    process.env.PATH = [user, system, alias, oldPath ?? ""].join(delimiter);
    const reordered = (await resolveNativeCandidates("fakeharness")).filter((entry) => entry.path.startsWith(root));
    assert.equal(reordered.length, 2);
    assert.deepEqual(first.map(resolvedLaunchIdentity).sort(), reordered.map(resolvedLaunchIdentity).sort());
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an upgraded symlink keeps its installation entry point but needs rediscovery before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-harness-upgrade-"));
  const bin = join(root, "bin");
  const v1 = join(root, "v1");
  const v2 = join(root, "v2");
  const name = platform() === "win32" ? "fakeharness.cmd" : "fakeharness";
  const oldPath = process.env.PATH;
  try {
    for (const dir of [bin, v1, v2]) mkdirSync(dir);
    for (const dir of [v1, v2]) {
      const file = join(dir, name);
      writeFileSync(file, platform() === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    const entry = join(bin, name);
    symlinkSync(join(v1, name), entry);
    process.env.PATH = [bin, oldPath ?? ""].join(delimiter);
    const before = (await resolveNativeCandidates("fakeharness")).find((candidate) => candidate.path === entry)!;
    assert.equal(before.launch.command, entry);
    const originalTarget = resolvedLaunchIdentity(before);
    assert.equal(launchTargetStillMatches(before.launch, { kind: "native" }, originalTarget), true);
    rmSync(entry);
    symlinkSync(join(v2, name), entry);
    assert.equal(launchTargetStillMatches(before.launch, { kind: "native" }, originalTarget), false);
    const after = (await resolveNativeCandidates("fakeharness")).find((candidate) => candidate.path === entry)!;
    assert.deepEqual(after.launch, before.launch);
    assert.notEqual(resolvedLaunchIdentity(after), originalTarget);
    assert.equal(launchTargetStillMatches(after.launch, { kind: "native" }, resolvedLaunchIdentity(after)), true);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a WSL launch checks its pinned target without starting the distribution synchronously", () => {
  const launch = { command: "/opt/codex/v1/bin/codex", args: [] };
  const context = { kind: "wsl" as const, distro: "Ubuntu" };
  assert.equal(launchTargetStillMatches(launch, context, JSON.stringify([launch.command])), true);
  assert.equal(launchTargetStillMatches(launch, context, JSON.stringify(["/opt/codex/v2/bin/codex"])), false);
});

test("launchForVersionManagerHit: node scripts wrap, real binaries run direct", () => {
  const node = "/h/.nvm/versions/node/v25.2.1/bin/node";
  const shim = "/h/.nvm/versions/node/v25.2.1/bin/codex";

  // npm shim: symlink resolves to a .js entry — wrap with the sibling node.
  const js = launchForVersionManagerHit(shim, "/h/.nvm/.../codex/bin/codex.js", "#!/usr/bin/env node", node);
  assert.deepEqual(js, { command: node, args: [shim] });

  // extension-less script with a node shebang still wraps.
  const shebang = launchForVersionManagerHit(shim, "/h/lib/codex-entry", "#!/usr/bin/env node", node);
  assert.equal(shebang.command, node);

  // a real (ELF) binary runs directly — garbage first line, no .js extension.
  const bin = launchForVersionManagerHit(shim, shim, "ELF...", node);
  assert.deepEqual(bin, { command: shim, args: [] });

  // node script but no sibling node available — fall back to direct (best effort).
  const noNode = launchForVersionManagerHit(shim, "/h/lib/codex.js", "#!/usr/bin/env node", null);
  assert.deepEqual(noNode, { command: shim, args: [] });
});

test("wslVersionManagerArgs: name rides as a positional arg, never inside the script", () => {
  const hostile = 'codex"; rm -rf ~; echo "';
  const args = wslVersionManagerArgs("Ubuntu-24.04", hostile);
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu-24.04", "--exec", "sh", "-c"]);
  const script = args[5]!;
  assert.ok(!script.includes(hostile), "name never interpolated into the script");
  assert.ok(script.includes('"$d/$1"'), "name consumed as $1");
  assert.ok(script.includes("sort -rV"), "newest version first");
  assert.ok(script.includes(".nvm/versions/node") && script.includes("fnm/node-versions"), "scans nvm + fnm");
  assert.equal(args[6], "sh"); // $0 placeholder
  assert.equal(args[7], hostile);
});

test("WSL scan finds a user-local executable even when non-login PATH finds system first",
  { skip: platform() === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-scan-"));
  const system = join(root, "system");
  const local = join(root, ".local", "bin");
  try {
    mkdirSync(system);
    mkdirSync(local, { recursive: true });
    for (const dir of [system, local]) {
      const file = join(dir, "fakeharness");
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    const args = wslCandidateScanArgs("Ubuntu", "fakeharness");
    assert.match(args[5]!, /sort -rV/, "version-manager candidates remain newest-first");
    const scanned = await run("/bin/sh", args.slice(4), {
      env: { HOME: root, PATH: [system, "/usr/bin", "/bin"].join(delimiter) },
    });
    assert.equal(scanned.code, 0, scanned.stderr);
    assert.ok(scanned.stdout.includes(`path\t${system}/fakeharness`));
    assert.ok(scanned.stdout.includes(`common-dir\t${local}/fakeharness`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wslInspectArgs: the inspected path rides as a positional arg, never inside the script", () => {
  const hostile = "/home/u/.nvm/versions/node/v20.0.0/bin/$(rm -rf ~)/codex";
  const args = wslInspectArgs("Ubuntu", hostile);
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "--exec", "sh", "-c"]);
  assert.ok(!args[5]!.includes(hostile), "path never interpolated into the script");
  assert.ok(args[5]!.includes('"$1"'), "path consumed as $1");
  assert.ok(args[5]!.includes("readlink -f"), "resolves the exact hit, not a scan");
  assert.equal(args[6], "sh"); // $0 placeholder
  assert.equal(args[7], hostile);
});
