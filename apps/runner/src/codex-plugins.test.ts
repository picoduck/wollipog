import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { once } from "node:events";
import { createServer } from "node:https";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inheritProviderPlugins } from "./provider-plugins.js";
import { inheritCodexPlugins } from "./codex-plugins.js";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import type { SessionMeta } from "./session-store.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { codexSkillsFromList } from "./drivers/codex-skill-catalog.js";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import { parse } from "smol-toml";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-plugins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, ".codex");
  const account = join(root, "account");
  const plugin = "review@local";
  const cache = "plugins/cache/local/review";
  mkdirSync(join(source, cache, "local/.codex-plugin"), { recursive: true });
  mkdirSync(account);
  writeFileSync(join(source, cache, "local/.codex-plugin/plugin.json"), '{"name":"review"}');
  writeFileSync(join(source, "config.toml"), '[plugins."review@local"]\nenabled = true\n');
  const launch = { command: "codex", args: [], env: { HOME: root, CODEX_HOME: account },
    context: { kind: "native" as const }, providerCredentialHome: account };
  return { root, source, account, plugin, cache, launch };
}

test("plugin inheritance preserves credentials, data, config, and account overrides", (t) => {
  const f = fixture(t);
  const sourceConfig = 'model = "source-model"\n[features]\nplugins = true\nremote_plugin = false\n' +
    '[plugins."review@local"]\nenabled = true\n[plugins."other@local"]\nenabled = false\n';
  const accountConfig = 'model = "account-model"\n[plugins."review@local"]\nenabled = false\n';
  writeFileSync(join(f.source, "config.toml"), sourceConfig);
  writeFileSync(join(f.account, "config.toml"), accountConfig);
  writeFileSync(join(f.source, "auth.json"), "source-auth");
  writeFileSync(join(f.account, "auth.json"), "account-auth");
  mkdirSync(join(f.source, "plugins/data"));
  writeFileSync(join(f.source, "plugins/data/private"), "private");
  const args = inheritCodexPlugins(f.launch);
  assert.ok(!args.some((arg) => arg.includes("review@local")));
  assert.ok(args.includes('plugins.other@local.enabled=false'));
  assert.ok(args.includes('features.plugins=true'));
  assert.ok(!args.some((arg) => arg.includes("model")));
  assert.equal(realpathSync(join(f.account, f.cache)), join(f.source, f.cache));
  assert.equal(readFileSync(join(f.account, "auth.json"), "utf8"), "account-auth");
  assert.equal(readFileSync(join(f.account, "config.toml"), "utf8"), accountConfig);
  assert.equal(readFileSync(join(f.source, "config.toml"), "utf8"), sourceConfig);
  assert.equal(existsSync(join(f.account, "plugins/data")), false);
});

test("later installs, updates, disables, and removals are reflected on the next launch", (t) => {
  const f = fixture(t);
  inheritCodexPlugins(f.launch);
  writeFileSync(join(f.source, "config.toml"), '[plugins."review@local"]\nenabled = false\n' +
    '[plugins."new@local"]\nenabled = true\n');
  mkdirSync(join(f.source, "plugins/cache/local/new/local"), { recursive: true });
  assert.ok(inheritCodexPlugins(f.launch).includes('plugins.review@local.enabled=false'));
  assert.ok(existsSync(join(f.account, "plugins/cache/local/new/local")));
  mkdirSync(join(f.source, f.cache, "2.0"));
  assert.ok(existsSync(join(f.account, f.cache, "2.0")));
  rmSync(join(f.source, f.cache), { recursive: true });
  inheritCodexPlugins(f.launch);
  assert.throws(() => lstatSync(join(f.account, f.cache)), { code: "ENOENT" });
  writeFileSync(join(f.source, "config.toml"), "");
  inheritCodexPlugins(f.launch);
  assert.throws(() => lstatSync(join(f.account, "plugins/cache/local/new")), { code: "ENOENT" });
});

test("account installations and operator-owned cache links are preserved", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.account, f.cache), { recursive: true });
  writeFileSync(join(f.account, f.cache, "own"), "own");
  inheritCodexPlugins(f.launch);
  assert.ok(!lstatSync(join(f.account, f.cache)).isSymbolicLink());
  assert.equal(readFileSync(join(f.account, f.cache, "own"), "utf8"), "own");
  rmSync(join(f.account, "plugins"), { recursive: true });
  const other = join(f.root, "operator-cache");
  mkdirSync(other);
  mkdirSync(join(f.account, "plugins"));
  symlinkSync(other, join(f.account, "plugins/cache"), process.platform === "win32" ? "junction" : "dir");
  inheritCodexPlugins(f.launch);
  assert.equal(existsSync(join(other, "local")), false);
});

test("default home, WSL, and remote execution do not inherit host plugins", (t) => {
  const f = fixture(t);
  assert.deepEqual(inheritCodexPlugins({ ...f.launch, env: { ...f.launch.env, CODEX_HOME: f.source } }), []);
  assert.deepEqual(inheritCodexPlugins({ ...f.launch, context: { kind: "wsl", distro: "Ubuntu" } }), []);
  for (const backend of ["container", "cloud"] as const) {
    assert.deepEqual(inheritCodexPlugins({ ...f.launch, isolation: { backend } as never }), []);
  }
  assert.equal(existsSync(join(f.account, "plugins")), false);
});

test("explicit CLI settings and Node bootstrap scripts keep precedence and position", (t) => {
  const f = fixture(t);
  const explicit = ["-c", 'plugins."review@local".enabled=false'];
  const args = inheritCodexPlugins({ ...f.launch, command: process.execPath, args: ["codex.js", ...explicit] });
  assert.equal(args[0], "codex.js");
  assert.deepEqual(args.slice(-2), explicit);
});

test("config parse failures never expose source lines or credentials", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "config.toml"), 'token = "SECRET" invalid');
  assert.throws(() => inheritCodexPlugins(f.launch), (error: unknown) => {
    assert.match((error as Error).message, /default config.toml/);
    assert.doesNotMatch((error as Error).message, /SECRET|token/);
    return true;
  });
});

test("dotted plugin IDs and nested tool policies retain their keys and account overrides", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, "config.toml"), '[plugins."review@local.market"]\nenabled = true\n' +
    '[plugins."review@local.market".mcp_servers.review]\nenabled_tools = ["review.diff", "review.patch"]\n');
  writeFileSync(join(f.account, "config.toml"), '[plugins."other@local"]\nenabled = false\n');
  const args = inheritCodexPlugins(f.launch);
  assert.equal(args[0], "-c");
  assert.deepEqual(JSON.parse(JSON.stringify(parse(args[1]!))), { plugins: {
    "review@local.market": { enabled: true, mcp_servers: { review: { enabled_tools: ["review.diff", "review.patch"] } } },
    "other@local": { enabled: false },
  } });
});

test("native TUI inheritance runs under the home lease before guard enumeration", async (t) => {
  const f = fixture(t);
  let acquired = false;
  const meta = { ...f.launch, sessionId: "plugins", driver: "codex-app-server", config: {} } as unknown as SessionMeta;
  const launch = await prepareAgentTuiLaunch(meta, {
    controlPlaneProtocolVersion: null,
    acquireProviderHome() { assert.equal(existsSync(join(f.account, f.cache)), false); acquired = true; },
    provision() {}, assertSessionNotDeleted() {}, provisionManagedWorktreeGuard: (prepared) => {
      assert.equal(acquired, true);
      assert.ok(existsSync(join(f.account, f.cache)));
      assert.ok(prepared.args.includes("plugins.review@local.enabled=true"));
      return { args: prepared.args, protections: [], guardActive: false };
    },
    prepareScratch: async () => f.root,
  });
  assert.ok(launch?.args.includes('plugins.review@local.enabled=true'));
  assert.deepEqual(meta.args, []);
});

test("installed Codex CLI loads inherited plugins from an existing account", {
  skip: !process.env.WOLLIPOG_TEST_CODEX_PLUGIN_BINARY,
}, async (t) => {
  const f = fixture(t);
  const binary = process.env.WOLLIPOG_TEST_CODEX_PLUGIN_BINARY!;
  const marketplace = join(f.root, "marketplace");
  mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
  mkdirSync(join(marketplace, "review/.codex-plugin"), { recursive: true });
  writeFileSync(join(marketplace, "review/.codex-plugin/plugin.json"), '{"name":"review"}');
  mkdirSync(join(marketplace, "review/skills/review"), { recursive: true });
  writeFileSync(join(marketplace, "review/skills/review/SKILL.md"),
    "---\nname: review\ndescription: Review a change.\n---\n\nReview the change.\n");
  writeFileSync(join(marketplace, ".agents/plugins/marketplace.json"), JSON.stringify({
    name: "local", plugins: [{ name: "review", source: { source: "local", path: "./review" } }],
  }));
  const run = (home: string, args: string[]) => execFileSync(binary, args, {
    cwd: f.root, env: { ...process.env, HOME: f.root, CODEX_HOME: home }, encoding: "utf8", timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  run(f.source, ["--disable", "remote_plugin", "plugin", "marketplace", "add", marketplace]);
  run(f.source, ["--disable", "remote_plugin", "plugin", "add", f.plugin]);
  const sourceList = run(f.source, ["--disable", "remote_plugin", "plugin", "list", "--json"]);
  assert.ok(JSON.parse(sourceList).installed.length, sourceList);
  const listed = JSON.parse(run(f.account, [...inheritCodexPlugins(f.launch), "--disable", "remote_plugin",
    "plugin", "list", "--json"]));
  assert.ok(listed.installed.some((plugin: { pluginId: string; enabled: boolean }) =>
    plugin.pluginId === f.plugin && plugin.enabled), JSON.stringify({ listed, args: inheritCodexPlugins(f.launch),
      config: readFileSync(join(f.source, "config.toml"), "utf8") }));
  const child = spawn(binary, [...inheritCodexPlugins(f.launch), "--disable", "remote_plugin", "app-server"], {
    cwd: f.root, env: { ...process.env, ...f.launch.env }, stdio: ["pipe", "pipe", "ignore"],
  });
  const peer = new JsonRpcPeer(child.stdin, child.stdout);
  try {
    await peer.requestWithDeadline("initialize", { clientInfo: { name: "wollipog-plugin-test", version: "1" } }, Date.now() + 10_000);
    peer.notify("initialized", {});
    const skills = codexSkillsFromList(await peer.requestWithDeadline("skills/list", { cwds: [f.root] }, Date.now() + 10_000));
    assert.ok(skills.some((skill) => skill.name === "review:review" && skill.path.includes("plugins/cache")), JSON.stringify(skills));
  } finally {
    peer.dispose("plugin verification completed");
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
});

test("installed Codex reconciles remote catalog installs into an already-running account", {
  skip: !process.env.WOLLIPOG_TEST_CODEX_PLUGIN_BINARY || process.platform === "win32",
}, async (t) => {
  const f = fixture(t);
  const bundleRoot = join(f.root, "remote-bundle");
  mkdirSync(join(bundleRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(bundleRoot, "skills/search"), { recursive: true });
  writeFileSync(join(bundleRoot, ".codex-plugin/plugin.json"), '{"name":"notion"}');
  writeFileSync(join(bundleRoot, "skills/search/SKILL.md"),
    "---\nname: search\ndescription: Search Notion.\n---\n\nSearch Notion.\n");
  const archive = execFileSync("tar", ["-czf", "-", "-C", bundleRoot, ".codex-plugin", "skills"]);
  let installed = false;
  let authenticatedSnapshots = 0;
  const requests: string[] = [];
  const certificate = join(f.root, "fixture-cert.pem");
  const key = join(f.root, "fixture-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", certificate, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
  { stdio: "ignore" });
  const serverKey = join(f.root, "fixture-server-key.pem");
  const serverCertificate = join(f.root, "fixture-server-cert.pem");
  const certificateRequest = join(f.root, "fixture-server.csr");
  const extensions = join(f.root, "fixture-server.ext");
  writeFileSync(extensions, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n");
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKey,
    "-out", certificateRequest, "-subj", "/CN=localhost"], { stdio: "ignore" });
  execFileSync("openssl", ["x509", "-req", "-in", certificateRequest, "-CA", certificate, "-CAkey", key,
    "-CAcreateserial", "-out", serverCertificate, "-days", "1", "-extfile", extensions], { stdio: "ignore" });
  let driver: CodexAppServerDriver | undefined;
  const server = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate) }, (req, res) => {
    const url = new URL(req.url!, endpoint);
    requests.push(url.pathname);
    if (url.pathname === "/backend-api/ps/plugins/installed") {
      if (req.headers.authorization === "Bearer fixture-token" && req.headers["chatgpt-account-id"] === "fixture-account") {
        authenticatedSnapshots++;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ plugins: installed ? [{
        id: "plugins~Plugin_00000000000000000000000000000000", name: "notion", scope: "GLOBAL",
        enabled: true, installation_policy: "AVAILABLE", authentication_policy: "ON_USE",
        release: { version: "1.0.0", display_name: "Notion", description: "Search Notion",
          bundle_download_url: `${endpoint}/bundle`, interface: {} },
      }] : [], pagination: { limit: 200, next_page_token: null } }));
    } else if (url.pathname === "/bundle") {
      res.end(archive);
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>((resolve) => {
    driver?.dispose();
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  writeFileSync(join(f.account, "config.toml"), `chatgpt_base_url = "${endpoint}/backend-api/"\n` +
    'cli_auth_credentials_store = "file"\n[features]\nplugins = true\napps = false\nremote_plugin = false\nplugin_sharing = false\n');
  const claims = { email: "fixture@example.test", "https://api.openai.com/auth": {
    chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", chatgpt_plan_type: "plus",
  } };
  const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  writeFileSync(join(f.account, "auth.json"), JSON.stringify({ auth_mode: "chatgpt",
    tokens: { id_token: idToken, access_token: "fixture-token", refresh_token: "fixture-refresh", account_id: "fixture-account" },
    last_refresh: new Date().toISOString(),
  }));
  const stderr: string[] = [];
  const activeDriver = driver = new CodexAppServerDriver({ command: process.env.WOLLIPOG_TEST_CODEX_PLUGIN_BINARY!,
    args: [], cwd: f.root, context: { kind: "native" }, config: {},
    env: { HOME: f.root, CODEX_HOME: f.account, SSL_CERT_FILE: certificate, CODEX_CA_CERTIFICATE: certificate },
  }, { onEvent: () => {}, onStderr: (line) => stderr.push(line), onExit: () => {} });
  await activeDriver.initialize();
  await activeDriver.newSession(f.root);
  assert.equal(activeDriver.sessionCommands().some((command) => command.name === "notion:search"), false);
  installed = true;
  await (activeDriver as any).reconcilePlugins("turn_start");
  assert.ok(existsSync(join(f.account, "plugins/cache/openai-curated-remote/notion/1.0.0/skills/search/SKILL.md")),
    JSON.stringify({ requests, stderr, authenticatedSnapshots }));
  const waitFor = async (available: boolean) => {
    const deadline = Date.now() + 10_000;
    while (activeDriver.sessionCommands().some((command) => command.name === "notion:search") !== available) {
      assert.ok(Date.now() < deadline, JSON.stringify({ commands: activeDriver.sessionCommands(), requests, stderr }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await waitFor(true);
  assert.ok(existsSync(join(f.account, "plugins/cache/openai-curated-remote/notion/1.0.0/skills/search/SKILL.md")));
  installed = false;
  await (activeDriver as any).reconcilePlugins("turn_start");
  await waitFor(false);
  assert.ok(authenticatedSnapshots >= 3, "every reconciliation must use the managed account's identity");
  assert.ok(existsSync(join(f.source, f.cache)), "remote sync must preserve default-home plugins");
});


test("unmanaged custom Codex homes do not inherit default plugins", (t) => {
  const f = fixture(t);
  const { providerCredentialHome: _home, ...unmanaged } = f.launch;
  assert.deepEqual(inheritProviderPlugins({ ...unmanaged, driver: "codex-app-server" }), []);
  assert.equal(existsSync(join(f.account, "plugins")), false);
});


test("package launchers keep their bootstrap before inherited Codex flags", (t) => {
  const f = fixture(t);
  for (const [command, bootstrap] of [
    ["npx", ["-y", "@openai/codex"]], ["npm", ["exec", "--", "@openai/codex@0.159.2"]],
    ["pnpm", ["dlx", "@openai/codex"]], ["bun", ["x", "@openai/codex"]],
  ] as const) {
    const explicit = ["-c", "plugins.review@local.enabled=false"];
    const args = inheritCodexPlugins({ ...f.launch, command, args: [...bootstrap, ...explicit] });
    assert.deepEqual(args.slice(0, bootstrap.length), bootstrap);
    assert.ok(args.slice(bootstrap.length).includes("plugins.review@local.enabled=true"));
    assert.deepEqual(args.slice(-2), explicit);
  }
});
