import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, WOLLIPOG_CONTROL_PLANE_SERVICE } from "@wollipog/protocol";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// The `ws` server the runner's own client talks to — resolve the exact copy the runner depends on.
const testRequire = createRequire(import.meta.url);
const { WebSocketServer } = testRequire("ws") as typeof import("ws");

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

// Race a promise against a deadline WITHOUT leaking the timer: an uncancelled timers/promises delay
// keeps the event loop alive and delays the whole test file by its full duration.
async function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, undefined, { signal: controller.signal }).then(
        () => { throw new Error(message()); },
        () => undefined as never, // aborted once the racing promise won — harmless
      ),
    ]);
  } finally {
    controller.abort();
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

interface FakeControlPlane {
  port: number;
  server: Server;
  wss: InstanceType<typeof WebSocketServer>;
  firstRunnerSocket: Promise<import("ws").WebSocket>;
  close(): Promise<void>;
}

// A minimal control plane: answer the runner's attestation probe, then upgrade its /runner socket so
// we can push it a frame of our choosing.
async function startFakeControlPlane(): Promise<FakeControlPlane> {
  const port = await reservePort();
  const wss = new WebSocketServer({ noServer: true });
  let resolveFirst: (socket: import("ws").WebSocket) => void;
  const firstRunnerSocket = new Promise<import("ws").WebSocket>((resolvePromise) => {
    resolveFirst = resolvePromise;
  });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url && req.url.includes("/runner/attestation/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        service: WOLLIPOG_CONTROL_PLANE_SERVICE,
        instanceId: randomUUID(),
        protocolVersion: PROTOCOL_VERSION,
      }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/runner")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => resolveFirst(ws));
  });
  await new Promise<void>((resolvePromise) => server.listen(port, "127.0.0.1", resolvePromise));
  return {
    port,
    server,
    wss,
    firstRunnerSocket,
    close: () =>
      new Promise<void>((resolvePromise) => {
        wss.close();
        server.close(() => resolvePromise());
      }),
  };
}

test(
  "the runner survives a malformed control-plane frame instead of crashing on an uncaught throw",
  { timeout: 60_000 },
  async (t) => {
    const cp = await startFakeControlPlane();
    const temp = mkdtempSync(join(tmpdir(), "wollipog-runner-survival-"));
    let output = "";
    const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RUNNER_ID: "runner-survival",
        RUNNER_TOKEN: "runner-survival-token",
        CONTROL_PLANE_URL: `ws://127.0.0.1:${cp.port}/runner`,
        RUNNER_DATA_DIR: temp,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-65_536); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    t.after(async () => {
      await stopChild(child);
      await cp.close();
      rmSync(temp, { recursive: true, force: true });
    });

    // The runner attests, then opens its /runner socket and sends `register`.
    const runnerSocket = await withTimeout(
      cp.firstRunnerSocket,
      30_000,
      () => `runner never connected\n${output}`,
    );
    const registered = new Promise<void>((resolvePromise) => {
      runnerSocket.on("message", (data: Buffer) => {
        try {
          if (JSON.parse(data.toString()).type === "register") resolvePromise();
        } catch {
          /* ignore non-JSON */
        }
      });
    });
    await withTimeout(registered, 30_000, () => `runner never sent register\n${output}`);

    // Acknowledge, then deliver a frame that parses cleanly but throws inside handleCommand
    // (`msg.spec.sessionId` dereferences an absent field) — historically a fatal uncaughtException
    // that skipped the graceful lease-release shutdown.
    runnerSocket.send(JSON.stringify({
      type: "registered",
      ok: true,
      serverTime: Date.now(),
      heartbeatIntervalMs: 10_000,
      protocolVersion: PROTOCOL_VERSION,
    }));
    await delay(300);
    runnerSocket.send(JSON.stringify({ type: "start_session" }));

    // Give the runner a moment to (previously) crash. It must instead drop the frame and stay up.
    for (let attempt = 0; attempt < 40 && !output.includes("dropping unhandled control-plane frame"); attempt++) {
      assert.equal(child.exitCode, null, `runner exited after the malformed frame\n${output}`);
      await delay(100);
    }
    assert.match(
      output,
      /dropping unhandled control-plane frame \(start_session\)/,
      `runner did not log the dropped frame\n${output}`,
    );
    assert.equal(child.exitCode, null, `runner exited after the malformed frame\n${output}`);

    // A malformed frame whose handler is FIRE-AND-FORGET async (`git_action` -> handleGitAction
    // dereferences an absent `msg.action`) rejects AFTER handleCommand's synchronous try/catch has
    // returned. Without per-dispatch containment its rejection reaches the process unhandledRejection
    // net and still shuts the runner down — the exact gap the sync try/catch alone cannot close.
    runnerSocket.send(JSON.stringify({ type: "git_action" }));
    for (let attempt = 0; attempt < 40 && !output.includes("dropping unhandled control-plane frame (git_action)"); attempt++) {
      assert.equal(child.exitCode, null, `runner exited after the async malformed frame\n${output}`);
      await delay(100);
    }
    assert.match(
      output,
      /dropping unhandled control-plane frame \(git_action\)/,
      `runner did not contain the async handler rejection\n${output}`,
    );
    assert.equal(child.exitCode, null, `runner exited after the async malformed frame\n${output}`);

    // `logout_agent` dispatches via `.then(...)` (not `void handleX()`), so a malformed frame with no
    // sessionId rejects async through a DIFFERENT shape than git_action — guard that path too.
    runnerSocket.send(JSON.stringify({ type: "logout_agent" }));
    for (let attempt = 0; attempt < 40 && !output.includes("dropping unhandled control-plane frame (logout_agent)"); attempt++) {
      assert.equal(child.exitCode, null, `runner exited after the logout_agent frame\n${output}`);
      await delay(100);
    }
    assert.match(
      output,
      /dropping unhandled control-plane frame \(logout_agent\)/,
      `runner did not contain the logout_agent rejection\n${output}`,
    );
    assert.equal(child.exitCode, null, `runner exited after the logout_agent frame\n${output}`);
  },
);
