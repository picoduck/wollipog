import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_AGENT_CONTROL_PROBE_COMMAND,
  PI_PROJECT_TRUST_DECLINED,
  PI_PROJECT_TRUST_NONCE_ENV,
  PI_PROJECT_TRUST_NOT_REQUESTED,
  PI_PROJECT_TRUST_STATUS_KEY,
  PI_SECURITY_REQUEST_NONCE_ENV,
  PI_SECURITY_REQUEST_PREFIX,
  piAgentControlExtensionSource,
  piAgentControlProbeSource,
} from "./pi-agent-control-extension.js";

test("generated Pi Agent Control extensions are standalone valid modules", async () => {
  const source = piAgentControlExtensionSource();
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const probeSource = piAgentControlProbeSource("probe-nonce");
  const probe = await import(`data:text/javascript;base64,${Buffer.from(probeSource).toString("base64")}`);
  assert.equal(typeof bridge.default, "function");
  assert.equal(typeof probe.default, "function");
  assert.match(source, /tools\/list/);
  assert.match(source, /request_user_input/);
  assert.match(source, /WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE/);
  assert.match(source, /timeoutMs: null, signal/,
    "tool calls remain pending until their durable operation replies or the bridge exits");
  assert.match(source, /notifications\/cancelled/);
  assert.match(source, /project_trust/);
  assert.match(source, /tool_call/);
  assert.match(source, new RegExp(PI_SECURITY_REQUEST_NONCE_ENV));
  assert.match(source, new RegExp(PI_SECURITY_REQUEST_PREFIX));
  assert.doesNotMatch(source, /failed to start:.*error/u,
    "runner-local startup error detail is not forwarded through Pi notifications");
  assert.doesNotMatch(source, /WOLLIPOG_SESSION_TOKEN_FILE\s*=/,
    "the extension inherits a token-file reference and never embeds credential bytes");
  assert.match(probeSource, new RegExp(PI_AGENT_CONTROL_PROBE_COMMAND));
  assert.match(probeSource, /probe-nonce/);
  assert.match(probeSource, /session_start/);
  assert.match(probeSource, /setStatus/);
});

test("Pi Agent Control probe reports readiness only after the pre-load trust hook", async () => {
  const probe = await import(`data:text/javascript;base64,${Buffer.from(piAgentControlProbeSource("probe-nonce")).toString("base64")}`);
  const handlers = new Map<string, (...args: any[]) => any>();
  const statuses: Array<[string, string]> = [];
  probe.default({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: () => {},
    getActiveTools: () => [PI_AGENT_CONTROL_PROBE_COMMAND],
    setActiveTools: () => {},
  });
  const ctx = { ui: {
    setStatus: (key: string, value: string) => statuses.push([key, value]),
    select: () => {},
    input: () => {},
  } };
  await handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(statuses, [], "session startup alone does not prove the trust hook exists");
  assert.deepEqual(await handlers.get("project_trust")?.(), { trusted: "no" });
  await handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(statuses, [["wollipog-agent-control-probe", "probe-nonce"]]);
});

function loadExtensionHandlers(bridge: { default(pi: unknown): void }): Map<string, (...args: any[]) => any> {
  const handlers = new Map<string, (...args: any[]) => any>();
  bridge.default({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  });
  return handlers;
}

function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>): void {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("generated Pi Agent Control extension declines project trust without remembering, even when offered a UI", async (t) => {
  withEnv(t, {
    [PI_SECURITY_REQUEST_NONCE_ENV]: "security-nonce",
    [PI_PROJECT_TRUST_NONCE_ENV]: "launch-nonce",
    WOLLIPOG_PI_AGENT_CONTROL_COMMAND: undefined,
  });
  const source = piAgentControlExtensionSource();
  const encodedSource = Buffer.from(source).toString("base64");
  const statusOf = async (dispatchedCwd?: string) => {
    // A fresh module instance per launch, as Pi loads the extension once per process.
    const bridge = await import(`data:text/javascript;base64,${encodedSource}#${Math.random()}`);
    const handlers = loadExtensionHandlers(bridge);
    const selects: string[] = [];
    const statuses: Array<[string, string]> = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (title: string) => { selects.push(title); return "Trust This Project"; },
        confirm: async () => true,
        setStatus: (key: string, text: string) => statuses.push([key, text]),
        notify: () => {},
      },
    };
    if (dispatchedCwd !== undefined) {
      assert.deepEqual(await handlers.get("project_trust")?.({ type: "project_trust", cwd: dispatchedCwd }, ctx),
        { trusted: "no" }, "the decline is never remembered in Pi's trust store");
    }
    // Agent Control launch metadata is absent here, so startup fails after the trust report.
    await assert.rejects(handlers.get("session_start")?.({}, ctx), /launch metadata is invalid/);
    assert.deepEqual(selects, [], "an offered UI is never used to decide project trust");
    return statuses.filter(([key]) => key === PI_PROJECT_TRUST_STATUS_KEY).map(([, text]) => text);
  };
  const cwd = "/repo/project";
  assert.deepEqual(await statusOf(cwd),
    [`launch-nonce.${PI_PROJECT_TRUST_DECLINED}.${Buffer.from(cwd).toString("base64url")}`]);
  assert.deepEqual(await statusOf(), [`launch-nonce.${PI_PROJECT_TRUST_NOT_REQUESTED}.`]);

  delete process.env[PI_PROJECT_TRUST_NONCE_ENV];
  assert.deepEqual(await statusOf(cwd), [], "a launch without its own nonce reports nothing");
});

test("generated Pi Agent Control extension blocks tools fail-closed", async (t) => {
  withEnv(t, { [PI_SECURITY_REQUEST_NONCE_ENV]: "security-nonce" });
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(piAgentControlExtensionSource()).toString("base64")}`);
  const handlers = loadExtensionHandlers(bridge);
  const messages: Array<{ title: string; message?: string }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      confirm: async (title: string, message: string) => {
        messages.push({ title, message });
        return true;
      },
    },
  };
  assert.equal(await handlers.get("tool_call")?.({
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "git status" },
  }, ctx), undefined);

  await handlers.get("tool_call")?.({
    toolCallId: "call-long",
    toolName: "bash",
    input: { command: "x".repeat(20_000) },
  }, ctx);
  const longEnvelope = messages.at(-1)?.message ?? "";
  const encoded = longEnvelope.slice(`${PI_SECURITY_REQUEST_PREFIX}security-nonce.`.length);
  const longPayload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(longPayload.input.length, 16_000);
  assert.match(longPayload.input, /… \[truncated by Wollipog\]$/);

  delete process.env[PI_SECURITY_REQUEST_NONCE_ENV];
  assert.deepEqual(await handlers.get("tool_call")?.({ toolCallId: "call-2", toolName: "write" }, ctx), {
    block: true,
    reason: "Blocked by Wollipog permission policy.",
  });
});
