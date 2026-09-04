import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ManagedBackgroundJobView, type SessionView } from "@wollipog/protocol";
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
  assert.equal(backgroundJobDeliveryStage(baseJob), "Not Started");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, terminalObservedAt: 3_000, continuationRequired: true }), "Continuation Pending");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, continuationAcceptedAt: 4_000 }), "Continuation Accepted");
  assert.equal(backgroundJobDeliveryStage({ ...baseJob, assistantResultPersistedAt: 5_000 }), "Result Delivered");
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
