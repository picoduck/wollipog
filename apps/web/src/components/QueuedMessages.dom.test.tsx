import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { QueuedPromptView } from "@wollipog/protocol";
import type { ConversationSteeringAvailabilityInput } from "../conversation-steering.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { QueuedMessages, queuedMessageExcerpt, queuedMessageLabel, type QueuedMessagesProps } from "./QueuedMessages.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
let phone = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: query === "(max-width: 760px)" ? phone : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
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

/** A running turn on a current, online runner whose agent steers. */
const STEERING: ConversationSteeringAvailabilityInput = {
  runnerProtocolVersion: 200,
  runnerOnline: true,
  sessionStatus: "running",
  activeTurnId: "turn-1",
  supportsSteering: true,
  policyPaused: false,
  inputPending: false,
  queueHeld: false,
  stopPending: false,
};

function queued(id: string, overrides: Partial<QueuedPromptView> = {}): QueuedPromptView {
  return {
    id,
    text: `Message ${id}`,
    steerable: true,
    liveQueueObserved: true,
    editable: true,
    editRevision: "r1",
    ...overrides,
  };
}

interface Calls { steer: string[]; edit: string[]; cancel: string[]; dismiss: string[] }

async function render(overrides: Partial<QueuedMessagesProps>) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const calls: Calls = { steer: [], edit: [], cancel: [], dismiss: [] };
  const props = (next: Partial<QueuedMessagesProps>): QueuedMessagesProps => ({
    sessionId: "session-1",
    prompts: [],
    queueHeld: false,
    agent: "Claude Code",
    steering: STEERING,
    requestBusy: false,
    refusal: null,
    steeringPending: new Set(),
    editingPromptId: null,
    editOpen: false,
    pendingAction: undefined,
    onSteer: (prompt) => calls.steer.push(prompt.id),
    onEdit: (prompt) => calls.edit.push(prompt.id),
    onCancel: (prompt) => calls.cancel.push(prompt.id),
    onDismiss: (prompt) => calls.dismiss.push(prompt.id),
    ...overrides,
    ...next,
  });
  const draw = (next: Partial<QueuedMessagesProps> = {}) => act(async () => {
    root.render(<QueuedMessages {...props(next)} />);
  });
  await draw();
  return {
    container,
    calls,
    draw,
    summary: () => container.querySelector(".queue-summary") as HTMLButtonElement | null,
    notes: () => [...container.querySelectorAll(".queue-note")].map((note) => note.textContent),
    row: (id: string) => container.querySelector(`[data-testid="queued-prompt-${id}"]`) as HTMLElement,
    button: (scope: ParentNode, name: string) =>
      scope.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement | null,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("two ordinary queued messages read 2 Queued Messages and carry no status badge", async () => {
  const tray = await render({ prompts: [queued("a"), queued("b")] });
  try {
    assert.equal(tray.container.querySelector(".queue-count")?.textContent, "2 Queued Messages");
    assert.equal(tray.container.querySelector("section.queue")?.getAttribute("aria-label"), "Queued Messages");
    assertNoDomNode(tray.container.querySelector(".queue-rows .status"), "an ordinary row has no badge");
    assert.deepEqual(tray.notes(), [], "nothing is shared to explain");
    for (const id of ["a", "b"]) {
      const row = tray.row(id);
      assert.equal(row.querySelector(".queue-text")?.textContent, `Message ${id}`);
      assert.equal(tray.button(row, "Steer Queued Message")?.disabled, false, "each eligible row shows Steer");
      assert.equal(tray.button(row, "Edit Queued Message")?.disabled, false);
      assert.equal(tray.button(row, "Cancel Queued Message")?.disabled, false);
    }
    tray.button(tray.row("b"), "Steer Queued Message")!.click();
    tray.button(tray.row("a"), "Edit Queued Message")!.click();
    tray.button(tray.row("b"), "Cancel Queued Message")!.click();
    assert.deepEqual(tray.calls, { steer: ["b"], edit: ["a"], cancel: ["b"], dismiss: [] });
  } finally {
    await tray.unmount();
  }
});

test("steering unavailable for the whole session is said once, and no row offers Steer or an ⓘ", async () => {
  const tray = await render({
    prompts: [queued("a"), queued("b")],
    steering: { ...STEERING, supportsSteering: false },
  });
  try {
    assert.deepEqual(tray.notes(), ["Claude Code can't take steering mid-turn, so these send when the turn ends."]);
    assertNoDomNode(tray.button(tray.container, "Steer Queued Message"));
    assert.ok(!tray.container.textContent?.includes("ⓘ"));
    assert.ok(!tray.container.textContent?.includes("✕"));
    // Edit and Cancel do not depend on steering.
    assert.equal(tray.button(tray.row("a"), "Edit Queued Message")?.disabled, false);
    assert.equal(tray.button(tray.row("a"), "Cancel Queued Message")?.disabled, false);

    // The same reason on every row is a session fact too.
    await tray.draw({
      steering: STEERING,
      prompts: [
        queued("a", { steerable: false, steerDisabledReason: "This agent waits for the turn to end." }),
        queued("b", { steerable: false, steerDisabledReason: "This agent waits for the turn to end." }),
      ],
    });
    assert.deepEqual(tray.notes(), ["This agent waits for the turn to end."]);

    // Rows that differ keep their own reasons, visible on the row, and only the eligible row offers
    // Steer.
    await tray.draw({
      steering: STEERING,
      prompts: [queued("a", { steerable: false, steerDisabledReason: "Not this one." }), queued("b")],
    });
    assert.deepEqual(tray.notes(), []);
    assertNoDomNode(tray.button(tray.row("a"), "Steer Queued Message"));
    assert.equal(tray.row("a").querySelector(".queue-reason")?.textContent, "Not this one.");
    assert.ok(tray.button(tray.row("b"), "Steer Queued Message"));
    assertNoDomNode(tray.row("b").querySelector(".queue-reason"));
  } finally {
    await tray.unmount();
  }
});

test("a held queue shows one Held badge, on the summary line, and says why", async () => {
  const tray = await render({
    prompts: [queued("a"), queued("b"), queued("c")],
    queueHeld: true,
    steering: { ...STEERING, queueHeld: true },
  });
  try {
    const badges = [...tray.container.querySelectorAll(".status")];
    assert.deepEqual(badges.map((badge) => badge.textContent), ["Held"]);
    assert.ok(tray.summary()?.contains(badges[0]!), "the badge is on the summary line");
    assert.deepEqual(tray.notes(), [
      "Held until the current turn or a pending decision settles. Resolve any visible prompt to continue.",
    ]);
  } finally {
    await tray.unmount();
  }
});

test("only exceptions carry a status: Steering…, Pending Delivery, Delivery Uncertain and Delivery Failed", async () => {
  const tray = await render({
    prompts: [
      queued("plain"),
      queued("steering"),
      queued("durable", { durableDeliveryState: "pending", steerable: false, liveQueueObserved: false }),
      queued("uncertain", { durableDeliveryState: "uncertain", steerable: false, liveQueueObserved: false }),
      queued("failed", { durableDeliveryState: "failed", steerable: false, liveQueueObserved: false,
        durableDeliveryError: "The machine restarted." }),
    ],
    steeringPending: new Set(["steering"]),
  });
  try {
    const status = (id: string) => tray.row(id).querySelector(".status")?.textContent ?? null;
    assert.equal(status("plain"), null);
    assert.equal(status("steering"), "Steering…");
    assert.equal(status("durable"), "Pending Delivery");
    assert.equal(status("uncertain"), "Delivery Uncertain");
    assert.equal(status("failed"), "Delivery Failed");
    assert.equal(tray.container.querySelector(".queue-count")?.textContent, "5 Queued Messages");
    // The failure's reason is the notice slot's to show, not the row's.
    assert.ok(!tray.row("failed").textContent?.includes("The machine restarted."));
    // A steer in flight takes Steer away; the row says Steering… instead.
    assertNoDomNode(tray.button(tray.row("steering"), "Steer Queued Message"));
    // A settled receipt is dismissed, never canceled, and it cannot be edited or resent.
    assertNoDomNode(tray.button(tray.row("failed"), "Cancel Queued Message"));
    const failedEdit = tray.button(tray.row("failed"), "Edit Queued Message")!;
    assert.equal(failedEdit.disabled, true);
    assert.equal(failedEdit.title, "Delivery attempts for this message have ended, so it cannot be steered or edited.");
    tray.button(tray.row("failed"), "Dismiss Failed Message")!.click();
    tray.button(tray.row("uncertain"), "Dismiss Uncertain Message")!.click();
    assert.deepEqual(tray.calls.dismiss, ["failed", "uncertain"]);
    // A durable entry not yet admitted cannot be canceled, and says why on its own line.
    const cancel = tray.button(tray.row("durable"), "Cancel Queued Message")!;
    assert.equal(cancel.disabled, true);
    const reasonId = cancel.getAttribute("aria-describedby")!;
    assert.equal(tray.container.querySelector(`#${reasonId}`)?.textContent,
      "This message can't be canceled until its machine accepts it.");
  } finally {
    await tray.unmount();
  }
});

test("a cancel no row can use is named Cancel Queued Message, disabled, and explained once in the header", async () => {
  const tray = await render({
    prompts: [queued("a"), queued("b")],
    steering: { ...STEERING, runnerProtocolVersion: 1 },
  });
  try {
    const cancels = ["a", "b"].map((id) => tray.button(tray.row(id), "Cancel Queued Message")!);
    assert.ok(cancels.every((cancel) => cancel.disabled));
    const ids = new Set(cancels.map((cancel) => cancel.getAttribute("aria-describedby")));
    assert.equal(ids.size, 1, "both reference the one header sentence");
    const note = tray.container.querySelector(`#${[...ids][0]}`);
    assert.ok(note?.classList.contains("queue-note"));
    assertNoDomNode(tray.container.querySelector(".queue-reason"), "no row repeats it");
  } finally {
    await tray.unmount();
  }
});

test("a Viewer sees every queue action disabled, with the refusal visible", async () => {
  const refusal = "Viewers can't manage this session's queue.";
  const tray = await render({ prompts: [queued("a"), queued("failed", { durableDeliveryState: "failed",
    steerable: false, liveQueueObserved: false })], refusal });
  try {
    const note = tray.container.querySelector(".queue-note");
    assert.equal(note?.textContent, refusal);
    const buttons = [...tray.container.querySelectorAll<HTMLButtonElement>(".queue-rows button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [
      "Steer Queued Message", "Edit Queued Message", "Cancel Queued Message",
      "Edit Queued Message", "Dismiss Failed Message",
    ]);
    for (const button of buttons) {
      assert.equal(button.disabled, true, `${button.getAttribute("aria-label")} is disabled`);
      assert.equal(button.getAttribute("aria-describedby"), note?.id);
    }
  } finally {
    await tray.unmount();
  }
});

test("an image-only message reads its image count after a paperclip; text shows its first line", async () => {
  assert.equal(queuedMessageLabel({ text: "", hasImages: true, imageCount: 1 }), "1 image");
  assert.equal(queuedMessageLabel({ text: "", hasImages: true, imageCount: 3 }), "3 images");
  assert.equal(queuedMessageLabel({ text: "Look at these", hasImages: true, imageCount: 3 }), "Look at these");
  assert.equal(queuedMessageLabel({ text: "\nFirst line\nSecond line", hasImages: false }), "First line");
  assert.equal(queuedMessageExcerpt({ text: "one two three four five six seven", hasImages: false }),
    "one two three four five six…");
  assert.equal(queuedMessageExcerpt({ text: "", hasImages: true, imageCount: 3 }), "3 images");
  const tray = await render({
    prompts: [
      queued("one", { text: "", hasImages: true, imageCount: 1 }),
      queued("three", { text: "", hasImages: true, imageCount: 3 }),
    ],
  });
  try {
    for (const [id, label] of [["one", "1 image"], ["three", "3 images"]] as const) {
      const text = tray.row(id).querySelector(".queue-text")!;
      assert.equal(text.textContent, label);
      assert.ok(text.querySelector("svg"), "a paperclip icon, not 📎");
    }
    assert.ok(!tray.container.textContent?.includes("📎"));
  } finally {
    await tray.unmount();
  }
});

test("an image-only message from an older runner or control plane, which sends no count, reads Image attachment", async () => {
  assert.equal(queuedMessageLabel({ text: "", hasImages: true }), "Image attachment");
  // A malformed count is treated as absent rather than shown.
  assert.equal(queuedMessageLabel({ text: "", hasImages: true, imageCount: -1 }), "Image attachment");
  assert.equal(queuedMessageLabel({ text: "", hasImages: true, imageCount: 1.5 }), "Image attachment");
  const tray = await render({ prompts: [queued("legacy", { text: "", hasImages: true })] });
  try {
    const text = tray.row("legacy").querySelector(".queue-text")!;
    assert.equal(text.textContent, "Image attachment");
    assert.ok(text.querySelector("svg"), "a paperclip icon, not 📎");
  } finally {
    await tray.unmount();
  }
});

test("a message whose only attachments are workspace references reads Attachment, not an image count", async () => {
  assert.equal(queuedMessageLabel({ text: "", hasImages: true, imageCount: 0 }), "Attachment");
  const tray = await render({ prompts: [queued("reference", { text: "", hasImages: true, imageCount: 0 })] });
  try {
    const text = tray.row("reference").querySelector(".queue-text")!;
    assert.equal(text.textContent, "Attachment");
    assert.ok(text.querySelector("svg"), "a paperclip icon, not 📎");
  } finally {
    await tray.unmount();
  }
});

test("on a phone each row is its text and one Queued Message Actions button whose sheet lists every action", async () => {
  phone = true;
  const tray = await render({
    prompts: [queued("a"), queued("b", { steerable: false, steerDisabledReason: "Not eligible." })],
  });
  try {
    for (const id of ["a", "b"]) {
      const buttons = [...tray.row(id).querySelectorAll("button")];
      assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), ["Queued Message Actions"]);
    }
    await act(async () => { tray.summary()!.click(); });
    await act(async () => { tray.button(tray.row("b"), "Queued Message Actions")!.click(); });
    const items = [...domWindow.document.querySelectorAll('[role="menuitem"]')] as unknown as HTMLButtonElement[];
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent),
      ["Steer into This Turn", "Edit Message", "Cancel Message"]);
    const steer = items[0]!;
    assert.equal(steer.getAttribute("aria-disabled"), "true");
    assert.equal(steer.querySelector(".menu-desc")?.textContent, "Not eligible.", "the reason is the visible second line");
    assert.equal(items[1]!.getAttribute("aria-disabled"), null);
    assert.equal(items[2]!.getAttribute("aria-disabled"), null);
    await act(async () => { steer.click(); });
    assert.deepEqual(tray.calls.steer, [], "an unavailable item does nothing");
    await act(async () => { items[1]!.click(); });
    assert.deepEqual(tray.calls.edit, ["b"]);
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "choosing closes the sheet");
  } finally {
    phone = false;
    await tray.unmount();
  }
});

test("focus in a phone row's open action sheet returns to the composer when the row leaves", async () => {
  phone = true;
  let lost = 0;
  const tray = await render({ prompts: [queued("a")], onFocusLost: () => { lost += 1; } });
  try {
    await act(async () => { tray.summary()!.click(); });
    await act(async () => { tray.button(tray.row("a"), "Queued Message Actions")!.click(); });
    const item = domWindow.document.querySelector('[role="menuitem"]') as unknown as HTMLButtonElement;
    await act(async () => { item.focus(); });
    assert.equal(domWindow.document.activeElement, item as never);
    // The runner takes the message while its sheet is open.
    await tray.draw({ prompts: [], onFocusLost: () => { lost += 1; } });
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    assert.equal(lost, 1, "the tray hands focus on once");
  } finally {
    phone = false;
    await tray.unmount();
  }
});

test("an empty queue renders nothing", async () => {
  const tray = await render({ prompts: [] });
  try {
    assert.equal(tray.container.innerHTML, "");
  } finally {
    await tray.unmount();
  }
});

test("the tray starts as one collapsed summary that names its count and controls the hidden rows (#2788)", async () => {
  const tray = await render({ prompts: [queued("a")], steering: { ...STEERING, supportsSteering: false } });
  try {
    const summary = tray.summary()!;
    assert.equal(summary.tagName, "BUTTON");
    assert.equal(summary.textContent, "1 Queued Message");
    assert.equal(summary.getAttribute("aria-expanded"), "false");
    const rows = tray.container.querySelector(`#${summary.getAttribute("aria-controls")}`) as HTMLElement;
    assert.ok(rows.classList.contains("queue-rows"), "the summary controls the row list");
    assert.equal(rows.hidden, true, "rows are hidden, so none of their controls can take focus");
    assert.equal((tray.container.querySelector(".queue-notes") as HTMLElement).hidden, true,
      "the explanation waits with the rows");

    await act(async () => { summary.click(); });
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    assert.equal(rows.hidden, false);
    assert.equal((tray.container.querySelector(".queue-notes") as HTMLElement).hidden, false);
    assert.equal(tray.row("a").querySelector(".queue-text")?.textContent, "Message a");

    await act(async () => { summary.click(); });
    assert.equal(summary.getAttribute("aria-expanded"), "false");
    assert.equal(rows.hidden, true);
    assert.deepEqual(tray.calls, { steer: [], edit: [], cancel: [], dismiss: [] }, "toggling changes no message");
  } finally {
    await tray.unmount();
  }
});

test("the collapsed summary carries Held and the most severe row status, which expanding leaves to the rows", async () => {
  const tray = await render({
    prompts: [
      queued("plain"),
      queued("uncertain", { durableDeliveryState: "uncertain", steerable: false, liveQueueObserved: false }),
      queued("failed", { durableDeliveryState: "failed", steerable: false, liveQueueObserved: false }),
    ],
    queueHeld: true,
    steering: { ...STEERING, queueHeld: true },
  });
  const badges = () => [...tray.summary()!.querySelectorAll(".status")].map((badge) => badge.textContent);
  try {
    assert.deepEqual(badges(), ["Held", "Delivery Failed"]);
    assert.equal(tray.summary()?.textContent, "3 Queued MessagesHeldDelivery Failed");
    await tray.draw({
      prompts: [
        queued("plain", { steeringState: "promoting" }),
        queued("uncertain", { durableDeliveryState: "uncertain", steerable: false, liveQueueObserved: false }),
      ],
      queueHeld: false,
      steering: STEERING,
    });
    assert.deepEqual(badges(), ["Delivery Uncertain"], "Steering… is not an exception the summary raises");
    await act(async () => { tray.summary()!.click(); });
    assert.deepEqual(badges(), [], "expanded, each row carries its own status");
    assert.equal(tray.row("uncertain").querySelector(".status")?.textContent, "Delivery Uncertain");
  } finally {
    await tray.unmount();
  }
});

test("arrivals, removals and status changes update the count but keep the person's choice", async () => {
  const tray = await render({ prompts: [queued("a")] });
  try {
    await tray.draw({ prompts: [queued("a"), queued("b"), queued("c")] });
    assert.equal(tray.summary()?.textContent, "3 Queued Messages");
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "false", "an arrival does not open the tray");
    await tray.draw({ prompts: [queued("a"), queued("b", { durableDeliveryState: "failed", steerable: false })] });
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "false", "a failure does not open the tray");

    await act(async () => { tray.summary()!.click(); });
    await tray.draw({ prompts: [queued("b", { durableDeliveryState: "failed", steerable: false })] });
    assert.equal(tray.summary()?.textContent, "1 Queued Message");
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "true", "a removal does not close it");
    // An empty queue has no summary row; the next arrival finds the tray as the person left it.
    await tray.draw({ prompts: [] });
    assertNoDomNode(tray.summary());
    await tray.draw({ prompts: [queued("d")] });
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "true");
  } finally {
    await tray.unmount();
  }
});

test("another session starts collapsed", async () => {
  const tray = await render({ prompts: [queued("a")] });
  try {
    await act(async () => { tray.summary()!.click(); });
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "true");
    await tray.draw({ sessionId: "session-2", prompts: [queued("x")] });
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "false");
    assert.equal(tray.summary()?.getAttribute("aria-controls"), "queued-rows-session-2");
  } finally {
    await tray.unmount();
  }
});

test("collapsing on a phone closes a row's open action sheet and returns its focus to the summary", async () => {
  phone = true;
  let lost = 0;
  const tray = await render({ prompts: [queued("a")], onFocusLost: () => { lost += 1; } });
  try {
    await act(async () => { tray.summary()!.click(); });
    await act(async () => { tray.button(tray.row("a"), "Queued Message Actions")!.click(); });
    const item = domWindow.document.querySelector('[role="menuitem"]') as unknown as HTMLButtonElement;
    await act(async () => { item.focus(); });
    // A screen reader's cursor can reach the summary without dismissing the sheet first.
    await act(async () => { tray.summary()!.click(); });
    assert.equal(tray.summary()?.getAttribute("aria-expanded"), "false");
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "the sheet closes with its row");
    assert.ok((domWindow.document.activeElement as unknown) === tray.summary(), "focus is on the summary");
    assert.equal(lost, 0);
    assert.deepEqual(tray.calls, { steer: [], edit: [], cancel: [], dismiss: [] });
  } finally {
    phone = false;
    await tray.unmount();
  }
});

test("collapsing returns focus held in a row to the summary and keeps the row being edited", async () => {
  let lost = 0;
  const tray = await render({ prompts: [queued("a"), queued("b")], onFocusLost: () => { lost += 1; } });
  try {
    await act(async () => { tray.summary()!.click(); });
    const edit = tray.button(tray.row("b"), "Edit Queued Message")!;
    await act(async () => { edit.focus(); });
    await tray.draw({ editingPromptId: "b", editOpen: true, onFocusLost: () => { lost += 1; } });
    await act(async () => { tray.summary()!.click(); });
    assert.ok((domWindow.document.activeElement as unknown) === tray.summary(), "focus is on the summary");
    assert.equal(lost, 0, "focus never fell to the page, so the composer is not asked to take it");
    await act(async () => { tray.summary()!.click(); });
    assert.equal(tray.row("b").getAttribute("aria-current"), "true", "the edit survives the collapse");
    assert.equal(tray.button(tray.row("a"), "Edit Queued Message")?.disabled, true,
      "a collapse lifts no restriction");
  } finally {
    await tray.unmount();
  }
});
