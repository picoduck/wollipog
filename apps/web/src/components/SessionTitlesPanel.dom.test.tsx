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
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SessionTitlesPanel } from "./SessionTitlesPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/settings/behavior" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
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

function savedEndpoint(apiKeyConfigured: boolean): SessionNamingSettingsView {
  return {
    ...baseView("custom_model_endpoint"),
    modes: { ...baseView().modes, custom_model_endpoint: { available: true } },
    customModel: {
      endpointOrigin: "https://models.example",
      model: "title-model",
      timeoutMs: 900,
      apiKeyConfigured,
      configurationSource: "runner",
      runnerId: "runner-build",
      machineName: "Build Machine",
      online: true,
    },
  };
}

type Call = { path: string; method: string; body?: Record<string, unknown> };

/** A transport that records every call and answers each with `respond`, or the current view. */
function recordingTransport(
  view: () => SessionNamingSettingsView,
  respond?: (call: Call) => Response | Promise<Response> | undefined,
): { transport: ApiTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request(path, init) {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      const call = { path, method, ...(body ? { body } : {}) };
      calls.push(call);
      return await respond?.(call) ?? json(view());
    },
  };
  return { transport, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function renderPanel(transport: ApiTransport): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={createApiClient(transport)}>
        <FeedbackProvider><SessionTitlesPanel /></FeedbackProvider>
      </ApiProvider>,
    );
  });
  return { container, root };
}

async function cleanup({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

const body = () => domWindow.document.body as unknown as HTMLElement;
/** Dialogs are portalled to <body>; the newest is last. */
const dialogs = () => [...body().querySelectorAll<HTMLElement>('[role="dialog"]')];
const dialog = () => dialogs().at(-1) ?? null;

function buttonNamed(scope: HTMLElement, name: string): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name);
  assert.ok(button, `expected button named ${name}`);
  return button;
}

function queryButton(scope: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name);
}

const settle = () => act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));

async function selectOption(scope: HTMLElement, label: string, option: string): Promise<void> {
  const trigger = scope.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `expected ${label} select`);
  await act(async () => trigger.click());
  const choice = [...body().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").startsWith(option));
  assert.ok(choice, `expected ${option} option in ${label}`);
  await act(async () => choice.click());
  // Select restores focus through a zero-delay timer; let it finish before the next picker opens.
  await settle();
}

function input(scope: HTMLElement, label: string): HTMLInputElement {
  const target = [...scope.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  assert.ok(target, `expected a field labelled ${label}`);
  const field = byId(target.htmlFor) as HTMLInputElement | null;
  assert.ok(field, `expected the ${label} input`);
  return field;
}

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    field.value = value;
    fireDomEvent.change(field);
  });
}

async function leave(field: HTMLInputElement) {
  await act(async () => {
    field.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
  });
}

function byId(id: string): HTMLElement | null {
  return domWindow.document.getElementById(id) as unknown as HTMLElement | null;
}

test("the group is Session Titles with a Title Source row, in words a person uses", async () => {
  const { transport } = recordingTransport(() => baseView());
  const view = await renderPanel(transport);
  try {
    const group = view.container.querySelector("section.settings-group")!;
    assert.equal(group.querySelector(".settings-group-title")?.textContent, "Session Titles");
    assert.equal(group.querySelector(".settings-group-scope")?.textContent, "Your Account");
    const titles = [...group.querySelectorAll(".setting-row-title")].map((title) => title.textContent);
    assert.deepEqual(titles, ["Title Source"], "First Message has nothing to summarize");
    const trigger = group.querySelector<HTMLButtonElement>('[aria-label^="Title Source:"]')!;
    assert.equal(trigger.getAttribute("aria-label"), "Title Source: First Message");
    assert.match(group.textContent ?? "", /Use your first message\. No model needed\./);

    await act(async () => trigger.click());
    const list = body().querySelector('[role="listbox"]')!;
    assert.match(list.textContent ?? "", /First Message[\s\S]*Agent[\s\S]*An agent on one of your machines writes the title\.[\s\S]*Custom Endpoint/);
    await act(async () => trigger.click());
    await settle();

    await selectOption(view.container, "Title Source", "Agent");
    const text = `${view.container.textContent} ${dialog()?.textContent}`;
    for (const banned of [/Session Naming/i, /Agent Harness/, /Prompt Text Only/]) assert.doesNotMatch(text, banned);
  } finally {
    await cleanup(view);
  }
});

test("choosing First Message saves once and shows the Saved check", async () => {
  let current = baseView("session_agent_account");
  const { transport, calls } = recordingTransport(() => current, (call) => {
    if (call.method === "PUT") current = { ...current, mode: "prompt_text_only", effectiveMode: "prompt_text_only" };
    return undefined;
  });
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "First Message");
    assert.deepEqual(calls.filter((call) => call.method !== "GET"), [
      { path: "/api/session-naming", method: "PUT", body: { mode: "prompt_text_only" } },
    ]);
    assert.ok(view.container.querySelector(".setting-row-saved"), "the Saved check shows");
    assert.equal(view.container.querySelector('[role="status"]')?.textContent, "Title Source saved");
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"), "Title Source: First Message");
    assertNoDomNode(queryButton(view.container, "Edit…") ?? null, "First Message has no setup to edit");
  } finally {
    await cleanup(view);
  }
});

test("choosing Custom Endpoint opens its dialog, and Cancel keeps the previous source selected and stored", async () => {
  const { transport, calls } = recordingTransport(() => baseView());
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Custom Endpoint");
    assert.equal(dialog()?.querySelector(".modal-title")?.textContent, "Custom Endpoint for Titles");
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"),
      "Title Source: First Message", "the stored source shows while the dialog is open");
    await act(async () => buttonNamed(dialog()!, "Cancel").click());
    assertNoDomNode(dialog());
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"), "Title Source: First Message");
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["GET /api/session-naming"]);
  } finally {
    await cleanup(view);
  }
});

test("the endpoint dialog validates on blur and on Save, which stays enabled and focuses the first invalid field", async () => {
  const { transport, calls } = recordingTransport(() => baseView());
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Custom Endpoint");
    const panel = dialog()!;
    const url = input(panel, "Endpoint URL");
    assert.equal(url.type, "url");
    assert.equal(input(panel, "Model").placeholder, "Model ID");
    await type(url, "not a url");
    await leave(url);
    assert.equal(url.getAttribute("aria-invalid"), "true");
    const urlError = byId(url.getAttribute("aria-describedby")!);
    assert.equal(urlError?.className, "field-error");
    assert.equal(urlError?.textContent, "Enter a full URL, starting with https://.");

    const timeout = input(panel, "Timeout");
    await type(timeout, "10");
    await leave(timeout);
    assert.equal(timeout.getAttribute("aria-invalid"), "true");
    assert.match(panel.textContent ?? "", /Enter a timeout from 250 to 30,000 ms\./);
    assert.ok(timeout.getAttribute("aria-describedby")?.split(" ").some((id) =>
      byId(id)?.className === "field-error"));

    // Focus elsewhere first, so the move to the first invalid field is Save's doing.
    await act(async () => timeout.focus());
    const save = buttonNamed(panel, "Save");
    assert.equal(save.disabled, false);
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    assert.equal(domWindow.document.activeElement, url, "focus moves to the first invalid field");
    assert.equal(input(panel, "Model").getAttribute("aria-invalid"), "true", "Save reveals every error");
    assert.deepEqual(calls.filter((call) => call.method !== "GET"), [], "nothing is sent");

    await type(url, "https://models.example/v1/chat/completions");
    assert.equal(url.getAttribute("aria-invalid"), null, "a valid value clears its error as it is typed");
  } finally {
    await cleanup(view);
  }
});

test("key actions show only when they can act, and the key is write-only", async () => {
  let current = baseView();
  const { transport, calls } = recordingTransport(() => current, (call) => {
    if (call.path === "/api/session-naming/custom-model" && call.method === "PUT") current = savedEndpoint(true);
    return undefined;
  });
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Custom Endpoint");
    let panel = dialog()!;
    for (const name of ["Replace…", "Delete…", "Test Connection"]) assert.equal(queryButton(panel, name), undefined, name);
    assert.match(panel.textContent ?? "", /The key is sent once to that machine and never shown again\./);
    assert.match(panel.textContent ?? "", /Session text goes to your endpoint through this machine\./);
    await type(input(panel, "Endpoint URL"), "https://models.example/v1/chat/completions");
    await type(input(panel, "Model"), "title-model");
    await type(input(panel, "Timeout"), "900");
    await type(input(panel, "API Key (Optional)"), "write-only-secret");
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    assertNoDomNode(dialog(), "the dialog closes once it saves");

    assert.deepEqual(calls.at(-1)?.body, {
      runnerId: "runner-build",
      endpoint: "https://models.example/v1/chat/completions",
      model: "title-model",
      timeoutMs: 900,
      apiKey: "write-only-secret",
    });
    assert.equal(JSON.stringify(current).includes("write-only-secret"), false);
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"), "Title Source: Custom Endpoint");
    const titles = [...view.container.querySelectorAll(".setting-row-title")].map((title) => title.textContent);
    assert.deepEqual(titles, ["Title Source", "models.example through Build Machine"]);
    assert.match(view.container.textContent ?? "", /title-model, 900 ms timeout/);

    await act(async () => buttonNamed(view.container, "Edit…").click());
    panel = dialog()!;
    assert.match(panel.textContent ?? "", /A key is saved on Build Machine\./);
    assert.ok(queryButton(panel, "Replace…"));
    assert.equal(queryButton(panel, "Delete…")?.className, "btn sm ghost danger");
    assert.ok(queryButton(panel, "Test Connection"));
    assertNoDomNode(panel.querySelector('input[type="password"]'), "a saved key is a line, not a field");
    assert.match(panel.textContent ?? "", /Delete the saved key to send through another machine\./);
  } finally {
    await cleanup(view);
  }
});

test("Replace… sends a new key through its own dialog and Test Connection answers in the dialog", async () => {
  const { transport, calls } = recordingTransport(() => savedEndpoint(true), (call) => {
    if (call.path === "/api/session-naming/custom-model/test") return json({ ok: false, status: "authentication_failed" });
    return undefined;
  });
  const view = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(view.container, "Edit…").click());
    await act(async () => buttonNamed(dialog()!, "Test Connection").click());
    assert.match(dialog()!.textContent ?? "", /The endpoint refused the API key\./);

    await act(async () => buttonNamed(dialog()!, "Replace…").click());
    assert.equal(dialogs().length, 2, "Replace API Key stacks over the endpoint dialog");
    const replace = dialog()!;
    assert.equal(replace.querySelector(".modal-title")?.textContent, "Replace API Key");
    await act(async () => fireDomEvent.submit(replace.querySelector("form")!));
    assert.match(replace.textContent ?? "", /Enter the new API key\./);
    await type(input(replace, "New API Key"), "replacement-secret");
    await act(async () => fireDomEvent.submit(replace.querySelector("form")!));
    assert.equal(dialogs().length, 1);
    assert.deepEqual(calls.at(-1), {
      path: "/api/session-naming/custom-model/api-key",
      method: "POST",
      body: { apiKey: "replacement-secret" },
    });
    assert.match(dialog()!.textContent ?? "", /The new key is saved on Build Machine\./);
  } finally {
    await cleanup(view);
  }
});

test("Delete… asks in the stacked Delete API Key confirmation, and only its confirm deletes", async () => {
  let current = savedEndpoint(true);
  const { transport, calls } = recordingTransport(() => current, (call) => {
    if (call.method === "DELETE") current = savedEndpoint(false);
    return undefined;
  });
  const view = await renderPanel(transport);
  const deletes = () => calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  try {
    await act(async () => buttonNamed(view.container, "Edit…").click());
    await act(async () => buttonNamed(dialog()!, "Delete…").click());
    assert.equal(dialogs().length, 2, "the confirmation opens over the endpoint dialog");
    assert.match(dialog()!.textContent ?? "", /Delete API Key[\s\S]*The API key is deleted from the selected machine/);
    assert.equal(buttonNamed(dialog()!, "Delete API Key").className, "btn danger");
    await act(async () => buttonNamed(dialog()!, "Cancel").click());
    await settle();
    assert.equal(dialogs().length, 1);
    assert.deepEqual(deletes(), [], "Cancel deletes nothing");

    await act(async () => buttonNamed(dialog()!, "Delete…").click());
    await act(async () => buttonNamed(dialog()!, "Delete API Key").click());
    await settle();
    assert.deepEqual(deletes(), ["/api/session-naming/custom-model/api-key"]);
    assert.equal(dialogs().length, 1, "the endpoint dialog stays open");
    assert.equal(queryButton(dialog()!, "Delete…"), undefined);
    assert.ok(input(dialog()!, "API Key (Optional)"), "without a key, the field is back");
  } finally {
    await cleanup(view);
  }
});

test("the agent dialog preselects a machine's only agent, describes agents by sign-in, and saves the target", async () => {
  let current = baseView();
  const { transport, calls } = recordingTransport(() => current, (call) => {
    if (call.path === "/api/session-naming/harness") {
      current = {
        ...current,
        mode: "session_agent_account",
        effectiveMode: "session_agent_account",
        harnessTarget: {
          ...(call.body as { runnerId: string; agentId: string; driver: "codex-app-server"; model: string; effort: string }),
          machineName: "Build Machine",
          harnessName: "Codex App Server",
          modelName: "Luna",
          available: true,
        },
      };
    }
    return undefined;
  });
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Agent");
    const panel = dialog()!;
    assert.equal(panel.querySelector(".modal-title")?.textContent, "Agent for Titles");
    assert.match(panel.querySelector('[aria-label^="Machine:"]')?.getAttribute("aria-label") ?? "", /Build Machine/);
    assert.match(panel.querySelector('[aria-label^="Agent:"]')?.getAttribute("aria-label") ?? "", /Codex App Server/, "one agent is preselected");
    const agent = panel.querySelector<HTMLButtonElement>('[aria-label^="Agent:"]')!;
    await act(async () => agent.click());
    assert.match(body().querySelector('[role="listbox"]')?.textContent ?? "", /Codex, using an API key/);
    await act(async () => agent.click());
    await settle();

    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    assert.match(panel.textContent ?? "", /Choose a model\./);
    assert.equal(panel.querySelector('[aria-label^="Model:"]')?.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.activeElement, panel.querySelector('[aria-label^="Model:"]'));

    await selectOption(panel, "Model", "Luna");
    await selectOption(panel, "Reasoning Effort", "Low");
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    assertNoDomNode(dialog());
    assert.deepEqual(calls.at(-1), {
      path: "/api/session-naming/harness",
      method: "PUT",
      body: { runnerId: "runner-build", agentId: "codex-app-server", driver: "codex-app-server", model: "luna", effort: "low" },
    });
    const titles = [...view.container.querySelectorAll(".setting-row-title")].map((title) => title.textContent);
    assert.deepEqual(titles, ["Title Source", "Codex App Server on Build Machine"]);
    assert.match(view.container.textContent ?? "", /Luna, low effort/);
    assert.ok(view.container.querySelector(".setting-row-saved"));
  } finally {
    await cleanup(view);
  }
});

test("the migrated each-session agent keeps working and reads in plain words", async () => {
  let current = baseView();
  delete current.harnessMachines;
  const { transport, calls } = recordingTransport(() => current, (call) => {
    if (call.method === "PUT") current = { ...current, mode: "session_agent_account", effectiveMode: "session_agent_account" };
    return undefined;
  });
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Agent");
    assert.match(dialog()!.textContent ?? "", /Each session uses its own agent\./);
    assertNoDomNode(dialog()!.querySelector('[aria-label^="Machine:"]'));
    await act(async () => fireDomEvent.submit(dialog()!.querySelector("form")!));
    assert.deepEqual(calls.at(-1), { path: "/api/session-naming", method: "PUT", body: { mode: "session_agent_account" } });
    assert.match(view.container.textContent ?? "", /Each session uses its own agent/);
  } finally {
    await cleanup(view);
  }
});

test("without owner or admin permission, the sources are disabled with the reason as visible text", async () => {
  const { transport } = recordingTransport(() => ({ ...savedEndpoint(true), canManage: false }));
  const view = await renderPanel(transport);
  try {
    const trigger = view.container.querySelector('[aria-label^="Title Source:"]')!;
    assert.equal(trigger.getAttribute("aria-disabled"), "true");
    const reason = view.container.querySelector(".setting-row-reason");
    assert.equal(reason?.textContent, "Only an organization owner or admin can change this.");
    assert.ok(trigger.getAttribute("aria-describedby")?.includes(reason!.id));
    assert.equal(buttonNamed(view.container, "Edit…").disabled, true);
  } finally {
    await cleanup(view);
  }
});

test("a rejected fetch is a plain load-failure notice with Retry, never the browser's words", async () => {
  let requests = 0;
  const transport: ApiTransport = {
    instanceId: "test",
    publicOrigin: "http://localhost",
    close() {},
    async request() {
      requests++;
      if (requests === 1) throw new TypeError("Failed to fetch");
      return json(baseView());
    },
  };
  const view = await renderPanel(transport);
  try {
    const notice = view.container.querySelector('.settings-group [role="alert"]');
    assert.ok(notice, "the failure is a notice above the group's surface");
    assert.ok(notice.compareDocumentPosition(view.container.querySelector(".settings-group-surface")!) & 4, "above the surface");
    assert.match(notice.textContent ?? "", /^Couldn't load session title settings\. Check the connection, then try again\./);
    assert.doesNotMatch(view.container.textContent ?? "", /Failed to fetch|Load Failed|Could not load/);
    await act(async () => buttonNamed(view.container, "Retry").click());
    assertNoDomNode(view.container.querySelector('[role="alert"]'));
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"), "Title Source: First Message");
  } finally {
    await cleanup(view);
  }
});

test("a server's load failure says the plain sentence and keeps its own words for the tooltip", async () => {
  const { transport } = recordingTransport(() => baseView(), () => json({ error: "could not load session naming settings" }, 500));
  const view = await renderPanel(transport);
  try {
    const notice = view.container.querySelector('[role="alert"]')!;
    assert.match(notice.textContent ?? "", /^Couldn't load session title settings\./);
    assert.equal(notice.querySelector("[title]")?.getAttribute("title"), "could not load session naming settings");
  } finally {
    await cleanup(view);
  }
});

test("a failed dialog save is a danger notice above the footer, with Show Details for the server's words", async () => {
  const { transport } = recordingTransport(() => baseView(), (call) =>
    call.method === "PUT" ? json({ error: "the selected Machine rejected the configuration" }, 409) : undefined);
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Agent");
    const panel = dialog()!;
    await selectOption(panel, "Model", "Luna");
    await selectOption(panel, "Reasoning Effort", "Low");
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    const notice = panel.querySelector('[role="alert"]')!;
    assert.match(notice.textContent ?? "", /Couldn't save the title source\. Your choices are still here/);
    assert.doesNotMatch(notice.textContent ?? "", /rejected the configuration/, "the detail waits behind Show Details");
    await act(async () => buttonNamed(notice as HTMLElement, "Show Details").click());
    assert.match(notice.textContent ?? "", /rejected the configuration/);
    assert.equal(view.container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-label"), "Title Source: First Message");
  } finally {
    await cleanup(view);
  }
});

test("a save that fails after switching instances never touches the new instance's state", async () => {
  const deferred = () => {
    let reject!: (cause: unknown) => void;
    const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
    return { promise, reject };
  };
  const saves = { a: deferred(), b: deferred() };
  const transport = (name: "a" | "b"): ApiTransport => ({
    instanceId: name,
    publicOrigin: "http://localhost",
    close() {},
    async request(_path, init) {
      return (init?.method ?? "GET") === "PUT" ? saves[name].promise : json(baseView("session_agent_account"));
    },
  });
  const clients = { a: createApiClient(transport("a")), b: createApiClient(transport("b")) };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = (name: "a" | "b") => root.render(
    <ApiProvider client={clients[name]}><FeedbackProvider><SessionTitlesPanel /></FeedbackProvider></ApiProvider>,
  );
  const sourceDisabled = () => container.querySelector('[aria-label^="Title Source:"]')?.getAttribute("aria-disabled");
  try {
    await act(async () => draw("a"));
    await selectOption(container, "Title Source", "First Message");
    await act(async () => draw("b"));
    await selectOption(container, "Title Source", "First Message");
    assert.equal(sourceDisabled(), "true", "B's save is running");
    await act(async () => {
      saves.a.reject(new TypeError("Failed to fetch"));
      await saves.a.promise.catch(() => undefined);
    });
    await settle();
    assert.equal(sourceDisabled(), "true", "A's failure does not end B's save");
    assertNoDomNode(container.querySelector('[role="alert"]'), "A's failure is not shown on B");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a typed API key never reaches the DOM, before or after a failed save (#3814)", async () => {
  const { transport, calls } = recordingTransport(() => baseView(), (call) =>
    call.method === "PUT" ? json({ error: "the selected Machine rejected the configuration" }, 409) : undefined);
  const view = await renderPanel(transport);
  try {
    await selectOption(view.container, "Title Source", "Custom Endpoint");
    const panel = dialog()!;
    const url = input(panel, "Endpoint URL");
    await type(url, "http://models.internal/v1");
    await type(input(panel, "Model"), "title-model");
    await leave(url);
    assert.equal(url.getAttribute("aria-invalid"), null, "without a key, an http endpoint is allowed");
    const key = input(panel, "API Key (Optional)");
    await type(key, "endpoint-key-secret");
    assert.doesNotMatch(body().innerHTML, /endpoint-key-secret/, "a typed key is not mirrored into a value attribute");
    await leave(url);
    assert.equal(byId(url.getAttribute("aria-describedby")!)?.textContent, "Use an https:// URL to send an API key.",
      "a typed key still decides how the endpoint is checked");
    await type(key, "");
    assert.equal(url.getAttribute("aria-invalid"), null, "and removing it clears that error");

    await type(url, "https://models.example/v1/chat/completions");
    await type(key, "endpoint-key-secret");
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    await settle();
    assert.equal(calls.at(-1)?.body?.apiKey, "endpoint-key-secret", "Save sends the typed key");
    assert.match(panel.querySelector('[role="alert"]')?.textContent ?? "", /Couldn't save the endpoint\./);
    assert.equal(key.value, "", "the key is not kept past the request that carried it");
    assert.doesNotMatch(body().innerHTML, /endpoint-key-secret/, "nor is it in the DOM after the failure");
  } finally {
    await cleanup(view);
  }
});

test("a replacement API key never reaches the DOM, before or after a failed replace (#3814)", async () => {
  const { transport } = recordingTransport(() => savedEndpoint(true), (call) =>
    call.path === "/api/session-naming/custom-model/api-key" ? json({ error: "the machine is offline" }, 409) : undefined);
  const view = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(view.container, "Edit…").click());
    await act(async () => buttonNamed(dialog()!, "Replace…").click());
    const replace = dialog()!;
    const key = input(replace, "New API Key");
    await type(key, "replacement-key-secret");
    assert.doesNotMatch(body().innerHTML, /replacement-key-secret/);
    await act(async () => fireDomEvent.submit(replace.querySelector("form")!));
    await settle();
    assert.match(replace.textContent ?? "", /The API key wasn't replaced\./);
    assert.equal(key.value, "");
    assert.doesNotMatch(body().innerHTML, /replacement-key-secret/, "nor after the failure");
    await act(async () => fireDomEvent.submit(replace.querySelector("form")!));
    assert.match(replace.textContent ?? "", /Enter the new API key\./, "a cleared field asks for the key again");
  } finally {
    await cleanup(view);
  }
});

test("with a saved key, an http URL off this machine is refused before anything is sent", async () => {
  const { transport, calls } = recordingTransport(() => savedEndpoint(true));
  const view = await renderPanel(transport);
  try {
    await act(async () => buttonNamed(view.container, "Edit…").click());
    const panel = dialog()!;
    const url = input(panel, "Endpoint URL");
    await type(url, "http://models.internal/v1");
    await leave(url);
    assert.equal(url.getAttribute("aria-invalid"), "true");
    assert.equal(byId(url.getAttribute("aria-describedby")!)?.textContent, "Use an https:// URL to send an API key.");
    await act(async () => fireDomEvent.submit(panel.querySelector("form")!));
    assert.equal(domWindow.document.activeElement, url);
    assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
    await type(url, "http://127.0.0.1:8080/v1");
    assert.equal(url.getAttribute("aria-invalid"), null, "a loopback endpoint may keep its key");
  } finally {
    await cleanup(view);
  }
});

test("an unavailable source says in its row that new sessions use their first message", async () => {
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
  const { transport } = recordingTransport(() => drifted);
  const view = await renderPanel(transport);
  try {
    const rows = [...view.container.querySelectorAll(".setting-row")];
    assert.equal(rows[1]?.querySelector(".setting-row-title")?.textContent, "Codex App Server on Old Machine");
    assert.equal(rows[1]?.querySelector(".setting-row-desc")?.textContent,
      "The selected Machine is offline. New sessions use their first message instead.");
  } finally {
    await cleanup(view);
  }
});
