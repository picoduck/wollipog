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
import { assertNoDomNode } from "../dom-test-assertions.js";

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
  assert.ok(menu.parentElement === doc().body, "the menu is portalled to <body>");
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
  assertNoDomNode(doc().querySelector(`[role="menu"][aria-label="${name}"]`), "Escape closes the menu");
  assert.ok(doc().activeElement === trigger, "Escape returns focus to the trigger");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await reopen();
  assert.ok(doc().querySelector(`[role="menu"][aria-label="${name}"]`), `${name} opens again`);
  await press("Tab");
  assertNoDomNode(doc().querySelector(`[role="menu"][aria-label="${name}"]`), "Tab closes the menu");
  // The menu lived at the end of <body>: focus returns to the trigger before the browser's Tab
  // moves on, so Tab continues from where the menu was opened (the interaction contract).
  assert.ok(doc().activeElement === trigger, "Tab continues from the trigger, not the end of <body>");
  assertNoDomNode(doc().querySelector(".menu-backdrop"), "and leaves no backdrop behind");
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
    await assertKeyboardContract("More Actions", async () => {
      trigger.focus();
      await press("ArrowDown", trigger);
      return trigger;
    });
  } finally {
    await unmount(mounted);
    restore();
  }
});

/**
 * More Actions has no section labels (§9.1, #2161): a separator sits only between two groups, never
 * first, last or beside another, and the destructive items are the last group, after a separator.
 */
function assertGroupsSeparated(menu: Element, state: string): void {
  const children = [...menu.children].filter((child) =>
    !child.classList.contains("sheet-grabber") && !child.classList.contains("menu-head"));
  assert.equal(children.filter((child) => child.classList.contains("menu-label")).length, 0,
    `${state}: no section labels`);
  children.forEach((child, index) => {
    if (!child.classList.contains("menu-sep")) return;
    assert.ok(index > 0 && index < children.length - 1, `${state}: a separator sits between two groups`);
    assert.ok(!children[index + 1]!.classList.contains("menu-sep"), `${state}: separators never touch`);
  });
  const danger = children.filter((child) => child.classList.contains("danger"));
  if (danger.length === 0) return;
  const lastSeparatorAt = children.map((child) => child.classList.contains("menu-sep")).lastIndexOf(true);
  assert.ok(lastSeparatorAt > 0, `${state}: a separator introduces the destructive items`);
  assert.deepEqual(children.slice(lastSeparatorAt + 1), danger,
    `${state}: the destructive items are the whole last group`);
}

test("every More Actions state separates its groups and ends with the destructive items", async () => {
  const restore = stubViewport(false);
  const states: Array<[string, Partial<SessionView>]> = [
    ["running", { status: "running", archived: false }],
    ["idle", { status: "idle", archived: false }],
    ["stopped", { status: "stopped", archived: false }],
    ["stop failed", {
      status: "stopped",
      archived: false,
      stopOperation: {
        operationId: "stop-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 2, attemptCount: 1,
        capacityReleased: false, failure: { code: "runner_rejected", message: "Stop failed.", failedAt: 3 },
      },
    } as Partial<SessionView>],
    ["archived", { status: "stopped", archived: true }],
    ["archived and running", { status: "running", archived: true }],
  ];
  try {
    for (const [state, overrides] of states) {
      const session = { id: `session-${state}`, runnerId: "runner-1", title: state, ...overrides } as SessionView;
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
        await act(async () => { trigger.click(); await tick(); });
        const menu = doc().querySelector('[role="menu"][aria-label="More Actions"]');
        assert.ok(menu, `${state}: the menu opens`);
        assertGroupsSeparated(menu, state);
      } finally {
        await unmount(mounted);
      }
    }
  } finally {
    restore();
  }
});

test("the rail's More menu keeps the menu keyboard contract and opens as a sheet", async () => {
  const restore = stubViewport(true);
  const mounted = await mount(
    <Rail view={{ name: "inbox" }} blockedCount={0} stalledCount={0} onNavigate={() => undefined} />,
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
    assertNoDomNode(other!.querySelector(".menu-check"));
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

test("an inline menu renders where it is written, inside its dialog, rather than in <body>", async () => {
  function Harness({ inline }: { inline: boolean }) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return (
      <div role="dialog" aria-modal="true" className="host-dialog">
        <button ref={triggerRef} type="button">More Actions</button>
        <MenuSurface surfaceRef={surfaceRef} anchor={{ trigger: triggerRef }} label="More Actions" inline={inline}
          onDismiss={() => undefined}>
          <MenuItem>Adoption Recovery…</MenuItem>
        </MenuSurface>
      </div>
    );
  }
  const restore = stubViewport(false);
  for (const inline of [true, false]) {
    const mounted = await mount(<Harness inline={inline} />);
    try {
      const menu = doc().querySelector<HTMLElement>('[role="menu"]');
      assert.ok(menu);
      const backdrop = doc().querySelector(".menu-backdrop");
      if (inline) {
        // Inside the aria-modal dialog, so assistive technology reaches it, and inside the dialog's
        // layer, so the dialogs' backdrop cannot cover it.
        assert.ok(menu.closest(".host-dialog"), "an inline menu stays inside its dialog");
        assert.ok(backdrop?.closest(".host-dialog"), "its backdrop does too");
        assert.notEqual(menu.style.left, "", "an inline menu is still placed against its trigger");
      } else {
        assert.equal(menu.parentElement, doc().body, "a menu is portalled to <body> by default");
        assertNoDomNode(menu.closest(".host-dialog"));
      }
    } finally {
      await unmount(mounted);
    }
  }
  restore();
});

/**
 * Stubs layout, which happy-dom lacks: a fixed probe (fixed-containing-block.ts) lands at the given
 * ancestor box, `.stub-trigger` at (300, 200), and anything else (the menu, its parent) is 200px
 * wide with no height, at the box's corner, so it moves when the box does.
 */
function stubLayout(box: { left: number; top: number; bottom: number }): { probes: () => number; restore: () => void } {
  const original = domWindow.HTMLElement.prototype.getBoundingClientRect;
  let probes = 0;
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
  domWindow.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.style.position === "fixed" && this.style.height === "100%") {
      probes += 1;
      return rect(box.left, box.top, 0, domWindow.innerHeight - box.bottom - box.top);
    }
    if (this.classList.contains("stub-trigger")) return rect(300, 200, 80, 28);
    return rect(box.left, box.top, 200, 0);
  } as never;
  return {
    probes: () => probes,
    restore: () => { domWindow.HTMLElement.prototype.getBoundingClientRect = original; },
  };
}

function ContainedHarness({ inline }: { inline: boolean }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div role="dialog" aria-modal="true">
      <button ref={triggerRef} type="button" className="stub-trigger">More Actions</button>
      <MenuSurface surfaceRef={surfaceRef} anchor={{ trigger: triggerRef }} label="More Actions" inline={inline}
        onDismiss={() => undefined}>
        <MenuItem>Adoption Recovery…</MenuItem>
      </MenuSurface>
    </div>
  );
}

test("an inline menu under a fixed containing block opens beside its trigger; a portalled one is unchanged", async () => {
  // An ancestor stands 100px right of and 50px below the viewport's corner, 50px above its bottom.
  const layout = stubLayout({ left: 100, top: 50, bottom: 50 });
  const restore = stubViewport(false);
  try {
    for (const inline of [true, false]) {
      const before = layout.probes();
      const mounted = await mount(<ContainedHarness inline={inline} />);
      try {
        const menu = doc().querySelector<HTMLElement>('[role="menu"]')!;
        const backdrop = doc().querySelector<HTMLElement>(".menu-backdrop")!;
        if (inline) {
          // 4px below the trigger (§2.9), in the ancestor's coordinates.
          assert.equal(menu.style.top, `${228 + 4 - 50}px`);
          assert.equal(menu.style.left, `${300 - 100}px`);
          assert.ok(layout.probes() > before, "the containing block is measured");
          // The backdrop reaches back out to the viewport's corner and covers all of it.
          assert.equal(backdrop.style.top, "-50px");
          assert.equal(backdrop.style.left, "-100px");
          assert.equal(backdrop.style.width, "100vw");
          assert.equal(backdrop.style.height, "100vh");
        } else {
          assert.equal(menu.style.top, `${228 + 4}px`, "a portalled menu is placed in viewport coordinates");
          assert.equal(menu.style.left, "300px");
          assert.equal(layout.probes(), before, "and measures no containing block");
          assert.equal(backdrop.getAttribute("style"), null);
        }
        // A scroll or resize that moved nothing measures nothing more.
        const placed = layout.probes();
        await act(async () => {
          domWindow.dispatchEvent(new domWindow.Event("scroll"));
          domWindow.dispatchEvent(new domWindow.Event("resize"));
        });
        assert.equal(layout.probes(), placed);
      } finally {
        await unmount(mounted);
      }
    }
  } finally {
    restore();
    layout.restore();
  }
});

test("an inline phone sheet under a fixed containing block keeps docking to that block", async () => {
  // A scroller around the block clips the sheet, so docked to the viewport instead it could land
  // behind a dialog's footer. It keeps the stylesheet's docking and measures nothing.
  const layout = stubLayout({ left: 16, top: 40, bottom: 60 });
  const restore = stubViewport(true);
  const mounted = await mount(<ContainedHarness inline />);
  try {
    const menu = doc().querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(menu.style.top, "", "a sheet has no anchored placement");
    assert.equal(menu.style.left, "");
    assert.equal(menu.style.bottom, "");
    assert.equal(doc().querySelector(".menu-backdrop")!.getAttribute("style"), null);
    assert.equal(layout.probes(), 0);
  } finally {
    await unmount(mounted);
    restore();
    layout.restore();
  }
});

test("a menu that stops rendering in place drops the offsets it measured there", async () => {
  const layout = stubLayout({ left: 100, top: 50, bottom: 50 });
  const restore = stubViewport(false);
  const mounted = await mount(<ContainedHarness inline />);
  try {
    assert.equal(doc().querySelector<HTMLElement>(".menu-backdrop")!.style.left, "-100px");
    await act(async () => { mounted.root.render(<ContainedHarness inline={false} />); });
    const menu = doc().querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(menu.parentElement, doc().body);
    assert.equal(menu.style.left, "300px");
    assert.equal(doc().querySelector(".menu-backdrop")!.getAttribute("style"), null);
  } finally {
    await unmount(mounted);
    restore();
    layout.restore();
  }
});
