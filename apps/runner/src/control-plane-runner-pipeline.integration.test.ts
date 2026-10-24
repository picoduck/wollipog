import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import { linuxLeaseProcessProbe, proveLeaseAbandoned, type LeaseProcessEvidence } from "./provider-home-lease-evidence.js";
import { agentControlFifoRelayBase, sweepAgentControlFifoRelays } from "./agent-control-fifo-relay.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";

// Real control plane + real runner daemon + real mock-agent, end to end. This is the first test to
// exercise the runner's transport/reconnect module (apps/runner/src/index.ts) against a live control
// plane: a session created over the HTTP API drives a full mock-agent turn whose events must arrive
// on a real /ui subscription, and the session must survive a runner daemon restart (the historical
// "runner offline"/state-wipe locus).

import { transportRunnerEnvironment } from "./fixtures/transport-runner-environment.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MOCK_AGENT = fileURLToPath(new URL("../../mock-agent/index.mjs", import.meta.url));
const LEASE_AGENT = fileURLToPath(new URL("./fixtures/pipeline-lease-agent.mjs", import.meta.url));
const RUNNER_ID = "e2e-pipeline-runner";
const CONTROL_PLANE_TOKEN = "e2e-pipeline-control-plane-token";

// This dev machine exports dev-stack RUNNER_*/CONTROL_PLANE_* env that parseEnv would let override
// the runner's config file (and would point it at the real dev control plane). Strip every such key
// so the spawned processes are driven only by this test's explicit config/flags.
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_)/u.test(key)) delete env[key];
  }
  return env;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

// Race an exit against a timeout, cancelling the losing timer. A bare delay(ms) in the race would
// stay pending after a fast exit and keep the test worker alive for the full timeout (~5s/run).
async function exitedWithin(exited: Promise<void>, ms: number): Promise<boolean> {
  const controller = new AbortController();
  const timedOut = delay(ms, false, { signal: controller.signal }).catch(() => false);
  try {
    return await Promise.race([exited.then(() => true), timedOut]);
  } finally {
    controller.abort();
  }
}

async function stopChild(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  if (await exitedWithin(exited, graceMs)) return;
  child.kill("SIGKILL");
  assert.ok(await exitedWithin(exited, 3_000), "the test-owned child exited before its temporary state is removed");
}

// A minimal /ui inbox: buffer every JSON frame and let callers await the first one matching a
// predicate. take() consumes its match so a second take of the same predicate waits for a NEW frame.
type JsonObject = Record<string, unknown>;
class JsonInbox {
  private readonly queued: JsonObject[] = [];
  private readonly waiters = new Set<{ predicate: (m: JsonObject) => boolean; resolve: (m: JsonObject) => void }>();
  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      const object = message as JsonObject;
      for (const waiter of this.waiters) {
        if (!waiter.predicate(object)) continue;
        this.waiters.delete(waiter);
        waiter.resolve(object);
        return;
      }
      this.queued.push(object);
    });
  }
  take(predicate: (m: JsonObject) => boolean, timeoutMs = 30_000): Promise<JsonObject> {
    const existing = this.queued.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(this.queued.splice(existing, 1)[0]!);
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonObject) => {
          clearTimeout(timer);
          resolvePromise(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for a /ui frame"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

function eventPayload(message: JsonObject): { sessionId?: string; payload?: { kind?: string; text?: string; message?: string } } {
  return (message.event as { sessionId?: string; payload?: { kind?: string; text?: string; message?: string } } | undefined) ?? {};
}

function isTerminalTurnMessage(message: JsonObject, sessionId: string): boolean {
  if (message.type !== "session_event") return false;
  const event = eventPayload(message);
  return (
    event.sessionId === sessionId &&
    event.payload?.kind === "agent_message" &&
    typeof event.payload.text === "string" &&
    event.payload.text.includes("MOCK_NOTES.md")
  );
}

async function openUiSocket(wsBase: string, token: string): Promise<{ socket: WebSocket; inbox: JsonInbox }> {
  const socket = new WebSocket(`${wsBase}/ui?token=${encodeURIComponent(token)}`);
  const inbox = new JsonInbox(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the /ui socket failed to open")), { once: true });
  });
  return { socket, inbox };
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (child.exitCode !== null) throw new Error(`control plane exited early (${child.exitCode})\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      /* listen has not completed */
    }
    await delay(50);
  }
  throw new Error(`control plane did not become healthy\n${logs()}`);
}

type LeaseRecord = {
  version: number; state: "active" | "released"; pid: number; leaseId: string;
  previousLeaseId: string | null; previousRecordHash: string | null;
  process?: LeaseProcessEvidence;
};

// Read canonical records without changing the private registry. Check links against exact bytes,
// not timestamps or runner health; the journal may contain duplicate initialization mirrors.
function journal(home: string): Array<{ record: LeaseRecord; raw: string; hash: string }> {
  const root = join(home, ".agent-manager/provider-home-leases-v1");
  const unique = new Map<string, { record: LeaseRecord; raw: string; hash: string }>();
  for (const dir of [root, join(root, "mutable-home.lock")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const raw = readFileSync(join(dir, name), "utf8");
      const record = JSON.parse(raw) as LeaseRecord;
      if (record.state !== "active" && record.state !== "released") continue;
      const hash = createHash("sha256").update(raw).digest("hex");
      unique.set(hash, { record, raw, hash });
    }
  }
  const entries = [...unique.values()];
  const successors = new Set(entries.map(({ record }) => record.previousLeaseId));
  const tip = entries.filter(({ record }) => !successors.has(record.leaseId));
  assert.equal(tip.length, 1, "the canonical journal has exactly one tip");
  const ordered = [tip[0]!];
  while (ordered[0]!.record.previousLeaseId) {
    const current = ordered[0]!;
    const previous = entries.find(({ record }) => record.leaseId === current.record.previousLeaseId);
    assert.ok(previous, "every predecessor remains in the journal");
    assert.equal(current.record.previousRecordHash, previous.hash, "successor hashes exact predecessor bytes");
    assert.ok(!ordered.includes(previous), "the journal is acyclic");
    ordered.unshift(previous);
  }
  assert.equal(ordered.length, entries.length, "every canonical record belongs to the chain");
  return ordered;
}

async function until(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(50);
  }
}

function liveFixtureProcess(pid: number, startedAt: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    return stat[19] === startedAt && stat[0] !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasFixtureAncestor(pid: number, ancestor: { pid: number; startedAt: string }): boolean {
  // tsx/cli is a supervisor itself: its Node child is the daemon that records the lease.
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (pid === ancestor.pid) return liveFixtureProcess(pid, ancestor.startedAt);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    pid = Number(stat[1]);
  }
  return false;
}

type FixtureIdentity = { pid: number; startedAt: string };

function ownedFixtureTree(root: FixtureIdentity): FixtureIdentity[] {
  if (!liveFixtureProcess(root.pid, root.startedAt)) return [];
  const owned: FixtureIdentity[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
      if (hasFixtureAncestor(pid, root)) owned.push({ pid, startedAt: stat[19]! });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return owned;
}

function killFixtureIdentity(entry: FixtureIdentity): void {
  if (!liveFixtureProcess(entry.pid, entry.startedAt)) return;
  try { process.kill(entry.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function abandonmentInspection(record: LeaseRecord, scannerPid: number, fixturePids: number[]) {
  assert.ok(record.process, "the recorded runner has lifecycle evidence");
  const probe = linuxLeaseProcessProbe("/proc", process.getuid?.(), scannerPid);
  assert.ok(probe, "Linux process inspection is available");
  let scan: { marked: number[]; uninspectable: number[] } | undefined;
  const result = proveLeaseAbandoned(record.process, record.pid, {
    ...probe,
    scan: (marker, startTime) => {
      scan = probe.scan(marker, startTime);
      return scan;
    },
  });
  // Counts and fixed reasons only: never log process environments, markers, or private paths.
  return {
    result,
    markedProcesses: scan?.marked.length ?? 0,
    markedFixtureProcesses: scan?.marked.filter((pid) => fixturePids.includes(pid)).length ?? 0,
    uninspectableProcesses: scan?.uninspectable.filter((pid) => pid !== -1).length ?? 0,
    settled: !scan?.uninspectable.includes(-1),
  };
}

for (const stopMode of ["smoke", "SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "second-signal", "supervisor-stop", "supervisor-teardown"] as const) {
  test(
    stopMode === "smoke" ? "a session created over the control plane drives a mock-agent turn to /ui and survives a runner restart"
      : stopMode === "SIGKILL" || stopMode === "second-signal"
        ? `provider-HOME pipeline refuses handoff after ${stopMode} while a descendant survives`
      : stopMode === "supervisor-teardown" ? "provider-HOME pipeline teardown reaps the inner daemon after forced supervisor exit"
      : `provider-HOME pipeline handoff after ${stopMode}: journal ownership and completed turns`,
    { timeout: 120_000, skip: stopMode !== "smoke" && process.platform !== "linux" ? "lease process evidence uses Linux procfs" : false },
    async (t) => {
      const port = await reservePort();
      const httpBase = `http://127.0.0.1:${port}`;
      const wsBase = `ws://127.0.0.1:${port}`;
      const temp = mkdtempSync(join(tmpdir(), "wollipog-e2e-pipeline-"));
      const databasePath = join(temp, "control-plane.db");
      const workspaceDir = join(temp, "workspace");
      const runnerDataDir = join(temp, "runner-data");
      const runnerHome = join(temp, "home");
      const runnerBin = join(temp, "bin");
      const configPath = join(temp, "runner.config.json");
      const fixtureProcesses = join(temp, "provider-processes.jsonl");
      const supervisedRunner = join(temp, "supervised-runner.json");
      const descendants = () => existsSync(fixtureProcesses)
        ? readFileSync(fixtureProcesses, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; startedAt: string; kind: string })
        : [];
      const killFixtureProcesses = async () => {
        for (const entry of descendants()) killFixtureIdentity(entry);
        await until(() => descendants().every((entry) => !liveFixtureProcess(entry.pid, entry.startedAt)), "only this fixture's provider processes should be gone");
      };
      mkdirSync(workspaceDir, { recursive: true });
      mkdirSync(runnerHome, { recursive: true });
      mkdirSync(runnerBin);
      if (process.platform === "linux") symlinkSync(process.execPath, join(runnerBin, "node"));

      // The control plane loads-or-creates its local device (owner) token beside the DB. Materialize it
      // first so the test can authenticate owner HTTP calls and the /ui route with a known secret.
      const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));

      let cpOutput = "";
      const controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
        cwd: REPO_ROOT,
        env: {
          ...transportRunnerEnvironment(temp),
          RUNNER_DATA_DIR: runnerDataDir,
          HOME: runnerHome,
          USERPROFILE: runnerHome,
          XDG_CONFIG_HOME: join(runnerHome, ".config"),
          XDG_DATA_HOME: join(runnerHome, ".local", "share"),
          XDG_STATE_HOME: join(runnerHome, ".local", "state"),
          XDG_CACHE_HOME: join(runnerHome, ".cache"),
          CONTROL_PLANE_HOST: "127.0.0.1",
          CONTROL_PLANE_PORT: String(port),
          CONTROL_PLANE_DB: databasePath,
          CONTROL_PLANE_TOKEN,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const captureCp = (chunk: unknown) => {
        cpOutput = (cpOutput + String(chunk)).slice(-65_536);
      };
      controlPlane.stdout?.on("data", captureCp);
      controlPlane.stderr?.on("data", captureCp);

      let runner: ChildProcess | null = null;
      let runnerOutput = "";
      const captureRunner = (chunk: unknown) => {
        runnerOutput = (runnerOutput + String(chunk)).slice(-65_536);
      };
      const uiSockets = new Set<WebSocket>();

      let runnerStarts = 0;
      const spawnRunner = (): ChildProcess => {
        const supervised = (stopMode === "supervisor-stop" || stopMode === "supervisor-teardown") && runnerStarts++ === 0;
        const args = supervised
          ? [fileURLToPath(new URL("./fixtures/pipeline-lease-supervisor.mjs", import.meta.url)), configPath, supervisedRunner]
          : ["--import", "tsx", "apps/runner/src/cli.ts", "--config", configPath];
        const child = spawn(process.execPath, args, {
          cwd: REPO_ROOT,
          // Isolate HOME so the runner's native provider-home lease targets this temp dir instead of the
          // shared user home — otherwise it collides with any real runner (e.g. a dev stack) on this box.
          env: {
            ...hermeticEnv(),
            // Keep developer-specific provider installations out of PATH (#3208). The current
            // Node remains available to generated helper scripts; native tools use system bins.
            ...(process.platform === "linux" ? { PATH: [runnerBin, "/usr/bin", "/bin"].join(":") } : {}),
            HOME: runnerHome,
            USERPROFILE: runnerHome,
            XDG_CONFIG_HOME: join(runnerHome, ".config"),
            XDG_DATA_HOME: join(runnerHome, ".local", "share"),
            XDG_STATE_HOME: join(runnerHome, ".local", "state"),
            XDG_CACHE_HOME: join(runnerHome, ".cache"),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        child.stdout?.on("data", captureRunner);
        child.stderr?.on("data", captureRunner);
        return child;
      };

      let cleaned = false;
      const supervisedCleanup = new Map<string, FixtureIdentity>();
      const cleanup = async (graceMs = 20_000): Promise<void> => {
        if (cleaned) return;
        for (const socket of uiSockets) {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        }
        // Capture BEFORE stopping either supervisor: parent links disappear when tsx/cli dies.
        // Keep PID/start-time identities so forced teardown reaches its real inner daemon too.
        if (existsSync(supervisedRunner)) {
          const launcher = JSON.parse(readFileSync(supervisedRunner, "utf8")) as FixtureIdentity;
          for (const entry of ownedFixtureTree(launcher)) supervisedCleanup.set(`${entry.pid}:${entry.startedAt}`, entry);
        }
        if (runner) await stopChild(runner, graceMs);
        for (const entry of supervisedCleanup.values()) killFixtureIdentity(entry);
        await until(() => [...supervisedCleanup.values()].every((entry) => !liveFixtureProcess(entry.pid, entry.startedAt)),
          "the supervisor, launcher, and real daemon must be gone before deleting temporary state", 3_000);
        await killFixtureProcesses();
        await stopChild(controlPlane);
        // SIGKILL can leave the runner's intentionally unlistable 0300 FIFO relay directories.
        // After every owned process is gone, use the same targeted sweep as runner startup;
        // ordinary rmSync cannot list these directories, even though this user owns them.
        const fifoBase = agentControlFifoRelayBase(join(runnerDataDir, "agent-control"));
        const fifoMode = existsSync(fifoBase) ? (lstatSync(fifoBase).mode & 0o777).toString(8) : null;
        const gracefulFifoLeak = graceMs > 0 && runner?.exitCode === 0 && fifoMode !== null;
        const removedFifos = sweepAgentControlFifoRelays(fifoBase);
        assert.equal(existsSync(fifoBase), false, "stale FIFO relay permissions were settled before recursive removal");
        if (stopMode === "supervisor-teardown") {
          t.diagnostic(`forced teardown: recordedLiveProcesses=${[...supervisedCleanup.values()].filter((entry) => liveFixtureProcess(entry.pid, entry.startedAt)).length}, staleFifoMode=${fifoMode}, removedFifoChannels=${removedFifos}`);
        }
        rmSync(temp, { recursive: true, force: true });
        cleaned = true;
        // Still clean up on failure, but never let the crash sweep hide a graceful-shutdown leak.
        assert.equal(gracefulFifoLeak, false, "a gracefully exited runner must remove its FIFO relay base without the test sweep");
      };
      t.after(() => cleanup());

      await waitForHealth(httpBase, controlPlane, () => cpOutput);

      // Issue a runner credential the way an operator would: an owner POST for a brand-new runner id.
      const credentialResponse = await fetch(`${httpBase}/api/runner-credentials`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ runnerId: RUNNER_ID, label: "E2E pipeline" }),
      });
      assert.equal(credentialResponse.status, 201, `credential issue failed\n${cpOutput}`);
      const runnerToken = (await credentialResponse.json() as { token: string }).token;
      assert.match(runnerToken, /^wollipogr_[A-Za-z0-9_-]{43}$/u);

      // Point the runner daemon at the real control plane with the mock ACP agent as its only agent.
      writeFileSync(
        configPath,
        JSON.stringify({
          runnerId: RUNNER_ID,
          controlPlaneUrl: `${wsBase}/runner`,
          token: runnerToken,
          dataDir: runnerDataDir,
          workspaces: [{ id: "repo", name: "Repo", path: workspaceDir }],
          agents: [
            {
              id: "mock",
              name: "Mock",
              command: process.execPath,
              args: [stopMode === "smoke" ? MOCK_AGENT : LEASE_AGENT],
              driver: "acp",
              context: { kind: "native" },
              // Advertise ACP session resume so the persisted session can be continued (rather than
              // going read-only) after the runner daemon restarts and re-attaches to it.
              env: { HOME: runnerHome, WOLLIPOG_MOCK_SESSION_LIFECYCLE: "resume", WOLLIPOG_PIPELINE_PROCESSES: fixtureProcesses },
            },
          ],
        }),
      );

      runner = spawnRunner();

      // Subscribe a real /ui client before we create the session, then target the session so live
      // events are delivered (the /ui route drops events for sessions a client has not subscribed to).
      const { socket: ui, inbox: uiInbox } = await openUiSocket(wsBase, ownerToken);
      uiSockets.add(ui);
      await uiInbox.take((m) => m.type === "snapshot");

      // Poll session creation until the runner has registered and is advertising its mock agent.
      let sessionId = "";
      for (let attempt = 0; attempt < 300; attempt++) {
        assert.equal(runner.exitCode, null, `runner exited before registering\n${runnerOutput}`);
        const created = await fetch(`${httpBase}/api/sessions`, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ runnerId: RUNNER_ID, workspaceId: "repo", agentId: "mock", useWorktree: false, prompt: "Please jot a quick note about the pipeline" }),
        });
        if (created.status === 201) {
          sessionId = (await created.json() as { id: string }).id;
          break;
        }
        await delay(100);
      }
      assert.ok(sessionId, `session was never created (runner never registered)\n${runnerOutput}`);

      ui.send(JSON.stringify({ type: "session_subscriptions", revision: 1, sessionIds: [sessionId], podIds: [] }));
      await uiInbox.take(
        (m) => m.type === "session_subscriptions_applied" && (m.revision as number) === 1,
      );

      const sessionStatus = async (): Promise<string> => {
        const response = await fetch(`${httpBase}/api/sessions/${sessionId}`, {
          headers: { authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(response.status, 200);
        return ((await response.json()) as { session: { status: string } }).session.status;
      };

      const waitForIdle = async (): Promise<void> => {
        for (let attempt = 0; attempt < 300; attempt++) {
          if ((await sessionStatus()) === "idle") return;
          await delay(100);
        }
        throw new Error(`session never returned to idle\n${runnerOutput}`);
      };

      // Turn 1: the session was created with an initial prompt, so the runner drives a full mock-agent
      // turn. Its terminal agent message ("… wrote MOCK_NOTES.md …") must arrive on the /ui subscription.
      const firstTurn = await uiInbox
        .take((m) => isTerminalTurnMessage(m, sessionId))
        .catch((error) => {
          throw new Error(`${(error as Error).message}\n=== RUNNER OUTPUT ===\n${runnerOutput}`);
        });
      assert.match(
        eventPayload(firstTurn).payload?.text ?? "",
        /MOCK_NOTES\.md/,
        "the first turn's terminal agent message reached /ui",
      );
      await waitForIdle();

      if (stopMode === "supervisor-teardown") {
        const launcher = JSON.parse(readFileSync(supervisedRunner, "utf8")) as FixtureIdentity;
        const tree = ownedFixtureTree(launcher);
        assert.ok(tree.length >= 2, "the launcher and its real inner daemon are both alive before teardown");
        // Exercise cleanup directly before the ordinary stop step, as an assertion failure would.
        // A zero grace period forces the escalation path instead of waiting for normal draining.
        await cleanup(0);
        assert.ok(tree.every((entry) => !liveFixtureProcess(entry.pid, entry.startedAt)), "forced teardown left no recorded process alive");
        assert.equal(existsSync(temp), false, "temporary state was removed only after the owned processes exited");
        return;
      }

      // Restart the runner daemon. The session (persisted in the runner's store and the control plane
      // DB) must survive the restart: after the daemon reconnects and resumes it, a fresh prompt must
      // drive another full turn whose terminal message again reaches the /ui subscription.
      let before: ReturnType<typeof journal> = [];
      const counts = () => Object.fromEntries(["process", "session", "provider"].map((kind) =>
        [kind, descendants().filter((entry) => entry.kind === kind).length]));
      const beforeCounts = counts();
      const survivorExpected = stopMode === "SIGKILL" || stopMode === "second-signal";
      const secondSignal = stopMode === "second-signal";
      if (stopMode === "smoke") {
        await stopChild(runner);
      } else {
        await until(() => descendants().some((entry) => entry.kind === "descendant" && liveFixtureProcess(entry.pid, entry.startedAt)), "provider descendant is alive before shutdown");
        before = journal(runnerHome);
        const held = before.at(-1)!;
        assert.equal(held.record.state, "active");
        if (stopMode === "supervisor-stop") {
          const launcher = JSON.parse(readFileSync(supervisedRunner, "utf8")) as { pid: number; startedAt: string };
          assert.ok(hasFixtureAncestor(held.record.pid, launcher), "the daemon owning the HOME is inside this fixture's supervisor tree");
        } else {
          assert.equal(held.record.pid, runner.pid, "the real daemon acquired this provider HOME");
        }
        assert.ok(held.record.process, "the active record contains actual runner lifecycle evidence");
        const exited = new Promise<void>((resolvePromise) => runner!.once("exit", () => resolvePromise()));
        const shutdownOutputStart = runnerOutput.length;
        assert.ok(runner.kill(secondSignal || stopMode === "supervisor-stop" ? "SIGTERM" : stopMode));
        if (secondSignal) {
          await until(() => runnerOutput.slice(shutdownOutputStart).includes("shutting down"), "the first signal entered the pending-kill drain");
          assert.ok(runner.kill("SIGINT"));
        }
        assert.ok(await exitedWithin(exited, 20_000), "runner shutdown finishes without test SIGKILL fallback");
        if (survivorExpected) {
          assert.deepEqual(journal(runnerHome), before, "forced exit preserves exact active journal evidence");
          assert.ok(descendants().some((entry) => liveFixtureProcess(entry.pid, entry.startedAt)), "a provider descendant survives the forced exit");
        } else {
          assert.equal(runner.exitCode, 0);
          assert.ok(descendants().every((entry) => !liveFixtureProcess(entry.pid, entry.startedAt)), "graceful shutdown drained detached TERM-ignoring descendants");
          const released = journal(runnerHome);
          assert.equal(released.at(-1)!.record.state, "released", "shutdown publishes release after draining descendants");
          assert.equal(released.at(-1)!.record.previousLeaseId, held.record.leaseId);
          assert.deepEqual(released.slice(0, before.length), before, "shutdown preserves predecessor bytes");
        }

      }

      // Wait until the control plane has fully processed the old socket's close (onGone -> offline)
      // BEFORE spawning the replacement. Otherwise the resume prompt below could be routed to the
      // still-mapped dead socket (hub.sendToRunner buffers into a closed socket and returns 200), be
      // lost, and time out the second turn. With no replacement running yet, the runner cannot flip
      // back online in the meantime, so this poll is race-free.
      let sawOffline = false;
      for (let attempt = 0; attempt < 300 && !sawOffline; attempt++) {
        const response = await fetch(`${httpBase}/api/runners`, { headers: { authorization: `Bearer ${ownerToken}` } });
        assert.equal(response.status, 200);
        const runners = (await response.json() as { runners: { runnerId: string; status: string }[] }).runners;
        sawOffline = runners.find((r) => r.runnerId === RUNNER_ID)?.status === "offline";
        if (!sawOffline) await delay(100);
      }
      assert.ok(sawOffline, `control plane never observed the old runner go offline after restart\n${runnerOutput}`);

      runner = spawnRunner();

      // HTTP acceptance alone is not success: a failed launch also acknowledges a prompt.
      const sendPrompt = async (text: string): Promise<void> => {
        let lastResponse = "none";
        try {
          await until(async () => {
            assert.equal(runner!.exitCode, null, `replacement exited before reconnecting\n${runnerOutput}`);
            const response = await fetch(`${httpBase}/api/sessions/${sessionId}/prompt`, {
              method: "POST",
              headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
              body: JSON.stringify({ text }),
            });
            if (response.status === 200) return true;
            const detail = (await response.text()).slice(0, 512);
            lastResponse = `${response.status}: ${detail}`;
            assert.ok(!detail.includes("session is failed"), `a failed session requires Restart before another prompt: ${detail}`);
            assert.ok([409, 503].includes(response.status), `unexpected prompt response: ${response.status}`);
            return false;
          }, "replacement never accepted a prompt");
        } catch (error) {
          const old = before.at(-1)?.record;
          const proof = old ? abandonmentInspection(old, runner!.pid!, descendants().map((entry) => entry.pid)) : null;
          throw new Error(`${(error as Error).message}; last HTTP response=${lastResponse}; read-only abandonment=${JSON.stringify(proof)}\n${runnerOutput}`, { cause: error });
        }
      };

      if (survivorExpected) {
        await sendPrompt("Try while the old provider descendant is still alive");
        const refusal = await uiInbox.take((message) => {
          const event = eventPayload(message);
          return message.type === "session_event" && event.sessionId === sessionId && event.payload?.kind === "error";
        }).catch((error) => {
          const inspection = abandonmentInspection(before.at(-1)!.record, runner!.pid!, descendants().map((entry) => entry.pid));
          throw new Error(`${(error as Error).message}; read-only abandonment=${JSON.stringify(inspection)}\n${runnerOutput}`, { cause: error });
        });
        const inspection = abandonmentInspection(before.at(-1)!.record, runner.pid!, descendants().map((entry) => entry.pid));
        t.diagnostic(`surviving crash boundary at refusal: ${JSON.stringify(inspection)}`);
        assert.ok(eventPayload(refusal).payload?.message?.endsWith(LEASE_WORKER_ERRORS.process_survivor),
          `expected the specific process-survivor refusal, received ${JSON.stringify(eventPayload(refusal).payload)}`);
        assert.deepEqual(inspection.result, { proven: false, reason: "marked_process" },
          `busy refusal must be caused by a marked survivor, not an unrelated unreadable process: ${JSON.stringify(inspection)}`);
        assert.ok(inspection.markedFixtureProcesses > 0, "the proof identifies this fixture's surviving marked provider");
        assert.deepEqual(journal(runnerHome), before, "a refused replacement cannot append or release ownership");
        assert.ok(descendants().some((entry) => liveFixtureProcess(entry.pid, entry.startedAt)), "the refusal was observed while the old provider survived");
        const refusedCounts = counts();
        // Discovery independently invokes this executable for initialize-only probes. Preserve
        // that observation instead of claiming a lease refusal prevents every executable launch.
        t.diagnostic(`ACP executable/session/turn counts: before restart=${JSON.stringify(beforeCounts)}, at refusal=${JSON.stringify(refusedCounts)}`);
        assert.equal(refusedCounts.session, beforeCounts.session, "refusal did not initialize another provider session");
        assert.equal(refusedCounts.provider, beforeCounts.provider, "refusal did not start another provider turn");
        // This is case 3's terminal outcome. Do not pretend prompting the now-failed session is
        // a recovery attempt; phase 2 verifies the recorded-boundary replacement turn.
        return;
      }

      await sendPrompt("Note again after the runner restart");

      const secondTurn = await uiInbox
        .take((m) => isTerminalTurnMessage(m, sessionId))
        .catch((error) => {
          throw new Error(`${(error as Error).message}\n=== RUNNER OUTPUT ===\n${runnerOutput}`);
        });
      assert.match(
        eventPayload(secondTurn).payload?.text ?? "",
        /MOCK_NOTES\.md/,
        "a full turn completes and reaches /ui after the runner restarts",
      );
      await waitForIdle();
      assert.match(readFileSync(join(workspaceDir, "MOCK_NOTES.md"), "utf8"), /Note again after the runner restart/,
        "the replacement completed the new prompt, not a replay of the old turn");
      if (stopMode !== "smoke") {
        const succeeded = journal(runnerHome);
        assert.equal(succeeded.at(-1)!.record.state, "active");
        assert.equal(succeeded.at(-1)!.record.pid, runner.pid, "replacement owns the HOME and completed a provider turn");
        assert.deepEqual(succeeded.slice(0, before.length), before, "handoff keeps every predecessor byte");
      }
    },
  );
}

// Phase 2 must use #3584's recorded-boundary proof in a delegated scope, rather than the
// legacy whole-user scan: CI reproduced a fail-closed uninspectable-process refusal even
// after fixture cleanup. These positive recovery modes require real recorded evidence.
test.todo("provider-HOME recovery after SIGKILL with an empty recorded boundary (phase 2, #3584 delegated scope)");
test.todo("provider-HOME recovery after second-signal exit with an empty recorded boundary (phase 2, #3584 delegated scope)");
// Keep an unrelated non-dumpable same-user process alive throughout the recorded-boundary restart.
test.todo("provider-HOME recovery with an unrelated unreadable process left alive (phase 2, #3584 recorded boundary)");
