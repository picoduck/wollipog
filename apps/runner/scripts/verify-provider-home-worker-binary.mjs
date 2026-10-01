/** Run the actual source/SEA daemon against an isolated loopback peer and empty skill sync.
 * No provider is launched. Exercises SessionManager -> async facade -> fixed worker -> native I/O. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = process.argv.includes("--source"), maximal = process.argv.includes("--maximal");
const packaged = process.argv.includes("--packaged");
const packageDir = join(repo, "apps/runner/dist-bin");
const packagedNames = packaged ? readdirSync(packageDir).filter(name => /^wollipog-runner-/u.test(name)) : [];
if (packaged) assert.equal(packagedNames.length, 1, "fixture expects exactly one native packaged runner");
const binary = source ? process.execPath : packaged ? join(packageDir, packagedNames[0]) : resolve(process.argv[2]);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const protocol = Number(readFileSync(join(repo, "packages/protocol/src/index.ts"), "utf8").match(/export const PROTOCOL_VERSION = (\d+);/u)[1]);
const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-worker-daemon-")));
const home = join(root, "home"), temp = join(root, "tmp"), emptyBin = join(root, "bin");
for (const path of [home, temp, emptyBin]) mkdirSync(path, { mode: 0o700 });
const instanceId = randomUUID(), runnerId = "isolated-lease-worker", interval = maximal ? 10_000 : 100;
const children = [], peers = [], states = new Map();
let output = "", lastHeartbeat = 0, delays = [], measuring = false;
const wss = new WebSocketServer({ noServer: true });
const server = createServer((request, response) => {
  if (request.url?.includes("/runner/attestation/")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "wollipog-control-plane", instanceId, protocolVersion: protocol }));
  } else response.writeHead(404).end();
});
server.on("upgrade", (request, socket, head) => wss.handleUpgrade(request, socket, head, peer => {
  const record = { peer, registered: false }; peers.push(record);
  peer.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "register" || message.type === "agents_updated") {
      assert.ok((message.agents ?? []).every(agent => agent.available === false),
        "fixture must not discover a live provider");
    }
    if (message.type === "register") {
      record.registered = true;
      peer.send(JSON.stringify({ type: "registered", ok: true, serverTime: Date.now(), heartbeatIntervalMs: interval, protocolVersion: protocol }));
    } else if (message.type === "heartbeat" && record === peers[0] && measuring) {
      const now = performance.now(); delays.push(Math.max(0, now - lastHeartbeat - interval)); lastHeartbeat = now;
    } else if (message.type === "skills_state" && message.requestId) states.set(message.requestId, message);
  });
}));

async function until(predicate, description, ms = 30_000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    assert.ok(performance.now() < end, `${description}\n${output}`);
    await pause(10);
  }
}

function launchDaemon(file, args, options) {
  if (process.platform !== "win32") return spawn(file, args, options);
  // A private pseudoconsole can deliver actual Ctrl+C/SIGINT. child.kill(SIGTERM) on Windows
  // force-terminates a process and cannot prove the daemon's orderly shutdown/release path.
  const terminal = createRequire(import.meta.url)("node-pty").spawn(file, args, {
    cwd: options.cwd, env: options.env, cols: 120, rows: 40, useConpty: true,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: terminal.pid, exitCode: null, signalCode: null,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill(signal) {
      if (signal === "SIGTERM") terminal.write("\x03");
      else {
        // Force only this ConPTY's exact launched daemon PID; closing a console is not a
        // substitute for the deliberately abrupt owner-death scenario. Await native onExit.
        try { process.kill(terminal.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    },
  });
  terminal.onData(data => child.stdout.emit("data", data));
  terminal.on("error", error => child.emit("error", error));
  terminal.onExit(({ exitCode }) => {
    // node-pty's Windows native wait callback supplies this code; bare pipe/PTY closure with no
    // process exit receipt must never enable recovery, fixture-root deletion or graceful proof.
    if (!Number.isSafeInteger(exitCode)) { child.emit("error", new Error("unproved ConPTY daemon exit")); return; }
    child.exitCode = exitCode;
    child.emit("close", exitCode, null);
  });
  return child;
}
async function start(dataDir) {
  mkdirSync(dataDir, { mode: 0o700 });
  const config = `${dataDir}.config.json`;
  writeFileSync(config, JSON.stringify({ runnerId, controlPlaneUrl: `ws://127.0.0.1:${server.address().port}/runner`,
    token: "isolated-smoke-token", dataDir, agents: [], workspaces: [], features: { acpRegistry: false } }));
  // Windows needs its system tools for the fixed PowerShell helper; PATH provider entries are
  // removed, and each conventional user install root points into this fixture.
  const inherited = process.platform === "win32"
    ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])) : process.env;
  const systemPath = process.platform === "win32" ? `${inherited.SYSTEMROOT}\\System32;${inherited.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0` : "/usr/bin:/bin";
  const child = launchDaemon(binary, [...(source ? ["--import", loader, join(repo, "apps/runner/src/cli.ts")] : []), "--config", config], {
    cwd: dataDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...inherited, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "local"), APPDATA: join(home, "roaming"),
      TMPDIR: temp, TMP: temp, TEMP: temp, PATH: source ? systemPath : process.platform === "win32" ? systemPath : emptyBin,
      RUNNER_ID: runnerId, RUNNER_DATA_DIR: dataDir, RUNNER_TOKEN: "isolated-smoke-token",
      CONTROL_PLANE_URL: `ws://127.0.0.1:${server.address().port}/runner` },
  });
  children.push(child); child.stdout.on("data", b => { output = (output + b).slice(-65536); });
  child.stderr.on("data", b => { output = (output + b).slice(-65536); });
  child.on("error", error => { output += error.message; });
  await until(() => {
    assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output);
    return peers.length >= children.length && peers[children.length - 1].registered;
  }, "runner registration");
  assert.equal(child.exitCode, null, output);
  return { child, peer: peers[children.length - 1].peer, dataDir };
}
async function sync(runner, id) {
  // Registration can precede startup discovery. A discovery change during cold acquisition must
  // invalidate the old skill authorization; exercise a fresh authoritative request rather than
  // disabling that production fence. Only this explicit supersession is retryable in the fixture.
  for (let attempt = 0; attempt < 3; attempt++) {
    const requestId = `${id}-${attempt}`;
    runner.peer.send(JSON.stringify({ type: "skills_sync", runnerId, requestId, skills: [] }));
    await until(() => states.has(requestId), `skill sync ${requestId}`, maximal ? 300_000 : 60_000);
    const state = states.get(requestId);
    if (state.error !== "Skill synchronization was superseded while waiting for provider-home ownership.") return state;
  }
  throw new Error("startup skill authorization kept changing beyond the finite fixture retry budget");
}
function evidence() {
  const lease = join(home, ".agent-manager/provider-home-leases-v1");
  return [lease, join(lease, "mutable-home.lock")].flatMap(directory =>
    readdirSync(directory).filter(name => name.endsWith(".json")).map(name => {
      const path = join(directory, name), raw = readFileSync(path, "utf8");
      return { path, hash: createHash("sha256").update(raw).digest("hex"), record: JSON.parse(raw) };
    }));
}
function seed(ownerHash) {
  const lease = join(home, ".agent-manager/provider-home-leases-v1"), lock = join(lease, "mutable-home.lock");
  assert.equal(existsSync(lease), false, "preparation must precede every lease operation");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  let previous = { version: 2, state: "active", ownerHash, leaseId: randomUUID(), previousLeaseId: null, previousRecordHash: null,
    recoveredEntriesHash: createHash("sha256").update("[]").digest("hex"), pid: 999999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01", padding: "p".repeat(3300) };
  let raw = JSON.stringify(previous) + "\n", anchor = join(lease, "mutable-home.recovery.json");
  writeFileSync(anchor, raw, { mode: 0o600 }); linkSync(anchor, join(lock, "checkpoint.json")); linkSync(anchor, join(lock, `lease-${previous.leaseId}.json`));
  for (let i = 0; i < 4090; i++) {
    const next = { ...previous, recoveredEntriesHash: undefined, state: i % 2 === 0 ? "released" : "active", leaseId: randomUUID(),
      previousLeaseId: previous.leaseId, previousRecordHash: createHash("sha256").update(raw).digest("hex") };
    raw = JSON.stringify(next) + "\n"; const name = `next-${previous.leaseId}.json`;
    writeFileSync(join(lease, name), raw, { mode: 0o600 }); linkSync(join(lease, name), join(lock, name)); previous = next;
  }
}
async function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("close", (code, signaled) => resolveExit({ code, signaled }));
    child.once("error", rejectExit);
  });
  child.kill(signal);
  const controller = new AbortController();
  try {
    return await Promise.race([exit, pause(30_000, undefined, { signal: controller.signal }).then(() => { throw new Error(`daemon shutdown deadline\n${output}`); })]);
  } finally { controller.abort(); }
}

try {
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const first = await start(join(root, "runner-a"));
  if (maximal) seed(JSON.parse(readFileSync(join(first.dataDir, ".wollipog-runner-owner-v2.json"), "utf8")).ownerHash);
  lastHeartbeat = performance.now(); measuring = true;
  const begin = performance.now(); const result = await sync(first, "initial"); const operationDurationMs = performance.now() - begin;
  if (!maximal) await pause(1200);
  measuring = false;
  assert.equal(result.error, undefined, output);
  assert.ok(delays.length > 0, "actual daemon sent heartbeats during the measurement");
  assert.ok(Math.max(...delays) <= 500, `actual heartbeat dispatch delay ${Math.max(...delays)} ms`);
  const active = evidence().filter(item => item.record.state === "active" && item.record.pid === first.child.pid);
  assert.ok(active.length > 0, "the daemon worker published ownership using its parent PID");
  const before = evidence().map(({ path, hash }) => [path, hash]);
  const second = await start(join(root, "runner-b"));
  await sync(second, "contended");
  assert.match(output, /lease unavailable|already in use/iu);
  assert.deepEqual(evidence().map(({ path, hash }) => [path, hash]), before, "a second live runner cannot adopt private authority");
  await stop(first.child, "SIGKILL");
  await sync(second, "recovery");
  assert.ok(evidence().some(item => item.record.state === "active" && item.record.pid === second.child.pid), "actual runner death enables proved recovery");
  const stopped = await stop(second.child, "SIGTERM"); assert.equal(stopped.code, 0, output);
  assert.ok(evidence().some(item => item.record.state === "released" && item.record.pid === second.child.pid), "graceful shutdown awaited exact release");
  console.log(JSON.stringify({ mode: source ? "source-daemon" : "SEA-daemon", platform: process.platform, maximal,
    operationDurationMs, heartbeatIntervalMs: interval, heartbeatDispatches: delays.length, maxHeartbeatDelayMs: Math.max(...delays),
    liveOwnerRefused: true, killedRunnerRecovered: true, gracefulReleaseProved: true }));
} finally {
  for (const child of children) await stop(child, "SIGKILL");
  for (const { peer } of peers) peer.terminate();
  await new Promise(resolveClose => wss.close(resolveClose));
  await new Promise(resolveClose => server.close(resolveClose));
  rmSync(root, { recursive: true, force: true });
}
