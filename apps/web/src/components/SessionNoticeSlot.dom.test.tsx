import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { Notice } from "./Notice.js";
import {
  SESSION_NOTICE_RANK,
  SessionNoticeSlot,
  compareSessionNotices,
  type SessionNoticeEntry,
  type SessionNoticeSeverity,
} from "./SessionNoticeSlot.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function entry(key: string, severity: SessionNoticeSeverity, rank: number, title = key): SessionNoticeEntry {
  return {
    key, severity, rank, title,
    render: ({ trailing, onDismiss }) => (
      <Notice tone={severity} ariaLabel={title} title={title} trailing={trailing} onDismiss={onDismiss}>
        {title} body.
      </Notice>
    ),
  };
}

/** The issue's conditions, most severe and lowest rank first (#1966). */
const ORDERED = [
  entry("worktree-missing", "danger", SESSION_NOTICE_RANK.worktreeMissing, "Worktree Missing"),
  entry("history-quarantine", "danger", SESSION_NOTICE_RANK.historyQuarantine, "Conversation Quarantined"),
  entry("worktree-setup-failed", "danger", SESSION_NOTICE_RANK.worktreeSetupFailed, "Worktree Setup Failed"),
  entry("account-switch-failed", "warning", SESSION_NOTICE_RANK.accountSwitchFailed, "Account Switch Failed"),
  entry("skills-unavailable", "warning", SESSION_NOTICE_RANK.skillsUnavailable, "Skills Unavailable"),
  entry("setup-suggestion", "info", SESSION_NOTICE_RANK.setupSuggestion, "Set Up This Project"),
];

function menuItems(): HTMLButtonElement[] {
  return [...domWindow.document.querySelectorAll('[role="menuitem"]')] as unknown as HTMLButtonElement[];
}

async function render(sessionId: string, entries: readonly SessionNoticeEntry[]) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = (next: readonly SessionNoticeEntry[]) => act(async () => {
    root.render(<SessionNoticeSlot sessionId={sessionId} entries={next} />);
  });
  await draw(entries);
  return {
    container,
    draw,
    shown: () => [...container.querySelectorAll(".notice")].map((notice) => notice.getAttribute("aria-label")),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("each pair of conditions shows the more severe, then the lower rank, whatever the input order", async () => {
  for (let i = 0; i < ORDERED.length; i += 1) {
    for (let j = i + 1; j < ORDERED.length; j += 1) {
      const first = ORDERED[i]!;
      const second = ORDERED[j]!;
      assert.ok(compareSessionNotices(first, second) < 0, `${first.key} before ${second.key}`);
      const slot = await render(`pair-${i}-${j}`, [second, first]);
      try {
        assert.deepEqual(slot.shown(), [first.title], `${first.title} shows over ${second.title}`);
        assert.equal(slot.container.querySelector(".session-notice-more")?.textContent, "+1 More");
      } finally {
        await slot.unmount();
      }
    }
  }
});

test("severity outranks rank", () => {
  assert.ok(compareSessionNotices(entry("a", "danger", 9), entry("b", "warning", 1)) < 0);
  assert.ok(compareSessionNotices(entry("a", "warning", 9), entry("b", "info", 1)) < 0);
});

test("nothing renders without a condition", async () => {
  const slot = await render("empty", []);
  try {
    assert.equal(slot.container.innerHTML, "");
  } finally {
    await slot.unmount();
  }
});

test("a choice holds while the conditions are unchanged, and focus follows +N More", async () => {
  const entries = ORDERED.slice(1, 4);
  const slot = await render("choice", entries);
  try {
    const more = () => slot.container.querySelector(".session-notice-more") as HTMLButtonElement;
    await act(async () => { more().click(); });
    const item = menuItems().find((candidate) => candidate.textContent === "Worktree Setup Failed")!;
    await act(async () => { item.click(); });
    assert.deepEqual(slot.shown(), ["Worktree Setup Failed"]);
    assert.equal(domWindow.document.activeElement, more(), "focus moves to the shown notice's +N More");

    // Re-rendering the same set (a fresh array, a reordered one) keeps the choice.
    await slot.draw([...entries].reverse());
    assert.deepEqual(slot.shown(), ["Worktree Setup Failed"]);
    // A new condition resets it.
    await slot.draw([...entries, ORDERED[4]!]);
    assert.deepEqual(slot.shown(), ["Conversation Quarantined"]);
  } finally {
    await slot.unmount();
  }
});

test("focus stays in the slot when the condition it was on resolves while the menu is open", async () => {
  const [first, second, third] = [ORDERED[1]!, ORDERED[2]!, ORDERED[3]!];
  const slot = await render("resolve-open", [first, second, third]);
  try {
    await act(async () => { (slot.container.querySelector(".session-notice-more") as HTMLButtonElement).click(); });
    assert.equal(domWindow.document.activeElement?.textContent, second.title, "the menu opens on its first item");
    // The focused item's condition resolves; focus moves to the item that is left.
    await slot.draw([first, third]);
    assert.equal(domWindow.document.activeElement?.textContent, third.title);
    // The last one resolves: the menu and "+N More" go, and focus lands in the shown notice.
    await slot.draw([first]);
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    const active = domWindow.document.activeElement as unknown as HTMLElement | null;
    assert.notEqual(active, domWindow.document.body as unknown as HTMLElement, "focus does not fall to <body>");
    assert.ok(active && slot.container.contains(active as never), "focus stays in the slot");
  } finally {
    await slot.unmount();
  }
});

test("when every condition resolves at once with the menu open, focus goes to the fallback", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let restored = 0;
  const draw = (next: readonly SessionNoticeEntry[]) => act(async () => {
    root.render(<SessionNoticeSlot sessionId="resolve-all" entries={next} onFocusLost={() => { restored += 1; }} />);
  });
  try {
    await draw([ORDERED[1]!, ORDERED[2]!]);
    await act(async () => { (container.querySelector(".session-notice-more") as HTMLButtonElement).click(); });
    assert.equal(domWindow.document.activeElement?.getAttribute("role"), "menuitem");
    await draw([]);
    assert.equal(container.innerHTML, "");
    assert.equal(restored, 1, "the slot hands focus to its fallback (the composer)");
    await draw([]);
    assert.equal(restored, 1, "only once");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("only info conditions are dismissible, and a dismissal lasts for the session", async () => {
  const info = ORDERED[5]!;
  const warning = ORDERED[3]!;
  const slot = await render("dismiss-a", [info]);
  try {
    assert.ok(slot.container.querySelector(".notice-head .notice-dismiss"), "an info notice has a dismiss in its title row");
    await slot.draw([warning]);
    assertNoDomNode(slot.container.querySelector(".notice-dismiss"), "a warning is not dismissible by the slot");

    await slot.draw([info, warning]);
    await act(async () => { (slot.container.querySelector(".session-notice-more") as HTMLButtonElement).click(); });
    await act(async () => {
      menuItems()[0]!.click();
    });
    assert.deepEqual(slot.shown(), ["Set Up This Project"]);
    await act(async () => { (slot.container.querySelector(".notice-dismiss") as HTMLButtonElement).click(); });
    assert.deepEqual(slot.shown(), ["Account Switch Failed"]);
    assertNoDomNode(slot.container.querySelector(".session-notice-more"), "a dismissed note is not counted");
  } finally {
    await slot.unmount();
  }
  const again = await render("dismiss-a", [info]);
  const other = await render("dismiss-b", [info]);
  try {
    assert.deepEqual(again.shown(), [], "the same session keeps the dismissal");
    assert.deepEqual(other.shown(), ["Set Up This Project"], "another session does not");
  } finally {
    await again.unmount();
    await other.unmount();
  }
});
