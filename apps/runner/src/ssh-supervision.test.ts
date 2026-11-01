import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { watchSshLifetime } from "./ssh-supervision.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("an SSH EOF requests exactly one graceful shutdown, never a second signal", async () => {
  const input = new PassThrough();
  let stops = 0;
  watchSshLifetime(input, () => stops++);
  input.write("ignored input");
  assert.equal(stops, 0);
  input.end();
  await setImmediate();
  input.emit("error", new Error("transport ended"));
  assert.equal(stops, 1);
});

test("SSH EOF stops the real runner while control-plane attestation is retrying", { timeout: 15_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ssh-runner-attestation-"));
  const tokenFile = join(root, "token");
  const data = join(root, "data");
  writeFileSync(tokenFile, "isolated-test-token", { mode: 0o600 });
  const server = createServer((_req, res) => { res.writeHead(503); res.end("unavailable"); });
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requested = once(server, "request");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)),
    "--runner-id", "ssh-fixture", "--control-plane-url", `ws://127.0.0.1:${address.port}/runner`,
    "--token-file", tokenFile, "--data-dir", data], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, WOLLIPOG_SSH_SUPERVISED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  child.stdout.resume(); child.stderr.resume();
  await Promise.race([requested, exited.then(() => { throw new Error("runner exited before the attestation fixture was reached"); })]);
  assert.equal(existsSync(data), false, "no runner data or provider HOME was acquired before attestation");
  child.stdin.end();
  let deadline: ReturnType<typeof setTimeout>;
  const result = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("runner ignored SSH EOF during attestation")), 1_500);
  })]).finally(() => clearTimeout(deadline));
  assert.deepEqual(result, [0, null]);
  assert.equal(existsSync(data), false);
});

test("SSH shutdown observes an already ended stream and can be disarmed", async () => {
  const input = new PassThrough();
  input.resume(); input.end(); await setImmediate();
  let stops = 0;
  watchSshLifetime(input, () => stops++);
  assert.equal(stops, 1);
  const next = new PassThrough();
  watchSshLifetime(next, () => stops++)();
  next.end(); await setImmediate();
  assert.equal(stops, 1);
});
