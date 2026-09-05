import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import {
  backgroundDeliveryNotifyDecision,
  backgroundDeliveryNotifyDecisions,
  Notifier,
  notifyDecision,
} from "./notify.js";

function session(over: Partial<SessionView>): SessionView {
  return { id: "s1", title: "Build feature", status: "running", pendingApproval: null, ...over } as SessionView;
}

test("no notification without a known previous status (initial snapshot)", () => {
  assert.equal(notifyDecision(undefined, session({ status: "input_required" })), null);
});

test("no notification when the status did not change", () => {
  assert.equal(notifyDecision(session({ status: "running" }), session({ status: "running" })), null);
});

test("running -> input_required notifies with the approval title", () => {
  const next = session({ status: "input_required", pendingApproval: { requestId: "r", title: "Run: rm -rf build", options: [] } });
  const p = notifyDecision(session({ status: "running" }), next);
  assert.ok(p);
  assert.match(p!.title, /needs your input/);
  assert.match(p!.body, /Run: rm -rf build/);
  assert.equal(p!.sessionId, "s1");
});

test("authentication input is distinct from tool approval", () => {
  const next = session({
    status: "input_required",
    pendingApproval: { requestId: "auth", title: "Sign in to Gemini CLI", options: [], kind: "authentication" },
  });
  assert.match(notifyDecision(session({ status: "running" }), next)!.body, /^Authentication required/);
});

test("running -> completed / failed / idle each notify", () => {
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "completed" }))!.title, /completed/);
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "failed" }))!.title, /failed/);
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "idle" }))!.title, /awaiting a prompt/);
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "idle" }))!.body, /awaiting another prompt/);
});

test("only a newly settled live background delivery suppresses the trailing Awaiting Prompt", () => {
  const delivery = {
    continuationId: "bgcont-1",
    parentTurnId: "turn-1",
    jobCount: 1,
    terminalCount: 1,
    notificationQueuedAt: 100,
  };
  const historical = session({ status: "running", backgroundDeliveries: [delivery] });
  assert.match(notifyDecision(historical, session({ status: "idle", backgroundDeliveries: [delivery] }))!.title, /awaiting a prompt/,
    "an old replayed delivery cannot suppress an unrelated foreground completion");
  assert.equal(notifyDecision(historical, session({
    status: "idle",
    backgroundDeliveries: [{ ...delivery, statusSettledAt: 200 }],
  })), null);
});

test("completed/idle only notify when coming from a busy state (not from input_required)", () => {
  // input_required -> idle (e.g. user denied) shouldn't fire a 'ready' buzz
  assert.equal(notifyDecision(session({ status: "input_required" }), session({ status: "idle" })), null);
  assert.equal(notifyDecision(session({ status: "input_required" }), session({ status: "completed" })), null);
});

test("failed notifies from any prior state (it's always worth surfacing)", () => {
  assert.ok(notifyDecision(session({ status: "idle" }), session({ status: "failed" })));
});

test("title falls back to 'Session' when blank", () => {
  const p = notifyDecision(session({ status: "running", title: "  " }), session({ status: "failed", title: "  " }));
  assert.match(p!.title, /^Session failed/);
});

test("unobserved background delivery notifies on first snapshot and deduplicates by continuation", () => {
  const next = session({
    title: "Research",
    backgroundDeliveries: [{
      continuationId: "bgcont-1",
      parentTurnId: "turn-1",
      jobCount: 2,
      terminalCount: 2,
      notificationQueuedAt: 100,
      watchdogState: "dashboard_observation_pending",
    }],
  });
  assert.deepEqual(backgroundDeliveryNotifyDecision(undefined, next), {
    title: "Research resumed background work",
    body: "The parent workflow delivered its result.",
    sessionId: next.id,
    notificationId: "bgcont-1",
  });
  assert.equal(backgroundDeliveryNotifyDecision(next, next), null);
  assert.equal(backgroundDeliveryNotifyDecision(undefined, {
    ...next,
    backgroundDeliveries: [{ ...next.backgroundDeliveries![0]!, dashboardObservedAt: 101 }],
  }), null);

  const second = {
    ...next.backgroundDeliveries![0]!,
    continuationId: "bgcont-2",
    parentTurnId: "turn-2",
  };
  assert.equal(
    backgroundDeliveryNotifyDecisions(undefined, {
      ...next,
      backgroundDeliveries: [next.backgroundDeliveries![0]!, second],
    }).length,
    2,
    "each newly visible continuation gets its own notification before the snapshot is acknowledged",
  );
});

test("notification tags and click handlers remain bound to the originating instance", () => {
  const previousNotification = globalThis.Notification;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const created: Array<{ options?: NotificationOptions; onclick: (() => void) | null }> = [];
  class FakeNotification {
    static permission = "granted" as NotificationPermission;
    static requestPermission = async () => "granted" as NotificationPermission;
    onclick: (() => void) | null = null;
    constructor(_title: string, readonly options?: NotificationOptions) { created.push(this); }
    close() {}
  }
  const clicks: string[] = [];
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: FakeNotification });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "hidden" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { focus() {} } });
  try {
    const instance = new Notifier();
    instance.enabled = true;
    const payload = { title: "Done", body: "Finished", sessionId: "same-session" };
    instance.show(payload, { instanceId: "remote-a", onClick: (id) => clicks.push(`a:${id}`) });
    instance.show(payload, { instanceId: "remote-b", onClick: (id) => clicks.push(`b:${id}`) });
    instance.show({ ...payload, notificationId: "bgcont-1" }, {
      instanceId: "remote-a", onClick: (id) => clicks.push(`a:${id}`),
    });
    instance.show({ ...payload, notificationId: "bgcont-2" }, {
      instanceId: "remote-a", onClick: (id) => clicks.push(`a:${id}`),
    });
    assert.deepEqual(created.map((item) => item.options?.tag), [
      "remote-a:same-session",
      "remote-b:same-session",
      "remote-a:same-session:bgcont-1",
      "remote-a:same-session:bgcont-2",
    ]);
    created[0]!.onclick?.();
    assert.deepEqual(clicks, ["a:same-session"]);
  } finally {
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: previousNotification });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});


test("questions and approvals receive distinct notification labels", () => {
  const question = session({
    status: "input_required",
    pendingApproval: { requestId: "question", title: "Which database?", options: [], kind: "question" },
  });
  const approval = session({
    status: "input_required",
    pendingApproval: { requestId: "approval", title: "Run deploy?", options: [], kind: "permission" },
  });
  const recovery = session({
    status: "input_required",
    pendingApproval: {
      requestId: "recovery",
      title: "Which database?",
      options: [],
      kind: "question",
      recoveryReason: "provider_restart",
    },
  });
  assert.match(notifyDecision(session({ status: "running" }), question)!.body, /^Answer required/);
  assert.match(notifyDecision(session({ status: "running" }), approval)!.body, /^Approval required/);
  assert.match(notifyDecision(session({ status: "running" }), recovery)!.body, /^Recovery required/);
});
