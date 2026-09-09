import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  WSL_BWRAP_LAUNCHER_SOURCE_PATH,
  buildWslBwrapLaunchArgs,
  buildWslBwrapPrepareArgs,
  parseWslBwrapPreparation,
  wslBwrapSessionRoot,
} from "./wsl-bwrap-launcher.js";

const haveCompiler = process.platform === "linux" &&
  spawnSync("cc", ["--version"], { stdio: "ignore" }).status === 0 && (() => {
    try {
      const stat = statSync("/usr/bin/bwrap");
      const help = spawnSync("/usr/bin/bwrap", ["--help"], { encoding: "utf8" });
      return stat.uid === 0 && (stat.mode & 0o022) === 0 && help.status === 0 &&
        ["--bind-fd", "--ro-bind-fd"].every((flag) => `${help.stdout}${help.stderr}`.includes(flag));
    } catch { return false; }
  })();

function fixture(): { root: string; launcher: string; home: string; cwd: string; source: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-bwrap-launcher-"));
  const launcher = join(root, "launcher");
  const compiled = spawnSync("cc", [
    "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIE", "-pie",
    "-Wl,-z,relro", "-Wl,-z,now", "-Wl,-z,noexecstack",
    "-o", launcher, WSL_BWRAP_LAUNCHER_SOURCE_PATH,
  ], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const source = join(root, "state");
  const target = join(home, ".codex", "sessions");
  mkdirSync(home); mkdirSync(cwd); mkdirSync(source);
  return { root, launcher, home, cwd, source, target };
}

test("WSL launcher preparation decoder accepts only the fixed bounded ABI", () => {
  const valid = JSON.stringify({
    version: 1,
    cwd: { path: "/work/tree", identity: "1:2:3" },
    home: { path: "/home/me", identity: "4:5:6" },
    binds: [{
      mode: "rw",
      source: { path: "/state", identity: "7:8:9" },
      target: { path: "/home/me/.codex/sessions", identity: "a:b:c" },
    }],
  });
  assert.deepEqual(parseWslBwrapPreparation(valid), JSON.parse(valid));
  assert.throws(() => parseWslBwrapPreparation(JSON.stringify({ ...JSON.parse(valid), extra: true })), /unsupported schema/);
  assert.throws(() => parseWslBwrapPreparation(JSON.stringify({ ...JSON.parse(valid), cwd: { path: "/a/../b", identity: "1:2:3" } })), /traversal-free/);
  assert.throws(() => parseWslBwrapPreparation(JSON.stringify({ ...JSON.parse(valid), home: { path: "/home/me", identity: "not-an-id" } })), /identity/);
});

test("WSL launcher argv keeps paths and provider arguments as native boundaries", () => {
  const prepare = buildWslBwrapPrepareArgs({
    bwrap: "/usr/bin/bwrap", home: "/home/user name", cwd: "/work/a b",
    ensure: ["/state/one"], binds: [{ mode: "rw", source: "/state/one", target: "/home/user name/.codex/sessions" }],
  });
  assert.deepEqual(prepare.slice(0, 7), [
    "prepare", "--bwrap", "/usr/bin/bwrap", "--home", "/home/user name", "--cwd", "/work/a b",
  ]);
  const preparation = parseWslBwrapPreparation(JSON.stringify({
    version: 1,
    cwd: { path: "/work/a b", identity: "1:2:3" },
    home: { path: "/home/user name", identity: "4:5:6" },
    binds: [{ mode: "rw", source: { path: "/state/one", identity: "7:8:9" },
      target: { path: "/home/user name/.codex/sessions", identity: "a:b:c" } }],
  }));
  const launch = buildWslBwrapLaunchArgs({
    distro: "Ubuntu Dev", bwrap: "/usr/bin/bwrap", preparation,
    network: "deny", pidfile: "/tmp/wlp.pgid", command: "/usr/bin/provider",
    args: ["value with spaces", "$(not-code)", "line one\nline two"],
  });
  assert.deepEqual(launch.slice(0, 5), ["-d", "Ubuntu Dev", "--cd", "/work/a b", "--exec"]);
  assert.deepEqual(launch.slice(-4), ["/usr/bin/provider", "value with spaces", "$(not-code)", "line one\nline two"]);
});

test("target launcher securely prepares paths and rejects symlinked ancestors", { skip: !haveCompiler }, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const args = buildWslBwrapPrepareArgs({
    bwrap: "/usr/bin/bwrap", home: f.home, cwd: f.cwd,
    ensure: [f.target], binds: [{ mode: "rw", source: f.source, target: f.target }],
  });
  const prepared = spawnSync(f.launcher, args, { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const plan = parseWslBwrapPreparation(prepared.stdout);
  assert.equal(plan.cwd.path, f.cwd);
  assert.equal(plan.binds[0]?.target.path, f.target);

  const protectedRoot = join(f.root, "protected");
  mkdirSync(protectedRoot);
  const alias = join(f.root, "alias");
  symlinkSync(protectedRoot, alias, "dir");
  const escaped = join(alias, "escaped");
  const rejected = spawnSync(f.launcher, buildWslBwrapPrepareArgs({
    bwrap: "/usr/bin/bwrap", home: f.home, cwd: alias, ensure: [escaped],
  }), { encoding: "utf8" });
  assert.equal(rejected.status, 125);
  assert.match(rejected.stderr, /cannot securely create directory|cannot securely resolve cwd/);
  assert.equal(spawnSync("test", ["-e", join(protectedRoot, "escaped")]).status, 1);
});

test("target launcher refuses a prepare-to-launch directory replacement", { skip: !haveCompiler }, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  mkdirSync(f.target, { recursive: true });
  const prepared = spawnSync(f.launcher, buildWslBwrapPrepareArgs({
    bwrap: "/usr/bin/bwrap", home: f.home, cwd: f.cwd,
    binds: [{ mode: "rw", source: f.source, target: f.target }],
  }), { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const plan = parseWslBwrapPreparation(prepared.stdout);
  renameSync(f.cwd, `${f.cwd}-original`);
  mkdirSync(f.cwd);
  const wslArgs = buildWslBwrapLaunchArgs({
    distro: "fixture", launcher: f.launcher, bwrap: "/usr/bin/bwrap", preparation: plan,
    network: "inherit", pidfile: join(f.root, "provider.pgid"), command: "/bin/true", args: [],
  });
  const directArgs = wslArgs.slice(wslArgs.indexOf("launch"));
  const launched = spawnSync(f.launcher, directArgs, { cwd: f.cwd, encoding: "utf8" });
  assert.equal(launched.status, 125);
  assert.match(launched.stderr, /cwd identity changed/);
});

test("checked-in launcher source stays available to source-checkout provisioning", () => {
  const source = readFileSync(WSL_BWRAP_LAUNCHER_SOURCE_PATH, "utf8");
  assert.match(source, /RESOLVE_NO_SYMLINKS/);
  assert.match(source, /ready_entry\(ready_fd, "control\.sock", S_IFSOCK\)/,
    "provider launch waits against the already-opened relay bind source");
  assert.doesNotMatch(source, /"--sync-fd"/,
    "no filesystem-authority descriptor is inherited by the bwrap init process");
});

test("target launcher rejects singleton flags without values", { skip: process.platform !== "linux" }, (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const option of ["--bwrap", "--home", "--cwd", "--pidfile", "--network"]) {
    const rejected = spawnSync(f.launcher, ["launch", option], { encoding: "utf8" });
    assert.equal(rejected.status, 125, `${option} fails closed instead of dereferencing argv[argc]`);
  }
});

test("target-local state roots contain only fixed prefixes and full hashes", () => {
  const owner = "a".repeat(64);
  const session = "b".repeat(64);
  assert.equal(wslBwrapSessionRoot(owner, session),
    `/var/lib/wollipog-wsl-launcher/runner-instances/${owner}/sessions/${session}`);
  for (const value of ["", "../escape", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}/x`]) {
    assert.throws(() => wslBwrapSessionRoot(value, session), /hashed owner/);
    assert.throws(() => wslBwrapSessionRoot(owner, value), /hashed owner/);
  }
});
