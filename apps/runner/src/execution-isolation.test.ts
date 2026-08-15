import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSeatbeltProfile,
  cloneExecutionIsolationState,
  migrateExecutionIsolationState,
  adoptLegacyWslExecutionIsolationState,
  parseWslIsolationProbe,
  providerStateKey,
  removeExecutionIsolationState,
  resolveExecutionIsolation,
  verifyExecutionIsolationForkState,
} from "./execution-isolation.js";

const provider = { mode: "provider" as const, network: "inherit" as const };
const bwrap = { mode: "bwrap" as const, network: "deny" as const };

test("native macOS and Windows policies resolve only their audited platform adapters", async () => {
  const state = {
    driver: "claude-code" as const,
    dataDir: "/Users/me/Library/Application Support/Wollipog",
    env: {},
    sessionId: "s1",
    cwd: "/Users/me/Work/repo",
  };
  const macCreated: string[][] = [];
  const seatbelt = await resolveExecutionIsolation(
    { mode: "seatbelt", network: "deny" }, { kind: "native" }, {
      platform: "darwin",
      nativeHome: () => "/Users/me",
      nativeTmp: () => "/private/var/folders/tmp",
      realpathNative: async (path) => path.endsWith("/.claude/projects") ? "/Volumes/provider-state/claude/projects" : path,
      mkdirNative: async (paths) => { macCreated.push(paths); },
      resolveNative: async (name) => name === "sandbox-exec" ? {
        path: "/usr/bin/sandbox-exec", via: "path", launch: { command: "/usr/bin/sandbox-exec", args: [] },
      } : null,
    }, state,
  );
  assert.equal(seatbelt?.backend, "seatbelt");
  assert.match(seatbelt?.backend === "seatbelt" ? seatbelt.profile : "", /\(deny default\)/);
  assert.match(seatbelt?.backend === "seatbelt" ? seatbelt.profile : "", /Users\/me\/Work\/repo/);
  assert.doesNotMatch(seatbelt?.backend === "seatbelt" ? seatbelt.profile : "", /allow network/);
  assert.doesNotMatch(seatbelt?.backend === "seatbelt" ? seatbelt.profile : "", /allow mach/);
  assert.match(seatbelt?.backend === "seatbelt" ? seatbelt.profile : "", /Volumes\/provider-state\/claude\/projects/);
  assert.deepEqual(macCreated, [["/Users/me/.claude/projects"]]);

  const windows = await resolveExecutionIsolation(
    { mode: "windows-job", network: "inherit" }, { kind: "native" }, {
      platform: "win32",
      resolveNative: async (name) => name === "powershell" ? {
        path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        via: "path",
        launch: { command: "powershell.exe", args: [] },
      } : null,
    }, { ...state, dataDir: "C:\\Wollipog", cwd: "C:\\repo" },
  );
  assert.equal(windows?.backend, "windows-job");
  assert.ok(windows?.args.includes("-EncodedCommand"));

  await assert.rejects(() => resolveExecutionIsolation(
    { mode: "seatbelt", network: "inherit" }, { kind: "native" }, { platform: "win32" }, state,
  ), /requires native macOS/);
  await assert.rejects(() => resolveExecutionIsolation(
    { mode: "windows-job", network: "inherit" }, { kind: "wsl", distro: "Ubuntu" }, { platform: "win32" }, state,
  ), /native-host only.*require bwrap/);
});

test("Seatbelt profile escapes paths and limits its writable surface", () => {
  const profile = buildSeatbeltProfile({
    driver: "codex-app-server",
    dataDir: '/Users/me/Library/Application Support/Wollipog "state"',
    env: { HOME: "/Users/me" },
    sessionId: "s1",
    cwd: "/Users/me/repo",
  }, "/Users/me", "inherit", "/private/var/folders/tmp");
  assert.match(profile, /allow network/);
  assert.match(profile, /\\"state\\"/);
  assert.match(profile, /\/Users\/me\/\.codex\/sessions/);
  assert.throws(() => buildSeatbeltProfile({
    driver: "acp", dataDir: "/data", env: {}, sessionId: "s1", cwd: "/repo\nallow default",
  }, "/Users/me", "deny"), /control-free POSIX path/);
});

test("provider isolation preserves the driver-owned boundary", async () => {
  assert.equal(await resolveExecutionIsolation(provider, { kind: "native" }, {
    platform: "win32",
    uid: () => undefined,
    resolveNative: async () => { throw new Error("must not probe"); },
    resolveWsl: async () => { throw new Error("must not probe"); },
  }), undefined);
});

test("bwrap resolves in the exact native or WSL process namespace", async () => {
  const native = await resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux",
    uid: () => 1000,
    resolveNative: async () => ({
      path: "/usr/bin/bwrap",
      via: "path",
      launch: { command: "/usr/bin/bwrap", args: ["--launcher-prefix"] },
    }),
    resolveWsl: async () => null,
  });
  assert.deepEqual(native, {
    backend: "bwrap", command: "/usr/bin/bwrap", args: ["--launcher-prefix"], network: "deny",
  });
  const wsl = await resolveExecutionIsolation(bwrap, { kind: "wsl", distro: "Ubuntu" }, {
    platform: "win32",
    uid: () => undefined,
    resolveNative: async () => null,
    resolveWsl: async (context) => context.distro === "Ubuntu"
      ? { command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }
      : null,
  });
  assert.deepEqual(wsl, { backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "deny" });
});

test("strict bwrap policy fails closed when the target context cannot provide it", async () => {
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "win32", uid: () => undefined, resolveNative: async () => null, resolveWsl: async () => null,
  }), /requires Linux or WSL.*fail closed/);
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "wsl", distro: "Missing" }, {
    platform: "win32", uid: () => undefined, resolveNative: async () => null, resolveWsl: async () => null,
  }), /required inside WSL distro Missing/);
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000, resolveNative: async () => null, resolveWsl: async () => null,
  }), /bwrap was not found/);
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 0, resolveNative: async () => null, resolveWsl: async () => null,
  }), /refuses a root runner/);
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "wsl", distro: "Rooted" }, {
    platform: "win32", uid: () => undefined, resolveNative: async () => null,
    resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 0, home: "/root" }),
  }), /refuses root execution inside WSL distro Rooted/);
});

test("strict sessions virtualize only Claude/Codex transcript roots under runner data", async () => {
  const sessionKey = providerStateKey("session/../../../host");
  const nativeCreated: string[][] = [];
  const native = await resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000, nativeHome: () => "/home/me",
    resolveNative: async () => ({
      path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
    }),
    mkdirNative: async (paths) => { nativeCreated.push(paths); },
  }, { driver: "claude-code", dataDir: "/var/lib/wollipog", env: {}, sessionId: "session/../../../host", cwd: "/work" });
  assert.deepEqual(native?.writableBinds, [{
    source: `/var/lib/wollipog/provider-state/claude/${sessionKey}/projects`,
    target: "/home/me/.claude/projects",
  }]);
  assert.deepEqual(nativeCreated, [[
    `/var/lib/wollipog/provider-state/claude/${sessionKey}/projects`, "/home/me/.claude/projects",
  ]]);

  const wslCreated: string[][] = [];
  const wsl = await resolveExecutionIsolation(bwrap, { kind: "wsl", distro: "Ubuntu" }, {
    platform: "win32",
    resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
    mkdirWsl: async (_context, paths) => { wslCreated.push(paths); },
  }, { driver: "codex-app-server", dataDir: "C:/ignored-in-wsl", env: { HOME: "/srv/agent" }, sessionId: "session/../../../host", cwd: "/work" });
  assert.deepEqual(wsl?.writableBinds, [{
    source: `/home/me/.agent-manager/provider-state/codex/${sessionKey}/sessions`,
    target: "/srv/agent/.codex/sessions",
  }]);
  assert.deepEqual(wslCreated, [[
    `/home/me/.agent-manager/provider-state/codex/${sessionKey}/sessions`, "/srv/agent/.codex/sessions",
  ]]);

  const acp = await resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000,
    resolveNative: async () => ({
      path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
    }),
  }, { driver: "acp", dataDir: "/var/lib/wollipog", env: {}, sessionId: "s-acp", cwd: "/work" });
  assert.equal(acp?.writableBinds, undefined, "unknown adapter state is never made writable by guessing");

  const codex = await resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000, nativeHome: () => "/home/me",
    resolveNative: async () => ({
      path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
    }),
    mkdirNative: async () => {},
  }, { driver: "codex", dataDir: "/var/lib/wollipog", env: {}, sessionId: "s-codex", cwd: "/work" });
  assert.deepEqual(codex?.writableBinds?.[0], {
    source: `/var/lib/wollipog/provider-state/codex/${providerStateKey("s-codex")}/sessions`,
    target: "/home/me/.codex/sessions",
  });
});

test("isolated provider state clone and cleanup stay inside hashed session partitions", async () => {
  const nativeCopies: unknown[] = [];
  const nativeRemovals: unknown[] = [];
  await cloneExecutionIsolationState(
    bwrap, { kind: "native" }, "codex-app-server", "/var/lib/wollipog", "../source", "../target", {
      copyNative: async (source, target) => { nativeCopies.push({ source, target }); },
    },
  );
  await removeExecutionIsolationState(
    bwrap, { kind: "native" }, "codex-app-server", "/var/lib/wollipog", "../target", {
      removeNative: async (location) => { nativeRemovals.push(location); },
    },
  );
  assert.deepEqual(nativeCopies, [{
    source: {
      root: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../source")}`,
      leaf: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../source")}/sessions`,
    },
    target: {
      root: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../target")}`,
      leaf: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../target")}/sessions`,
    },
  }]);
  assert.deepEqual(nativeRemovals, [{
    root: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../target")}`,
    leaf: `/var/lib/wollipog/provider-state/codex/${providerStateKey("../target")}/sessions`,
  }]);

  const wslCopies: unknown[] = [];
  await cloneExecutionIsolationState(
    bwrap, { kind: "wsl", distro: "Ubuntu" }, "claude-code", "C:/ignored", "source", "target", {
      resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
      copyWsl: async (context, source, target) => { wslCopies.push({ context, source, target }); },
    },
  );
  assert.deepEqual(wslCopies, [{
    context: { kind: "wsl", distro: "Ubuntu" },
    source: {
      root: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("source")}`,
      leaf: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("source")}/projects`,
    },
    target: {
      root: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("target")}`,
      leaf: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("target")}/projects`,
    },
  }]);

  const wslRemovals: unknown[] = [];
  await removeExecutionIsolationState(
    bwrap, { kind: "wsl", distro: "Ubuntu" }, "claude-code", "C:/ignored", "target", {
      resolveWsl: async () => { throw new Error("bwrap was uninstalled"); },
      resolveWslHome: async () => "/home/me",
      removeWsl: async (context, location) => { wslRemovals.push({ context, location }); },
    },
  );
  assert.deepEqual(wslRemovals, [{
    context: { kind: "wsl", distro: "Ubuntu" },
    location: {
      root: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("target")}`,
      leaf: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("target")}/projects`,
    },
  }]);
});

test("native provider state transfer copies the fork result and cleanup removes only the child", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-state-"));
  const sourceRoot = join(root, "provider-state", "codex", providerStateKey("source"));
  const sourceLeaf = join(sourceRoot, "sessions");
  const targetRoot = join(root, "provider-state", "codex", providerStateKey("target"));
  try {
    mkdirSync(sourceLeaf, { recursive: true });
    writeFileSync(join(sourceLeaf, "rollout-now-child-123.jsonl"), "child transcript\n");
    await verifyExecutionIsolationForkState(
      bwrap, { kind: "native" }, "codex", root, "source", "child-123",
    );
    await cloneExecutionIsolationState(bwrap, { kind: "native" }, "codex", root, "source", "target");
    assert.equal(readFileSync(join(targetRoot, "sessions", "rollout-now-child-123.jsonl"), "utf8"), "child transcript\n");
    await removeExecutionIsolationState(bwrap, { kind: "native" }, "codex", root, "target");
    assert.equal(existsSync(targetRoot), false);
    assert.equal(existsSync(sourceRoot), true, "child cleanup never removes its source partition");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy provider-wide state migrates once into the old session's hashed partition", async () => {
  const copies: unknown[] = [];
  await migrateExecutionIsolationState(
    bwrap, { kind: "native" }, "claude-code", "/var/lib/wollipog", "old-session", {
      existsNative: async (path) => {
        assert.equal(path, "/var/lib/wollipog/provider-state/claude/projects");
        return true;
      },
      copyNative: async (source, target) => { copies.push({ source, target }); },
    },
  );
  assert.deepEqual(copies, [{
    source: {
      root: "/var/lib/wollipog/provider-state/claude",
      leaf: "/var/lib/wollipog/provider-state/claude/projects",
    },
    target: {
      root: `/var/lib/wollipog/provider-state/claude/${providerStateKey("old-session")}`,
      leaf: `/var/lib/wollipog/provider-state/claude/${providerStateKey("old-session")}/projects`,
    },
  }]);

  copies.length = 0;
  await migrateExecutionIsolationState(
    bwrap, { kind: "native" }, "codex", "/var/lib/wollipog", "new-session", {
      existsNative: async () => false,
      copyNative: async (source, target) => { copies.push({ source, target }); },
    },
  );
  assert.deepEqual(copies, [], "an absent legacy store creates no guessed transcript import");
});

test("fork transfer waits for a stable non-empty provider artifact and rejects missing or unsafe ids", async () => {
  let probes = 0;
  let waits = 0;
  await verifyExecutionIsolationForkState(
    bwrap, { kind: "native" }, "codex-app-server", "/var/lib/wollipog", "source", "thread-123", {
      forkSizeNative: async (location, driver, providerSessionId) => {
        probes++;
        assert.equal(location.leaf, `/var/lib/wollipog/provider-state/codex/${providerStateKey("source")}/sessions`);
        assert.equal(driver, "codex-app-server");
        assert.equal(providerSessionId, "thread-123");
        return probes === 1 ? 0 : 12;
      },
      wait: async () => { waits++; },
    },
  );
  assert.equal(probes, 4);
  assert.equal(waits, 3);

  let growing = 0;
  await assert.rejects(() => verifyExecutionIsolationForkState(
    bwrap, { kind: "native" }, "codex-app-server", "/var/lib/wollipog", "source", "slow-child", {
      forkSizeNative: async () => ++growing,
      wait: async () => {},
    },
  ), /stable non-empty/);
  assert.equal(growing, 20, "a continuously growing artifact fails closed after the stability window");

  await assert.rejects(() => verifyExecutionIsolationForkState(
    bwrap, { kind: "native" }, "claude-code", "/var/lib/wollipog", "source", "../../escape", {
      forkSizeNative: async () => 12,
    },
  ), /unsafe session id/);

  await assert.rejects(() => verifyExecutionIsolationForkState(
    bwrap, { kind: "wsl", distro: "Ubuntu" }, "claude-code", "C:/ignored", "source", "child-456", {
      resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
      forkSizeWsl: async (_context, location, driver, providerSessionId) => {
        assert.equal(location.leaf, `/home/me/.agent-manager/provider-state/claude/${providerStateKey("source")}/projects`);
        assert.equal(driver, "claude-code");
        assert.equal(providerSessionId, "child-456");
        return null;
      },
      wait: async () => {},
    },
  ), /stable non-empty/);
});

test("WSL isolation probe parsing requires three absolute, well-formed lines", () => {
  assert.deepEqual(parseWslIsolationProbe("/usr/bin/bwrap\n1000\n/home/me\n"), {
    command: "/usr/bin/bwrap", uid: 1000, home: "/home/me",
  });
  assert.equal(parseWslIsolationProbe("1000\n/home/me\n"), null);
  assert.equal(parseWslIsolationProbe("/usr/bin/bwrap\n1000\nrelative\n"), null);
  assert.equal(parseWslIsolationProbe("/usr/bin/bwrap\n1000\n/home/u/../../etc\n"), null);
  assert.equal(parseWslIsolationProbe("/usr/bin/bwrap\nnot-a-uid\n/home/me\n"), null);
});

test("attested WSL owners get disjoint provider roots and ambiguous v2 state fails closed", async () => {
  const firstOwner = "1".repeat(64);
  const secondOwner = "2".repeat(64);
  const resolve = (ownerHash: string) => resolveExecutionIsolation(
    bwrap,
    { kind: "wsl", distro: "Ubuntu" },
    {
      platform: "win32",
      resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
      mkdirWsl: async () => {},
    },
    { driver: "claude-code", dataDir: "C:/ignored", env: {}, sessionId: "same-session", cwd: "/work", ownerHash },
  );
  const [first, second] = await Promise.all([resolve(firstOwner), resolve(secondOwner)]);
  const firstSource = first?.writableBinds?.[0]?.source;
  const secondSource = second?.writableBinds?.[0]?.source;
  assert.match(firstSource ?? "", new RegExp(`/runner-instances/${firstOwner}/provider-state/claude/`));
  assert.match(secondSource ?? "", new RegExp(`/runner-instances/${secondOwner}/provider-state/claude/`));
  assert.notEqual(firstSource, secondSource);

  let copied = false;
  await assert.rejects(() => migrateExecutionIsolationState(
    bwrap,
    { kind: "wsl", distro: "Ubuntu" },
    "claude-code",
    "C:/ignored",
    "same-session",
    {
      resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
      existsWsl: async (_context, path) => path.includes(providerStateKey("same-session")),
      copyWsl: async () => { copied = true; },
    },
    firstOwner,
  ), (error) => {
    assert.match((error as Error).message, /no control-plane ownership proof/);
    assert.match(
      (error as Error).message,
      new RegExp(`/provider-state/claude/${providerStateKey("same-session")}/projects`),
    );
    assert.match(
      (error as Error).message,
      new RegExp(`/runner-instances/${firstOwner}/provider-state/claude/${providerStateKey("same-session")}/projects`),
    );
    return true;
  });
  assert.equal(copied, false, "unattributable shared bytes remain untouched");
});

test("explicit offline WSL adoption copies one legacy source and preserves it", async () => {
  const owner = "a".repeat(64);
  const copies: Array<{ source: string; target: string }> = [];
  const result = await adoptLegacyWslExecutionIsolationState(
    { kind: "wsl", distro: "Ubuntu" }, "claude-code", "same-session", owner,
    {
      resolveWsl: async () => ({ command: "/usr/bin/bwrap", uid: 1000, home: "/home/me" }),
      existsWsl: async (_context, path) => path === `/home/me/.agent-manager/provider-state/claude/${providerStateKey("same-session")}/projects`,
      copyWsl: async (_context, source, target) => copies.push({ source: source.leaf, target: target.leaf }),
    },
  );
  assert.equal(result, "adopted");
  assert.deepEqual(copies, [{
    source: `/home/me/.agent-manager/provider-state/claude/${providerStateKey("same-session")}/projects`,
    target: `/home/me/.agent-manager/runner-instances/${owner}/provider-state/claude/${providerStateKey("same-session")}/projects`,
  }]);
});

test("relative HOME overrides fail closed instead of mounting the wrong state path", async () => {
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000,
    resolveNative: async () => ({
      path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
    }),
  }, { driver: "claude-code", dataDir: "/var/lib/wollipog", env: { HOME: "relative" }, sessionId: "s1", cwd: "/work" }), /absolute traversal-free POSIX HOME/);
  await assert.rejects(() => resolveExecutionIsolation(bwrap, { kind: "native" }, {
    platform: "linux", uid: () => 1000,
    resolveNative: async () => ({
      path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] },
    }),
  }, { driver: "claude-code", dataDir: "/var/lib/wollipog", env: { HOME: "/home/u/../../etc" }, sessionId: "s1", cwd: "/work" }), /traversal-free/);
});
