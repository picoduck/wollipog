import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import type { InboxSplit, InboxSplitKey } from "../inbox.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { SessionGroupTabs } from "./SessionGroupTabs.js";

const domWindow = new Window();
const globals = ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const prior = new Map(globals.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

before(() => {
  const values: Record<(typeof globals)[number], unknown> = {
    window: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    HTMLElement: domWindow.HTMLElement,
    HTMLButtonElement: domWindow.HTMLButtonElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
});

after(() => {
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: prior.get(name) });
});

function split(key: InboxSplitKey, name: string, count: number, blockedCount = 0, stalledCount = 0): InboxSplit {
  return {
    key,
    kind: key === null ? "all" : "project",
    name,
    project: null,
    sessions: [{ status: "running" } as SessionView],
    count,
    blockedCount,
    stalledCount,
  };
}

const splits = [split(null, "All", 5, 1, 1), split("alpha", "Alpha", 3, 1, 1), split("beta", "Beta", 0)];

async function mount(snoozed: boolean, selected: InboxSplitKey[] = []) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <SessionGroupTabs
      splits={splits}
      labels={new Map()}
      activeKey="alpha"
      snoozed={snoozed}
      onSelect={(key) => selected.push(key)}
      onTabKeyDown={() => undefined}
      tabRef={() => undefined}
    />,
  ));
  return {
    container,
    tab: (name: string) => [...container.querySelectorAll<HTMLElement>(".tab")].find((tab) => tab.textContent?.startsWith(name))!,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the Snoozed view counts snoozed sessions and draws no attention badges or words", async () => {
  const view = await mount(true);
  const alpha = view.tab("Alpha");
  assertNoDomNode(alpha.querySelector(".count-badge"), "no badge while Snoozed is on");
  assertNoDomNode(alpha.querySelector(".sr-only"), "no attention words while Snoozed is on");
  assert.equal(alpha.querySelector(".count")?.textContent, "3");
  assert.equal(alpha.title, "Alpha\n3 snoozed sessions\nSwitch group (Tab / Shift+Tab)");
  await view.unmount();
});

test("zero attention counts draw nothing, and a tab's name, count and badges sit in that order", async () => {
  const view = await mount(false);
  const alpha = view.tab("Alpha");
  assert.deepEqual([...alpha.children].map((child) => child.className), [
    "group-name", "count", "count-badge", "count-badge danger", "sr-only",
  ]);
  assert.deepEqual([...view.tab("Beta").children].map((child) => child.className), ["group-name", "count"]);
  await view.unmount();
});

test("All Groups follows the tab row, opens from the keyboard and lists every group in tab order", async () => {
  const selected: InboxSplitKey[] = [];
  const view = await mount(false, selected);
  const bar = view.container.querySelector(".tabs-bar")!;
  assert.deepEqual([...bar.children].map((child) => child.getAttribute("role") ?? child.getAttribute("aria-label")), [
    "tablist", "All Groups",
  ], "no tools slot is drawn without tools");
  const trigger = bar.querySelector<HTMLButtonElement>('button[aria-label="All Groups"]')!;
  assert.equal(trigger.className, "icon-btn sm tabs-all");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  await act(async () => {
    trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
  });
  const rows = [...domWindow.document.querySelectorAll('[role="menu"][aria-label="All Groups"] [role="menuitemradio"]')] as unknown as HTMLButtonElement[];
  assert.deepEqual(rows.map((row) => row.getAttribute("aria-label")), [
    "All, 5, 1 Blocked, 1 Stalled", "Alpha, 3, 1 Blocked, 1 Stalled", "Beta, 0",
  ]);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  await act(async () => { rows[2]!.click(); });
  assert.deepEqual(selected, ["beta"]);
  await view.unmount();
});
