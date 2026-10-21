import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { chooseTranscriptAction, readTranscriptAction } from "../dom-test-transcript-actions.js";
import { EventTimeline } from "./EventTimeline.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { markdownPlainText as plainText } from "./markdown-plain-text.js";
import { inPlaceHandoffTurns } from "@wollipog/protocol";

const domWindow = new Window({ url: "http://localhost/" });
let coarsePointer = false;
const matchMedia = (query: string) => ({
  get matches() { return query === "(pointer: coarse)" ? coarsePointer : false; },
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
  return { container, toasts, unmount: () => act(async () => root.unmount()) };
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

test("in-place turns offer Hand Off without offering a native fork and show ambiguous-history reasons", async () => {
  const payloads = [
    { seq: 1, payload: { kind: "user_message" as const, text: "Task", final: true } },
    { seq: 2, payload: { kind: "agent_message" as const, text: "Answer", final: true } },
    { seq: 3, payload: { kind: "agent_response_completed" as const } },
  ];
  const inPlaceItems = items.filter((item) => item.kind !== "checkpoint" && item.kind !== "conversation_checkpoint");
  const called: number[] = [];
  const good = inPlaceHandoffTurns(payloads);
  const { container, unmount } = await mount({ items: inPlaceItems,
    handoff: { open: (turn) => called.push(turn), inPlaceTurns: new Map(good.turns.map((point) => [point.promptSeq, point])) } });
  const handoff = await readTranscriptAction(container, "More Turn Actions", "Hand Off After This Turn…");
  assert.ok(handoff);
  assert.equal(handoff.disabled, false);
  assert.equal(await readTranscriptAction(container, "More Turn Actions", "Fork After This Turn…"), null);
  await chooseTranscriptAction(container, "More Turn Actions", "Hand Off After This Turn…");
  assert.deepEqual(called, [1]);
  await unmount();
  for (const history of [payloads.slice(0, 2), payloads.slice(1)]) {
    const projection = inPlaceHandoffTurns(history);
    const mounted = await mount({ items: inPlaceItems,
      handoff: { open: () => assert.fail("ambiguous turn must not hand off"),
        inPlaceTurns: new Map(projection.turns.map((point) => [point.promptSeq, point])), historyReason: projection.reason } });
    const disabled = await readTranscriptAction(mounted.container, "More Turn Actions", "Hand Off After This Turn…");
    assert.ok(disabled?.disabled);
    assert.match(disabled.reason!, /no authoritative completion|Load the earlier history/);
    await mounted.unmount();
  }
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

test("opening focus and type-ahead reach unavailable items too", async () => {
  coarsePointer = false;
  const { container } = await mount({
    items: [
      { kind: "user_message", id: 1, text: "" },
      { kind: "checkpoint", id: 2, turn: 1 },
      { kind: "agent_message", id: 3, text: "Done." },
      { kind: "conversation_checkpoint", id: 4, turn: 1 },
    ],
    onRewind: () => { throw new Error("an unavailable Rewind must not run"); },
    rewindUnavailableReason: "Reconnect the runner before restoring files.",
  });
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
  const key = async (target: Element, value: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    });
    return (document.activeElement as HTMLElement).dataset.menuLabel;
  };
  // An attachment-only prompt has nothing to copy, so its first item is unavailable, and focused.
  assert.equal(await key(trigger, "ArrowDown"), "Copy Message");
  assert.equal(document.activeElement?.getAttribute("aria-disabled"), "true");
  assert.equal(await key(document.activeElement!, "r"), "Rewind Files to Before This Turn…",
    "type-ahead lands on the unavailable Rewind, so its reason is heard");
  await act(async () => { (document.activeElement as HTMLElement).click(); });
  assert.equal(trigger.getAttribute("aria-expanded"), "true", "choosing it does nothing");
  await key(document.activeElement!, "Escape");
  assert.equal(trigger.getAttribute("aria-expanded"), "false", "Escape still closes the menu");
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

/** A Clipboard API whose writes stay pending until the test settles them. */
function deferredClipboard() {
  const writes: Array<{ text: string; resolve: () => void }> = [];
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => new Promise<void>((resolve) => { writes.push({ text, resolve }); }) },
  });
  return {
    writes,
    succeed: async () => { await act(async () => { writes.at(-1)!.resolve(); await Promise.resolve(); }); },
    restore: () => {
      if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
      else delete (domWindow.navigator as unknown as { clipboard?: unknown }).clipboard;
    },
  };
}

/** Open More Turn Actions and choose `label`; returns the trigger. */
async function chooseTurnAction(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More Turn Actions"]')!;
  await act(async () => { trigger.click(); });
  const item = [...document.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((candidate) => candidate.dataset.menuLabel === label)!;
  await act(async () => { item.click(); });
  return trigger;
}

test("a Copy Response write that succeeds after the transcript unmounted shows no toast and moves no focus (#3582)", async () => {
  coarsePointer = false;
  const clipboard = deferredClipboard();
  const { container, toasts, unmount } = await mount();
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    await chooseTurnAction(container, "Copy Response");
    assert.equal(clipboard.writes.length, 1, "the copy started");
    await unmount();
    await act(async () => { elsewhere.focus(); });
    await clipboard.succeed();
    assert.deepEqual(toasts, [], "no toast for a menu that has gone");
    assert.ok(document.activeElement === elsewhere, "focus stays where the person put it");
  } finally {
    elsewhere.remove();
    clipboard.restore();
  }
});

test("a Copy Response write that succeeds while the menu's trigger is still shown says so and leaves focus there (#3582)", async () => {
  coarsePointer = false;
  const clipboard = deferredClipboard();
  const { container, toasts } = await mount();
  try {
    const trigger = await chooseTurnAction(container, "Copy Response");
    assert.ok(document.activeElement === trigger, "the copy left focus on the trigger");
    await clipboard.succeed();
    assert.deepEqual(toasts, ["Response copied."]);
    assert.ok(document.activeElement === trigger, "focus is still on the trigger");
  } finally {
    clipboard.restore();
  }
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

test("Insert into Draft appears only where a transcript supplies it, on top-level replies alone (#2862)", async () => {
  coarsePointer = false;
  const withSubagent: TimelineItem[] = [
    ...items,
    { kind: "agent_message", id: 5, text: "A subagent's note", parentToolUseId: "task-1" },
  ];
  const main = await mount({ items: withSubagent });
  assertNoDomNode(main.container.querySelector('button[aria-label="Insert into Draft"]'),
    "the main session's transcript never shows the action");

  const inserted: string[] = [];
  const side = await mount({ items: withSubagent, onInsertReply: (item) => inserted.push(item.text) });
  const inserts = [...side.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Insert into Draft"]')];
  assert.equal(inserts.length, 1, "a subagent's reply is not the agent's answer, so it has none");
  await act(async () => { inserts[0]!.click(); });
  assert.deepEqual(inserted, ["## Result\n\nThe **answer** is [here](https://example.test).\n\n- one\n- two"],
    "the reply's own source text");
});
