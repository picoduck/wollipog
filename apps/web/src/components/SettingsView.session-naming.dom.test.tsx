import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type { SessionNamingMode, SessionNamingSettingsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { SessionNamingPanel } from "./SettingsView.js";

const domWindow = new Window({ url: "http://localhost/settings/session-naming" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function view(mode: SessionNamingMode): SessionNamingSettingsView {
  return {
    mode,
    effectiveMode: mode === "custom_model_endpoint" ? mode : "prompt_text_only",
    source: "organization",
    canManage: true,
    modes: {
      prompt_text_only: { available: true },
      session_agent_account: {
        available: false,
        reason: "Runner-hosted agent account naming is not available in this release.",
      },
      custom_model_endpoint: { available: true },
    },
    customModel: {
      endpointOrigin: "https://models.example",
      model: "small-title-model",
      timeoutMs: 750,
      apiKeyConfigured: true,
      configurationSource: "environment",
    },
  };
}

test("Session Naming shows every mode, explains unavailable agent accounts, and saves prompt-only", async () => {
  let mode: SessionNamingMode = "custom_model_endpoint";
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (method === "PUT") mode = JSON.parse(String(init?.body)).mode as SessionNamingMode;
      return new Response(JSON.stringify(view(mode)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <ApiProvider client={createApiClient(transport)}>
            <SessionNamingPanel />
          </ApiProvider>
        </React.StrictMode>,
      );
    });
    assert.equal(calls[0]?.path, "/api/session-naming");
    assert.match(container.textContent ?? "", /API key configured/);
    assert.match(container.textContent ?? "", /Managed through the control-plane environment/);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    assert.ok(trigger);
    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.deepEqual(options.map((option) => option.querySelector("span")?.textContent), [
      "Prompt Text OnlyUse the first completed user message. No model or provider credentials are required.",
      "Use Session Agent AccountUse the authenticated provider account on the session's Machine.Runner-hosted agent account naming is not available in this release.",
      "Custom Model EndpointSend selected session text to the operator-configured OpenAI-compatible endpoint.",
    ]);
    const agent = options[1]!;
    assert.equal(agent.getAttribute("aria-disabled"), "true");
    assert.match(agent.textContent ?? "", /not available in this release/);

    await act(async () => options[0]!.click());
    assert.equal(calls.at(-1)?.method, "PUT");
    assert.deepEqual(JSON.parse(calls.at(-1)?.body ?? "{}"), { mode: "prompt_text_only" });
    assert.equal(trigger.getAttribute("aria-label"), "Naming Mode: Prompt Text Only");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming identifies load failure and retries in place", async () => {
  let requests = 0;
  const transport: ApiTransport = {
    instanceId: "test-retry",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ error: "could not load session naming settings" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(view("prompt_text_only")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={createApiClient(transport)}>
          <SessionNamingPanel />
        </ApiProvider>,
      );
    });
    assert.match(container.textContent ?? "", /Could not load session naming: could not load session naming settings/);
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Retry");
    assert.ok(retry);

    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    assert.ok(trigger);
    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.ok(options.length > 0);
    for (const option of options) {
      assert.match(option.textContent ?? "", /Session naming settings could not be loaded/);
    }

    await act(async () => retry.click());
    assert.equal(requests, 2);
    assert.match(container.textContent ?? "", /Saved for this organization/);
    assert.doesNotMatch(container.textContent ?? "", /Load Failed/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming reports secret-free runner provider and billing availability", async () => {
  const available: SessionNamingSettingsView = {
    ...view("session_agent_account"),
    effectiveMode: "session_agent_account",
    modes: {
      ...view("session_agent_account").modes,
      session_agent_account: { available: true },
    },
    sessionAgentAccounts: [
      { provider: "claude", billingSource: "subscription", machineCount: 1 },
      { provider: "codex", billingSource: "provider_account", machineCount: 2 },
    ],
  };
  const transport: ApiTransport = {
    instanceId: "test-accounts",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(available), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={createApiClient(transport)}>
          <SessionNamingPanel />
        </ApiProvider>,
      );
    });
    assert.match(container.textContent ?? "", /Runner Accounts/);
    assert.match(container.textContent ?? "", /Claude · subscription · 1 Machine/);
    assert.match(container.textContent ?? "", /Codex · provider account · 2 Machines/);
    assert.match(container.textContent ?? "", /Each session uses only its own Machine and provider account/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming provisions runner configuration and keeps API keys write-only", async () => {
  const runnerView: SessionNamingSettingsView = {
    ...view("custom_model_endpoint"),
    effectiveMode: "custom_model_endpoint",
    customModel: {
      endpointOrigin: "https://models.example",
      model: "title-model",
      timeoutMs: 900,
      apiKeyConfigured: true,
      configurationSource: "runner",
      runnerId: "runner-one",
      machineName: "Build Machine",
      online: true,
    },
    customModelTargets: [{
      runnerId: "runner-one",
      machineName: "Build Machine",
      online: true,
      available: true,
      configured: true,
    }],
  };
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const transport: ApiTransport = {
    instanceId: "test-custom-runner",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (path.endsWith("/test")) {
        return new Response(JSON.stringify({ ok: true, status: "available" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(runnerView), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={createApiClient(transport)}>
          <SessionNamingPanel />
        </ApiProvider>,
      );
    });
    assert.match(container.textContent ?? "", /Stored on Build Machine/);
    for (const label of ["Endpoint", "Model", "Timeout", "API Key"]) {
      assert.ok(container.querySelector(`[aria-label="${label}"]`), `${label} field is visible`);
    }
    assert.ok(container.querySelector('[aria-label^="Machine: "]'), "Machine field is visible");
    for (const label of ["Save Configuration", "Replace API Key", "Delete API Key", "Test Connection"]) {
      assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === label));
    }

    const key = container.querySelector<HTMLInputElement>('[aria-label="API Key"]');
    assert.ok(key);
    await act(async () => {
      key.value = "write-only-browser-sentinel";
      Simulate.change(key);
    });
    const replace = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Replace API Key");
    assert.ok(replace);
    assert.equal(replace.disabled, false);
    await act(async () => replace.click());
    const replaceCall = calls.find((call) =>
      call.path === "/api/session-naming/custom-model/api-key" && call.method === "POST");
    assert.ok(replaceCall);
    assert.deepEqual(JSON.parse(replaceCall.body ?? "{}"), { apiKey: "write-only-browser-sentinel" });
    assert.equal(key.value, "");
    assert.doesNotMatch(container.textContent ?? "", /write-only-browser-sentinel/);
    assert.equal(domWindow.localStorage.length, 0);

    const testConnection = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Test Connection");
    assert.ok(testConnection);
    await act(async () => testConnection.click());
    assert.ok(calls.some((call) => call.path === "/api/session-naming/custom-model/test" && call.method === "POST"));
    assert.match(container.textContent ?? "", /Connection succeeded/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.localStorage.clear();
  }
});
