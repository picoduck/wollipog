import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsClaudeProjectMemory } from "@wollipog/protocol";
import { prepareProjectMemory, withClaudeProjectMemory } from "./project-memory.js";
import type { SessionMeta } from "./session-store.js";
import { runContextCommand } from "./context-command.js";
import { resolveExecutionIsolation, buildSeatbeltProfile } from "./execution-isolation.js";

function meta(projectId = "project", account = "/account/one", sharing: "shared" | "separate" = "separate"): SessionMeta {
  return { driver: "claude-code", agentVersion: "2.1.284", projectMemory: { projectId, sharing },
    repoPath: "/repo", env: {}, providerCredentialHome: account, context: { kind: "native" } } as SessionMeta;
}

test("private/shared partitions survive switches and restart without copying credentials or unrelated memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-"));
  try {
    mkdirSync(join(root, "legacy", "memory"), { recursive: true });
    writeFileSync(join(root, "legacy", "memory", "MEMORY.md"), "old shared notes");
    writeFileSync(join(root, "auth.json"), "credentials stay put");
    const one = await prepareProjectMemory(meta(), root);
    const two = await prepareProjectMemory(meta("project", "/account/two"), root);
    assert.ok(one && two && one !== two);
    writeFileSync(join(one, "MEMORY.md"), "one's private memory");
    assert.equal(await prepareProjectMemory(meta(), root), one);
    const shared = await prepareProjectMemory(meta("project", "/account/one", "shared"), root);
    assert.ok(shared && shared !== one && shared !== two);
    writeFileSync(join(shared, "MEMORY.md"), "shared project notes");
    assert.equal(await prepareProjectMemory(meta("project", "/account/two", "shared"), root), shared);
    assert.notEqual(await prepareProjectMemory(meta("other", "/account/one", "shared"), root), shared);
    assert.equal(await prepareProjectMemory(meta(), root), one);
    assert.equal(readFileSync(join(one, "MEMORY.md"), "utf8"), "one's private memory");
    assert.equal(readFileSync(join(shared, "MEMORY.md"), "utf8"), "shared project notes");
    assert.equal(readFileSync(join(root, "auth.json"), "utf8"), "credentials stay put");
    assert.equal(readFileSync(join(root, "legacy", "memory", "MEMORY.md"), "utf8"), "old shared notes");
    assert.notEqual(await prepareProjectMemory({ ...meta(), projectMemory: { projectId: null, sharing: "separate" } }, root), one);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unverified Claude and non-host targets fail explicitly; Codex neither redirects nor copies global memories", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-gating-"));
  try {
    for (const version of [undefined, "2.1.283", "garbage"]) {
      await assert.rejects(prepareProjectMemory({ ...meta(), agentVersion: version }, root), /requires Claude/);
    }
    assert.equal(supportsClaudeProjectMemory("2.1.284"), true);
    assert.equal(supportsClaudeProjectMemory("3.0.0"), true);
    await assert.rejects(prepareProjectMemory({ ...meta(), executionTarget: { adapter: "container" } as never }, root), /execution target/);
    for (const driver of ["codex", "codex-app-server"] as const) for (const sharing of ["separate", "shared"] as const) {
      assert.equal(await prepareProjectMemory({ ...meta("project", "/account/one", sharing), driver }, root), undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a redirected managed store fails without touching the destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-symlink-"));
  try {
    mkdirSync(join(root, "other"));
    symlinkSync(join(root, "other"), join(root, "project-memory"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(prepareProjectMemory(meta(), root), /redirected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude's effective settings retain hooks, env, and permissions while replacing its memory directory", () => {
  const source = { hooks: { PreToolUse: [{ hooks: [{ command: "guard" }] }] }, env: { KEEP: "yes" },
    permissions: { deny: ["Bash(rm:*)"] }, autoMemoryDirectory: "/old" };
  const args = withClaudeProjectMemory(["--settings", "nonexistent-overridden-settings.json", "-p",
    "--settings=" + JSON.stringify(source)], "/project/selected");
  const settings = JSON.parse(args.at(-1)!);
  assert.deepEqual(settings, { ...source, autoMemoryDirectory: "/project/selected" });
  assert.equal(args.filter((arg) => arg === "--settings").length, 1);
  assert.ok(args.includes("-p"));
  assert.throws(() => withClaudeProjectMemory(["--settings", "[]"], "/selected"), /ENOENT|Invalid/);
});

test("Bubblewrap binds only the selected partition; Seatbelt grants it even for strict scratch-only sessions", { skip: process.platform === "win32" ? "POSIX sandbox path rendering" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-boundary-"));
  try {
    const selected = await prepareProjectMemory(meta(), root);
    assert.ok(selected);
    const other = await prepareProjectMemory(meta("project", "/account/two"), root);
    const state = { driver: "claude-code" as const, dataDir: root, env: { HOME: join(root, "home") },
      sessionId: "session", cwd: root, additionalWritableRoots: [selected], projectMemoryDirectory: selected,
      orchestratorScratchOnly: true };
    const isolation = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {
      platform: "linux", uid: () => 1000,
      resolveNative: async () => ({ launch: { command: "/bwrap", args: [] } }) as never,
    }, state);
    assert.ok(isolation?.backend === "bwrap");
    assert.ok(isolation.writableBinds?.some((bind) => bind.source === selected && bind.target === selected));
    assert.ok(!isolation.writableBinds?.some((bind) => bind.source === other));
    const profile = buildSeatbeltProfile(state, state.env.HOME, "inherit");
    assert.ok(profile.includes(selected));
    assert.ok(!profile.includes(other!));
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("WSL selects stable project/account partitions inside its owner namespace and refuses redirected ancestors", { skip: process.platform === "win32" ? "the target-local shell requires POSIX" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog memory wsl "));
  const owner = "a".repeat(64);
  const inContext: typeof runContextCommand = async (_context, command, args) => ({
    stdout: execFileSync(command, args, { encoding: "utf8", env: { ...process.env, HOME: root }, timeout: 5000 }),
    stderr: "", code: 0,
  });
  try {
    const wsl = { ...meta(), context: { kind: "wsl" as const, distro: "synthetic" } };
    const privatePath = await prepareProjectMemory(wsl, "C:\\host-state", owner, inContext);
    assert.ok(privatePath?.startsWith(join(root, ".agent-manager", "runner-instances", owner)));
    const shared = await prepareProjectMemory({ ...wsl, projectMemory: { projectId: "project", sharing: "shared" } }, "C:\\host-state", owner, inContext);
    assert.notEqual(privatePath, shared);
    assert.equal(await prepareProjectMemory(wsl, "C:\\host-state", owner, inContext), privatePath);
    rmSync(join(root, ".agent-manager"), { recursive: true });
    mkdirSync(join(root, "other")); symlinkSync(join(root, "other"), join(root, ".agent-manager"), "dir");
    await assert.rejects(prepareProjectMemory(wsl, "C:\\host-state", owner, inContext), /redirected/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relative operator settings resolve in the provider cwd; oversized settings fail before spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-memory-settings-"));
  try {
    writeFileSync(join(root, "settings.json"), JSON.stringify({ env: { PRESERVE: "yes" }, autoMemoryDirectory: "/old" }));
    const args = withClaudeProjectMemory(["--settings", "settings.json"], "/selected", root);
    assert.deepEqual(JSON.parse(args.at(-1)!), { env: { PRESERVE: "yes" }, autoMemoryDirectory: "/selected" });
    writeFileSync(join(root, "settings.json"), "x".repeat(100_000));
    assert.throws(() => withClaudeProjectMemory(["--settings", "settings.json"], "/selected", root), /too large/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
