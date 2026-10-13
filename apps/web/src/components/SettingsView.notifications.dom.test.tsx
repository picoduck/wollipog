import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { PushSetting } from "../push.js";
import { SETTINGS_SECTIONS, type SettingsSection } from "../navigation.js";
import { DEFAULT_EXPERIMENT_FLAGS } from "../experiments.js";
import { ExperimentalPanel, NotificationsPanel, SettingsView, useNotifySetting } from "./SettingsView.js";
import { notifier } from "../notify.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/settings/notifications" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries({ ...globals, Notification: undefined })) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: undefined });
  notifier.enabled = false;
});

/** The browser's Notification API, reduced to the permission this section reads. */
function stubNotification(permission: NotificationPermission, answer: NotificationPermission = permission) {
  const stub = {
    permission,
    requestPermission: async () => {
      stub.permission = answer;
      return answer;
    },
  };
  Object.defineProperty(globalThis, "Notification", { configurable: true, writable: true, value: stub });
  return stub;
}

function push(overrides: Partial<PushSetting> = {}): PushSetting {
  return { state: "off", confirmed: false, toggle: async () => undefined, ...overrides };
}

/** The shell's composition: the live hook, read through the panel production mounts. */
function LiveNotifications({ setting }: { setting: PushSetting }) {
  return <NotificationsPanel notify={useNotifySetting()} push={setting} />;
}

async function render(node: React.ReactNode) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    async rerender(next: React.ReactNode) {
      await act(async () => root.render(next));
    },
    switchNamed(title: string) {
      const control = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
        .find((element) => element.textContent?.includes(title));
      assert.ok(control, `${title} renders`);
      return control;
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a window with neither kind of alert says so instead of showing an empty group", async () => {
  // No Notification API (the global is undefined) and push unavailable: both rows return null.
  const view = await render(<LiveNotifications setting={push({ state: "unavailable" })} />);
  try {
    const { container } = view;
    assert.equal(container.querySelectorAll('[role="switch"]').length, 0);
    assertNoDomNode(container.querySelector(".settings-group"), "no group surrounds no rows");
    assertNoDomNode(container.querySelector(".settings-group-title"), "and no heading sits over nothing");
    const state = container.querySelector(".settings-state-surface > .state.compact");
    assert.ok(state, "a compact state in a padded surface takes the group's place");
    assert.equal(state.querySelector("h3.state-title")?.textContent, "Alerts Aren't Available Here");
    assert.equal(state.querySelector(".state-body")?.textContent,
      "This window can't show system notifications. Anything that needs you still shows a count on Sessions.");
  } finally {
    await view.unmount();
  }
});

test("either kind alone is enough to show the group", async () => {
  const pushOnly = await render(<LiveNotifications setting={push()} />);
  try {
    assertNoDomNode(pushOnly.container.querySelector(".settings-state-surface"));
    assert.ok(pushOnly.switchNamed("Push Notifications"));
  } finally {
    await pushOnly.unmount();
  }
  stubNotification("default");
  const desktopOnly = await render(<LiveNotifications setting={push({ state: "unavailable" })} />);
  try {
    assertNoDomNode(desktopOnly.container.querySelector(".settings-state-surface"));
    assert.ok(desktopOnly.switchNamed("Desktop Alerts"));
  } finally {
    await desktopOnly.unmount();
  }
});

test("a browser that blocks alerts disables Desktop Alerts and says how to allow them", async () => {
  const browser = stubNotification("denied");
  notifier.enabled = true;
  const view = await render(<LiveNotifications setting={push()} />);
  try {
    const { container } = view;
    const desktop = view.switchNamed("Desktop Alerts");
    assert.equal(desktop.disabled, true, "nothing the page does can turn it on");
    assert.equal(desktop.getAttribute("aria-checked"), "false", "a saved choice the browser refuses is not on");
    const description = domWindow.document.getElementById(desktop.getAttribute("aria-describedby")!);
    assert.equal(description?.textContent, "Your browser blocks alerts from Wollipog.");
    const notice = container.querySelector(".notice.t-warning.compact");
    assert.ok(notice, "a compact warning notice");
    assert.ok(notice.compareDocumentPosition(container.querySelector(".settings-group-surface")!) &
      domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "sits above the surface");
    assert.match(notice.textContent ?? "",
      /Allow notifications for this site in your browser's settings, then turn Desktop Alerts on\./);
    const tryAgain = notice.querySelector<HTMLButtonElement>("button");
    assert.equal(tryAgain?.textContent, "Try Again");

    // Still blocked: Try Again reads the same answer and nothing changes.
    await act(async () => tryAgain!.click());
    assert.ok(container.querySelector(".notice.t-warning"), "still blocked, still explained");

    // Allowed in the browser's settings, then Try Again: the notice clears and the row works again.
    browser.permission = "granted";
    await act(async () => tryAgain!.click());
    assertNoDomNode(container.querySelector(".notice"), "the notice clears once the browser allows alerts");
    const allowed = view.switchNamed("Desktop Alerts");
    assert.equal(allowed.disabled, false);
    assert.equal(allowed.getAttribute("aria-checked"), "true", "the saved choice applies again");
    assert.match(allowed.textContent ?? "", /Approvals and finished turns, while Wollipog is open\./);
  } finally {
    await view.unmount();
  }
});

test("Try Again clears the notice when the browser will ask again", async () => {
  const browser = stubNotification("denied");
  const view = await render(<LiveNotifications setting={push()} />);
  try {
    browser.permission = "default";
    await act(async () => view.container.querySelector<HTMLButtonElement>(".notice button")!.click());
    assertNoDomNode(view.container.querySelector(".notice"));
    assert.equal(view.switchNamed("Desktop Alerts").disabled, false, "turning it on will show the prompt");
  } finally {
    await view.unmount();
  }
});

test("refusing the push prompt blocks Desktop Alerts too, once push settles", async () => {
  // Push asks for the same permission. Its refusal never passes through this hook's toggle, so a
  // permission held in state stayed "default" and Desktop Alerts looked operable (#3117 review).
  const browser = stubNotification("default");
  const view = await render(<LiveNotifications setting={push({ state: "busy", confirmed: false })} />);
  try {
    assertNoDomNode(view.container.querySelector(".notice"));
    browser.permission = "denied";
    // The shell re-renders the panel when push settles back to off.
    await view.rerender(<LiveNotifications setting={push({ state: "off", confirmed: false })} />);
    assert.ok(view.container.querySelector(".notice.t-warning"), "the refusal is explained");
    assert.equal(view.switchNamed("Desktop Alerts").disabled, true);
  } finally {
    await view.unmount();
  }
});

test("coming back to the window re-reads a permission changed in the browser's settings", async () => {
  const browser = stubNotification("denied");
  const view = await render(<LiveNotifications setting={push()} />);
  try {
    assert.ok(view.container.querySelector(".notice.t-warning"));
    browser.permission = "granted";
    await act(async () => window.dispatchEvent(new domWindow.Event("focus") as unknown as Event));
    assertNoDomNode(view.container.querySelector(".notice"), "allowed in the browser, without Try Again");
    assert.equal(view.switchNamed("Desktop Alerts").disabled, false);
  } finally {
    await view.unmount();
  }
});

test("refusing the browser's prompt shows the blocked state rather than a switch that snaps back", async () => {
  stubNotification("default", "denied");
  const view = await render(<LiveNotifications setting={push()} />);
  try {
    assertNoDomNode(view.container.querySelector(".notice"));
    await act(async () => view.switchNamed("Desktop Alerts").click());
    assert.ok(view.container.querySelector(".notice.t-warning"), "the refusal is explained at once");
    assert.equal(view.switchNamed("Desktop Alerts").disabled, true);
  } finally {
    await view.unmount();
  }
});

test("while push turns on the row says so and the switch keeps its confirmed value", async () => {
  const view = await render(<LiveNotifications setting={push({ state: "busy", confirmed: false })} />);
  try {
    const control = view.switchNamed("Push Notifications");
    assert.equal(control.getAttribute("aria-checked"), "false", "not on until the server confirms it");
    assert.equal(control.getAttribute("aria-busy"), "true");
    const busy = view.container.querySelector(".setting-row-desc-slot.is-busy");
    assert.match(busy?.textContent ?? "", /Turning on push for this browser…/);
    // The description stays underneath, hidden, so the row keeps its height.
    const description = view.container.querySelector<HTMLElement>(".setting-row-desc[aria-hidden='true']");
    assert.equal(description?.textContent, "Get alerts even when Wollipog is closed.");
  } finally {
    await view.unmount();
  }
});

test("while push turns off the switch stays on and the row keeps its own description", async () => {
  const view = await render(<LiveNotifications setting={push({ state: "busy", confirmed: true })} />);
  try {
    const control = view.switchNamed("Push Notifications");
    assert.equal(control.getAttribute("aria-checked"), "true", "still on until the subscription is gone");
    assert.doesNotMatch(control.textContent ?? "", /Turning on/);
    assert.match(control.textContent ?? "", /Get alerts even when Wollipog is closed\./);
  } finally {
    await view.unmount();
  }
});

test("every Notifications and Experimental sentence ends with a period, and the old words are gone", async () => {
  stubNotification("default");
  const notifications = await render(<LiveNotifications setting={push()} />);
  const experimental = await render(<ExperimentalPanel flags={DEFAULT_EXPERIMENT_FLAGS} onToggle={() => undefined} />);
  try {
    const sections = ["notifications", "experimental"].map((id) => SETTINGS_SECTIONS.find((entry) => entry.id === id)!);
    const sentences = [
      ...sections.flatMap((entry) => [entry.description, entry.panelDescription!]),
      ...[notifications, experimental].flatMap((view) =>
        [...view.container.querySelectorAll(".setting-row-desc")].map((element) => element.textContent ?? "")),
    ];
    assert.equal(sentences.length, 8, "two index lines, two panel heads and four row descriptions");
    for (const sentence of sentences) assert.match(sentence, /\.$/, `"${sentence}" ends with a period`);
    for (const view of [notifications, experimental]) {
      assert.doesNotMatch(view.container.textContent ?? "", /Push-to-wake|Untested Features/i);
      assertNoDomNode(view.container.querySelector(".settings-group-title"), "one ungrouped surface");
    }
    assert.deepEqual(sections.map((entry) => [entry.panelDescription, entry.scope]), [
      ["Alerts for approvals and finished turns.", "This Device"],
      ["Early features. Turning one off hides it from navigation and search.", "This Device"],
    ]);
    assert.deepEqual([...experimental.container.querySelectorAll(".setting-row-desc")].map((element) => element.textContent), [
      "Runs that coordinate several agents in a workflow graph.",
      "Shared-context groups of sessions.",
    ]);
  } finally {
    await notifications.unmount();
    await experimental.unmount();
  }
});

test("the panel head says what each section's index line has no room for", async () => {
  for (const [section, expected] of [
    ["notifications", "Alerts for approvals and finished turns."],
    ["experimental", "Early features. Turning one off hides it from navigation and search."],
    // A section without a longer sentence keeps its index line in the head.
    ["about", "Versions and updates."],
  ] as const) {
    const view = await render(
      <SettingsView section={section} onNavigate={() => undefined}
        panels={Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry.id, null])) as Record<SettingsSection, React.ReactNode>} />,
    );
    try {
      assert.equal(view.container.querySelector(".settings-panel-desc")?.textContent, expected);
      if (section !== "about") {
        assert.equal(view.container.querySelector(".settings-panel-scope")?.textContent, "This Device");
      }
    } finally {
      await view.unmount();
    }
  }
});
