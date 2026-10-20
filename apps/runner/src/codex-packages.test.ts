import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { configuredCodexHomes, sessionWritableRoots, trustedPath } from "./review-trust.js";
import { verifySpawnedCommand } from "./review-sessions.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import { buildBwrapArgs } from "./spawn.js";

const posixOnly = { skip: process.platform === "win32" };

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-codex-packages-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const packages = join(codexHome, "packages");
  const standalone = join(packages, "standalone");
  const release = join(standalone, "releases", "version", "bin");
  const bin = join(home, ".local", "bin");
  mkdirSync(release, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "state"));
  const binary = join(release, "codex");
  writeFileSync(binary, "a native binary fixture", { mode: 0o700 });
  symlinkSync("releases/version", join(standalone, "current"));
  const command = join(bin, "codex");
  symlinkSync(join(standalone, "current", "bin", "codex"), command);
  return { root, home, codexHome, packages, standalone, binary, bin, command };
}

test("the standalone reviewer needs proof; every other writable root and ownership check still applies", posixOnly, (t) => {
  const f = fixture(t);
  const roots = sessionWritableRoots(f.home, join(f.root, "state"), [], []);
  const uid = process.getuid!();
  const rootUid = statSync("/").uid;
  const proof = { home: f.home };
  assert.throws(() => verifySpawnedCommand(f.command, f.bin, roots, uid, rootUid), /a session can write/);
  assert.equal(verifySpawnedCommand(f.command, f.bin, roots, uid, rootUid, proof), f.binary);
  assert.equal(verifySpawnedCommand("codex", f.bin, roots, uid, rootUid, proof), f.binary);
  assert.throws(() => verifySpawnedCommand(f.command, f.bin, roots, uid, rootUid,
    { ...proof, refusal: "Codex packages are unprotected from session s_unsafe" }), /session s_unsafe/);
  for (const extra of [f.home, f.packages, f.standalone, join(f.standalone, "releases"), f.root]) {
    assert.throws(() => verifySpawnedCommand(f.command, f.bin, [...roots, extra], uid, rootUid, proof), /a session can write/);
  }
  for (const path of [join(f.codexHome, "other"), join(f.packages, "other")]) {
    writeFileSync(path, "planted", { mode: 0o700 });
    assert.throws(() => trustedPath(path, roots, uid, rootUid, proof), /a session can write/);
  }
  symlinkSync(f.binary, join(f.codexHome, "shortcut"));
  assert.throws(() => trustedPath(join(f.codexHome, "shortcut"), roots, uid, rootUid, proof), /a session can write/);
  chmodSync(f.binary, 0o777);
  assert.throws(() => verifySpawnedCommand(f.command, f.bin, roots, uid, rootUid, proof), /writable by every user/);
});

test("all configured HOME, CODEX_HOME and account homes are inventoried across harnesses", posixOnly, () => {
  const homes = configuredCodexHomes("/host", {
    hostEnv: { HOME: "/host-home", CODEX_HOME: "/host-codex", AGENT_CODEX: "/agent-codex" },
    agents: [{ id: "claude", env: { HOME: "/agent-home", CODEX_HOME: { fromEnv: "AGENT_CODEX" } } }],
    providerAccounts: [{ directory: "/account" }],
    sessions: [{ env: { HOME: "/session-home", CODEX_HOME: "/session-codex" },
      providerCredentialHome: "/credential", providerConversationHome: "/conversation",
      pendingProviderCredentialHome: "/pending" } as unknown as SessionMeta],
  });
  assert.deepEqual(new Set(homes), new Set([
    "/host/.codex", "/host-home/.codex", "/host-codex", "/agent-home/.codex", "/agent-codex", "/account",
    "/session-home/.codex", "/session-codex", "/credential", "/conversation", "/pending",
  ]));
});

for (const mode of ["bwrap", "seatbelt"] as const) {
  test(`${mode} protects default and configured packages after all writable grants, for every harness`, posixOnly, async (t) => {
    const f = fixture(t);
    const otherHome = join(f.root, "account");
    const otherPackages = join(otherHome, "packages");
    mkdirSync(otherPackages, { recursive: true });
    for (const driver of ["codex-app-server", "claude-code", "pi", "acp"] as const) {
      const isolation = await resolveExecutionIsolation({ mode, network: "inherit" }, { kind: "native" }, {
        platform: mode === "bwrap" ? "linux" : "darwin", uid: () => 1000,
        nativeHome: () => f.home, nativeEnvironment: () => ({}), nativeTmp: () => f.root,
        resolveNative: async () => ({ path: "/bin/boundary", via: "path", launch: { command: "/bin/boundary", args: [] } }),
      }, {
        driver, dataDir: join(f.root, "state"), env: { HOME: f.home, CODEX_HOME: f.codexHome },
        sessionId: "s_protected", cwd: f.root, additionalWritableRoots: [f.codexHome, otherHome], codexHomes: [otherHome],
      });
      assert.ok(isolation?.backend === mode);
      if (isolation.backend === "bwrap") {
        assert.deepEqual(isolation.readOnlyBinds, [f.packages, otherPackages]);
        const args = buildBwrapArgs({ cwd: f.root, command: "codex", args: [] }, isolation);
        assert.ok(args.lastIndexOf("--ro-bind") > args.lastIndexOf("--bind"));
        const index = args.indexOf(f.packages);
        assert.deepEqual(args.slice(index - 1, index + 5),
          ["--ro-bind", f.packages, f.packages, "--ro-bind", otherPackages, otherPackages]);
      } else if (isolation.backend === "seatbelt") {
        assert.deepEqual(isolation.readOnlyPaths, [f.packages, otherPackages]);
        const deny = isolation.profile.indexOf("(deny file-write*");
        assert.ok(deny > isolation.profile.indexOf(`(subpath "${f.codexHome}")`));
        for (const path of [f.packages, otherPackages]) {
          assert.ok(isolation.profile.slice(deny).includes(`(literal "${path}")`));
          assert.ok(isolation.profile.slice(deny).includes(`(subpath "${path}")`));
        }
        const pins = isolation.profile.slice(isolation.profile.indexOf("(deny file-write-unlink"));
        for (const path of [f.codexHome, f.home, f.root, otherHome]) {
          assert.ok(pins.includes(`(literal "${path}")`), "package ancestors cannot be renamed out of the deny rule");
        }
      }
    }
  });
}

test("a package alias protects its target without making the replaceable link trusted", posixOnly, async (t) => {
  const f = fixture(t);
  rmSync(f.packages, { recursive: true });
  mkdirSync(join(f.root, "elsewhere"));
  symlinkSync(join(f.root, "elsewhere"), f.packages);
  const isolation = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {
    platform: "linux", uid: () => 1000, nativeHome: () => f.home, nativeEnvironment: () => ({}),
    resolveNative: async () => ({ path: "/bin/bwrap", via: "path", launch: { command: "/bin/bwrap", args: [] } }),
  }, { driver: "claude-code", dataDir: f.root, env: { HOME: f.home }, sessionId: "s1", cwd: f.root });
  assert.ok(isolation?.backend === "bwrap");
  assert.deepEqual(isolation.readOnlyBinds, [join(f.root, "elsewhere")]);
  assert.throws(() => trustedPath(f.command, [f.codexHome], process.getuid!(), statSync("/").uid, { home: f.home }),
    /a session can write/);
});

test("foreign or traversal-containing installation hints do not fail unrelated Linux launches", posixOnly, async () => {
  const isolation = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {
    platform: "linux", uid: () => 1000, nativeHome: () => "C:\\Users\\fixture", nativeEnvironment: () => ({}),
    existsNative: async () => false,
    resolveNative: async () => ({ path: "/bin/bwrap", via: "path", launch: { command: "/bin/bwrap", args: [] } }),
  }, { driver: "acp", dataDir: "/state", env: {}, sessionId: "s1", cwd: "/work", codexHomes: ["/a/../b"] });
  assert.equal(isolation?.backend, "bwrap");
});

test("reviewer admission names each unprotected writer and requires exact live launch proof", posixOnly, (t) => {
  const f = fixture(t);
  const store = new SessionStore(join(f.root, "sessions"));
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, f.root,
    undefined, undefined, undefined, undefined, { mode: "bwrap", network: "inherit" });
  t.after(() => manager.shutdownAll());
  const active = (manager as unknown as { active: Map<string, unknown> }).active;
  const id = "s_writer";
  const makeMeta = (driver: SessionMeta["driver"]) => ({
    sessionId: id, agentId: "fixture", workspaceId: "fixture", driver, context: { kind: "native" }, env: {}, repoPath: f.root, worktreePath: null,
    status: "idle", title: "writer", config: {}, args: [], command: "fixture", agentSessionId: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  }) as SessionMeta;
  for (const driver of ["codex-app-server", "claude-code", "pi", "acp"] as const) {
    store.create(makeMeta(driver));
    active.set(id, { codexPackageReadOnlyPaths: [] });
    assert.match(manager.codexReviewerProtection(f.home).refusal!, /session s_writer/);
    active.set(id, { codexPackageReadOnlyPaths: [f.packages] });
    assert.equal(manager.codexReviewerProtection(f.home).refusal, undefined);
    active.delete(id);
    store.patchMeta(id, { status: "starting" });
    assert.match(manager.codexReviewerProtection(f.home).refusal!, /session s_writer/);
    store.patchMeta(id, { status: "idle" });
  }
  assert.equal(store.acquireWorktreeLease(id, "other-runner"), true);
  assert.match(manager.codexReviewerProtection(f.home).refusal!, /session s_writer/,
    "an idle provider owned by another manager has no attested boundary here");
  store.releaseWorktreeLease(id, "other-runner");
  const providerManager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, f.root);
  t.after(() => providerManager.shutdownAll());
  assert.equal(providerManager.codexReviewerProtection(f.home).refusal, undefined,
    "future unisolated launches do not block admission when there is no live unprotected writer");
});
