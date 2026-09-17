import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_AGENT_CONTROL_PROBE_COMMAND,
  PI_SECURITY_REQUEST_NONCE_ENV,
  PI_SECURITY_REQUEST_PREFIX,
  PI_SECURITY_REQUEST_TITLE,
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

test("generated Pi Agent Control extension makes trust durable and blocks tools fail-closed", async (t) => {
  const originalNonce = process.env[PI_SECURITY_REQUEST_NONCE_ENV];
  process.env[PI_SECURITY_REQUEST_NONCE_ENV] = "security-nonce";
  t.after(() => {
    if (originalNonce === undefined) delete process.env[PI_SECURITY_REQUEST_NONCE_ENV];
    else process.env[PI_SECURITY_REQUEST_NONCE_ENV] = originalNonce;
  });
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(piAgentControlExtensionSource()).toString("base64")}`);
  const handlers = new Map<string, (...args: any[]) => any>();
  bridge.default({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  });
  const messages: Array<{ title: string; message?: string; options?: string[] }> = [];
  let trustChoice: string | undefined = "Trust This Project";
  const ctx = {
    hasUI: true,
    ui: {
      confirm: async (title: string, message: string) => {
        messages.push({ title, message });
        return true;
      },
      select: async (title: string, options: string[]) => {
        messages.push({ title, options });
        return trustChoice;
      },
    },
  };
  assert.deepEqual(await handlers.get("project_trust")?.({ cwd: "/repo" }, ctx), {
    trusted: "yes",
    remember: true,
  });
  assert.match(messages[0]?.title ?? "",
    new RegExp(`^${PI_SECURITY_REQUEST_TITLE}\\n${PI_SECURITY_REQUEST_PREFIX}security-nonce\\.`));
  assert.deepEqual(messages[0]?.options, ["Trust This Project", "Skip Project Resources"]);
  trustChoice = "Skip Project Resources";
  assert.deepEqual(await handlers.get("project_trust")?.({ cwd: "/repo" }, ctx), {
    trusted: "no",
    remember: true,
  });
  trustChoice = undefined;
  assert.deepEqual(await handlers.get("project_trust")?.({ cwd: "/repo" }, ctx), {
    trusted: "no",
  }, "cancelling trust fails closed without persisting a decision");
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
