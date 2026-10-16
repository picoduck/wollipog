import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { RunnerCredentialSecret } from "@wollipog/protocol";
import {
  BoxOrchestrator,
  MAX_TUNNEL_PORT_ATTEMPTS,
  REMOTE_TUNNEL_PORT_MAX,
  REMOTE_TUNNEL_PORT_MIN,
  bootstrapFailureMessage,
  pickRemoteTunnelPort,
  remoteForwardFailurePort,
} from "./box-orchestrator.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

const BOX_ID = "box-0123abcd";
const RUNNER_ID = "box-runner";

/** One SSH account's loopback ports, shared by every simulated control plane that targets it. */
class FakeRemoteHost {
  readonly listeners = new Map<number, string>();
  /** When set, a killed tunnel's listener stays bound (sshd has not noticed the drop yet). */
  lingerOnKill = false;
}

type FakeTunnel = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(): boolean;
};

interface SimulatedControlPlane {
  db: ControlPlaneDb;
  orchestrator: BoxOrchestrator;
  /** Remote listen port of every tunnel this control plane spawned, in order. */
  attempts: number[];
  /** Tunnels that bound their port and are still running. */
  live: Map<number, FakeTunnel>;
}

function boxDb(autoReconnect = true): ControlPlaneDb {
  const db = ControlPlaneDb.open(":memory:");
  db.createBox({
    boxId: BOX_ID,
    runnerId: RUNNER_ID,
    sshTarget: "me@shared-host",
    sshPort: 22,
    workspaces: [{ id: "home", name: "home", path: "." }],
    autoReconnect,
    runnerDataDir: `.agent-manager/runner-data/${BOX_ID}`,
    now: 1,
  });
  return db;
}

/** A control plane whose ssh tunnels bind ports on `host` the way OpenSSH with
 * ExitOnForwardFailure does: an occupied port fails before the remote command runs. */
function controlPlane(host: FakeRemoteHost, label: string, db = boxDb()): SimulatedControlPlane {
  const attempts: number[] = [];
  const live = new Map<number, FakeTunnel>();
  let credentials = 0;
  let orchestrator: BoxOrchestrator;
  const spawnTunnel = (args: string[]): ChildProcess => {
    const forward = args[args.indexOf("-R") + 1] ?? "";
    assert.match(forward, /^\d+:127\.0\.0\.1:4317$/, "the remote listener stays loopback-only");
    const port = Number(forward.split(":")[0]);
    attempts.push(port);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill(): boolean {
        child.killed = true;
        setImmediate(() => {
          live.delete(port);
          if (!host.lingerOnKill && host.listeners.get(port) === label) host.listeners.delete(port);
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
          child.stderr.emit("end");
        });
        return true;
      },
    }) as FakeTunnel;
    setImmediate(() => {
      if (host.listeners.has(port)) {
        // Node may deliver exit before the stderr chunk that names the port; model that order.
        child.exitCode = 255;
        child.emit("exit", 255, null);
        setImmediate(() => {
          child.stderr.emit("data", Buffer.from(`Error: remote port forwarding failed for listen port ${port}\n`));
          child.stderr.emit("end");
        });
        return;
      }
      host.listeners.set(port, label);
      live.set(port, child);
      orchestrator.onRunnerRegistered(RUNNER_ID, `rcred_${"0".repeat(32)}`);
    });
    return child as unknown as ChildProcess;
  };
  orchestrator = new BoxOrchestrator({
    db,
    hub: { boxChanged() {} } as unknown as Hub,
    cpPort: 4317,
    issueCredential: () => ({
      credential: { credentialId: `rcred_${(credentials++).toString(16).padStart(32, "0")}` },
      token: "runner-token",
    }) as unknown as RunnerCredentialSecret,
    resolveBinary: async () => ({ path: "/local/runner", sha256: "e".repeat(64), source: "staged" }),
    spawnTunnel,
    // Every control plane starts from the same first port, the worst case the old fixed
    // allocator always produced.
    randomIndex: () => 0,
  });
  const harness = orchestrator as unknown as {
    detectTriple(): Promise<string>;
    remoteRunnerMatches(): Promise<boolean>;
    deployTokenFile(): Promise<void>;
  };
  harness.detectTriple = async () => "x86_64-unknown-linux-gnu";
  harness.remoteRunnerMatches = async () => true;
  harness.deployTokenFile = async () => {};
  return { db, orchestrator, attempts, live };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const status = (cp: SimulatedControlPlane) => cp.db.getBox(BOX_ID)?.status;

test("remote tunnel ports are picked from the range, wrap, and skip occupied ports", () => {
  assert.equal(pickRemoteTunnelPort(new Set(), () => 0), REMOTE_TUNNEL_PORT_MIN);
  assert.equal(pickRemoteTunnelPort(new Set([REMOTE_TUNNEL_PORT_MIN]), () => 0), REMOTE_TUNNEL_PORT_MIN + 1);
  const span = REMOTE_TUNNEL_PORT_MAX - REMOTE_TUNNEL_PORT_MIN + 1;
  assert.equal(pickRemoteTunnelPort(new Set([REMOTE_TUNNEL_PORT_MAX]), () => span - 1), REMOTE_TUNNEL_PORT_MIN);
  const all = new Set(Array.from({ length: span }, (_, i) => REMOTE_TUNNEL_PORT_MIN + i));
  assert.equal(pickRemoteTunnelPort(all, () => 0), null);
});

test("only ssh's forward-failure message identifies an occupied tunnel port", () => {
  assert.equal(remoteForwardFailurePort("Error: remote port forwarding failed for listen port 47100\n"), 47100);
  assert.equal(remoteForwardFailurePort("me@host: Permission denied (publickey)."), null);
  assert.equal(remoteForwardFailurePort("ssh: connect to host h port 22: Connection refused"), null);
});

test("bootstrap failures name the SSH, installation, or credential stage", () => {
  assert.equal(
    bootstrapFailureMessage("connect", "ssh me@h: Permission denied (publickey)."),
    "SSH connection failed: ssh me@h: Permission denied (publickey).",
  );
  assert.equal(bootstrapFailureMessage("connect", "unsupported remote platform: Plan9"), "unsupported remote platform: Plan9");
  assert.match(bootstrapFailureMessage("install", "scp failed: disk full"), /^Runner installation failed: scp failed/);
  assert.match(bootstrapFailureMessage("credential", "ssh exited 1"), /^Runner credential deployment failed:/);
});

test("a second control plane on the same SSH account moves to a free port without touching the first tunnel", async () => {
  const host = new FakeRemoteHost();
  const a = controlPlane(host, "A");
  a.orchestrator.add(BOX_ID);
  await waitFor(() => status(a) === "online", "control plane A online");
  const firstTunnel = a.live.get(REMOTE_TUNNEL_PORT_MIN);
  assert.ok(firstTunnel);

  // B has automatic reconnect off: port recovery is part of connecting, not of reconnecting.
  const b = controlPlane(host, "B", boxDb(false));
  b.orchestrator.add(BOX_ID);
  await waitFor(() => status(b) === "online", "control plane B online");

  assert.deepEqual(b.attempts, [REMOTE_TUNNEL_PORT_MIN, REMOTE_TUNNEL_PORT_MIN + 1]);
  assert.deepEqual(a.attempts, [REMOTE_TUNNEL_PORT_MIN]);
  assert.equal(firstTunnel.killed, false, "the existing tunnel is never interrupted");
  assert.equal(host.listeners.get(REMOTE_TUNNEL_PORT_MIN), "A");
  assert.equal(host.listeners.get(REMOTE_TUNNEL_PORT_MIN + 1), "B");
  assert.equal(status(a), "online");
  assert.equal(b.db.getBox(BOX_ID)?.lastError, null);
  a.orchestrator.shutdown();
  b.orchestrator.shutdown();
});

test("control planes racing for the same port both end up connected on distinct ports", async () => {
  const host = new FakeRemoteHost();
  const planes = [controlPlane(host, "A"), controlPlane(host, "B"), controlPlane(host, "C")];
  for (const cp of planes) cp.orchestrator.add(BOX_ID);
  await waitFor(() => planes.every((cp) => status(cp) === "online"), "every control plane online");
  const ports = planes.map((cp) => [...cp.live.keys()]);
  assert.ok(ports.every((held) => held.length === 1), JSON.stringify(ports));
  assert.equal(new Set(ports.flat()).size, planes.length, "each control plane holds its own port");
  for (const cp of planes) cp.orchestrator.shutdown();
});

test("a reconnect whose old port is still held recovers on the same Machine entry", async () => {
  const host = new FakeRemoteHost();
  const a = controlPlane(host, "A");
  a.orchestrator.add(BOX_ID);
  await waitFor(() => status(a) === "online", "first connection");

  host.lingerOnKill = true; // sshd still holds the dropped connection's listener
  assert.equal(await a.orchestrator.reconnect(BOX_ID), "started");
  await waitFor(() => a.live.size === 1 && status(a) === "online", "reconnected tunnel");

  assert.deepEqual(a.attempts, [REMOTE_TUNNEL_PORT_MIN, REMOTE_TUNNEL_PORT_MIN, REMOTE_TUNNEL_PORT_MIN + 1]);
  assert.equal(a.db.listBoxConfigs().length, 1, "no replacement Machine entry");
  assert.equal(a.db.getBoxConfig(BOX_ID)?.runnerId, RUNNER_ID);
  a.orchestrator.shutdown();
});

test("a restarted control plane recovers when another control plane took its previous port", async () => {
  const host = new FakeRemoteHost();
  const db = boxDb();
  host.listeners.set(REMOTE_TUNNEL_PORT_MIN, "another control plane");
  const restarted = controlPlane(host, "A", db);
  restarted.orchestrator.rehydrate();
  await waitFor(() => status(restarted) === "online", "rehydrated box online");
  assert.deepEqual([...restarted.live.keys()], [REMOTE_TUNNEL_PORT_MIN + 1]);
  assert.equal(host.listeners.get(REMOTE_TUNNEL_PORT_MIN), "another control plane");
  restarted.orchestrator.shutdown();
});

test("exhausted port recovery reports a tunnel failure distinct from installation and SSH, then keeps retrying", async () => {
  const host = new FakeRemoteHost();
  for (let i = 0; i < MAX_TUNNEL_PORT_ATTEMPTS; i++) host.listeners.set(REMOTE_TUNNEL_PORT_MIN + i, "foreign");
  const a = controlPlane(host, "A");
  a.orchestrator.add(BOX_ID);
  await waitFor(() => status(a) === "failed", "failed status");

  assert.equal(a.attempts.length, MAX_TUNNEL_PORT_ATTEMPTS, "recovery is bounded");
  assert.equal(new Set(a.attempts).size, MAX_TUNNEL_PORT_ATTEMPTS, "every attempt used a different port");
  const error = a.db.getBox(BOX_ID)?.lastError ?? "";
  assert.match(error, /^Tunnel establishment failed after the runner was installed/);
  assert.match(error, new RegExp(`remote tunnel port ${REMOTE_TUNNEL_PORT_MIN + MAX_TUNNEL_PORT_ATTEMPTS - 1}`));
  assert.match(error, /SSH connection on port 22 succeeded/);
  assert.doesNotMatch(error, /Runner installation failed|SSH connection failed/);
  assert.ok(
    [...host.listeners.values()].every((owner) => owner === "foreign"),
    "recovery never displaces the listeners that hold the ports",
  );
  const runtime = (a.orchestrator as unknown as {
    runtimes: Map<string, { reconnectTimer: unknown; remotePort: number }>;
  }).runtimes.get(BOX_ID);
  assert.ok(runtime?.reconnectTimer, "automatic reconnect continues at the normal backoff");
  assert.equal(runtime.remotePort, REMOTE_TUNNEL_PORT_MIN + MAX_TUNNEL_PORT_ATTEMPTS, "the next attempt uses a fresh port");
  a.orchestrator.shutdown();
});
