import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inheritProviderPlugins, pluginProviderForDriver } from "./provider-plugins.js";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import type { SessionMeta } from "./session-store.js";

function json(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function read(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-claude-plugins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".claude");
  const account = join(root, "account");
  const installPath = join(source, "plugins/cache/local/review/1.0.0");
  json(join(installPath, ".claude-plugin/plugin.json"), { name: "review", version: "1.0.0" });
  const record = { scope: "user", installPath, version: "1.0.0", installedAt: "2026-10-01T00:00:00.000Z",
    lastUpdated: "2026-10-01T00:00:00.000Z" };
  json(join(source, "plugins/installed_plugins.json"), { version: 2, plugins: { "review@local": [record] } });
  json(join(source, "settings.json"), { enabledPlugins: { "review@local": true } });
  mkdirSync(account);
  const launch = { command: "claude", args: [] as string[], driver: "claude-code", context: { kind: "native" as const },
    env: { HOME: root, CLAUDE_CONFIG_DIR: account } };
  return { root, source, account, installPath, record, launch };
}

test("every registered provider uses the matching plugin inheritance policy", () => {
  assert.equal(pluginProviderForDriver("claude-code"), "claude");
  assert.equal(pluginProviderForDriver("codex"), "codex");
  assert.equal(pluginProviderForDriver("codex-app-server"), "codex");
  assert.equal(pluginProviderForDriver("pi"), undefined);
});

test("Claude inherits user marketplace plugins while keeping auth, remote sync, and project installs separate", (t) => {
  const f = fixture(t);
  json(join(f.source, "settings.json"), { enabledPlugins: { "review@local": true, "remote@synced": false },
    env: { SECRET: "source-secret" }, permissions: { allow: ["Bash"] }, syncClaudeAiPlugins: false });
  json(join(f.source, "plugins/installed_plugins.json"), { version: 2, plugins: {
    "review@local": [f.record], "project@local": [{ ...f.record, scope: "project", projectPath: "/other" }],
    "remote@synced": [{ ...f.record }],
  } });
  json(join(f.source, ".credentials.json"), { accessToken: "source-token" });
  json(join(f.account, ".credentials.json"), { accessToken: "account-token" });
  json(join(f.account, "settings.json"), { env: { SECRET: "account-secret" }, hooks: { PreToolUse: [] } });
  const original = readFileSync(join(f.account, ".credentials.json"), "utf8");
  assert.deepEqual(inheritProviderPlugins(f.launch), []);
  assert.equal(readFileSync(join(f.account, ".credentials.json"), "utf8"), original);
  const settings = read(join(f.account, "settings.json"));
  assert.deepEqual(settings, { env: { SECRET: "account-secret" }, hooks: { PreToolUse: [] }, enabledPlugins: { "review@local": true } });
  const registry = read(join(f.account, "plugins/installed_plugins.json"));
  assert.deepEqual(Object.keys(registry.plugins), ["review@local"]);
  const path = registry.plugins["review@local"][0].installPath;
  assert.ok(path.startsWith(f.account));
  assert.equal(read(join(path, ".claude-plugin/plugin.json")).name, "review");
});

test("Claude picks up source install, update, disable, and removal on subsequent launches", (t) => {
  const f = fixture(t);
  inheritProviderPlugins(f.launch);
  const firstPath = read(join(f.account, "plugins/installed_plugins.json")).plugins["review@local"][0].installPath;
  const updatedPath = join(f.source, "plugins/cache/local/review/2.0.0");
  json(join(updatedPath, ".claude-plugin/plugin.json"), { name: "review", version: "2.0.0" });
  json(join(f.source, "plugins/installed_plugins.json"), { version: 2, plugins: {
    "review@local": [{ ...f.record, version: "2.0.0", installPath: updatedPath }],
    "new@local": [{ ...f.record }],
  } });
  json(join(f.source, "settings.json"), { enabledPlugins: { "review@local": false, "new@local": true } });
  inheritProviderPlugins(f.launch);
  const registry = read(join(f.account, "plugins/installed_plugins.json"));
  assert.equal(registry.plugins["review@local"][0].version, "2.0.0");
  assert.ok(registry.plugins["new@local"]);
  assert.equal(read(join(firstPath, ".claude-plugin/plugin.json")).version, "1.0.0", "running sessions keep their old snapshot");
  assert.equal(read(join(f.account, "settings.json")).enabledPlugins["review@local"], false);
  json(join(f.source, "plugins/installed_plugins.json"), { version: 2, plugins: {} });
  json(join(f.source, "settings.json"), {});
  inheritProviderPlugins(f.launch);
  assert.deepEqual(read(join(f.account, "plugins/installed_plugins.json")).plugins, {});
  assert.deepEqual(read(join(f.account, "settings.json")).enabledPlugins, {});
});

test("Claude account installations and explicit disables take precedence after inheritance", (t) => {
  const f = fixture(t);
  inheritProviderPlugins(f.launch);
  const registry = read(join(f.account, "plugins/installed_plugins.json"));
  registry.plugins["review@local"][0].version = "account-version";
  json(join(f.account, "plugins/installed_plugins.json"), registry);
  json(join(f.account, "settings.json"), { enabledPlugins: { "review@local": false } });
  inheritProviderPlugins(f.launch);
  assert.equal(read(join(f.account, "plugins/installed_plugins.json")).plugins["review@local"][0].version, "account-version");
  assert.equal(read(join(f.account, "settings.json")).enabledPlugins["review@local"], false);
  json(join(f.source, "plugins/installed_plugins.json"), { version: 2, plugins: {} });
  inheritProviderPlugins(f.launch);
  assert.equal(read(join(f.account, "plugins/installed_plugins.json")).plugins["review@local"][0].version, "account-version");
});

test("default removal preserves an account install's marketplace and enablement", (t) => {
  const f = fixture(t);
  const marketplace = join(f.root, "marketplace");
  json(join(marketplace, ".claude-plugin/marketplace.json"), { name: "local", plugins: [] });
  json(join(f.source, "plugins/known_marketplaces.json"), { local: {
    source: { source: "directory", path: marketplace }, installLocation: marketplace,
  } });
  inheritProviderPlugins(f.launch);
  const registry = read(join(f.account, "plugins/installed_plugins.json"));
  registry.plugins["review@local"][0].version = "account-version";
  json(join(f.account, "plugins/installed_plugins.json"), registry);
  json(join(f.source, "plugins/installed_plugins.json"), { version: 2, plugins: {} });
  json(join(f.source, "settings.json"), {});
  inheritProviderPlugins(f.launch);
  assert.equal(read(join(f.account, "settings.json")).enabledPlugins["review@local"], true);
  assert.ok(read(join(f.account, "plugins/known_marketplaces.json")).local);
  assert.ok(read(join(f.account, "settings.json")).extraKnownMarketplaces.local);
});

test("Claude default home, WSL, and remote execution preserve their own installations", (t) => {
  const f = fixture(t);
  inheritProviderPlugins({ ...f.launch, context: { kind: "wsl", distro: "Ubuntu" } });
  inheritProviderPlugins({ ...f.launch, executionTarget: { adapter: "container" } });
  inheritProviderPlugins({ ...f.launch, executionTarget: { adapter: "cloud" } });
  inheritProviderPlugins({ ...f.launch, env: { ...f.launch.env, CLAUDE_CONFIG_DIR: f.source } });
  assert.equal(existsSync(join(f.account, "plugins")), false);
});

test("Claude does not write through operator-owned plugin or settings links", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.source, "settings.json"), join(f.account, "settings.json"));
  const original = readFileSync(join(f.source, "settings.json"), "utf8");
  inheritProviderPlugins(f.launch);
  assert.equal(existsSync(join(f.account, "plugins")), false);
  assert.equal(readFileSync(join(f.source, "settings.json"), "utf8"), original);
});

test("Claude malformed plugin settings fail without quoting secrets", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "settings.json"), '{"SECRET":"source-secret", invalid}');
  assert.throws(() => inheritProviderPlugins(f.launch), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Claude plugin inheritance could not read/u);
    assert.equal(error.message.includes("source-secret"), false);
    return true;
  });
});

test("Claude Native TUI reconciles plugins under a lease before guard preparation", async (t) => {
  const f = fixture(t);
  const meta = { ...f.launch, sessionId: "claude-plugin", config: {}, repoPath: f.root } as unknown as SessionMeta;
  const steps: string[] = [];
  await prepareAgentTuiLaunch(meta, {
    controlPlaneProtocolVersion: null, provision: () => {}, acquireProviderHome: () => { steps.push("lease"); },
    assertSessionNotDeleted: () => {}, prepareScratch: async () => f.root,
    provisionManagedWorktreeGuard: async (prepared) => {
      steps.push("guard");
      assert.ok(read(join(prepared.env.CLAUDE_CONFIG_DIR!, "plugins/installed_plugins.json")).plugins["review@local"]);
      return { args: prepared.args, env: prepared.env, protections: [] } as never;
    },
  });
  assert.deepEqual(steps, ["lease", "guard"]);
  assert.deepEqual(meta.args, []);
});

test("installed Claude CLI lists and disables inherited plugins independently", {
  skip: !process.env.WOLLIPOG_TEST_CLAUDE_PLUGIN_BINARY,
}, (t) => {
  const f = fixture(t);
  const binary = process.env.WOLLIPOG_TEST_CLAUDE_PLUGIN_BINARY!;
  const project = join(f.root, "project");
  mkdirSync(project);
  const run = (home: string, args: string[]) => execFileSync(binary, args, {
    cwd: project, env: { ...process.env, HOME: f.root, CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const listed = (home: string) => JSON.parse(run(home, ["plugin", "list", "--json"]));
  const skill = join(f.installPath, "skills/check");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: check\ndescription: Check the change.\n---\n\nCheck the change.\n");
  const marketplace = join(f.root, "marketplace");
  json(join(marketplace, ".claude-plugin/marketplace.json"), {
    name: "local", owner: { name: "Plugin Test" }, plugins: [{ name: "review", source: { source: "github", repo: "fixture/review" } }],
  });
  run(f.source, ["plugin", "marketplace", "add", marketplace]);
  assert.match(run(f.source, ["plugin", "details", "review@local"]), /check/u);
  inheritProviderPlugins(f.launch);
  assert.ok(listed(f.account).some((plugin: any) => plugin.id === "review@local" && plugin.enabled));
  assert.match(run(f.account, ["plugin", "details", "review@local"]), /check/u);
  run(f.account, ["plugin", "disable", "review@local", "--scope", "user"]);
  inheritProviderPlugins(f.launch);
  assert.ok(listed(f.account).some((plugin: any) => plugin.id === "review@local" && !plugin.enabled));
  assert.equal(read(join(f.source, "settings.json")).enabledPlugins["review@local"], true);
  assert.ok(existsSync(f.installPath));
  run(f.account, ["plugin", "uninstall", "review@local", "--scope", "user"]);
  assert.ok(existsSync(join(f.installPath, ".claude-plugin/plugin.json")));
});
