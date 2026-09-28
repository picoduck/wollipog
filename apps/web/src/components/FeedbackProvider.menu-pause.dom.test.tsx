import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackProvider, useFeedback, type ToastOptions } from "./FeedbackProvider.js";
import { MenuItem, MenuSurface } from "./Menu.js";

/**
 * #1990 (docs/design-system.md §13.1): on a phone an open menu or popover hides the toast stack, so
 * every auto-dismiss timer pauses for as long as it is open and resumes with the time it had left.
 * The pause follows the shared menu primitive's open state, not a list of menu class names.
 */

const domWindow = new Window({ url: "http://localhost/", width: 390, height: 844 });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

// Timers fire only when a test advances this clock, and Date.now reads the same clock, so the time
// a toast "had left" is exact.
const realNow = Date.now;
let now = 1_000_000;
const timers: Array<{ id: number; at: number; run: () => void }> = [];
let nextTimerId = 1;
Date.now = () => now;
Object.assign(domWindow, {
  setTimeout: (run: () => void, delay = 0) => {
    const id = nextTimerId++;
    timers.push({ id, at: now + Math.max(0, Number(delay) || 0), run });
    return id;
  },
  clearTimeout: (id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  },
});
test.after(() => { Date.now = realNow; });

async function advance(ms: number) {
  const until = now + ms;
  for (;;) {
    const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!next) break;
    timers.splice(timers.indexOf(next), 1);
    now = next.at;
    await act(async () => { next.run(); });
  }
  now = until;
}

let controls: {
  toast: (message: string, options?: ToastOptions) => void;
  open: (kind: "menu" | "popover" | null) => void;
} | null = null;

function Harness() {
  const feedback = useFeedback();
  const [open, setOpen] = useState<"menu" | "popover" | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  controls = { toast: (message, options) => feedback.showToast(message, options), open: setOpen };
  return open === null ? null : (
    <MenuSurface surfaceRef={surface} anchor={{ point: { x: 20, y: 20 } }} label="More Actions" kind={open}
      onDismiss={() => setOpen(null)}>
      <MenuItem>Rename</MenuItem>
    </MenuSurface>
  );
}

async function mount(width: number) {
  await act(async () => { domWindow.happyDOM.setViewport({ width, height: 844 }); });
  timers.length = 0;
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => { root.render(<StrictMode><FeedbackProvider><Harness /></FeedbackProvider></StrictMode>); });
  const region = () => domWindow.document.querySelector(".toast-region") as unknown as HTMLElement;
  return {
    region,
    toasts: () => [...region().querySelectorAll(".toast")].map((toast) => toast.textContent ?? ""),
    toast: async (message: string, options?: ToastOptions) => { await act(async () => { controls!.toast(message, options); }); },
    open: async (kind: "menu" | "popover" | null) => { await act(async () => { controls!.open(kind); }); },
    async dispose() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("at 390px no toast expires while a menu hides the stack, and it resumes with the time it had left", async () => {
  const view = await mount(390);
  try {
    await view.open("menu");
    assert.ok(domWindow.document.querySelector("body > .menu"), "the shared menu primitive is open");
    await view.toast("Saved.");
    assert.ok(view.region().classList.contains("under-menu"), "the stack is hidden while the menu is open");
    await advance(20_000);
    assert.deepEqual(view.toasts().length, 1, "no toast dismissed itself while the stack was hidden");
    await view.open(null);
    assert.equal(view.region().classList.contains("under-menu"), false, "the toast reappears when the menu closes");
    await advance(4_999);
    assert.equal(view.toasts().length, 1, "the pause restarted nothing and took nothing away");
    await advance(1);
    assert.equal(view.toasts().length, 0, "the toast dismisses once its remaining five seconds run");
  } finally {
    await view.dispose();
  }
});

test("a toast raised before the menu opened keeps only the time it had left", async () => {
  const view = await mount(390);
  try {
    await view.toast("Session archived.", { action: { label: "Undo", run: () => {} } });
    await advance(4_000);
    await view.open("menu");
    await advance(60_000);
    assert.equal(view.toasts().length, 1, "the Undo toast is still there after a long menu");
    await view.open(null);
    await advance(5_999);
    assert.equal(view.toasts().length, 1);
    await advance(1);
    assert.equal(view.toasts().length, 0, "10s in total: 4s before the menu, 6s after it; no restart from zero");
  } finally {
    await view.dispose();
  }
});

test("a popover from the same primitive pauses the stack too", async () => {
  const view = await mount(390);
  try {
    await view.open("popover");
    assert.ok(domWindow.document.querySelector("body > .popover"));
    await view.toast("Copied.");
    await advance(20_000);
    assert.equal(view.toasts().length, 1);
    assert.ok(view.region().classList.contains("under-menu"));
  } finally {
    await view.dispose();
  }
});

test("leaving the stack with the pointer does not resume timers while a menu still hides it", async () => {
  const view = await mount(390);
  try {
    await view.toast("Saved.");
    const region = view.region();
    await act(async () => { region.dispatchEvent(new domWindow.MouseEvent("mouseover", { bubbles: true }) as never); });
    await view.open("menu");
    await act(async () => { region.dispatchEvent(new domWindow.MouseEvent("mouseout", { bubbles: true }) as never); });
    await advance(20_000);
    assert.equal(view.toasts().length, 1, "the menu's pause outlives the pointer's");
    await view.open(null);
    await advance(5_000);
    assert.equal(view.toasts().length, 0);
  } finally {
    await view.dispose();
  }
});

test("error and warning toasts still persist until dismissed", async () => {
  const view = await mount(390);
  try {
    await view.toast("Archive failed.", { tone: "error" });
    await view.toast("Budget nearly spent.", { tone: "warning" });
    await view.open("menu");
    await advance(30_000);
    await view.open(null);
    await advance(120_000);
    // A phone shows the newest toast and keeps the rest behind "+N More" (§13.1).
    assert.match(view.toasts()[0]!, /Budget nearly spent/);
    assert.equal(view.region().querySelector(".toast-more")?.textContent, "+1 More", "the error is still there");
  } finally {
    await view.dispose();
  }
});

test("at 1440px an open menu neither hides the stack nor pauses its timers", async () => {
  const view = await mount(1440);
  try {
    await view.open("menu");
    await view.toast("Saved.");
    assert.equal(view.region().classList.contains("under-menu"), false);
    await advance(5_000);
    assert.equal(view.toasts().length, 0, "the info toast dismissed on its usual schedule");
    await view.open(null);
  } finally {
    await view.dispose();
  }
});
