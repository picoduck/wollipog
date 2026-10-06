import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { sessionAttentionBreakdown, type PendingApproval, type SessionView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/session/status", width: 1440, height: 900 });
for (const [name, value] of Object.entries({
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
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const approval: PendingApproval = { requestId: "approval-1", title: "Run the tests", options: [], kind: "permission" };
const question: PendingApproval = { requestId: "question-1", title: "Which branch?", options: [], kind: "question" };

interface Opened {
  attention: number;
  background: number;
  workers: number;
  requests: number;
  /** Where focus was when Background Work was opened: what a panel records as its opener. */
  focusAtBackground?: Element | null;
}

function body(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

async function renderHeader(
  overrides: Partial<SessionView>,
  options: { runnerOnline?: boolean; workers?: number; childRequests?: number } = {},
): Promise<{ root: Root; opened: Opened; rerender: (next: Partial<SessionView>) => Promise<void> }> {
  const opened: Opened = { attention: 0, background: 0, workers: 0, requests: 0 };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const draw = (next: Partial<SessionView>) => {
    const session = { id: "status", runnerId: "runner-1", title: "Status", status: "idle", ...next } as SessionView;
    root.render(
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
            runnerOnline={options.runnerOnline ?? true}
            runnerProtocolVersion={85}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady
            activeSubagents={options.workers
              ? { count: options.workers, workers: true, onOpen: () => { opened.workers += 1; } }
              : undefined}
            onOpenAttention={() => { opened.attention += 1; }}
            childRequests={{ count: options.childRequests ?? 0, onOpen: () => { opened.requests += 1; } }}
            onOpenBackgroundWork={() => {
              opened.background += 1;
              opened.focusAtBackground = domWindow.document.activeElement as unknown as Element | null;
            }}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  };
  await act(async () => { draw(overrides); });
  return { root, opened, rerender: async (next) => { await act(async () => { draw(next); }); } };
}

async function cleanUp(root: Root) {
  await act(async () => { root.unmount(); });
  domWindow.document.body.innerHTML = "";
  await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
}

function trigger(): HTMLButtonElement {
  const match = body().querySelector<HTMLButtonElement>("header.session-bar .session-status-button");
  assert.ok(match, "the bar has its Session Status control");
  return match;
}

/** The badges drawn in the bar itself; an open popover is portalled to <body>, outside it. */
function barBadges(): string[] {
  return [...body().querySelectorAll("header.session-bar .status")].map((badge) => badge.textContent ?? "");
}

function popover(): HTMLElement | null {
  return body().querySelector<HTMLElement>('[role="dialog"][aria-label="Session Status"]');
}

function rowButton(label: string): HTMLButtonElement {
  const match = [...popover()!.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label);
  assert.ok(match, `missing row action: ${label}`);
  return match;
}

test("an approval and an answer request show the breakdown's first kind with +1", async () => {
  const pendingApproval = { ...question, additionalRequests: [approval] };
  const { root } = await renderHeader({ status: "input_required", pendingApproval });
  try {
    const first = sessionAttentionBreakdown({ status: "input_required", pendingApproval })[0]!.label;
    assert.deepEqual(barBadges(), [first], "exactly one status badge is drawn in the bar");
    assert.equal(trigger().querySelector(".session-status-more")?.textContent, "+1");
    assert.equal(trigger().getAttribute("aria-label"), `Session Status: ${first} and 1 More`);
    assert.equal(trigger().getAttribute("aria-haspopup"), "dialog");
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.match(trigger().className, /\bbtn ghost\b/, "the control is a ghost button, not a pill");
  } finally {
    await cleanUp(root);
  }
});

test("8 human-owned and 4 Orchestrator-owned child requests are one 8 Child Requests condition that opens the Requests panel (#2206)", async () => {
  const { root, opened } = await renderHeader({
    status: "running",
    orchestratorCampaign: { pendingRequests: { human: 8, orchestrator: 4 } } as SessionView["orchestratorCampaign"],
  }, { childRequests: 8 });
  try {
    assert.deepEqual(barBadges(), ["8 Child Requests"], "one status, and no other request badge");
    assert.match(trigger().querySelector(".status")?.className ?? "", /\bt-warning\b/u);
    assert.equal(trigger().getAttribute("aria-label"), "Session Status: 8 Child Requests");
    await act(async () => { trigger().click(); });
    const rows = [...popover()!.querySelectorAll(".session-status-row")];
    assert.deepEqual(rows.map((row) => row.querySelector(".status")?.textContent), ["8 Child Requests"]);
    assert.equal(rows[0]!.querySelector(".session-status-text")?.textContent,
      "8 requests from child sessions need your input.");
    assert.doesNotMatch(popover()!.textContent ?? "", /Orchestrator Action|Descendant Requests|Needs Your Input/u);
    await act(async () => { rowButton("Open Requests").click(); });
    assert.equal(opened.requests, 1);
    assert.equal(opened.attention, 0);
  } finally {
    await cleanUp(root);
  }
});

test("child requests outside a campaign are counted from the descendant poll, and none shows no condition (#2206)", async () => {
  let rendered = await renderHeader({ status: "running" }, { childRequests: 3 });
  try {
    assert.deepEqual(barBadges(), ["3 Child Requests"]);
  } finally {
    await cleanUp(rendered.root);
  }
  rendered = await renderHeader({
    status: "running",
    orchestratorCampaign: { pendingRequests: { human: 0, orchestrator: 4 } } as SessionView["orchestratorCampaign"],
  });
  try {
    assert.deepEqual(barBadges(), ["Running"], "the Orchestrator's own requests are counted only in the panel");
  } finally {
    await cleanUp(rendered.root);
  }
});

test("an idle session shows Waiting on External Job while background work runs, else Awaiting Prompt", async () => {
  for (const [backgroundWorkState, label] of [["running", "Waiting on External Job"], [undefined, "Awaiting Prompt"]] as const) {
    const { root } = await renderHeader({ backgroundWorkState });
    try {
      assert.deepEqual(barBadges(), [label]);
      assertNoDomNode(trigger().querySelector(".session-status-more"), "nothing else needs the person");
      assert.equal(trigger().getAttribute("aria-label"), `Session Status: ${label}`);
    } finally {
      await cleanUp(root);
    }
  }
});

test("lost background work and an offline machine show their own badge when nothing needs the person", async () => {
  let rendered = await renderHeader({ backgroundWorkState: "orphaned" });
  try {
    assert.deepEqual(barBadges(), ["Background Work Lost"]);
  } finally {
    await cleanUp(rendered.root);
  }
  rendered = await renderHeader({ status: "running" }, { runnerOnline: false });
  try {
    assert.deepEqual(barBadges(), ["Disconnected"]);
  } finally {
    await cleanUp(rendered.root);
  }
});

test("background work changes are still announced, as text rather than a second badge", async () => {
  const { root } = await renderHeader({ status: "running", backgroundWorkState: "running" });
  try {
    const live = body().querySelector('header.session-bar [role="status"][data-live="background-work"]');
    assert.equal(live?.textContent, "Background Work: Waiting on External Job");
    assert.equal(live?.getAttribute("aria-live"), "polite");
    assert.deepEqual(barBadges(), ["Running"]);
  } finally {
    await cleanUp(root);
  }
});

test("the popover is titled Session Status and lists each condition with its sentence and action", async () => {
  const { root, opened } = await renderHeader(
    { status: "input_required", pendingApproval: { ...approval, additionalRequests: [question] }, backgroundWorkState: "running" },
    { workers: 2 },
  );
  try {
    await act(async () => { trigger().click(); });
    const dialog = popover();
    assert.ok(dialog, "the popover opens as a dialog");
    assert.equal(trigger().getAttribute("aria-expanded"), "true");
    assert.equal(trigger().getAttribute("aria-controls"), dialog.id);
    assert.equal(dialog.querySelector(".session-status-head")?.textContent, "Session Status");
    const rows = [...dialog.querySelectorAll(".session-status-row")].map((row) => ({
      badge: row.querySelector(".status")?.textContent,
      action: row.querySelector("button")?.textContent,
      sentence: row.querySelector(".session-status-text")?.textContent,
    }));
    assert.deepEqual(rows.map((row) => [row.badge, row.action]), [
      ...sessionAttentionBreakdown({ status: "input_required", pendingApproval: { ...approval, additionalRequests: [question] } })
        .map((group) => [group.label, group.label === "Answer Required" ? "Answer" : "Review Request"]),
      ["Waiting on External Job", "Open"],
      ["2 Workers", "Open Agents"],
    ], "lifecycle is not listed while something needs the person");
    assert.ok(rows.every((row) => /\.$/.test(row.sentence ?? "")), "every row says what it means");

    await act(async () => { rowButton("Open Background Work").click(); });
    assert.equal(opened.background, 1);
    assertNoDomNode(popover(), "running an action closes the popover");

    await act(async () => { trigger().click(); });
    await act(async () => { rowButton("Open Agents").click(); });
    assert.equal(opened.workers, 1);
    assertNoDomNode(popover());

    await act(async () => { trigger().click(); });
    await act(async () => { rowButton("Review Request").click(); });
    assert.equal(opened.attention, 1, "Review Request opens the request through the bar's attention entry point");
    assertNoDomNode(popover());
  } finally {
    await cleanUp(root);
  }
});

test("Escape closes the popover and returns focus to the trigger", async () => {
  const { root } = await renderHeader({});
  try {
    await act(async () => { trigger().click(); });
    const dialog = popover()!;
    assert.ok(domWindow.document.activeElement === (dialog as never),
      "with nothing to act on, the popover holds focus itself");
    assert.deepEqual([...dialog.querySelectorAll(".session-status-row .status")].map((badge) => badge.textContent),
      ["Awaiting Prompt"], "the lifecycle is listed when nothing needs the person");
    await act(async () => {
      dialog.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assertNoDomNode(popover());
    assert.ok(domWindow.document.activeElement === (trigger() as never));
  } finally {
    await cleanUp(root);
  }
});

test("queue reasons are popover rows, not badges", async () => {
  const { root } = await renderHeader({
    status: "queued",
    capacityWait: { kind: "runner_capacity", description: "Waiting for a free runner slot." },
  } as Partial<SessionView>);
  try {
    assert.deepEqual(barBadges(), ["Queued"]);
    await act(async () => { trigger().click(); });
    const fact = popover()!.querySelector(".session-status-fact");
    assert.equal(fact?.textContent, "Runner Capacity");
    assertNoDomNode(fact?.closest(".session-status-row")?.querySelector(".status"));
  } finally {
    await cleanUp(root);
  }
});

test("a compact dot does not outlive the compact tier: a phone shows the whole badge again", async () => {
  const { root, rerender } = await renderHeader({ status: "running" });
  try {
    // Stand in for a dot the compact tier measured; the same button stays mounted on a phone.
    trigger().setAttribute("data-dot", "");
    trigger().title = "Running";
    await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
    await rerender({ status: "running" });
    assert.equal(trigger().hasAttribute("data-dot"), false);
    assert.equal(trigger().hasAttribute("title"), false);
    assert.match(trigger().className, /\bbtn sm ghost\b/, "the phone line's small size");
  } finally {
    await cleanUp(root);
  }
});

test("a live update keeps the focused action of a row that stays", async () => {
  const before = { status: "input_required", pendingApproval: approval, backgroundWorkState: "running" } as Partial<SessionView>;
  const { root, rerender } = await renderHeader(before);
  try {
    await act(async () => { trigger().click(); });
    const open = rowButton("Open Background Work");
    open.focus();
    // The approval is answered elsewhere: the row ahead of the background-work row goes away.
    await rerender({ ...before, status: "idle", pendingApproval: null });
    assert.ok(popover(), "the popover stays open");
    assert.ok(rowButton("Open Background Work") === open, "the row kept its element");
    assert.ok(domWindow.document.activeElement === (open as never));
  } finally {
    await cleanUp(root);
  }
});

test("focus lost with its row returns to the popover, so Escape still closes it", async () => {
  const before = { status: "input_required", pendingApproval: approval, backgroundWorkState: "running" } as Partial<SessionView>;
  const { root, rerender } = await renderHeader(before);
  try {
    await act(async () => { trigger().click(); });
    rowButton("Open Background Work").focus();
    await rerender({ ...before, backgroundWorkState: "resumed" });
    const dialog = popover()!;
    assert.ok(domWindow.document.activeElement === (dialog as never), "focus is back inside the dialog");
    await act(async () => {
      dialog.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    assertNoDomNode(popover());
    assert.ok(domWindow.document.activeElement === (trigger() as never));
  } finally {
    await cleanUp(root);
  }
});

test("running an action leaves focus on the trigger, so a panel it opens can return there", async () => {
  const { root, opened } = await renderHeader({ status: "running", backgroundWorkState: "running" });
  try {
    await act(async () => { trigger().click(); });
    const open = rowButton("Open Background Work");
    open.focus();
    // A panel records document.activeElement as its opener in the commit that unmounts this row, so
    // the row's own button (about to be removed) must not be what it finds.
    await act(async () => { open.click(); });
    assertNoDomNode(popover());
    assert.equal(opened.background, 1);
    assert.ok(opened.focusAtBackground === (trigger() as never), "the opener is the durable trigger");
    assert.ok(domWindow.document.activeElement === (trigger() as never), "focus stays on the trigger, not <body>");
  } finally {
    await cleanUp(root);
  }
});

test("a counted row says its count in words, not only as a hidden numeral", async () => {
  const pendingApproval = {
    ...question,
    additionalRequests: [approval, { ...approval, requestId: "approval-2" }],
  };
  const { root } = await renderHeader({ status: "input_required", pendingApproval });
  try {
    await act(async () => { trigger().click(); });
    const counted = [...popover()!.querySelectorAll(".session-status-row .status")]
      .find((badge) => badge.textContent?.startsWith("Approval Required"));
    assert.ok(counted, "the approval row is listed");
    const spoken = [...counted.childNodes]
      .filter((node) => (node as unknown as Element).getAttribute?.("aria-hidden") !== "true")
      .map((node) => node.textContent).join("");
    assert.equal(spoken, "Approval Required, 2 Requests");
  } finally {
    await cleanUp(root);
  }
});
