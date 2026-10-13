import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { AgentHarnessDefaultsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { AgentDefaultsPanel } from "./AgentDefaultsPanel.js";
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
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
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

/** Codex App Server (Luna or Sol), Claude Code (Opus) and an agent with nothing to choose. */
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
      {
        agentId: "plain",
        driver: "acp",
        context: { kind: "native" },
        name: "Plain Agent",
        installations: [{
          runnerId: "runner-one",
          machineName: "Build Machine",
          online: true,
          models: [],
          effortLevels: [],
          permissionModes: [],
        }],
        compatibleInstallations: 1,
      },
    ],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function transport(request: ApiTransport["request"]): ApiTransport {
  return { instanceId: "test", publicOrigin: "http://localhost", close() {}, request };
}

const body = () => domWindow.document.body as unknown as HTMLElement;
/** What has focus, as the DOM types know it (happy-dom has its own). */
const focused = () => domWindow.document.activeElement as unknown as Element | null;

function buttonNamed(name: string | RegExp, scope: HTMLElement = body()): HTMLButtonElement {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    const label = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
    return typeof name === "string" ? label === name || candidate.textContent === name : name.test(label);
  });
  assert.ok(button, `expected button named ${name}`);
  return button;
}

/** The row for an agent, by its title. */
function row(container: HTMLElement, title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".setting-row")].find((candidate) =>
    candidate.querySelector(".setting-row-title")?.textContent === title);
  assert.ok(found, `expected a row for ${title}`);
  return found;
}

function dialog(): HTMLElement {
  const found = body().querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(found, "expected the dialog");
  return found;
}

async function choose(label: string, option: string): Promise<void> {
  const trigger = body().querySelector<HTMLButtonElement>(`[role="dialog"] [aria-label^="${label}:"]`);
  assert.ok(trigger, `expected ${label} select`);
  await act(async () => trigger.click());
  const choice = [...body().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").startsWith(option));
  assert.ok(choice, `expected ${option} option in ${label}`);
  await act(async () => choice.click());
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));
}

async function nextFrame(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => domWindow.requestAnimationFrame(() => resolve())));
  await settle();
}

async function openEditor(container: HTMLElement, agent: string): Promise<HTMLButtonElement> {
  const edit = buttonNamed("Edit…", row(container, agent));
  edit.focus();
  await act(async () => edit.click());
  await settle();
  return edit;
}

async function renderPanel(api: ApiTransport, options: { onOpenConnections?: () => void } = {}): Promise<{
  container: HTMLDivElement;
  root: Root;
  render: (discoveryRevision?: object) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = createApiClient(api);
  const render = async (discoveryRevision?: object) => {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <AgentDefaultsPanel discoveryRevision={discoveryRevision} onOpenConnections={options.onOpenConnections} />
      </ApiProvider>,
    ));
    await settle();
  };
  await render();
  return {
    container,
    root,
    render,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("every agent is a row with no expansion: Edit…, a sentence-case summary, or Not Configurable", async () => {
  const fixture = await renderPanel(transport(async () => json(view(true))));
  try {
    const { container } = fixture;
    const group = container.querySelector("section.settings-group");
    assert.ok(group);
    assert.equal(group.querySelector(".settings-group-title")?.textContent, "Agent Defaults");
    assert.equal(group.querySelector(".settings-group-scope")?.textContent, "Your Account");
    assert.equal(group.querySelector(".settings-group-desc")?.textContent,
      "What each agent starts with. You can still change it in any session.");
    const refresh = buttonNamed("Refresh Agents", group as HTMLElement);
    assert.ok(refresh.classList.contains("icon-btn") && refresh.classList.contains("sm"));

    assert.equal(container.querySelectorAll(".settings-group-surface > .setting-row").length, 3);
    assertNoDomNode(container.querySelector("[aria-expanded]"));
    assertNoDomNode(container.querySelector(".setting-row-chevron"));

    const codex = row(container, "Codex App Server");
    assert.equal(codex.querySelector(".setting-row-desc")?.textContent, "Luna, low effort, Full Access (No Sandbox)");
    assert.doesNotMatch(codex.textContent ?? "", /·/);
    const edit = buttonNamed("Edit…", codex);
    assert.equal(edit.getAttribute("aria-haspopup"), "dialog");

    const claude = row(container, "Claude Code");
    assert.equal(claude.querySelector(".setting-row-desc")?.textContent, "Uses Wollipog defaults");
    buttonNamed("Edit…", claude);

    const plain = row(container, "Plain Agent");
    assert.equal(plain.querySelector(".setting-row-desc")?.textContent, "This agent has no model or permission choices.");
    assert.equal(plain.querySelector(".setting-row-control")?.textContent, "Not Configurable");
    assertNoDomNode(plain.querySelector("button"));
  } finally {
    await fixture.cleanup();
  }
});

test("Edit… opens the agent's dialog; Save Defaults saves, closes, updates the row and returns focus", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  let current = view();
  const fixture = await renderPanel(transport(async (path, init) => {
    assert.equal(path, "/api/agent-harness-defaults");
    const method = init?.method ?? "GET";
    const sent = init?.body ? JSON.parse(String(init.body)) as { config?: Record<string, string> } : undefined;
    calls.push({ method, ...(sent ? { body: sent } : {}) });
    if (method === "PUT") {
      current = view();
      current.defaults[0]!.preference = sent!.config!;
    }
    return json(current);
  }));
  try {
    const edit = await openEditor(fixture.container, "Codex App Server");
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Codex App Server Defaults");
    // No saved defaults: Use Wollipog Defaults is not offered.
    assert.equal([...body().querySelectorAll("button")].some((button) => button.textContent === "Use Wollipog Defaults"), false);
    assert.match(dialog().textContent ?? "", /Changes apply to new sessions\./);
    // Each field starts on Wollipog Default; an effort waits for a model.
    assert.match(buttonNamed(/^Model:/, dialog()).getAttribute("aria-label") ?? "", /Wollipog Default/);
    assert.equal(buttonNamed(/^Reasoning Effort:/, dialog()).getAttribute("aria-disabled"), "true");
    assert.equal(dialog().querySelector("#agent-defaults-effort-helper")?.textContent, "Choose a model first.");

    await choose("Model", "Luna");
    await choose("Reasoning Effort", "High");
    await choose("Permission Mode", "Full Access");
    await act(async () => buttonNamed("Save Defaults").click());
    await nextFrame();

    assert.deepEqual(calls.at(-1), {
      method: "PUT",
      body: {
        agentId: "codex",
        driver: "codex-app-server",
        context: { kind: "native" },
        config: { model: "luna", effort: "high", permissionMode: "danger-full-access" },
      },
    });
    assertNoDomNode(body().querySelector('[role="dialog"]'));
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Luna, high effort, Full Access (No Sandbox)");
    assert.ok(focused() === edit, "focus is on Edit…");
  } finally {
    await fixture.cleanup();
  }
});

test("a model with efforts needs an effort, shown on the field instead of saving", async () => {
  const methods: string[] = [];
  const fixture = await renderPanel(transport(async (_path, init) => {
    methods.push(init?.method ?? "GET");
    return json(view());
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Sol");
    await act(async () => buttonNamed("Save Defaults").click());
    await settle();
    assert.deepEqual(methods, ["GET"]);
    const effort = buttonNamed(/^Reasoning Effort:/, dialog());
    assert.equal(effort.getAttribute("aria-invalid"), "true");
    assert.ok(focused() === effort, "focus is on Reasoning Effort");
    assert.match(dialog().querySelector(".field-error")?.textContent ?? "", /Choose a reasoning effort for this model\./);

    await choose("Reasoning Effort", "Extra High");
    assertNoDomNode(dialog().querySelector(".field-error"));
  } finally {
    await fixture.cleanup();
  }
});

test("Use Wollipog Defaults clears the saved preference", async () => {
  const methods: string[] = [];
  let current = view(true);
  const fixture = await renderPanel(transport(async (_path, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "DELETE") current = view();
    return json(current);
  }));
  try {
    const edit = await openEditor(fixture.container, "Codex App Server");
    // The saved choice is the starting draft.
    assert.match(buttonNamed(/^Model:/, dialog()).getAttribute("aria-label") ?? "", /Luna/);
    const reset = buttonNamed("Use Wollipog Defaults");
    assert.ok(reset.classList.contains("ghost"));
    await act(async () => reset.click());
    await nextFrame();
    assert.deepEqual(methods, ["GET", "DELETE"]);
    assertNoDomNode(body().querySelector('[role="dialog"]'));
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Uses Wollipog defaults");
    assert.ok(focused() === edit, "focus is on Edit…");
  } finally {
    await fixture.cleanup();
  }
});

test("a rejected save keeps the dialog open with the draft and a danger notice above the footer", async () => {
  let gets = 0;
  const fixture = await renderPanel(transport(async (_path, init) => {
    if (init?.method === "PUT") return json({ error: "agent harness default rejected: database is locked" }, 503);
    gets += 1;
    return json(view());
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Luna");
    await choose("Reasoning Effort", "Low");
    await act(async () => buttonNamed("Save Defaults").click());
    await nextFrame();

    const notice = dialog().querySelector<HTMLElement>('.notice[role="alert"]');
    assert.ok(notice, "a danger notice");
    assert.ok(notice.classList.contains("t-danger"));
    assert.match(notice.textContent ?? "", /Defaults Not Saved/);
    assert.match(notice.textContent ?? "", /Your choices are still here/);
    // The server's words are behind Show Details, not in the sentence.
    assert.doesNotMatch(notice.textContent ?? "", /database is locked/);
    await act(async () => buttonNamed("Show Details", notice).click());
    assert.match(notice.textContent ?? "", /database is locked/);
    // It is the body's last child, directly above the footer.
    const form = dialog().querySelector("form");
    assert.equal(form?.lastElementChild, notice);

    assert.match(buttonNamed(/^Model:/, dialog()).getAttribute("aria-label") ?? "", /Luna/);
    assert.match(buttonNamed(/^Reasoning Effort:/, dialog()).getAttribute("aria-label") ?? "", /Low/);
    // The failure reads the list again, so the draft is checked against what the agent offers now.
    assert.equal(gets, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("an older server shows Update Wollipog with Retry, and Retry brings the rows", async () => {
  let gets = 0;
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    return gets === 1 ? json({ error: "Not Found" }, 404) : json(view());
  }));
  try {
    const notice = fixture.container.querySelector<HTMLElement>(".notice");
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /Update Wollipog to Use Agent Defaults/);
    assert.match(notice.textContent ?? "", /This version of Wollipog doesn't support agent defaults\./);
    assertNoDomNode(fixture.container.querySelector(".settings-group-surface"));
    const retry = buttonNamed("Retry", notice);
    retry.focus();
    await act(async () => retry.click());
    await nextFrame();
    assertNoDomNode(fixture.container.querySelector(".notice"));
    row(fixture.container, "Codex App Server");
    assert.ok(focused() === buttonNamed("Refresh Agents"), "focus is on Refresh Agents");
  } finally {
    await fixture.cleanup();
  }
});

test("any other failure says Couldn't Load Agent Defaults with details, and a failed refresh keeps the rows", async () => {
  let gets = 0;
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    if (gets === 1 || gets === 3) return json({ error: "connection reset by peer" }, 502);
    return json(view(true));
  }));
  try {
    let notice = fixture.container.querySelector<HTMLElement>('.notice[role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /Couldn't Load Agent Defaults/);
    buttonNamed("Show Details", notice);
    await act(async () => buttonNamed("Retry", notice!).click());
    await nextFrame();
    row(fixture.container, "Codex App Server");

    await act(async () => buttonNamed("Refresh Agents").click());
    await nextFrame();
    notice = fixture.container.querySelector<HTMLElement>('.notice[role="alert"]');
    assert.ok(notice);
    assert.match(notice.textContent ?? "", /Couldn't Load Agent Defaults/);
    assert.match(notice.textContent ?? "", /may be out of date/);
    // Above the surface, and the rows stay.
    assert.equal(notice.nextElementSibling?.classList.contains("settings-group-surface"), true);
    row(fixture.container, "Codex App Server");
  } finally {
    await fixture.cleanup();
  }
});

test("no agents shows No Agents Connected with Open Connections", async () => {
  let opened = 0;
  const fixture = await renderPanel(transport(async () => json({ defaults: [] })), { onOpenConnections: () => { opened += 1; } });
  try {
    const state = fixture.container.querySelector(".settings-state-surface > .state.compact");
    assert.ok(state);
    assert.match(state.textContent ?? "", /No Agents Connected/);
    await act(async () => buttonNamed("Open Connections").click());
    assert.equal(opened, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a slow first read shows three skeleton rows", async () => {
  let answer!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { answer = resolve; });
  const fixture = await renderPanel(transport(() => pending));
  try {
    assertNoDomNode(fixture.container.querySelector(".approvals-skeleton"));
    await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 350)));
    const skeleton = fixture.container.querySelector(".approvals-skeleton");
    assert.ok(skeleton);
    assert.equal(skeleton.querySelectorAll(".setting-row").length, 3);
    assert.match(skeleton.textContent ?? "", /Loading agent defaults…/);
    await act(async () => {
      answer(json(view()));
      await pending;
    });
    await settle();
    assertNoDomNode(fixture.container.querySelector(".approvals-skeleton"));
    row(fixture.container, "Claude Code");
  } finally {
    await fixture.cleanup();
  }
});

test("a discovery refresh repairs the open draft, says which fields changed, and closes for a removed agent", async () => {
  let gets = 0;
  const repaired = view();
  repaired.defaults[0]!.installations[0]!.models = [{ id: "luna", displayName: "Luna", efforts: ["low"] }];
  repaired.defaults[0]!.installations[0]!.effortLevels = ["low"];
  const removed = view();
  removed.defaults = removed.defaults.filter((option) => option.agentId !== "codex");
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    return json(gets <= 2 ? view() : gets === 3 ? repaired : removed);
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Sol");
    await choose("Reasoning Effort", "Extra High");
    await choose("Permission Mode", "Full Access");

    // The same capabilities: nothing to say.
    await fixture.render({ revision: 1 });
    const status = dialog().querySelector('[role="status"][aria-atomic="true"]');
    assert.ok(status);
    assert.equal(status.textContent, "");

    await fixture.render({ revision: 2 });
    assert.match(buttonNamed(/^Model:/, dialog()).getAttribute("aria-label") ?? "", /Wollipog Default/);
    assert.match(buttonNamed(/^Permission Mode:/, dialog()).getAttribute("aria-label") ?? "", /Full Access/);
    assert.ok(dialog().querySelector('[role="status"][aria-atomic="true"]') === status, "the same status region");
    assert.match(status.textContent ?? "", /Model and Reasoning Effort/);
    assert.doesNotMatch(status.textContent ?? "", /Permission Mode/);

    await fixture.render({ revision: 3 });
    await nextFrame();
    assertNoDomNode(body().querySelector('[role="dialog"]'));
    assert.equal(fixture.container.textContent?.includes("Codex App Server"), false);
    assert.ok(focused() === buttonNamed("Refresh Agents"), "focus is on Refresh Agents");
  } finally {
    await fixture.cleanup();
  }
});

test("a save outranks discovery reads that overlap it", async () => {
  let gets = 0;
  let answerPut!: (response: Response) => void;
  let answerLate!: (response: Response) => void;
  const put = new Promise<Response>((resolve) => { answerPut = resolve; });
  const late = new Promise<Response>((resolve) => { answerLate = resolve; });
  const fixture = await renderPanel(transport(async (_path, init) => {
    if (init?.method === "PUT") return put;
    gets += 1;
    return gets === 1 ? json(view()) : late;
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Luna");
    await choose("Reasoning Effort", "Low");
    await act(async () => buttonNamed("Save Defaults").click());
    await fixture.render({ revision: 1 });
    await act(async () => {
      answerPut(json(view(true)));
      await put;
    });
    await settle();
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Luna, low effort, Full Access (No Sandbox)");
    await act(async () => {
      answerLate(json(view()));
      await late;
    });
    await settle();
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Luna, low effort, Full Access (No Sandbox)");
  } finally {
    await fixture.cleanup();
  }
});

test("an older overlapping read never replaces a newer one", async () => {
  let gets = 0;
  let answerOlder!: (response: Response) => void;
  const older = new Promise<Response>((resolve) => { answerOlder = resolve; });
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    if (gets === 1) return json(view());
    return gets === 2 ? older : json(view(true));
  }));
  try {
    await fixture.render({ revision: 1 });
    await fixture.render({ revision: 2 });
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Luna, low effort, Full Access (No Sandbox)");
    await act(async () => {
      answerOlder(json(view()));
      await older;
    });
    await settle();
    assert.equal(row(fixture.container, "Codex App Server").querySelector(".setting-row-desc")?.textContent,
      "Luna, low effort, Full Access (No Sandbox)");
    assert.equal(gets, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("resetting an agent that offers nothing now returns focus to Refresh Agents, since its row loses Edit…", async () => {
  const saved = view();
  saved.defaults[2]!.preference = { permissionMode: "retired-mode" };
  saved.defaults[2]!.compatibleInstallations = 0;
  let current = saved;
  const fixture = await renderPanel(transport(async (_path, init) => {
    if (init?.method === "DELETE") current = view();
    return json(current);
  }));
  try {
    // A saved default keeps Edit… even though the agent has nothing to choose, so it can be cleared.
    await openEditor(fixture.container, "Plain Agent");
    await act(async () => buttonNamed("Use Wollipog Defaults").click());
    await nextFrame();
    assertNoDomNode(body().querySelector('[role="dialog"]'));
    assert.equal(row(fixture.container, "Plain Agent").querySelector(".setting-row-control")?.textContent, "Not Configurable");
    assert.ok(focused() === buttonNamed("Refresh Agents"), "focus is on Refresh Agents");
  } finally {
    await fixture.cleanup();
  }
});

test("Retry keeps focus while it fails again, and hands it to Refresh Agents once it works", async () => {
  let gets = 0;
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    return gets <= 2 ? json({ error: "connection reset by peer" }, 503) : json(view());
  }));
  try {
    const retry = buttonNamed("Retry", fixture.container.querySelector<HTMLElement>(".notice")!);
    retry.focus();
    await act(async () => retry.click());
    await nextFrame();
    assert.equal(gets, 2);
    const again = buttonNamed("Retry", fixture.container.querySelector<HTMLElement>(".notice")!);
    assert.ok(focused() === again, "focus stays on Retry after another failure");
    await act(async () => again.click());
    await nextFrame();
    assertNoDomNode(fixture.container.querySelector(".notice"));
    assert.ok(focused() === buttonNamed("Refresh Agents"), "focus is on Refresh Agents");
  } finally {
    await fixture.cleanup();
  }
});

test("Save Defaults with every field on Wollipog Default resets, and stays the busy, focused button", async () => {
  const methods: string[] = [];
  let reject!: (response: Response) => void;
  const pendingDelete = new Promise<Response>((resolve) => { reject = resolve; });
  const fixture = await renderPanel(transport(async (_path, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    return method === "DELETE" ? pendingDelete : json(view(true));
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Wollipog Default");
    await choose("Permission Mode", "Wollipog Default");
    const save = buttonNamed("Save Defaults");
    save.focus();
    await act(async () => save.click());
    await settle();
    assert.deepEqual(methods, ["GET", "DELETE"]);
    // Busy without `disabled`, which would drop the focus it was pressed with.
    assert.equal(save.getAttribute("aria-busy"), "true");
    assert.equal(save.disabled, false);
    assert.equal(buttonNamed("Use Wollipog Defaults").getAttribute("aria-busy"), null);
    await act(async () => {
      reject(json({ error: "database is locked" }, 503));
      await pendingDelete;
    });
    await nextFrame();
    assert.match(dialog().querySelector('.notice[role="alert"]')?.textContent ?? "", /Defaults Not Reset/);
    assert.ok(focused() === save, "focus stays on Save Defaults");
  } finally {
    await fixture.cleanup();
  }
});

test("a repair that removes the chosen model clears the missing-effort error", async () => {
  let gets = 0;
  const withoutSol = view();
  withoutSol.defaults[0]!.installations[0]!.models = [{ id: "luna", displayName: "Luna", efforts: ["low", "high"] }];
  const fixture = await renderPanel(transport(async () => {
    gets += 1;
    return json(gets === 1 ? view() : withoutSol);
  }));
  try {
    await openEditor(fixture.container, "Codex App Server");
    await choose("Model", "Sol");
    await act(async () => buttonNamed("Save Defaults").click());
    await settle();
    assert.ok(dialog().querySelector(".field-error"), "the missing-effort error shows");
    await fixture.render({ revision: 1 });
    assertNoDomNode(dialog().querySelector(".field-error"));
    const effort = buttonNamed(/^Reasoning Effort:/, dialog());
    assert.equal(effort.getAttribute("aria-invalid"), null);
    assert.equal(dialog().querySelector("#agent-defaults-effort-helper")?.textContent, "Choose a model first.");
  } finally {
    await fixture.cleanup();
  }
});
