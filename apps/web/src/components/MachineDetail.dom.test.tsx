import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type BoxView, type IdentityAdministrationView, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { connectionFacts, connectionFactsText, legacyDataState, machineMetaFacts, machineNoticeKind } from "./MachineDetail.js";
import { RunnersView } from "./RunnersView.js";

/**
 * One detail for every machine (#2988): the title row, ⋯ Machine Actions, the phone's detail bar
 * sheet, the one lifecycle notice and Connection Details, through the real Machines tab.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function runner(runnerId: string, overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId,
    hostname: `${runnerId}.local`,
    os: "linux",
    version: "0.42.0",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: Date.now() - 4 * 60_000,
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

const studio = runner("studio", { displayName: "Studio Mac", os: "macos", hostname: "studio.local" });
const buildRunner = runner("build-runner", { displayName: "Build Box", hostname: "build" });
const buildBox: BoxView = {
  boxId: "box-build", runnerId: "build-runner", displayName: "Build Box", sshTarget: "me@build",
  status: "online", lastError: null, createdAt: 1, deployedVersion: "0.42.0+abc", triple: "x86_64-unknown-linux-gnu",
};

function snapshot(runners: RunnerView[], boxes: BoxView[] = []): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners, boxes, projects: [], sessions: [], runs: [], pods: [],
  };
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation = (view: View): ViewNavigation => ({ current: () => view, push() {}, replace() {}, listen: () => () => {} });
const settle = () => act(async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); });
let sequence = 0;

async function mount({ runners, boxes = [], machineId, role = "owner", client: overrides = {} }: {
  runners: RunnerView[];
  boxes?: BoxView[];
  machineId: string;
  role?: "owner" | "viewer";
  client?: Partial<ApiClient>;
}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `machine-detail-${sequence}`,
    runtimeKey: `machine-detail-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const identity = { context: { role }, organizations: [], memberships: [], teams: [] } as unknown as IdentityAdministrationView;
  const client = {
    ...api,
    getIdentity: async () => identity,
    listSkills: async () => ({ skills: [] }),
    runnerSkills: async () => ({ removalReporting: "supported", desired: [], reported: { unmanaged: [], removals: [] } }),
    ...overrides,
  } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={navigation({ name: "runners", section: "machines", machineId })}>
              <RunnersView />
            </StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(runners, boxes)); });
  await settle();
  const body = domWindow.document.body as unknown as HTMLElement;
  return {
    body,
    detail: () => body.querySelector<HTMLElement>("article.machine-detail")!,
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

async function setWidth(width: number) {
  await act(async () => domWindow.happyDOM.setWindowSize({ width, height: 900 }));
  await settle();
}

afterEach(async () => { await setWidth(1440); });

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;

async function openMenu(body: HTMLElement) {
  await act(async () => body.querySelector<HTMLButtonElement>('button[aria-label="Machine Actions"]')!.click());
  const menu = body.querySelector<HTMLElement>('[role="menu"][aria-label="Machine Actions"]')!;
  assert.ok(menu, "⋯ Machine Actions opens");
  return menu;
}
const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const itemLabels = (menu: HTMLElement) => menuItems(menu).map((item) => item.querySelector(".menu-text")?.textContent);
const dialogNamed = (body: HTMLElement, title: string) => [...body.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
  .find((dialog) => dialog.querySelector("h2, h3, .modal-title")?.textContent?.trim() === title);

/** Every class the machine card used, which the one detail replaces (#2988 item 9). */
const RETIRED_CLASSES = [
  "runner-card", "runner-head", "runner-head-right", "runner-card-actions", "runner-meta", "os-badge", "btn-rediscover",
  "box-card", "connection-details-trigger", "runner-update-result", "box-error", "status-dot", "runner-agent-sessions",
];

test("a native and an SSH machine share one title row: name, one badge, Settings… and ⋯, then one meta line", async () => {
  for (const [machine, kind] of [[studio, "native"], [buildRunner, "ssh"]] as const) {
    const view = await mount({ runners: [studio, buildRunner], boxes: [buildBox], machineId: machine.runnerId });
    try {
      const detail = view.detail();
      assert.equal(detail.dataset.kind, kind);
      const row = detail.querySelector(".machine-detail-title-row")!;
      assert.deepEqual([...row.children].map((child) => child.tagName === "H2" ? "title" : child.classList.contains("status") ? "badge" : child.className),
        ["title", "badge", "actions"], kind);
      assert.equal(row.querySelector("h2")?.textContent, machine.displayName);
      assert.equal(row.querySelector("h2")?.getAttribute("title"), machine.displayName, "its tooltip is the whole name");
      assert.equal(detail.querySelectorAll(".status").length, 1, `${kind}: one badge`);
      assert.deepEqual([...row.querySelectorAll(".actions > button, .actions .overflow-menu > button")].map((button) => button.textContent?.trim() || button.getAttribute("aria-label")),
        ["Settings…", "Machine Actions"]);
      for (const retired of RETIRED_CLASSES) assertNoDomNode(view.body.querySelector(`.${retired}`), `${kind} has no .${retired}`);
      assert.equal(detail.querySelectorAll(".machine-detail-meta").length, 1);
    } finally {
      await view.unmount();
    }
  }
});

test("the meta line names the kind, the host and the OS in its own casing, and when offline when it was last seen", async () => {
  const facts = (r: RunnerView, b?: BoxView) => machineMetaFacts(r, b).map((fact) => fact.text);
  assert.deepEqual(facts(studio), ["Native Runner", "studio.local", "macOS"]);
  assert.deepEqual(facts(runner("w", { os: "windows", hostname: "w" })), ["Native Runner", "w", "Windows"]);
  assert.deepEqual(facts(runner("l", { hostname: "l" })), ["Native Runner", "l", "Linux"]);
  assert.deepEqual(facts(buildRunner, buildBox), ["SSH", "me@build", "Linux"]);
  assert.deepEqual(facts(runner("o", { hostname: "o", status: "offline" })), ["Native Runner", "o", "Linux", "Last seen 4m ago"]);

  const view = await mount({ runners: [studio], machineId: "studio" });
  try {
    const meta = view.detail().querySelector(".machine-detail-meta")!;
    assert.deepEqual([...meta.querySelectorAll("li")].map((item) => item.textContent), ["Native Runner", "studio.local", "macOS"]);
    assert.ok(meta.querySelector("li svg"), "the kind leads with its icon");
  } finally {
    await view.unmount();
  }
});

test("⋯ holds the actions in order; an online native runner's Delete Machine… says to stop it first", async () => {
  const view = await mount({ runners: [studio], machineId: "studio" });
  try {
    const menu = await openMenu(view.body);
    assert.deepEqual(itemLabels(menu), ["Rediscover Agents", "Find Agent Sessions…", "Connection Details…", "Delete Machine…"]);
    assert.ok(menu.querySelector(".menu-sep"), "Delete Machine… follows a separator");
    const remove = menuItems(menu).at(-1)!;
    assert.equal(remove.disabled, true);
    assert.ok(remove.classList.contains("danger"));
    assert.equal(remove.querySelector(".menu-desc")?.textContent, "Stop the runner to delete.");
  } finally {
    await view.unmount();
  }
});

test("an offline native runner leads ⋯ with Repair Connection…; an SSH machine with Reconnect; a viewer sees Connection Details… only", async () => {
  const offline = runner("studio", { displayName: "Studio Mac", status: "offline" });
  const native = await mount({ runners: [offline], machineId: "studio" });
  try {
    const menu = await openMenu(native.body);
    assert.deepEqual(itemLabels(menu), ["Repair Connection…", "Connection Details…", "Delete Machine…"]);
    assert.equal(menuItems(menu).at(-1)!.disabled, false, "a stopped runner can be deleted");
  } finally {
    await native.unmount();
  }
  const ssh = await mount({ runners: [buildRunner], boxes: [buildBox], machineId: "build-runner" });
  try {
    assert.deepEqual(itemLabels(await openMenu(ssh.body)), ["Reconnect", "Find Agent Sessions…", "Connection Details…", "Delete Machine…"]);
  } finally {
    await ssh.unmount();
  }
  const viewer = await mount({ runners: [studio], machineId: "studio", role: "viewer" });
  try {
    assertNoDomNode(buttonNamed(viewer.detail(), "Settings…"), "a viewer has no Settings…");
    assert.deepEqual(itemLabels(await openMenu(viewer.body)), ["Connection Details…"]);
  } finally {
    await viewer.unmount();
  }
});

test("at 390px the detail bar's ⋯ starts with Settings…, the body has no Settings…, and Delete Machine… replaces the sheet with Back", async () => {
  await setWidth(390);
  const offline = runner("studio", { displayName: "Studio Mac", status: "offline" });
  const view = await mount({ runners: [offline], machineId: "studio" });
  try {
    const bar = view.body.querySelector(".detail-bar")!;
    assert.ok(bar.querySelector('button[aria-label="Machine Actions"]'), "the app bar carries ⋯");
    const detail = view.detail();
    assertNoDomNode(detail.querySelector("h2"), "the bar carries the name");
    assertNoDomNode(buttonNamed(detail, "Settings…"));
    assertNoDomNode(detail.querySelector('button[aria-label="Machine Actions"]'));
    assert.equal(detail.querySelectorAll(".machine-detail-title-row .status").length, 1, "the body keeps the badge");
    assert.ok(detail.querySelector(".machine-detail-meta"), "and the meta line");

    const menu = await openMenu(view.body);
    assert.deepEqual(itemLabels(menu), ["Settings…", "Repair Connection…", "Connection Details…", "Delete Machine…"]);
    await act(async () => menuItems(menu).at(-1)!.click());
    await settle();
    const confirmation = dialogNamed(view.body, "Delete Machine")!;
    assert.ok(confirmation, "the confirmation opens");
    assert.match(confirmation.textContent ?? "", /Studio Mac, its sessions and its multi-agent runs are deleted from Wollipog\. Files on the machine stay where they are\./);
    const back = confirmation.querySelector<HTMLButtonElement>('button[aria-label="Back to More Actions"]')!;
    assert.ok(back, "the confirmation has Back to More Actions");
    assertNoDomNode(view.body.querySelector('[role="menu"][aria-label="Machine Actions"]'), "it replaced the sheet");
    await act(async () => back.click());
    await settle();
    assert.ok(view.body.querySelector('[role="menu"][aria-label="Machine Actions"]'), "Back brings the sheet back");
  } finally {
    await view.unmount();
  }
});

test("only one lifecycle notice shows: offline outranks a failed connection's update and legacy data", async () => {
  const outdated = { ...buildRunner, protocolVersion: PROTOCOL_VERSION - 1 };
  const legacy: BoxView = { ...buildBox, status: "offline", runnerDataLayout: "legacy", legacyDataAccountStatus: "unclaimed" };
  assert.equal(machineNoticeKind(outdated, legacy), "offline");
  assert.equal(machineNoticeKind(outdated, { ...legacy, status: "online" }), "update_required");
  assert.equal(machineNoticeKind(buildRunner, { ...legacy, status: "online" }), "legacy_data");
  assert.equal(machineNoticeKind(undefined, { ...buildBox, status: "bootstrapping" }), "connecting");
  assert.equal(machineNoticeKind(buildRunner, { ...buildBox, status: "failed", lastError: "x" }), "connection_failed");
  assert.equal(machineNoticeKind(buildRunner, { ...buildBox, status: "offline", lastError: "x" }), "connection_failed");
  assert.equal(machineNoticeKind(studio, undefined), null);
  assert.equal(machineNoticeKind({ ...studio, status: "offline" }, undefined), "offline");
  assert.equal(machineNoticeKind({ ...studio, protocolVersion: PROTOCOL_VERSION - 1 }, undefined), "update_required");

  const view = await mount({ runners: [{ ...outdated, status: "offline" }], boxes: [legacy], machineId: "build-runner" });
  try {
    const notices = view.detail().querySelectorAll(".notice");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.textContent ?? "", /This Machine Is Offline/);
    assert.ok(buttonNamed(notices[0]!, "Reconnect"), "an SSH session that ended offers Reconnect");
    assert.doesNotMatch(view.detail().textContent ?? "", /Runner Update Required|Older Runner Data Found/);
  } finally {
    await view.unmount();
  }
});

test("a machine whose runner can't start on older data keeps Adopt Legacy Data… in its connection notice", async () => {
  assert.equal(legacyDataState({ ...buildBox, runnerDataLayout: "legacy", legacyDataAccountStatus: "unclaimed" }), "adoptable");
  assert.equal(legacyDataState({ ...buildBox, runnerDataLayout: "legacy", legacyDataAccountStatus: "pending" }), "elsewhere");
  assert.equal(legacyDataState({ ...buildBox, runnerDataLayout: "legacy", legacyDataAccountStatus: "pending",
    legacyDataAdoption: { status: "pending" } as BoxView["legacyDataAdoption"] }), "pending");
  assert.equal(legacyDataState({ ...buildBox, runnerDataLayout: "legacy", legacyDataAccountStatus: "adopted" }), "adopted");
  assert.equal(legacyDataState({ ...buildBox, runnerDataLayout: "isolated-v1" }), null);

  // The runner refuses to start without --adopt-legacy-data-dir, so ssh exits with its error.
  const refused: BoxView = { ...buildBox, status: "offline", lastError: "runner data directory needs adoption",
    runnerDataLayout: "legacy", legacyDataAccountStatus: "unclaimed" };
  const adoptions: boolean[] = [];
  const view = await mount({
    runners: [{ ...buildRunner, status: "offline" }],
    boxes: [refused],
    machineId: "build-runner",
    client: { adoptLegacyBoxData: async (_boxId: string, force = false) => { adoptions.push(force); return { ok: true, status: "started" }; } } as Partial<ApiClient>,
  });
  try {
    const notices = view.detail().querySelectorAll(".notice");
    assert.equal(notices.length, 1, "still one notice");
    assert.match(notices[0]!.textContent ?? "", /Couldn't Connect to Build Box/);
    assert.match(notices[0]!.textContent ?? "", /It has older runner data, which its runner needs adopted before it can start\./);
    await act(async () => buttonNamed(notices[0]!, "Adopt Legacy Data…")!.click());
    await settle();
    const confirmation = dialogNamed(view.body, "Adopt Legacy Data")!;
    assert.ok(confirmation, "the adoption asks first");
    await act(async () => buttonNamed(confirmation, "Adopt Legacy Data")!.click());
    await settle();
    assert.deepEqual(adoptions, [false]);
  } finally {
    await view.unmount();
  }

  // An SSH session that simply ended offers it beside Reconnect; a viewer reads why, with no button.
  for (const role of ["owner", "viewer"] as const) {
    const ended = await mount({
      runners: [{ ...buildRunner, status: "offline" }],
      boxes: [{ ...refused, lastError: null }],
      machineId: "build-runner",
      role,
    });
    try {
      const notice = ended.detail().querySelector(".notice")!;
      assert.match(notice.textContent ?? "", /This Machine Is Offline/);
      assert.match(notice.textContent ?? "", /older runner data/);
      assert.equal(Boolean(buttonNamed(notice, "Adopt Legacy Data…")), role === "owner", role);
    } finally {
      await ended.unmount();
    }
  }
});

test("once Delete Machine is confirmed it can't be cancelled, since the deletion can't be withdrawn", async () => {
  let finish!: () => void;
  const deleting = new Promise<void>((resolve) => { finish = resolve; });
  const offline = runner("studio", { displayName: "Studio Mac", status: "offline" });
  const view = await mount({ runners: [offline], machineId: "studio", client: { removeRunner: () => deleting } as Partial<ApiClient> });
  try {
    const menu = await openMenu(view.body);
    await act(async () => menuItems(menu).at(-1)!.click());
    await settle();
    const confirmation = dialogNamed(view.body, "Delete Machine")!;
    await act(async () => buttonNamed(confirmation, "Delete Machine")!.click());
    await settle();
    const cancel = buttonNamed(confirmation, "Cancel")!;
    assert.ok(cancel.disabled || cancel.getAttribute("aria-disabled") === "true", "Cancel is locked while the deletion runs");
    await act(async () => {
      confirmation.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
    });
    await settle();
    assert.ok(dialogNamed(view.body, "Delete Machine"), "Escape does not dismiss it either");
    await act(async () => { finish(); await deleting; });
    await settle();
  } finally {
    await view.unmount();
  }
});

test("an offline native runner's notice is neutral with Repair and Connection Details; a viewer is told whom to ask", async () => {
  const offline = runner("studio", { displayName: "Studio Mac", status: "offline" });
  const owner = await mount({ runners: [offline], machineId: "studio" });
  try {
    const notice = owner.detail().querySelector(".notice")!;
    assert.ok(notice.classList.contains("neutral") || /neutral/.test(notice.className), notice.className);
    assert.match(notice.textContent ?? "", /Wollipog can't reach its runner\. The runner may have stopped, or its credential may no longer work\./);
    assert.deepEqual([...notice.querySelectorAll(".notice-actions button, .actions button")].map((button) => button.textContent?.trim())
      .filter((label) => label !== "Show Details"), ["Repair Connection…", "Connection Details…"]);
  } finally {
    await owner.unmount();
  }
  const viewer = await mount({ runners: [offline], machineId: "studio", role: "viewer" });
  try {
    const notice = viewer.detail().querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /Ask an organization owner or admin to repair this connection\./);
    assertNoDomNode(buttonNamed(notice, "Repair Connection…"));
  } finally {
    await viewer.unmount();
  }
});

test("an SSH connection refused for its key says so, with ssh's words behind Show Details", async () => {
  const raw = "me@build: Permission denied (publickey).";
  const view = await mount({ runners: [buildRunner], boxes: [{ ...buildBox, status: "failed", lastError: raw }], machineId: "build-runner" });
  try {
    const notice = view.detail().querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /Couldn't Connect to Build Box/);
    assert.match(notice.textContent ?? "", /The host refused your SSH key\. Load the key with ssh-add, then try again\./);
    assert.doesNotMatch(notice.textContent ?? "", /publickey/, "the raw text waits behind Show Details");
    assert.ok(buttonNamed(notice, "Try Again"));
    await act(async () => buttonNamed(notice, "Show Details")!.click());
    assert.match(notice.textContent ?? "", /Permission denied \(publickey\)\./);
  } finally {
    await view.unmount();
  }
});

test("Update Runner… on a busy machine asks to interrupt the sessions it names, then updates", async () => {
  const calls: boolean[] = [];
  const view = await mount({
    runners: [{ ...buildRunner, protocolVersion: PROTOCOL_VERSION - 1 }],
    boxes: [buildBox],
    machineId: "build-runner",
    client: {
      updateBoxRunner: async (_boxId: string, force = false) => {
        calls.push(force);
        if (!force) {
          throw new ApiError("active sessions", 409, "BOX_HAS_ACTIVE_SESSIONS", {
            activeSessionCount: 2,
            activeSessions: [{ title: "Fix the half-cent rounding bug", status: "running" }, { title: "Draft the notes", status: "idle" }],
          });
        }
        return { status: "started", expectedVersion: "0.43.0", source: "release-cache", releaseTag: "v0.43.0" };
      },
    } as Partial<ApiClient>,
  });
  try {
    const notice = view.detail().querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /Runner Update Required/);
    assert.match(notice.textContent ?? "", /This machine's runner is out of date\./);
    await act(async () => buttonNamed(notice, "Update Runner…")!.click());
    await settle();
    const confirmation = dialogNamed(view.body, "Interrupt Sessions and Update")!;
    assert.ok(confirmation, "the interruption asks first");
    assert.match(confirmation.textContent ?? "", /Updating this runner will interrupt 2 active sessions\./);
    assert.match(confirmation.textContent ?? "", /Fix the half-cent rounding bug/);
    assert.match(confirmation.textContent ?? "", /Draft the notes/);
    await act(async () => buttonNamed(confirmation, "Interrupt Sessions and Update")!.click());
    await settle();
    assert.deepEqual(calls, [false, true]);
    assert.match(view.body.textContent ?? "", /Deploying the update\. The status changes when the runner is back online\./, "the result is a toast");
  } finally {
    await view.unmount();
  }
});

test("Connection Details lists every fact, Not available where one is missing, and Copy All copies all of them", async () => {
  const facts = connectionFacts(buildRunner, buildBox, "build-runner");
  assert.deepEqual(facts.map((fact) => fact.label), [
    "Connection", "SSH Target", "Host", "Operating System", "Runner Version", "Last Seen", "Worktree Storage", "Sandboxing",
    "Deployed Build", "Platform",
  ]);
  assert.deepEqual(connectionFacts(studio, undefined, "studio").map((fact) => fact.label), [
    "Connection", "Machine ID", "Host", "Operating System", "Runner Version", "Last Seen", "Worktree Storage", "Sandboxing",
  ]);
  const text = connectionFactsText("Build Box", facts, PROTOCOL_VERSION);
  for (const fact of facts) assert.match(text, new RegExp(`^${fact.label}: `, "m"), `Copy All includes ${fact.label}`);
  assert.match(text, /^Runner Version: 0\.42\.0 \(Protocol v\d+\)$/m);
  assert.match(text, /^Worktree Storage: Not available$/m);

  for (const [machine, boxes, description] of [[studio, [], "Studio Mac"], [buildRunner, [buildBox], "Build Box"]] as const) {
    const view = await mount({ runners: [machine], boxes: [...boxes], machineId: machine.runnerId, role: "viewer" });
    try {
      const menu = await openMenu(view.body);
      await act(async () => menuItems(menu).find((item) => item.textContent?.includes("Connection Details…"))!.click());
      await settle();
      const dialog = dialogNamed(view.body, "Connection Details")!;
      assert.ok(dialog, `${description}: Connection Details opens`);
      assert.match(dialog.textContent ?? "", new RegExp(description));
      const terms = [...dialog.querySelectorAll(".facts dt")].map((term) => term.textContent);
      assert.ok(terms.includes("Runner Version") && terms.includes("Sandboxing"), terms.join(", "));
      const missing = [...dialog.querySelectorAll(".facts dd")].find((value) => value.previousElementSibling?.textContent === "Worktree Storage")!;
      assert.equal(missing.textContent, "Not available");
      assertNoDomNode(missing.querySelector("code"), "a missing value is never a code chip");
      assert.ok(buttonNamed(dialog, "Copy All"), "Copy All");
      assert.ok(buttonNamed(dialog, "Done"), "Done");
      assert.equal(/Wollipog reconnects automatically/.test(dialog.textContent ?? ""), boxes.length > 0,
        "the SSH reconnect sentence is for SSH machines");
    } finally {
      await view.unmount();
    }
  }
});
