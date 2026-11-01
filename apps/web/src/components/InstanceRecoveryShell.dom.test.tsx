import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import { InstancesContextProvider, type InstanceManager, type InstanceStatus } from "../instances-context.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { InstanceRecoveryShell, RECOVERY_RETRY_AFTER_MS, RECOVERY_SKELETON_DELAY_MS } from "./InstanceRecoveryShell.js";
import { resetInstanceRowFeedback } from "./InstancesPanel.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "https://tauri.localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
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
const studio: InstanceProfile = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverInstanceId: "11111111-1111-4111-8111-111111111111",
  kind: "remote",
  label: "Studio",
  origin: "https://studio.example:4317",
  createdAt: "2026-07-20T00:00:00Z",
  lastConnectedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
};
const LONG_NAME = "The Build Farm Workstation Under the Stairs in the Garage at the Back of the House";
const longStudio: InstanceProfile = { ...studio, label: LONG_NAME };

type Call = string;

function manager(overrides: Partial<InstanceManager>, calls: Call[] = []): InstanceManager {
  return {
    desktopMultiInstance: true,
    registry: { profiles: [local, studio], activeInstanceId: studio.id },
    activeProfile: studio,
    runtime: null,
    navigation: undefined,
    phase: "failed",
    error: null,
    statusByProfile: { local: { availability: "saved" } },
    async switchInstance(profileId) { calls.push(`switch:${profileId}`); },
    async retryActive(options) { calls.push(options?.restart ? "retry:restart" : "retry"); },
    async addInstance() {},
    async editInstance() {},
    async repairInstance() {},
    async removeInstance() {},
    manageInstances() {},
    openInstanceDialog(options) { calls.push(`dialog:${options.mode}:${"profileId" in options ? options.profileId : ""}`); },
    currentConnection: () => 1,
    async goToThisMachine() { calls.push("go-to-this-machine"); },
    reportActiveStatus() {},
    ...overrides,
  };
}

/** A failed remote whose recorded status is `status`. */
const failed = (status: InstanceStatus, error = status.message ?? null, profile = studio) => ({
  phase: "failed" as const,
  activeProfile: profile,
  registry: { profiles: [local, profile], activeInstanceId: profile.id },
  error,
  statusByProfile: { local: { availability: "saved" as const }, [profile.id]: status },
});

function mount(initial: InstanceManager) {
  resetInstanceRowFeedback();
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  const element = (value: InstanceManager) => (
    <FeedbackContext.Provider value={{
      confirm: async () => false,
      showToast: () => 1,
      showUndo: () => -1,
      dismissToast: () => undefined,
    }}>
      <InstancesContextProvider value={value}><InstanceRecoveryShell /></InstancesContextProvider>
    </FeedbackContext.Provider>
  );
  const container = host as unknown as HTMLElement;
  const panel = () => container.querySelector<HTMLElement>(".instance-recovery-state")!;
  return {
    container,
    panel,
    render: (value: InstanceManager = initial) => act(async () => { root.render(element(value)); }),
    /** The panel's actions in order, with Show Details left out. */
    actions: () => Array.from(panel().querySelectorAll<HTMLButtonElement>(".actions > button"))
      .filter((button) => !/^(Show|Hide) Details$/.test(button.textContent ?? ""))
      .map((button) => ({ label: button.textContent, primary: button.classList.contains("primary") })),
    action: (label: string) => Array.from(panel().querySelectorAll<HTMLButtonElement>(".actions > button"))
      .find((button) => button.textContent === label)!,
    row: (profile: InstanceProfile) => container.querySelector<HTMLElement>(`.instance-row[data-instance-id="${profile.id}"]`)!,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

const delay = (ms: number) => new Promise<void>((resolve) => domWindow.setTimeout(resolve, ms));

test("the screen is the shell's 64px rail, disabled, with the instance tile at its top, and no second frame", async () => {
  const view = mount(manager(failed({ availability: "offline", message: "Can't reach Studio." })));
  await view.render();
  try {
    const rail = view.container.querySelector(".app > nav.app-rail")!;
    assert.ok(rail, "the shell's rail");
    assert.equal(rail.classList.contains("labelled"), false);
    assert.ok(rail.querySelector(".rail-instance .instance-tile-trigger[aria-label='Switch Instance: Studio']"), "the tile at its top");
    const items = Array.from(rail.querySelectorAll<HTMLElement>(".rail-destinations > .rail-item, .rail-settings > .rail-item"));
    assert.ok(items.length > 1);
    for (const item of items) assert.equal(item.getAttribute("aria-disabled"), "true", item.getAttribute("aria-label") ?? "");
    assertNoDomNode(rail.querySelector('[aria-label="Search"]'), "no search item");
    assertNoDomNode(view.container.querySelector(".instance-recovery-nav, .instance-recovery-app, .topbar, .brand"));
    assert.ok(view.container.querySelector("main.main > .main-body > .page.instance-recovery-page"), "one page container");
  } finally {
    await view.unmount();
  }
});

const TABLE: Array<{
  state: string;
  manager: Partial<InstanceManager>;
  title: string;
  sentence: string | null;
  fact?: RegExp;
  actions: Array<{ label: string; primary: boolean }>;
}> = [
  {
    state: "Loading",
    manager: { phase: "loading", activeProfile: local, registry: { profiles: [local], activeInstanceId: "local" } },
    title: "Loading Instances",
    sentence: null,
    actions: [],
  },
  {
    state: "Connecting",
    manager: { phase: "opening", statusByProfile: { [studio.id]: { availability: "connecting" } } },
    title: "Connecting to Studio",
    sentence: "Opening a secure connection to studio.example:4317.",
    fact: /^Trying for 0s$/,
    actions: [{ label: "Go to This Machine", primary: false }],
  },
  {
    state: "Offline",
    manager: failed({ availability: "offline", message: "Can't reach Studio: timed out." }),
    title: "Can't Reach Studio",
    sentence: "It didn't answer at studio.example:4317. It may be asleep, or Wollipog isn't running there.",
    fact: /^Last connected 5h ago$/,
    actions: [{ label: "Retry", primary: true }, { label: "Go to This Machine", primary: false }],
  },
  {
    state: "Offline, refused",
    manager: failed({ availability: "offline", message: "Connection refused." }),
    title: "Can't Reach Studio",
    sentence: "It refused the connection at studio.example:4317. Wollipog may not be running there.",
    fact: /^Last connected 5h ago$/,
    actions: [{ label: "Retry", primary: true }, { label: "Go to This Machine", primary: false }],
  },
  {
    state: "Pairing Required",
    manager: failed({ availability: "authentication-required", message: "The pairing token was rejected." }),
    title: "Studio Needs a New Pairing",
    sentence: "It no longer accepts this app's saved credential. Create a pairing link on Studio and paste it here to reconnect.",
    actions: [{ label: "Re-Pair…", primary: true }, { label: "Go to This Machine", primary: false }],
  },
  {
    state: "Pairing Required, nothing saved",
    manager: failed({ availability: "missing-credential" }),
    title: "Studio Needs a New Pairing",
    sentence: "This app has no saved pairing for it. Create a pairing link on Studio and paste it here to connect.",
    actions: [{ label: "Re-Pair…", primary: true }, { label: "Go to This Machine", primary: false }],
  },
  {
    state: "Update Required, with a long name",
    manager: failed({ availability: "incompatible", message: "Unsupported API version 3." }, undefined, longStudio),
    title: `${LONG_NAME} Needs an Update`,
    sentence: "It runs an older Wollipog that this app can't use. Update Wollipog on that computer, then retry.",
    actions: [{ label: "Go to This Machine", primary: true }, { label: "Retry", primary: false }],
  },
  {
    state: "Not Found",
    manager: { phase: "missing", activeProfile: local, registry: { profiles: [local, studio], activeInstanceId: "local" } },
    title: "Instance Not Found",
    sentence: "This link points to an instance that isn't saved in this app anymore. Choose one below, or go back to this computer.",
    actions: [{ label: "Go to This Machine", primary: true }],
  },
  {
    state: "This Machine unavailable",
    manager: {
      phase: "failed",
      activeProfile: local,
      registry: { profiles: [local, studio], activeInstanceId: "local" },
      error: "connect ECONNREFUSED 127.0.0.1:4317",
    },
    title: "Can't Reach Wollipog on This Machine",
    sentence: "Wollipog on this computer didn't answer. It may still be starting.",
    actions: [{ label: "Retry", primary: true }],
  },
];

test("each state renders its title as the page's only h1, its sentence and its actions in order", async () => {
  for (const row of TABLE) {
    const view = mount(manager(row.manager));
    await view.render();
    try {
      const headings = view.container.querySelectorAll("h1");
      assert.equal(headings.length, 1, `${row.state}: one h1`);
      const title = headings[0]!;
      assert.equal(title.textContent, row.title, row.state);
      assert.equal(title.id, "page-title", `${row.state}: the page's title`);
      assert.equal(title.getAttribute("tabindex"), "-1", `${row.state}: focusable from script`);
      assert.ok(view.panel().contains(title), `${row.state}: the panel's title`);
      assert.equal(domWindow.document.title, `${row.title} – Wollipog`, `${row.state}: the window title`);
      const sentences = Array.from(view.panel().querySelectorAll(".state-body > p:not(.instance-recovery-fact)")).map((p) => p.textContent);
      assert.deepEqual(sentences, row.sentence ? [row.sentence] : [], `${row.state}: one sentence`);
      const fact = view.panel().querySelector(".instance-recovery-fact")?.textContent ?? null;
      if (row.fact) assert.match(fact ?? "", row.fact, `${row.state}: fact`);
      else assert.equal(fact, null, `${row.state}: no fact`);
      assert.deepEqual(view.actions(), row.actions, `${row.state}: actions`);
    } finally {
      await view.unmount();
    }
  }
});

test("the panel's tile takes the status word's tone, and Connecting's is a spinner in info, never success", async () => {
  const tones: Array<[Partial<InstanceManager>, string, string]> = [
    [{ phase: "opening", statusByProfile: { [studio.id]: { availability: "connecting" } } }, "t-info", ".spinner"],
    [failed({ availability: "offline" }), "t-neutral", "svg"],
    [failed({ availability: "authentication-required" }), "t-warning", "svg"],
    [failed({ availability: "incompatible" }), "t-warning", "svg"],
  ];
  for (const [overrides, tone, glyph] of tones) {
    const view = mount(manager(overrides));
    await view.render();
    try {
      assert.ok(view.panel().classList.contains(tone), `${view.panel().className} has ${tone}`);
      assert.equal(view.panel().classList.contains("t-success"), false);
      assert.ok(view.panel().querySelector(`.state-icon ${glyph}`), `${tone}: ${glyph} tile`);
    } finally {
      await view.unmount();
    }
  }
});

test("Pairing Required offers Re-Pair… and no Retry; each action calls the manager", async () => {
  const calls: Call[] = [];
  const view = mount(manager(failed({ availability: "authentication-required" }), calls));
  await view.render();
  try {
    assert.equal(view.action("Retry"), undefined);
    await act(async () => { view.action("Re-Pair…").click(); });
    await act(async () => { view.action("Go to This Machine").click(); });
    assert.deepEqual(calls, [`dialog:repair:${studio.id}`, "go-to-this-machine"]);
  } finally {
    await view.unmount();
  }
  calls.length = 0;
  const offline = mount(manager(failed({ availability: "offline" }), calls));
  await offline.render();
  try {
    await act(async () => { offline.action("Retry").click(); });
    assert.deepEqual(calls, ["retry"]);
  } finally {
    await offline.unmount();
  }
});

test("the failure is said once: the failing row shows its address and last connection, no action and no notice", async () => {
  const view = mount(manager(failed({ availability: "offline", message: "Can't reach Studio: timed out." })));
  await view.render();
  try {
    const text = view.container.textContent ?? "";
    assert.equal(text.split("It didn't answer").length - 1, 1, "the sentence appears once");
    assert.doesNotMatch(text, /Didn't answer\./, "the row does not repeat it");
    assert.doesNotMatch(text, /timed out/, "the raw error waits behind Show Details");
    const row = view.row(studio);
    assert.equal(row.querySelector(".status")?.textContent, "Offline");
    assert.equal(row.querySelector(".instance-row-address")?.textContent, studio.origin);
    assert.equal(row.querySelector(".instance-row-last")?.textContent, "Last connected 5h ago");
    assert.deepEqual(Array.from(row.querySelectorAll(".instance-row-actions button")).map((button) => button.getAttribute("aria-label")),
      ["More Actions for Studio"], "the slot is empty, only ⋯ stays");
    assertNoDomNode(view.container.querySelector(".instance-list > .notice"));
    assert.ok(view.row(local).querySelector("button")?.textContent?.includes("Switch"), "This Machine is a Switch away");

    const details = Array.from(view.panel().querySelectorAll("button")).find((button) => button.textContent === "Show Details")!;
    await act(async () => { details.click(); });
    assert.match(view.panel().querySelector(".state-details")?.textContent ?? "", /timed out/);
  } finally {
    await view.unmount();
  }
});

test("Not Found marks no row Current, and This Machine offers Switch", async () => {
  for (const activeProfile of [local, studio]) {
    const calls: Call[] = [];
    const view = mount(manager({
      phase: "missing",
      activeProfile,
      registry: { profiles: [local, studio], activeInstanceId: activeProfile.id },
      statusByProfile: { local: { availability: "online" } },
    }, calls));
    await view.render();
    try {
      assert.doesNotMatch(view.container.querySelector(".instance-list")!.textContent ?? "", /Current/, activeProfile.label);
      const switchButton = Array.from(view.row(local).querySelectorAll("button")).find((button) => button.textContent?.includes("Switch"));
      assert.ok(switchButton, `${activeProfile.label}: This Machine has Switch`);
      await act(async () => { switchButton.click(); });
      assert.deepEqual(calls, ["switch:local"]);
    } finally {
      await view.unmount();
    }
  }
});

test("Loading shows skeleton rows only after 300ms, and no actions", async () => {
  const view = mount(manager({ phase: "loading", activeProfile: local, registry: { profiles: [local], activeInstanceId: "local" } }));
  await view.render();
  try {
    assertNoDomNode(view.container.querySelector(".instance-skeleton-row"), "nothing new before 300ms");
    assertNoDomNode(view.container.querySelector(".instance-list"));
    await act(async () => { await delay(RECOVERY_SKELETON_DELAY_MS + 50); });
    assert.equal(view.container.querySelectorAll(".instance-skeleton-row").length, 3);
    assertNoDomNode(view.panel().querySelector(".actions"));
  } finally {
    await view.unmount();
  }
});

test("Connecting offers Go to This Machine at once and Retry after 20 seconds, counting from each connection's start", async () => {
  let now = 50_000;
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const dateNow = mock.method(Date, "now", () => now);
  try {
    await withScopedClockOverrides(domWindow, {
      setInterval: (run: () => void) => {
        const id = nextId++;
        intervals.set(id, run);
        return id;
      },
      clearInterval: (id: number) => { intervals.delete(id); },
    }, async () => {
      let connection = 1;
      const calls: Call[] = [];
      const connecting = manager({
        phase: "opening",
        statusByProfile: { [studio.id]: { availability: "connecting" } },
        currentConnection: () => connection,
      }, calls);
      const view = mount(connecting);
      const advance = async (seconds: number) => {
        for (let second = 0; second < seconds; second += 1) {
          now += 1000;
          await act(async () => { for (const run of intervals.values()) run(); });
        }
      };
      const fact = () => view.panel().querySelector(".instance-recovery-fact")?.textContent;
      await view.render();
      try {
        assert.equal(fact(), "Trying for 0s");
        assert.deepEqual(view.actions(), [{ label: "Go to This Machine", primary: false }]);
        await advance(5);
        assert.equal(fact(), "Trying for 5s", "the elapsed time updates");
        await advance(RECOVERY_RETRY_AFTER_MS / 1000 - 6);
        assert.equal(fact(), "Trying for 19s");
        assert.equal(view.action("Retry"), undefined, "no Retry before 20s");
        await advance(1);
        assert.equal(fact(), "Trying for 20s");
        assert.deepEqual(view.actions(), [{ label: "Go to This Machine", primary: false }, { label: "Retry", primary: false }]);
        // It gives up on the hung attempt, even one a retry started, rather than joining it.
        const retry = view.action("Retry");
        retry.focus();
        await act(async () => { retry.click(); });
        assert.deepEqual(calls, ["retry:restart"]);

        // The retry starts a new connection, and its time starts again. Retry leaves with the time,
        // and focus goes to the page's title rather than the document.
        connection = 2;
        await view.render({ ...connecting });
        assert.equal(fact(), "Trying for 0s");
        assert.equal(view.action("Retry"), undefined);
        assert.equal(domWindow.document.activeElement?.id, "page-title");
      } finally {
        await view.unmount();
      }
      assert.equal(intervals.size, 0, "the timer stops with the screen");
    });
  } finally {
    dateNow.mock.restore();
  }
});

test("This Machine connecting has nowhere to go back to: no Go to This Machine", async () => {
  const view = mount(manager({
    phase: "opening",
    activeProfile: local,
    registry: { profiles: [local, studio], activeInstanceId: "local" },
    statusByProfile: { local: { availability: "connecting" } },
  }));
  await view.render();
  try {
    assert.equal(view.container.querySelector("h1")?.textContent, "Connecting to This Machine");
    assert.deepEqual(view.actions(), []);
  } finally {
    await view.unmount();
  }
});

test("a state change that removes the focused control moves focus to the page title", async () => {
  const offline = manager(failed({ availability: "offline" }));
  const view = mount(offline);
  await view.render();
  try {
    view.action("Retry").focus();
    await view.render(manager({ phase: "opening", statusByProfile: { [studio.id]: { availability: "connecting" } } }));
    assert.equal(domWindow.document.activeElement?.id, "page-title");
  } finally {
    await view.unmount();
  }
});
