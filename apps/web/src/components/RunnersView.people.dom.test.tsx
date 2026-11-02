import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
  OrganizationRole,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { RunnersView } from "./RunnersView.js";

/**
 * Connections › People and Devices (#2997): three sections of two-line rows, each keeping its own
 * permissions, loading and errors, mounted through the production Connections view. Dialogs are
 * portalled, so the tests read the document body.
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

const ORG = { organizationId: "org-1", organizationName: "Fixture Organization" };

function member(userId: string, userName: string, role: OrganizationRole, userStatus: "active" | "suspended" = "active"): OrganizationMembershipView {
  return { ...ORG, userId, userName, role, userStatus, createdAt: 1 };
}

const people = [
  member("me", "Misko", "owner"),
  member("owner-2", "Grace Hopper", "owner"),
  member("pat", "pat@example.org", "operator"),
  member("sam", "Sam Lee", "viewer", "suspended"),
];

function directory(
  role: OrganizationRole,
  { localBootstrap = true, memberships = people, teams = true }: {
    localBootstrap?: boolean;
    memberships?: OrganizationMembershipView[];
    teams?: boolean;
  } = {},
): IdentityAdministrationView {
  return {
    context: { userId: "me", userName: "Misko", ...ORG, role, deviceId: null, localBootstrap },
    organizations: [{ organizationId: ORG.organizationId, name: ORG.organizationName, createdAt: 1 }],
    memberships,
    teams: teams ? [
      { teamId: "team-1", organizationId: ORG.organizationId, name: "Support", memberUserIds: ["pat", "me"], createdAt: 2 },
      { teamId: "team-2", organizationId: ORG.organizationId, name: "Empty Team", memberUserIds: [], createdAt: 3 },
    ] : [],
  };
}

const NOW = Date.now();
const devices: DeviceView[] = [{
  ...ORG,
  deviceId: "device-1",
  name: "Pat's Phone",
  createdAt: NOW - 5 * 60_000,
  lastSeenAt: NOW - 2 * 3_600_000,
  userId: "pat",
  userName: "pat@example.org",
  role: "operator",
}, {
  ...ORG,
  deviceId: "device-2",
  name: "Home Laptop",
  createdAt: NOW - 3 * 86_400_000,
  lastSeenAt: null,
  userId: "me",
  userName: "Misko",
  role: "owner",
}];

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true, createProjectLocations: true },
    runners: [],
    boxes: [],
    projects: [],
    sessions: [],
    runs: [],
    pods: [],
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

let sequence = 0;
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); });

interface Calls { identity: number; devices: number; revoked: string[] }

async function mount(client: Partial<ApiClient> & { role?: OrganizationRole; localBootstrap?: boolean } = {}) {
  const { role = "owner", localBootstrap = true, ...overrides } = client;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const body = domWindow.document.body as unknown as HTMLElement;
  const root = createRoot(mountPoint);
  const sockets: FakeSocket[] = [];
  const view: View = { name: "runners", section: "people" };
  const navigation: ViewNavigation = { current: () => view, push() {}, replace() {}, listen: () => () => {} };
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `runners-people-${sequence}`,
    runtimeKey: `runners-people-${sequence}:1`,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    close() {},
  };
  const calls: Calls = { identity: 0, devices: 0, revoked: [] };
  const apiClient = {
    ...api,
    sshConfigHosts: async () => ({ hosts: [] }),
    listSkills: async () => ({ skills: [] }),
    getIdentity: async () => {
      calls.identity += 1;
      return directory(role, { localBootstrap });
    },
    listDevices: async () => {
      calls.devices += 1;
      return { devices: structuredClone(devices) };
    },
    revokeDevice: async (deviceId: string) => {
      calls.revoked.push(deviceId);
    },
    ...overrides,
  } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={apiClient}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={navigation}><RunnersView /></StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    sockets[0]?.onopen?.();
    sockets[0]?.push(snapshot());
  });
  await settle();
  return {
    body,
    calls,
    sockets,
    panel: () => body.querySelector("#connections-people-panel")!,
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

const section = (body: HTMLElement, name: string) => body.querySelector(`#${name}-heading`)!.closest("section")!;
const rows = (scope: Element, kind: "person" | "device" | "team") => [...scope.querySelectorAll(`.access-row[data-row="${kind}"]`)];
const rowNamed = (scope: Element, kind: "person" | "device" | "team", name: string) =>
  rows(scope, kind).find((row) => row.querySelector(".row-title")?.textContent?.includes(name));
const buttons = (scope: Element) => [...scope.querySelectorAll<HTMLButtonElement>("button")];
const buttonNamed = (scope: Element, text: string) => buttons(scope).find((button) => button.textContent === text);
const dialog = () => document.body.querySelector('[role="dialog"]:not(.feedback-confirmation)')!;
const confirmation = () => document.body.querySelector(".feedback-confirmation")!;
async function click(target: Element | undefined) {
  assert.ok(target, "the control exists");
  await act(async () => (target as HTMLElement).click());
  await settle();
}

test("the tab is three titled sections under the tab row, with no intro heading or identity chip", async () => {
  const view = await mount();
  try {
    const panel = view.panel();
    assertNoDomNode(panel.querySelector(".access-page-intro, .access-context, .access-page"));
    assertNoDomNode(panel.querySelector("h2")?.closest(".page-header") ?? null, "the panel adds no heading to the page header");
    assert.deepEqual([...panel.querySelectorAll("h2.section-title")].map((title) => title.textContent),
      ["People 4", "Paired Devices 2", "Teams 2"]);
    assert.equal(panel.querySelectorAll(".section-title svg").length, 0, "section titles have no icons");
    // One small action each, ending in an ellipsis because it opens a form.
    assert.deepEqual([...panel.querySelectorAll(".section-head > .btn.sm")].map((button) => button.textContent),
      ["Add Person…", "Pair Device…", "Create Team…"]);
    assert.deepEqual([...panel.querySelectorAll(".section-note")].map((note) => note.textContent), [
      "Phones and other computers that can open Wollipog away from this computer.",
      "Teams share machines, workspaces and sessions among their members.",
    ]);
    assert.doesNotMatch(panel.textContent ?? "", /Advanced|Most personal fleets/);
    // Every row is a two-line row; no button is nested in another, and none is disabled.
    for (const row of panel.querySelectorAll(".access-row")) assert.ok(row.classList.contains("row-2"));
    assert.equal(panel.querySelectorAll("button button").length, 0);
    assert.equal(panel.querySelectorAll("button:disabled, [aria-disabled=\"true\"]").length, 0);
  } finally {
    await view.unmount();
  }
});

test("person rows mark your own row You, show status only as an exception, and name roles in Title Case", async () => {
  const view = await mount();
  try {
    const list = section(view.body, "people");
    const me = rowNamed(list, "person", "Misko")!;
    assert.match(me.textContent ?? "", /You/);
    assert.equal(buttonNamed(me, "Manage…"), undefined, "your own row has no Manage…");
    assert.ok(buttonNamed(me, "Edit Name…"), "but an owner edits their own name from it (#3001)");
    assert.doesNotMatch(me.textContent ?? "", /Default name/, "a chosen name is not called the default");
    // No person shows Active; the suspended one shows one neutral hollow-dot badge.
    assert.doesNotMatch(list.textContent ?? "", /Active/);
    const sam = rowNamed(list, "person", "Sam Lee")!;
    const badges = [...sam.querySelectorAll(".status")];
    assert.equal(badges.length, 1);
    assert.equal(badges[0]!.textContent, "Suspended");
    assert.ok(badges[0]!.classList.contains("t-neutral") && badges[0]!.classList.contains("hollow"));
    // Line 2: the role from titleCaseLabel, the device count from the loaded devices, team names.
    const pat = rows(list, "person").find((row) => row.querySelector(".access-row-meta")?.textContent?.includes("Operator"))!;
    assert.deepEqual([...pat.querySelectorAll(".access-row-meta > .access-meta")].map((item) => item.textContent),
      ["Operator", "1 device", "Support"]);
    assert.match(me.querySelector(".access-row-meta")?.textContent ?? "", /Owner1 deviceSupport/);
    assert.match(sam.querySelector(".access-row-meta")?.textContent ?? "", /^ViewerNo devices$/);
    // The row's open target and its Manage… both open Manage Person.
    await click(pat.querySelector(".access-row-open")!);
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Manage Person");
    await click(buttonNamed(dialog(), "Cancel"));
    await click(buttonNamed(pat, "Manage…"));
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Manage Person");
  } finally {
    await view.unmount();
  }
});

test("an admin sees why an owner row can't be managed, and nothing about it is disabled", async () => {
  const view = await mount({ role: "admin" });
  try {
    const list = section(view.body, "people");
    const grace = rowNamed(list, "person", "Grace Hopper")!;
    assert.equal(grace.querySelector(".access-row-trail")?.textContent, "Only owners can change an owner");
    assert.equal(buttonNamed(grace, "Manage…"), undefined);
    assertNoDomNode(grace.querySelector(".access-row-open"));
    // Not an owner's row: the admin manages it.
    assert.ok(buttonNamed(rowNamed(list, "person", "Sam Lee")!, "Manage…"));
    assert.equal(view.panel().querySelectorAll("button:disabled, [aria-disabled=\"true\"]").length, 0);
  } finally {
    await view.unmount();
  }
});

test("a viewer is told who can see paired devices and never asks for them", async () => {
  const view = await mount({ role: "viewer" });
  try {
    assert.equal(view.calls.devices, 0, "no GET /api/devices");
    const paired = section(view.body, "devices");
    assert.equal(paired.querySelector(".notice")?.textContent, "Only owners and admins can see paired devices.");
    assert.ok(paired.querySelector(".notice.t-neutral svg"), "a neutral notice with its lock icon");
    assertNoDomNode(paired.querySelector(".surface, .access-empty, .skeleton"), "no list and no empty state");
    assert.equal(paired.querySelector("h2")?.textContent, "Paired Devices", "and no count it can't know");
    assert.equal(view.panel().querySelectorAll(".section-head .btn").length, 0, "a viewer has no section actions");
    assert.equal(view.panel().querySelectorAll(".access-row-open, .access-row-trail .btn").length, 0);
    assert.doesNotMatch(section(view.body, "people").textContent ?? "", /device/, "nor device counts");
  } finally {
    await view.unmount();
  }
});

test("a failed device list stays inside Paired Devices, and Retry asks for devices only", async () => {
  let fail = true;
  const view = await mount({
    listDevices: async () => {
      if (fail) throw new Error("devices table is locked");
      return { devices: structuredClone(devices) };
    },
  });
  try {
    assert.equal(rows(section(view.body, "people"), "person").length, 4, "People still render");
    assert.equal(rows(section(view.body, "teams"), "team").length, 2, "Teams still render");
    const paired = section(view.body, "devices");
    const notice = paired.querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load Paired Devices");
    assert.match(notice.textContent ?? "", /Wollipog didn't get the device list\. People and teams are unaffected\./);
    assert.doesNotMatch(notice.textContent ?? "", /devices table is locked/, "the raw message waits behind Show Details");
    await click(buttonNamed(notice, "Show Details"));
    assert.match(paired.textContent ?? "", /devices table is locked/);
    assertNoDomNode(view.panel().querySelector(":scope > .access-sections > .notice"), "the page has no detached error");
    const identityRequests = view.calls.identity;
    fail = false;
    await click(buttonNamed(notice, "Retry"));
    assert.equal(view.calls.identity, identityRequests, "Retry reloads devices only");
    assert.equal(rows(section(view.body, "devices"), "device").length, 2);
  } finally {
    await view.unmount();
  }
});

test("a device row opens Device Details, whose Revoke Device… confirms naming the device and its person", async () => {
  const view = await mount();
  try {
    const paired = section(view.body, "devices");
    const phone = rowNamed(paired, "device", "Pat's Phone")!;
    assert.match(phone.querySelector(".access-row-meta")?.textContent ?? "", /Paired 5m ago/);
    assert.match(phone.querySelector(".access-row-meta")?.textContent ?? "", /Last used 2h ago/);
    assert.match(rowNamed(paired, "device", "Home Laptop")!.textContent ?? "", /Never used/);
    await click(phone.querySelector(".access-row-open")!);
    const details = dialog();
    assert.equal(details.querySelector(".modal-title, h2")?.textContent, "Pat's Phone");
    assert.deepEqual([...details.querySelectorAll("dl.facts dt")].map((term) => term.textContent),
      ["Person", "Access Level", "Paired", "Last Used"]);
    assert.equal(details.querySelectorAll("dl.facts dd")[1]?.textContent, "Operator");
    assert.ok(details.querySelector("dl.facts time[title]"), "Paired has its date in a tooltip");
    assert.ok(buttonNamed(details, "Done"));
    assert.equal(document.body.innerHTML.includes("pat@example.org"), false, "the person stays masked");

    await click(buttonNamed(details, "Revoke Device…"));
    const confirm = confirmation();
    assert.match(confirm.textContent ?? "", /Revoke Device/);
    assert.match(confirm.textContent ?? "", /“Pat's Phone” stops working for .*Email Hidden.* right away\. To use it again, pair it again\./);
    assert.equal(document.body.innerHTML.includes("pat@example.org"), false, "masked in the confirmation too");
    const devicesBefore = view.calls.devices;
    await click(buttons(confirm).find((button) => button.textContent === "Revoke Device" && button.classList.contains("danger")));
    assert.deepEqual(view.calls.revoked, ["device-1"]);
    assert.ok(view.calls.devices > devicesBefore, "the list is refreshed");
    assertNoDomNode(document.body.querySelector('[role="dialog"]'), "Device Details closes once the device is revoked");
  } finally {
    await view.unmount();
  }
});

test("a desktop row's Revoke… opens the same confirmation", async () => {
  const view = await mount();
  try {
    const laptop = rowNamed(section(view.body, "devices"), "device", "Home Laptop")!;
    const revoke = buttonNamed(laptop, "Revoke…")!;
    assert.ok(revoke.classList.contains("ghost") && revoke.classList.contains("danger"));
    await click(revoke);
    assert.match(confirmation().textContent ?? "", /“Home Laptop” stops working for Misko right away\. To use it again, pair it again\./);
    await click(buttonNamed(confirmation(), "Cancel"));
    assert.deepEqual(view.calls.revoked, []);
  } finally {
    await view.unmount();
  }
});

test("a paired dashboard lists devices without Pair Device… or any Revoke, and says where to do that", async () => {
  const view = await mount({ localBootstrap: false });
  try {
    const paired = section(view.body, "devices");
    assert.equal(buttonNamed(paired, "Pair Device…"), undefined);
    assert.match(paired.querySelector(".notice.t-neutral")?.textContent ?? "",
      /You're on a paired device\. Pair and revoke devices from the computer running Wollipog\./);
    assert.equal(buttons(paired).filter((button) => /Revoke/.test(button.textContent ?? "")).length, 0);
    await click(rowNamed(paired, "device", "Home Laptop")!.querySelector(".access-row-open")!);
    assert.equal(buttons(dialog()).filter((button) => /Revoke/.test(button.textContent ?? "")).length, 0);
    assert.match(dialog().textContent ?? "", /Revoke devices from the computer running Wollipog\./);
  } finally {
    await view.unmount();
  }
});

test("team rows count their members and mask email-shaped names as the People rows do", async () => {
  const view = await mount();
  try {
    const teams = section(view.body, "teams");
    const support = rowNamed(teams, "team", "Support")!;
    assert.match(support.querySelector(".access-row-meta")?.textContent ?? "", /^2 members: Misko, Email Hidden/);
    assert.equal(support.innerHTML.includes("pat@example.org"), false);
    await click(support.querySelector('.access-row-meta button[aria-label="Show Member Name"]')!);
    assert.match(support.querySelector(".access-row-meta")?.textContent ?? "", /pat@example\.org/);
    assert.equal(rowNamed(teams, "team", "Empty Team")!.querySelector(".access-row-meta")?.textContent, "No members yet");
    // A person row's masked name has its reveal beside the open target, never inside it.
    const pat = rows(section(view.body, "people"), "person").find((row) => row.textContent?.includes("Email Hidden"))!;
    assertNoDomNode(pat.querySelector(".access-row-open button"));
    assert.ok(pat.querySelector('.row-line > button[aria-label="Show Person Name"]'));
  } finally {
    await view.unmount();
  }
});

test("only you and no devices: the empty lines sit at the row padding", async () => {
  const view = await mount({
    getIdentity: async () => directory("owner", { memberships: [people[0]!], teams: false }),
    listDevices: async () => ({ devices: [] }),
  });
  try {
    assert.equal(section(view.body, "devices").querySelector(".access-empty")?.textContent,
      "No devices yet. Pair your phone to check on agents when you're away from this computer.");
    assert.equal(section(view.body, "teams").querySelector(".access-empty")?.textContent, "No teams yet.");
  } finally {
    await view.unmount();
  }
});

test("while devices load, Paired Devices shows two skeleton rows and no count", async () => {
  let release: (value: { devices: DeviceView[] }) => void = () => {};
  const view = await mount({ listDevices: () => new Promise((resolve) => { release = resolve; }) });
  try {
    const paired = section(view.body, "devices");
    assert.equal(paired.querySelectorAll(".skeleton .row.row-2").length, 2);
    assert.equal(paired.querySelector("h2")?.textContent, "Paired Devices");
    await act(async () => release({ devices: structuredClone(devices) }));
    await settle();
    assert.equal(rows(section(view.body, "devices"), "device").length, 2);
  } finally {
    await view.unmount();
  }
});

test("a failed identity load is a titled danger notice with Retry, and loading is skeleton rows", async () => {
  let attempts = 0;
  let release: () => void = () => {};
  const view = await mount({
    getIdentity: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("identity store offline");
      await new Promise<void>((resolve) => { release = resolve; });
      return directory("owner");
    },
  });
  try {
    const notice = view.panel().querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load People and Devices");
    assert.doesNotMatch(notice.textContent ?? "", /identity store offline|could not be loaded/);
    assertNoDomNode(view.panel().querySelector(".connection-access-error"));
    await click(buttonNamed(notice, "Retry"));
    assert.ok(view.panel().querySelectorAll(".skeleton .row.row-2").length > 0, "loading is skeleton rows");
    assert.doesNotMatch(view.panel().textContent ?? "", /Loading organization access/);
    await act(async () => release());
    await settle();
    assert.equal(rows(section(view.body, "people"), "person").length, 4);
  } finally {
    await view.unmount();
  }
});

test("an unpaired device shows one line and no error or Retry", async () => {
  const view = await mount({ getIdentity: async () => { throw new Error("unauthorized"); } });
  try {
    await act(async () => view.sockets[0]!.onclose?.({ code: 1008 }));
    await settle();
    assert.equal(view.panel().textContent, "People and devices load after this device is paired.");
    assert.equal(view.panel().querySelectorAll("button, .notice").length, 0);
  } finally {
    await view.unmount();
  }
});

test("offline, the last lists stay on screen dimmed under Reconnecting…, without errors", async () => {
  let offline = false;
  const view = await mount({
    listDevices: async () => {
      if (offline) throw new Error("socket closed");
      return { devices: structuredClone(devices) };
    },
  });
  try {
    offline = true;
    await act(async () => view.sockets[0]!.onclose?.({ code: 1006 }));
    await settle();
    const panel = view.panel();
    assert.equal(panel.querySelector(".state.offline")?.textContent, "Reconnecting…");
    const stale = panel.querySelector(".is-stale")!;
    assert.ok(stale, "the lists are kept as stale content");
    assert.equal(stale.contains(panel.querySelector(".state.offline")), false, "the line itself is not dimmed");
    assert.equal(rows(stale, "person").length, 4);
    assert.equal(rows(stale, "device").length, 2, "the last device list stays");
    assertNoDomNode(panel.querySelector(".notice.t-danger"));
  } finally {
    await view.unmount();
  }
});

test("on a phone each row ends in a chevron, an owner row in a labelled lock, and no row holds a button", async () => {
  await act(async () => domWindow.happyDOM.setWindowSize({ width: 390, height: 844 }));
  const view = await mount({ role: "admin" });
  try {
    const panel = view.panel();
    assert.equal(panel.querySelectorAll(".access-row-trail .btn").length, 0, "no row action renders on a phone");
    const pat = rows(section(view.body, "people"), "person").find((row) => row.textContent?.includes("Email Hidden"))!;
    assert.ok(pat.querySelector('.access-row-trail svg[aria-hidden="true"]'), "a manageable row ends in a chevron");
    const lock = rowNamed(section(view.body, "people"), "person", "Grace Hopper")!.querySelector(".access-row-lock")!;
    assert.equal(lock.getAttribute("role"), "img");
    assert.equal(lock.getAttribute("aria-label"), "Only owners can change an owner");
    assert.equal(rows(section(view.body, "devices"), "device").every((row) => row.querySelector(".access-row-trail svg")), true);
  } finally {
    await view.unmount();
    await act(async () => domWindow.happyDOM.setWindowSize({ width: 1440, height: 900 }));
  }
});

test("a directory change another dashboard made reloads the lists in place (#2606)", async () => {
  let renamed = false;
  const view = await mount({
    getIdentity: async () => {
      const current = directory("owner");
      return renamed
        ? { ...current, memberships: current.memberships.map((one) => one.userId === "sam" ? { ...one, userName: "Sam Rivera" } : one) }
        : current;
    },
  });
  try {
    const people = () => section(view.body, "people");
    assert.ok(rowNamed(people(), "person", "Sam Lee"));
    const panelRoot = view.panel().querySelector(".access-sections");
    const devicesBefore = view.calls.devices;
    renamed = true;
    await act(async () => view.sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "identity_directory_changed" }) }));
    await settle();
    assert.ok(rowNamed(people(), "person", "Sam Rivera"), "the renamed member shows without a reconnect");
    assert.equal(rowNamed(people(), "person", "Sam Lee"), undefined);
    assert.ok(view.calls.devices > devicesBefore, "and the device list is read again with it");
    assert.ok(view.panel().querySelector(".access-sections") === panelRoot, "the panel stayed mounted");
  } finally {
    await view.unmount();
  }
});

/** The directory while your name is still the default "Owner" (#3001), until a save names you. */
function defaultNameServer(role: OrganizationRole = "owner") {
  const server = { name: "Owner", defaultName: true, updates: [] as Array<{ userId: string; body: object }> };
  const getIdentity = async (): Promise<IdentityAdministrationView> => {
    const current = directory(role, {
      memberships: people.map((one) => one.userId === "me" ? { ...one, userName: server.name, role } : one),
    });
    return {
      ...current,
      context: { ...current.context, userName: server.name, ...(server.defaultName ? { defaultName: true as const } : {}) },
    };
  };
  const updateIdentityMember = async (userId: string, body: { displayName?: string }) => {
    server.updates.push({ userId, body });
    if (userId === "me" && body.displayName !== undefined) {
      server.name = body.displayName;
      server.defaultName = false;
    }
    return { membership: member(userId, server.name, role) };
  };
  return { server, getIdentity, updateIdentityMember };
}

const setYourName = (body: HTMLElement) => section(body, "people").querySelector(".notice");

test("while your name is the default, People asks you to set it, and saving any name ends it (#3001)", async () => {
  localStorage.clear();
  const { server, getIdentity, updateIdentityMember } = defaultNameServer();
  const view = await mount({ getIdentity, updateIdentityMember });
  try {
    const notice = setYourName(view.body)!;
    assert.ok(notice.classList.contains("t-neutral"), "one neutral notice");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Set Your Name");
    assert.match(notice.textContent ?? "",
      /People in your organization see you as “Owner”\. Add your name so they know who you are\./);
    assert.deepEqual(buttons(notice).map((button) => button.textContent), ["Set Your Name…", "Not Now"]);
    assert.ok(notice.nextElementSibling?.classList.contains("surface"), "at the top of the People section, above its rows");
    const me = () => rowNamed(section(view.body, "people"), "person", "Owner")!;
    assert.match(me().querySelector(".access-row-meta")?.textContent ?? "", /^OwnerDefault name/);

    await click(buttonNamed(notice, "Set Your Name…"));
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Your Name");
    // Saving the default unchanged is still saving a name.
    await click(buttonNamed(dialog(), "Save Changes"));
    assert.deepEqual(server.updates, [{ userId: "me", body: { displayName: "Owner" } }]);
    assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 0);
    assertNoDomNode(setYourName(view.body), "the notice is gone once a name is saved");
    assert.doesNotMatch(me().textContent ?? "", /Default name/);
    assert.match(me().textContent ?? "", /You/, "and the row still says You");
  } finally {
    await view.unmount();
  }
});

test("your own row and its Edit Name… open Your Name, which sends only the new name (#3001)", async () => {
  localStorage.clear();
  const { server, getIdentity, updateIdentityMember } = defaultNameServer();
  const view = await mount({ getIdentity, updateIdentityMember });
  try {
    const me = rowNamed(section(view.body, "people"), "person", "Owner")!;
    await click(me.querySelector(".access-row-open")!);
    assert.equal(dialog().querySelector(".modal-title, h2")?.textContent, "Your Name");
    await click(buttonNamed(dialog(), "Cancel"));
    await click(buttonNamed(me, "Edit Name…"));
    const yours = dialog();
    assert.equal(yours.querySelector(".modal-title, h2")?.textContent, "Your Name");
    assertNoDomNode(yours.querySelector('[role="radiogroup"]'), "no Access Level choice");
    assert.equal(buttonNamed(yours, "Suspend Access…"), undefined);
    assert.match(yours.textContent ?? "", /Access LevelOwner/);
    assert.match(yours.textContent ?? "", /You can't change your own access level\./);
    const input = yours.querySelector("input")!;
    await act(async () => {
      input.value = "Misko";
      fireDomEvent.change(input);
    });
    await click(buttonNamed(yours, "Save Changes"));
    assert.deepEqual(server.updates, [{ userId: "me", body: { displayName: "Misko" } }]);
    const renamed = rowNamed(section(view.body, "people"), "person", "Misko")!;
    assert.match(renamed.textContent ?? "", /You/);
    assertNoDomNode(setYourName(view.body));
  } finally {
    await view.unmount();
  }
});

test("Not Now hides Set Your Name on this device only; the Default name line stays (#3001)", async () => {
  localStorage.clear();
  const first = defaultNameServer();
  let view = await mount({ getIdentity: first.getIdentity, updateIdentityMember: first.updateIdentityMember });
  try {
    await click(buttonNamed(setYourName(view.body)!, "Not Now"));
    assertNoDomNode(setYourName(view.body));
    assert.deepEqual(first.server.updates, [], "Not Now saves nothing");
    assert.match(rowNamed(section(view.body, "people"), "person", "Owner")!.textContent ?? "", /Default name/);
  } finally {
    await view.unmount();
  }
  // A reload on this device keeps it hidden.
  view = await mount({ getIdentity: first.getIdentity, updateIdentityMember: first.updateIdentityMember });
  try {
    assertNoDomNode(setYourName(view.body), "still hidden after a reload");
  } finally {
    await view.unmount();
  }
  // Another device, with its own storage, still asks.
  localStorage.clear();
  view = await mount({ getIdentity: first.getIdentity, updateIdentityMember: first.updateIdentityMember });
  try {
    assert.ok(setYourName(view.body), "another device still shows the notice");
  } finally {
    await view.unmount();
  }
});

test("Set Your Name shows only to the person whose name is the default, and a viewer's own row opens nothing (#3001)", async () => {
  localStorage.clear();
  // Everyone else's context carries no marker, even when the default person is in their list.
  const other = await mount();
  try {
    assertNoDomNode(setYourName(other.body));
    assert.doesNotMatch(section(other.body, "people").textContent ?? "", /Default name/);
  } finally {
    await other.unmount();
  }
  // A viewer can't call the identity routes, so they are not asked, and their row stays plain.
  const { getIdentity } = defaultNameServer("viewer");
  const viewer = await mount({ role: "viewer", getIdentity });
  try {
    assertNoDomNode(setYourName(viewer.body));
    const me = rowNamed(section(viewer.body, "people"), "person", "Owner")!;
    assert.match(me.textContent ?? "", /You/);
    assertNoDomNode(me.querySelector(".access-row-open"), "the row opens nothing");
    assert.equal(buttons(me).length, 0, "and has no action");
    assert.equal(document.body.querySelectorAll('[role="dialog"]').length, 0);
  } finally {
    await viewer.unmount();
  }
});
