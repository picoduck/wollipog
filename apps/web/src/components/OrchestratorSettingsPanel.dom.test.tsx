import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { OrchestratorSettingsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { SETTINGS_SECTIONS, type SettingsSection, type View } from "../navigation.js";
import { Store } from "../store.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { OrchestratorSettingsPanel } from "./OrchestratorSettingsPanel.js";
import { SettingsView } from "./SettingsView.js";
import { fireDomEvent } from "./test-dom-events.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/settings/orchestrator", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  // Desktop: the section nav beside the panel.
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false,
  }),
});
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
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

type Defaults = OrchestratorSettingsView["defaults"];

function settings(drifted = false): OrchestratorSettingsView {
  return {
    source: "user_default",
    defaults: {
      behavior: {
        childHarness: null,
        childModel: drifted ? "retired-model" : null,
        childEffort: null,
        maximumConcurrentChildren: 4,
        followUps: "recommend_only",
        completion: "retain",
      },
      delegation: {
        parentControl: "questions_and_approvals",
        decisions: {
          implementation_question: "human",
          pr_merge: "human",
          merged_branch_deletion: "human",
          follow_up_issue_publication: "human",
          ui_evidence_approval: "human",
        },
      },
      execution: { strictProjectIsolation: false, integrationIsolation: false },
    },
    capabilities: {
      harnesses: [
        {
          agentId: "codex", driver: "codex-app-server", context: { kind: "native" }, name: "Codex App Server",
          models: [{ id: "sol", displayName: "Sol", efforts: ["high"] }], effortLevels: ["high"],
          supportedPairs: [{ modelId: "sol", effortLevels: ["high"] }], installations: 1,
        },
        {
          agentId: "pi", driver: "pi", context: { kind: "native" }, name: "Pi",
          models: [{ id: "sol", displayName: "Sol", efforts: ["low"] }], effortLevels: ["low"],
          supportedPairs: [{ modelId: "sol", effortLevels: ["low"] }], installations: 1,
        },
      ],
      models: [{ id: "sol", displayName: "Sol", efforts: ["high"] }],
      effortLevels: ["high"],
      supportedPairs: [{ modelId: "sol", effortLevels: ["high"] }],
      installations: 1,
      compatibleInstallations: drifted ? 0 : 1,
      status: drifted ? "unavailable" : "available",
      ...(drifted ? { reason: "The saved fixed child model is unavailable. Choose Automatic." } : {}),
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A server holding `initial`. Every PUT is recorded in `writes`; `reject` answers the next PUTs with
 * a 409 carrying that sentence instead of saving.
 */
function server(initial: OrchestratorSettingsView) {
  let current = initial;
  const writes: Array<{ defaults: Defaults }> = [];
  const state = { reject: null as string | null, current: () => current, set: (next: OrchestratorSettingsView) => { current = next; } };
  const transport: ApiTransport = {
    instanceId: "test", publicOrigin: "http://localhost", close() {},
    async request(path, init) {
      assert.equal(path, "/api/orchestrator-settings");
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { defaults: Defaults };
        if (state.reject) return json({ error: state.reject }, 409);
        writes.push(body);
        current = { ...current, source: "user_default", defaults: body.defaults };
      }
      return json(current);
    },
  };
  return { transport, writes, state };
}

async function settle(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));
}

async function mount(node: ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await settle();
  return {
    container,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function panel(transport: ApiTransport, discoveryRevision?: object) {
  return <ApiProvider client={createApiClient(transport)}><OrchestratorSettingsPanel discoveryRevision={discoveryRevision} /></ApiProvider>;
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);
}

function pill(scope: ParentNode, group: string, label: string): HTMLButtonElement {
  const row = [...scope.querySelectorAll('[role="radiogroup"]')].find((node) => node.getAttribute("aria-label") === group);
  assert.ok(row, `${group} is rendered as its own control`);
  const radio = [...row.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((node) => node.textContent?.trim() === label);
  assert.ok(radio, `${group} offers ${label}`);
  return radio;
}

async function choose(scope: ParentNode, select: string, option: RegExp | string) {
  const trigger = scope.querySelector<HTMLButtonElement>(`[aria-label^="${select}:"]`)!;
  await act(async () => trigger.click());
  const match = [...scope.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((node) => typeof option === "string" ? node.textContent?.startsWith(option) : option.test(node.textContent ?? ""));
  assert.ok(match, `${select} offers ${String(option)}`);
  await act(async () => match.click());
}

/** What the field (or select trigger) is described by first: its error while it shows one (§8.5). */
function fieldError(control: Element): Element | null {
  const first = control.getAttribute("aria-describedby")?.split(" ")[0];
  const node = first ? document.getElementById(first) : null;
  return node?.classList.contains("field-error") ? node : null;
}

test("the editor has three groups and no footer row, and a change saves the whole default from the save bar", async () => {
  const { transport, writes } = server(settings());
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    assert.deepEqual([...container.querySelectorAll("h3")].map((node) => node.textContent),
      ["Children", "Execution Permissions", "Decision Delegation"]);
    assertNoDomNode(container.querySelector(".save-bar"), "with no changes, no save bar renders");
    assert.doesNotMatch(container.textContent ?? "", /Current Source|Human-Only Decisions|Effective Boundary|Effective Integrations/);
    assertNoDomNode(container.querySelector(".form-error"));
    // The always-visible text is one line per row; the details are behind the two About disclosures.
    const disclosures = [...container.querySelectorAll("details.disclosure")];
    assert.deepEqual(disclosures.map((node) => node.querySelector("summary")?.textContent),
      ["About Isolation", "About UI Evidence Delegation"]);
    assert.ok(disclosures.every((node) => !(node as HTMLDetailsElement).open), "every disclosure starts closed");
    assert.match(disclosures[1]!.textContent ?? "", /provider may retain images in provider-local transcripts or media logs/);
    assert.match(disclosures[1]!.textContent ?? "", /Video evidence otherwise requires human review/);
    assert.match(container.querySelector(".orchestrator-human-only")?.textContent ?? "",
      /^Secrets, sign-in, permission grants, governance changes, budgets and guardrails always stay with you\.$/);
    assert.ok(container.querySelector(".orchestrator-human-only > svg"), "with its lock icon");
    assert.equal(container.querySelector(".orchestrator-gates-label")?.textContent, "Who Decides at Each Gate");

    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "8" } }); });
    const bar = container.querySelector(".save-bar")!;
    assert.equal(bar.querySelector(".save-bar-message")?.textContent, "Unsaved changes");
    assert.ok(button(bar, "Discard"));
    await act(async () => button(bar, "Save Defaults")!.click());
    await settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.defaults.behavior.maximumConcurrentChildren, 8);
    assert.equal(Object.keys(writes[0]!.defaults.delegation.decisions).length, 5);
    assert.equal(writes[0]!.defaults.execution.strictProjectIsolation, false);
    assertNoDomNode(container.querySelector(".save-bar"), "a saved draft is clean again");
  } finally {
    await view.cleanup();
  }
});

test("changing Follow-Ups shows the save bar, and Discard restores the saved value and hides it", async () => {
  const { transport, writes } = server(settings());
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    assertNoDomNode(container.querySelector(".save-bar"));
    await choose(container, "Follow-Ups", "Execute Approved");
    assert.match(container.querySelector('[aria-label^="Follow-Ups:"]')?.getAttribute("aria-label") ?? "", /Execute Approved/);
    const bar = container.querySelector(".save-bar");
    assert.ok(bar, "a change shows the bar");
    await act(async () => button(bar, "Discard")!.click());
    assert.match(container.querySelector('[aria-label^="Follow-Ups:"]')?.getAttribute("aria-label") ?? "", /Recommend Only/);
    assertNoDomNode(container.querySelector(".save-bar"));
    assert.equal(writes.length, 0, "discarding never writes");

    // Changing a value and changing it back is no change.
    await choose(container, "Follow-Ups", "Execute Approved");
    await choose(container, "Follow-Ups", "Recommend Only");
    assertNoDomNode(container.querySelector(".save-bar"));
  } finally {
    await view.cleanup();
  }
});

test("65 children marks the 96px field invalid with its error under it, and the bar asks for 1 fix", async () => {
  const { transport, writes } = server(settings());
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    assert.ok(limit.closest(".input-affix")?.classList.contains("w-xs"), "the 96px number field (§8.3)");
    await act(async () => { fireDomEvent.change(limit, { target: { value: "65" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), "true");
    const error = fieldError(limit);
    assert.equal(error?.textContent, "Enter a whole number from 0 to 64.");
    assert.ok(limit.closest(".setting-row-control")?.contains(error), "under the field, not under the title");
    const bar = container.querySelector(".save-bar")!;
    assert.equal(bar.querySelector(".save-bar-message")?.textContent, "Fix 1 setting to save");
    const save = button(bar, "Save Defaults")!;
    assert.equal(save.getAttribute("aria-disabled"), "true");
    await act(async () => save.click());
    await settle();
    assert.equal(writes.length, 0, "a blocked Save does not save");

    // An emptied field is invalid rather than a silent 0, which would pause every new campaign.
    await act(async () => { fireDomEvent.change(limit, { target: { value: "" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), "true");
    await act(async () => { fireDomEvent.change(limit, { target: { value: "0" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), null);
    assert.equal(container.querySelector(".save-bar-message")?.textContent, "Unsaved changes");
  } finally {
    await view.cleanup();
  }
});

test("a rejected save turns the bar into its error state with Try Again and keeps the draft", async () => {
  const { transport, writes, state } = server(settings());
  state.reject = "The fixed Child Harness is not available. Choose Automatic.";
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "9" } }); });
    await act(async () => button(container.querySelector(".save-bar")!, "Save Defaults")!.click());
    await settle();
    const bar = container.querySelector(".save-bar")!;
    assert.ok(bar.classList.contains("is-error"));
    assert.equal(bar.getAttribute("role"), "alert");
    assert.equal(bar.querySelector(".save-bar-message")?.textContent, "The fixed Child Harness is not available. Choose Automatic.");
    assert.equal(limit.value, "9", "the draft is kept");

    state.reject = null;
    await act(async () => button(bar, "Try Again")!.click());
    await settle();
    assert.equal(writes[0]?.defaults.behavior.maximumConcurrentChildren, 9);
    assertNoDomNode(container.querySelector(".save-bar"));
  } finally {
    await view.cleanup();
  }
});

test("with no installation, a warning notice leads Children and the model and effort selects say why they are disabled", async () => {
  const current = settings();
  const reason = "No current Agent Harness installation advertises child model and effort capabilities. Connect or update a runner, then retry.";
  current.capabilities = {
    harnesses: [], models: [], effortLevels: [], supportedPairs: [],
    installations: 0, compatibleInstallations: 0, status: "unavailable", reason,
  };
  const { transport, writes } = server(current);
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    const children = container.querySelector("section.settings-group")!;
    const afterHead = children.querySelector(":scope > .settings-group-head + *")!;
    assert.ok(afterHead.classList.contains("notice") && afterHead.classList.contains("t-warning"),
      "the warning notice is the first thing in Children");
    assert.ok(afterHead.classList.contains("compact"));
    assert.match(afterHead.textContent ?? "", new RegExp(reason.replace(/\./g, "\\.")));
    const open = afterHead.querySelector<HTMLAnchorElement>("a.btn");
    assert.equal(open?.textContent, "Open Connections");
    assert.equal(open?.getAttribute("href"), "/connections/machines");
    for (const select of ["Child Model", "Child Effort"]) {
      const trigger = container.querySelector(`[aria-label^="${select}:"]`)!;
      assert.equal(trigger.getAttribute("aria-disabled"), "true", `${select} is disabled`);
      const described = (trigger.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
      assert.ok(described.includes(reason), `${select} is described by the reason`);
    }
    assertNoDomNode(container.querySelector(".form-error"), "no red paragraph after the groups");
    assertNoDomNode(container.querySelector('[role="alert"]'));

    // An all-Automatic policy is still valid, so other changes still save.
    await act(async () => pill(container, "Completion", "Stop and Archive").click());
    const save = button(container.querySelector(".save-bar")!, "Save Defaults")!;
    assert.equal(save.getAttribute("aria-disabled"), null);
    await act(async () => save.click());
    await settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.defaults.behavior.childModel, null);
    assert.equal(writes[0]!.defaults.behavior.childEffort, null);
  } finally {
    await view.cleanup();
  }
});

test("an unsupported fixed model and effort are each marked at their select, and a retired model at Child Model", async () => {
  const unsupported = settings();
  unsupported.defaults.behavior.childModel = "sol";
  unsupported.defaults.behavior.childEffort = "medium";
  const first = await mount(panel(server(unsupported).transport));
  try {
    const { container } = first;
    for (const select of ["Child Model", "Child Effort"]) {
      const trigger = container.querySelector(`[aria-label^="${select}:"]`)!;
      assert.equal(trigger.getAttribute("aria-invalid"), "true", select);
      assert.equal(fieldError(trigger)?.textContent, "Choose a model and effort this agent supports, or Automatic.");
    }
    assert.equal(container.querySelector('[aria-label^="Child Harness:"]')?.getAttribute("aria-invalid"), null,
      "Automatic is never the cause");
    assertNoDomNode(container.querySelector(".form-error"));
    // Already saved like this, so only the bar's block says it cannot be saved again yet.
    await act(async () => pill(container, "Completion", "Stop and Archive").click());
    assert.equal(container.querySelector(".save-bar-message")?.textContent, "Fix 2 settings to save");
    await choose(container, "Child Effort", "Automatic");
    assert.equal(container.querySelector('[aria-label^="Child Model:"]')?.getAttribute("aria-invalid"), null);
    assert.equal(container.querySelector(".save-bar-message")?.textContent, "Unsaved changes");
  } finally {
    await first.cleanup();
  }

  const second = await mount(panel(server(settings(true)).transport));
  try {
    const { container } = second;
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Child Model:"]')!;
    assert.match(trigger.getAttribute("aria-label") ?? "", /Retired-model \(Unavailable\)/i);
    assert.equal(trigger.getAttribute("aria-invalid"), "true");
    assert.equal(fieldError(trigger)?.textContent, "Choose another model.");
    assert.equal(container.querySelector('[aria-label^="Child Effort:"]')?.getAttribute("aria-invalid"), null);
    assertNoDomNode(container.querySelector(".notice"), "installations exist, so this is the field's error, not a notice");
    assert.equal(trigger.getAttribute("aria-disabled"), null, "the saved model stays changeable");
    await act(async () => trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never));
    assert.equal(trigger.getAttribute("aria-expanded"), "true", "the shared select remains keyboard operable in drift state");
    assert.match(container.textContent ?? "", /Choose a Child Harness or return Child Model to Automatic/i);
  } finally {
    await second.cleanup();
  }
});

test("a server without the settings route asks for a newer Wollipog; another failure offers Retry and the details", async () => {
  let answer: Response | null = json({ error: "Not Found" }, 404);
  let attempts = 0;
  const transport: ApiTransport = {
    instanceId: "test", publicOrigin: "http://localhost", close() {},
    async request() {
      attempts += 1;
      return answer ?? json(settings());
    },
  };
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    const notice = container.querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Orchestrator Settings Need a Newer Wollipog");
    assert.match(notice.textContent ?? "", /Update or restart Wollipog so it matches this dashboard, then try again\./);
    assert.doesNotMatch(container.textContent ?? "", /control plane/i, "docs/design-system.md §17.2 retires the term");
    assert.equal(button(notice, "Show Details"), undefined);

    answer = json({ error: "database is locked" }, 500);
    await act(async () => button(notice, "Retry")!.click());
    await settle();
    const failed = container.querySelector(".notice.t-danger")!;
    assert.equal(failed.querySelector(".notice-title")?.textContent, "Couldn't Load Orchestrator Settings");
    assert.doesNotMatch(failed.textContent ?? "", /database is locked/, "the raw failure waits behind Show Details");
    await act(async () => button(failed, "Show Details")!.click());
    assert.match(failed.textContent ?? "", /database is locked/);

    answer = null;
    await act(async () => button(failed, "Retry")!.click());
    await settle();
    assert.equal(attempts, 3);
    assertNoDomNode(container.querySelector(".notice"));
    assert.ok(container.querySelector("#orchestrator-max-children"));
  } finally {
    await view.cleanup();
  }
});

test("a server that predates fixed Child Harness policy names Wollipog as the thing to update", async () => {
  const current = settings();
  delete (current.capabilities as Partial<typeof current.capabilities>).harnesses;
  const view = await mount(panel(server(current).transport));
  try {
    const { container } = view;
    const notice = container.querySelector(".settings-group-head + .notice.t-warning");
    assert.match(notice?.textContent ?? "", /Update Wollipog on a machine to choose a fixed Child Harness\./);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Child Harness:"]');
    assert.equal(trigger?.getAttribute("aria-disabled"), "true");
    // The legacy model and effort choices still work against that server.
    assert.equal(container.querySelector('[aria-label^="Child Model:"]')?.getAttribute("aria-disabled"), null);
    assert.doesNotMatch(container.textContent ?? "", /control plane/i);
  } finally {
    await view.cleanup();
  }
});

test("Child Harness precedes and scopes model and effort while clearing incompatible selections", async () => {
  const current = settings();
  current.defaults.behavior.childModel = "sol";
  current.defaults.behavior.childEffort = "high";
  const { transport, writes } = server(current);
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    const titles = [...container.querySelectorAll(".setting-row-title")].map((node) => node.textContent);
    assert.ok(titles.indexOf("Child Harness") < titles.indexOf("Child Model"));
    assert.ok(titles.indexOf("Child Model") < titles.indexOf("Child Effort"));

    await choose(container, "Child Harness", /Pi · Pi · Native/);
    assert.match(container.querySelector('[aria-label^="Child Model:"]')?.getAttribute("aria-label") ?? "", /Automatic/);
    assert.match(container.querySelector('[aria-label^="Child Effort:"]')?.getAttribute("aria-label") ?? "", /Automatic/);

    const effort = container.querySelector<HTMLButtonElement>('[aria-label^="Child Effort:"]')!;
    await act(async () => effort.click());
    const effortText = [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent).join(" ");
    assert.match(effortText, /Low/);
    assert.doesNotMatch(effortText, /High/);
    await act(async () => effort.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never));

    await act(async () => button(container.querySelector(".save-bar")!, "Save Defaults")!.click());
    await settle();
    assert.equal(writes[0]?.defaults.behavior.childHarness?.driver, "pi");
    assert.equal(writes[0]?.defaults.behavior.childModel, null);
    assert.equal(writes[0]?.defaults.behavior.childEffort, null);
  } finally {
    await view.cleanup();
  }
});

test("runner discovery refreshes capabilities without discarding unsaved defaults", async () => {
  const { transport, state } = server(settings());
  const view = await mount(panel(transport, { revision: 1 }));
  try {
    const limit = view.container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "8" } }); });
    state.set({ ...state.current(), capabilities: { ...state.current().capabilities, installations: 2 } });
    await act(async () => view.root.render(panel(transport, { revision: 2 })));
    await settle();
    assert.equal(view.container.querySelector<HTMLInputElement>("#orchestrator-max-children")?.value, "8");
    assert.ok(view.container.querySelector(".save-bar"), "still a draft to save");
  } finally {
    await view.cleanup();
  }
});

test("isolation is Off | On, and Strict Project Isolation On includes Integration Isolation", async () => {
  const { transport, writes } = server(settings());
  const view = await mount(panel(transport));
  try {
    const { container } = view;
    for (const group of ["Strict Project Isolation", "Integration Isolation"]) {
      const row = [...container.querySelectorAll('[role="radiogroup"]')].find((node) => node.getAttribute("aria-label") === group)!;
      assert.deepEqual([...row.querySelectorAll('[role="radio"]')].map((node) => node.textContent?.trim()), ["Off", "On"]);
    }
    assertNoDomNode(container.querySelector('[role="switch"]'), "a draft-and-save editor has no switches");
    assert.equal(pill(container, "Strict Project Isolation", "Off").getAttribute("aria-checked"), "true");
    assert.match(container.textContent ?? "", /Children use their agent's own permissions and governance\./);
    const about = container.querySelector<HTMLDetailsElement>("details.orchestrator-about")!;
    assert.match(about.textContent ?? "", /does not claim operating-system read-only enforcement/);
    assert.match(about.textContent ?? "", /Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would/);

    const enable = pill(container, "Integration Isolation", "On");
    assert.equal(enable.getAttribute("aria-disabled"), null, "independently configurable while the project boundary is off");
    await act(async () => enable.click());
    // An account default has no selected harness, so the details state the per-harness differences.
    assert.match(about.textContent ?? "",
      /Claude Code removes configured MCP servers only, because it cannot drop hooks without also dropping your permission rules/);
    assert.match(about.textContent ?? "", /Codex also removes apps, plugins, and hooks/);
    await act(async () => button(container.querySelector(".save-bar")!, "Save Defaults")!.click());
    await settle();
    assert.equal(writes[0]?.defaults.execution.integrationIsolation, true);
    assert.equal(writes[0]?.defaults.execution.strictProjectIsolation, false, "the two policies are saved independently");

    await act(async () => pill(container, "Strict Project Isolation", "On").click());
    assert.match(container.textContent ?? "", /Children can't write outside their project\. Needs a supported sandbox\./);
    const off = pill(container, "Integration Isolation", "Off");
    assert.equal(off.getAttribute("aria-disabled"), "true");
    assert.equal(pill(container, "Integration Isolation", "On").getAttribute("aria-checked"), "true");
    assert.match(container.textContent ?? "", /Included with Strict Project Isolation\./);
    assert.match(about.textContent ?? "", /harness-owned Orchestrator preset replaces the provider surface/);
  } finally {
    await view.cleanup();
  }
});

test("an older server blocks Integration Isolation and still round-trips a save without it", async () => {
  // This server predates the policy: its own default shape has no `execution.integrationIsolation`,
  // and its update parser rejects a payload carrying it.
  const current = settings();
  delete (current.defaults.execution as Partial<typeof current.defaults.execution>).integrationIsolation;
  const { transport, writes } = server(current);
  const strict: ApiTransport = {
    ...transport,
    async request(path, init) {
      if (init?.method === "PUT" && Object.hasOwn((JSON.parse(String(init.body)) as { defaults: Defaults }).defaults.execution, "integrationIsolation")) {
        return json({ error: "a complete valid Orchestrator default is required" }, 400);
      }
      return transport.request(path, init);
    },
  };
  const view = await mount(panel(strict));
  try {
    const { container } = view;
    for (const label of ["Off", "On"]) {
      assert.equal(pill(container, "Integration Isolation", label).getAttribute("aria-disabled"), "true");
    }
    assert.match(container.textContent ?? "", /Update Wollipog to configure Integration Isolation\./);
    assert.doesNotMatch(container.textContent ?? "", /control plane/i, "docs/design-system.md §17.2 retires the term");

    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "9" } }); });
    await act(async () => button(container.querySelector(".save-bar")!, "Save Defaults")!.click());
    await settle();
    assert.equal(writes.length, 1, "the save succeeded against the older parser");
    assert.equal(writes[0]?.defaults.behavior.maximumConcurrentChildren, 9);
    assert.equal(Object.hasOwn(writes[0]!.defaults.execution, "integrationIsolation"), false,
      "the payload round-trips without gaining a field this server rejects");
    assertNoDomNode(container.querySelector(".save-bar"), "and the round-tripped default is clean");
  } finally {
    await view.cleanup();
  }
});

/** Settings as the shell builds it: routes through the store, whose `navigate` asks a dirty editor. */
function SettingsShell({ store, transport, onView }: { store: Store; transport: ApiTransport; onView: (set: (view: View) => void) => void }) {
  const [view, setView] = React.useState<View>(store.getState().view);
  onView(setView);
  const panels = Object.fromEntries(SETTINGS_SECTIONS.map(({ id, title }) => [id, <p key={id}>{title} panel</p>])) as Record<SettingsSection, ReactNode>;
  panels.orchestrator = <OrchestratorSettingsPanel />;
  return <FeedbackProvider>
    <ApiProvider client={createApiClient(transport)}>
      <SettingsView section={view.name === "settings" ? view.section : undefined} onNavigate={store.navigate}
        onOpenShortcuts={() => undefined} panels={panels} />
    </ApiProvider>
  </FeedbackProvider>;
}

test("leaving with a dirty draft asks Keep Editing or Discard Changes, and Keep Editing stays with the draft", async () => {
  let setView: (view: View) => void = () => undefined;
  const store = new Store({ name: "settings", section: "orchestrator" }, (view) => setView(view));
  const { transport } = server({ ...settings(), source: "system_default" });
  const view = await mount(<SettingsShell store={store} transport={transport} onView={(set) => { setView = set; }} />);
  const appearance = () => view.container.querySelector<HTMLAnchorElement>('nav.settings-nav a[href="/settings/appearance"]')!;
  const leave = async () => {
    await act(async () => { appearance().dispatchEvent(new domWindow.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as never); });
    await settle();
  };
  try {
    const { container } = view;
    // The panel's head: its own description, and where the defaults come from.
    assert.equal(container.querySelector(".settings-panel-desc")?.textContent, "Defaults for new campaigns. Running campaigns keep their own.");
    assert.equal(container.querySelector(".settings-panel-scope")?.textContent, "Wollipog Defaults");

    // Clean: a link just goes.
    await leave();
    assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
    await act(async () => store.navigate({ name: "settings", section: "orchestrator" }));
    await settle();

    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "7" } }); });
    await leave();
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog, "leaving asks first");
    assert.equal(dialog.querySelector("h2, .modal-title")?.textContent, "Discard Changes");
    const keep = button(dialog, "Keep Editing")!;
    assert.ok(button(dialog, "Discard Changes"));
    assert.equal(document.activeElement, keep, "Keep Editing has the initial focus");
    await act(async () => keep.click());
    await settle();
    assertNoDomNode(document.querySelector('[role="dialog"]'));
    assert.deepEqual(store.getState().view, { name: "settings", section: "orchestrator" });
    assert.equal(container.querySelector<HTMLInputElement>("#orchestrator-max-children")?.value, "7", "the draft is still there");

    await leave();
    await act(async () => button(document.querySelector('[role="dialog"]')!, "Discard Changes")!.click());
    await settle();
    assert.deepEqual(store.getState().view, { name: "settings", section: "appearance" });
    assert.match(container.textContent ?? "", /Appearance panel/);
    assert.equal(container.querySelector(".settings-panel-scope")?.textContent, "This Device", "the head goes back to the section's own");
  } finally {
    await view.cleanup();
  }
});

test("closing the window with a dirty draft asks the browser to confirm", async () => {
  const { transport } = server(settings());
  const view = await mount(panel(transport));
  const unload = () => {
    const event = new domWindow.Event("beforeunload", { cancelable: true });
    domWindow.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    assert.equal(unload(), false, "a clean editor lets the window close");
    const limit = view.container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "7" } }); });
    assert.equal(unload(), true);
    await act(async () => button(view.container.querySelector(".save-bar")!, "Discard")!.click());
    assert.equal(unload(), false);
  } finally {
    await view.cleanup();
  }
});
