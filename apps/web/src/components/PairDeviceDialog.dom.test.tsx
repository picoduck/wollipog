import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { PairingBlocker, PairingReach } from "../device-token.js";
import { PairDeviceDialog } from "./PairDeviceDialog.js";

/**
 * Pair Device (#2999): one title over both steps and the result, every member listed with
 * suspended people disabled and saying why, the for-line and Device Name's field error, the result's
 * one-time warning, QR and address, each reason no other device can reach this computer in plain
 * words with the operator detail behind Show Details, and Manual Setup's single-line wells.
 */

let phone = false;
const domWindow = new Window({ url: "http://localhost:4317/", width: 1440, height: 900 });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  // A getter: the shared media stores keep one list per query and read `matches` on every render.
  value: (query: string) => ({
    get matches() { return query === "(pointer: fine)" ? !phone : query === "(max-width: 760px)" ? phone : false; },
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
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
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const body = domWindow.document.body as unknown as HTMLElement;
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const TOKEN = "one_time_device_token";

function identity(memberships: Array<{ userId: string; userName: string; role: string; userStatus: string }>): IdentityAdministrationView {
  return {
    context: { userId: "user-1", userName: "Misko", role: "owner", localBootstrap: true },
    memberships,
    teams: [],
  } as unknown as IdentityAdministrationView;
}

const people = identity([
  { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" },
  { userId: "user-2", userName: "Pat", role: "operator", userStatus: "active" },
  { userId: "user-3", userName: "Sam", role: "viewer", userStatus: "suspended" },
  { userId: "user-4", userName: "Alex", role: "admin", userStatus: "active" },
]);

const reachable: PairingReach = { hosts: ["100.114.88.27", "192.168.1.197"], port: 443, webServed: true, boundBeyondLoopback: true };
const REACH_FOR: Record<PairingBlocker, PairingReach> = {
  "not-web-served": { ...reachable, webServed: false },
  "remote-access": { ...reachable, publicOrigin: "https://box.example", remoteAccess: { phase: "failed", message: "tailscale serve is not running" } },
  loopback: { ...reachable, boundBeyondLoopback: false },
  "no-address": { ...reachable, hosts: [] },
};

const unmounts = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const unmount of [...unmounts]) await unmount();
  phone = false;
});

async function mount({ directory = people, reach = reachable, onSaved = async () => {}, pairDevice }: {
  directory?: IdentityAdministrationView;
  reach?: PairingReach;
  onSaved?: () => Promise<void>;
  pairDevice?: ApiClient["pairDevice"];
} = {}) {
  const calls: Array<[string, string | undefined]> = [];
  let closed = 0;
  const client = {
    ...api,
    pairDevice: pairDevice ?? (async (name: string, userId?: string) => {
      calls.push([name, userId]);
      return { device: { deviceId: "device-1", name } as never, token: TOKEN, pairing: reach };
    }),
  } as unknown as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  body.append(mountPoint);
  const root = createRoot(mountPoint);
  const render = (next: IdentityAdministrationView) => act(async () => {
    root.render(
      <ApiProvider client={client}>
        <PairDeviceDialog identity={next} onClose={() => { closed += 1; }} onSaved={onSaved} />
      </ApiProvider>,
    );
  });
  await render(directory);
  await settle();
  const unmount = async () => {
    if (!unmounts.delete(unmount)) return;
    await act(async () => root.unmount());
    mountPoint.remove();
  };
  unmounts.add(unmount);
  const dialog = () => {
    const found = body.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(found, "the dialog is open");
    return found;
  };
  return { calls, closed: () => closed, dialog, render };
}

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name) ?? null;
const rows = (scope: Element) => [...scope.querySelectorAll<HTMLElement>(".choice-row")].map((row) => {
  const input = row.querySelector("input") as HTMLInputElement;
  return {
    title: row.querySelector(".choice-row-title")?.textContent,
    meta: row.querySelector(".choice-row-meta")?.textContent,
    checked: input.checked,
    disabled: input.getAttribute("aria-disabled") === "true",
    reason: row.querySelector(".choice-row-reason")?.textContent ?? null,
    input,
  };
});
const heading = (scope: Element) => ({
  title: scope.querySelector(".modal-title")?.textContent,
  description: scope.querySelector(".modal-desc")?.textContent,
});
async function click(button: HTMLElement | null) {
  assert.ok(button, "the button exists");
  await act(async () => { button.click(); });
  await settle();
}
const nameInput = (scope: Element) => {
  const label = [...scope.querySelectorAll("label")].find((element) => element.textContent === "Device Name");
  assert.ok(label, "Device Name has a label");
  return domWindow.document.getElementById(label.getAttribute("for")!) as unknown as HTMLInputElement;
};
async function typeName(scope: Element, value: string) {
  const input = nameInput(scope);
  await act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
}
async function createLink(view: Awaited<ReturnType<typeof mount>>, deviceName = "Phone") {
  await click(buttonNamed(view.dialog(), "Continue"));
  await typeName(view.dialog(), deviceName);
  await click(buttonNamed(view.dialog(), "Create Pairing Link"));
}
const primaries = (scope: Element) => [...scope.querySelectorAll(".btn.primary")];

test("one title over both steps, every member listed in the page's order with suspended people disabled and saying why", async () => {
  const view = await mount();
  let dialog = view.dialog();
  assert.deepEqual(heading(dialog), { title: "Pair Device", description: "Step 1 of 2: Choose who it's for." });
  assert.ok(body.querySelector(".modal-backdrop[data-grows]"), "anchored near the top so a taller step grows downward");
  assert.deepEqual(rows(dialog).map(({ title, meta, checked, disabled, reason }) => ({ title, meta, checked, disabled, reason })), [
    { title: "Alex", meta: "Admin", checked: false, disabled: false, reason: null },
    { title: "Misko", meta: "Owner", checked: true, disabled: false, reason: null },
    { title: "Pat", meta: "Operator", checked: false, disabled: false, reason: null },
    { title: "Sam", meta: "Viewer", checked: false, disabled: true, reason: "Suspended. Restore their access to pair a device." },
  ]);

  // Neither a click nor the keyboard's change chooses a suspended person.
  const sam = rows(dialog)[3]!.input;
  await act(async () => { sam.click(); });
  await act(async () => { fireDomEvent.change(sam); });
  assert.deepEqual(rows(dialog).filter((row) => row.checked).map((row) => row.title), ["Misko"]);

  await act(async () => { fireDomEvent.change(rows(dialog)[2]!.input); });
  await click(buttonNamed(dialog, "Continue"));
  dialog = view.dialog();
  assert.deepEqual(heading(dialog), { title: "Pair Device", description: "Step 2 of 2: Name the device." });
  assert.equal(dialog.querySelector(".for-line")?.textContent, "For Pat (Operator)Change");
  assert.equal(domWindow.document.activeElement, nameInput(dialog), "a fine pointer lands in Device Name");

  // Change returns to step 1 with the chosen person kept.
  await click(buttonNamed(dialog, "Change"));
  dialog = view.dialog();
  assert.deepEqual(heading(dialog).title, "Pair Device");
  assert.deepEqual(rows(dialog).filter((row) => row.checked).map((row) => row.title), ["Pat"]);
  assert.equal(domWindow.document.activeElement, rows(dialog)[2]!.input, "focus returns to the chosen person");
});

test("a suspended viewer of the dialog is not preselected; the first active person is", async () => {
  const view = await mount({
    directory: identity([
      { userId: "user-1", userName: "Misko", role: "owner", userStatus: "suspended" },
      { userId: "user-2", userName: "Pat", role: "operator", userStatus: "active" },
    ]),
  });
  assert.deepEqual(rows(view.dialog()).filter((row) => row.checked).map((row) => row.title), ["Pat"]);
});

test("Create Pairing Link with an empty name says so under Device Name and creates nothing", async () => {
  const view = await mount();
  await click(buttonNamed(view.dialog(), "Continue"));
  const dialog = view.dialog();
  const create = buttonNamed(dialog, "Create Pairing Link");
  assert.ok(create?.classList.contains("primary"), "the final step's primary names the outcome");
  assert.equal(buttonNamed(dialog, "Back")?.classList.contains("primary"), false);
  await click(create);
  const input = nameInput(dialog);
  const error = dialog.querySelector(".field-error");
  assert.equal(error?.textContent, "Name the device.");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.getAttribute("aria-describedby"), error?.id);
  assertNoDomNode(dialog.querySelector(".field-helper"), "the error replaces the helper");
  assert.equal(domWindow.document.activeElement, input);
  assert.deepEqual(view.calls, []);

  // The error clears as soon as the value is valid, and the helper comes back.
  await typeName(dialog, "Phone");
  assertNoDomNode(dialog.querySelector(".field-error"), "a valid name clears the error");
  assert.equal(dialog.querySelector(".field-helper")?.textContent, "Use a name they'll recognize later, like Pixel 9 or Home Laptop.");
});

test("the result keeps the one-time link through a failed list refresh, with one grid of QR and address and no primary", async () => {
  let refreshed = false;
  const view = await mount({
    onSaved: async () => {
      refreshed = true;
      throw new Error("refresh offline");
    },
  });
  await createLink(view);
  assert.ok(refreshed);
  assert.deepEqual(view.calls, [["Phone", "user-1"]]);
  const dialog = view.dialog();
  assert.deepEqual(heading(dialog), { title: "Pair Device", description: "Phone is ready to pair for Misko." });
  assert.equal(
    dialog.querySelector(".notice.compact")?.textContent,
    "The link works once and isn't shown again. Pair the device before you close this.",
  );
  assert.deepEqual(primaries(dialog), [], "Copy Pairing Link and Done are both secondary");
  assert.ok(buttonNamed(dialog, "Done")?.classList.contains("btn"));
  const copy = buttonNamed(dialog, "Copy Pairing Link");
  assert.ok(copy?.classList.contains("btn"));
  assert.equal(domWindow.document.activeElement, copy, "focus moves to Copy Pairing Link");
  assert.match(dialog.textContent ?? "", /Scan the code with the device's camera, or copy the link and open it on the device\./);
  assert.match(dialog.textContent ?? "", /Couldn't Refresh Paired Devices/);

  const qr = dialog.querySelector('.pair-result .pair-qr svg[role="img"]');
  assert.ok(qr, "the reachable link is an accessible QR code");
  assert.equal(qr.querySelector("title")?.textContent, "Pair Phone with Wollipog");
  // The link carries the credential: it is neither text nor an attribute until Manual Setup opens.
  assert.equal(dialog.innerHTML.includes(TOKEN), false);

  const trigger = dialog.querySelector<HTMLButtonElement>('[aria-label^="Network Address:"]');
  assert.ok(trigger, "two addresses offer the shared Select");
  assert.match(trigger.getAttribute("aria-label") ?? "", /100\.114\.88\.27:443/);
  assert.match(dialog.textContent ?? "", /Pick an address the device can reach\./);
  const firstQr = qr.innerHTML;
  await click(trigger);
  const option = [...body.querySelectorAll<HTMLElement>('[role="option"]')].find((each) => each.textContent?.startsWith("192.168.1.197:443"));
  assert.ok(option);
  await click(option);
  assert.notEqual(dialog.querySelector(".pair-qr svg")?.innerHTML, firstQr, "another address draws another code");
  assert.equal(body.innerHTML.includes(TOKEN), false);
});

test("one reachable address shows no address picker", async () => {
  const view = await mount({ reach: { ...reachable, hosts: ["192.168.1.197"] } });
  await createLink(view);
  assertNoDomNode(view.dialog().querySelector('[aria-label^="Network Address:"]'), "no picker for one address");
  assert.ok(view.dialog().querySelector(".pair-qr svg"));
});

test("Manual Setup's two values reach the DOM only when opened, each a single-line code well with its copy button", async () => {
  const view = await mount();
  await createLink(view);
  const dialog = view.dialog();
  const details = dialog.querySelector<HTMLDetailsElement>("details.disclosure");
  assert.ok(details);
  assertNoDomNode(dialog.querySelector(".code-well"), "nothing to copy until Manual Setup opens");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new domWindow.Event("toggle") as unknown as Event);
  });
  assert.match(dialog.textContent ?? "", /Use these only if the device can't open a link\./);
  const wells = [...dialog.querySelectorAll(".pair-manual .field")].map((field) => ({
    label: field.querySelector(".field-label")?.textContent,
    oneLine: field.querySelector(".code-well")?.classList.contains("one-line"),
    value: field.querySelector(".code-well > code")?.textContent,
    copy: field.querySelector(".code-well > button.icon-btn.sm")?.getAttribute("aria-label"),
  }));
  assert.deepEqual(wells, [
    { label: "Pairing Fragment", oneLine: true, value: `#pair=${TOKEN}`, copy: "Copy Pairing Fragment" },
    { label: "Pairing Code", oneLine: true, value: TOKEN, copy: "Copy Pairing Code" },
  ]);
  assertNoDomNode(dialog.querySelector("pre.code-block, .install-cmd"), "the old blocks are gone");
});

const EXPECTED: Record<PairingBlocker, { title: string; action: boolean; detail: RegExp | null }> = {
  loopback: { title: "Other Devices Can't Reach This Computer Yet", action: true, detail: /CONTROL_PLANE_PUBLIC_ORIGIN.*CONTROL_PLANE_HOST/u },
  "not-web-served": { title: "This Computer Isn't Serving Wollipog's Pages", action: false, detail: /pnpm --filter @wollipog\/web build/u },
  "remote-access": { title: "Remote Access Needs Attention", action: true, detail: /tailscale serve is not running/u },
  "no-address": { title: "No Network Address Found", action: false, detail: null },
};

for (const [reason, expected] of Object.entries(EXPECTED) as Array<[PairingBlocker, typeof EXPECTED[PairingBlocker]]>) {
  test(`with no reachable link (${reason}), the result says why in plain words and keeps the operator detail behind Show Details`, async () => {
    const view = await mount({ reach: REACH_FOR[reason] });
    await createLink(view);
    const dialog = view.dialog();
    assertNoDomNode(dialog.querySelector(".pair-qr"), "no code without a reachable link");
    const notice = dialog.querySelector<HTMLElement>(".notice.t-warning:not(.compact)");
    assert.ok(notice);
    assert.equal(notice.querySelector(".notice-title")?.textContent, expected.title);
    assert.equal(Boolean(buttonNamed(notice, "Open Network Settings")), expected.action);
    assert.doesNotMatch(dialog.textContent ?? "", /CONTROL_PLANE|control plane|pnpm/u, "nothing for operators until Show Details");
    assert.deepEqual(primaries(dialog), []);
    // Copy Pairing Link stays, secondary, with a link another browser on this computer can open.
    const copy = buttonNamed(dialog, "Copy Pairing Link");
    assert.ok(copy?.classList.contains("btn"));
    assert.equal(copy?.classList.contains("primary"), false);
    assert.match(dialog.textContent ?? "", /The link still works in another browser on this computer\./);
    const show = buttonNamed(notice, "Show Details");
    if (!expected.detail) {
      assertNoDomNode(show, "nothing behind Show Details");
      return;
    }
    await click(show);
    assert.match(notice.textContent ?? "", expected.detail);
  });
}

test("Open Network Settings leaves the dialog", async () => {
  const view = await mount({ reach: REACH_FOR.loopback });
  await createLink(view);
  const assign = domWindow.location.assign;
  const visited: string[] = [];
  domWindow.location.assign = ((url: string) => { visited.push(url); }) as typeof assign;
  try {
    await click(buttonNamed(view.dialog(), "Open Network Settings"));
  } finally {
    domWindow.location.assign = assign;
  }
  assert.deepEqual(visited, ["/settings/network"]);
  assert.equal(view.closed(), 1);
});

test("email-shaped names stay masked in the picker, the for-line and the result until revealed", async () => {
  const view = await mount({
    directory: identity([
      { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" },
      { userId: "user-2", userName: "pat@example.com", role: "operator", userStatus: "active" },
      { userId: "user-3", userName: "sam@example.org", role: "viewer", userStatus: "suspended" },
    ]),
  });
  let dialog = view.dialog();
  const leaked = () => body.innerHTML.includes("@example.");
  assert.equal(leaked(), false);
  assert.deepEqual(rows(dialog).map((row) => row.title), ["Misko", "Hidden Name 1", "Hidden Name 2"]);
  await click(buttonNamed(dialog, "Show Names"));
  assert.deepEqual(rows(dialog).map((row) => row.title), ["Misko", "pat@example.com", "sam@example.org"]);
  await act(async () => { fireDomEvent.change(rows(dialog)[1]!.input); });
  await click(buttonNamed(dialog, "Continue"));

  dialog = view.dialog();
  assert.equal(leaked(), false, "the for-line masks the name again");
  assert.equal(dialog.querySelector(".for-line .pid-mask")?.textContent, "Email Hidden");
  await click(buttonNamed(dialog, "Show Person Name"));
  assert.match(dialog.querySelector(".for-line")?.textContent ?? "", /For pat@example\.com \(Operator\)/);
  await click(buttonNamed(dialog, "Hide Person Name"));
  await typeName(dialog, "Pat's Tablet");
  await click(buttonNamed(dialog, "Create Pairing Link"));

  dialog = view.dialog();
  assert.equal(leaked(), false, "the result sentence masks the name");
  assert.equal(heading(dialog).description, "Pat's Tablet is ready to pair for Email Hidden.");
  await click(buttonNamed(dialog.querySelector(".modal-desc")!, "Show Person Name"));
  assert.equal(heading(dialog).description, "Pat's Tablet is ready to pair for pat@example.com.");
});

test("on a phone the sheet's header Back returns from step 2 to step 1 with the chosen person kept", async () => {
  phone = true;
  const view = await mount();
  let dialog = view.dialog();
  assertNoDomNode(dialog.querySelector(".modal-back"), "step 1 has no Back");
  await act(async () => { fireDomEvent.change(rows(dialog)[2]!.input); });
  await click(buttonNamed(dialog, "Continue"));
  dialog = view.dialog();
  const back = dialog.querySelector<HTMLButtonElement>(".modal-back");
  assert.equal(back?.getAttribute("aria-label"), "Back");
  assert.notEqual(domWindow.document.activeElement, nameInput(dialog), "a touch keyboard does not open over the sheet");
  await click(back);
  dialog = view.dialog();
  assert.equal(heading(dialog).description, "Step 1 of 2: Choose who it's for.");
  assert.deepEqual(rows(dialog).filter((row) => row.checked).map((row) => row.title), ["Pat"]);
  assert.equal(view.closed(), 0);
});

test("a refused creation keeps step 2 and says so above the footer, with the server's words behind Show Details", async () => {
  const view = await mount({ pairDevice: async () => { throw new Error("device limit reached"); } });
  await createLink(view);
  const dialog = view.dialog();
  assert.equal(heading(dialog).description, "Step 2 of 2: Name the device.");
  const notice = dialog.querySelector<HTMLElement>(".notice.t-danger");
  assert.equal(notice?.querySelector(".notice-title")?.textContent, "Couldn't Create the Pairing Link");
  assert.doesNotMatch(dialog.textContent ?? "", /device limit reached/);
  await click(buttonNamed(notice!, "Show Details"));
  assert.match(notice?.textContent ?? "", /device limit reached/);
});
