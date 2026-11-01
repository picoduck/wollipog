import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  ActiveInstanceConnectionProvider,
  InstancesContextProvider,
  type ActiveInstanceConnection,
  type InstanceAvailability,
  type InstanceManager,
} from "../instances-context.js";
import { FeedbackContext, type ConfirmationOptions } from "./FeedbackProvider.js";
import { InstanceSelector } from "./InstanceSelector.js";
import { InstancesPanel, resetInstanceRowFeedback } from "./InstancesPanel.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/connections/instances" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const local: InstanceProfile = {
  id: "local",
  serverInstanceId: "local",
  kind: "local",
  label: "This Machine",
  origin: "http://127.0.0.1:4317",
  createdAt: "",
};
const remote: InstanceProfile = {
  id: "e9df4628-0ed8-4a42-a608-62d52ed94b74",
  serverInstanceId: "60c2e80c-24a2-48da-9428-eea738e89979",
  kind: "remote",
  label: "Home Workstation",
  origin: "https://home-workstation.example.test",
  createdAt: "2026-07-20T00:00:00Z",
  lastConnectedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
};

function manager(overrides: Partial<InstanceManager> = {}): InstanceManager {
  return {
    desktopMultiInstance: true,
    registry: { profiles: [local, remote], activeInstanceId: "local" },
    activeProfile: local,
    runtime: null,
    navigation: undefined,
    phase: "ready",
    error: null,
    statusByProfile: { local: { availability: "online" } },
    async switchInstance() {},
    async retryActive() {},
    async addInstance() {},
    async editInstance() {},
    async repairInstance() {},
    async removeInstance() {},
    manageInstances() {},
    openInstanceDialog() {},
    async goToThisMachine() {},
    reportActiveStatus() {},
    ...overrides,
  };
}

interface Feedback {
  confirmations: ConfirmationOptions[];
  toasts: string[];
  accept: boolean;
}

function mount(value: InstanceManager, options: { connection?: ActiveInstanceConnection | null; selector?: boolean; reset?: boolean } = {}) {
  if (options.reset !== false) resetInstanceRowFeedback();
  const feedback: Feedback = { confirmations: [], toasts: [], accept: true };
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const mountPoint = host as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const addButton = { current: null as HTMLButtonElement | null };
  const element = (next: InstanceManager, connection: ActiveInstanceConnection | null) => (
    <FeedbackContext.Provider value={{
      confirm: async (confirmation) => { feedback.confirmations.push(confirmation); return feedback.accept; },
      showToast: (message) => { feedback.toasts.push(message); return 1; },
      showUndo: () => -1,
      dismissToast: () => undefined,
    }}>
      <InstancesContextProvider value={next}>
        <ActiveInstanceConnectionProvider value={connection}>
          {options.selector && <InstanceSelector />}
          <button ref={addButton} type="button">Add Remote Instance…</button>
          <InstancesPanel addButtonRef={addButton} />
        </ActiveInstanceConnectionProvider>
      </InstancesContextProvider>
    </FeedbackContext.Provider>
  );
  return {
    feedback,
    mountPoint,
    addButton,
    render: (next = value, connection = options.connection ?? null) => act(async () => { root.render(element(next, connection)); }),
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
const rowOf = (scope: ParentNode, profile: InstanceProfile) =>
  scope.querySelector<HTMLElement>(`.instance-row[data-instance-id="${profile.id}"]`)!;
const buttons = (row: HTMLElement) =>
  Array.from(row.querySelectorAll<HTMLButtonElement>(".instance-row-actions button"));
const slotLabels = (row: HTMLElement) =>
  buttons(row).filter((button) => !button.classList.contains("icon-btn")).map((button) => button.textContent?.trim());

test("the tab is one surface of two-line rows in registry order, This Machine first, with no card grid or count", async () => {
  const view = mount(manager({
    statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "online" } },
  }));
  await view.render();
  try {
    const surface = view.mountPoint.querySelector(".surface.instance-list")!;
    assert.ok(surface, "one surface");
    const rows = Array.from(surface.querySelectorAll<HTMLElement>(":scope > .row.row-2.instance-row"));
    assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), ["This Machine", "Home Workstation"]);
    assertNoDomNode(view.mountPoint.querySelector(".instance-card, .instance-grid, .instances-page, .toolbar, dl"));
    assert.doesNotMatch(view.mountPoint.textContent ?? "", /\b2 Instances\b/, "the tab carries the count");

    // The lead is the rail tile's recipe with its corner dot; line 1 the name and its one badge.
    const [mine, theirs] = rows;
    assert.equal(mine!.querySelector(".instance-monogram.tile")?.textContent, "TM");
    assert.equal(theirs!.querySelector(".instance-monogram.tile")?.textContent, "HW");
    assert.equal(theirs!.querySelector(".row-title")?.getAttribute("title"), "Home Workstation", "the full name is the tooltip");
    // Line 2: where the instance is, and for a healthy remote its mono address and last connection.
    assert.equal(mine!.querySelector(".row-sub")?.textContent, "On this machine");
    const address = theirs!.querySelector(".instance-row-address")!;
    assert.equal(address.textContent, remote.origin);
    assert.equal(address.getAttribute("title"), remote.origin, "the full origin is the tooltip");
    assert.equal(theirs!.querySelector(".instance-row-last")?.textContent, "Last connected 40d ago");
    // This Machine has no menu; a remote has one named for it.
    assertNoDomNode(mine!.querySelector('[aria-haspopup="menu"]'));
    assert.equal(theirs!.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-label"), "More Actions for Home Workstation");
  } finally {
    await view.unmount();
  }
});

/**
 * Every availability, inactive and active, with and without the shell's banner (#2102, #3002): the
 * one word in its tone and hollow state (the tile's dot agrees), line 2, and the one slot.
 */
test("each state has one word, one sentence on line 2 and at most one slot button, and agrees with the rail", async () => {
  const never = { ...remote, lastConnectedAt: undefined };
  const cases: Array<{
    name: string;
    availability?: InstanceAvailability;
    message?: string;
    active?: boolean;
    phase?: InstanceManager["phase"];
    connection?: ActiveInstanceConnection;
    profile?: InstanceProfile;
    word: string | null;
    tone?: string;
    hollow?: boolean;
    line2: string;
    slot: string[];
    current?: boolean;
  }> = [
    { name: "not tried yet", word: null, line2: `${remote.origin}Last connected 40d ago`, slot: ["Switch"] },
    { name: "never connected", profile: never, word: null, line2: `${remote.origin}Never connected`, slot: ["Switch"] },
    { name: "online", availability: "online", word: "Online", tone: "t-success", hollow: false, line2: `${remote.origin}Last connected 40d ago`, slot: ["Switch"] },
    { name: "offline", availability: "offline", message: "error sending request for url", word: "Offline", tone: "t-neutral", hollow: true, line2: "Didn't answer.Last connected 40d ago", slot: ["Switch"] },
    { name: "refused", availability: "offline", message: "Connection refused (os error 111)", word: "Offline", tone: "t-neutral", hollow: true, line2: "Refused the connection.Last connected 40d ago", slot: ["Switch"] },
    { name: "rejected pairing", availability: "authentication-required", word: "Pairing Required", tone: "t-warning", hollow: false, line2: "No longer accepts the saved pairing.Last connected 40d ago", slot: ["Re-Pair…"] },
    { name: "missing pairing", availability: "missing-credential", word: "Pairing Required", tone: "t-warning", hollow: false, line2: "This app has no saved pairing for it.Last connected 40d ago", slot: ["Re-Pair…"] },
    { name: "older version", availability: "incompatible", word: "Update Required", tone: "t-warning", hollow: false, line2: "Runs an older Wollipog. Update it on that computer.Last connected 40d ago", slot: [] },
    { name: "connecting", availability: "connecting", active: true, word: "Connecting", tone: "t-info", hollow: false, line2: `${remote.origin}Last connected 40d ago`, slot: ["Switch"] },
    { name: "current and online", availability: "online", active: true, word: "Online", tone: "t-success", hollow: false, line2: `${remote.origin}Last connected 40d ago`, slot: [], current: true },
    { name: "current and offline", availability: "offline", active: true, word: "Offline", tone: "t-neutral", hollow: true, line2: "Didn't answer.Last connected 40d ago", slot: ["Retry"] },
    // The manager still records Online a moment after the socket drops; the banner wins.
    { name: "banner offline", availability: "online", active: true, connection: "reconnecting", word: "Offline", tone: "t-neutral", hollow: true, line2: "Didn't answer.Last connected 40d ago", slot: ["Retry"] },
    { name: "banner pairing", availability: "online", active: true, connection: "sign-in-required", word: "Pairing Required", tone: "t-warning", hollow: false, line2: "No longer accepts the saved pairing.Last connected 40d ago", slot: ["Re-Pair…"] },
    // The banner describes only the active instance; another row keeps its own status.
    { name: "beside This Machine's banner", availability: "online", connection: "reconnecting", word: "Online", tone: "t-success", hollow: false, line2: `${remote.origin}Last connected 40d ago`, slot: ["Switch"] },
  ];
  for (const example of cases) {
    const profile = example.profile ?? remote;
    const value = manager({
      registry: { profiles: [local, profile], activeInstanceId: example.active ? profile.id : "local" },
      activeProfile: example.active ? profile : local,
      phase: example.phase ?? (example.availability === "connecting" ? "opening" : "ready"),
      statusByProfile: {
        local: { availability: "online" },
        ...(example.availability ? { [profile.id]: { availability: example.availability, message: example.message } } : {}),
      },
    });
    const view = mount(value, { connection: example.connection ?? null, selector: true });
    await view.render();
    try {
      const row = rowOf(view.mountPoint, profile);
      const badges = Array.from(row.querySelectorAll(".status"));
      const dot = row.querySelector(".instance-tile-dot");
      if (example.word === null) {
        assert.equal(badges.length, 0, `${example.name}: no badge`);
        assertNoDomNode(dot, `${example.name}: no dot`);
      } else {
        assert.equal(badges.length, 1, `${example.name}: one badge`);
        assert.equal(badges[0]!.textContent, example.word, example.name);
        assert.ok(badges[0]!.classList.contains(example.tone!), `${example.name}: ${badges[0]!.className}`);
        assert.equal(badges[0]!.classList.contains("hollow"), example.hollow, `${example.name}: badge hollow`);
        assert.ok(dot?.classList.contains(example.tone!), `${example.name}: the tile's dot is the badge's tone`);
        assert.equal(dot!.classList.contains("hollow"), example.hollow, `${example.name}: dot hollow`);
      }
      assert.equal(row.querySelector(".row-sub")?.textContent, example.line2, example.name);
      assert.deepEqual(slotLabels(row), example.slot, `${example.name}: the slot`);
      assert.ok(!buttons(row).some((button) => button.classList.contains("primary")), `${example.name}: no primary in a row`);
      assert.equal(Boolean(row.querySelector(".instance-row-current")), Boolean(example.current), `${example.name}: Current`);
      if (example.current) assert.equal(row.querySelector(".instance-row-current")?.textContent, "Current");
      assert.equal(row.querySelectorAll('[aria-haspopup="menu"]').length, 1, `${example.name}: one More Actions`);
      if (example.connection && example.active) {
        assert.doesNotMatch(row.textContent ?? "", /Online/, `${example.name}: never Online beside the banner`);
      }
      assert.doesNotMatch(view.mountPoint.textContent ?? "", /\bSaved\b|Sign-In Required|Local Control Plane|Available|Reconnecting/,
        `${example.name}: no retired word on the page`);

      // The rail tile and the instance menu say the same word (§11.2), the tooltip in sentence case.
      const tile = view.mountPoint.querySelector<HTMLButtonElement>(".instance-tile-trigger")!;
      if (example.active) {
        assert.equal(tile.getAttribute("data-rail-detail"), example.word!.charAt(0) + example.word!.slice(1).toLowerCase(), example.name);
      }
      await act(async () => { tile.click(); });
      const menuRow = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
        .find((item) => item.querySelector(".menu-text")?.textContent === profile.label)!;
      const menuStatus = menuRow.querySelector(".status")?.textContent ?? null;
      assert.equal(menuStatus, example.word === "Online" ? null : example.word, `${example.name}: the menu row`);
      assert.doesNotMatch(domWindow.document.querySelector('[role="menu"]')?.textContent ?? "", /\bSaved\b|Sign-In Required|Local Control Plane/);
      await act(async () => { tile.click(); });
    } finally {
      await view.unmount();
    }
  }
});

test("This Machine reads On this machine and Current, offers Retry while its connection is lost, and has no menu", async () => {
  let retries = 0;
  const value = manager({ async retryActive() { retries += 1; } });
  const view = mount(value);
  await view.render();
  try {
    let row = rowOf(view.mountPoint, local);
    assert.equal(row.querySelector(".status")?.textContent, "Online");
    assert.equal(row.querySelector(".instance-row-current")?.textContent, "Current");
    assert.ok(row.querySelector(".instance-row-current svg"), "a check before the word");
    assert.deepEqual(slotLabels(row), []);

    await view.render(value, "reconnecting");
    row = rowOf(view.mountPoint, local);
    assert.equal(row.querySelector(".status")?.textContent, "Offline");
    assert.equal(row.querySelector(".row-sub")?.textContent, "On this machine", "no transport sentence for This Machine");
    const retry = buttons(row).find((button) => button.textContent?.trim() === "Retry")!;
    await act(async () => { retry.click(); await tick(); });
    assert.equal(retries, 1);
    assertNoDomNode(row.querySelector('[aria-haspopup="menu"]'));
  } finally {
    await view.unmount();
  }
});

test("Switch keeps its label and width with a spinner while the row reads Connecting", async () => {
  let finish: () => void = () => undefined;
  const switched: string[] = [];
  const value = manager({
    statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "offline" } },
    switchInstance(profileId) {
      switched.push(profileId);
      return new Promise<void>((resolve) => { finish = resolve; });
    },
  });
  const view = mount(value);
  await view.render();
  try {
    const before = buttons(rowOf(view.mountPoint, remote))[0]!;
    assert.equal(before.textContent?.trim(), "Switch");
    assert.ok(before.querySelector("svg"), "an icon leads Switch");
    await act(async () => { before.click(); await tick(); });
    assert.deepEqual(switched, [remote.id]);

    // The manager makes the profile active and Connecting as the switch starts.
    const opening = manager({
      ...value,
      registry: { profiles: [local, remote], activeInstanceId: remote.id },
      activeProfile: remote,
      phase: "opening",
      statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "connecting" } },
    });
    await view.render(opening);
    const row = rowOf(view.mountPoint, remote);
    const busy = buttons(row)[0]!;
    assert.ok(busy === before, "the same button stays");
    assert.equal(busy.textContent?.trim(), "Switch", "the label stays");
    assert.equal(busy.getAttribute("aria-busy"), "true");
    assert.ok(busy.querySelector(".spinner"), "an inline spinner");
    assert.equal(row.querySelector(".status")?.textContent, "Connecting");
    assert.ok(row.querySelector(".status")?.classList.contains("pulse"), "Connecting pulses");
    assert.equal(row.getAttribute("aria-busy"), "true");
    assert.ok(Array.from(row.querySelectorAll(".sr-only[role=\"status\"]")).some((live) => live.textContent === "Switching to Home Workstation…"),
      "the switch is announced");

    await act(async () => { finish(); await tick(); });
    await view.render(manager({
      ...opening,
      phase: "ready",
      statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "online" } },
    }));
    assert.equal(rowOf(view.mountPoint, remote).querySelector(".instance-row-current")?.textContent, "Current");
  } finally {
    await view.unmount();
  }
});

test("a failed switch shows a danger notice under its row in the list that replaces the one pressed", async () => {
  // As InstanceProvider does: the switch makes the profile active and opening, the boundary
  // unmounts the shell's list, and a failed connection resolves the switch with the failed phase.
  let finish: () => void = () => undefined;
  let connection = 1;
  const value = manager({
    statusByProfile: { local: { availability: "online" } },
    switchInstance: () => {
      connection += 1;
      return new Promise<void>((resolve) => { finish = resolve; });
    },
    currentConnection: () => connection,
  });
  const shell = mount(value);
  await shell.render();
  await act(async () => { buttons(rowOf(shell.mountPoint, remote))[0]!.click(); await tick(); });
  await shell.unmount();

  const switched = { registry: { profiles: [local, remote], activeInstanceId: remote.id }, activeProfile: remote };
  const view = mount(manager({
    ...value,
    ...switched,
    phase: "opening",
    statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "connecting" } },
  }), { reset: false });
  await view.render();
  try {
    let row = rowOf(view.mountPoint, remote);
    assert.equal(buttons(row)[0]!.textContent?.trim(), "Switch", "the recovery screen's list shows the switch running");
    assert.equal(buttons(row)[0]!.getAttribute("aria-busy"), "true");
    await act(async () => { finish(); await tick(); });
    await view.render(manager({
      ...value,
      ...switched,
      phase: "failed",
      error: "tcp connect error: Connection refused (os error 111)",
      statusByProfile: {
        local: { availability: "online" },
        [remote.id]: { availability: "offline", message: "tcp connect error: Connection refused (os error 111)" },
      },
    }));
    row = rowOf(view.mountPoint, remote);
    assert.equal(row.querySelector(".row-sub")?.textContent, "Refused the connection.Last connected 40d ago");
    assert.deepEqual(slotLabels(row), ["Retry"]);
    const notice = row.nextElementSibling as HTMLElement;
    assert.ok(notice?.classList.contains("notice"), "directly below the row");
    assert.ok(notice.classList.contains("t-danger") && notice.classList.contains("compact"));
    assert.ok(notice.parentElement?.classList.contains("instance-list"), "inside the surface");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Couldn't switch to “Home Workstation”. Try again.");
    assert.doesNotMatch(notice.textContent ?? "", /os error/, "the raw message waits behind Show Details");
    const details = Array.from(notice.querySelectorAll("button")).find((button) => button.textContent === "Show Details")!;
    await act(async () => { details.click(); });
    assert.match(notice.querySelector(".notice-details-body")?.textContent ?? "", /Connection refused \(os error 111\)/);
    const dismiss = notice.querySelector<HTMLButtonElement>(".notice-dismiss")!;
    await act(async () => { dismiss.click(); });
    assertNoDomNode(view.mountPoint.querySelector(".instance-list > .notice"));
  } finally {
    await view.unmount();
  }
});

test("a finished Switch never speaks for a later connection of the same instance that fails", async () => {
  let connection = 1;
  const value = manager({
    async switchInstance() { connection += 1; },
    currentConnection: () => connection,
  });
  const view = mount(value);
  await view.render();
  try {
    // The switch opens Home Workstation, and the list shows it current and online.
    await act(async () => { buttons(rowOf(view.mountPoint, remote))[0]!.click(); await tick(); });
    const switched = { registry: { profiles: [local, remote], activeInstanceId: remote.id }, activeProfile: remote };
    await view.render(manager({ ...value, ...switched, statusByProfile: { [remote.id]: { availability: "online" } } }));
    assert.equal(rowOf(view.mountPoint, remote).querySelector(".instance-row-current")?.textContent, "Current");

    // Later an edit, a re-pair or the recovery screen's Retry opens it again, and that fails.
    connection += 1;
    await view.render(manager({
      ...value,
      ...switched,
      phase: "failed",
      error: "error sending request for url",
      statusByProfile: { [remote.id]: { availability: "offline", message: "error sending request for url" } },
    }));
    const row = rowOf(view.mountPoint, remote);
    assert.equal(row.querySelector(".status")?.textContent, "Offline", "the row still says what is wrong");
    assertNoDomNode(view.mountPoint.querySelector(".instance-list > .notice"), "but no notice claims the switch failed");
  } finally {
    await view.unmount();
  }
});

test("More Actions holds Edit…, Re-Pair…, Copy Address and Remove…, which is last and danger", async () => {
  const opened: Parameters<InstanceManager["openInstanceDialog"]>[0][] = [];
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  const view = mount(manager({ openInstanceDialog(options) { opened.push(options); } }));
  await view.render();
  try {
    const trigger = rowOf(view.mountPoint, remote).querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
    assert.ok(trigger.classList.contains("icon-btn") && trigger.classList.contains("sm"));
    assert.equal(trigger.getAttribute("title"), "More Actions for Home Workstation");
    const open = async () => {
      await act(async () => { trigger.click(); });
      return document.querySelector<HTMLElement>('[role="menu"]')!;
    };
    let menu = await open();
    assert.equal(menu.getAttribute("aria-label"), "More Actions for Home Workstation");
    const children = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item, .menu-sep"));
    assert.deepEqual(children.map((child) => child.classList.contains("menu-sep") ? "—" : child.querySelector(".menu-text")?.textContent),
      ["Edit…", "Re-Pair…", "Copy Address", "—", "Remove…"]);
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item"));
    assert.ok(items.every((item) => item.querySelector(".menu-icon svg")), "each item has its icon");
    assert.ok(items.at(-1)!.classList.contains("danger"), "Remove… is danger");
    assert.ok(!items.slice(0, -1).some((item) => item.classList.contains("danger")));
    await act(async () => { trigger.click(); });

    // Edit… and Re-Pair… open the provider's one dialog and return focus to ⋯ (#3003).
    for (const [label, mode] of [["Edit…", "edit"], ["Re-Pair…", "repair"]] as const) {
      menu = await open();
      const item = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item")).find((each) => each.textContent === label)!;
      await act(async () => { item.click(); await tick(); });
      const request = opened.at(-1)!;
      assert.equal(request.mode, mode);
      assert.equal((request as { profileId: string }).profileId, remote.id);
      assert.ok(request.returnFocus === (trigger as never), `${label}: focus returns to ⋯`);
      assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));
    }

    // Copy Address copies the full origin, nothing else, and confirms.
    menu = await open();
    const copy = Array.from(menu.querySelectorAll<HTMLElement>(".menu-item")).find((each) => each.textContent === "Copy Address")!;
    await act(async () => { copy.click(); await tick(); });
    assert.deepEqual(copied, [remote.origin]);
    assert.deepEqual(view.feedback.toasts, ["Copied the address."]);
    assert.ok(domWindow.document.activeElement === (trigger as never), "focus stays on ⋯");
  } finally {
    if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
    else delete (domWindow.navigator as unknown as { clipboard?: unknown }).clipboard;
    await view.unmount();
  }
});

test("Remove… confirms what is removed and what is not, and focus returns to Add Remote Instance…", async () => {
  const removed: string[] = [];
  for (const active of [false, true]) {
    const value = manager({
      registry: { profiles: [local, remote], activeInstanceId: active ? remote.id : "local" },
      activeProfile: active ? remote : local,
      statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "online" } },
      async removeInstance(profileId) { removed.push(profileId); },
    });
    const view = mount(value);
    await view.render();
    try {
      const trigger = rowOf(view.mountPoint, remote).querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
      await act(async () => { trigger.click(); });
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] .menu-item'))
        .find((each) => each.textContent === "Remove…")!;
      await act(async () => { item.click(); await tick(); await tick(); });
      const confirmation = view.feedback.confirmations.at(-1)!;
      assert.equal(confirmation.title, "Remove Instance");
      assert.equal(confirmation.confirmLabel, "Remove Instance");
      assert.equal(confirmation.tone, "danger");
      assert.equal(confirmation.message, active
        ? "“Home Workstation” and its saved credential are removed from this app, and Wollipog switches to This Machine. Nothing on Home Workstation is deleted."
        : "“Home Workstation” and its saved credential are removed from this app. Nothing on Home Workstation is deleted.");
      await act(async () => { await tick(); await tick(); });
      assert.ok(domWindow.document.activeElement === (view.addButton.current as never), "focus returns to Add Remote Instance…");
    } finally {
      await view.unmount();
    }
  }
  assert.deepEqual(removed, [remote.id, remote.id]);
});

test("a 70-character name keeps one line with its full name as the tooltip, beside its badge and actions", async () => {
  const long = { ...remote, label: "Build Farm in the Northern Datacenter Rack Seven Beside the North Door" };
  assert.equal(long.label.length, 70);
  const view = mount(manager({
    registry: { profiles: [local, long], activeInstanceId: "local" },
    statusByProfile: { local: { availability: "online" }, [long.id]: { availability: "offline" } },
  }));
  await view.render();
  try {
    const row = rowOf(view.mountPoint, long);
    const title = row.querySelector(".row-line > .row-title")!;
    assert.equal(title.getAttribute("title"), long.label);
    assert.ok(title.nextElementSibling?.classList.contains("status"), "the badge follows the name on line 1");
    assert.equal(row.querySelector(".instance-row-actions")?.previousElementSibling?.className, "row-body", "the actions end the row");
    assert.equal(row.querySelector('[aria-haspopup="menu"]')?.getAttribute("aria-label"), `More Actions for ${long.label}`);
  } finally {
    await view.unmount();
  }
});
