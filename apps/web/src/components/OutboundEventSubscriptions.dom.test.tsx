import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AutomationSchedule,
  CreateOutboundEventSubscriptionRequest,
  OutboundEventDeliveryView,
  OutboundEventSubscriptionCredential,
  OutboundEventSubscriptionView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext, FeedbackProvider, type ConfirmationOptions } from "./FeedbackProvider.js";
import { OutboundEventSubscriptions } from "./OutboundEventSubscriptions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  ResizeObserver: domWindow.ResizeObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = Date.now();
const MINUTE = 60_000;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const snapshot: UiSnapshotMessage = {
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
  runners: [],
  boxes: [],
  sessions: [],
  runs: [],
  pods: [],
};

function subscription(id: string, overrides: Partial<OutboundEventSubscriptionView> = {}): OutboundEventSubscriptionView {
  return {
    subscriptionId: id,
    callbackUrl: `https://${id}.example.com/hooks/wollipog?token=private`,
    scope: { kind: "project", projectId: "project-acme" },
    eventKinds: ["session.completed", "pull_request.merged", "checks.failed", "session.created"],
    includeSessionName: false,
    includeQuestionTitle: false,
    state: "active",
    generation: 1,
    createdBy: { kind: "human", id: "test" },
    createdAt: NOW - 60 * MINUTE,
    updatedAt: NOW - 60 * MINUTE,
    ...overrides,
  };
}

function delivery(id: string, overrides: Partial<OutboundEventDeliveryView>): OutboundEventDeliveryView {
  return {
    deliveryId: id,
    subscriptionId: "sub",
    eventId: `event-${id}`,
    kind: "session.completed",
    status: "delivered",
    attemptCount: 1,
    createdAt: NOW - 10 * MINUTE,
    // Settled as it was attempted, unless a test says otherwise.
    updatedAt: overrides.lastAttemptAt ?? NOW - 10 * MINUTE,
    lastAttemptAt: NOW - 10 * MINUTE,
    statusCode: 204,
    ...overrides,
  };
}

const automations = [{ automationId: "automation-audit", name: "Nightly Audit" }] as AutomationSchedule[];
const projects = [{ id: "project-acme", name: "acme-storefront" }];

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  confirmations: ConfirmationOptions[];
  toasts: string[];
  creates: CreateOutboundEventSubscriptionRequest[];
  render: () => Promise<void>;
}

/** Every confirmation the tab asks for, answered by `answer`; by default it is declined. */
let answer: (options: ConfirmationOptions) => Promise<boolean> = async () => false;

async function mount(
  subscriptions: OutboundEventSubscriptionView[],
  deliveries: Record<string, OutboundEventDeliveryView[]> = {},
  overrides: Partial<ApiClient> = {},
  /** The app's own FeedbackProvider, so confirmations are real dialogs, instead of `answer`. */
  realFeedback = false,
): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `outbound-${Math.random()}`,
    runtimeKey: "outbound:1",
    createSocket: () => socket,
    close() {},
  };
  const confirmations: ConfirmationOptions[] = [];
  const toasts: string[] = [];
  const creates: CreateOutboundEventSubscriptionRequest[] = [];
  const client = {
    ...api,
    outboundEventSubscriptions: async () => [...subscriptions],
    outboundEventDeliveries: async (subscriptionId: string) => deliveries[subscriptionId] ?? [],
    createOutboundEventSubscription: async (request: CreateOutboundEventSubscriptionRequest) => {
      creates.push(structuredClone(request));
      return { subscription: subscription("created"), secret: "whsec_created" };
    },
    ...overrides,
  } as unknown as ApiClient;
  const feedback = {
    confirm: async (options: ConfirmationOptions) => {
      confirmations.push(options);
      return answer(options);
    },
    showToast: (message: string) => { toasts.push(message); return 1; },
    showUndo: () => 1,
    dismissToast: () => {},
  };
  const tab = (
    <StoreProvider connection={connection}>
      <OutboundEventSubscriptions projects={projects} automations={automations} />
    </StoreProvider>
  );
  const tree = (
    <React.StrictMode>
      <ApiProvider client={client}>
        {realFeedback
          ? <FeedbackProvider>{tab}</FeedbackProvider>
          : <FeedbackContext.Provider value={feedback}>{tab}</FeedbackContext.Provider>}
      </ApiProvider>
    </React.StrictMode>
  );
  const render = async () => { await act(async () => { root.render(tree); }); };
  await render();
  await act(async () => { socket.push(snapshot); });
  await act(settle);
  return { container, root, socket, confirmations, toasts, creates, render };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.resolve();
}

async function unmount(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
}

function byText<T extends HTMLElement>(scope: ParentNode, selector: string, text: string): T {
  const found = [...scope.querySelectorAll<T>(selector)].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(found, `${selector} "${text}" is rendered`);
  return found;
}

const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
  await act(settle);
};

function rowOf(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-subscription-id="${id}"]`);
  assert.ok(row, `${id} row is rendered`);
  return row;
}

async function expand(container: HTMLElement, id: string): Promise<HTMLElement> {
  const row = rowOf(container, id);
  await click(row.querySelector<HTMLElement>(".outbound-subscription-open")!);
  return rowOf(container, id);
}

/** The row's ⋯, opened: its items in order, with a separator as "—". */
async function openMenu(container: HTMLElement, id: string): Promise<string[]> {
  await click(rowOf(container, id).querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
  const menu = domWindow.document.querySelector('[role="menu"]');
  assert.ok(menu, "the row's ⋯ opens");
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((child) => child.getAttribute("role") === "separator"
    ? "—"
    : child.querySelector(".menu-item-label")?.textContent?.trim() ?? child.textContent?.trim() ?? "");
}

function menuItem(label: string): HTMLElement {
  return byText(domWindow.document as unknown as ParentNode, '[role="menuitem"]', label);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const setValue = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: value }) as never);
    // React reads a text field's change from focus and keyup here, as SessionMoveDialogs' tests do.
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as never);
  });
};

const blur = async (input: HTMLInputElement) => {
  await act(async () => {
    input.blur();
    input.dispatchEvent(new domWindow.FocusEvent("focusout", { bubbles: true }) as never);
  });
};

test("a row names its callback, one badge, its scope, its event count and its last delivery in words", async () => {
  const healthy = subscription("healthy", { lastDeliveredAt: NOW - 4 * MINUTE });
  const failing = subscription("failing", { scope: { kind: "automation", automationId: "automation-audit" } });
  const fixture = await mount([healthy, failing], {
    healthy: [delivery("ok", { lastAttemptAt: NOW - 4 * MINUTE })],
    failing: [
      // An older delivery that was delivered, then a newer attempt that failed.
      delivery("old", { lastAttemptAt: NOW - 30 * MINUTE }),
      delivery("refused", { status: "failed", statusCode: undefined, error: "connect ECONNREFUSED 10.0.0.1:443", attemptCount: 6, lastAttemptAt: NOW - 2 * MINUTE }),
    ],
  });
  try {
    const healthyRow = rowOf(fixture.container, "healthy");
    assert.equal(healthyRow.querySelector(".outbound-subscription-address")?.textContent, "healthy.example.com/hooks/wollipog",
      "host and path, without the scheme or the query");
    assert.equal(healthyRow.querySelector(".status")?.textContent, "Active");
    assert.deepEqual([...healthyRow.querySelectorAll(".outbound-subscription-meta > span")].map((span) => span.textContent),
      ["Project: acme-storefront", "4 events", "Last delivered 4 minutes ago"]);
    const failingRow = rowOf(fixture.container, "failing");
    assert.equal(failingRow.querySelector(".status")?.textContent, "Delivery Failed");
    assert.deepEqual([...failingRow.querySelectorAll(".outbound-subscription-meta > span")].map((span) => span.textContent),
      ["Automation: Nightly Audit", "4 events", "Last delivery failed 2 minutes ago"]);
    assert.equal(fixture.container.querySelectorAll(".outbound-subscription-row .status").length, 2, "one badge per row");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Enabled|Key Generation/);
    assert.match(fixture.container.querySelector(".outbound-events-help")?.textContent ?? "",
      /^Send signed session, pull request and cost events to your own HTTPS address\. Prompts, transcripts and answers are never sent\.$/);
  } finally {
    await unmount(fixture);
  }
});

test("an opened row lists its events in words, names only included extras, and shows deliveries in words", async () => {
  const paused = subscription("paused", { state: "paused", pauseReason: "Paused after 6 bounded delivery attempts" });
  const fixture = await mount([paused], {
    paused: [
      delivery("retrying", { kind: "checks.failed", status: "retrying", statusCode: 500, attemptCount: 2, nextRetryAt: NOW + 6 * MINUTE + 10_000 }),
      delivery("refused", { kind: "session.created", status: "failed", statusCode: undefined, error: "connect ECONNREFUSED 10.0.0.1:443", attemptCount: 6 }),
      delivery("ok", { kind: "pull_request.merged" }),
    ],
  });
  try {
    const row = await expand(fixture.container, "paused");
    assert.equal(row.querySelector(".outbound-subscription-open")?.getAttribute("aria-expanded"), "true");
    assert.deepEqual([...row.querySelectorAll(".outbound-subscription-events-list li")].map((item) => item.textContent),
      ["Session Created", "Session Completed", "Pull Request Merged", "Checks Failed"]);
    assert.doesNotMatch(row.textContent ?? "", /Included|Excluded|Also Includes/, "with neither extra, nothing is said about them");
    const notice = row.querySelector(".notice.t-warning");
    assert.match(notice?.textContent ?? "", /Paused after 6 bounded delivery attempts/);
    assert.ok(byText(notice!, "button", "Resume"));
    const cells = [...row.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((cell) => cell.textContent));
    assert.deepEqual(cells, [
      ["Checks Failed", "HTTP 500", "Attempts: 2", "Next Retry: In 6 minutes"],
      ["Session Created", "Connection Refused", "Attempts: 6", "Next Retry: Gave up"],
      ["Pull Request Merged", "Delivered", "Attempts: 1", ""],
    ]);
    assert.deepEqual([...row.querySelectorAll("thead th")].map((th) => th.textContent), ["Event", "Result", "Attempts", "Next Retry"]);
    const tones = [...row.querySelectorAll("tbody .status")].map((badge) => [...badge.classList].find((name) => name.startsWith("t-")));
    assert.deepEqual(tones, ["t-danger", "t-danger", "t-success"]);
    // No timestamp and no placeholder dash anywhere on the tab.
    const text = fixture.container.textContent ?? "";
    assert.doesNotMatch(text, /—/);
    assert.doesNotMatch(text, /\d{1,2}:\d{2}:\d{2}/);
    assert.doesNotMatch(text, new RegExp(new Date(NOW - 10 * MINUTE).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await unmount(fixture);
  }
});

test("⋯ offers Copy Callback URL, Resume while paused and Rotate Secret, with Revoke Subscription last after a separator", async () => {
  const fixture = await mount([subscription("paused", { state: "paused" }), subscription("active")]);
  try {
    assert.deepEqual(await openMenu(fixture.container, "paused"),
      ["Copy Callback URL", "Resume", "Rotate Secret…", "—", "Revoke Subscription…"]);
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never); });
    await act(settle);
    assert.equal(rowOf(fixture.container, "active").querySelector('button[aria-haspopup="menu"]')?.getAttribute("aria-label"),
      "active.example.com Actions");
  } finally {
    await unmount(fixture);
  }
});

test("Rotate Secret and Revoke Subscription confirm with the callback's host and bring ⋯ back on a phone", async () => {
  let rotated = 0;
  let revoked = 0;
  answer = async (options) => {
    await options.onConfirm?.(new AbortController().signal);
    return true;
  };
  const fixture = await mount([subscription("hooks")], {}, {
    rotateOutboundEventSubscription: async () => {
      rotated += 1;
      return { subscription: subscription("hooks"), secret: "whsec_rotated" } satisfies OutboundEventSubscriptionCredential;
    },
    deleteOutboundEventSubscription: async () => { revoked += 1; return { revoked: true }; },
  } as Partial<ApiClient>);
  try {
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Rotate Secret…"));
    const rotate = fixture.confirmations.at(-1)!;
    assert.equal(rotate.title, "Rotate Secret");
    assert.equal(rotate.message,
      "The subscription to hooks.example.com gets a new signing secret. The old one stops working and any request in flight is canceled.");
    assert.equal(rotate.confirmLabel, "Rotate Secret");
    assert.equal(rotate.tone, "danger");
    assert.equal(rotate.back?.label, "Back to More Actions");
    assert.equal(rotated, 1);
    assert.match(fixture.container.querySelector(".outbound-events-secret")?.textContent ?? "", /Copy the Signing Secret Now.*hooks\.example\.com/);
    assert.equal(fixture.container.querySelector(".outbound-events-secret code")?.textContent, "whsec_rotated");

    await openMenu(fixture.container, "hooks");
    await click(menuItem("Revoke Subscription…"));
    const revoke = fixture.confirmations.at(-1)!;
    assert.equal(revoke.title, "Revoke Subscription");
    assert.equal(revoke.message, "Events stop going to hooks.example.com, and pending deliveries are dropped. This can't be undone.");
    assert.equal(revoke.confirmLabel, "Revoke Subscription");
    assert.equal(revoke.tone, "danger");
    assert.equal(revoke.back?.label, "Back to More Actions");
    assert.equal(revoked, 1);
    assertNoDomNode(fixture.container.querySelector(".outbound-events-secret"), "a revoked subscription's secret is cleared");

    // Back reopens the row's ⋯.
    answer = async (options) => { options.back?.run(); return false; };
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Rotate Secret…"));
    await act(settle);
    assert.ok(domWindow.document.querySelector('[role="menu"]'), "Back brings the ⋯ menu back");
  } finally {
    answer = async () => false;
    await unmount(fixture);
  }
});

test("a running Rotate Secret can't be dismissed, so a late rotation never replaces a newer secret or outlives a revoke (CR-1.2)", async () => {
  const rotations: Array<ReturnType<typeof deferred<OutboundEventSubscriptionCredential>>> = [];
  const revocation = deferred<{ revoked: boolean }>();
  const fixture = await mount([subscription("hooks")], {}, {
    rotateOutboundEventSubscription: () => {
      const next = deferred<OutboundEventSubscriptionCredential>();
      rotations.push(next);
      return next.promise;
    },
    deleteOutboundEventSubscription: () => revocation.promise,
  } as Partial<ApiClient>, true);
  const confirmation = () => domWindow.document.querySelector(".feedback-confirmation") as unknown as HTMLElement | null;
  const secret = () => fixture.container.querySelector(".outbound-events-secret code")?.textContent ?? null;
  try {
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Rotate Secret…"));
    assert.ok(confirmation(), "Rotate Secret asks first");
    await click(byText(confirmation()!, "button", "Rotate Secret"));
    assert.equal(rotations.length, 1);
    // While the rotation runs, Cancel and Escape leave the confirmation where it is.
    await click(byText<HTMLButtonElement>(confirmation()!, "button", "Cancel"));
    await act(async () => {
      domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
    });
    await act(settle);
    assert.ok(confirmation(), "a running rotation can't be dismissed");
    // No second rotation can start beside it.
    assert.equal(rotations.length, 1);
    await act(async () => { rotations[0]!.resolve({ subscription: subscription("hooks"), secret: "whsec_first" }); });
    await act(settle);
    assertNoDomNode(confirmation(), "the confirmation closes once the rotation settles");
    assert.equal(secret(), "whsec_first");

    await openMenu(fixture.container, "hooks");
    await click(menuItem("Revoke Subscription…"));
    await click(byText(confirmation()!, "button", "Revoke Subscription"));
    await click(byText<HTMLButtonElement>(confirmation()!, "button", "Cancel"));
    assert.ok(confirmation(), "a running revoke can't be dismissed");
    await act(async () => { revocation.resolve({ revoked: true }); });
    await act(settle);
    assertNoDomNode(confirmation());
    assert.equal(secret(), null, "the revoked subscription's secret is cleared and stays cleared");
  } finally {
    await unmount(fixture);
  }
});

test("a rotation that settles after the tab has gone shows no secret, and a late copy reports nothing", async () => {
  const rotation = deferred<OutboundEventSubscriptionCredential>();
  const writing = deferred<void>();
  let confirmed: Promise<void> | undefined;
  answer = async (options) => {
    confirmed = options.onConfirm?.(new AbortController().signal);
    return true;
  };
  const clipboard = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", { configurable: true, value: { writeText: () => writing.promise } });
  const fixture = await mount([subscription("hooks")], {}, {
    rotateOutboundEventSubscription: () => rotation.promise,
  } as Partial<ApiClient>);
  try {
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Rotate Secret…"));
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Copy Callback URL"));
    await act(async () => { fixture.root.unmount(); });
    rotation.resolve({ subscription: subscription("hooks"), secret: "whsec_late" });
    writing.resolve();
    await confirmed;
    await act(settle);
    assert.deepEqual(fixture.toasts, [], "the copy settled after the tab had gone");
    assert.doesNotMatch(domWindow.document.body.textContent ?? "", /whsec_late/);
  } finally {
    answer = async () => false;
    if (clipboard) Object.defineProperty(domWindow.navigator, "clipboard", clipboard);
    fixture.container.remove();
  }
});

test("Copy Callback URL copies the whole address and says so", async () => {
  const written: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
  const fixture = await mount([subscription("hooks")]);
  try {
    await openMenu(fixture.container, "hooks");
    await click(menuItem("Copy Callback URL"));
    assert.deepEqual(written, ["https://hooks.example.com/hooks/wollipog?token=private"]);
    assert.deepEqual(fixture.toasts, ["Callback URL copied."]);
  } finally {
    if (clipboard) Object.defineProperty(domWindow.navigator, "clipboard", clipboard);
    await unmount(fixture);
  }
});

test("the empty tab shows one New Subscription, in its empty state", async () => {
  const fixture = await mount([]);
  try {
    assert.match(fixture.container.textContent ?? "", /No Outbound Events Yet/);
    assert.match(fixture.container.textContent ?? "",
      /Send a signed request to your own service when a session finishes or a pull request merges\./);
    assert.equal([...fixture.container.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "New Subscription").length, 1);
    assert.doesNotMatch(fixture.container.textContent ?? "", /Close Subscription Form/);
  } finally {
    await unmount(fixture);
  }
});

test("a failed read says Couldn't Load Outbound Events with Retry, and Retry reads again", async () => {
  let fail = true;
  const fixture = await mount([], {}, {
    outboundEventSubscriptions: async () => {
      if (fail) throw new Error("GET /api/outbound-events/subscriptions failed: 503");
      return [subscription("hooks")];
    },
  });
  try {
    const notice = fixture.container.querySelector(".notice.t-danger");
    assert.match(notice?.textContent ?? "", /Couldn't Load Outbound Events/);
    assert.doesNotMatch(fixture.container.textContent ?? "", /No Outbound Events Yet/, "a failed read never claims the tab is empty");
    fail = false;
    await click(byText(notice!, "button", "Retry"));
    assertNoDomNode(fixture.container.querySelector(".notice.t-danger"));
    assert.ok(rowOf(fixture.container, "hooks"));
  } finally {
    await unmount(fixture);
  }
});

test("while reconnecting the last-known rows stay, dimmed under Reconnecting…, in the same wrapper", async () => {
  const fixture = await mount([subscription("hooks")]);
  try {
    const wrapper = fixture.container.querySelector(".outbound-subscriptions-list");
    assert.ok(wrapper);
    assert.equal(wrapper.classList.contains("is-stale"), false);
    await act(async () => { fixture.socket.onclose?.({ code: 1006 }); });
    await act(settle);
    const stale = fixture.container.querySelector(".outbound-subscriptions-list");
    assert.ok(stale?.classList.contains("is-stale"), "the rows are dimmed");
    assert.ok(stale?.querySelector('[data-subscription-id="hooks"]'), "the last-known row stays");
    assert.match(fixture.container.textContent ?? "", /Reconnecting…/);
    assert.doesNotMatch(fixture.container.textContent ?? "", /No Outbound Events Yet/);
  } finally {
    await unmount(fixture);
  }
});

test("before the first read the tab shows skeleton rows, never the empty state", async () => {
  const fixture = await mount([], {}, { outboundEventSubscriptions: () => new Promise<never>(() => {}) });
  try {
    assert.ok(fixture.container.querySelector(".surface .skeleton-bar"));
    assert.match(fixture.container.textContent ?? "", /Loading outbound events…/);
    assert.doesNotMatch(fixture.container.textContent ?? "", /No Outbound Events Yet/);
  } finally {
    await unmount(fixture);
  }
});

function dialog(): HTMLElement {
  const found = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  assert.ok(found, "New Subscription is open");
  return found;
}

async function openDialog(fixture: Fixture): Promise<HTMLElement> {
  await click(byText(fixture.container, "button", "New Subscription"));
  return dialog();
}

test("New Subscription checks the address on blur and on submit, focuses it and sends nothing", async () => {
  const fixture = await mount([]);
  try {
    const form = await openDialog(fixture);
    assert.equal(form.querySelector("form")?.noValidate, true);
    const url = form.querySelector<HTMLInputElement>("input[type=url]")!;
    for (const value of ["not a url", "http://events.example.com/hooks"]) {
      await setValue(url, value);
      await blur(url);
      assert.equal(url.getAttribute("aria-invalid"), "true", `${value} is refused`);
      const error = form.querySelector(".field-error");
      assert.equal(error?.textContent, "Enter a full HTTPS address, such as https://example.com/hooks.");
      assert.equal(url.getAttribute("aria-describedby"), error?.id, "the field is described by its error");
    }
    // A valid address clears the error as it is typed.
    await setValue(url, "https://events.example.com/hooks");
    assert.equal(url.getAttribute("aria-invalid"), null);
    assertNoDomNode(form.querySelector(".field-error"));

    await setValue(url, "not a url");
    (domWindow.document.activeElement as unknown as HTMLElement | null)?.blur();
    await click(byText(domWindow.document as unknown as ParentNode, "button", "Create Subscription"));
    assert.equal(url.getAttribute("aria-invalid"), "true");
    assert.equal(domWindow.document.activeElement, url as never, "Create Subscription focuses the invalid field");
    assert.deepEqual(fixture.creates, [], "nothing is sent");
  } finally {
    await unmount(fixture);
  }
});

test("New Subscription groups its events, counts them in the footer and refuses none chosen", async () => {
  const fixture = await mount([]);
  try {
    const form = await openDialog(fixture);
    assert.deepEqual([...form.querySelectorAll(".outbound-subscription-event-group .group-label")].map((label) => label.textContent),
      ["Sessions", "Pull Requests", "Cost"]);
    assert.equal(form.querySelectorAll(".outbound-subscription-events label.checkbox").length, 11);
    const count = () => domWindow.document.querySelector(".outbound-subscription-dialog-count")?.textContent;
    assert.equal(count(), "2 events selected");
    for (const label of ["Session Created", "Input Required"]) {
      await click(byText<HTMLLabelElement>(form, "label.checkbox", label).querySelector("input")!);
    }
    assert.equal(count(), "No events selected");
    await setValue(form.querySelector<HTMLInputElement>("input[type=url]")!, "https://events.example.com/hooks");
    await click(byText(domWindow.document as unknown as ParentNode, "button", "Create Subscription"));
    assert.match(form.textContent ?? "", /Choose at least one event to send\./);
    assert.deepEqual(fixture.creates, []);
    await click(byText<HTMLLabelElement>(form, "label.checkbox", "Checks Failed").querySelector("input")!);
    assert.doesNotMatch(form.textContent ?? "", /Choose at least one event to send\./);
    assert.equal(count(), "1 event selected");
    await click(byText(domWindow.document as unknown as ParentNode, "button", "Create Subscription"));
    assert.deepEqual(fixture.creates, [{
      callbackUrl: "https://events.example.com/hooks",
      scope: { kind: "project", projectId: "project-acme" },
      eventKinds: ["checks.failed"],
      includeSessionName: false,
      includeQuestionTitle: false,
    }]);
  } finally {
    await unmount(fixture);
  }
});

test("a refused create keeps the dialog open with a danger notice at the end of its body", async () => {
  const fixture = await mount([], {}, {
    createOutboundEventSubscription: async () => { throw new Error("callback hostname could not be resolved"); },
  });
  try {
    const form = await openDialog(fixture);
    await setValue(form.querySelector<HTMLInputElement>("input[type=url]")!, "https://nowhere.example.com/hooks");
    await click(byText(domWindow.document as unknown as ParentNode, "button", "Create Subscription"));
    const notice = form.querySelector("form > .notice.t-danger:last-child");
    assert.match(notice?.textContent ?? "", /Couldn't Create Subscription/);
    assertNoDomNode(form.querySelector(".modal-foot .notice"), "no error in the footer");
  } finally {
    await unmount(fixture);
  }
});

test("a create that settles after the tab has gone shows no secret", async () => {
  const creation = deferred<OutboundEventSubscriptionCredential>();
  const fixture = await mount([], {}, { createOutboundEventSubscription: () => creation.promise });
  try {
    const form = await openDialog(fixture);
    await setValue(form.querySelector<HTMLInputElement>("input[type=url]")!, "https://events.example.com/hooks");
    await click(byText(domWindow.document as unknown as ParentNode, "button", "Create Subscription"));
    await act(async () => { fixture.root.unmount(); });
    creation.resolve({ subscription: subscription("created"), secret: "whsec_after_unmount" });
    await act(settle);
    assert.doesNotMatch(domWindow.document.body.textContent ?? "", /whsec_after_unmount/);
  } finally {
    fixture.container.remove();
  }
});
