import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { Notifier, notifyDecision } from "./notify.js";

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

test("authentication input is labeled as sign-in rather than tool approval", () => {
  const next = session({
    status: "input_required",
    pendingApproval: { requestId: "auth", title: "Sign in to Gemini CLI", options: [], kind: "authentication" },
  });
  assert.match(notifyDecision(session({ status: "running" }), next)!.body, /^Sign-in required/);
});

test("running -> completed / failed / idle each notify", () => {
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "completed" }))!.title, /completed/);
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "failed" }))!.title, /failed/);
  assert.match(notifyDecision(session({ status: "running" }), session({ status: "idle" }))!.title, /ready/);
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
    assert.deepEqual(created.map((item) => item.options?.tag), ["remote-a:same-session", "remote-b:same-session"]);
    created[0]!.onclick?.();
    assert.deepEqual(clicks, ["a:same-session"]);
  } finally {
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: previousNotification });
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
