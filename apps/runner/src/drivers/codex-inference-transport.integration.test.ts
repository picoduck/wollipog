import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { JsonRpcPeer } from "../jsonrpc.js";
import type { AgentProcess, SpawnAgentOptions } from "../spawn.js";
import { CodexAppServerDriver } from "./codex-app-server.js";
import type { DriverOptions } from "./driver.js";

function harness(options: { role?: boolean; resume?: boolean; provider?: string; config?: unknown; configError?: boolean } = {}) {
  const diagnostics: string[] = [];
  const launches: SpawnAgentOptions[] = [];
  const servers: JsonRpcPeer[] = [];
  const children: AgentProcess[] = [];
  const calls: string[] = [];
  const opts: DriverOptions = {
    command: "codex", args: ["-c", "model=selected-model", "-c", "approval_policy=on-request"], cwd: "/project",
    env: { CODEX_HOME: "/selected-account", ACCOUNT_MARKER: "private-account" }, context: { kind: "native" },
    config: { model: "selected-model", effort: "high", permissionMode: "auto-review" },
    ...(options.role ? { orchestrator: { strictProjectIsolation: false, integrationIsolation: false } } : {}),
    ...(options.resume ? { resumeId: "thread" } : {}),
  };
  const driver = new CodexAppServerDriver(opts, { onEvent: () => {}, onExit: () => {}, onStderr: line => diagnostics.push(line) }, undefined, {
    spawn: launch => {
      launches.push(launch);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin, stdout, stderr: new PassThrough(), pid: 123,
      }) as unknown as AgentProcess;
      children.push(child);
      const server = new JsonRpcPeer(stdout, stdin);
      servers.push(server);
      server.onRequest("initialize", () => ({ userAgent: "wollipog/0.160.0 (Linux)" }));
      server.onRequest("plugin/reconcile", () => ({}));
      server.onRequest("skills/list", () => ({ data: [] }));
      server.onRequest("app/installed", () => ({}));
      server.onRequest("thread/read", () => { calls.push("thread/read"); return { thread: { id: "thread", status: { type: "idle" } } }; });
      for (const method of ["thread/start", "thread/resume"]) server.onRequest(method, () => {
        calls.push(method);
        return { thread: { id: "thread" }, modelProvider: options.provider ?? "openai" };
      });
      server.onRequest("config/read", params => {
        calls.push("config/read");
        assert.deepEqual(params, { cwd: "/project", includeLayers: false });
        if (options.configError) throw new Error("private-prompt token=secret endpoint=https://private.invalid");
        return { config: options.config };
      });
      return child;
    },
    kill: () => {},
  });
  return { driver, opts, diagnostics, launches, calls, servers, children };
}

test("standard and additive Orchestrator fresh/resumed/relaunched drivers retain native defaults and launch selection", async () => {
  for (const role of [false, true]) for (const resume of [false, true]) {
    const h = harness({ role, resume });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await h.driver.initialize();
        await h.driver.newSession("/project");
      }
      assert.equal(h.launches.length, 2);
      for (const launch of h.launches) {
        assert.deepEqual(launch.args, [...h.opts.args, "--enable", "default_mode_request_user_input", "app-server"]);
        assert.deepEqual(launch.env, h.opts.env);
      }
      assert.deepEqual(h.calls, resume ? ["thread/read", "thread/resume", "thread/read", "thread/resume"] : ["thread/start", "thread/start"]);
      const records = h.diagnostics.map(line => JSON.parse(line));
      assert.deepEqual(records.map(record => record.launch), [1, 2]);
      assert.ok(records.every(record => record.configuredTransport === "websocket" && record.observedTransport === "unverified"));
      assert.ok(records.every(record => record.entryPoint === (resume ? "thread_resume" : "thread_start")));
    } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
  }
});

test("custom-provider support is read from the effective config without overriding it or exposing private values", async () => {
  for (const enabled of [true, false]) {
    const h = harness({ resume: true, provider: "private-provider", config: {
      model_providers: { "private-provider": { supports_websockets: enabled, base_url: "https://private.invalid", experimental_bearer_token: "secret" } },
      instructions: "private-prompt",
    } });
    try {
      await h.driver.initialize();
      await h.driver.newSession("/project");
      assert.deepEqual(h.calls, ["thread/read", "thread/resume", "config/read"]);
      assert.equal(JSON.parse(h.diagnostics[0]!).configuredTransport, enabled ? "websocket" : "http");
      assert.doesNotMatch(h.diagnostics.join("\n"), /private-|secret|https:|selected-model|selected-account/);
      assert.deepEqual(h.launches[0]!.args, [...h.opts.args, "--enable", "default_mode_request_user_input", "app-server"]);
    } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
  }
});

test("config-read failure remains unknown and does not fail or disclose provider error text", async () => {
  const h = harness({ provider: "private-provider", configError: true });
  try {
    await h.driver.initialize();
    assert.equal(await h.driver.newSession("/project"), "thread");
    assert.equal(JSON.parse(h.diagnostics[0]!).configuredTransport, "unknown");
    assert.doesNotMatch(h.diagnostics.join("\n"), /private-|secret|https:/);
  } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
});

test("structured fallback warnings are sanitized, scoped, deduplicated, and reset on relaunch", async () => {
  const h = harness();
  try {
    await h.driver.initialize();
    await h.driver.newSession("/project");
    const warning = "Falling back from WebSockets to HTTPS transport. private-prompt token=secret https://private.invalid";
    h.servers[0]!.notify("warning", { threadId: "other-thread", message: warning });
    h.servers[0]!.notify("warning", { threadId: "thread", message: warning });
    h.servers[0]!.notify("warning", { message: warning });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.diagnostics.length, 2);
    assert.deepEqual(JSON.parse(h.diagnostics[1]!), {
      event: "codex_inference_transport", entryPoint: "provider_warning", launch: 1, phase: "fallback",
      provider: "openai", configuredTransport: "websocket", observedTransport: "http", reason: "provider_http_fallback",
    });
    await h.driver.initialize();
    await h.driver.newSession("/project");
    assert.equal(JSON.parse(h.diagnostics[2]!).observedTransport, "unverified");
    h.servers[0]!.notify("warning", { threadId: "thread", message: warning });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.diagnostics.length, 3, "a previous process cannot report fallback for the current launch");
    h.servers[1]!.notify("warning", { threadId: "thread", message: warning });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(h.diagnostics[3]!).launch, 2);
    assert.doesNotMatch(h.diagnostics.join("\n"), /private-|secret|https:/);
  } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
});

test("fallback stderr split at arbitrary byte boundaries never exposes the suffix", async () => {
  const h = harness();
  try {
    await h.driver.initialize();
    await h.driver.newSession("/project");
    for (const text of ["Falling back from Web", "Sockets to HTTPS trans", "port. token=secret private-prompt\n"]) {
      (h.children[0]!.stderr as PassThrough).write(text);
    }
    assert.equal(h.diagnostics.length, 2);
    assert.equal(JSON.parse(h.diagnostics[1]!).observedTransport, "http");
    assert.doesNotMatch(h.diagnostics.join("\n"), /secret|private-prompt/);
  } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
});

test("known subagent fallback is scoped without marking the root thread as HTTP", async () => {
  const h = harness();
  try {
    await h.driver.initialize();
    await h.driver.newSession("/project");
    h.servers[0]!.notify("item/completed", { threadId: "thread", item: {
      type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed",
      senderThreadId: "thread", receiverThreadIds: ["private-child"],
    } });
    const message = "Falling back from WebSockets to HTTPS transport. secret";
    for (let i = 0; i < 2; i++) h.servers[0]!.notify("warning", { threadId: "private-child", message });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.diagnostics.length, 2);
    assert.equal(JSON.parse(h.diagnostics[1]!).scope, "subagent");
    assert.equal(JSON.parse(h.diagnostics[1]!).provider, "unknown");
    await h.driver.newSession("/project");
    assert.equal(JSON.parse(h.diagnostics[2]!).observedTransport, "unverified");
    h.servers[0]!.notify("warning", { threadId: "thread", message });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.diagnostics.length, 4, "child fallback does not suppress the root warning");
    assert.doesNotMatch(h.diagnostics.join("\n"), /private-child|secret/);
  } finally { h.driver.dispose(); for (const server of h.servers) server.dispose("done"); }
});
