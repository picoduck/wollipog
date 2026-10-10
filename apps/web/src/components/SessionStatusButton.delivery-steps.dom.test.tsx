import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type BackgroundJobStopResponse,
  type ManagedBackgroundJobView,
  type PendingApproval,
  type SessionCommandPermissions,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { STOP_JOB_OUTCOME } from "../background-job-stop.js";
import { FeedbackContext, type ConfirmationOptions, type ToastOptions } from "./FeedbackProvider.js";
import { SessionHeader } from "./SessionHeader.js";
import { backgroundDeliveryStepRetention, resetBackgroundDeliverySteps } from "./useBackgroundDeliveryStep.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * The Session Status popover's Result Blocked and Result Missing rows take their step themselves
 * (#2275): Stop Job… behind the panel's danger confirmation, and Acknowledge Missing Result. Every
 * case where the step cannot apply opens Background Work instead.
 */

const domWindow = new Window({ url: "http://localhost/session/delivery", width: 1440, height: 900 });
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

const NOW = Date.now();

function job(id: string, overrides: Partial<ManagedBackgroundJobView> = {}): ManagedBackgroundJobView {
  return {
    id, parentTurnId: "turn-1", launchType: "monitor",
    registeredAt: NOW - 60_000, lastObservedAt: NOW - 1_000, sourcePresent: true,
    ...overrides,
  } as ManagedBackgroundJobView;
}

/** A finished agent job waits on one monitor that is still running. */
const finishedAgent = job("agent", {
  launchType: "agent", registeredAt: NOW - 120_000, terminalStatus: "completed",
  terminalObservedAt: NOW - 30_000, continuationRequired: true,
});
const runningMonitor = job("monitor");

function blocked(overrides: Partial<SessionView> = {}): Partial<SessionView> {
  return {
    driver: "claude-code",
    backgroundWorkState: "running",
    backgroundWorkTracking: "managed",
    backgroundJobsAvailable: true,
    backgroundJobs: [finishedAgent, runningMonitor],
    backgroundDeliveries: [{
      parentTurnId: "turn-1", jobCount: 2, terminalCount: 1,
      watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1,
    }],
    ...overrides,
  } as Partial<SessionView>;
}

function missing(overrides: Partial<SessionView> = {}): Partial<SessionView> {
  return {
    driver: "claude-code",
    backgroundWorkTracking: "managed",
    backgroundJobsAvailable: true,
    backgroundJobs: [],
    backgroundDeliveries: [{
      continuationId: "continuation-1", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1,
      acceptedAt: NOW - 120_000, missingResultAt: NOW - 90_000, watchdogState: "accepted_without_result",
    }],
    ...overrides,
  } as Partial<SessionView>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

interface Harness {
  root: Root;
  stops: Array<{ sessionId: string; jobId: string; reply: Deferred<BackgroundJobStopResponse> }>;
  acknowledgements: Array<{ sessionId: string; continuationId: string; reply: Deferred<SessionView> }>;
  confirmations: ConfirmationOptions[];
  toasts: Array<{ message: string; tone?: ToastOptions["tone"] }>;
  opened: { background: number };
  /** What the next confirmation answers; `deferred` holds it open until the test settles it. */
  confirmAnswer: { value: boolean; deferred?: Deferred<boolean> };
  /** Draws the header again with this session, as a live update does. */
  rerender: (next: Partial<SessionView>) => Promise<void>;
  /** Unmounts the header and mounts a new one for the same session, as leaving and returning does. */
  remount: () => Promise<void>;
}

function body(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

async function renderHeader(
  overrides: Partial<SessionView>,
  options: { runnerOnline?: boolean; runnerProtocolVersion?: number } = {},
): Promise<Harness> {
  const harness: Harness = {
    root: undefined as unknown as Root,
    stops: [],
    acknowledgements: [],
    confirmations: [],
    toasts: [],
    opened: { background: 0 },
    confirmAnswer: { value: true },
    rerender: async () => undefined,
    remount: async () => undefined,
  };
  const client: ApiClient = {
    ...api,
    stopBackgroundJob: (sessionId: string, jobId: string) => {
      const reply = deferred<BackgroundJobStopResponse>();
      harness.stops.push({ sessionId, jobId, reply });
      return reply.promise;
    },
    acknowledgeBackgroundMissingResult: (sessionId: string, continuationId: string) => {
      const reply = deferred<SessionView>();
      harness.acknowledgements.push({ sessionId, continuationId, reply });
      return reply.promise;
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  harness.root = createRoot(container);
  let current = overrides;
  const draw = (next: Partial<SessionView>) => {
    current = next;
    const session = { id: "delivery", runnerId: "runner-1", title: "Delivery", status: "idle", ...next } as SessionView;
    harness.root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={{
          confirm: async (confirmation) => {
            harness.confirmations.push(confirmation);
            if (harness.confirmAnswer.deferred) return harness.confirmAnswer.deferred.promise;
            return harness.confirmAnswer.value;
          },
          showToast: (message, toast) => {
            harness.toasts.push({ message, tone: toast?.tone });
            return harness.toasts.length;
          },
          showUndo: () => 1,
          dismissToast: () => undefined,
        }}>
          <SessionHeader
            session={session}
            onBack={() => undefined}
            runnerOnline={options.runnerOnline ?? true}
            runnerProtocolVersion={options.runnerProtocolVersion ?? PROTOCOL_VERSION}
            providerLogoutSupported={false}
            stopBeforeArchiveSupported
            exportReady
            onOpenBackgroundWork={() => { harness.opened.background += 1; }}
          />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  };
  await act(async () => { draw(overrides); });
  harness.rerender = async (next) => { await act(async () => { draw(next); }); };
  harness.remount = async () => {
    await act(async () => { harness.root.unmount(); });
    harness.root = createRoot(container);
    await act(async () => { draw(current); });
  };
  return harness;
}

async function cleanUp(root: Root) {
  await act(async () => { root.unmount(); });
  domWindow.document.body.innerHTML = "";
  // Steps outlive a header on purpose; each test starts with none.
  resetBackgroundDeliverySteps();
}

/** Lets pending promise callbacks run and React commit what they set. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function trigger(): HTMLButtonElement {
  const match = body().querySelector<HTMLButtonElement>("header.session-bar .session-status-button");
  assert.ok(match, "the bar has its Session Status control");
  return match;
}

function popover(): HTMLElement | null {
  return body().querySelector<HTMLElement>('[role="dialog"][aria-label="Session Status"]');
}

async function openPopover() {
  if (!popover()) await act(async () => { trigger().click(); });
  assert.ok(popover(), "the popover opened");
}

/** The action of the popover row whose badge reads `badge`, by its accessible name. */
function rowAction(badge: string): { name: string; button: HTMLButtonElement } {
  const row = [...popover()!.querySelectorAll<HTMLElement>(".session-status-row")]
    .find((candidate) => candidate.querySelector(".status")?.textContent === badge);
  assert.ok(row, `missing row: ${badge}`);
  const button = row.querySelector<HTMLButtonElement>("button");
  assert.ok(button, `the ${badge} row has an action`);
  return { name: button.getAttribute("aria-label") ?? button.textContent ?? "", button };
}

test("Result Blocked is the bar's status and its row offers Stop Job… for the one job still running", async () => {
  const harness = await renderHeader(blocked());
  try {
    assert.equal(trigger().getAttribute("aria-label"), "Session Status: Result Blocked");
    await openPopover();
    const { name, button } = rowAction("Result Blocked");
    assert.equal(name, "Stop Job…");
    await act(async () => { button.click(); });
    await settle();
    assertNoDomNode(popover(), "the step closes the popover");
    assert.ok(domWindow.document.activeElement === (trigger() as unknown), "focus waits on the Session Status control");

    // The panel's danger confirmation and wording, naming the job as the panel does.
    assert.equal(harness.confirmations.length, 1);
    const confirmation = harness.confirmations[0]!;
    assert.equal(confirmation.title, "Stop Job");
    assert.equal(confirmation.message, STOP_JOB_OUTCOME);
    assert.deepEqual(confirmation.detailRows, [{ label: "Monitor Job onitor" }]);
    assert.equal(confirmation.confirmLabel, "Stop Job");
    assert.equal(confirmation.cancelLabel, "Keep Running");
    assert.equal(confirmation.tone, "danger");
    assert.ok(confirmation.returnFocus?.current === (trigger() as unknown), "the confirmation returns focus to the control");
    assert.deepEqual(harness.stops.map((stop) => [stop.sessionId, stop.jobId]), [["delivery", "monitor"]]);

    // While the request runs, the reopened row shows it busy and refuses a second press.
    await openPopover();
    const busy = rowAction("Result Blocked").button;
    assert.equal(busy.getAttribute("aria-busy"), "true");
    assert.equal(busy.getAttribute("aria-disabled"), "true");
    await act(async () => { busy.click(); });
    await settle();
    assert.equal(harness.confirmations.length, 1, "no second confirmation");
    assert.equal(harness.stops.length, 1, "no second request");

    harness.stops[0]!.reply.resolve({ sessionId: "delivery", jobId: "monitor", outcome: "stopped" } as BackgroundJobStopResponse);
    await settle();
    assert.deepEqual(harness.toasts, [{ message: "Monitor Job onitor was stopped.", tone: "success" }]);
    // Until the session update arrives, the stopped job is not offered again.
    await openPopover();
    assert.equal(rowAction("Result Blocked").name, "Open Background Work");
  } finally {
    await cleanUp(harness.root);
  }
});

test("cancelling Stop Job sends nothing and keeps the step", async () => {
  const harness = await renderHeader(blocked());
  harness.confirmAnswer.value = false;
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.stops.length, 0);
    await openPopover();
    const { name, button } = rowAction("Result Blocked");
    assert.equal(name, "Stop Job…");
    assert.equal(button.getAttribute("aria-busy"), null);
  } finally {
    await cleanUp(harness.root);
  }
});

test("a failed Stop Job is an error toast, and the row keeps its step", async () => {
  const harness = await renderHeader(blocked());
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    harness.stops[0]!.reply.reject(new Error("The runner refused the stop."));
    await settle();
    assert.deepEqual(harness.toasts, [{ message: "The runner refused the stop.", tone: "error" }]);
    await openPopover();
    const { name, button } = rowAction("Result Blocked");
    assert.equal(name, "Stop Job…");
    assert.equal(button.getAttribute("aria-busy"), null, "the step can be tried again");
  } finally {
    await cleanUp(harness.root);
  }
});

test("a job that had already ended is said in an info toast", async () => {
  const harness = await renderHeader(blocked());
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    harness.stops[0]!.reply.resolve({ sessionId: "delivery", jobId: "monitor", outcome: "already_terminal" } as BackgroundJobStopResponse);
    await settle();
    assert.deepEqual(harness.toasts, [{ message: "This job had already ended, so nothing was changed.", tone: "info" }]);
  } finally {
    await cleanUp(harness.root);
  }
});

const readOnly: SessionCommandPermissions = {
  stop: { allowed: false, reason: "Viewers can't stop sessions." },
  restart: { allowed: false, reason: "Viewers can't restart sessions." },
  stopBackgroundJob: { allowed: false, reason: "Viewers can't stop jobs." },
  archive: { allowed: false, reason: "Viewers can't archive sessions." },
  unarchive: { allowed: false, reason: "Viewers can't unarchive sessions." },
  prompt: { allowed: false, reason: "Viewers can't send prompts." },
  delete: { allowed: false, reason: "Viewers can't delete sessions." },
  rename: { allowed: false, reason: "Viewers can't rename sessions." },
};

for (const [name, overrides, options] of [
  ["Stop Job needs a newer runner", blocked(), { runnerProtocolVersion: 189 }],
  ["the runner is offline", blocked(), { runnerOnline: false }],
  ["the person may not stop jobs", blocked({ commandPermissions: readOnly }), {}],
  ["the session is not Claude Code", blocked({ driver: "codex-app-server" }), {}],
  ["two jobs of the turn are still running", blocked({ backgroundJobs: [finishedAgent, runningMonitor, job("second-monitor")] }), {}],
  ["no job of the turn is listed", blocked({ backgroundJobs: [] }), {}],
  // The inventory is bounded: a second unfinished job can be left out of it (#2275 review).
  ["the full count has an unfinished job the bounded inventory leaves out", blocked({
    backgroundJobsTruncated: true,
    backgroundDeliveries: [{
      parentTurnId: "turn-1", jobCount: 3, terminalCount: 1,
      watchdogState: "continuation_blocked", unfinishedSiblingJobs: 2,
    }],
  }), {}],
  ["the inventory is truncated and the full count is unknown", blocked({
    backgroundJobsTruncated: true,
    backgroundDeliveries: [{ parentTurnId: "turn-1", jobCount: 2, terminalCount: 1, watchdogState: "continuation_blocked" }],
  }), {}],
  ["the turn is unknown", blocked({
    backgroundJobs: [job("orphan", { parentTurnId: "unknown" })],
    backgroundDeliveries: [{ parentTurnId: "unknown", jobCount: 1, terminalCount: 0, watchdogState: "continuation_blocked" }],
  }), {}],
] as const) {
  test(`Result Blocked opens Background Work when ${name}`, async () => {
    const harness = await renderHeader(overrides, options);
    try {
      assert.match(trigger().getAttribute("aria-label") ?? "", /^Session Status: Result Blocked/);
      await openPopover();
      const action = rowAction("Result Blocked");
      assert.equal(action.name, "Open Background Work");
      await act(async () => { action.button.click(); });
      assert.equal(harness.opened.background, 1);
      assert.equal(harness.confirmations.length, 0);
      assert.equal(harness.stops.length, 0);
    } finally {
      await cleanUp(harness.root);
    }
  });
}

test("Result Missing's row acknowledges the missing result without asking first", async () => {
  const harness = await renderHeader(missing());
  try {
    assert.equal(trigger().getAttribute("aria-label"), "Session Status: Result Missing");
    await openPopover();
    const { name, button } = rowAction("Result Missing");
    assert.equal(name, "Acknowledge Missing Result");
    await act(async () => { button.click(); });
    await settle();
    assertNoDomNode(popover(), "the step closes the popover");
    assert.ok(domWindow.document.activeElement === (trigger() as unknown), "focus returns to the Session Status control");
    assert.equal(harness.confirmations.length, 0, "the panel's step asks nothing first, and neither does this one");
    assert.deepEqual(harness.acknowledgements.map((ack) => [ack.sessionId, ack.continuationId]), [["delivery", "continuation-1"]]);

    await openPopover();
    const busy = rowAction("Result Missing").button;
    assert.equal(busy.getAttribute("aria-busy"), "true");
    await act(async () => { busy.click(); });
    await settle();
    assert.equal(harness.acknowledgements.length, 1, "no second request while the first runs");

    harness.acknowledgements[0]!.reply.resolve({} as SessionView);
    await settle();
    assert.deepEqual(harness.toasts, [{ message: "Missing result acknowledged.", tone: "success" }]);
    await openPopover();
    assert.equal(rowAction("Result Missing").name, "Open Background Work", "an acknowledged result is not offered again");
  } finally {
    await cleanUp(harness.root);
  }
});

test("a failed acknowledgement is an error toast, and the row keeps its step", async () => {
  const harness = await renderHeader(missing());
  try {
    await openPopover();
    await act(async () => { rowAction("Result Missing").button.click(); });
    await settle();
    harness.acknowledgements[0]!.reply.reject(new Error("background delivery is not terminally missing"));
    await settle();
    assert.deepEqual(harness.toasts, [{ message: "background delivery is not terminally missing", tone: "error" }]);
    await openPopover();
    const { name, button } = rowAction("Result Missing");
    assert.equal(name, "Acknowledge Missing Result");
    assert.equal(button.getAttribute("aria-busy"), null);
  } finally {
    await cleanUp(harness.root);
  }
});

test("Result Missing with no continuation to acknowledge opens Background Work", async () => {
  const harness = await renderHeader(missing({
    backgroundDeliveries: [{ parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, watchdogState: "accepted_without_result" }],
  }));
  try {
    await openPopover();
    const action = rowAction("Result Missing");
    assert.equal(action.name, "Open Background Work");
    await act(async () => { action.button.click(); });
    assert.equal(harness.opened.background, 1);
    assert.equal(harness.acknowledgements.length, 0);
  } finally {
    await cleanUp(harness.root);
  }
});

test("an approval leads, Result Missing is +1, and its row still takes its step", async () => {
  const approval: PendingApproval = { requestId: "approval-1", title: "Run the tests", options: [], kind: "permission" };
  const harness = await renderHeader(missing({ status: "input_required", pendingApproval: approval }));
  try {
    assert.equal(trigger().getAttribute("aria-label"), "Session Status: Approval Required and 1 More");
    assert.equal(trigger().querySelector(".session-status-more")?.textContent, "+1");
    await openPopover();
    assert.equal(rowAction("Result Missing").name, "Acknowledge Missing Result");
  } finally {
    await cleanUp(harness.root);
  }
});

test("a result still on its way back stays a passive row with Open", async () => {
  const harness = await renderHeader(missing({
    backgroundDeliveries: [{ parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, watchdogState: "terminal_without_continuation" }],
  }));
  try {
    assert.equal(trigger().getAttribute("aria-label"), "Session Status: Awaiting Prompt");
    await openPopover();
    assert.equal(rowAction("Result Pending").name, "Open Background Work");
  } finally {
    await cleanUp(harness.root);
  }
});

test("with no full count, a complete inventory still offers Stop Job… for its one running job", async () => {
  const harness = await renderHeader(blocked({
    backgroundDeliveries: [{ parentTurnId: "turn-1", jobCount: 2, terminalCount: 1, watchdogState: "continuation_blocked" }],
  }));
  try {
    await openPopover();
    assert.equal(rowAction("Result Blocked").name, "Stop Job…");
  } finally {
    await cleanUp(harness.root);
  }
});

test("two presses before React commits send one acknowledgement", async () => {
  const harness = await renderHeader(missing());
  try {
    await openPopover();
    const { button } = rowAction("Result Missing");
    await act(async () => {
      button.click();
      button.click();
    });
    await settle();
    assert.equal(harness.acknowledgements.length, 1);
  } finally {
    await cleanUp(harness.root);
  }
});

test("two presses before React commits open one Stop Job confirmation and send one stop", async () => {
  const harness = await renderHeader(blocked());
  try {
    await openPopover();
    const { button } = rowAction("Result Blocked");
    await act(async () => {
      button.click();
      button.click();
    });
    await settle();
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.stops.length, 1);
    // Once the stop settles with a failure, the step can be taken again.
    harness.stops[0]!.reply.reject(new Error("The runner refused the stop."));
    await settle();
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    assert.equal(harness.stops.length, 2);
  } finally {
    await cleanUp(harness.root);
  }
});

test("a cancelled confirmation releases the step for the next press", async () => {
  const harness = await renderHeader(blocked());
  harness.confirmAnswer.value = false;
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    harness.confirmAnswer.value = true;
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    assert.equal(harness.confirmations.length, 2);
    assert.equal(harness.stops.length, 1);
  } finally {
    await cleanUp(harness.root);
  }
});

test("a confirmation that resolves after the background work changed stops nothing (#2275 review)", async () => {
  const harness = await renderHeader(blocked());
  harness.confirmAnswer.deferred = deferred<boolean>();
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    // While the confirmation is open, the control plane reports a second unfinished job.
    await harness.rerender(blocked({
      backgroundDeliveries: [{
        parentTurnId: "turn-1", jobCount: 3, terminalCount: 1,
        watchdogState: "continuation_blocked", unfinishedSiblingJobs: 2,
      }],
    }));
    harness.confirmAnswer.deferred.resolve(true);
    await settle();
    assert.equal(harness.stops.length, 0, "the captured job is not stopped");
    assert.deepEqual(harness.toasts, [{ message: "The background work changed, so nothing was stopped.", tone: "info" }]);
    await openPopover();
    assert.equal(rowAction("Result Blocked").name, "Open Background Work");
  } finally {
    await cleanUp(harness.root);
  }
});

test("a confirmation that resolves with the same one job still stops it", async () => {
  const harness = await renderHeader(blocked());
  harness.confirmAnswer.deferred = deferred<boolean>();
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    await harness.rerender(blocked({ title: "Renamed while confirming" }));
    harness.confirmAnswer.deferred.resolve(true);
    await settle();
    assert.deepEqual(harness.stops.map((stop) => stop.jobId), ["monitor"]);
  } finally {
    await cleanUp(harness.root);
  }
});

test("an acknowledgement in flight stays busy across a header remount, and is not sent twice (#2275 review)", async () => {
  const harness = await renderHeader(missing());
  try {
    await openPopover();
    await act(async () => { rowAction("Result Missing").button.click(); });
    await settle();
    await harness.remount();
    await openPopover();
    const busy = rowAction("Result Missing").button;
    assert.equal(busy.getAttribute("aria-busy"), "true");
    await act(async () => { busy.click(); });
    await settle();
    assert.equal(harness.acknowledgements.length, 1);
    harness.acknowledgements[0]!.reply.resolve({} as SessionView);
    await settle();
    await openPopover();
    assert.equal(rowAction("Result Missing").name, "Open Background Work");
  } finally {
    await cleanUp(harness.root);
  }
});

test("a Stop Job in flight stays busy across a header remount", async () => {
  const harness = await renderHeader(blocked());
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    assert.equal(harness.stops.length, 1);
    await harness.remount();
    await openPopover();
    const busy = rowAction("Result Blocked").button;
    assert.equal(busy.getAttribute("aria-busy"), "true");
    await act(async () => { busy.click(); });
    await settle();
    assert.equal(harness.confirmations.length, 1);
    assert.equal(harness.stops.length, 1);
  } finally {
    await cleanUp(harness.root);
  }
});

test("a confirmation that resolves after the session's header is gone stops nothing (#2275 review)", async () => {
  const harness = await renderHeader(blocked());
  harness.confirmAnswer.deferred = deferred<boolean>();
  try {
    await openPopover();
    await act(async () => { rowAction("Result Blocked").button.click(); });
    await settle();
    // The person moves to another session while the confirmation is open.
    await harness.rerender(blocked({ id: "other-session", backgroundDeliveries: [] }));
    harness.confirmAnswer.deferred.resolve(true);
    await settle();
    assert.equal(harness.stops.length, 0);
    assert.deepEqual(harness.toasts, [{ message: "The session was closed, so nothing was stopped.", tone: "info" }]);
  } finally {
    await cleanUp(harness.root);
  }
});

test("the step store holds only steps in flight and the sessions on screen (#2275 review)", async () => {
  const harness = await renderHeader(missing());
  try {
    // Several sessions shown in turn leave nothing behind but the one on screen.
    for (const id of ["one", "two", "three"]) await harness.rerender(missing({ id }));
    assert.deepEqual(backgroundDeliveryStepRetention(), { steps: 0, inputs: 1 });

    // A finished step stays only while the row would still offer it.
    await openPopover();
    await act(async () => { rowAction("Result Missing").button.click(); });
    await settle();
    harness.acknowledgements[0]!.reply.resolve({} as SessionView);
    await settle();
    assert.deepEqual(backgroundDeliveryStepRetention(), { steps: 1, inputs: 1 });
    await harness.rerender(missing({ id: "three", backgroundDeliveries: [] }));
    assert.deepEqual(backgroundDeliveryStepRetention(), { steps: 0, inputs: 1 });

    // A step that finishes after its session's last header is gone is not kept.
    await harness.rerender(missing({ id: "four" }));
    await openPopover();
    await act(async () => { rowAction("Result Missing").button.click(); });
    await settle();
    await act(async () => { harness.root.unmount(); });
    harness.acknowledgements[1]!.reply.resolve({} as SessionView);
    await settle();
    assert.deepEqual(backgroundDeliveryStepRetention(), { steps: 0, inputs: 0 });
    harness.root = createRoot(domWindow.document.createElement("div") as never);
  } finally {
    await cleanUp(harness.root);
  }
});
