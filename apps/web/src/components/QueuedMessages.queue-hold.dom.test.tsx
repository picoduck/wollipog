import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  queueHoldReason,
  type QueueHoldReleaseResponse,
  type QueuedPromptView,
  type SessionQueueHoldView,
  type SessionView,
} from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ConversationSteeringAvailabilityInput } from "../conversation-steering.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { QUEUE_HOLD_RELEASED, queueHoldReleaseOutcome, queueHoldTrayView } from "../queue-hold-release.js";
import { FeedbackContext, FeedbackProvider, type ConfirmationOptions } from "./FeedbackProvider.js";
import { QueuedMessages, type QueuedMessagesProps } from "./QueuedMessages.js";

const domWindow = new Window({ url: "http://localhost/" });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
const globals: Record<string, unknown> = {
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
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);
before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

const STEERING: ConversationSteeringAvailabilityInput = {
  runnerProtocolVersion: 244,
  runnerOnline: true,
  sessionStatus: "queued",
  activeTurnId: undefined,
  supportsSteering: true,
  policyPaused: false,
  inputPending: false,
  queueHeld: false,
  stopPending: false,
};

const SINCE = Date.UTC(2026, 9, 28, 9, 0);

function hold(overrides: Partial<SessionQueueHoldView> = {}): SessionQueueHoldView {
  return {
    kind: "worktree_rebind",
    holdId: `worktree-rebind:${SINCE}`,
    since: SINCE,
    target: "/home/dev/worktrees/issue-3752",
    queuedPrompts: 2,
    unfinishedBackgroundJobs: 1,
    oldestUnfinishedJob: { launchType: "monitor", startedAt: SINCE - 30 * 60_000 },
    canStopJobs: true,
    canRelease: true,
    ...overrides,
  };
}

const HOLD_REASON = "The 2 queued messages cannot start: the provider must first move to worktree " +
  "/home/dev/worktrees/issue-3752, and that handoff waits for 1 background job with no terminal status.";

type HeldSession = Pick<SessionView, "status" | "capacityWait" | "queueHold" | "holds" | "commandPermissions">;

function heldSession(overrides: Partial<HeldSession> = {}): HeldSession {
  const queueHold = overrides.queueHold ?? hold();
  return {
    status: "queued",
    queueHold,
    holds: [{ kind: "worktree_rebind", holdId: queueHold.holdId, since: SINCE, reason: HOLD_REASON, recoveryAction: "Wait." }],
    commandPermissions: {
      stop: { allowed: true },
      restart: { allowed: true },
      stopBackgroundJob: { allowed: true },
    } as SessionView["commandPermissions"],
    ...overrides,
  };
}

const PROMPTS: QueuedPromptView[] = [
  { id: "q1", text: "Run the tests again", steerable: false, liveQueueObserved: true },
  { id: "q2", text: "Then open the pull request", steerable: false, liveQueueObserved: true },
];

/** Renders the tray for a held session with a recording confirmation that answers `answer`. */
async function mountTray(session: HeldSession, client: Partial<ApiClient> = {}, answer = true, runnerOnline = true) {
  const confirmations: ConfirmationOptions[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const props = (next: HeldSession): QueuedMessagesProps => ({
    sessionId: "session-held",
    prompts: PROMPTS,
    queueHeld: false,
    queueHold: queueHoldTrayView(next, runnerOnline),
    agent: "Claude Code",
    steering: STEERING,
    requestBusy: false,
    refusal: null,
    steeringPending: new Set(),
    editingPromptId: null,
    editOpen: false,
    pendingAction: undefined,
    onSteer: () => undefined,
    onEdit: () => undefined,
    onCancel: () => undefined,
    onDismiss: () => undefined,
  });
  const render = (next: HeldSession) => act(async () => root.render(
    <React.StrictMode><ApiProvider client={client as ApiClient}>
      <FeedbackContext.Provider value={{
        confirm: async (options) => { confirmations.push(options); return answer; },
        showToast: () => 1,
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <QueuedMessages {...props(next)} />
      </FeedbackContext.Provider>
    </ApiProvider></React.StrictMode>,
  ));
  await render(session);
  return {
    container,
    confirmations,
    render,
    line: () => container.querySelector(".queue-hold"),
    proceed: () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Proceed Now…") ?? null,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a releasable handoff hold shows its reason and Proceed Now… under the collapsed summary (#3752)", async () => {
  const tray = await mountTray(heldSession());
  try {
    const summary = tray.container.querySelector(".queue-summary")!;
    assert.equal(summary.getAttribute("aria-expanded"), "false", "the tray is still collapsed");
    const line = tray.line();
    assert.ok(line, "the hold line shows");
    assert.ok(!line!.closest("[hidden]"), "the hold line is not hidden with the rows");
    assert.ok(summary.nextElementSibling === line, "it sits right under the summary");
    assert.equal(line!.querySelector(".queue-note")?.textContent, HOLD_REASON);
    const proceed = tray.proceed();
    assert.ok(proceed, "Proceed Now… is offered");
    assert.ok(proceed!.classList.contains("btn") && proceed!.classList.contains("sm"));
    assert.ok(!proceed!.disabled);
    const reasonId = line!.querySelector(".queue-note")!.id;
    assert.equal(proceed!.getAttribute("aria-describedby"), reasonId, "the reason describes the button");
    await act(async () => (summary as HTMLButtonElement).click());
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    assert.ok(tray.proceed(), "expanded, it still shows");
  } finally {
    await tray.dispose();
  }
});

test("without a reason from the control plane the hold reads the protocol's sentence", async () => {
  const tray = await mountTray(heldSession({ holds: [] }));
  try {
    assert.equal(tray.line()?.querySelector(".queue-note")?.textContent, queueHoldReason(hold()));
  } finally {
    await tray.dispose();
  }
});

test("a Viewer reads the reason but is not offered Proceed Now… (#3752, #1857)", async () => {
  const tray = await mountTray(heldSession({
    commandPermissions: {
      stop: { allowed: false, reason: "Viewers cannot stop sessions." },
      restart: { allowed: false, reason: "Viewers cannot restart sessions." },
      stopBackgroundJob: { allowed: false, reason: "Viewers cannot stop background jobs." },
    } as SessionView["commandPermissions"],
  }));
  try {
    assert.equal(tray.line()?.querySelector(".queue-note")?.textContent, HOLD_REASON);
    assertNoDomNode(tray.proceed(), "no Proceed Now… for a Viewer");
    assert.ok(!(tray.container.textContent ?? "").includes("Proceed Now"));
  } finally {
    await tray.dispose();
  }
});

test("a hold the runner cannot release (no canRelease) offers no Proceed Now… (#3752)", async () => {
  const { canRelease: _canRelease, ...older } = hold();
  const tray = await mountTray(heldSession({ queueHold: older }));
  try {
    assert.ok(tray.line(), "the reason still shows");
    assertNoDomNode(tray.proceed(), "nothing to release with");
  } finally {
    await tray.dispose();
  }
});

test("an offline runner keeps Proceed Now… disabled, with its reason as visible text", async () => {
  const tray = await mountTray(heldSession(), {}, true, false);
  try {
    const proceed = tray.proceed()!;
    assert.ok(proceed.disabled);
    const reason = domWindow.document.getElementById(proceed.getAttribute("aria-describedby")!);
    assert.equal(reason?.textContent, "The runner is offline.");
  } finally {
    await tray.dispose();
  }
});

test("no hold line for a session that is not held behind a handoff", async () => {
  for (const session of [
    heldSession({ status: "running" }),
    heldSession({ queueHold: undefined }),
    heldSession({ capacityWait: { kind: "runner_capacity" } as SessionView["capacityWait"] }),
  ]) {
    const tray = await mountTray(session);
    try {
      assertNoDomNode(tray.line());
    } finally {
      await tray.dispose();
    }
  }
});

test("Proceed Now opens the danger confirmation, then releases exactly the hold that was shown (#3752)", async () => {
  const releases: Array<[string, string]> = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const client = {
    releaseQueueHold: async (sessionId: string, holdId: string): Promise<QueueHoldReleaseResponse> => {
      releases.push([sessionId, holdId]);
      return { sessionId, holdId, outcome: "released", jobIds: ["job-monitor-1"] };
    },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <QueuedMessages sessionId="session-held" prompts={PROMPTS} queueHeld={false}
            queueHold={queueHoldTrayView(heldSession(), true)} agent="Claude Code" steering={STEERING}
            requestBusy={false} refusal={null} steeringPending={new Set()} editingPromptId={null} editOpen={false}
            pendingAction={undefined} onSteer={() => undefined} onEdit={() => undefined} onCancel={() => undefined}
            onDismiss={() => undefined} />
        </FeedbackProvider>
      </ApiProvider>,
    ));
    const proceed = [...container.querySelectorAll<HTMLButtonElement>(".queue-hold button")]
      .find((button) => button.textContent === "Proceed Now…")!;
    await act(async () => proceed.click());
    const dialog = domWindow.document.querySelector('[role="alertdialog"], [role="dialog"]') as unknown as HTMLElement | null;
    assert.ok(dialog, "a confirmation opens");
    const text = dialog!.textContent ?? "";
    assert.ok(text.includes("Proceed Now"), "titled Proceed Now");
    assert.ok(text.includes(queueHoldReleaseOutcome(hold())), "says what proceeding does");
    assert.equal(domWindow.document.activeElement?.textContent, "Cancel", "Cancel has initial focus");
    assert.deepEqual(releases, [], "nothing is released before confirming");
    const buttons = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent);
    assert.ok(buttons.includes("Cancel") && buttons.includes("Proceed Now"));
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Proceed Now")!;
    assert.ok(confirm.classList.contains("danger"));
    await act(async () => confirm.click());
    await flush();
    assert.deepEqual(releases, [["session-held", `worktree-rebind:${SINCE}`]], "the shown hold's id, once");
    assert.equal(container.querySelector(".queue-hold [role='status']")?.textContent, QUEUE_HOLD_RELEASED);
    assertNoDomNode(container.querySelector(".queue-hold button"), "nothing left to release");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the confirmation names the account switch and a single queued message", () => {
  assert.equal(
    queueHoldReleaseOutcome({ kind: "provider_account_switch", queuedPrompts: 1 }),
    "Every unfinished background job in this session ends and is recorded as killed, and the conversation keeps " +
      "running. Then the session switches to the selected provider account and the queued message runs.",
  );
  assert.equal(
    queueHoldReleaseOutcome({ kind: "worktree_rebind", queuedPrompts: 2 }),
    "Every unfinished background job in this session ends and is recorded as killed, and the conversation keeps " +
      "running. Then the session moves to the selected worktree and the 2 queued messages run in order.",
  );
});

test("while releasing the button is busy; a refusal shows the server's sentence and can be retried (#3752)", async () => {
  let finish!: (value: QueueHoldReleaseResponse) => void;
  const refusal = "A turn started while you were confirming, so nothing was ended. Try again once it finishes.";
  const answers: Array<() => Promise<QueueHoldReleaseResponse>> = [
    async () => { throw new Error(refusal); },
    () => new Promise<QueueHoldReleaseResponse>((resolve) => { finish = resolve; }),
  ];
  const calls: string[] = [];
  const tray = await mountTray(heldSession(), {
    releaseQueueHold: (_sessionId: string, holdId: string) => { calls.push(holdId); return answers.shift()!(); },
  } as Partial<ApiClient>);
  try {
    await act(async () => tray.proceed()!.click());
    await flush();
    assert.deepEqual(tray.confirmations.map((options) => [options.title, options.confirmLabel, options.tone]), [
      ["Proceed Now", "Proceed Now", "danger"],
    ]);
    const alert = tray.container.querySelector(".queue-hold .notice[role='alert']");
    assert.equal(alert?.textContent, refusal);

    await act(async () => tray.proceed()!.click());
    await flush();
    assert.equal(tray.proceed()!.getAttribute("aria-busy"), "true", "busy while the request runs");
    assertNoDomNode(tray.container.querySelector("[role='alert']"));
    await act(async () => tray.proceed()!.click());
    await flush();
    assert.equal(calls.length, 2, "a busy button sends nothing more");
    await act(async () => {
      finish({ sessionId: "session-held", holdId: calls[1]!, outcome: "released", jobIds: [] });
      await Promise.resolve();
    });
    assert.equal(tray.container.querySelector(".queue-hold [role='status']")?.textContent, QUEUE_HOLD_RELEASED);
  } finally {
    await tray.dispose();
  }
});

test("cancelling the confirmation, or a hold that changed while it was open, releases nothing", async () => {
  let called = false;
  const declined = await mountTray(heldSession(), {
    releaseQueueHold: async () => { called = true; return {} as QueueHoldReleaseResponse; },
  } as Partial<ApiClient>, false);
  try {
    await act(async () => declined.proceed()!.click());
    await flush();
    assert.equal(declined.confirmations.length, 1);
    assert.equal(called, false);
    assert.ok(declined.proceed(), "still offered");
  } finally {
    await declined.dispose();
  }

  let answer!: (confirmed: boolean) => void;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const client = { releaseQueueHold: async () => { called = true; return {} as QueueHoldReleaseResponse; } } as unknown as ApiClient;
  const draw = (session: HeldSession) => act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        confirm: () => new Promise<boolean>((resolve) => { answer = resolve; }),
        showToast: () => 1,
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <QueuedMessages sessionId="session-held" prompts={PROMPTS} queueHeld={false}
          queueHold={queueHoldTrayView(session, true)} agent="Claude Code" steering={STEERING}
          requestBusy={false} refusal={null} steeringPending={new Set()} editingPromptId={null} editOpen={false}
          pendingAction={undefined} onSteer={() => undefined} onEdit={() => undefined} onCancel={() => undefined}
          onDismiss={() => undefined} />
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  try {
    await draw(heldSession());
    const proceed = [...container.querySelectorAll<HTMLButtonElement>(".queue-hold button")]
      .find((button) => button.textContent === "Proceed Now…")!;
    await act(async () => proceed.click());
    // While the confirmation is open, the hold clears and a new one forms.
    await draw(heldSession({ queueHold: hold({ holdId: `worktree-rebind:${SINCE + 1}` }) }));
    await act(async () => { answer(true); await Promise.resolve(); });
    await flush();
    assert.equal(called, false, "the hold that was confirmed is gone, so nothing is sent");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
