import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { sanitizeStartupOutput, waitForLiveStackHealth } from "./live-stack-health.js";

test("a never-answering listener has a finite deadline and useful sanitized diagnostics", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    const started = performance.now();
    await assert.rejects(waitForLiveStackHealth(`http://127.0.0.1:${address.port}`, child,
      () => ({ controlPlane: "booting\ntoken=private-token\n/home/private/worktree/index.ts\n", runner: "" }), {
        phase: "initial startup", secrets: ["private-token"], timeoutMs: 150,
      }), (error: Error) => {
      assert.match(error.message, /startup=initial startup; phase=process spawned; elapsedMs=\d+/u);
      assert.match(error.message, /process=running; exitCode=null; signal=null/u);
      assert.match(error.message, /lastHealthProbe=probe timed out/u);
      assert.match(error.message, /booting/u);
      assert.doesNotMatch(error.message, /private-token|\/home\/private/u);
      return true;
    });
    assert(performance.now() - started < 2_000, "hung probe must not defeat the deadline");
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("early process exit reports exit status without waiting for the readiness deadline", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(23)"]);
  await once(child, "exit");
  await assert.rejects(waitForLiveStackHealth("http://127.0.0.1:1", child,
    () => ({ controlPlane: "startup failed", runner: "r".repeat(9_000) }), {
    phase: "restart", secrets: [],
  }), (error: Error) => {
    assert.match(error.message, /startup=restart; phase=process spawned; elapsedMs=\d+/u);
    assert.match(error.message, /process=exited; exitCode=23; signal=null/u);
    assert.match(error.message, /lastHealthProbe=not attempted/u);
    assert.match(error.message, /startup failed/u);
    assert.match(error.message, /=== CONTROL PLANE ===/u);
    assert.match(error.message, /=== RUNNER ===/u);
    assert(error.message.length < 9_000);
    return true;
  });
});

test("non-healthy listener reports its last HTTP status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    await assert.rejects(waitForLiveStackHealth("http://fixture", child, () => ({ controlPlane: "", runner: "" }), {
      phase: "initial startup", secrets: [], timeoutMs: 200,
    }), /phase=health listener responded;[\s\S]*lastHealthProbe=HTTP 503/u);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
});

test("redaction removes credentials and private paths while retaining repository locations and URLs", () => {
  const output = sanitizeStartupOutput("x".repeat(65_536) +
    '\nBearer abc\n{"api_key":"hidden"}\nC:\\Users\\private\\file\n/tmp/private/file\nopaque-secret', ["opaque-secret"]);
  assert.doesNotMatch(output, /abc|hidden|Users|private|opaque-secret/u);
  assert.match(output, /\[redacted\]/u);
  assert.equal(sanitizeStartupOutput("at f (file:///home/private/file.ts:12:3)", []), "at f ([path]");
  assert.equal(sanitizeStartupOutput("file:/home/private/x.js cwd:/tmp/private/y cwd:C:\\Users\\private\\z", []),
    "file:[path] cwd:[path] cwd:[path]");
  assert.equal(sanitizeStartupOutput("at f (file:///home/u/repo/apps/control-plane/src/db.ts:12:3) GET http://127.0.0.1:9/healthz HTTP/1.1", [], "/home/u/repo"),
    "at f (file://[repo]apps/control-plane/src/db.ts:12:3) GET http://127.0.0.1:9/healthz HTTP/1.1");
});
