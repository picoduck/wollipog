import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  ARCHIVED_HISTORY_RETENTION_LIMITS,
  type ArchivedHistoryRetentionView,
  type UpdateArchivedHistoryRetentionRequest,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ArchivedHistoryRetentionPanel } from "./ArchivedHistoryRetentionPanel.js";
import { FeedbackProvider } from "./FeedbackProvider.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow), cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow), React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = Date.now();

function view(overrides: Partial<ArchivedHistoryRetentionView> = {}): ArchivedHistoryRetentionView {
  return {
    retentionDays: null, source: "default", environmentDays: null, canManage: true, prunesFrom: null,
    nextRunAt: NOW + 30 * 60_000, eligible: { sessions: 0, events: 0 }, lastRun: null,
    limits: ARCHIVED_HISTORY_RETENTION_LIMITS, ...overrides,
  };
}

/** A server that keeps what it is sent, answers previews, and records every save. */
function server(initial: ArchivedHistoryRetentionView) {
  let current = initial;
  const saves: Array<number | null> = [];
  const previews: number[] = [];
  const client = {
    ...api,
    archivedHistoryRetention: async (previewDays?: number) => {
      if (previewDays === undefined) return current;
      previews.push(previewDays);
      return { ...current, preview: { retentionDays: previewDays, eligible: { sessions: 3, events: 1_200 }, prunesFrom: NOW + 86_400_000 } };
    },
    updateArchivedHistoryRetention: async (input: UpdateArchivedHistoryRetentionRequest) => {
      saves.push(input.retentionDays);
      current = { ...current, retentionDays: input.retentionDays, source: "organization",
        prunesFrom: input.retentionDays === null ? null : NOW + 86_400_000 };
      return current;
    },
  } as unknown as ApiClient;
  return { client, saves, previews };
}

async function render(client: ApiClient) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}><FeedbackProvider><ArchivedHistoryRetentionPanel /></FeedbackProvider></ApiProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const dialog = () => domWindow.document.body.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  return {
    container,
    toggle: () => container.querySelector<HTMLButtonElement>('[role="switch"]')!,
    days: () => container.querySelector<HTMLInputElement>('input[type="number"]')!,
    dialog,
    dialogButton: (name: string) => {
      const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name);
      assert.ok(button, `expected ${name} in the confirmation`);
      return button;
    },
    settle: () => act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); }),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("retention is off until confirmed, and turning it on shows what it prunes and when first", async () => {
  const { client, saves, previews } = server(view());
  const ui = await render(client);
  try {
    assert.equal(ui.toggle().getAttribute("aria-checked"), "false");
    assert.match(ui.container.textContent ?? "", /Archived sessions keep their full history\./);
    assert.equal(ui.days().value, "90", "the suggested threshold waits in the field");
    assert.equal(saves.length, 0, "opening Settings never saves");

    await act(async () => { ui.toggle().click(); });
    await ui.settle();
    assert.deepEqual(previews, [90]);
    assert.ok(ui.dialog(), "turning it on is confirmed in the app's dialog");
    assert.match(ui.dialog()!.textContent ?? "", /Prune Archived History[\s\S]*more than 90 days ago is permanently removed/);
    assert.match(ui.dialog()!.textContent ?? "", /Sessions to Prune[\s\S]*3[\s\S]*Events to Remove \(Approx\.\)[\s\S]*1,200/);
    assert.equal(ui.dialogButton("Prune History").className, "btn danger");

    await act(async () => { ui.dialogButton("Cancel").click(); });
    await ui.settle();
    assertNoDomNode(ui.dialog());
    assert.deepEqual(saves, [], "Cancel saves nothing");
    assert.equal(ui.toggle().getAttribute("aria-checked"), "false");

    await act(async () => { ui.toggle().click(); });
    await ui.settle();
    await act(async () => { ui.dialogButton("Prune History").click(); });
    await ui.settle();
    assert.deepEqual(saves, [90]);
    assert.equal(ui.toggle().getAttribute("aria-checked"), "true");
    assert.match(ui.container.textContent ?? "", /lose most of their history 90 days after archiving/);
    assert.match(ui.container.textContent ?? "", /Pruning starts /, "the delay before the first prune is shown");
  } finally {
    await ui.unmount();
  }
});

test("lengthening and turning it off save at once, while shortening is confirmed", async () => {
  const { client, saves } = server(view({ retentionDays: 90, source: "organization", prunesFrom: NOW - 1_000,
    eligible: { sessions: 4, events: 9_000 } }));
  const ui = await render(client);
  try {
    assert.match(ui.container.textContent ?? "", /4 sessions, about 9,000 events/);
    await act(async () => { fireDomEvent.change(ui.days(), { target: { value: "120" } }); });
    await act(async () => { ui.days().focus(); ui.days().blur(); });
    await ui.settle();
    assertNoDomNode(ui.dialog(), "a longer threshold prunes less, so it needs no confirmation");
    assert.deepEqual(saves, [120]);

    await act(async () => { fireDomEvent.change(ui.days(), { target: { value: "30" } }); });
    await act(async () => { ui.days().focus(); ui.days().blur(); });
    await ui.settle();
    assert.match(ui.dialog()!.textContent ?? "", /Shorten History Retention/);
    await act(async () => { ui.dialogButton("Cancel").click(); });
    await ui.settle();
    assert.equal(ui.days().value, "120", "a cancelled change shows the policy in effect again");

    await act(async () => { ui.toggle().click(); });
    await ui.settle();
    assertNoDomNode(ui.dialog(), "turning it off prunes nothing");
    assert.deepEqual(saves, [120, null]);
    assert.equal(ui.toggle().getAttribute("aria-checked"), "false");
  } finally {
    await ui.unmount();
  }
});

test("a threshold outside the limits says so and saves nothing", async () => {
  const { client, saves } = server(view({ retentionDays: 90, source: "organization", prunesFrom: NOW - 1_000 }));
  const ui = await render(client);
  try {
    for (const value of ["6", "3651", "9.5", ""]) {
      await act(async () => { fireDomEvent.change(ui.days(), { target: { value } }); });
      await act(async () => { ui.days().focus(); ui.days().blur(); });
      assert.equal(ui.days().getAttribute("aria-invalid"), "true", value);
      assert.match(ui.container.textContent ?? "", /Enter a whole number of days from 7 to 3,650\./);
    }
    assert.deepEqual(saves, []);
  } finally {
    await ui.unmount();
  }
});

test("a member who cannot change it reads the policy, and the environment's default is named", async () => {
  const { client } = server(view({ retentionDays: 180, source: "environment", environmentDays: 180, canManage: false,
    prunesFrom: NOW - 1_000, lastRun: { finishedAt: NOW - 3_600_000, sessions: 2, events: 900 } }));
  const ui = await render(client);
  try {
    assert.equal(ui.toggle().getAttribute("aria-checked"), "true");
    assert.ok(ui.toggle().disabled, "the switch is read-only");
    assert.ok(ui.days().disabled, "the field is read-only");
    assert.match(ui.container.textContent ?? "", /Only an organization owner or admin can change this\./);
    assert.match(ui.container.textContent ?? "", /environment sets 180 days\. Saving here overrides it for this organization\./);
    assert.match(ui.container.textContent ?? "", /Last Pass[\s\S]*2 sessions, 900 events/);
  } finally {
    await ui.unmount();
  }
});

test("a control plane that predates retention leaves the rows disabled with the reason to update", async () => {
  const client = {
    ...api,
    archivedHistoryRetention: async () => { throw new ApiError("Not Found", 404); },
  } as unknown as ApiClient;
  const ui = await render(client);
  try {
    assert.ok(ui.toggle().disabled);
    assert.match(ui.container.textContent ?? "", /Update Wollipog to change this setting\./);
    assertNoDomNode(ui.container.querySelector("[role=alert]"), "an older server is not a failure");
  } finally {
    await ui.unmount();
  }
});
