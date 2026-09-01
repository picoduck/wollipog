import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface Log {
  closed: number;
  restored: number;
  renamed: string[];
  snoozed: string[];
  archived: string[];
}

async function mount(overrides: { snoozeAvailable?: boolean } = {}): Promise<{ root: Root; log: Log; menu: HTMLElement }> {
  const log: Log = { closed: 0, restored: 0, renamed: [], snoozed: [], archived: [] };
  const restoreHost = domWindow.document.createElement("button") as unknown as HTMLElement;
  domWindow.document.body.append(restoreHost as never);
  restoreHost.addEventListener("focus", () => { log.restored += 1; });
  const state: SessionContextMenuState = {
    sessionId: "s-1",
    anchor: { x: 120, y: 90 },
    restoreTarget: () => restoreHost,
  };
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SessionContextMenu
        state={state}
        sessionTitle="Fix the Parser"
        snoozeAvailable={overrides.snoozeAvailable ?? true}
        onClose={() => { log.closed += 1; }}
        onRename={(id) => log.renamed.push(id)}
        onSnooze={(id) => log.snoozed.push(id)}
        onArchive={(id) => log.archived.push(id)}
      />,
    );
  });
  const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.ok(menu, "the menu portals to the body");
  return { root, log, menu };
}

async function unmount(root: Root) {
  await act(async () => { root.unmount(); });
  domWindow.document.body.innerHTML = "";
}

test("the menu names its session, offers the three actions, and takes initial focus", async () => {
  const { root, menu } = await mount();
  try {
    assert.equal(menu.getAttribute("aria-label"), "Session Actions for Fix the Parser");
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    assert.deepEqual(items, ["Rename Session…", "Snooze…", "Archive"]);
    assert.equal(domWindow.document.activeElement?.textContent, "Rename Session…",
      "the virtualized collections never focus rows, so the menu takes focus itself");
    assert.ok(menu.querySelector(".menu-item.menu-danger")?.textContent === "Archive");
    assert.ok(domWindow.document.querySelector(".menu-backdrop"),
      "the backdrop enrolls the menu in the shell's Escape ladder");
  } finally {
    await unmount(root);
  }
});

test("snooze is omitted when reminders are unsupported", async () => {
  const { root, menu } = await mount({ snoozeAvailable: false });
  try {
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    assert.deepEqual(items, ["Rename Session…", "Archive"]);
  } finally {
    await unmount(root);
  }
});

test("dialog actions close without restoring focus; archive and dismissal restore it", async () => {
  const { root, log, menu } = await mount();
  try {
    await act(async () => {
      (menu.querySelectorAll('[role="menuitem"]')[0] as unknown as HTMLButtonElement).click();
    });
    assert.deepEqual(log.renamed, ["s-1"]);
    assert.equal(log.closed, 1);
    assert.equal(log.restored, 0, "the rename dialog takes focus; restoring would fight it");
  } finally {
    await unmount(root);
  }

  const second = await mount();
  try {
    await act(async () => {
      (second.menu.querySelector(".menu-danger") as unknown as HTMLButtonElement).click();
    });
    assert.deepEqual(second.log.archived, ["s-1"]);
    assert.equal(second.log.restored, 1, "archive opens no dialog, so keyboard position returns");

    await act(async () => {
      (domWindow.document.querySelector(".menu-backdrop") as unknown as HTMLElement).click();
    });
  } finally {
    await unmount(second.root);
  }
});

test("Escape and arrow roving come from the collection-owned keyboard handler", async () => {
  const { root, log, menu } = await mount();
  try {
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
    assert.equal(domWindow.document.activeElement?.textContent, "Snooze…");
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    assert.equal(log.closed, 1);
    assert.equal(log.restored, 1);
  } finally {
    await unmount(root);
  }
});
