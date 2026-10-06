import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import type { InboxSplit, InboxSplitKey } from "../inbox.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { SessionGroupTabs, type GroupTabMenuRequest } from "./SessionGroupTabs.js";

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

test("a project tab asks for its menu on a right-click or Shift+F10 without being selected; All keeps the browser's (#2199)", async () => {
  const projectSplits = [
    split(null, "All", 5),
    { ...split("alpha", "Alpha", 3), project: { kind: "legacy" as const, runnerId: "runner-1", workspaceId: "alpha" } },
    { ...split("beta", "Beta", 2), project: { kind: "legacy" as const, runnerId: "runner-1", workspaceId: "beta" } },
  ];
  const selected: InboxSplitKey[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const describe = (request: GroupTabMenuRequest | null) => {
    if (!request) return "";
    const where = request.point ? `${request.point.x},${request.point.y}` : "tab";
    return `${request.tab.textContent?.slice(0, 4)}@${where}`;
  };
  await act(async () => root.render(
    <SessionGroupTabs
      splits={projectSplits}
      labels={new Map()}
      activeKey="alpha"
      snoozed={false}
      onSelect={(key) => selected.push(key)}
      onTabKeyDown={() => undefined}
      tabRef={() => undefined}
      tabMenu={(group, { active, request, closeRequest }) => (
        <span className="probe" data-key={group.key} data-active={String(active)} data-request={describe(request)}
          onClick={closeRequest} />
      )}
    />,
  ));
  const tab = (name: string) => [...container.querySelectorAll<HTMLElement>(".tab")].find((candidate) => candidate.textContent?.startsWith(name))!;
  const probe = (key: string) => container.querySelector<HTMLElement>(`.probe[data-key="${key}"]`)!;
  const contextMenu = (target: HTMLElement, button: number) => {
    const event = new domWindow.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button, clientX: 40, clientY: 20 });
    target.dispatchEvent(event as unknown as Event);
    return event;
  };
  const press = (target: HTMLElement, init: { key: string; shiftKey?: boolean }) => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }) as unknown as Event);
  };

  let event: { defaultPrevented: boolean } | undefined;
  await act(async () => { event = contextMenu(tab("Beta"), 2); });
  assert.equal(event!.defaultPrevented, true, "the browser's menu gives way to the project's");
  assert.equal(probe("beta").dataset.request, "Beta@40,20", "a right-click opens at the pointer");
  assert.equal(probe("beta").dataset.active, "false");
  assert.equal(probe("alpha").dataset.request, "");
  assert.deepEqual(selected, [], "the selected tab does not change");

  await act(async () => { probe("beta").click(); });
  assert.equal(probe("beta").dataset.request, "", "closing clears the request");

  await act(async () => { press(tab("Beta"), { key: "F10", shiftKey: true }); });
  assert.equal(probe("beta").dataset.request, "Beta@tab", "Shift+F10 opens at the tab");
  await act(async () => { probe("beta").click(); });
  await act(async () => { press(tab("Alpha"), { key: "ContextMenu" }); });
  assert.equal(probe("alpha").dataset.request, "Alph@tab", "so does the context-menu key");
  // A keyboard's own contextmenu event reports no pointer button, so it also opens at the tab.
  await act(async () => { contextMenu(tab("Alpha"), 0); });
  assert.equal(probe("alpha").dataset.request, "Alph@tab");

  await act(async () => { event = contextMenu(tab("All"), 2); });
  assert.equal(event!.defaultPrevented, false, "All has no project menu");
  assert.deepEqual(selected, []);
  await act(async () => root.unmount());
  container.remove();
});
