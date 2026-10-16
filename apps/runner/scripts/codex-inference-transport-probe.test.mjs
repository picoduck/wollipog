import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

const nativeIntegration = {
  timeout: 20000,
  skip: process.platform !== "linux" ? "Exact fixture identity/exit checks require Linux /proc" : false,
};

// Bundle-time replacement only: the production command has no synthetic mode or auth bypass.
// No real provider, HOME, credentials, upstream request, or shared driver fixture is used.
const driverFixture = `
import { createConnection } from 'node:net';
export class CodexAppServerResumeError extends Error {}
export class CodexAppServerDriver {
  constructor(options, callbacks, _stager, deps) {
    this.options = options; this.callbacks = callbacks; this.deps = deps;
  }
  async initialize() {
    this.child = this.deps.spawn({ command: process.execPath,
      args: [process.env.SYNTHETIC_PROVIDER], cwd: this.options.cwd,
      env: { ...process.env, CODEX_HOME: this.options.env.CODEX_HOME }, context: { kind: 'native' } });
    console.log(JSON.stringify({ syntheticOwnedProvider: this.child.pid }));
    await new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', () => reject(new Error('synthetic_startup_failed')));
      this.child.stdout.once('data', resolve);
    });
    if (process.env.SYNTHETIC_SETUP_FAILURE) throw new Error('synthetic-access-secret');
    const base = this.options.args.find(arg => arg.startsWith('openai_base_url='));
    this.port = Number(base.match(/127[.]0[.]0[.]1:([0-9]+)/)[1]);
    // Hold a partially received HTTP request open. Cleanup must include pre-upgrade sockets.
    this.proxy = createConnection({ host: '127.0.0.1', port: this.port });
    this.proxy.on('error', () => {});
    await new Promise(resolve => this.proxy.once('connect', resolve));
    this.proxy.write('GET /backend-api/codex/responses HTTP/1.1' + String.fromCharCode(13, 10));
    if (process.env.SYNTHETIC_STAGE === 'initialize') return this.pause('initialize');
  }
  async newSession() { return 'synthetic-thread'; }
  async prompt() {
    if (process.env.SYNTHETIC_STAGE === 'fallback') {
      this.callbacks.onStderr(JSON.stringify({ event: 'codex_inference_transport', phase: 'fallback',
        provider: 'openai', configuredTransport: 'websocket', observedTransport: 'http' }));
    }
    if (process.env.SYNTHETIC_STAGE !== 'complete') return this.pause(process.env.SYNTHETIC_STAGE);
    return 'end_turn';
  }
  pause(stage) {
    console.log(JSON.stringify({ syntheticStage: stage, pid: this.child.pid, port: this.port }));
    return new Promise(() => {});
  }
  resolvePermission() {}
  dispose() {
    if (this.child) this.deps.kill(this.child);
    if (process.env.SYNTHETIC_DISPOSE_FAILURE) throw new Error('synthetic-access-secret');
  }
}
`;

const providerFixture = `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const auth = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'auth.json'), 'utf8'));
if (auth.tokens.refresh_token !== '' || !auth.tokens.access_token.startsWith('synthetic.')) process.exit(12);
// Exercise bounded KILL escalation as well as ordinary TERM shutdown.
if (process.env.SYNTHETIC_IGNORE_TERM) process.on('SIGTERM', () => {});
console.log('synthetic-provider-ready');
setInterval(() => {}, 1000);
`;

function live(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function until(predicate, message, timeout = 9000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture(t, { stage, signal, duplicate = false, disposeFailure = false, startupFailure = false,
  setupFailure = false, ignoreTerm = false }) {
  const root = mkdtempSync(join(tmpdir(), "synthetic-probe-test-"));
  const provider = join(root, "provider.mjs");
  let child, closed, output = "", errors = "", ownedPid;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
      // Baseline or pre-readiness failures may orphan the fixture. Verify its unique command.
      if (ownedPid && live(ownedPid)) {
        try {
          const command = readFileSync(`/proc/${ownedPid}/cmdline`, "utf8").split("\0");
          assert.equal(command[1], startupFailure ? join(root, "missing.mjs") : provider);
          process.kill(ownedPid, "SIGKILL");
          await until(() => !live(ownedPid), "test-owned provider did not exit");
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const temporary = join(root, "temporary");
  const authHome = join(root, "source");
  mkdirSync(temporary, { mode: 0o700 });
  mkdirSync(authHome, { mode: 0o700 });
  const access = `synthetic.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 7200 })).toString("base64url")}.signature`;
  const source = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: access,
    id_token: "synthetic-id", account_id: "synthetic-account", refresh_token: "synthetic-refresh-secret" } });
  writeFileSync(join(authHome, "auth.json"), source, { mode: 0o600 });
  writeFileSync(provider, providerFixture);
  const bundle = join(root, "probe.mjs");
  await build({ entryPoints: [resolve("apps/runner/scripts/codex-inference-transport-probe.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "esm", external: ["ws", "node-pty"],
    // Resolve external workspace dependencies from the repository without putting the fixture here.
    banner: { js: `import { createRequire as syntheticRequire } from 'node:module'; const require = syntheticRequire(${JSON.stringify(resolve("apps/runner/package.json"))});` },
    plugins: [{ name: "synthetic-driver", setup(build) {
      build.onResolve({ filter: /\/codex-app-server\.js$/ }, () => ({ path: "driver", namespace: "synthetic" }));
      build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: driverFixture, loader: "js" }));
    } }],
  });
  // ESM bare dependency imports resolve relative to the fixture; use a test-owned symlink.
  const { symlinkSync } = await import("node:fs");
  symlinkSync(resolve("apps/runner/node_modules"), join(root, "node_modules"), "dir");
  child = spawn(process.execPath, [bundle, ...(stage === "fallback" ? ["--force-http-fallback"] : [])], {
    cwd: root, env: { PATH: process.env.PATH, HOME: authHome, CODEX_HOME: authHome, TMPDIR: temporary,
      SYNTHETIC_PROVIDER: startupFailure ? join(root, "missing.mjs") : provider,
      SYNTHETIC_STAGE: stage, ...(ignoreTerm ? { SYNTHETIC_IGNORE_TERM: "1" } : {}),
      ...(setupFailure ? { SYNTHETIC_SETUP_FAILURE: "1" } : {}),
      ...(disposeFailure ? { SYNTHETIC_DISPOSE_FAILURE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", bytes => {
    output += bytes;
    for (const line of output.split("\n")) {
      try { ownedPid ??= JSON.parse(line).syntheticOwnedProvider; } catch { /* Partial JSON line. */ }
    }
  });
  child.stderr.on("data", bytes => { errors += bytes; });
  closed = once(child, "close");
  if (signal) {
    await until(() => output.includes('"syntheticStage"') || child.exitCode !== null,
      `fixture failed to become ready: ${errors}`);
    const ready = output.split("\n").map(line => { try { return JSON.parse(line); } catch { return {}; } })
      .find(event => event.syntheticStage);
    assert.ok(ready, `fixture exited early: ${errors} ${output}`);
    ownedPid = ready.pid;
    const [staged] = readdirSync(temporary);
    assert.ok(staged);
    assert.equal(statSync(join(temporary, staged)).mode & 0o777, 0o700);
    assert.equal(statSync(join(temporary, staged, "codex/auth.json")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(temporary, staged, "codex/auth.json"))).tokens.refresh_token, "");
    child.kill(signal);
    if (duplicate) {
      await new Promise(resolve => setTimeout(resolve, 30));
      child.kill(signal);
    }
  }
  await Promise.race([closed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("synthetic probe did not exit within 12 seconds")), 12000);
    closed.finally(() => clearTimeout(timer));
  })]);
  assert.equal(readFileSync(join(authHome, "auth.json"), "utf8"), source);
  assert.deepEqual({ staged: readdirSync(temporary), providerLive: ownedPid ? live(ownedPid) : false },
    { staged: [], providerLive: false }, "staged credentials or owned provider survived probe exit");
  if (ownedPid) await until(() => !live(ownedPid), "owned provider survived probe exit");
  assert.ok(!output.includes(access) && !output.includes("synthetic-refresh-secret") && !output.includes("synthetic-access-secret"));
  assert.ok(!errors.includes(access) && !errors.includes("synthetic-refresh-secret") && !errors.includes("synthetic-access-secret"));
  if (signal) {
    assert.equal(child.signalCode, null);
    assert.equal(child.exitCode, signal === "SIGINT" ? 130 : 143);
    assert.ok(output.includes('"interrupted":true'), output);
  }
  if (disposeFailure) assert.ok(output.includes('"cleanupFailed":true'), output);
  else assert.ok(output.includes('"cleanupFailed":false'), output);
  return output;
}

for (const stage of ["initialize", "prompt", "fallback"]) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`synthetic ${stage} interruption cleans staged credentials and owned provider (${signal})`,
      nativeIntegration, t => fixture(t, { stage, signal }));
  }
}
test("duplicate signals wait for owned provider escalation", nativeIntegration,
  t => fixture(t, { stage: "prompt", signal: "SIGTERM", duplicate: true, ignoreTerm: true }));
test("driver cleanup failure still removes staged credentials without raw error output", nativeIntegration,
  t => fixture(t, { stage: "prompt", signal: "SIGINT", disposeFailure: true }));
test("normal case completion cleans staged credentials", nativeIntegration,
  t => fixture(t, { stage: "complete" }));
test("provider startup failure cleans staged credentials", nativeIntegration,
  t => fixture(t, { stage: "initialize", startupFailure: true }));
test("failure before phase readiness still cleans the recorded provider", nativeIntegration,
  t => fixture(t, { stage: "initialize", setupFailure: true }));
