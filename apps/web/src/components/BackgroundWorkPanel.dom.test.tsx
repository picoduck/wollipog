import assert from "node:assert/strict";
import { statusMeta } from "../status-meta.js";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { STOP_JOB_OUTCOME } from "../background-job-stop.js";
import {
  BACKGROUND_WORK_SKELETON_DELAY_MS,
  BackgroundWorkPanel,
  backgroundJobCurrentState,
  type BackgroundWorkPanelProps,
} from "./BackgroundWorkPanel.js";
import { FeedbackContext, type ConfirmationOptions } from "./FeedbackProvider.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
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

const baseJob: ManagedBackgroundJobView = {
  id: "opaque-job-id",
  parentTurnId: "turn-1",
  launchType: "agent",
  registeredAt: 1_000,
  lastObservedAt: 2_000,
  sourcePresent: true,
};

test("a job's current state keeps its lifecycle separate from where its result is", () => {
  // States are keys of the shared job vocabulary; `statusMeta("job", …)` owns their words.
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true), "running");
  assert.equal(backgroundJobCurrentState(baseJob, "running", false, true), "unverified");
  assert.equal(backgroundJobCurrentState({ ...baseJob, sourcePresent: false }, "running", true, true), "unverified");
  assert.equal(backgroundJobCurrentState({ ...baseJob, terminalStatus: "failed" }, undefined, false, true), "failed");
  assert.equal(backgroundJobCurrentState(baseJob, "orphaned", true, true), "lost");
  assert.equal(statusMeta("job", "lost").label, "Lost");
  assert.equal(statusMeta("job", "unverified").label, "Unverified");
  assert.equal(backgroundJobCurrentState(baseJob, undefined, true, true), "unverified",
    "a source-present row cannot claim Running without a current aggregate lifecycle");
  // A listed job past the stall bound is reported as stalled, from the control plane's mark or
  // from the clock, and never declared ended (#1651).
  assert.equal(backgroundJobCurrentState({ ...baseJob, stalledSince: 3_601_000 }, "running", true, true), "stalled");
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true, 1_000 + 3_600_000), "stalled");
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true, 1_000 + 3_599_000), "running");
  assert.equal(backgroundJobCurrentState({ ...baseJob, stalledSince: 3_601_000 }, "running", false, true), "unverified",
    "an offline runner cannot confirm a stalled job any more than a running one");
});

test("every watchdog is one notice at the top of its highlighted group, and its details wait for Show Details (#2859)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const cases = [
    ["terminal_without_continuation", null, "Returning the result of a background job to this conversation."],
    ["continuation_blocked", "Result Blocked",
      "A background job finished, but its result can't be returned while another job from the same turn is still running."],
    ["accepted_without_result", "Result Missing",
      "A background job finished, but its result never reached this conversation. Wollipog won't retry on its own, so the step can't run twice."],
    ["result_not_projected", null, "The result of a background job reached Wollipog and is being added to this conversation."],
    ["dashboard_observation_pending", null, "Confirming that this dashboard shows the result of a background job."],
  ] as const;
  try {
    for (const [watchdogState, title, sentence] of cases) {
      await act(async () => root.render(
        <BackgroundWorkPanel
          session={{
            id: "session",
            runnerId: "runner",
            backgroundWorkTracking: "managed",
            backgroundJobs: [],
            backgroundDeliveries: [{
              parentTurnId: "turn-1",
              jobCount: 1,
              terminalCount: 1,
              watchdogState,
            }],
          } as unknown as SessionView}
          runnerOnline
          runnerProtocolVersion={PROTOCOL_VERSION}
          parentTurns={new Map()}
        />,
      ));
      const highlighted = container.querySelector<HTMLElement>(".background-work-turn[data-watchdog-highlighted]");
      assert.equal(highlighted?.dataset["watchdogState"], watchdogState);
      assert.equal(highlighted?.dataset["watchdogHighlighted"], "true");
      const notices = [...highlighted!.querySelectorAll<HTMLElement>(".notice")];
      assert.equal(notices.length, 1, `${watchdogState}: one notice`);
      const notice = notices[0]!;
      assert.equal(notice.dataset["state"], watchdogState);
      assert.equal(notice.previousElementSibling?.classList.contains("background-work-turn-head"), true,
        "the notice is at the top of its group, under the turn's heading");
      assertNoDomNode(highlighted!.querySelector(".background-delivery-summary"));
      assertNoDomNode(highlighted!.querySelector("details"), "no Technical Details disclosure remains");
      assert.doesNotMatch(highlighted!.textContent ?? "", /Completed|Still Pending|Your Action|Recovery State/u);
      assertNoDomNode(highlighted!.querySelector(".row-title"), "the notice stands in for its receipt's row");
      if (title === null) {
        assert.ok(notice.classList.contains("compact") && notice.classList.contains("t-info"), `${watchdogState}: compact info`);
        assert.equal(notice.querySelector(".notice-body")?.textContent, sentence);
        assert.equal(notice.querySelectorAll("button").length, 0, "a result on its way asks nothing of the person");
        continue;
      }
      assert.ok(notice.classList.contains("t-warning"), `${watchdogState}: warning`);
      assert.equal(notice.querySelector(".notice-title")?.textContent, title);
      assert.equal(notice.querySelector(".notice-body p")?.textContent, sentence);
      assertNoDomNode(notice.querySelector(".notice-details-body"), "the details are not in the DOM until opened");
      const toggle = notice.querySelector<HTMLButtonElement>(".notice-details-toggle")!;
      assert.equal(toggle.textContent, "Show Details");
      await act(async () => toggle.click());
      assert.equal(toggle.textContent, "Hide Details");
      assert.equal(notice.querySelector(".notice-details-body code")?.textContent, watchdogState);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("only the group holding the watchdog delivery is highlighted, and none without a watchdog (#1793)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  // Groups list newest first, so turn-3 renders first and turn-2, the watchdog's, second.
  const completedJob = (id: string, parentTurnId: string, registeredAt: number): ManagedBackgroundJobView => ({
    ...baseJob,
    id,
    parentTurnId,
    registeredAt,
    terminalStatus: "completed",
    terminalObservedAt: registeredAt + 100,
    continuationRequired: true,
    assistantResultPersistedAt: registeredAt + 200,
  });
  const render = (backgroundDeliveries: SessionView["backgroundDeliveries"]) => act(async () => root.render(
    <BackgroundWorkPanel
      session={{
        id: "session",
        runnerId: "runner",
        backgroundWorkTracking: "managed",
        backgroundJobs: [
          completedJob("job-1", "turn-1", 1_000),
          completedJob("job-2", "turn-2", 2_000),
          completedJob("job-3", "turn-3", 3_000),
        ],
        backgroundDeliveries,
      } as SessionView}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      parentTurns={new Map()}
    />,
  ));
  const groups = () => [...container.querySelectorAll<HTMLElement>(".background-work-turn")];
  // Plain values per group, so a failure reports markers instead of inspecting DOM nodes.
  const markers = () => groups().map((group) => ({
    watchdogHighlighted: group.getAttribute("data-watchdog-highlighted"),
    ariaCurrent: group.getAttribute("aria-current"),
    watchdogState: group.getAttribute("data-watchdog-state"),
  }));
  const unmarked = { watchdogHighlighted: null, ariaCurrent: null, watchdogState: null };
  try {
    await render([]);
    assert.deepEqual(markers(), [unmarked, unmarked, unmarked],
      "healthy history without a watchdog highlights no group");

    await render([{
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
    }, {
      parentTurnId: "turn-2",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "result_not_projected",
    }, {
      parentTurnId: "turn-3",
      jobCount: 1,
      terminalCount: 1,
    }]);
    assert.deepEqual(markers(), [unmarked, {
      watchdogHighlighted: "true",
      ariaCurrent: "true",
      watchdogState: "result_not_projected",
    }, unmarked], "only the group holding the watchdog delivery is highlighted");

    // #2329: the control plane lists retained deliveries before Result Blocked ones, so a pending
    // delivery can come first; the highlight follows the one that waits on the person.
    const highlighted = (watchdogState: string) => ({
      watchdogHighlighted: "true", ariaCurrent: "true", watchdogState,
    });
    const passive = (watchdogState: string) => ({ ...unmarked, watchdogState });
    await render([{
      continuationId: "bgcont-pending",
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "dashboard_observation_pending",
    }, {
      parentTurnId: "turn-2",
      jobCount: 2,
      terminalCount: 1,
      watchdogState: "continuation_blocked",
    }]);
    assert.deepEqual(markers(), [unmarked, highlighted("continuation_blocked"), passive("dashboard_observation_pending")],
      "the blocked group is highlighted, not the pending one listed first");

    await render([{
      continuationId: "bgcont-pending",
      parentTurnId: "turn-2",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "dashboard_observation_pending",
    }, {
      parentTurnId: "turn-2",
      jobCount: 2,
      terminalCount: 1,
      watchdogState: "continuation_blocked",
    }]);
    assert.deepEqual(markers(), [unmarked, highlighted("continuation_blocked"), unmarked],
      "within one group, the group names the blocked delivery too");

    await render([{
      continuationId: "bgcont-pending",
      parentTurnId: "turn-1",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "dashboard_observation_pending",
    }, {
      parentTurnId: "turn-2",
      jobCount: 1,
      terminalCount: 1,
      watchdogState: "result_not_projected",
    }]);
    assert.deepEqual(markers(), [unmarked, passive("result_not_projected"), highlighted("dashboard_observation_pending")],
      "with only pending deliveries, the first listed stays highlighted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** The Acknowledge buttons on screen. */
const acknowledgeButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>("button")]
  .filter((button) => button.textContent === "Acknowledge");

test("each missing result is its own notice, acknowledged on its own, and never offers a retry (#2275, #2859)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const acknowledged: Array<[string, string]> = [];
  const client = {
    acknowledgeBackgroundMissingResult: async (sessionId: string, continuationId: string) => {
      acknowledged.push([sessionId, continuationId]);
      return {} as SessionView;
    },
  } as unknown as ApiClient;
  const delivery = (continuationId: string, missingResultAt: number) => ({
    continuationId,
    parentTurnId: "turn-1",
    jobCount: 1,
    terminalCount: 1,
    acceptedAt: missingResultAt - 1_000,
    missingResultAt,
    watchdogState: "accepted_without_result" as const,
  });
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <BackgroundWorkPanel
          session={{
            id: "session",
            runnerId: "runner",
            backgroundWorkTracking: "managed",
            backgroundJobs: [],
            backgroundDeliveries: [delivery("bgcont-a", 10_000), delivery("bgcont-b", 20_000)],
          } as unknown as SessionView}
          runnerOnline
          runnerProtocolVersion={PROTOCOL_VERSION}
          parentTurns={new Map()}
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelectorAll('.notice[data-state="accepted_without_result"]').length, 2);
    assert.equal(acknowledgeButtons(container).length, 2);
    await act(async () => {
      acknowledgeButtons(container)[0]!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(acknowledged, [["session", "bgcont-a"]]);
    assert.equal(acknowledgeButtons(container).length, 1,
      "acknowledging one leaves the other independently actionable");
    assert.equal(container.querySelectorAll('.notice[data-state="accepted_without_result"]').length, 1);
    assert.deepEqual([...container.querySelectorAll(".background-job-row .status")].map((badge) => badge.textContent),
      ["Missing Result Acknowledged"], "the acknowledged receipt returns as a row");
    assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => /retry|rerun/iu.test(button.textContent ?? "")), false,
    "acknowledgement never offers replay");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("missing-result feedback stays with its session across same-id rerenders and overlapping requests", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const requests: Array<{
    sessionId: string;
    resolve: (value: SessionView) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const client = {
    acknowledgeBackgroundMissingResult: (sessionId: string) => new Promise<SessionView>((resolve, reject) => {
      requests.push({ sessionId, resolve, reject });
    }),
  } as unknown as ApiClient;
  const renderSession = (sessionId: string, missingResultAcknowledgedAt?: number) => root.render(
    <ApiProvider client={client}>
      <BackgroundWorkPanel
        session={{
          id: sessionId,
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobs: [],
          backgroundDeliveries: [{
            continuationId: "bgcont-shared",
            parentTurnId: `turn-${sessionId}`,
            jobCount: 1,
            terminalCount: 1,
            acceptedAt: 10_000,
            missingResultAt: 20_000,
            missingResultAcknowledgedAt,
            watchdogState: "accepted_without_result",
          }],
        } as unknown as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurns={new Map()}
      />
    </ApiProvider>
  );
  const button = () => acknowledgeButtons(container)[0] ?? null;
  const busy = () => button()?.getAttribute("aria-busy") === "true";
  const groupStatus = () => container.querySelector(".background-work-turn-head .status")?.textContent ?? null;
  try {
    await act(async () => renderSession("session-a"));
    await act(async () => {
      button()!.click();
      await Promise.resolve();
    });
    assert.equal(requests[0]?.sessionId, "session-a");
    assert.equal(busy(), true);
    assert.equal(button()!.textContent, "Acknowledge", "the label stays while busy");

    await act(async () => renderSession("session-b"));
    assert.equal(busy(), false,
      "session A's same-id request must not make session B look busy");
    await act(async () => {
      button()!.click();
      await Promise.resolve();
    });
    assert.deepEqual(requests.map((request) => request.sessionId), ["session-a", "session-b"]);
    assert.equal(busy(), true);

    await act(async () => {
      requests[0]!.reject(new Error("Session A acknowledgement failed."));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(busy(), true,
      "session A's late settlement must not clear session B's newer request");
    assertNoDomNode(container.querySelector('[role="alert"]'),
      "session A's late error must not appear in session B");

    await act(async () => {
      requests[1]!.resolve({} as SessionView);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(groupStatus(), "Missing Result Acknowledged",
      "session B retains its own successful optimistic acknowledgement");
    assertNoDomNode(container.querySelector(".notice"), "the notice is replaced by the group's status");

    await act(async () => renderSession("session-c", 30_000));
    assert.equal(groupStatus(), "Missing Result Acknowledged",
      "a durable server acknowledgement remains authoritative without local state");
    assertNoDomNode(button());

    await act(async () => renderSession("session-a"));
    assert.equal(container.querySelector('[role="alert"]')?.textContent,
      "Session A acknowledgement failed.",
      "the late error remains available only in its originating session");
    assert.equal(busy(), false);

    await act(async () => renderSession("session-a", 30_000));
    assert.equal(groupStatus(), "Missing Result Acknowledged",
      "durable acknowledgement supersedes the same session's transient failure");
    assertNoDomNode(container.querySelector('[role="alert"]'),
      "durable acknowledgement clears the stale local error from view");
    assertNoDomNode(button());
  } finally {
    for (const request of requests) request.resolve({} as SessionView);
    await act(async () => root.unmount());
    container.remove();
  }
});

test("terminal missing history remains actionable without a watchdog but yields to late proof", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const client = {
    acknowledgeBackgroundMissingResult: async () => ({} as SessionView),
  } as unknown as ApiClient;
  const missingDelivery = {
    continuationId: "bgcont-suppressed",
    parentTurnId: "turn-suppressed",
    jobCount: 1,
    terminalCount: 1,
    acceptedAt: 10_000,
    missingResultAt: 20_000,
  };
  const render = (delivery: typeof missingDelivery & { runnerResultPersistedAt?: number }) => root.render(
    <ApiProvider client={client}>
      <BackgroundWorkPanel
        session={{
          id: "session-suppressed",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobs: [],
          backgroundDeliveries: [delivery],
        } as unknown as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurns={new Map()}
      />
    </ApiProvider>
  );
  try {
    await act(async () => render(missingDelivery));
    assert.equal(container.querySelector(".notice-title")?.textContent, "Result Missing");
    assert.equal(acknowledgeButtons(container).length, 1,
      "terminal missing audit remains resolvable when attention is suppressed");
    await act(async () => {
      acknowledgeButtons(container)[0]!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      container.querySelector(".background-work-turn-head .status")?.textContent,
      "Missing Result Acknowledged",
      "the group's status follows the successful optimistic acknowledgement",
    );
    await act(async () => render({ ...missingDelivery, runnerResultPersistedAt: 30_000 }));
    assert.doesNotMatch(container.textContent ?? "", /Result Missing/);
    assert.equal(container.querySelector(".background-work-turn-head .status")?.textContent, "Result Returned");
    assert.equal(container.querySelectorAll<HTMLButtonElement>("button").length, 0,
      "late delivery proof is authoritative and needs no acknowledgement");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const MINUTE = 60_000;

/** Renders the panel alone (outside the side panel, so it keeps its own page stack) and cleans up. */
async function mountBackgroundWork(props: Partial<BackgroundWorkPanelProps> & { session: SessionView }, client = {} as ApiClient) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (next: Partial<BackgroundWorkPanelProps> & { session: SessionView }) => act(async () => root.render(
    <ApiProvider client={client}>
      <BackgroundWorkPanel runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} parentTurns={new Map()} {...next} />
    </ApiProvider>,
  ));
  await render(props);
  return {
    container,
    render,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function managedSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session",
    runnerId: "runner",
    driver: "claude-code",
    backgroundWorkTracking: "managed",
    backgroundWorkState: "running",
    backgroundJobs: [],
    backgroundDeliveries: [],
    ...overrides,
  } as unknown as SessionView;
}

const headings = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".background-work-turn-head")]
  .map((head) => ({
    title: head.querySelector("h3")?.textContent,
    status: head.querySelector(".status.inline")?.textContent,
    viewTurn: head.querySelector("button")?.textContent ?? null,
  }));

test("groups are the transcript's turns, newest first, each with its status and View Turn (#2858)", async () => {
  const now = Date.now();
  const viewed: string[] = [];
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobs: [
        { ...baseJob, id: "job-turn-2", parentTurnId: "turn-2", launchType: "shell", registeredAt: now - 30 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 29 * MINUTE, continuationRequired: true,
          assistantResultPersistedAt: now - 28 * MINUTE },
        { ...baseJob, id: "job-turn-4", parentTurnId: "turn-4", launchType: "monitor", registeredAt: now - 5 * MINUTE },
        { ...baseJob, id: "job-earlier", parentTurnId: "turn-1", launchType: "shell", registeredAt: now - 60 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 59 * MINUTE, continuationRequired: false },
        { ...baseJob, id: "job-unknown", parentTurnId: "unknown", launchType: "agent", registeredAt: now - 90 * MINUTE },
      ],
    }),
    parentTurns: new Map([["turn-2", { eventId: 20, turn: 2 }], ["turn-4", { eventId: 40, turn: 4 }]]),
    earlierActivityUnloaded: true,
    onViewTurn: (turnId) => viewed.push(turnId),
  });
  try {
    assert.deepEqual(headings(panel.container), [
      { title: "Turn 4", status: "Waiting for 1 Job", viewTurn: "View Turn" },
      { title: "Turn 2", status: "Result Returned", viewTurn: "View Turn" },
      { title: "Earlier Turn", status: "Result Returned", viewTurn: "View Turn" },
      { title: "Unknown Turn", status: "Unverified", viewTurn: null },
    ]);
    const viewButtons = [...panel.container.querySelectorAll<HTMLButtonElement>(".background-work-view-turn")];
    assert.ok(viewButtons.every((button) => button.classList.contains("btn") && button.classList.contains("sm") &&
      button.classList.contains("ghost")));
    // Each View Turn is described by its own turn's heading, so a reader hears which turn it opens.
    assert.equal(domWindow.document.getElementById(viewButtons[0]!.getAttribute("aria-describedby")!)?.textContent, "Turn 4");
    for (const button of viewButtons) await act(async () => button.click());
    assert.deepEqual(viewed, ["turn-4", "turn-2", "turn-1"], "an unloaded turn is still viewable while earlier activity can load");

    // With the whole transcript loaded, a turn that is not in it cannot be viewed.
    await panel.render({
      session: managedSession({ backgroundJobs: [{ ...baseJob, id: "job-earlier", parentTurnId: "turn-1" }] }),
      parentTurns: new Map(),
      onViewTurn: (turnId) => viewed.push(turnId),
    });
    assert.deepEqual(headings(panel.container), [{ title: "Earlier Turn", status: "Waiting for 1 Job", viewTurn: null }]);
  } finally {
    await panel.dispose();
  }
});

test("a job row is its name with a six-character id, its badge, one sentence and its duration (#2858)", async () => {
  const now = Date.now();
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobs: [
        { ...baseJob, id: "job-shell-a1f3c9", parentTurnId: "turn-2", launchType: "shell", registeredAt: now - 10 * MINUTE },
        { ...baseJob, id: "job-shell-7be210", parentTurnId: "turn-2", launchType: "shell", registeredAt: now - 12 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 11 * MINUTE, continuationRequired: true },
        { ...baseJob, id: "job-agent-04d2e1", parentTurnId: "turn-1", launchType: "agent", registeredAt: now - 60 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 55 * MINUTE, continuationRequired: true,
          assistantResultPersistedAt: now - 50 * MINUTE },
        { ...baseJob, id: "job-shell-0aa111", parentTurnId: "turn-1", launchType: "shell", registeredAt: now - 61 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 58 * MINUTE, continuationRequired: true,
          assistantResultPersistedAt: now - 50 * MINUTE },
      ],
    }),
    parentTurns: new Map([["turn-1", { eventId: 10, turn: 1 }], ["turn-2", { eventId: 20, turn: 2 }]]),
  });
  try {
    const rows = [...panel.container.querySelectorAll<HTMLButtonElement>("button.background-job-row")];
    const read = (row: HTMLElement) => ({
      title: row.querySelector(".row-title")?.textContent,
      id: row.querySelector(".row-title .mono")?.textContent,
      badge: row.querySelector(".status")?.textContent,
      sentence: row.querySelector(".row-sub")?.textContent,
      duration: row.querySelector(".row-trail")?.textContent,
    });
    assert.deepEqual(rows.map(read), [
      { title: "Shell Job 7be210", id: "7be210", badge: "Completed", sentence: "Result waits for the other job", duration: "1m 0s" },
      { title: "Shell Job a1f3c9", id: "a1f3c9", badge: "Running", sentence: "Started 10m ago", duration: "10m 0s" },
      { title: "Shell Job 0aa111", id: "0aa111", badge: "Completed", sentence: "Result returned 50m ago", duration: "3m 0s" },
      { title: "Agent Job 04d2e1", id: "04d2e1", badge: "Completed", sentence: "Result returned 50m ago", duration: "5m 0s" },
    ]);
    assert.equal(new Set(rows.map((row) => row.querySelector(".row-title")?.textContent)).size, rows.length,
      "no two jobs share a name, even of one kind in different turns");
    for (const row of rows) {
      assert.ok(row.classList.contains("row") && row.classList.contains("row-2"), "the §5.2 two-line row");
      assert.equal(row.dataset["panelPageKey"], `background:${rows.indexOf(row) === 0 ? "job-shell-7be210"
        : rows.indexOf(row) === 1 ? "job-shell-a1f3c9" : rows.indexOf(row) === 2 ? "job-shell-0aa111" : "job-agent-04d2e1"}`);
    }

    // Offline, a job the runner cannot vouch for reads when it was last seen.
    await panel.render({
      session: managedSession({
        backgroundJobs: [{ ...baseJob, id: "job-shell-a1f3c9", parentTurnId: "turn-2", launchType: "shell",
          registeredAt: now - 20 * MINUTE, lastObservedAt: now - 12 * MINUTE }],
      }),
      runnerOnline: false,
      parentTurns: new Map([["turn-2", { eventId: 20, turn: 2 }]]),
    });
    const offline = panel.container.querySelector<HTMLElement>("button.background-job-row")!;
    assert.equal(read(offline).badge, "Unverified");
    assert.equal(read(offline).sentence, "Last seen 12m ago");
  } finally {
    await panel.dispose();
  }
});

test("selecting a job opens its Job Detail page in place of the list, which waits hidden (#2858)", async () => {
  const now = Date.now();
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobs: [{ ...baseJob, id: "job-shell-a1f3c9", parentTurnId: "turn-4", launchType: "shell", registeredAt: now - 10 * MINUTE }],
    }),
    parentTurns: new Map([["turn-4", { eventId: 40, turn: 4 }]]),
  });
  try {
    assertNoDomNode(panel.container.querySelector(".job-detail"));
    await act(async () => panel.container.querySelector<HTMLButtonElement>("button.background-job-row")!.click());
    assert.ok(panel.container.querySelector<HTMLElement>(".background-work-panel")!.hidden, "the list stays mounted, hidden");
    const page = panel.container.querySelector<HTMLElement>(".background-work-page .job-detail");
    assert.equal(page?.getAttribute("aria-label"), "Shell Job a1f3c9");
    const facts = Object.fromEntries([...page!.querySelectorAll(".facts > div")].map((entry) =>
      [entry.querySelector("dt")?.textContent, entry.querySelector("dd")?.textContent]));
    assert.deepEqual(Object.keys(facts), ["Started", "Running For", "Last Activity", "Result", "Started By"]);
    assert.match(facts.Started ?? "", /^10m ago at \d{1,2}:\d{2}/u);
    assert.equal(facts.Result, "Returns to this conversation when the job finishes");
    assert.equal(facts["Started By"], "Turn 4");
  } finally {
    await panel.dispose();
  }
});

test("the list's copy has no barrier, terminal, continuation, parent-turn or evidence words, and labels are Title Case (#2858)", async () => {
  const now = Date.now();
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobsTruncated: true,
      backgroundJobs: [
        { ...baseJob, id: "job-c0ffe1", parentTurnId: "turn-1", launchType: "shell", registeredAt: now - 9 * MINUTE },
        { ...baseJob, id: "job-c0ffe2", parentTurnId: "turn-1", launchType: "monitor", registeredAt: now - 8 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 7 * MINUTE, continuationRequired: true },
        { ...baseJob, id: "job-c0ffe3", parentTurnId: "turn-2", launchType: "workflow", registeredAt: now - 6 * MINUTE,
          terminalStatus: "failed", terminalObservedAt: now - 5 * MINUTE, continuationRequired: true,
          continuationQueuedAt: now - 4 * MINUTE },
        { ...baseJob, id: "job-c0ffe4", parentTurnId: "unknown", launchType: "unknown", registeredAt: now - 3 * MINUTE },
      ],
      backgroundDeliveries: [
        { parentTurnId: "turn-3", jobCount: 2, terminalCount: 2, runnerResultPersistedAt: now - 2 * MINUTE },
      ],
    }),
    parentTurns: new Map([["turn-1", { eventId: 10, turn: 1 }], ["turn-2", { eventId: 20, turn: 2 }]]),
    onViewTurn: () => undefined,
  });
  try {
    const text = panel.container.textContent ?? "";
    assert.doesNotMatch(text, /barrier|terminal|continuation|parent turn|evidence|delivery|lifecycle/iu);
    assert.match(text, /Showing the 128 most recent jobs\./u);
    assert.equal(panel.container.querySelector(".list-foot")?.textContent, "Showing the 128 most recent jobs.");
    const minor = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
    const labels = [
      ...panel.container.querySelectorAll(".background-work-turn-head h3, .status, button.btn, .row-title"),
    ].map((element) => element.textContent ?? "");
    for (const label of labels) {
      for (const word of label.split(/\s+/u).filter(Boolean)) {
        if (minor.has(word) || /^[0-9a-f]{6}$/u.test(word) || /^\d/u.test(word)) continue;
        assert.match(word, /^[A-Z]/u, `"${word}" in "${label}" is Title Case`);
      }
    }
    for (const sentence of [...panel.container.querySelectorAll(".row-sub")].map((element) => element.textContent ?? "")) {
      assert.match(sentence, /^[A-Z0-9][^A-Z]*$/u, `"${sentence}" is sentence case`);
    }
    assert.deepEqual([...panel.container.querySelectorAll(".row-title")].map((title) => title.textContent),
      ["Result Receipt", "Background Job c0ffe4", "Workflow Job c0ffe3", "Shell Job c0ffe1", "Monitor Job c0ffe2"]);
  } finally {
    await panel.dispose();
  }
});

test("receipt-only turns list one Result Receipt row per receipt with its stage (#2858)", async () => {
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobsTruncated: true,
      backgroundDeliveries: [{
        continuationId: "private-continuation",
        parentTurnId: "retained-parent",
        jobCount: 3,
        terminalCount: 3,
        queuedAt: 3_000,
        acceptedAt: 3_100,
        runnerResultPersistedAt: 3_200,
        notificationQueuedAt: 3_300,
      }, {
        parentTurnId: "retained-parent",
        jobCount: 1,
        terminalCount: 1,
        queuedAt: 4_000,
      }],
    } as Partial<SessionView>),
    parentTurns: new Map([["retained-parent", { eventId: 77, turn: 3 }]]),
  });
  try {
    assert.equal(panel.container.querySelectorAll(".background-work-turn").length, 1);
    assert.deepEqual(headings(panel.container), [{ title: "Turn 3", status: "Result Returned", viewTurn: null }]);
    const receipts = [...panel.container.querySelectorAll<HTMLElement>(".background-job-row")];
    assert.deepEqual(receipts.map((row) => [row.tagName, row.querySelector(".row-title")?.textContent,
      row.querySelector(".status")?.textContent, row.querySelector(".row-sub")?.textContent]), [
      ["DIV", "Result Receipt", "Result Returned", "3 of 3 jobs finished"],
      ["DIV", "Result Receipt", "Returning Result", "1 of 1 job finished"],
    ], "a receipt is not a job, so it opens no page");
    assert.doesNotMatch(panel.container.textContent ?? "", /Running|Completed|Failed|Killed|Lost|private-continuation|retained-parent/u);
  } finally {
    await panel.dispose();
  }
});

test("a turn's status: waiting, some finished, partly listed, returned (#2858)", async () => {
  const panel = await mountBackgroundWork({
    session: managedSession({
      backgroundJobsTruncated: true,
      backgroundJobs: [{ ...baseJob, terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true,
        continuationId: "continuation", assistantResultPersistedAt: 4_000 }],
      backgroundDeliveries: [{ continuationId: "continuation", parentTurnId: "turn-1", jobCount: 200, terminalCount: 199 }],
    }),
  });
  try {
    assert.deepEqual(headings(panel.container).map((heading) => heading.status), ["199 of 200 Finished"],
      "counts include the jobs outside the bounded list");
    await panel.render({
      session: managedSession({
        backgroundJobs: [
          { ...baseJob, terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true,
            continuationId: "continuation-1", assistantResultPersistedAt: 4_000 },
          { ...baseJob, id: "job-2", registeredAt: 5_000, terminalStatus: "completed", terminalObservedAt: 6_000,
            continuationRequired: true, continuationId: "continuation-2", assistantResultPersistedAt: 7_000 },
        ],
        backgroundDeliveries: [
          { continuationId: "continuation-1", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, runnerResultPersistedAt: 4_000 },
          { continuationId: "continuation-2", parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, runnerResultPersistedAt: 7_000 },
        ],
      }),
    });
    assert.deepEqual(headings(panel.container).map((heading) => heading.status), ["Result Returned"],
      "two rounds under one turn use their combined totals");
    await panel.render({
      session: managedSession({
        backgroundJobs: [
          { ...baseJob, id: "a" }, { ...baseJob, id: "b", registeredAt: 1_100 },
        ],
      }),
    });
    assert.deepEqual(headings(panel.container).map((heading) => heading.status), ["Waiting for 2 Jobs"]);
  } finally {
    await panel.dispose();
  }
});

test("each state is one notice or one compact state, in priority order (#2858)", async () => {
  const panel = await mountBackgroundWork({
    session: managedSession({ backgroundJobs: [{ ...baseJob, id: "job-shell-a1f3c9", launchType: "shell" }] }),
    runnerOnline: false,
    machineName: "Studio Workstation",
  });
  const text = () => panel.container.textContent ?? "";
  try {
    // Offline: one notice names the machine, over the last-known list, and nothing else warns.
    const notices = [...panel.container.querySelectorAll(".notice")];
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.textContent ?? "", /Studio Workstation is offline\. Finished jobs are shown; running jobs can't be checked\./u);
    assert.equal(panel.container.querySelectorAll(".hint.warn, [role='alert']").length, 0, "no second warning in the list");
    assert.equal(panel.container.querySelectorAll("button.background-job-row").length, 1);

    // Loading: nothing for 300ms, then skeleton rows at the row height.
    await panel.render({ session: managedSession({ backgroundJobsAvailable: true, backgroundJobs: undefined }) });
    assertNoDomNode(panel.container.querySelector(".background-work-skeleton"), "nothing new under 300ms");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, BACKGROUND_WORK_SKELETON_DELAY_MS + 50)); });
    const skeleton = panel.container.querySelector(".background-work-skeleton");
    assert.ok(skeleton, "skeleton rows after 300ms");
    assert.equal(skeleton!.querySelectorAll(".row.row-2").length, 3);
    assert.match(skeleton!.textContent ?? "", /Loading background work…/u);

    // A failed load: one danger state with Retry and the response behind Show Details.
    let retries = 0;
    await panel.render({
      session: managedSession({ backgroundJobsAvailable: true, backgroundJobs: undefined }),
      inventoryError: "502 Bad Gateway from runner",
      onRetryInventory: () => { retries += 1; },
    });
    assert.match(text(), /Couldn't Load Background Work/u);
    assert.match(text(), /The machine's list of background jobs didn't load\./u);
    assert.doesNotMatch(text(), /502 Bad Gateway/u, "the response waits behind Show Details");
    const buttons = () => [...panel.container.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => buttons().find((button) => button.textContent === "Retry")!.click());
    assert.equal(retries, 1);
    await act(async () => buttons().find((button) => button.textContent === "Show Details")!.click());
    assert.match(text(), /502 Bad Gateway from runner/u);

    // Not tracked: one message with Open Terminal, and no promise that jobs will appear.
    let terminals = 0;
    await panel.render({
      session: managedSession({ driver: "codex", backgroundWorkTracking: "untracked", backgroundWorkState: undefined } as Partial<SessionView>),
      onOpenTerminal: () => { terminals += 1; },
      runnerOnline: false,
    });
    assert.match(text(), /Background Work Isn't Tracked/u);
    assert.match(text(), /Codex CLI doesn't report background jobs, so Wollipog can't list them or tell when they finish\./u);
    assert.doesNotMatch(text(), /will appear here|show up here/u);
    assert.equal(panel.container.querySelectorAll(".notice").length, 0, "an untracked session has no offline notice to show");
    await act(async () => buttons().find((button) => button.textContent === "Open Terminal")!.click());
    assert.equal(terminals, 1);

    // An older runner: one state naming the machine, with Open Machine.
    let machines = 0;
    await panel.render({
      session: managedSession(),
      runnerProtocolVersion: 81,
      machineName: "Studio Workstation",
      onOpenMachine: () => { machines += 1; },
    });
    assert.match(text(), /Studio Workstation's runner is too old to list individual jobs\./u);
    await act(async () => buttons().find((button) => button.textContent === "Open Machine")!.click());
    assert.equal(machines, 1);

    // Empty.
    await panel.render({ session: managedSession({ backgroundJobsAvailable: true, backgroundWorkState: undefined }) });
    assert.match(text(), /No Background Work/u);
    assert.match(text(), /Jobs the agent leaves running after a turn show up here, grouped by the turn that started them\./u);
  } finally {
    await panel.dispose();
  }
});

test("About Background Work holds the privacy text, and no privacy footnote or card chrome remains (#2858)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const happySlot = domWindow.document.createElement("div");
  domWindow.document.body.append(happySlot);
  const slot = happySlot as unknown as HTMLElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <PanelActionSlotContext.Provider value={slot}>
        <BackgroundWorkPanel session={managedSession()} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
          parentTurns={new Map()} machineName="Studio Workstation" />
      </PanelActionSlotContext.Provider>,
    ));
    assertNoDomNode(container.querySelector(".background-work-privacy"));
    const about = slot.querySelector<HTMLButtonElement>('button[aria-label="About Background Work"]');
    assert.ok(about, "the About popover's button is in the panel header's action slot");
    await act(async () => about!.click());
    const popover = domWindow.document.querySelector('[role="dialog"][aria-label="About Background Work"]');
    assert.match(popover?.textContent ?? "", /Jobs the agent leaves running after a turn, grouped by the turn that started them\. When they finish, their result returns to this conversation\./u);
    assert.match(popover?.textContent ?? "", /Commands, file paths, credentials and output stay on Studio Workstation\. Wollipog only shows timing and status\./u);
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    for (const retired of [".background-work-privacy", ".background-work-barrier", ".background-work-group",
      ".background-work-job-confirm", ".background-work-link-unavailable"]) {
      assert.equal(css.includes(retired), false, `${retired} is gone from styles.css`);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    happySlot.remove();
  }
});

/** A turn whose shell job finished but whose result never arrived (#2859). */
function missingResultSession(id: string, overrides: Partial<SessionView> = {}): SessionView {
  const now = Date.now();
  return managedSession({
    id,
    backgroundWorkState: undefined,
    backgroundJobs: [{
      ...baseJob, id: "task-a1f3c9", parentTurnId: "turn-4", launchType: "shell", registeredAt: now - 20 * MINUTE,
      lastObservedAt: now - 15 * MINUTE, terminalStatus: "completed", terminalObservedAt: now - 15 * MINUTE,
      continuationRequired: true, continuationId: "bgcont-missing", continuationAcceptedAt: now - 14 * MINUTE,
      continuationMissingResultAt: now - 12 * MINUTE,
    }],
    backgroundDeliveries: [{
      continuationId: "bgcont-missing", parentTurnId: "turn-4", jobCount: 1, terminalCount: 1,
      acceptedAt: now - 14 * MINUTE, missingResultAt: now - 12 * MINUTE, watchdogState: "accepted_without_result",
    }],
    ...overrides,
  } as Partial<SessionView>);
}

test("Result Missing is one title, one sentence naming the job and Acknowledge, and says Result Missing once in its group (#2859)", async () => {
  const panel = await mountBackgroundWork({
    session: missingResultSession("session-missing-once"),
    parentTurns: new Map([["turn-4", { eventId: 40, turn: 4 }]]),
    onViewTurn: () => undefined,
  }, { acknowledgeBackgroundMissingResult: async () => ({} as SessionView) } as unknown as ApiClient);
  try {
    const group = panel.container.querySelector<HTMLElement>(".background-work-turn")!;
    assert.equal((group.textContent ?? "").split("Result Missing").length - 1, 1, "the state word appears once in the group");
    const notice = group.querySelector<HTMLElement>(".notice")!;
    assert.ok(notice.classList.contains("t-warning"));
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Result Missing");
    assert.deepEqual([...notice.querySelectorAll(".notice-body p")].map((line) => line.textContent), [
      "Shell job a1f3c9 finished, but its result never reached this conversation. Wollipog won't retry on its own, so the step can't run twice.",
    ]);
    assert.deepEqual([...notice.querySelectorAll<HTMLButtonElement>(".notice-actions button")].map((button) => button.textContent),
      ["Acknowledge", "Show Details"], "Acknowledge first, then Show Details");
    const acknowledge = notice.querySelector<HTMLButtonElement>(".notice-actions button")!;
    assert.ok(acknowledge.classList.contains("btn") && acknowledge.classList.contains("sm"));
    assert.equal(acknowledge.classList.contains("ghost"), false, "Acknowledge is the resolving .btn.sm, not a ghost");
    assertNoDomNode(group.querySelector(".background-work-turn-head .status"),
      "the notice stands for the group's status until it is acknowledged");
    assert.equal(group.querySelector(".background-job-row .row-sub")?.textContent, "Result never arrived");

    // Show Details: Finished, Missing Since, Acknowledge and Diagnostic, and nothing before it opens.
    assertNoDomNode(notice.querySelector(".facts"), "the details are not in the DOM until opened");
    const toggle = notice.querySelector<HTMLButtonElement>(".notice-details-toggle")!;
    await act(async () => toggle.click());
    assert.equal(toggle.textContent, "Hide Details");
    const facts = Object.fromEntries([...notice.querySelectorAll(".facts > div")].map((pair) =>
      [pair.querySelector("dt")?.textContent, pair.querySelector("dd")?.textContent]));
    assert.deepEqual(Object.keys(facts), ["Finished", "Missing Since", "Acknowledge", "Diagnostic"]);
    assert.equal(facts["Finished"], "15m ago");
    assert.equal(facts["Missing Since"], "12m ago");
    assert.equal(facts["Acknowledge"], "Clears the alert. It doesn't rerun the job or resend the result.");
    assert.equal(facts["Diagnostic"],
      "accepted_without_result The accepted provider turn ended without a durable delivery receipt.");
    assert.equal(notice.querySelector(".facts code")?.textContent, "accepted_without_result");
    await act(async () => toggle.click());
    assertNoDomNode(notice.querySelector(".facts"), "Hide Details removes them again");
  } finally {
    await panel.dispose();
  }
});

test("Acknowledge is busy, then the group reads Missing Result Acknowledged; a failure shows under the actions and keeps the notice (#2859)", async () => {
  let settle: { resolve: (value: SessionView) => void; reject: (reason: unknown) => void } | null = null;
  const client = {
    acknowledgeBackgroundMissingResult: () => new Promise<SessionView>((resolve, reject) => { settle = { resolve, reject }; }),
  } as unknown as ApiClient;
  const panel = await mountBackgroundWork({ session: missingResultSession("session-acknowledge-busy") }, client);
  const acknowledge = () => acknowledgeButtons(panel.container)[0] ?? null;
  try {
    await act(async () => { acknowledge()!.click(); await Promise.resolve(); });
    assert.equal(acknowledge()!.getAttribute("aria-busy"), "true");
    assert.match(panel.container.textContent ?? "", /Acknowledging the missing result…/u, "the busy state is announced");

    await act(async () => {
      settle!.reject(new Error("The control plane refused the acknowledgement."));
      await Promise.resolve();
      await Promise.resolve();
    });
    const notice = panel.container.querySelector<HTMLElement>('.notice[data-state="accepted_without_result"]');
    assert.ok(notice, "a failed request keeps the notice");
    const error = notice!.querySelector<HTMLElement>(".notice-actions > .background-recovery-note[role='alert']");
    assert.equal(error?.textContent, "The control plane refused the acknowledgement.");
    assert.ok(acknowledge()!.compareDocumentPosition(error!) & 4, "the message follows the actions");
    assert.equal(acknowledge()!.getAttribute("aria-busy"), null, "and Acknowledge can be tried again");

    await act(async () => { acknowledge()!.click(); await Promise.resolve(); });
    await act(async () => {
      settle!.resolve({} as SessionView);
      await Promise.resolve();
      await Promise.resolve();
    });
    assertNoDomNode(panel.container.querySelector(".notice"), "the notice goes once acknowledged");
    assert.equal(panel.container.querySelector(".background-work-turn-head .status")?.textContent, "Missing Result Acknowledged");
    assert.ok(panel.container.querySelector(".background-work-turn-head .status")?.classList.contains("t-neutral"),
      "the acknowledged status is neutral");
  } finally {
    await panel.dispose();
  }
});

/** A Result Blocked turn: a monitor that never fires beside a finished agent (#1780). */
function blockedSession(id: string, extraRunning = false): SessionView {
  const now = Date.now();
  const jobs: ManagedBackgroundJobView[] = [
    { ...baseJob, id: "bg-monitor-7be210", parentTurnId: "blocked", launchType: "monitor", registeredAt: now - 50 * MINUTE,
      lastObservedAt: now - MINUTE },
    { ...baseJob, id: "bg-agent-04d2e1", parentTurnId: "blocked", launchType: "agent", registeredAt: now - 49 * MINUTE,
      lastObservedAt: now - 20 * MINUTE, terminalStatus: "completed", terminalObservedAt: now - 20 * MINUTE, continuationRequired: true },
  ];
  if (extraRunning) {
    jobs.push({ ...baseJob, id: "bg-shell-c0ffee", parentTurnId: "blocked", launchType: "shell", registeredAt: now - 48 * MINUTE,
      lastObservedAt: now - MINUTE });
  }
  return managedSession({
    id,
    backgroundJobs: jobs,
    backgroundDeliveries: [{
      parentTurnId: "blocked", jobCount: jobs.length, terminalCount: 1, watchdogState: "continuation_blocked",
      unfinishedSiblingJobs: jobs.length - 1,
    }],
  });
}

test("Result Blocked offers Stop <job name>… behind the Job Detail confirmation, and says why when it can't (#2859)", async () => {
  const stops: string[] = [];
  const confirmations: ConfirmationOptions[] = [];
  const client = {
    stopBackgroundJob: async (_sessionId: string, jobId: string) => {
      stops.push(jobId);
      return { sessionId: "session", jobId, outcome: "stopped", terminalStatus: "killed" } as BackgroundJobStopResponse;
    },
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (session: SessionView, runnerProtocolVersion = PROTOCOL_VERSION) => act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        confirm: async (options) => { confirmations.push(options); return true; },
        showToast: () => 1,
        showUndo: () => 1,
        dismissToast: () => undefined,
      }}>
        <BackgroundWorkPanel session={session} runnerOnline runnerProtocolVersion={runnerProtocolVersion} parentTurns={new Map()} />
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  const notice = () => container.querySelector<HTMLElement>('.notice[data-state="continuation_blocked"]')!;
  try {
    await render(blockedSession("session-blocked-available"));
    assert.equal(notice().querySelector(".notice-title")?.textContent, "Result Blocked");
    assert.equal(notice().querySelector(".notice-body p")?.textContent,
      "Agent job 04d2e1 finished, but its result can't be returned while another job from the same turn is still running.");
    const stop = notice().querySelector<HTMLButtonElement>(".notice-actions button")!;
    assert.equal(stop.textContent, "Stop Monitor Job 7be210…");
    await act(async () => { stop.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(confirmations.map((options) => [options.title, options.message, options.confirmLabel, options.tone]),
      [["Stop Monitor Job 7be210", STOP_JOB_OUTCOME, "Stop Job", "danger"]], "the Job Detail page's confirmation");
    assert.deepEqual(stops, ["bg-monitor-7be210"]);
    assert.equal(notice().querySelector(".background-recovery-note[role='status']")?.textContent,
      "Stopped. Its status updates here shortly.");
    await act(async () => notice().querySelector<HTMLButtonElement>(".notice-details-toggle")!.click());
    assert.match(notice().querySelector(".facts")?.textContent ?? "", /Other Ways.*Restarting the session ends every job and reports this result to the new conversation\./su);

    // An older runner: the action stays, disabled, described by its reason on screen.
    await render(blockedSession("session-blocked-old-runner"), 189);
    const unavailable = notice().querySelector<HTMLButtonElement>(".notice-actions button")!;
    assert.equal(unavailable.textContent, "Stop Monitor Job 7be210…");
    assert.equal(unavailable.disabled, true);
    const reasonId = unavailable.getAttribute("aria-describedby")!;
    assert.equal(container.querySelector(`[id="${reasonId}"]`)?.textContent,
      "This machine needs a newer runner for stopping a background job. Update and restart the runner.");
    assert.ok(notice().querySelector(`.notice-body [id="${reasonId}"]`), "the reason is a visible line of the body");

    // Several unfinished jobs: no one job to name, so the notice says where to stop them.
    await render(blockedSession("session-blocked-several", true));
    assert.equal(notice().querySelectorAll(".notice-actions button").length, 1, "Show Details only");
    assert.equal(notice().querySelectorAll(".notice-body p")[1]?.textContent, "Open one of the unfinished jobs below to stop it.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a lost job is one danger notice that names the job and the restart, with View Turn and no empty state (#2859)", async () => {
  const now = Date.now();
  const viewed: string[] = [];
  const lostJob: ManagedBackgroundJobView = {
    ...baseJob, id: "task-7be210", parentTurnId: "turn-4", launchType: "monitor", registeredAt: now - 30 * MINUTE,
    lastObservedAt: now - 12 * MINUTE, sourcePresent: true,
  };
  const panel = await mountBackgroundWork({
    session: managedSession({ backgroundWorkState: "orphaned", backgroundJobs: [lostJob] }),
    machineName: "Studio Workstation",
    runnerConnectedAt: now - 10 * MINUTE,
    parentTurns: new Map([["turn-4", { eventId: 40, turn: 4 }]]),
    onViewTurn: (turn) => viewed.push(turn),
  });
  try {
    const notices = [...panel.container.querySelectorAll<HTMLElement>(".notice")];
    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.ok(notice.classList.contains("t-danger"));
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Lost Track of a Background Job");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Studio Workstation restarted while monitor job 7be210 was running, so its result can't come back to this conversation.");
    assert.deepEqual([...notice.querySelectorAll<HTMLButtonElement>(".notice-actions button")].map((button) => button.textContent),
      ["View Turn", "Show Details"]);
    assert.equal([...panel.container.querySelectorAll("button")].some((button) => /rerun|retry/iu.test(button.textContent ?? "")), false,
      "there is no Rerun");
    await act(async () => notice.querySelector<HTMLButtonElement>(".notice-actions button")!.click());
    assert.deepEqual(viewed, ["turn-4"], "View Turn scrolls to the job's turn");
    await act(async () => notice.querySelector<HTMLButtonElement>(".notice-details-toggle")!.click());
    const facts = Object.fromEntries([...notice.querySelectorAll(".facts > div")].map((pair) =>
      [pair.querySelector("dt")?.textContent, pair.querySelector("dd")?.textContent]));
    assert.deepEqual(facts, { "Last Seen": "12m ago", "Runner Restarted": "10m ago", "Started By": "Turn 4" });
    assert.equal(panel.container.querySelector("button.background-job-row .status")?.textContent, "Lost");
    assert.doesNotMatch(panel.container.textContent ?? "", /No Background Work|Background Work Lost/u);

    // Nothing listed: the notice still says it, without a turn to view, and the panel has no empty state.
    await panel.render({
      session: managedSession({ backgroundWorkState: "orphaned", backgroundJobs: [] }),
      onViewTurn: (turn) => viewed.push(turn),
    });
    const bare = panel.container.querySelector<HTMLElement>(".notice.t-danger")!;
    assert.equal(bare.querySelector(".notice-body")?.textContent,
      "The machine restarted while a background job was running, so its result can't come back to this conversation.");
    assertNoDomNode(bare.querySelector(".notice-actions"), "no turn to view and no details to show");
    assertNoDomNode(panel.container.querySelector(".state"), "no empty state under the notice");
  } finally {
    await panel.dispose();
  }
});

test("recovery notices' titles and labels are Title Case and their sentences sentence case, without pipeline words (#2859)", async () => {
  const now = Date.now();
  const missing = missingResultSession("session-copy");
  const blocked = blockedSession("session-copy");
  const pendingJob: ManagedBackgroundJobView = {
    ...baseJob, id: "task-1ab2c3", parentTurnId: "turn-9", launchType: "shell", registeredAt: now - MINUTE,
    lastObservedAt: now - MINUTE, terminalStatus: "completed", terminalObservedAt: now - MINUTE, continuationRequired: true,
  };
  const panel = await mountBackgroundWork({
    session: managedSession({
      id: "session-copy",
      backgroundJobs: [...missing.backgroundJobs!, ...blocked.backgroundJobs!, pendingJob],
      backgroundDeliveries: [...missing.backgroundDeliveries!, ...blocked.backgroundDeliveries!,
        { parentTurnId: "turn-9", jobCount: 1, terminalCount: 1, watchdogState: "terminal_without_continuation" }],
    }),
    machineName: "Studio Workstation",
  });
  const labels: string[] = [];
  const sentences: string[] = [];
  const collect = () => {
    for (const notice of panel.container.querySelectorAll<HTMLElement>(".notice")) {
      labels.push(...[...notice.querySelectorAll(".notice-title, button")].map((element) => (element.textContent ?? "").replace(/…$/u, "")));
      const lines = [...notice.querySelectorAll(".notice-body p")];
      sentences.push(...(lines.length > 0 ? lines : [...notice.querySelectorAll(".notice-body")]).map((element) => element.textContent ?? ""));
    }
  };
  try {
    assert.equal(panel.container.querySelectorAll(".notice").length, 3, "each turn's one notice");
    collect();
    await panel.render({
      session: managedSession({ id: "session-copy", backgroundWorkState: "orphaned", backgroundJobs: blocked.backgroundJobs! }),
      machineName: "Studio Workstation",
    });
    assert.equal(panel.container.querySelectorAll(".notice").length, 1, "the Lost notice");
    collect();
    assert.ok(labels.includes("Stop Monitor Job 7be210") && labels.includes("Lost Track of a Background Job"));
    const minor = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
    for (const label of labels) {
      for (const [index, word] of label.split(/\s+/u).filter(Boolean).entries()) {
        if ((index > 0 && minor.has(word)) || /^[0-9a-f]{6}$/u.test(word)) continue;
        assert.match(word, /^[A-Z]/u, `"${word}" in "${label}" is Title Case`);
      }
    }
    assert.equal(sentences.length, 4);
    for (const sentence of sentences) {
      assert.match(sentence, /^(?:Studio Workstation|[A-Z0-9])[^A-Z]*(?:Wollipog[^A-Z]*)*\.$/u, `"${sentence}" is sentence case`);
      assert.doesNotMatch(sentence, /barrier|terminal|continuation|delivery|orphan|watchdog/iu, sentence);
    }
  } finally {
    await panel.dispose();
  }
});

test("a partly listed turn still says Result Missing, and Missing Result Acknowledged once acknowledged (#2859)", async () => {
  const now = Date.now();
  const panel = await mountBackgroundWork({
    session: managedSession({
      id: "session-partial-acknowledge",
      backgroundWorkState: undefined,
      backgroundJobsTruncated: true,
      backgroundJobs: [{
        ...baseJob, id: "task-a1f3c9", parentTurnId: "turn-4", launchType: "shell", registeredAt: now - 20 * MINUTE,
        terminalStatus: "completed", terminalObservedAt: now - 15 * MINUTE, continuationRequired: true,
        continuationId: "bgcont-partial", continuationMissingResultAt: now - 12 * MINUTE,
      }],
      backgroundDeliveries: [{
        continuationId: "bgcont-partial", parentTurnId: "turn-4", jobCount: 2, terminalCount: 2,
        acceptedAt: now - 14 * MINUTE, missingResultAt: now - 12 * MINUTE, watchdogState: "accepted_without_result",
      }],
    } as Partial<SessionView>),
  }, { acknowledgeBackgroundMissingResult: async () => ({} as SessionView) } as unknown as ApiClient);
  try {
    assertNoDomNode(panel.container.querySelector(".background-work-turn-head .status"),
      "the notice says Result Missing for the partly listed turn");
    await act(async () => {
      acknowledgeButtons(panel.container)[0]!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assertNoDomNode(panel.container.querySelector(".notice"));
    assert.equal(panel.container.querySelector(".background-work-turn-head .status")?.textContent, "Missing Result Acknowledged",
      "the acknowledgement stays visible even though some of the turn's jobs are not listed");
  } finally {
    await panel.dispose();
  }
});

test("a pending result names only the jobs its receipt returns, not a finished job with nothing to return (#2859)", async () => {
  const now = Date.now();
  const panel = await mountBackgroundWork({
    session: managedSession({
      id: "session-pending-subject",
      backgroundWorkState: "continuation_pending",
      backgroundJobs: [
        { ...baseJob, id: "task-a1f3c9", parentTurnId: "turn-4", launchType: "shell", registeredAt: now - 9 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - 2 * MINUTE, continuationRequired: true },
        { ...baseJob, id: "task-b2c3d4", parentTurnId: "turn-4", launchType: "agent", registeredAt: now - 8 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - MINUTE, continuationRequired: false },
        { ...baseJob, id: "task-c3d4e5", parentTurnId: "turn-4", launchType: "shell", registeredAt: now - 7 * MINUTE,
          terminalStatus: "completed", terminalObservedAt: now - MINUTE, continuationRequired: true, sourcePresent: false },
      ],
      backgroundDeliveries: [{ parentTurnId: "turn-4", jobCount: 1, terminalCount: 1, watchdogState: "terminal_without_continuation" }],
    }),
  });
  try {
    assert.equal(panel.container.querySelector('.notice[data-state="terminal_without_continuation"] .notice-body')?.textContent,
      "Returning shell job a1f3c9's result to this conversation.");
  } finally {
    await panel.dispose();
  }
});

test("after Acknowledge, focus goes to the acknowledged turn's heading even when the groups reorder first (#2859)", async () => {
  const now = Date.now();
  let settle: ((value: SessionView) => void) | null = null;
  const client = {
    acknowledgeBackgroundMissingResult: () => new Promise<SessionView>((resolve) => { settle = resolve; }),
  } as unknown as ApiClient;
  const session = (acknowledgedAt?: number) => managedSession({
    id: "session-acknowledge-focus",
    backgroundWorkState: undefined,
    backgroundJobs: [
      { ...baseJob, id: "task-a1f3c9", parentTurnId: "turn-a", launchType: "shell", registeredAt: now - 30 * MINUTE,
        terminalStatus: "completed", terminalObservedAt: now - 25 * MINUTE, continuationRequired: true,
        continuationId: "bgcont-focus", continuationMissingResultAt: now - 20 * MINUTE },
      { ...baseJob, id: "task-b2c3d4", parentTurnId: "turn-b", launchType: "shell", registeredAt: now - 5 * MINUTE },
    ],
    backgroundDeliveries: [{
      continuationId: "bgcont-focus", parentTurnId: "turn-a", jobCount: 1, terminalCount: 1,
      acceptedAt: now - 22 * MINUTE, missingResultAt: now - 20 * MINUTE,
      ...(acknowledgedAt === undefined ? { watchdogState: "accepted_without_result" as const } : { missingResultAcknowledgedAt: acknowledgedAt }),
    }],
  } as Partial<SessionView>);
  const parentTurns = new Map([["turn-a", { eventId: 10, turn: 1 }], ["turn-b", { eventId: 20, turn: 2 }]]);
  const panel = await mountBackgroundWork({ session: session(), parentTurns }, client);
  const titles = () => [...panel.container.querySelectorAll(".background-work-turn-head h3")].map((title) => title.textContent);
  try {
    assert.deepEqual(titles(), ["Turn 2", "Turn 1"]);
    const acknowledge = acknowledgeButtons(panel.container)[0]!;
    acknowledge.focus();
    await act(async () => { acknowledge.click(); await Promise.resolve(); });
    // The acknowledged snapshot arrives before the request settles, and moves Turn 1 to the top.
    await panel.render({ session: session(now), parentTurns });
    assert.deepEqual(titles(), ["Turn 1", "Turn 2"]);
    await act(async () => {
      settle!({} as SessionView);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(domWindow.document.activeElement?.textContent, "Turn 1", "focus is on the acknowledged turn's heading");
  } finally {
    await panel.dispose();
  }
});

test("Result Blocked stops the one live unfinished job, not counting a job the runner no longer lists (#2859)", async () => {
  const now = Date.now();
  const blocked = blockedSession("session-blocked-tombstone");
  const panel = await mountBackgroundWork({
    session: {
      ...blocked,
      backgroundJobs: [...blocked.backgroundJobs!, {
        ...baseJob, id: "bg-shell-0dead0", parentTurnId: "blocked", launchType: "shell", registeredAt: now - 49 * MINUTE,
        lastObservedAt: now - 40 * MINUTE, sourcePresent: false,
      }],
    } as SessionView,
  });
  try {
    const notice = panel.container.querySelector<HTMLElement>('.notice[data-state="continuation_blocked"]')!;
    assert.equal(notice.querySelector(".notice-actions button")?.textContent, "Stop Monitor Job 7be210…");
    assert.equal(notice.querySelectorAll(".notice-body p").length, 1, "no reason line when Stop is offered");
  } finally {
    await panel.dispose();
  }
});
