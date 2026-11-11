// Installed SDK loader/event contracts with synthetic HOME and fake MCP. No Pi CLI/model/auth.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
const [srcUrl, codeRoot, root, mode = "sdk"] = process.argv.slice(2);
const tracing = process.env.WOLLIPOG_INERT_TRACE === "1";
const trace = phase => { if (tracing) console.error(`INERT_PHASE ${phase}`); };
const local = name => new URL(name, srcUrl).href;
assert.ok(mode === "sdk" || mode === "generated");
if (mode === "sdk") {
  const { verifyPiInertControlSdk } = await import(local("pi-inert-control-sdk.ts"));
  assert.equal(verifyPiInertControlSdk(codeRoot), true);
  // Independent package-resolution probe for this exact installed SDK prerequisite. Never
  // skip a different import/runtime failure, download anything or replace an installed module.
  try { createRequire(`${codeRoot}/package.json`).resolve("@earendil-works/pi-server"); }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    console.log("PI_INERT_CONTROL_SDK_UNAVAILABLE: pinned installed loader lacks @earendil-works/pi-server");
    process.exit(77);
  }
}
const registry = mode === "generated" ? await import("./pi-inert-control-registry.mjs") : null;
const { loadExtensions, loadExtensionFromFactory, createExtensionRuntime } = registry ?? await import(pathToFileURL(`${codeRoot}/dist/core/extensions/loader.js`).href);
const { ExtensionRunner } = registry ?? await import(pathToFileURL(`${codeRoot}/dist/core/extensions/runner.js`).href);
const { createEventBus } = registry ?? await import(pathToFileURL(`${codeRoot}/dist/core/event-bus.js`).href);
const { createBashTool } = registry ?? await import(pathToFileURL(`${codeRoot}/dist/core/tools/bash.js`).href);
const { piAgentControlExtensionSource, piInertAgentControlExtensionSource } = await import(local("pi-agent-control-extension.ts"));
const { installPiCommandHomePrototype } = await import(local("pi-command-home-prototype.ts"));
const { createPiInertControlLauncher } = await import(local("pi-inert-control-launcher.ts"));
const { piInertControlSpawnAdapter } = await import(local("pi-inert-control-spawn.ts"));
const { dispatch } = await import(local("session-management-mcp.ts"));
const { spawnAgent } = await import(local("spawn.ts"));
const nativeTools = ["read", "bash", "edit", "write"];
for (const [role, flags] of [["ordinary", {}], ["orchestrator", { orchestrator: true }], ["evidence", { uiEvidenceReviewer: true }]]) {
  const reply = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    cpUrl: "http://inert.invalid", token: "synthetic", selfSessionId: "synthetic", fetch: async () => { throw Error("NO_NETWORK"); }, ...flags,
  });
  const tools = reply.result.tools;
  const base = `${root}/${role}`, home = `${base}/home`, worktree = `${base}/selected`, immutable = `${base}/immutable`;
  for (const dir of [home, worktree, immutable]) mkdirSync(dir, { recursive: true });
  const shimPath = `${immutable}/spawn.mjs`;
  writeFileSync(shimPath, "let selected; export function select(spawn){selected=spawn} export function spawn(...args){return selected(...args)}\n");
  const shim = await import(pathToFileURL(shimPath).href);
  const extensionPath = `${immutable}/control.mjs`, mcp = fileURLToPath(new URL("fixtures/pi-inert-control-mcp.mjs", srcUrl));
  const generated = piInertAgentControlExtensionSource(pathToFileURL(shimPath).href);
  // Only the owned spawn import differs; ordinary emitted source and tools stay unchanged.
  assert.equal(generated.slice(generated.indexOf("\n")), piAgentControlExtensionSource().slice(piAgentControlExtensionSource().indexOf("\n")));
  writeFileSync(extensionPath, generated);
  const serialized = JSON.stringify(tools), parts = [];
  for (let offset = 0; offset < serialized.length; offset += 16000) parts.push(serialized.slice(offset, offset + 16000));
  const transport = { WOLLIPOG_CANARY: "inert-canary-value-3922", WOLLIPOG_PI_AGENT_CONTROL_COMMAND: realpathSync(process.execPath),
    WOLLIPOG_PI_AGENT_CONTROL_ARGS: JSON.stringify([mcp, "--agent-control-mcp"]),
    WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE: "synthetic-ready", WOLLIPOG_PI_SECURITY_REQUEST_NONCE: "synthetic-security",
    WOLLIPOG_INERT_CATALOG_PARTS: String(parts.length), WOLLIPOG_INERT_EVENTS_FILE: `${worktree}/events` };
  parts.forEach((part, index) => { transport[`WOLLIPOG_INERT_CATALOG_${index}`] = part; });
  // This entire fixture process was launched with a clean environment. Never layer real HOME/auth.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: home, PATH: "/usr/bin:/bin", LANG: "C" }, transport);
  let spawns = 0;
  const launcher = createPiInertControlLauncher({
    commandPolicy: { providerHome: home, immutablePaths: [immutable], installationRoot: mode === "sdk" ? codeRoot : immutable, version: "0.85.0", configuredArgs: ["--no-extensions"],
      shell: realpathSync("/bin/sh"), nodeRuntime: realpathSync(process.execPath), commandEntrypoint: fileURLToPath(new URL("pi-command-home-entrypoint.mjs", srcUrl)),
      outer: { backend: "bwrap", command: realpathSync(process.execPath), args: [], network: "inherit", preservesProviderHome: true,
        writableBinds: [{ source: home, target: home }], protectedWorktree: { parent: base, path: worktree, gitWritableRoots: [] } } },
    controlEntrypoint: fileURLToPath(new URL("pi-inert-control-entrypoint.mjs", srcUrl)), mcpEntrypoint: mcp,
    mcpEntrypointSha256: createHash("sha256").update(readFileSync(mcp)).digest("hex"), imports: [], transportEnvironment: transport,
  }, { ...(mode === "generated" ? { auditInstallation: () => true, auditRuntime: () => true } : {}), spawn: options => {
    spawns++;
    assert.ok(!JSON.stringify([options.args, options.env]).includes("inert-canary-value-3922"));
    const boundary = options.args.lastIndexOf("--");
    // No-kernel SDK contract seam, explicitly NOT OS conformance or a real provider launch.
    return spawnAgent({ ...options, command: options.args[boundary + 1], args: options.args.slice(boundary + 2) });
  } });
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    trace(`${role}/${reason}/loading`);
    const adapter = piInertControlSpawnAdapter(launcher, { command: realpathSync(process.execPath), args: [mcp, "--agent-control-mcp"], environment: { ...process.env } });
    const retired = [];
    shim.select((...args) => {
      const child = adapter.spawn(...args);
      retired.push(new Promise(resolve => child.once("close", resolve)));
      return child;
    });
    const runtime = createExtensionRuntime(), bus = createEventBus();
    let active = [...nativeTools], loaded, runner;
    runtime.refreshTools = () => { if (runner) active = [...new Set([...active, ...runner.getAllRegisteredTools().map(tool => tool.definition.name)])]; };
    runtime.getActiveTools = () => [...active];
    runtime.setActiveTools = tools => { active = [...tools]; };
    runtime.getAllTools = () => [...nativeTools.filter(name => name !== "bash").map(name => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
      ...(runner?.getAllRegisteredTools() ?? []).map(tool => ({ name: tool.definition.name, sourceInfo: tool.sourceInfo }))];
    loaded = await loadExtensions([extensionPath], worktree, bus, runtime);
    assert.deepEqual(loaded.errors, []);
    let backendCalls = 0;
    const operations = { async exec() { backendCalls++; throw Error("INERT_BACKEND_MUST_NOT_RUN"); } };
    const opsPath = `${immutable}/synthetic-operations.mjs`;
    loaded.extensions.push(await loadExtensionFromFactory(pi => installPiCommandHomePrototype(pi, { createBashTool }, operations, worktree, opsPath), worktree, bus, runtime, opsPath));
    runner = new ExtensionRunner(loaded.extensions, runtime, worktree, {}, {});
    const errors = [], statuses = [];
    runner.onError(error => errors.push(error));
    runner.setUIContext({ setStatus: (key, text) => statuses.push([key, text]), notify() {}, confirm: async () => true,
      select: async () => undefined, input: async () => undefined }, "rpc");
    await runner.emit({ type: "session_start", reason });
    trace(`${role}/${reason}/ready`);
    assert.deepEqual(errors, []);
    assert.ok(statuses.some(([key, value]) => key === "wollipog-agent-control" && value === "synthetic-ready"));
    const registered = runner.getAllRegisteredTools().map(tool => tool.definition.name);
    assert.ok(tools.every(tool => registered.includes(tool.name)));
    assert.ok(registered.includes("request_user_input")); assert.ok(nativeTools.every(tool => active.includes(tool)));
    const ordinaryCall = tools.find(tool => tool.name !== "wait_pull_request");
    const result = await runner.getToolDefinition(ordinaryCall.name).execute("fixture-call", { sessionId: "synthetic" }, undefined, undefined, runner.createContext());
    assert.equal(result.content[0].text, `inert:${ordinaryCall.name}`);
    if (registered.includes("wait_pull_request")) {
      trace(`${role}/${reason}/cancel`);
      const controller = new AbortController();
      const pending = runner.getToolDefinition("wait_pull_request").execute("fixture-wait", { pullRequest: "https://github.com/inert/repo/pull/1" }, controller.signal, undefined, runner.createContext());
      controller.abort(); await assert.rejects(pending, /cancel|abort/iu);
      for (let n = 0; n < 100; n++) {
        try { if (readFileSync(`${worktree}/events`, "utf8").includes("cancelled")) break; } catch {}
        await delay(10);
      }
      assert.match(readFileSync(`${worktree}/events`, "utf8"), /cancelled/u);
    }
    // The genuine catalog remains ineligible. The original prototype must refuse model Bash and
    // return refusing operations for RPC/user_bash, rather than allowing a name-only promotion.
    await assert.rejects(runner.getToolDefinition("bash").execute("fixture-bash", { command: "NEVER_RUN" }), /could not prove/u);
    const user = await runner.emitUserBash({ type: "user_bash", command: "NEVER_RUN", cwd: worktree, excludeFromContext: false });
    assert.ok(user.operations); await assert.rejects(user.operations.exec(), /could not prove/u); assert.equal(backendCalls, 0);
    await runner.emit({ type: "session_shutdown", reason: "reload" }); await Promise.all(retired);
    trace(`${role}/${reason}/retired`);
    runner.invalidate(); assert.throws(() => runner.getActiveTools(), /stale|reload/iu);
    bus.clear();
  }
  assert.equal(spawns, 5, "one fixed helper for each fresh synthetic SDK lifecycle, without retries");
}
console.log(mode === "sdk" ? "PI_INERT_CONTROL_PINNED_SDK: passed (real launches and import/mount completeness remain unproven)" :
  "PI_INERT_CONTROL_GENERATED_TRANSPORT: passed (explicit inert registry, no SDK/OS/provider claim)");
