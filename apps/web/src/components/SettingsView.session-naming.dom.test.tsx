import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
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
