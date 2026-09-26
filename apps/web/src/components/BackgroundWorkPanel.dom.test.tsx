import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type BackgroundJobStopResponse, type ManagedBackgroundJobView, type SessionView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import {
  BackgroundWorkPanel,
  backgroundJobCurrentState,
  backgroundJobDeliveryStage,
} from "./BackgroundWorkPanel.js";

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

test("job and delivery presentation keep current lifecycle separate from delivery", () => {
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true), "Running");
  assert.equal(backgroundJobCurrentState(baseJob, "running", false, true), "Status Unverified");
  assert.equal(backgroundJobCurrentState({ ...baseJob, sourcePresent: false }, "running", true, true), "Status Unverified");
  assert.equal(backgroundJobCurrentState({ ...baseJob, terminalStatus: "failed" }, undefined, false, true), "Failed");
  assert.equal(backgroundJobCurrentState(baseJob, "orphaned", true, true), "Orphaned");
  assert.equal(backgroundJobCurrentState(baseJob, undefined, true, true), "Status Unverified",
    "a source-present row cannot claim Running without a current aggregate lifecycle");
  // A listed job past the stall bound is reported as stalled, from the control plane's mark or
  // from the clock, and never declared ended (#1651).
  assert.equal(backgroundJobCurrentState({ ...baseJob, stalledSince: 3_601_000 }, "running", true, true), "Stalled");
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true, 1_000 + 3_600_000), "Stalled");
  assert.equal(backgroundJobCurrentState(baseJob, "running", true, true, 1_000 + 3_599_000), "Running");
  assert.equal(backgroundJobCurrentState({ ...baseJob, stalledSince: 3_601_000 }, "running", false, true), "Status Unverified",
    "an offline runner cannot confirm a stalled job any more than a running one");
  assert.equal(backgroundJobDeliveryStage(baseJob), "Not Started");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, terminalObservedAt: 3_000, continuationRequired: true }), "Continuation Pending");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, continuationAcceptedAt: 4_000 }), "Continuation In Flight");
  assert.equal(backgroundJobDeliveryStage({
    ...baseJob,
    continuationAcceptedAt: 4_000,
    continuationMissingResultAt: 4_500,
  }), "Result Missing");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, assistantResultPersistedAt: 5_000 }), "Result Delivered");
});

test("every watchdog highlights its delivery and explains completion, recovery, and user action", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const cases = [
    ["terminal_without_continuation", "Result Pending", /returning the result automatically/, /No action is needed/],
    ["continuation_blocked", "Result Blocked", /ends that job itself only when a queued handoff has waited on it past its bound/, /stop the unfinished job/],
    ["accepted_without_result", "Result Missing", /will not repeat an accepted step/, /Acknowledge the missing result/],
    ["result_not_projected", "Transcript Delayed", /updating the transcript automatically/, /No action is needed/],
    ["dashboard_observation_pending", "Notification Pending", /waiting for the dashboard confirmation/, /No action is needed/],
  ] as const;
  try {
    for (const [watchdogState, label, recovery, action] of cases) {
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
          parentTurnEventIds={new Map([["turn-1", 42]])}
          onOpenParentTurn={() => undefined}
        />,
      ));
      const highlighted = container.querySelector<HTMLElement>(".background-work-group-watchdog");
      assert.equal(highlighted?.dataset["watchdogState"], watchdogState);
      assert.equal(highlighted?.dataset["watchdogHighlighted"], "true");
      const summary = highlighted?.querySelector<HTMLElement>(".background-delivery-summary");
      assert.match(summary?.textContent ?? "", new RegExp(label));
      assert.match(summary?.textContent ?? "", /Completed.*Still Pending.*Recovery.*Your Action/s);
      assert.match(summary?.textContent ?? "", recovery);
      assert.match(summary?.textContent ?? "", action);
      const details = summary?.querySelector("details");
      assert.equal(details?.open, false);
      assert.equal(details?.querySelector("code")?.textContent, watchdogState);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("terminal missing continuations show age and acknowledge independently without retry", async () => {
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
          parentTurnEventIds={new Map()}
          onOpenParentTurn={() => undefined}
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelectorAll(".background-delivery-summary").length, 2);
    assert.equal(container.querySelectorAll<HTMLButtonElement>("button").length, 2);
    assert.match(container.textContent ?? "", /Missing Since.*Recovery State.*Acknowledgement Required/s);
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>("button")[0]!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(acknowledged, [["session", "bgcont-a"]]);
    assert.equal(container.querySelectorAll<HTMLButtonElement>("button").length, 1,
      "acknowledging one continuation leaves the other independently actionable");
    assert.equal(container.querySelectorAll('[data-recovery-state="missing-result-acknowledged"]').length, 1);
    assert.match(container.textContent ?? "", /Missing Result Acknowledged/);
    assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => /retry/i.test(button.textContent ?? "")), false,
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
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />
    </ApiProvider>
  );
  const button = () => container.querySelector<HTMLButtonElement>("button")!;
  try {
    await act(async () => renderSession("session-a"));
    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    assert.equal(requests[0]?.sessionId, "session-a");
    assert.equal(button().disabled, true);
    assert.equal(button().textContent, "Acknowledging…");

    await act(async () => renderSession("session-b"));
    assert.equal(button().disabled, false,
      "session A's same-id request must not make session B look busy");
    assert.equal(button().textContent, "Acknowledge Missing Result");
    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    assert.deepEqual(requests.map((request) => request.sessionId), ["session-a", "session-b"]);
    assert.equal(button().textContent, "Acknowledging…");

    await act(async () => {
      requests[0]!.reject(new Error("Session A acknowledgement failed."));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(button().disabled, true,
      "session A's late settlement must not clear session B's newer request");
    assert.equal(button().textContent, "Acknowledging…");
    assert.equal(container.querySelector('[role="alert"]'), null,
      "session A's late error must not appear in session B");

    await act(async () => {
      requests[1]!.resolve({} as SessionView);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(container.textContent ?? "", /Missing Result Acknowledged/,
      "session B retains its own successful optimistic acknowledgement");

    await act(async () => renderSession("session-c", 30_000));
    assert.match(container.textContent ?? "", /Missing Result Acknowledged/,
      "a durable server acknowledgement remains authoritative without local state");
    assert.equal(container.querySelector<HTMLButtonElement>("button"), null);

    await act(async () => renderSession("session-a"));
    assert.equal(container.querySelector('[role="alert"]')?.textContent,
      "Session A acknowledgement failed.",
      "the late error remains available only in its originating session");
    assert.equal(button().disabled, false);

    await act(async () => renderSession("session-a", 30_000));
    assert.match(container.textContent ?? "", /Missing Result Acknowledged/,
      "durable acknowledgement supersedes the same session's transient failure");
    assert.equal(container.querySelector('[role="alert"]'), null,
      "durable acknowledgement clears the stale local error from view");
    assert.equal(container.querySelector<HTMLButtonElement>("button"), null);
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
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />
    </ApiProvider>
  );
  try {
    await act(async () => render(missingDelivery));
    assert.match(container.textContent ?? "", /Acknowledgement Required/);
    assert.equal(container.querySelectorAll<HTMLButtonElement>("button").length, 1,
      "terminal missing audit remains resolvable when attention is suppressed");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(
      container.querySelector(".background-work-barrier strong")?.textContent,
      "Missing Result Acknowledged",
      "the barrier follows the successful optimistic acknowledgement",
    );
    await act(async () => render({ ...missingDelivery, runnerResultPersistedAt: 30_000 }));
    assert.doesNotMatch(container.textContent ?? "", /Acknowledgement Required/);
    assert.doesNotMatch(container.textContent ?? "", /Result Missing/);
    assert.match(container.textContent ?? "", /Result Delivered/);
    assert.equal(container.querySelectorAll<HTMLButtonElement>("button").length, 0,
      "late delivery proof is authoritative and needs no acknowledgement");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the panel renders individual jobs, their parent barrier, durable times, and a transcript action", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const opened: number[] = [];
  const session = {
    id: "session",
    runnerId: "runner",
    backgroundWorkTracking: "managed",
    backgroundJobs: [{
      ...baseJob,
      terminalStatus: "completed",
      terminalObservedAt: 3_000,
      continuationRequired: true,
      continuationId: "continuation",
      continuationQueuedAt: 3_100,
      assistantResultPersistedAt: 4_000,
    }, {
      ...baseJob,
      id: "second-private-id",
      launchType: "shell",
      registeredAt: 1_100,
      terminalStatus: "failed",
      terminalObservedAt: 3_200,
      continuationRequired: true,
      continuationId: "continuation",
      continuationQueuedAt: 3_100,
    }],
    backgroundDeliveries: [{
      continuationId: "continuation",
      parentTurnId: "turn-1",
      jobCount: 2,
      terminalCount: 2,
      notificationQueuedAt: 4_100,
    }],
  } as SessionView;
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={session}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map([["turn-1", 42]])}
        onOpenParentTurn={(eventId) => opened.push(eventId)}
      />,
    ));
    assert.equal(container.querySelectorAll(".background-work-job").length, 2);
    assert.match(container.textContent ?? "", /2 of 2 jobs terminal · 1 delivered/);
    assert.match(container.textContent ?? "", /Delivery Pending/);
    assert.match(container.textContent ?? "", /Notification Queued/);
    assert.match(container.textContent ?? "", /Agent Job 1/);
    assert.match(container.textContent ?? "", /Shell Job 2/);
    assert.doesNotMatch(container.textContent ?? "", /opaque-job-id|second-private-id|continuation|\/tmp/);
    assert.ok(container.querySelectorAll("time[datetime]").length >= 6);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    assert.deepEqual(opened, [42]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("bounded history uses authoritative barrier totals and discloses omitted jobs", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobsTruncated: true,
          backgroundJobs: [{
            ...baseJob,
            terminalStatus: "completed",
            terminalObservedAt: 3_000,
            continuationRequired: true,
            continuationId: "continuation",
            assistantResultPersistedAt: 4_000,
          }],
          backgroundDeliveries: [{
            continuationId: "continuation",
            parentTurnId: "turn-1",
            jobCount: 200,
            terminalCount: 199,
          }],
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /Showing the 128 most relevant jobs/);
    assert.match(container.textContent ?? "", /199 of 200 jobs terminal · 1 shown/);
    assert.match(container.textContent ?? "", /Waiting for Jobs/);
    assert.doesNotMatch(container.textContent ?? "", /BarrierDelivered/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("delivery-only history remains inspectable without inventing job lifecycle rows", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const opened: number[] = [];
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobs: [],
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
            notifications: [{
              deliveryId: "private-delivery",
              endpointKey: "private-endpoint",
              state: "clicked",
              attemptCount: 1,
              clickedAt: 3_400,
            }],
          }],
        } as unknown as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map([["retained-parent", 77]])}
        onOpenParentTurn={(eventId) => opened.push(eventId)}
      />,
    ));
    assert.equal(container.querySelectorAll(".background-work-group").length, 1);
    assert.equal(container.querySelectorAll(".background-work-job").length, 0);
    assert.equal(container.querySelectorAll(".background-work-delivery").length, 1);
    assert.match(container.textContent ?? "", /Delivery receipt retained for 3 jobs/);
    assert.match(container.textContent ?? "", /Per-job lifecycle history is outside the bounded inventory/);
    assert.match(container.textContent ?? "", /Delivery ReceiptResult Delivered · Notification Opened/);
    assert.match(container.textContent ?? "", /Delivery Receipt 1Result Delivered/);
    assert.match(container.textContent ?? "", /Recorded Job Count3Recorded Terminal Count3/);
    assert.doesNotMatch(container.textContent ?? "", /Running|Completed|Failed|Killed|Orphaned/);
    assert.doesNotMatch(container.textContent ?? "", /private-continuation|private-delivery|private-endpoint|retained-parent/);
    const receipt = container.querySelector('[role="group"][aria-label="Delivery Receipt Status"]');
    assert.ok(receipt, "screen readers receive a delivery-specific status group");
    const parentButton = container.querySelector<HTMLButtonElement>("button");
    assert.equal(parentButton?.textContent, "View Parent Turn");
    await act(async () => parentButton!.click());
    assert.deepEqual(opened, [77]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("multiple delivery rounds under one parent use their combined authoritative totals", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobs: [{
            ...baseJob,
            terminalStatus: "completed",
            terminalObservedAt: 3_000,
            continuationRequired: true,
            continuationId: "continuation-1",
            assistantResultPersistedAt: 4_000,
          }, {
            ...baseJob,
            id: "job-2",
            registeredAt: 5_000,
            terminalStatus: "completed",
            terminalObservedAt: 6_000,
            continuationRequired: true,
            continuationId: "continuation-2",
            assistantResultPersistedAt: 7_000,
          }],
          backgroundDeliveries: [{
            continuationId: "continuation-1",
            parentTurnId: "turn-1",
            jobCount: 1,
            terminalCount: 1,
            runnerResultPersistedAt: 4_000,
          }, {
            continuationId: "continuation-2",
            parentTurnId: "turn-1",
            jobCount: 1,
            terminalCount: 1,
            runnerResultPersistedAt: 7_000,
          }],
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /2 of 2 jobs terminal · 2 delivered/);
    assert.match(container.textContent ?? "", /BarrierDelivered/);
    assert.doesNotMatch(container.textContent ?? "", /Waiting for Jobs/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("unknown parent sentinels stay separate and aggregate-only states explain missing evidence", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
          backgroundJobs: [
            { ...baseJob, id: "unknown-1", parentTurnId: "unknown" },
            { ...baseJob, id: "unknown-2", parentTurnId: "unknown", registeredAt: 3_000 },
          ],
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.equal(container.querySelectorAll(".background-work-group").length, 2);
    assert.equal(container.querySelectorAll(".background-work-group h3")[0]?.textContent, "Unknown Parent Turn");
    assert.equal(container.querySelectorAll(".background-work-link-unavailable")[0]?.textContent,
      "Parent Turn Unknown");
    assert.equal(container.querySelectorAll(".background-work-barrier strong")[0]?.textContent,
      "Status Unverified");

    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundJobsAvailable: true,
          backgroundWorkTracking: "managed",
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /Loading Background Work/);
    assert.doesNotMatch(container.textContent ?? "", /No Background Work Recorded/);

    let retries = 0;
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundJobsAvailable: true,
          backgroundWorkTracking: "managed",
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
        inventoryError="offline"
        onRetryInventory={() => { retries += 1; }}
      />,
    ));
    assert.match(container.textContent ?? "", /Background Work Unavailable/);
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(retries, 1);

    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkTracking: "managed",
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /Background Work Status Unverified/);
    assert.match(container.textContent ?? "", /control plane does not expose/);
    assert.doesNotMatch(container.textContent ?? "", /No Background Work Recorded/);

    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkState: "orphaned",
          backgroundWorkTracking: "managed",
        } as SessionView}
        runnerOnline
        runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /Background Work Orphaned/);
    assert.match(container.textContent ?? "", /per-job lifecycle evidence is unavailable/);
    assert.doesNotMatch(container.textContent ?? "", /No Background Work Recorded/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("offline current work and older untracked providers receive truthful capability copy", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <BackgroundWorkPanel
        session={{
          id: "session",
          runnerId: "runner",
          backgroundWorkState: "running",
          backgroundWorkTracking: "untracked",
          backgroundJobs: [baseJob],
        } as SessionView}
        runnerOnline={false}
        runnerProtocolVersion={81}
        parentTurnEventIds={new Map()}
        onOpenParentTurn={() => undefined}
      />,
    ));
    assert.match(container.textContent ?? "", /predates inspectable background work/);
    assert.match(container.textContent ?? "", /does not expose a durable detached-work lifecycle/);
    assert.match(container.textContent ?? "", /Status Unverified/);
    assert.match(container.textContent ?? "", /Parent Turn Not Loaded/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** A Result Blocked turn: a monitor that never fires beside a finished subagent (#1780). */
function resultBlockedSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session",
    runnerId: "runner",
    driver: "claude-code",
    backgroundWorkTracking: "managed",
    backgroundWorkState: "running",
    backgroundJobs: [
      { ...baseJob, id: "monitor-1", launchType: "monitor" },
      {
        ...baseJob, id: "agent-1", launchType: "agent", terminalStatus: "completed",
        terminalObservedAt: 3_000, continuationRequired: true,
      },
    ],
    backgroundDeliveries: [{
      parentTurnId: "turn-1", jobCount: 2, terminalCount: 1,
      watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1,
    }],
    ...overrides,
  } as unknown as SessionView;
}

test("Result Blocked offers Stop Job, which stops only the unfinished job after confirmation (#1780)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const stops: Array<[string, string]> = [];
  let finish!: (value: BackgroundJobStopResponse) => void;
  const client = {
    stopBackgroundJob: (sessionId: string, jobId: string) => {
      stops.push([sessionId, jobId]);
      return new Promise<BackgroundJobStopResponse>((resolve) => { finish = resolve; });
    },
  } as unknown as ApiClient;
  const render = (session: SessionView) => act(async () => root.render(
    <ApiProvider client={client}>
      <BackgroundWorkPanel session={session} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
        parentTurnEventIds={new Map()} onOpenParentTurn={() => undefined} />
    </ApiProvider>,
  ));
  try {
    await render(resultBlockedSession());
    const summary = container.querySelector<HTMLElement>(".background-delivery-summary");
    assert.match(summary?.textContent ?? "", /Result Blocked/);
    assert.match(summary?.textContent ?? "", /Use Stop Job on the unfinished job below: only that job ends/);
    assert.doesNotMatch(summary?.textContent ?? "", /Ask the session to stop/);
    // Only the unfinished job offers the action.
    const stopButtons = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent === "Stop Job");
    assert.equal(stopButtons.length, 1);
    assert.match(stopButtons[0]!.getAttribute("aria-label") ?? "", /^Stop Monitor Job \d$/);

    await act(async () => stopButtons[0]!.click());
    assert.deepEqual(stops, [], "nothing is stopped before confirmation");
    const confirm = container.querySelector<HTMLElement>("[aria-label^='Confirm Stopping Monitor Job']");
    assert.match(confirm?.textContent ?? "", /Only this job ends, and it is recorded as killed\. The session, its conversation, and its other jobs keep running\./);
    const keep = [...confirm!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Keep Running")!;
    await act(async () => keep.click());
    assert.equal(container.querySelector("[aria-label^='Confirm Stopping Monitor Job']"), null);
    assert.deepEqual(stops, []);

    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label^='Stop Monitor Job']")!.click());
    const confirmStop = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Confirm Stop")!;
    assert.ok(confirmStop.classList.contains("danger"));
    await act(async () => confirmStop.click());
    assert.deepEqual(stops, [["session", "monitor-1"]]);
    const pending = container.querySelector<HTMLButtonElement>("[aria-label^='Stop Monitor Job']")!;
    assert.equal(pending.textContent, "Stopping…");
    assert.equal(pending.disabled, true);
    await act(async () => {
      finish({ sessionId: "session", jobId: "monitor-1", outcome: "stopped", terminalStatus: "killed" });
      await Promise.resolve();
    });
    assert.match(container.textContent ?? "", /The job was stopped\. Its status updates here shortly\./);

    // The inventory update arrives: the job is killed and the control is gone.
    await render(resultBlockedSession({
      backgroundJobs: [
        { ...baseJob, id: "monitor-1", launchType: "monitor", terminalStatus: "killed", terminalObservedAt: 4_000, continuationRequired: false },
        { ...baseJob, id: "agent-1", launchType: "agent", terminalStatus: "completed", terminalObservedAt: 3_000, continuationRequired: true },
      ],
      backgroundDeliveries: [],
    }));
    assert.equal(container.querySelector("[aria-label^='Stop Monitor Job']"), null);
    assert.match(container.textContent ?? "", /Killed/);
  } finally {
    await act(async () => root.unmount());
    happyContainer.remove();
  }
});

test("Stop Job reports a refusal and a job that had already ended without claiming a stop (#1780)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const answers: Array<() => Promise<BackgroundJobStopResponse>> = [
    async () => { throw new Error("the provider did not confirm that the job ended, so it was left as it was"); },
    async () => ({ sessionId: "session", jobId: "monitor-1", outcome: "already_terminal", terminalStatus: "completed" }),
  ];
  const client = { stopBackgroundJob: () => answers.shift()!() } as unknown as ApiClient;
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <BackgroundWorkPanel session={resultBlockedSession()} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
          parentTurnEventIds={new Map()} onOpenParentTurn={() => undefined} />
      </ApiProvider>,
    ));
    const confirmAndStop = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>("[aria-label^='Stop Monitor Job']")!.click());
      await act(async () => {
        [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Confirm Stop")!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
    };
    await confirmAndStop();
    assert.equal(container.querySelector("[role='alert']")?.textContent,
      "the provider did not confirm that the job ended, so it was left as it was");
    const retry = container.querySelector<HTMLButtonElement>("[aria-label^='Stop Monitor Job']")!;
    assert.equal(retry.disabled, false, "a refused stop can be tried again");
    await confirmAndStop();
    assert.match(container.textContent ?? "", /This job had already ended, so nothing was changed\./);
    assert.equal(container.querySelector("[role='alert']"), null);
  } finally {
    await act(async () => root.unmount());
    happyContainer.remove();
  }
});

test("Stop Job is shown as unavailable on an older runner, and Result Blocked says why (#1780)", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let called = false;
  const client = { stopBackgroundJob: async () => { called = true; } } as unknown as ApiClient;
  const render = (session: SessionView, version: number, online = true) => act(async () => root.render(
    <ApiProvider client={client}>
      <BackgroundWorkPanel session={session} runnerOnline={online} runnerProtocolVersion={version}
        parentTurnEventIds={new Map()} onOpenParentTurn={() => undefined} />
    </ApiProvider>,
  ));
  try {
    await render(resultBlockedSession(), 189);
    const button = container.querySelector<HTMLButtonElement>("[aria-label^='Stop Monitor Job']")!;
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Stop Job");
    const reason = domWindow.document.getElementById(button.getAttribute("aria-describedby")!);
    assert.match(reason?.textContent ?? "", /Stop Job is unavailable: Runner protocol is v189; Stop Job requires protocol v190/);
    const summary = container.querySelector<HTMLElement>(".background-delivery-summary");
    assert.match(summary?.textContent ?? "", /Stop Job is unavailable: Runner protocol is v189; Stop Job requires protocol v190\. Update and restart the runner\. Ask the session to stop the unfinished job/);
    await act(async () => button.click());
    assert.equal(called, false);

    // Another harness has no managed jobs to stop, so nothing is offered or promised.
    await render(resultBlockedSession({ driver: "codex" } as Partial<SessionView>), PROTOCOL_VERSION);
    assert.equal(container.querySelector("[aria-label^='Stop Monitor Job']"), null);
    assert.match(container.querySelector(".background-delivery-summary")?.textContent ?? "", /Ask the session to stop the unfinished job/);
  } finally {
    await act(async () => root.unmount());
    happyContainer.remove();
  }
});
