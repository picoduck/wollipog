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

async function nextFrame(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve())));
}

async function renderPanel(transport: ApiTransport, discoveryRevision?: object): Promise<{
  container: HTMLDivElement;
  root: Root;
  render: (nextDiscoveryRevision?: object) => Promise<void>;
}> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = createApiClient(transport);
  const render = async (nextDiscoveryRevision?: object) => {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <AgentHarnessDefaultsPanel discoveryRevision={nextDiscoveryRevision} />
      </ApiProvider>,
    ));
  };
  await render(discoveryRevision);
  return { container, root, render };
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
    await nextFrame();
    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      body: {
        agentId: "codex",
        driver: "codex-app-server",
        context: { kind: "native" },
        config: { model: "luna", effort: "low", permissionMode: "danger-full-access" },
      },
    });
    const codexRow = buttonNamed(fixture.container, "Codex App Server");
    assert.equal(codexRow.getAttribute("aria-expanded"), "false");
    assert.equal(codexRow.getAttribute("aria-controls"), null);
    assert.equal(domWindow.document.activeElement, codexRow);
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);

    await act(async () => codexRow.click());
    assert.notEqual(codexRow.getAttribute("aria-controls"), null);
    buttonNamed(fixture.container, "Cancel").focus();
    await act(async () => buttonNamed(fixture.container, "Cancel").click());
    await nextFrame();
    assert.equal(domWindow.document.activeElement, codexRow);
    assert.equal(codexRow.getAttribute("aria-controls"), null);

    await act(async () => codexRow.click());
    await act(async () => buttonNamed(fixture.container, "Claude Code").click());
    assert.equal(codexRow.getAttribute("aria-expanded"), "false");
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
    const reset = buttonNamed(fixture.container, "Use Wollipog Default");
    reset.focus();
    await act(async () => reset.click());
    await nextFrame();
    assert.match(fixture.container.textContent ?? "", /0 Harness Defaults Configured/);
    const row = buttonNamed(fixture.container, "Codex App Server");
    assert.match(row.textContent ?? "", /Wollipog Default/);
    assert.equal(row.getAttribute("aria-controls"), null);
    assert.equal(domWindow.document.activeElement, row);
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

test("Agent Harness defaults keep focus on Retry after another failed load", async () => {
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const retry = buttonNamed(fixture.container, "Retry");
    retry.focus();
    await act(async () => retry.click());
    await nextFrame();
    assert.equal(domWindow.document.activeElement as unknown === buttonNamed(fixture.container, "Retry"), true);
    assert.match(fixture.container.textContent ?? "", /Load Failed/);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness defaults retry failed loads and keep mutation errors scoped to the editor", async () => {
  let calls = 0;
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
      if (init?.method === "PUT") return new Response(JSON.stringify({ error: "save rejected" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
      return new Response(JSON.stringify(view(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    assert.match(fixture.container.textContent ?? "", /Load Failed/);
    assert.equal(buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").disabled, true);
    const retry = buttonNamed(fixture.container, "Retry");
    retry.focus();
    await act(async () => retry.click());
    await nextFrame();
    const defaultsRow = buttonNamed(fixture.container, "Default Models, Efforts, and Permissions");
    assert.equal(defaultsRow.disabled, false);
    assert.equal(domWindow.document.activeElement, defaultsRow);
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);

    await act(async () => defaultsRow.click());
    const refresh = buttonNamed(fixture.container, "Refresh");
    refresh.focus();
    await act(async () => refresh.click());
    await nextFrame();
    assert.equal(domWindow.document.activeElement, refresh);

    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    const save = buttonNamed(fixture.container, "Save");
    save.focus();
    await act(async () => save.click());
    await nextFrame();
    assert.match(fixture.container.querySelector('[role="alert"]')?.textContent ?? "", /save rejected/);
    assert.match(buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").textContent ?? "",
      /1 Harness Default Configured/);
    assert.equal(buttonNamed(fixture.container, "Codex App Server").getAttribute("aria-expanded"), "true");
    assert.equal(domWindow.document.activeElement, save);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness defaults refresh on discovery and ignore an older overlapping response", async () => {
  let calls = 0;
  let resolveOlder!: (response: Response) => void;
  let resolveNewer!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { resolveOlder = resolve; });
  const newer = new Promise<Response>((resolve) => { resolveNewer = resolve; });
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify(view()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return calls === 2 ? older : newer;
    },
  });
  try {
    await fixture.render({ revision: 1 });
    await fixture.render({ revision: 2 });
    resolveNewer(new Response(JSON.stringify(view(true)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await act(async () => { await newer; });
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);

    resolveOlder(new Response(JSON.stringify(view()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await act(async () => { await older; });
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);
    assert.equal(calls, 3);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness discovery refresh repairs drafts and closes a removed editor with restored focus", async () => {
  let getCalls = 0;
  const repaired = view();
  repaired.defaults[0]!.installations[0]!.models = [{ id: "luna", displayName: "Luna", efforts: ["low"] }];
  repaired.defaults[0]!.installations[0]!.effortLevels = ["low"];
  const removed = view();
  removed.defaults = removed.defaults.filter((option) => option.agentId !== "codex");
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      getCalls += 1;
      const next = getCalls === 1 ? view() : getCalls === 2 ? repaired : removed;
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const defaultsRow = buttonNamed(fixture.container, "Default Models, Efforts, and Permissions");
    await act(async () => defaultsRow.click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await choose(fixture.container, "Codex App Server Model", "Sol");
    await choose(fixture.container, "Codex App Server Reasoning Effort", "Extra High");
    await choose(fixture.container, "Codex App Server Permission Mode", "Full Access");

    await fixture.render({ revision: 1 });
    assert.match(buttonNamed(fixture.container, "Codex App Server Model").getAttribute("aria-label") ?? "", /Choose Model/);
    assert.equal(fixture.container.querySelector('[aria-label^="Codex App Server Reasoning Effort:"]'), null);
    assert.match(buttonNamed(fixture.container, "Codex App Server Permission Mode").getAttribute("aria-label") ?? "", /Full Access/);

    buttonNamed(fixture.container, "Codex App Server Model").focus();
    await fixture.render({ revision: 2 });
    await nextFrame();
    assert.equal(fixture.container.textContent?.includes("Codex App Server"), false);
    assert.equal(domWindow.document.activeElement, defaultsRow);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness mutations outrank overlapping discovery reads without disabling local actions", async () => {
  let getCalls = 0;
  let resolvePut!: (response: Response) => void;
  let resolveFirstRefresh!: (response: Response) => void;
  let resolveLateRefresh!: (response: Response) => void;
  const put = new Promise<Response>((resolve) => { resolvePut = resolve; });
  const firstRefresh = new Promise<Response>((resolve) => { resolveFirstRefresh = resolve; });
  const lateRefresh = new Promise<Response>((resolve) => { resolveLateRefresh = resolve; });
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      if (init?.method === "PUT") return put;
      getCalls += 1;
      if (getCalls === 1) return new Response(JSON.stringify(view(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return getCalls === 2 ? firstRefresh : lateRefresh;
    },
  });
  const unrelated = domWindow.document.createElement("button") as unknown as HTMLButtonElement;
  unrelated.textContent = "Unrelated Control";
  domWindow.document.body.append(unrelated as never);
  try {
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await fixture.render({ revision: 1 });
    assert.equal(buttonNamed(fixture.container, "Cancel").disabled, false);
    assert.equal(buttonNamed(fixture.container, "Save").disabled, false);
    resolveFirstRefresh(new Response(JSON.stringify(view(true)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await act(async () => { await firstRefresh; });

    const save = buttonNamed(fixture.container, "Save");
    save.focus();
    await act(async () => save.click());
    assert.equal(buttonNamed(fixture.container, "Codex App Server").disabled, true);
    assert.equal(buttonNamed(fixture.container, "Claude Code").disabled, true);
    await fixture.render({ revision: 2 });
    unrelated.focus();
    await act(async () => {
      resolvePut(new Response(JSON.stringify(view(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await put;
    });
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);
    assert.equal(domWindow.document.activeElement, unrelated);

    await act(async () => {
      resolveLateRefresh(new Response(JSON.stringify(view()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await lateRefresh;
    });
    assert.match(fixture.container.textContent ?? "", /1 Harness Default Configured/);
  } finally {
    unrelated.remove();
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});

test("Agent Harness mutation failures refetch an invalidated discovery revision", async () => {
  let getCalls = 0;
  let resolvePut!: (response: Response) => void;
  let resolveInvalidatedRefresh!: (response: Response) => void;
  const put = new Promise<Response>((resolve) => { resolvePut = resolve; });
  const invalidatedRefresh = new Promise<Response>((resolve) => { resolveInvalidatedRefresh = resolve; });
  const fixture = await renderPanel({
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      if (init?.method === "PUT") return put;
      getCalls += 1;
      if (getCalls === 1) return new Response(JSON.stringify(view(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      if (getCalls === 2) return invalidatedRefresh;
      return new Response(JSON.stringify(view()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    await act(async () => buttonNamed(fixture.container, "Default Models, Efforts, and Permissions").click());
    await act(async () => buttonNamed(fixture.container, "Codex App Server").click());
    await act(async () => buttonNamed(fixture.container, "Save").click());
    await fixture.render({ revision: 1 });
    await act(async () => {
      resolvePut(new Response(JSON.stringify({ error: "save rejected" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }));
      await put;
    });
    assert.match(fixture.container.textContent ?? "", /0 Harness Defaults Configured/);
    assert.match(fixture.container.querySelector('[role="alert"]')?.textContent ?? "", /save rejected/);
    assert.equal(getCalls, 3);

    await act(async () => {
      resolveInvalidatedRefresh(new Response(JSON.stringify(view(true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await invalidatedRefresh;
    });
    assert.match(fixture.container.textContent ?? "", /0 Harness Defaults Configured/);
  } finally {
    await act(async () => fixture.root.unmount());
    fixture.container.remove();
  }
});
