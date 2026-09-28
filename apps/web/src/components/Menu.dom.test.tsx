import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Rail } from "./Rail.js";
import { SessionHeader } from "./SessionHeader.js";

/**
 * The shared menu primitive (docs/design-system.md §9.1) and the keyboard contract every menu keeps
 * (docs/accessibility-interaction-contract.md): arrow keys, Home and End, type-ahead, Escape
 * returning focus to the trigger, and Tab closing the menu. Exercised on two real consumers, the
 * session header's Session Actions menu and the phone rail's More menu.
 */

const domWindow = new Window({ url: "http://localhost/session/session-menu" });
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const GLOBALS: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  localStorage: domWindow.localStorage,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(GLOBALS)) {
    priorGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, descriptor] of priorGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
const doc = () => domWindow.document as unknown as Document;

function stubViewport(phone: boolean): () => void {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: phone && query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  return () => { domWindow.matchMedia = prior; };
}

async function mount(element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = doc().createElement("div");
  doc().body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return { root, container };
}

async function unmount({ root, container }: { root: Root; container: HTMLElement }): Promise<void> {
  await act(async () => { root.unmount(); });
  container.remove();
}

async function press(key: string, target: Element | null = doc().activeElement): Promise<void> {
  assert.ok(target, `something must have focus to receive ${key}`);
  await act(async () => {
    target.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as never);
    await tick();
  });
}

function focusedLabel(): string {
  const active = doc().activeElement;
  return (active?.querySelector(".menu-text") ?? active)?.textContent?.trim() ?? "";
}

function menuLabels(menu: Element): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
    .filter((item) => !(item as HTMLButtonElement).disabled)
    .map((item) => (item.querySelector(".menu-text") ?? item).textContent?.trim() ?? "");
}

/**
 * Walks one open menu through the whole keyboard contract. `reopen` opens it again from its
 * trigger with the keyboard, and returns the trigger.
 */
async function assertKeyboardContract(name: string, reopen: () => Promise<HTMLElement>): Promise<void> {
  const trigger = await reopen();
  const menu = doc().querySelector(`[role="menu"][aria-label="${name}"]`);
  assert.ok(menu, `${name} opens`);
  assert.equal(menu.parentElement, doc().body, "the menu is portalled to <body>");
  assert.ok(menu.classList.contains("menu"), "it renders the shared menu primitive");
  assert.ok(menu.querySelector(":scope > .sheet-grabber"), "it carries the dialog sheet's grabber");
  assert.ok(doc().querySelector(".menu-backdrop"), "its backdrop enrolls it in the shell's Escape ladder");
  const labels = menuLabels(menu);
  assert.ok(labels.length >= 3, `${name} has enough items to rove through`);
  assert.equal(focusedLabel(), labels[0], "opening focuses the first item");

  await press("ArrowDown");
  assert.equal(focusedLabel(), labels[1], "ArrowDown moves to the next item");
  await press("ArrowUp");
  assert.equal(focusedLabel(), labels[0], "ArrowUp moves back");
  await press("ArrowUp");
  assert.equal(focusedLabel(), labels.at(-1), "ArrowUp from the first item wraps to the last");
  await press("ArrowDown");
  assert.equal(focusedLabel(), labels[0], "ArrowDown from the last item wraps to the first");
  await press("End");
  assert.equal(focusedLabel(), labels.at(-1), "End moves to the last item");
  await press("Home");
  assert.equal(focusedLabel(), labels[0], "Home moves to the first item");

  // Type-ahead: the first letter of an item further down the list moves focus to it.
  const targetIndex = labels.findIndex((label, index) => index > 0 &&
    !labels.slice(0, index).some((earlier) => earlier[0]?.toLowerCase() === label[0]?.toLowerCase()));
  assert.ok(targetIndex > 0, `${name} has an item with a distinct first letter`);
  await press(labels[targetIndex]![0]!.toLowerCase());
  assert.equal(focusedLabel(), labels[targetIndex], "type-ahead moves to the matching item");

  await press("Escape");
  assert.equal(doc().querySelector(`[role="menu"][aria-label="${name}"]`), null, "Escape closes the menu");
  assert.equal(doc().activeElement, trigger, "Escape returns focus to the trigger");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await reopen();
  assert.ok(doc().querySelector(`[role="menu"][aria-label="${name}"]`), `${name} opens again`);
  await press("Tab");
  assert.equal(doc().querySelector(`[role="menu"][aria-label="${name}"]`), null, "Tab closes the menu");
  assert.equal(doc().querySelector(".menu-backdrop"), null, "and leaves no backdrop behind");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
}

test("the session actions menu keeps the menu keyboard contract", async () => {
  const restore = stubViewport(false);
  const session = {
    id: "session-menu",
    runnerId: "runner-1",
    title: "Menu Session",
    status: "idle",
    archived: false,
  } as SessionView;
  const mounted = await mount(
    <ApiProvider client={api}>
      <FeedbackContext.Provider value={{
        confirm: async () => false,
        showToast: () => 1,
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <SessionHeader
          session={session}
          onBack={() => undefined}
          onSnooze={() => undefined}
          runnerOnline
          runnerProtocolVersion={85}
          providerLogoutSupported={false}
          stopBeforeArchiveSupported
          exportReady={false}
        />
      </FeedbackContext.Provider>
    </ApiProvider>,
  );
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[aria-label="More Actions"]');
    assert.ok(trigger);
    await assertKeyboardContract("Session Actions", async () => {
      trigger.focus();
      await press("ArrowDown", trigger);
      return trigger;
    });
  } finally {
    await unmount(mounted);
    restore();
  }
});

test("the rail's More menu keeps the menu keyboard contract and opens as a sheet", async () => {
  const restore = stubViewport(true);
  const mounted = await mount(
    <Rail view={{ name: "inbox" }} blockedCount={0} stalledCount={0} onlineConnections={0} onNavigate={() => undefined} />,
  );
  try {
    const trigger = mounted.container.querySelector<HTMLButtonElement>(".rail-more-trigger");
    assert.ok(trigger);
    await assertKeyboardContract("More Destinations", async () => {
      trigger.focus();
      await press("ArrowDown", trigger);
      return trigger;
    });
    await act(async () => { trigger.click(); await tick(); });
    const sheet = doc().querySelector('[role="menu"][aria-label="More Destinations"]') as HTMLElement | null;
    assert.ok(sheet);
    // A phone sheet is docked by the stylesheet (§7.5, §9.2), so no desktop placement is written.
    assert.equal(sheet.style.top, "");
    assert.equal(sheet.style.left, "");
    assert.equal(sheet.querySelector(".menu-head")?.textContent, "More", "the sheet has a title row");
  } finally {
    await unmount(mounted);
    restore();
  }
});

test("a selected radio-like item shows a check icon, never color alone", async () => {
  function Harness() {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={triggerRef} type="button">Open</button>
        <MenuSurface surfaceRef={surfaceRef} anchor={{ trigger: triggerRef }} label="Choose" onDismiss={() => undefined}>
          <MenuItem role="menuitemradio" checked>Selected</MenuItem>
          <MenuItem role="menuitemradio" checked={false}>Other</MenuItem>
          <MenuItem disabled description="Unavailable on this machine.">Refused</MenuItem>
        </MenuSurface>
      </>
    );
  }
  const restore = stubViewport(false);
  const mounted = await mount(<Harness />);
  try {
    const [selected, other, refused] = [...doc().querySelectorAll<HTMLButtonElement>(".menu .menu-item")];
    assert.equal(selected!.getAttribute("aria-checked"), "true");
    assert.ok(selected!.querySelector(".menu-trail .menu-check"), "the selected item carries a trailing check");
    assert.equal(other!.getAttribute("aria-checked"), "false");
    assert.equal(other!.querySelector(".menu-check"), null);
    // The disabled reason is the item's second line: it describes the item without renaming it.
    const labelledBy = refused!.getAttribute("aria-labelledby");
    assert.equal(labelledBy ? doc().getElementById(labelledBy)?.textContent : null, "Refused");
    const describedBy = refused!.getAttribute("aria-describedby");
    assert.equal(describedBy ? doc().getElementById(describedBy)?.textContent : null, "Unavailable on this machine.");
    const menu = doc().querySelector<HTMLElement>(".menu");
    assert.ok(menu);
    assert.notEqual(menu.style.left, "", "a desktop menu is placed against its trigger before paint");
  } finally {
    await unmount(mounted);
    restore();
  }
});
