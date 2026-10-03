import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { readTranscriptAction } from "../dom-test-transcript-actions.js";
import { EventTimeline } from "./EventTimeline.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { markdownPlainText as plainText } from "./markdown-plain-text.js";

const domWindow = new Window({ url: "http://localhost/" });
let coarsePointer = false;
const matchMedia = (query: string) => ({
  matches: query === "(pointer: coarse)" ? coarsePointer : false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
});
Object.defineProperty(domWindow, "matchMedia", { configurable: true, writable: true, value: matchMedia });
const clipboard: string[] = [];
Object.defineProperty(domWindow.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (text: string) => { clipboard.push(text); } },
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

const items: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "First **question**" },
  { kind: "checkpoint", id: 2, turn: 1 },
  { kind: "agent_message", id: 3, text: "## Result\n\nThe **answer** is [here](https://example.test).\n\n- one\n- two" },
  { kind: "conversation_checkpoint", id: 4, turn: 1 },
];

async function mount(props: Partial<React.ComponentProps<typeof EventTimeline>> = {}) {
  const toasts: string[] = [];
  const feedback: React.ContextType<typeof FeedbackContext> = {
    confirm: async () => false,
    showToast: (message: string) => { toasts.push(message); return toasts.length; },
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <FeedbackContext.Provider value={feedback}>
      <EventTimeline items={items} {...props} />
    </FeedbackContext.Provider>,
  ));
  cleanup(() => act(async () => root.unmount()));
  return { container, toasts };
}

test("More Turn Actions lists Your Message then This Turn, each under its section label", async () => {
  coarsePointer = false;
  const { container } = await mount({
    onRewind: () => {},
    onFork: () => {},
    onEditAndResend: () => {},
    handoff: { open: () => {} },
    forkAvailabilityByTurn: new Map([[1, { available: true as const, forkTurn: 1 }]]),
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  await act(async () => { trigger.click(); });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  assert.equal(menu.getAttribute("role"), "menu");
  assert.equal(menu.getAttribute("aria-label"), "More Turn Actions");
  const rows = [...menu.querySelectorAll(".menu-label, [role='menuitem']")].map((row) =>
    row.getAttribute("role") === "menuitem" ? (row as HTMLElement).dataset.menuLabel : `[${row.textContent}]`);
  assert.deepEqual(rows, [
    "[Your Message]", "Copy Message", "Edit as a New Turn", "Rewind Files to Before This Turn…",
    "[This Turn]", "Copy Response", "Copy Response as Markdown", "Fork After This Turn…", "Hand Off After This Turn…",
  ]);
  assert.equal(document.activeElement, menu.querySelector("[role='menuitem']"), "the first item takes focus");
});

test("an unavailable item is disabled with its reason as a visible second line it is described by", async () => {
  coarsePointer = false;
  const reason = "Runner is offline.";
  const { container } = await mount({
    onEditAndResend: () => { throw new Error("an unavailable action must not run"); },
    editAndResendUnavailableReason: reason,
  });
  for (const menu of ["More Turn Actions", "More Message Actions"]) {
    const edit = await readTranscriptAction(container, menu, "Edit as a New Turn");
    assert.ok(edit, `${menu} lists Edit as a New Turn`);
    assert.equal(edit.disabled, true);
    assert.equal(edit.element.disabled, false, "aria-disabled, not disabled, so it can still take focus");
    assert.equal(edit.reason, reason, "aria-describedby names the visible reason");
    const line = edit.element.querySelector(".menu-desc");
    assert.equal(line?.textContent, reason, "the reason is the item's visible second line");
    assert.equal(edit.element.getAttribute("aria-labelledby") !== null, true, "its name stays its label alone");
  }
});

test("a fine pointer gets the hover clusters; a coarse pointer gets only More Turn Actions", async () => {
  coarsePointer = false;
  const fine = await mount({ onEditAndResend: () => {} });
  const names = (root: HTMLElement) => [...root.querySelectorAll(".tl-message-actions button")].map((button) => button.getAttribute("aria-label"));
  assert.deepEqual(names(fine.container),
    ["Copy Message", "Edit as a New Turn", "More Message Actions", "Copy Response", "More Turn Actions"]);

  coarsePointer = true;
  const coarse = await mount({ onEditAndResend: () => {} });
  assert.deepEqual(names(coarse.container), ["More Turn Actions"], "no hover cluster renders on a coarse pointer");
  assertNoDomNode(coarse.container.querySelector(".tl-user-actions"), "no message cluster on a coarse pointer");
  const edit = await readTranscriptAction(coarse.container, "More Turn Actions", "Edit as a New Turn");
  assert.equal(edit?.disabled, false, "the turn menu still reaches every message action");
  coarsePointer = false;
});

test("the arrow keys reach unavailable items, and choosing one does nothing", async () => {
  coarsePointer = false;
  let edited = false;
  const { container } = await mount({
    onEditAndResend: () => { edited = true; },
    editAndResendUnavailableReason: "Runner is offline.",
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
  await act(async () => { trigger.click(); });
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const press = async (key: string) => {
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    return (document.activeElement as HTMLElement).dataset.menuLabel;
  };
  assert.equal((document.activeElement as HTMLElement).dataset.menuLabel, "Copy Message");
  assert.equal(await press("ArrowDown"), "Edit as a New Turn", "the unavailable item takes focus");
  assert.equal(await press("End"), "Copy Response as Markdown");
  assert.equal(await press("ArrowDown"), "Copy Message", "the arrows wrap");
  assert.equal(await press("ArrowUp"), "Copy Response as Markdown");
  assert.equal(await press("Home"), "Copy Message");
  const edit = [...menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((item) => item.dataset.menuLabel === "Edit as a New Turn")!;
  await act(async () => { edit.click(); });
  assert.equal(edited, false, "an unavailable action never runs");
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "and the menu stays open");
});

test("on a coarse pointer, a message no turn menu lists keeps More Message Actions", async () => {
  coarsePointer = true;
  const { container } = await mount({
    onEditAndResend: () => {},
    sessionActive: true,
    items: [
      ...items,
      { kind: "user_message", id: 5, text: "A steer", deliveryIntent: "steer", submissionId: "steer-1" },
      { kind: "user_message", id: 6, text: "Second prompt" },
      { kind: "agent_message", id: 7, text: "Working on it" },
    ],
  });
  const names = [...container.querySelectorAll(".tl-message-actions button")].map((button) => button.getAttribute("aria-label"));
  // The first prompt is in its settled turn's menu. The steer belongs to that turn but is not its
  // prompt, so it keeps its own menu before the footer; the running turn's prompt has no footer yet.
  assert.deepEqual(names, ["More Message Actions", "More Turn Actions", "More Message Actions"]);
  for (const index of [0, 1]) {
    const edit = await readTranscriptAction(container, "More Message Actions", "Edit as a New Turn", index);
    assert.equal(edit?.disabled, false);
  }
  coarsePointer = false;
});

test("a dialog action runs with focus on its trigger, so the dialog returns focus there", async () => {
  coarsePointer = false;
  let focusedAtRun: Element | null = null;
  let rewound: number | undefined;
  const { container } = await mount({
    onRewind: (turn) => { focusedAtRun = document.activeElement; rewound = turn; },
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
  await act(async () => { trigger.click(); });
  const rewind = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((item) => item.dataset.menuLabel === "Rewind Files to Before This Turn…")!;
  await act(async () => { rewind.click(); });
  assert.equal(rewound, 1);
  assert.equal(focusedAtRun, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "the menu closed");
});

test("Copy Response copies plain text and Copy Response as Markdown copies the source", async () => {
  coarsePointer = false;
  clipboard.length = 0;
  const { container, toasts } = await mount();
  for (const label of ["Copy Response", "Copy Response as Markdown"]) {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
    await act(async () => { trigger.click(); });
    const item = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
      .find((candidate) => candidate.dataset.menuLabel === label)!;
    await act(async () => { item.click(); });
  }
  assert.deepEqual(clipboard, [
    "Result\n\nThe answer is here.\n\n- one\n- two",
    "## Result\n\nThe **answer** is [here](https://example.test).\n\n- one\n- two",
  ]);
  assert.deepEqual(toasts, ["Response copied.", "Response copied as Markdown."]);
});

test("Markdown's plain text keeps paragraphs, lists, code, tables, task boxes and image names", () => {
  // It renders into its own detached root, which this file's act environment expects inside act().
  const markdownPlainText = (markdown: string) => {
    let text = "";
    act(() => { text = plainText(markdown); });
    return text;
  };
  assert.equal(markdownPlainText(""), "");
  assert.equal(markdownPlainText("# Title\n\nOne *two* `three`\nfour"), "Title\n\nOne two three\nfour");
  assert.equal(markdownPlainText("1. first\n2. second\n   - nested"), "1. first\n2. second\n   - nested");
  assert.equal(markdownPlainText("```ts\nconst a = 1;\n```"), "const a = 1;");
  assert.equal(markdownPlainText("| A | B |\n| - | - |\n| 1 | 2 |"), "A\tB\n1\t2");
  assert.equal(markdownPlainText("- [x] done\n- [ ] open"), "- [x] done\n- [ ] open");
  assert.equal(markdownPlainText("![a chart](https://example.test/chart.png) <b>raw</b>"), "a chart raw");
  assert.equal(markdownPlainText("> quoted\n\n---\n\nafter"), "quoted\n\nafter");
});
