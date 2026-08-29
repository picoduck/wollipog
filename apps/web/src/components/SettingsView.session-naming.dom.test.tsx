import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionNamingMode, SessionNamingSettingsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { SessionNamingPanel } from "./SettingsView.js";

const domWindow = new Window({ url: "http://localhost/settings/behavior" });
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

function baseView(mode: SessionNamingMode = "prompt_text_only"): SessionNamingSettingsView {
  return {
    mode,
    effectiveMode: mode,
    source: "organization",
    canManage: true,
    modes: {
      prompt_text_only: { available: true },
      session_agent_account: { available: true },
      custom_model_endpoint: { available: false, reason: "Configure a custom endpoint first." },
    },
    harnessMachines: [{
      runnerId: "runner-build",
      machineName: "Build Machine",
      harnesses: [{
        agentId: "codex-app-server",
        name: "Codex App Server",
        driver: "codex-app-server",
        provider: "codex",
        billingSource: "api",
        models: [
          { id: "luna", displayName: "Luna", efforts: ["low", "medium"] },
          { id: "sol", displayName: "Sol", efforts: ["xhigh"] },
        ],
      }],
    }],
    customModelTargets: [{
      runnerId: "runner-build",
      machineName: "Build Machine",
      online: true,
      available: true,
      configured: false,
    }],
  };
}

async function renderPanel(transport: ApiTransport): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={createApiClient(transport)}>
        <SessionNamingPanel />
      </ApiProvider>,
    );
  });
  return { container, root };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").includes(name));
  assert.ok(button, `expected button named ${name}`);
  return button;
}

async function selectOption(
  container: HTMLElement,
  label: string,
  option: string,
  expectedListText?: RegExp,
): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `expected ${label} select`);
  await act(async () => trigger.click());
  if (expectedListText) {
    assert.match(container.querySelector(`[role="listbox"][aria-label="${label}"]`)?.textContent ?? "", expectedListText);
  }
  const choice = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").includes(option));
  assert.ok(choice, `expected ${option} option in ${label}`);
  await act(async () => choice.click());
  // Select restores focus through a zero-delay timer. Let that close complete before opening the
  // next progressive picker, or the pending focus move dismisses the newly opened list in tests.
  await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));
}

test("Session Naming is compact, progressively discloses a capability-backed target, and collapses after save", async () => {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let current = baseView();
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ path, method, ...(body ? { body } : {}) });
      if (path === "/api/session-naming/harness" && method === "PUT") {
        assert.deepEqual(body, {
          runnerId: "runner-build",
          agentId: "codex-app-server",
          driver: "codex-app-server",
          model: "luna",
          effort: "low",
        });
        current = {
          ...current,
          mode: "session_agent_account",
          effectiveMode: "session_agent_account",
          harnessTarget: {
            ...body,
            machineName: "Build Machine",
            harnessName: "Codex App Server",
            modelName: "Luna",
            available: true,
          } as NonNullable<SessionNamingSettingsView["harnessTarget"]>,
        };
      }
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.match(container.textContent ?? "", /Prompt Text Only/);
    assert.equal(container.querySelector("#session-naming-editor"), null);
    const row = buttonNamed(container, "Session Naming");
    assert.equal(row.getAttribute("aria-expanded"), "false");
    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.ok(container.querySelector('[aria-label^="Naming Mode:"]'));
    assert.equal(container.querySelector('[aria-label^="Machine:"]'), null);

    await selectOption(container, "Naming Mode", "Agent Harness");
    assert.ok(container.querySelector('[aria-label^="Machine:"]'));
    assert.equal(container.querySelector('[aria-label^="Agent Harness:"]'), null);
    await selectOption(container, "Machine", "Build Machine");
    await selectOption(container, "Agent Harness", "Codex App Server", /Codex · API/);
    await selectOption(container, "Model", "Luna");
    await selectOption(container, "Reasoning Effort", "Low");
    await act(async () => buttonNamed(container, "Save Configuration").click());

    assert.equal(container.querySelector("#session-naming-editor"), null);
    assert.match(container.textContent ?? "", /Codex App Server · Luna · Low/);
    assert.equal(calls.some((call) => call.path === "/api/session-naming/harness" && call.method === "PUT"), true);
    assert.equal(domWindow.document.activeElement, row);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming preserves canonical harness, billing, and effort labels", async () => {
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(baseView()), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(container, "Session Naming").click());
    await selectOption(container, "Naming Mode", "Agent Harness");
    await selectOption(container, "Machine", "Build Machine");
    await selectOption(container, "Agent Harness", "Codex App Server", /Codex · API/);
    await selectOption(container, "Model", "Sol");
    const effort = container.querySelector<HTMLButtonElement>('[aria-label^="Reasoning Effort:"]');
    assert.ok(effort);
    await act(async () => effort.click());
    assert.match(container.querySelector('[role="listbox"][aria-label="Reasoning Effort"]')?.textContent ?? "", /Extra High/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming distinguishes native and WSL harnesses in options, accessible names, and summaries", async () => {
  const current = baseView("session_agent_account");
  current.harnessMachines![0]!.harnesses = [{
    ...current.harnessMachines![0]!.harnesses[0]!,
    name: "Codex App Server (Native)",
    context: { kind: "native" },
  }, {
    ...current.harnessMachines![0]!.harnesses[0]!,
    agentId: "codex-app-server-wsl-Ubuntu",
    name: "Codex App Server (WSL: Ubuntu)",
    context: { kind: "wsl", distro: "Ubuntu" },
  }];
  current.harnessTarget = {
    runnerId: "runner-build",
    machineName: "Build Machine",
    agentId: "codex-app-server-wsl-Ubuntu",
    harnessName: "Codex App Server (WSL: Ubuntu)",
    driver: "codex-app-server",
    context: { kind: "wsl", distro: "Ubuntu" },
    provider: "codex",
    billingSource: "api",
    model: "luna",
    modelName: "Luna",
    effort: "low",
    available: true,
  };
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.match(container.textContent ?? "", /Codex App Server \(WSL: Ubuntu\) · Luna · Low/);
    await act(async () => buttonNamed(container, "Session Naming").click());
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Agent Harness:"]');
    assert.ok(trigger);
    assert.match(trigger.getAttribute("aria-label") ?? "", /Codex App Server \(WSL: Ubuntu\)/);
    await act(async () => trigger.click());
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.equal(options.every((option) => option.getAttribute("aria-label") === null), true,
      "option text supplies the accessible name");
    const names = options.map((option) => option.textContent?.trim());
    assert.deepEqual(names, ["Codex App Server (Native)Codex · API", "Codex App Server (WSL: Ubuntu)Codex · API"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming row toggles closed, drops its draft, and exposes controls only while expanded", async () => {
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(baseView()), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    const row = buttonNamed(container, "Session Naming");
    assert.equal(row.getAttribute("aria-controls"), null);
    await act(async () => row.click());
    await selectOption(container, "Naming Mode", "Agent Harness");
    await selectOption(container, "Machine", "Build Machine");
    assert.ok(container.querySelector('[aria-label^="Agent Harness:"]'));

    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "false");
    assert.equal(row.getAttribute("aria-controls"), null);
    assert.equal(container.querySelector("#session-naming-editor"), null);

    await act(async () => row.click());
    assert.equal(row.getAttribute("aria-expanded"), "true");
    assert.equal(row.getAttribute("aria-controls"), "session-naming-editor");
    assert.equal(container.querySelector('[aria-label^="Machine:"]'), null, "the unsaved mode and Machine draft were reset");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("legacy Follow Session Agent can be selected again without an explicit v95 target", async () => {
  const current = baseView();
  delete current.harnessMachines;
  current.sessionAgentAccounts = [{ provider: "codex", billingSource: "provider_account", machineCount: 1 }];
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      calls.push({ path, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      return new Response(JSON.stringify({
        ...current,
        ...((init?.method ?? "GET") === "PUT"
          ? { mode: "session_agent_account", effectiveMode: "session_agent_account" }
          : {}),
      }), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(container, "Session Naming").click());
    await selectOption(container, "Naming Mode", "Agent Harness");
    assert.equal(container.querySelector('[aria-label^="Machine:"]'), null);
    assert.match(container.textContent ?? "", /Each session will use its own Machine/);
    const save = buttonNamed(container, "Save Configuration");
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.deepEqual(calls.at(-1), {
      path: "/api/session-naming",
      method: "PUT",
      body: JSON.stringify({ mode: "session_agent_account" }),
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("viewers can inspect Session Naming but cannot operate target controls or Save", async () => {
  const current: SessionNamingSettingsView = {
    ...baseView("session_agent_account"),
    canManage: false,
    harnessTarget: {
      runnerId: "runner-build",
      machineName: "Build Machine",
      agentId: "codex-app-server",
      harnessName: "Codex App Server",
      driver: "codex-app-server",
      model: "luna",
      modelName: "Luna",
      effort: "low",
      available: true,
    },
  };
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(container, "Session Naming").click());
    assert.match(container.textContent ?? "", /owner or admin permission is required/);
    for (const label of ["Machine", "Agent Harness", "Model", "Reasoning Effort"]) {
      assert.equal(container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)?.getAttribute("aria-disabled"), "true", label);
    }
    assert.equal(buttonNamed(container, "Save Configuration").disabled, true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("changing an earlier harness choice clears downstream selections and Cancel collapses without saving", async () => {
  const calls: string[] = [];
  const cascadeView = baseView();
  cascadeView.harnessMachines?.push({
    runnerId: "runner-review",
    machineName: "Review Machine",
    harnesses: [{
      agentId: "codex-review",
      name: "Codex App Server",
      driver: "codex-app-server",
      provider: "codex",
      billingSource: "provider_account",
      models: [{ id: "sol", displayName: "Sol", efforts: ["high"] }],
    }],
  });
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return new Response(JSON.stringify(cascadeView), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    const row = buttonNamed(container, "Session Naming");
    await act(async () => row.click());
    await selectOption(container, "Naming Mode", "Agent Harness");
    await selectOption(container, "Machine", "Build Machine");
    await selectOption(container, "Agent Harness", "Codex App Server");
    await selectOption(container, "Machine", "Review Machine");
    assert.match(container.querySelector<HTMLButtonElement>('[aria-label^="Agent Harness:"]')?.getAttribute("aria-label") ?? "", /Select/);
    assert.equal(container.querySelector('[aria-label^="Model:"]'), null);
    assert.equal(container.querySelector('[aria-label^="Reasoning Effort:"]'), null);
    await act(async () => buttonNamed(container, "Cancel").click());
    assert.equal(container.querySelector("#session-naming-editor"), null);
    assert.deepEqual(calls, ["GET /api/session-naming"]);
    assert.equal(domWindow.document.activeElement, row);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Custom Model Endpoint fields stay hidden until selected and API keys remain write-only", async () => {
  const bodies: string[] = [];
  let current = baseView();
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      if (init?.body) bodies.push(String(init.body));
      if (path === "/api/session-naming/custom-model" && init?.method === "PUT") {
        current = {
          ...current,
          mode: "custom_model_endpoint",
          effectiveMode: "custom_model_endpoint",
          customModel: {
            endpointOrigin: "https://models.example",
            model: "title-model",
            timeoutMs: 900,
            apiKeyConfigured: true,
            configurationSource: "runner",
            runnerId: "runner-build",
            machineName: "Build Machine",
            online: true,
          },
        };
      }
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.equal(container.querySelector('[aria-label="Endpoint"]'), null);
    await act(async () => buttonNamed(container, "Session Naming").click());
    assert.equal(container.querySelector('[aria-label="Endpoint"]'), null);
    await selectOption(container, "Naming Mode", "Custom Model Endpoint");
    const setInput = async (label: string, value: string) => {
      const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
      assert.ok(input);
      await act(async () => { input.value = value; fireDomEvent.change(input); });
    };
    await selectOption(container, "Machine", "Build Machine");
    await setInput("Endpoint", "https://models.example/v1/chat/completions");
    await setInput("Model", "title-model");
    await setInput("Timeout", "900");
    await setInput("API Key", "write-only-secret");
    await act(async () => buttonNamed(container, "Save Configuration").click());
    assert.equal(container.querySelector('[aria-label="Endpoint"]'), null);
    assert.match(container.textContent ?? "", /Custom Model Endpoint · https:\/\/models.example/);
    assert.equal(JSON.stringify(current).includes("write-only-secret"), false);
    assert.equal(bodies.some((body) => body.includes("write-only-secret")), true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("editing a saved custom endpoint requires the complete URL and excludes competing key operations", async () => {
  const current: SessionNamingSettingsView = {
    ...baseView("custom_model_endpoint"),
    customModel: {
      endpointOrigin: "https://models.example",
      model: "title-model",
      timeoutMs: 900,
      apiKeyConfigured: true,
      configurationSource: "runner",
      runnerId: "runner-build",
      machineName: "Build Machine",
      online: true,
    },
  };
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let resolveSave!: (response: Response) => void;
  const pendingSave = new Promise<Response>((resolve) => { resolveSave = resolve; });
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (path === "/api/session-naming/custom-model" && method === "PUT") return pendingSave;
      return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  const setInput = async (label: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    assert.ok(input);
    await act(async () => { input.value = value; fireDomEvent.change(input); });
  };
  try {
    await act(async () => buttonNamed(container, "Session Naming").click());
    await setInput("Model", "haiku-title");
    assert.match(container.textContent ?? "", /Re-enter the complete endpoint URL/);
    assert.equal(buttonNamed(container, "Save Configuration").disabled, true);

    await setInput("Endpoint", "https://models.example/v1/chat/completions");
    const save = buttonNamed(container, "Save Configuration");
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(calls.at(-1)?.path, "/api/session-naming/custom-model");
    assert.deepEqual(JSON.parse(calls.at(-1)?.body ?? "{}"), {
      runnerId: "runner-build",
      endpoint: "https://models.example/v1/chat/completions",
      model: "haiku-title",
      timeoutMs: 900,
    });
    for (const label of ["Replace API Key", "Delete API Key", "Test Connection"]) {
      assert.equal(buttonNamed(container, label).disabled, true, label);
    }
    assert.equal(container.querySelector<HTMLButtonElement>('[aria-label^="Machine:"]')?.getAttribute("aria-disabled"), "true");

    await act(async () => {
      resolveSave(new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } }));
      await pendingSave;
    });
    assert.equal(container.querySelector("#session-naming-editor"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming shows sanitized drift fallback and retries a load failure in place", async () => {
  let requests = 0;
  const drifted: SessionNamingSettingsView = {
    ...baseView("session_agent_account"),
    effectiveMode: "prompt_text_only",
    harnessTarget: {
      runnerId: "runner-old",
      machineName: "Old Machine",
      agentId: "codex-app-server",
      harnessName: "Codex App Server",
      driver: "codex-app-server",
      model: "luna",
      modelName: "Luna",
      effort: "low",
      available: false,
      reason: "The selected Machine is offline.",
    },
  };
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      requests++;
      if (requests === 1) return new Response(JSON.stringify({ error: "could not load session naming settings" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
      return new Response(JSON.stringify(drifted), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.match(container.textContent ?? "", /Load Failed/);
    await act(async () => buttonNamed(container, "Retry").click());
    assert.match(container.textContent ?? "", /selected Machine is offline/);
    assert.match(container.textContent ?? "", /fall back to prompt-derived naming/);
    assert.equal(container.textContent?.includes("token"), false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming explains a pinned billing-boundary change and keeps prompt fallback visible", async () => {
  const drifted: SessionNamingSettingsView = {
    ...baseView("session_agent_account"),
    effectiveMode: "prompt_text_only",
    harnessTarget: {
      runnerId: "runner-build",
      machineName: "Build Machine",
      agentId: "codex-app-server",
      harnessName: "Codex App Server",
      driver: "codex-app-server",
      context: { kind: "native" },
      provider: "codex",
      billingSource: "subscription",
      model: "luna",
      modelName: "Luna",
      effort: "low",
      available: false,
      reason: "The selected Agent Harness billing source changed from Subscription to API. Review and save it to confirm the change.",
    },
  };
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(drifted), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.match(container.textContent ?? "", /billing source changed from Subscription to API/);
    assert.match(container.textContent ?? "", /fall back to prompt-derived naming/);
    assert.equal(container.textContent?.includes("account@"), false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Session Naming attributes drift fallback to the selected mode", async () => {
  const drifted: SessionNamingSettingsView = {
    ...baseView("custom_model_endpoint"),
    effectiveMode: "prompt_text_only",
    modes: {
      ...baseView().modes,
      custom_model_endpoint: { available: false, reason: "The custom endpoint Machine is offline." },
    },
    harnessTarget: {
      runnerId: "runner-old",
      machineName: "Old Machine",
      agentId: "codex-app-server",
      harnessName: "Codex App Server",
      driver: "codex-app-server",
      model: "luna",
      modelName: "Luna",
      effort: "low",
      available: false,
      reason: "The selected Agent Harness is no longer authenticated.",
    },
  };
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(drifted), { headers: { "content-type": "application/json" } });
    },
  };
  const { container, root } = await renderPanel(transport);
  try {
    assert.match(container.textContent ?? "", /custom endpoint Machine is offline/);
    assert.doesNotMatch(container.textContent ?? "", /Agent Harness is no longer authenticated/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
