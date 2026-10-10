import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type BackgroundJobStopResponse,
  type ManagedBackgroundJobView,
  type SessionView,
} from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { STOP_JOB_ALREADY_ENDED, STOP_JOB_OUTCOME } from "../background-job-stop.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackContext, FeedbackProvider, type ConfirmationOptions } from "./FeedbackProvider.js";
import { JobDetail, STOP_JOB_STOPPED, type JobDetailProps } from "./JobDetail.js";

const domWindow = new Window({ url: "http://localhost/" });
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

const MINUTE = 60_000;
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

function job(overrides: Partial<ManagedBackgroundJobView> = {}): ManagedBackgroundJobView {
  const now = Date.now();
  return {
    id: "job-shell-a1f3c9",
    parentTurnId: "turn-4",
    launchType: "shell",
    registeredAt: now - 10 * MINUTE,
    lastObservedAt: now - MINUTE,
    sourcePresent: true,
    ...overrides,
  };
}

function session(jobs: ManagedBackgroundJobView[], overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session",
    runnerId: "runner",
    driver: "claude-code",
    backgroundWorkTracking: "managed",
    backgroundWorkState: "running",
    backgroundJobs: jobs,
    backgroundDeliveries: [],
    ...overrides,
  } as unknown as SessionView;
}

/** Renders a job page with a recording confirmation, answering each with `answer`. */
async function mountDetail(props: Partial<JobDetailProps> & { session: SessionView }, client: Partial<ApiClient> = {}, answer = true) {
  const confirmations: ConfirmationOptions[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  // StrictMode mounts, unmounts and remounts, as the app's development build does.
  const render = (next: Partial<JobDetailProps> & { session: SessionView }) => act(async () => root.render(
    <React.StrictMode><ApiProvider client={client as ApiClient}>
      <FeedbackContext.Provider value={{
        confirm: async (options) => { confirmations.push(options); return answer; },
        showToast: () => 1,
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <JobDetail jobId="job-shell-a1f3c9" runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} parentTurns={new Map()} {...next} />
      </FeedbackContext.Provider>
    </ApiProvider></React.StrictMode>,
  ));
  await render(props);
  return {
    container,
    confirmations,
    render,
    stopButton: () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Stop Job")) ?? null,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("Stop Job… opens the danger confirmation, focused on Cancel, titled with the job's name (#2858)", async () => {
  const stops: string[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const client = {
    stopBackgroundJob: async (_sessionId: string, jobId: string) => {
      stops.push(jobId);
      return { sessionId: "session", jobId, outcome: "stopped", terminalStatus: "killed" } as BackgroundJobStopResponse;
    },
  } as unknown as ApiClient;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <JobDetail session={session([job()])} jobId="job-shell-a1f3c9" runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
            parentTurns={new Map()} />
        </FeedbackProvider>
      </ApiProvider>,
    ));
    const stop = container.querySelector<HTMLButtonElement>(".job-detail-stop > button")!;
    assert.equal(stop.textContent, "Stop Job…");
    assert.ok(stop.classList.contains("btn") && stop.classList.contains("sm"));
    await act(async () => stop.click());
    const dialog = domWindow.document.querySelector('[role="alertdialog"], [role="dialog"]') as unknown as HTMLElement | null;
    assert.ok(dialog, "a confirmation opens");
    assert.match(dialog!.textContent ?? "", /Stop Shell Job a1f3c9/u);
    assert.ok((dialog!.textContent ?? "").includes(STOP_JOB_OUTCOME));
    const focused = domWindow.document.activeElement;
    assert.equal(focused?.textContent, "Cancel", "Cancel has initial focus in a danger confirmation");
    assert.deepEqual(stops, [], "nothing is stopped before confirming");
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Stop Job")!;
    assert.ok(confirm.classList.contains("danger"));
    await act(async () => confirm.click());
    await flush();
    assert.deepEqual(stops, ["job-shell-a1f3c9"], "confirming calls the stop route once");
    assert.match(container.textContent ?? "", new RegExp(STOP_JOB_STOPPED.replace(/\./gu, "\\.")));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("while stopping the button is busy, then says the outcome; a refusal is a danger notice and can be retried (#2858)", async () => {
  let finish!: (value: BackgroundJobStopResponse) => void;
  const answers: Array<() => Promise<BackgroundJobStopResponse>> = [
    async () => { throw new Error("the provider did not confirm in time that the job ended, so it is left running"); },
    () => new Promise<BackgroundJobStopResponse>((resolve) => { finish = resolve; }),
  ];
  const calls: string[] = [];
  const detail = await mountDetail({ session: session([job()]) }, {
    stopBackgroundJob: (_sessionId: string, jobId: string) => { calls.push(jobId); return answers.shift()!(); },
  } as Partial<ApiClient>);
  try {
    await act(async () => detail.stopButton()!.click());
    await flush();
    assert.deepEqual(detail.confirmations.map((options) => [options.title, options.message, options.confirmLabel, options.tone]), [
      ["Stop Shell Job a1f3c9", STOP_JOB_OUTCOME, "Stop Job", "danger"],
    ]);
    const alert = detail.container.querySelector(".job-detail-stop .notice[role='alert']");
    assert.equal(alert?.textContent, "the provider did not confirm in time that the job ended, so it is left running");
    assert.ok(alert?.classList.contains("compact"), "a compact danger notice under the button");

    await act(async () => detail.stopButton()!.click());
    await flush();
    assert.equal(detail.stopButton()!.getAttribute("aria-busy"), "true", "busy while the request runs");
    assert.equal(detail.stopButton()!.textContent, "Stop Job…", "the label stays while busy");
    assertNoDomNode(detail.container.querySelector("[role='alert']"));
    await act(async () => detail.stopButton()!.click());
    assert.equal(calls.length, 2, "a busy button sends nothing more");
    await act(async () => {
      finish({ sessionId: "session", jobId: "job-shell-a1f3c9", outcome: "already_terminal", terminalStatus: "completed" });
      await Promise.resolve();
    });
    assert.match(detail.container.textContent ?? "", new RegExp(STOP_JOB_ALREADY_ENDED.replace(/\./gu, "\\.")));
    assertNoDomNode(detail.stopButton(), "nothing is left to stop");
  } finally {
    await detail.dispose();
  }
});

test("cancelling the confirmation sends nothing (#2858)", async () => {
  let called = false;
  const detail = await mountDetail({ session: session([job()]) },
    { stopBackgroundJob: async () => { called = true; return {} as BackgroundJobStopResponse; } } as Partial<ApiClient>, false);
  try {
    await act(async () => detail.stopButton()!.click());
    await flush();
    assert.equal(detail.confirmations.length, 1);
    assert.equal(called, false);
    assert.equal(detail.stopButton()!.getAttribute("aria-busy"), null);
  } finally {
    await detail.dispose();
  }
});

test("unavailable, Stop Job stays disabled with its reason as visible text, never only a title (#2858, #1843)", async () => {
  const reason = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
  const detail = await mountDetail({
    session: session([job()], {
      commandPermissions: { stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: false, reason } },
    } as Partial<SessionView>),
  });
  try {
    const assertReason = (expected: RegExp) => {
      const button = detail.stopButton()!;
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, "Stop Job…");
      const described = domWindow.document.getElementById(button.getAttribute("aria-describedby")!);
      assert.match(described?.textContent ?? "", expected);
      assert.equal(described?.classList.contains("sr-only"), false, "the reason is on screen");
      assert.equal([...detail.container.querySelectorAll("[title]")].some((element) =>
        (element.getAttribute("title") ?? "").includes("Stop") || (element.getAttribute("title") ?? "") === described?.textContent),
      false, "no element carries the reason only in a title");
      assertNoDomNode(detail.container.querySelector(".sr-only"));
    };
    assertReason(new RegExp(`^${reason.replace(/\./gu, "\\.")}$`, "u"));
    await act(async () => detail.stopButton()!.click());
    assert.equal(detail.confirmations.length, 0, "no confirmation opens");

    await detail.render({ session: session([job()]), runnerProtocolVersion: 189 });
    assertReason(/This machine needs a newer runner for stopping a background job\./u);

    // A job that cannot be stopped offers nothing; another harness has nothing to stop.
    await detail.render({ session: session([job({ terminalStatus: "completed", terminalObservedAt: Date.now() - MINUTE })]) });
    assertNoDomNode(detail.stopButton());
    await detail.render({ session: session([job()], { driver: "codex" } as Partial<SessionView>) });
    assertNoDomNode(detail.stopButton());
  } finally {
    await detail.dispose();
  }
});

test("the page's facts: timing, result, the turn that started it, and who ended it (#2858, #1849)", async () => {
  const now = Date.now();
  const viewed: string[] = [];
  const facts = (container: HTMLElement) => Object.fromEntries([...container.querySelectorAll(".job-detail .facts > div")]
    .map((entry) => [entry.querySelector("dt")?.textContent, entry.querySelector("dd")?.textContent]));
  const detail = await mountDetail({
    session: session([
      job({ terminalStatus: "killed", terminalObservedAt: now - 2 * MINUTE, continuationRequired: false,
        endedBy: { actor: { kind: "orchestrator", sessionId: "s_parent_orchestrator" }, reason: "stop_request", endedAt: now - 2 * MINUTE } }),
    ], {
      backgroundDeliveries: [{ parentTurnId: "turn-4", jobCount: 1, terminalCount: 1, notificationQueuedAt: now - MINUTE,
        notifications: [{ deliveryId: "d", endpointKey: "e", state: "shown", attemptCount: 1, shownAt: now - MINUTE }] }],
    } as Partial<SessionView>),
    parentTurns: new Map([["turn-4", { eventId: 40, turn: 4 }]]),
    onViewTurn: (turnId) => viewed.push(turnId),
  });
  try {
    assert.equal(detail.container.querySelector(".job-detail > .status")?.textContent, "Killed");
    const read = facts(detail.container);
    assert.deepEqual(Object.keys(read), ["Started", "Duration", "Finished", "Last Activity", "Result", "Notification",
      "Started By", "Ended By", "Reason"]);
    assert.equal(read.Duration, "8m 0s");
    assert.equal(read.Finished, "2m ago");
    assert.equal(read.Result, "Nothing to return to this conversation");
    assert.equal(read.Notification, "Shown");
    assert.equal(read["Started By"], "Turn 4View Turn");
    assert.equal(read["Ended By"], "Controlling Orchestrator s_parent_orchestrator");
    assert.equal(read.Reason, "Stop Job Request");
    assert.doesNotMatch(detail.container.textContent ?? "", /continuation|terminal|pending|in flight/iu,
      "raw continuation stages stay off the page");
    const viewTurn = [...detail.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "View Turn")!;
    assert.ok(viewTurn.classList.contains("btn") && viewTurn.classList.contains("sm"), "a control-height button, 44px to hit on touch");
    await act(async () => viewTurn.click());
    assert.deepEqual(viewed, ["turn-4"]);

    // A job whose result waits on its sibling says so; one with no turn has no View Turn.
    await detail.render({
      session: session([
        job({ terminalStatus: "completed", terminalObservedAt: now - MINUTE, continuationRequired: true }),
        job({ id: "job-monitor-7be210", launchType: "monitor" }),
      ]),
      parentTurns: new Map([["turn-4", { eventId: 40, turn: 4 }]]),
      onViewTurn: (turnId) => viewed.push(turnId),
    });
    assert.equal(facts(detail.container).Result, "Returns to this conversation when the other job finishes");
    await detail.render({ session: session([job({ parentTurnId: "unknown" })]), onViewTurn: (turnId) => viewed.push(turnId) });
    assert.equal(facts(detail.container)["Started By"], "Unknown Turn");
    assert.equal([...detail.container.querySelectorAll("button")].some((button) => button.textContent === "View Turn"), false);

    // A job that left the list says so instead of showing an empty page.
    await detail.render({ session: session([]) });
    assert.match(detail.container.textContent ?? "", /Job Not Listed/u);
  } finally {
    await detail.dispose();
  }
});
