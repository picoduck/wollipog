import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentHarnessDefaultsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { AgentHarnessDefaultsPanel } from "./SettingsView.js";

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

function view(preference = false): AgentHarnessDefaultsView {
  return {
    defaults: [
      {
        agentId: "codex",
        driver: "codex-app-server",
        context: { kind: "native" },
        name: "Codex App Server",
        installations: [{
          runnerId: "runner-one",
          machineName: "Build Machine",
          online: true,
          models: [
            { id: "luna", displayName: "Luna", efforts: ["low", "high"] },
            { id: "sol", displayName: "Sol", efforts: ["xhigh"] },
          ],
          effortLevels: ["low", "high", "xhigh"],
          permissionModes: ["auto-review", "danger-full-access"],
        }],
        ...(preference ? { preference: { model: "luna", effort: "low", permissionMode: "danger-full-access" } } : {}),
        compatibleInstallations: 1,
      },
      {
        agentId: "claude-code",
        driver: "claude-code",
        context: { kind: "native" },
        name: "Claude Code",
        installations: [{
          runnerId: "runner-one",
          machineName: "Build Machine",
          online: true,
          models: [{ id: "opus", displayName: "Opus", efforts: ["high"] }],
          effortLevels: ["high"],
          permissionModes: ["auto", "plan"],
        }],
        compatibleInstallations: 1,
      },
    ],
  };
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").includes(name));
  assert.ok(button, `expected button named ${name}`);
  return button;
}

async function choose(container: HTMLElement, label: string, option: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `expected ${label} select`);
  await act(async () => trigger.click());
  const choice = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").includes(option));
  assert.ok(choice, `expected ${option} option in ${label}`);
  await act(async () => choice.click());
  await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));
}

async function renderPanel(transport: ApiTransport): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={createApiClient(transport)}><AgentHarnessDefaultsPanel /></ApiProvider>,
  ));
  return { container, root };
}

test("Agent Harness defaults progressively filter choices, save permission mode, and keep one editor open", async () => {
  const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
  let current = view();
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      assert.equal(path, "/api/agent-harness-defaults");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ method, ...(body ? { body } : {}) });
      if (method === "PUT") current = view(true);
      if (method === "DELETE") current = view(false);
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    assert.match(fixture.container.textContent ?? "", /0 Harness Defaults Configured/);
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    assert.equal(buttonNamed(fixture.container, "Codex App Server").getAttribute("aria-expanded"), "true");

    await choose(fixture.container, "Codex App Server Model", "Luna");
    assert.equal(fixture.container.querySelector('[aria-label^="Codex App Server Reasoning Effort:"]') !== null, true);
    await choose(fixture.container, "Codex App Server Reasoning Effort", "Low");
    await choose(fixture.container, "Codex App Server Permission Mode", "Full Access");
    await act(async () => buttonNamed(fixture.container, "Save").click());
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      body: {
        agentId: "codex",
        driver: "codex-app-server",
        context: { kind: "native" },
        config: { model: "luna", effort: "low", permissionMode: "danger-full-access" },
      },
    });
    assert.equal(buttonNamed(fixture.container, "Codex App Server").getAttribute("aria-expanded"), "false");
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);

    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await act(async () => buttonNamed(fixture.container, "Claude Code").click());
    assert.equal(buttonNamed(fixture.container, "Codex App Server").getAttribute("aria-expanded"), "false");
    assert.equal(buttonNamed(fixture.container, "Claude Code").getAttribute("aria-expanded"), "true");
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness defaults can restore the Wollipog default", async () => {
  let current = view(true);
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      if (init?.method === "DELETE") current = view(false);
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await act(async () => buttonNamed(fixture.container, "Use Wollipog Default").click());
    assert.match(fixture.container.textContent ?? "", /0 Harness Defaults Configured/);
    assert.match(buttonNamed(fixture.container, "Codex App Server").textContent ?? "", /Wollipog Default/);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness defaults discard hidden drifted values while preserving supported choices", async () => {
  const current = view(true);
  const codex = current.defaults[0]!;
  codex.installations[0]!.models = [{ id: "sol", displayName: "Sol", efforts: ["xhigh"] }];
  codex.compatibleInstallations = 0;
  const calls: Array<Record<string, unknown>> = [];
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      if (init?.method === "PUT" && init.body) calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    assert.match(buttonNamed(fixture.container, "Codex App Server Model").getAttribute("aria-label") ?? "", /Choose Model/);
    await act(async () => buttonNamed(fixture.container, "Save").click());
    assert.deepEqual(calls.at(-1), {
      agentId: "codex",
      driver: "codex-app-server",
      context: { kind: "native" },
      config: { permissionMode: "danger-full-access" },
    });
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness defaults offer only combinations supported by one Machine", async () => {
  const current = view();
  const codex = current.defaults[0]!;
  const installation = codex.installations[0]!;
  codex.installations = [
    {
      ...installation,
      models: [{ id: "luna", displayName: "Luna", efforts: ["low"] }],
      effortLevels: ["low"],
      permissionModes: ["auto-review"],
    },
    {
      ...installation,
      runnerId: "runner-two",
      machineName: "Second Machine",
      models: [{ id: "sol", displayName: "Sol", efforts: ["xhigh"] }],
      effortLevels: ["xhigh"],
      permissionModes: ["danger-full-access"],
    },
  ];
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await choose(fixture.container, "Codex App Server Model", "Luna");
    await choose(fixture.container, "Codex App Server Reasoning Effort", "Low");
    await act(async () => buttonNamed(fixture.container, "Codex App Server Permission Mode").click());
    const options = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .map((option) => option.textContent ?? "");
    assert.equal(options.some((label) => label.includes("Approve for Me")), true);
    assert.equal(options.some((label) => label.includes("Full Access")), false);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});
