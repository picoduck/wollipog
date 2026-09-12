import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  attachWslAgentControlBroker,
  validateWslAgentControlCliArgs,
  WSL_AGENT_CONTROL_HELPER_SOURCE,
  type WslAgentControlLaunch,
} from "./wsl-agent-control.js";

test("Direct WSL CLI bridge accepts only the Agent Control command families and no auth override", () => {
  assert.deepEqual(validateWslAgentControlCliArgs(["session", "list", "--json"]), ["session", "list", "--json"]);
  assert.deepEqual(validateWslAgentControlCliArgs(["worktree", "discard", "--path", "/tmp/w"]), ["worktree", "discard", "--path", "/tmp/w"]);
  for (const args of [
    ["admin", "status"], ["service", "restart"], ["session", "list", "--url=http://other"],
    ["session", "list", "--token-file", "/tmp/other"], ["session", "list\nadmin"],
  ]) assert.throws(() => validateWslAgentControlCliArgs(args), /allowlist|override|invalid/u);
});

test("target-local helper has no process or network launcher surface", () => {
  assert.doesNotMatch(WSL_AGENT_CONTROL_HELPER_SOURCE, /child_process|\bspawn\b|\bexec(?:File)?\b|createConnection\([^s]/u);
  assert.match(WSL_AGENT_CONTROL_HELPER_SOURCE, /net\.createConnection\(socketPath\)/u);
  assert.match(WSL_AGENT_CONTROL_HELPER_SOURCE, /server\.listen\(socketPath/u);
  assert.match(WSL_AGENT_CONTROL_HELPER_SOURCE, /output\(\{\.\.\.msg,type:"open",id\}\)/u,
    "relay-assigned frame type and connection id must override untrusted client fields");
});

test("target-local relay materializes owner-only bootstrap files and owns frame identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wlp-helper-source-"));
  const dir = join(root, "launch");
  mkdirSync(dir);
  const helper = join(root, "helper.mjs");
  const socketPath = join(dir, "control.sock");
  const token = "wollipoga_pipe_only";
  const mcp = JSON.stringify({ mcpServers: { wollipog: { command: "/usr/bin/node" } } });
  writeFileSync(helper, WSL_AGENT_CONTROL_HELPER_SOURCE);
  const child = spawn(process.execPath, [helper, "serve", socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  });
  child.stdin.write(`${JSON.stringify({ type: "bootstrap", token: Buffer.from(token).toString("base64"),
    mcp: Buffer.from(mcp).toString("base64") })}\n`);
  const deadline = Date.now() + 5_000;
  while ((!existsSync(socketPath) || !existsSync(join(dir, "token")) || !existsSync(join(dir, "mcp.json"))) &&
      Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readFileSync(join(dir, "token"), "utf8"), token);
  assert.equal(readFileSync(join(dir, "mcp.json"), "utf8"), mcp);
  assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "mcp.json")).mode & 0o777, 0o600);
  const relayFrame = new Promise<Record<string, unknown>>((resolve, reject) => {
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const at = pending.indexOf("\n");
      if (at >= 0) resolve(JSON.parse(pending.slice(0, at)) as Record<string, unknown>);
    });
    child.once("error", reject);
  });
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`${JSON.stringify({ type: "data", id: "forged", v: 1, kind: "mcp", sessionId: "s", token })}\n`);
  assert.deepEqual(await relayFrame, { type: "open", id: "1", v: 1, kind: "mcp", sessionId: "s", token });
  socket.destroy();
  child.kill();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  assert.equal(existsSync(socketPath), false);
  assert.equal(existsSync(join(dir, "token")), false);
  assert.equal(existsSync(join(dir, "mcp.json")), false);
  assert.equal(existsSync(dir), true,
    "relay preserves the pinned session directory for a subsequent metadata/provider launch");
});

function fixture(): { config: WslAgentControlLaunch; fromHelper: PassThrough; toHelper: PassThrough; lines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "wlp-wsl-control-"));
  const token = "wollipoga_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const tokenFile = join(dir, "token");
  const readyFile = join(dir, "ready");
  writeFileSync(tokenFile, token);
  writeFileSync(readyFile, createHash("sha256").update(token).digest("hex"));
  const fromHelper = new PassThrough();
  const toHelper = new PassThrough();
  const lines: string[] = [];
  let pending = "";
  toHelper.setEncoding("utf8");
  toHelper.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const at = pending.indexOf("\n");
      if (at < 0) break;
      lines.push(pending.slice(0, at));
      pending = pending.slice(at + 1);
    }
  });
  return { config: { protocolVersion: 1, distro: "Ubuntu", nodeRuntime: "/usr/bin/node",
    helperPath: "/usr/local/lib/wollipog/wsl-agent-control-v1.mjs", sessionId: "session-a", token,
    tokenFile, readyFile, cpUrl: "http://127.0.0.1:4317" }, fromHelper, toHelper, lines };
}

async function tick(): Promise<void> { await new Promise((resolve) => setImmediate(resolve)); }

test("broker rejects wrong-session, wrong-token, and stale credentials before opening a route", async () => {
  const f = fixture();
  const dispose = attachWslAgentControlBroker(f.fromHelper, f.toHelper, f.config);
  f.fromHelper.write(`${JSON.stringify({ type: "open", id: "one", v: 1, kind: "mcp", sessionId: "other", token: f.config.token })}\n`);
  f.fromHelper.write(`${JSON.stringify({ type: "open", id: "two", v: 1, kind: "mcp", sessionId: "session-a", token: "wrong" })}\n`);
  writeFileSync(f.config.readyFile, "0".repeat(64));
  f.fromHelper.write(`${JSON.stringify({ type: "open", id: "three", v: 1, kind: "mcp", sessionId: "session-a", token: f.config.token })}\n`);
  await tick();
  assert.equal(f.lines.filter((line) => JSON.parse(line).exit === 1).length, 3);
  assert.equal(f.lines.some((line) => JSON.parse(line).accepted === true), false);
  dispose();
});

test("broken broker output disposes without an unhandled pipe error or follow-up write", async () => {
  const f = fixture();
  const dispose = attachWslAgentControlBroker(f.fromHelper, f.toHelper, f.config);
  f.toHelper.destroy(new Error("simulated EPIPE"));
  await tick();
  assert.doesNotThrow(dispose, "disposal is idempotent after the write pipe fails");
  assert.doesNotThrow(() => f.fromHelper.write(`${JSON.stringify({ type: "open", id: "late", v: 1,
    kind: "mcp", sessionId: f.config.sessionId, token: f.config.token })}\n`));
  await tick();
});

test("broker authenticates exact MCP session and exposes only the Orchestrator tool table", async () => {
  const f = fixture();
  const dispose = attachWslAgentControlBroker(f.fromHelper, f.toHelper, f.config, async () => ({
    ok: true, status: 200, text: async () => "{}",
  }));
  const bootstrap = JSON.parse(f.lines[0]!);
  assert.equal(bootstrap.type, "bootstrap");
  assert.equal(Buffer.from(bootstrap.token, "base64").toString(), f.config.token);
  assert.equal(JSON.parse(Buffer.from(bootstrap.mcp, "base64").toString()).mcpServers.wollipog.env.WOLLIPOG_AGENT_CONTROL_SOCKET,
    "/tmp/wollipog-agent-control/control.sock");
  assert.doesNotMatch(f.lines[0]!, /wollipoga_/u, "credential bytes are never sent as plaintext framing");
  f.fromHelper.write(`${JSON.stringify({ type: "open", id: "mcp", v: 1, kind: "mcp", sessionId: f.config.sessionId, token: f.config.token })}\n`);
  await tick();
  assert.equal(f.lines.some((line) => JSON.parse(line).accepted === true), true);
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`;
  f.fromHelper.write(`${JSON.stringify({ type: "data", id: "mcp", data: Buffer.from(request).toString("base64") })}\n`);
  await tick();
  const payloads = f.lines.map((line) => JSON.parse(line)).filter((message) => message.data)
    .map((message) => Buffer.from(message.data, "base64").toString());
  const response = JSON.parse(payloads.join("").trim());
  const names = response.result.tools.map((tool: { name: string }) => tool.name);
  assert.ok(names.includes("create_session"));
  assert.ok(names.includes("set_guardrails"));
  assert.ok(names.includes("restart_session"));
  dispose();
});
