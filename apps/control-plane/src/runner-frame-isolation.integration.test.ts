import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { hashToken } from "./auth.js";
import { ControlPlaneDb } from "./db.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// Use the exact `ws` implementation @fastify/websocket depends on so close codes match the server's.
const testRequire = createRequire(import.meta.url);
const websocketPluginRequire = createRequire(testRequire.resolve("@fastify/websocket"));
const StrictWebSocket = websocketPluginRequire("ws").WebSocket as new (url: string) => StrictSocket;

interface StrictSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number, reason: Buffer) => void): void;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  if (await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(3_000)]);
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

function registerFrame(runnerId: string, token: string): string {
  return JSON.stringify({
    type: "register",
    token,
    protocolVersion: PROTOCOL_VERSION,
    runner: {
      runnerId,
      hostname: "frame-isolation-host",
      os: "linux",
      version: "integration",
      workspaces: [],
      agents: [],
    },
    sessionSnapshots: [],
  });
}

async function openRegisteredRunner(
  wsBase: string,
  runnerId: string,
  token: string,
  sockets: Set<StrictSocket>,
): Promise<StrictSocket> {
  const socket = new StrictWebSocket(`${wsBase}/runner`);
  sockets.add(socket);
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  const registered = new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for registered")), 5_000);
    socket.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message && typeof message === "object" && (message as { type?: unknown }).type === "registered") {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  });
  socket.send(registerFrame(runnerId, token));
  await registered;
  return socket;
}

function waitForClose(socket: StrictSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), 5_000);
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: reason.toString("utf8") });
    });
  });
}

test(
  "a malformed runner frame closes only the offending socket and never crashes the control plane",
  { timeout: 60_000 },
  async (t) => {
    const port = await reservePort();
    const temp = mkdtempSync(join(tmpdir(), "wollipog-frame-isolation-"));
    const databasePath = join(temp, "control-plane.db");
    const runnerToken = `wollipogr_${"a".repeat(43)}`;

    const seed = ControlPlaneDb.open(databasePath);
    const identity = seed.localIdentityContext();
    const now = Date.now();
    seed.issueRunnerCredential({
      credentialId: "rcred_frameisolation0000000000000000",
      runnerId: "runner-frame-isolation",
      organizationId: identity.organizationId,
      ownerKind: "organization",
      ownerId: identity.organizationId,
      label: "Frame isolation fixture",
      tokenHash: hashToken(runnerToken),
      createdByUserId: identity.userId,
      now,
      expiresAt: now + 600_000,
    });
    seed.close();

    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CONTROL_PLANE_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-32_768); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const sockets = new Set<StrictSocket>();
    t.after(async () => {
      for (const socket of sockets) {
        if (socket.readyState < 2) socket.close();
      }
      await stopChild(child);
      rmSync(temp, { recursive: true, force: true });
    });

    const httpBase = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;
    await waitForHealth(httpBase, child, () => output);

    // Each frame parses cleanly (cast-only parseMessage) but omits required fields, so the dispatch
    // throws — historically a fatal uncaughtException. Every one must instead close ONLY its socket.
    const malformedFrames = [
      JSON.stringify({ type: "session_event" }),
      JSON.stringify({ type: "session_status" }),
      JSON.stringify({ type: "shell_output" }),
    ];

    for (const frame of malformedFrames) {
      const socket = await openRegisteredRunner(wsBase, "runner-frame-isolation", runnerToken, sockets);
      const closed = waitForClose(socket);
      socket.send(frame);
      const result = await closed;
      assert.equal(result.code, 1008, `expected policy close for frame ${frame} (got ${result.code})`);
      assert.equal(result.reason, "malformed runner frame");
      sockets.delete(socket);

      // The server process must still be alive and serving after the poisoned frame.
      assert.equal(child.exitCode, null, `control plane exited after frame ${frame}\n${output}`);
      const health = await fetch(`${httpBase}/healthz`);
      assert.equal(health.status, 200, `healthz failed after frame ${frame}`);
    }

    // Definitive proof the control plane survived: a brand-new runner can still register.
    const survivor = await openRegisteredRunner(wsBase, "runner-frame-isolation", runnerToken, sockets);
    assert.ok(survivor.readyState < 2, "a fresh runner registered after the malformed frames");
  },
);
