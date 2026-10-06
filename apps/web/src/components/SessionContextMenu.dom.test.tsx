import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import type { ConversationForkAvailability } from "../session-actions.js";
import { SessionContextMenu, type SessionContextMenuState } from "./SessionContextMenu.js";
import { useLongPress } from "./interactions.js";

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
  PointerEvent: domWindow.PointerEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface Log {
  closed: number;
  restored: number;
  renamed: string[];
  toggledPin: string[];
  snoozed: string[];
  dismissed: string[];
  archived: string[];
  replied: string[];
  toggledUnread: string[];
  forked: string[];
}

type MenuSession = Pick<SessionView, "title" | "archiveStatus" | "archived" | "status">;
const idle: MenuSession = { title: "Fix the Parser", archived: false, status: "completed" };

/** The items' labels, without their keycaps or second lines. */
function labels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.querySelector(".menu-text")?.textContent ?? "");
}

function item(menu: HTMLElement, label: string): HTMLButtonElement {
  return [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.querySelector(".menu-text")?.textContent === label)!;
}

async function mount(overrides: {
  session?: MenuSession;
  unread?: boolean;
  stopBeforeArchiveSupported?: boolean;
  forkAvailability?: ConversationForkAvailability;
  showKeys?: boolean;
  pinned?: boolean;
  snoozeAvailable?: boolean;
  reminder?: SessionReminderView;
  renameRefusal?: string | null;
  archiveRefusal?: string | null;
} = {}): Promise<{ root: Root; log: Log; menu: HTMLElement }> {
  const log: Log = {
    closed: 0, restored: 0, renamed: [], toggledPin: [], snoozed: [], dismissed: [], archived: [], replied: [],
    toggledUnread: [], forked: [],
  };
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
        session={overrides.session ?? idle}
        unread={overrides.unread ?? false}
        stopBeforeArchiveSupported={overrides.stopBeforeArchiveSupported ?? true}
        {...(overrides.forkAvailability ? { forkAvailability: overrides.forkAvailability } : {})}
        showKeys={overrides.showKeys ?? false}
        pinned={overrides.pinned ?? false}
        snoozeAvailable={overrides.snoozeAvailable ?? true}
        {...(overrides.reminder ? { reminder: overrides.reminder } : {})}
        onClose={() => { log.closed += 1; }}
        onReply={(id) => log.replied.push(id)}
        onToggleUnread={(id) => log.toggledUnread.push(id)}
        onFork={(id) => log.forked.push(id)}
        onRename={(id) => log.renamed.push(id)}
        onTogglePin={(id) => log.toggledPin.push(id)}
        onSnooze={(id) => log.snoozed.push(id)}
        onDismissReminder={(id) => log.dismissed.push(id)}
        onArchive={(id) => log.archived.push(id)}
        renameRefusal={overrides.renameRefusal ?? null}
        archiveRefusal={overrides.archiveRefusal ?? null}
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

test("the menu names its session, offers its actions, and takes initial focus", async () => {
  const { root, menu } = await mount();
  try {
    assert.equal(menu.getAttribute("aria-label"), "Session Actions for Fix the Parser");
    assert.deepEqual(labels(menu), ["Reply", "Rename Session…", "Pin Session", "Mark Unread", "Snooze…", "Archive"]);
    assert.equal(domWindow.document.activeElement?.textContent, "Reply",
      "the virtualized collections never focus rows, so the menu takes focus itself");
    assert.ok(menu.querySelector(".menu-item.danger .menu-text")?.textContent === "Archive");
    assert.equal(menu.querySelector(".menu-head")?.textContent, "Fix the Parser",
      "the phone sheet is titled with the session's one-line title");
    assert.ok(domWindow.document.querySelector(".menu-backdrop"),
      "the backdrop enrolls the menu in the shell's Escape ladder");
  } finally {
    await unmount(root);
  }
});

test("returned reminders expose Snooze Again and direct dismissal", async () => {
  const scheduledFor = Date.now() - 60_000;
  const fired: SessionReminderView = {
    reminderId: "reminder-1", sessionId: "s-1", scheduledFor, timeZone: "UTC",
    originalExpression: "one minute ago", wakePolicy: "regardless", state: "fired",
    revision: 2, createdAt: scheduledFor - 1_000, updatedAt: scheduledFor,
    firedAt: scheduledFor, wakeReason: "scheduled",
  };
  const { root, log, menu } = await mount({ reminder: fired });
  try {
    assert.deepEqual(labels(menu),
      ["Reply", "Rename Session…", "Pin Session", "Mark Unread", "Snooze Again…", "Dismiss Reminder", "Archive"]);
    await act(async () => { item(menu, "Dismiss Reminder").click(); });
    assert.deepEqual(log.dismissed, ["s-1"]);
    assert.equal(log.restored, 1);
  } finally {
    await unmount(root);
  }
});

test("snooze is omitted when reminders are unsupported", async () => {
  const { root, menu } = await mount({ snoozeAvailable: false });
  try {
    assert.deepEqual(labels(menu), ["Reply", "Rename Session…", "Pin Session", "Mark Unread", "Archive"]);
  } finally {
    await unmount(root);
  }
});

test("dialog actions close without restoring focus; pin, archive, and dismissal restore it", async () => {
  const { root, log, menu } = await mount();
  try {
    await act(async () => { item(menu, "Rename Session…").click(); });
    assert.deepEqual(log.renamed, ["s-1"]);
    assert.equal(log.closed, 1);
    assert.equal(log.restored, 0, "the rename dialog takes focus; restoring would fight it");
  } finally {
    await unmount(root);
  }

  const pin = await mount({ pinned: true });
  try {
    await act(async () => {
      item(pin.menu, "Unpin Session").click();
    });
    assert.deepEqual(pin.log.toggledPin, ["s-1"], "the action keeps the menu target identity");
    assert.equal(pin.log.closed, 1);
    assert.equal(pin.log.restored, 1, "pinning opens no dialog, so keyboard position returns");
  } finally {
    await unmount(pin.root);
  }

  const second = await mount();
  try {
    await act(async () => {
      (second.menu.querySelector(".menu-item.danger") as unknown as HTMLButtonElement).click();
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
    assert.equal(domWindow.document.activeElement?.textContent, "Rename Session…");
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    assert.equal(log.closed, 1);
    assert.equal(log.restored, 1);
  } finally {
    await unmount(root);
  }
});

test("a Viewer's Rename and Archive stay listed, disabled and described by the reason; Pin and Snooze keep working (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const { root, log, menu } = await mount({ renameRefusal: reason, archiveRefusal: reason });
  try {
    for (const label of ["Rename Session…", "Archive"]) {
      const button = item(menu, label);
      assert.equal(button.disabled, true, `${label} is disabled`);
      assert.equal(button.title, reason);
      const described = button.getAttribute("aria-describedby");
      assert.equal(described ? domWindow.document.getElementById(described)?.textContent : null, reason,
        `${label} is described by the visible reason`);
    }
    assert.equal(menu.querySelectorAll(".menu-note").length, 1, "one shared reason is shown once");
    assert.equal(domWindow.document.activeElement?.textContent, "Reply", "initial focus is the first enabled item");
    await act(async () => {
      item(menu, "Rename Session…").click();
      item(menu, "Archive").click();
    });
    assert.deepEqual(log.renamed, []);
    assert.deepEqual(log.archived, []);
    await act(async () => { item(menu, "Pin Session").click(); });
    assert.deepEqual(log.toggledPin, ["s-1"], "per-person Pin still works");
  } finally {
    await unmount(root);
  }
});

test("Tab closes the menu from where it was opened, not from the end of <body>", async () => {
  const { root, log, menu } = await mount();
  try {
    await act(async () => {
      menu.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Tab", bubbles: true }) as never);
    });
    assert.equal(log.closed, 1);
    // Focus is back on the row the menu belongs to before the browser's Tab moves on from it.
    assert.equal(log.restored, 1);
  } finally {
    await unmount(root);
  }
});

/** Long-press and lift a touch pointer, as a finger does before the phone sheet mounts under it. */
async function longPressAndRelease(): Promise<Root> {
  function Pressable() {
    const press = useLongPress(() => undefined);
    return <div data-testid="pressable" {...press.handlers} />;
  }
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const pressRoot = createRoot(host);
  await act(async () => { pressRoot.render(<Pressable />); });
  const pressable = domWindow.document.querySelector('[data-testid="pressable"]')!;
  const pointer = { bubbles: true, pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 };
  await act(async () => {
    pressable.dispatchEvent(new domWindow.PointerEvent("pointerdown", pointer) as never);
    await new Promise((resolve) => domWindow.setTimeout(resolve, 560));
    pressable.dispatchEvent(new domWindow.PointerEvent("pointerup", pointer) as never);
  });
  return pressRoot;
}

test("the click a long-press releases onto a phone sheet item runs nothing", async () => {
  // A long-press on a low row can mount the phone sheet under the finger: the release click then
  // lands on an item rather than the backdrop. It is the opening gesture, not a choice.
  const pressRoot = await longPressAndRelease();
  const { root, log, menu } = await mount();
  try {
    const pin = item(menu, "Pin Session");
    await act(async () => { pin.click(); });
    assert.deepEqual(log.toggledPin, [], "the release click is swallowed");
    await act(async () => { pin.click(); });
    assert.deepEqual(log.toggledPin, ["s-1"], "the next, deliberate tap acts");
  } finally {
    await act(async () => { pressRoot.unmount(); });
    await unmount(root);
  }
});

test("a release onto the phone sheet's title row spends the grace, so the next item tap acts (#2082)", async () => {
  // The finger can lift over the sheet's title row instead of an item. Unspent there, the
  // release grace swallowed the user's first real tap on an item.
  const pressRoot = await longPressAndRelease();
  const { root, log, menu } = await mount();
  try {
    await act(async () => { menu.querySelector<HTMLElement>(".menu-head")!.click(); });
    assert.equal(domWindow.document.querySelector('[role="menu"]') !== null, true, "the release closes nothing");
    await act(async () => { item(menu, "Pin Session").click(); });
    assert.deepEqual(log.toggledPin, ["s-1"]);
  } finally {
    await act(async () => { pressRoot.unmount(); });
    await unmount(root);
  }
});

test("every item of a forkable session, in order, with its icon and one separator before the archive item (#2214)", async () => {
  const { root, log, menu } = await mount({ forkAvailability: { available: true, forkTurn: 3 } });
  try {
    assert.deepEqual(labels(menu),
      ["Reply", "Rename Session…", "Pin Session", "Mark Unread", "Fork Conversation…", "Snooze…", "Archive"]);
    for (const menuItem of menu.querySelectorAll('[role="menuitem"]')) {
      assert.ok(menuItem.querySelector(".menu-icon svg"), `${menuItem.textContent} leads with its icon`);
    }
    const children = [...menu.children];
    const separators = children.filter((child) => child.getAttribute("role") === "separator");
    assert.equal(separators.length, 1, "one separator");
    assert.equal(children[children.indexOf(separators[0]!) + 1], item(menu, "Archive"), "it comes right before Archive");
    await act(async () => { item(menu, "Fork Conversation…").click(); });
    assert.deepEqual(log.forked, ["s-1"]);
    assert.equal(log.restored, 0, "the fork's confirmation takes focus");
  } finally {
    await unmount(root);
  }

  const replied = await mount();
  try {
    await act(async () => { item(replied.menu, "Reply").click(); });
    assert.deepEqual(replied.log.replied, ["s-1"]);
  } finally {
    await unmount(replied.root);
  }
});

test("the archive item reads Archive, Archive and Stop… or Retry Stop… with the shared label (#2214)", async () => {
  const cases: Array<[MenuSession, boolean, string]> = [
    [idle, true, "Archive"],
    [{ ...idle, status: "running" }, true, "Archive and Stop…"],
    // A session waiting for its next prompt still has a live process to stop.
    [{ ...idle, status: "idle" }, true, "Archive and Stop…"],
    [{ ...idle, status: "running", archiveStatus: "stop_failed" }, true, "Retry Stop…"],
    // A control plane that cannot stop first archives a running session without asking.
    [{ ...idle, status: "running" }, false, "Archive"],
  ];
  for (const [session, stopBeforeArchiveSupported, label] of cases) {
    const { root, menu } = await mount({ session, stopBeforeArchiveSupported });
    try {
      assert.equal(labels(menu).at(-1), label, `${session.status} ${session.archiveStatus ?? ""}`);
    } finally {
      await unmount(root);
    }
  }
});

test("Fork Conversation is disabled with its reason as a visible second line, and absent where it can never fork", async () => {
  const reason = "Wait for the current turn or approval before creating a fork.";
  const running = await mount({ forkAvailability: { available: false, offered: true, reason } });
  try {
    const fork = item(running.menu, "Fork Conversation…");
    assert.equal(fork.disabled, true);
    assert.equal(fork.querySelector(".menu-desc")?.textContent, reason);
    assert.equal(domWindow.document.getElementById(fork.getAttribute("aria-describedby")!)?.textContent, reason);
    await act(async () => { fork.click(); });
    assert.deepEqual(running.log.forked, []);
  } finally {
    await unmount(running.root);
  }

  const never = await mount({
    forkAvailability: { available: false, offered: false, reason: "This provider does not support conversation forks." },
  });
  try {
    assert.equal(labels(never.menu).includes("Fork Conversation…"), false);
  } finally {
    await unmount(never.root);
  }
});

test("Mark Unread becomes Mark Read for an unread session, and Pin becomes Unpin for a pinned one", async () => {
  const { root, log, menu } = await mount({ unread: true, pinned: true });
  try {
    assert.deepEqual(labels(menu).slice(2, 4), ["Unpin Session", "Mark Read"]);
    await act(async () => { item(menu, "Mark Read").click(); });
    assert.deepEqual(log.toggledUnread, ["s-1"]);
    assert.equal(log.restored, 1, "marking opens no dialog, so keyboard position returns");
  } finally {
    await unmount(root);
  }
});

test("items with a Sessions list key show its keycap only where the key acts on this session (#2214)", async () => {
  const { root, menu } = await mount({ showKeys: true, forkAvailability: { available: true, forkTurn: 1 } });
  try {
    const keycaps = Object.fromEntries([...menu.querySelectorAll('[role="menuitem"]')].map((menuItem) => [
      menuItem.querySelector(".menu-text")?.textContent,
      menuItem.querySelector(".menu-trail kbd")?.textContent ?? null,
    ]));
    assert.deepEqual(keycaps, {
      "Reply": "R",
      "Rename Session…": null,
      "Pin Session": "S",
      "Mark Unread": "U",
      "Fork Conversation…": "F",
      "Snooze…": "H",
      "Archive": "E",
    });
    assert.equal(item(menu, "Archive").getAttribute("aria-keyshortcuts"), "E");
  } finally {
    await unmount(root);
  }

  const elsewhere = await mount({ showKeys: false });
  try {
    assert.equal(elsewhere.menu.querySelectorAll("kbd").length, 0, "no keycap for a session the keys do not act on");
  } finally {
    await unmount(elsewhere.root);
  }
});
