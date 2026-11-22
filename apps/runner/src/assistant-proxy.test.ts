import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ASSISTANT_THREAD_CREDENTIAL_TTL_MS, PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import { provisionAgentControl, type AgentControlHost } from "./agent-control.js";
import { assistantMcpConfigPath } from "./assistant-launch.js";
import { runAssistantMcp } from "./assistant-mcp.js";
import { AssistantProxies } from "./assistant-proxy.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** A control plane that answers MCP and records every bearer it was sent. */
function fakeControlPlane() {
  const bearers: string[] = [];
  const bodies: unknown[] = [];
  const fetch = (async (_url: URL, init?: RequestInit) => {
    bearers.push(String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /u, ""));
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    bodies.push(message);
    if (message.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "assistant_discover" }] } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { bearers, bodies, fetch };
}

async function callThroughAdapter(env: Record<string, string>, lines: string[]): Promise<string[]> {
  const input = new PassThrough(), output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += String(chunk); });
  const done = runAssistantMcp(env, input, output);
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return written.split("\n").filter(Boolean);
}

function harness(answer: "accept" | "refuse" = "accept", statuses: number[] = []) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-assistant-proxy-"));
  const worktree = mkdtempSync(join(tmpdir(), "wollipog-assistant-worktree-"));
  const host: AgentControlHost = { isSea: true, execPath: "/opt/wollipog-runner", execArgv: [], configDir: root };
  const cp = fakeControlPlane(), registered: string[] = [];
  let now = 1_000_000;
  const rejected: boolean[] = [];
  const proxies: AssistantProxies = new AssistantProxies({
    fetch: (url, init) => statuses.shift() === 401
      ? Promise.resolve(new Response(null, { status: 401 })) : cp.fetch(url, init),
    credentialRejected: (_sessionId, value) => { rejected.push(value); },
    now: () => now,
    ackTimeoutMs: 500,
    register: (sessionId, tokenHash) => {
      registered.push(tokenHash);
      queueMicrotask(() => answer === "accept"
        ? proxies.acknowledge(sessionId, tokenHash, true, now + ASSISTANT_THREAD_CREDENTIAL_TTL_MS)
        : proxies.acknowledge(sessionId, tokenHash, false, undefined, "the Assistant thread is archived"));
    },
  });
  const spec: SessionLaunchSpec = {
    sessionId: "s_assistant", workspaceId: "ws", workspacePath: worktree, agentId: "claude", command: "claude", args: [],
    env: { PROVIDER_SETTING: "kept" }, useWorktree: false, driver: "claude-code", context: { kind: "native" },
    assistant: { threadId: "thr_fixture" },
  };
  return { root, worktree, host, cp, registered, rejected, proxies, spec, advance: (ms: number) => { now += ms; },
    close: async () => { await proxies.closeAll(); rmSync(root, { recursive: true, force: true }); rmSync(worktree, { recursive: true, force: true }); } };
}

async function provisioned(h: ReturnType<typeof harness>): Promise<Record<string, string>> {
  const logs: string[] = [];
  await provisionAgentControl(h.spec, { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
    assistantProxy: h.proxies }, (line) => logs.push(line), h.host);
  const config = JSON.parse(readFileSync(assistantMcpConfigPath(h.root, h.spec.sessionId), "utf8"));
  return config.mcpServers.wollipog_assistant.env as Record<string, string>;
}

test("the agent can call its thread's tools but cannot read the thread credential", async () => {
  const h = harness();
  try {
    const adapterEnv = await provisioned(h);
    const replies = await callThroughAdapter(adapterEnv, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);
    // The session sees its tools, and notifications produce no reply.
    assert.deepEqual(replies.map((line) => JSON.parse(line).id).sort(), [1, 2]);
    assert.ok(replies.some((line) => JSON.parse(line).result?.tools?.[0]?.name === "assistant_discover"));

    // The control plane received the thread credential the runner registered.
    const token = h.cp.bearers[0]!;
    assert.match(token, /^wollipoga_[A-Za-z0-9_-]{43}$/u);
    assert.ok(h.cp.bearers.every((bearer) => bearer === token));
    assert.equal(sha256(token), h.registered.at(-1));

    // Everything the agent can read: its environment and arguments, the adapter's configuration
    // and environment, every runner file written for it, its worktree, and what the tools return
    // into its transcript. None of them holds the credential.
    const surfaces = [
      JSON.stringify(h.spec.env), JSON.stringify(h.spec.args), JSON.stringify(adapterEnv), ...replies,
      ...filesUnder(h.root).map((file) => readFileSync(file, "utf8")),
      ...filesUnder(h.worktree).map((file) => readFileSync(file, "utf8")),
    ];
    for (const surface of surfaces) assert.ok(!surface.includes(token), "the credential leaked to an agent-visible surface");
    assert.ok(!JSON.stringify(h.cp.bodies).includes(token), "the credential is never a tool argument");
  } finally { await h.close(); }
});

test("a revoked proxy shuts down and a refused credential reaches the assistant as a reason", async () => {
  const h = harness();
  try {
    const adapterEnv = await provisioned(h);
    await h.proxies.revoke(h.spec.sessionId);
    const [reply] = await callThroughAdapter(adapterEnv, [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })]);
    assert.equal(JSON.parse(reply!).id, 7);
    assert.match(JSON.parse(reply!).error.message, /proxy is unavailable/);
    assert.equal(h.cp.bearers.length, 0, "nothing reaches the control plane after revocation");
  } finally { await h.close(); }

  const refused = harness("refuse");
  try {
    const adapterEnv = await provisioned(refused);
    const [reply] = await callThroughAdapter(adapterEnv, [JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })]);
    assert.match(JSON.parse(reply!).error.message, /the Assistant thread is archived/);
    assert.equal(refused.cp.bearers.length, 0);
    assert.equal(refused.rejected.at(-1), true);
  } finally { await refused.close(); }
});

test("the proxy registers a fresh short-lived credential before half its lifetime has passed", async () => {
  const h = harness();
  try {
    const adapterEnv = await provisioned(h);
    const call = (id: number) => callThroughAdapter(adapterEnv, [JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })]);
    await call(1);
    h.advance(ASSISTANT_THREAD_CREDENTIAL_TTL_MS / 4);
    await call(2);
    assert.equal(new Set(h.cp.bearers).size, 1, "a fresh credential is still used");
    h.advance(ASSISTANT_THREAD_CREDENTIAL_TTL_MS / 2);
    await call(3);
    assert.equal(new Set(h.cp.bearers).size, 2, "an aging credential is replaced before use");
    assert.equal(sha256(h.cp.bearers.at(-1)!), h.registered.at(-1));
    // A wrong relay key is refused without reaching the control plane.
    const before = h.cp.bearers.length;
    const [reply] = await callThroughAdapter({ ...adapterEnv, WOLLIPOG_ASSISTANT_RELAY_KEY: "x".repeat(43) },
      [JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })]);
    assert.match(JSON.parse(reply!).error.message, /refused this request/);
    assert.equal(h.cp.bearers.length, before);
  } finally { await h.close(); }
});

test("Assistant tools recover when the same credential succeeds after a rejected retry", async () => {
  const h = harness("accept", [401, 401, 200]);
  try {
    const env = await provisioned(h);
    const call = (id: number) => callThroughAdapter(env, [JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })]);
    await call(1);
    assert.equal(h.rejected.at(-1), true);
    assert.equal(h.registered.length, 2);
    const [reply] = await call(2);
    assert.equal(JSON.parse(reply!).result.tools[0].name, "assistant_discover");
    assert.equal(h.rejected.at(-1), false);
    assert.equal(h.registered.length, 2, "the same credential recovered without a rotation");
  } finally { await h.close(); }
});
