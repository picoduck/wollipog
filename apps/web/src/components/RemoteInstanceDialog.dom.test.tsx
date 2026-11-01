import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { InstanceProfile } from "../desktop-instances.js";
import { InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import { RemoteInstanceDialog, type RemoteInstanceDialogProps } from "./RemoteInstanceDialog.js";
import { HTTPS_REQUIRED, NAME_REQUIRED, NOT_A_PAIRING_LINK } from "./remote-instance-copy.js";
import { assertNoDomNode, assertSameDomNode } from "../dom-test-assertions.js";

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
  React,
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
  origin: "https://remote.example.test",
  createdAt: "2026-07-20T00:00:00Z",
};
const TOKEN = "abcdefghijklmnop";

function manager(overrides: Partial<InstanceManager> = {}): InstanceManager {
  return {
    desktopMultiInstance: true,
    registry: { profiles: [local, remote], activeInstanceId: "local" },
    activeProfile: local,
    runtime: null,
    navigation: undefined,
    phase: "ready",
    error: null,
    statusByProfile: { local: { availability: "online" }, [remote.id]: { availability: "online" } },
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

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

/** Mounts the dialog; dialogs are portalled to <body>, so queries read the body. */
async function open(props: RemoteInstanceDialogProps, value: InstanceManager = manager()) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.append(host);
  const root = createRoot(host as unknown as HTMLDivElement);
  await act(async () => {
    root.render(<InstancesContextProvider value={value}><RemoteInstanceDialog {...props} /></InstancesContextProvider>);
  });
  const body = domWindow.document.body as unknown as HTMLElement;
  const dialog = () => body.querySelector<HTMLElement>('[role="dialog"]')!;
  /** The control a visible label names, through its `for`. */
  const field = (label: string): HTMLInputElement | null => {
    const element = Array.from(dialog().querySelectorAll<HTMLLabelElement>("label.field-label"))
      .find((candidate) => candidate.textContent === label);
    return element ? dialog().querySelector<HTMLInputElement>(`[id="${element.htmlFor}"]`) : null;
  };
  const button = (name: string) => Array.from(dialog().querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === name) ?? null;
  const type = (input: HTMLInputElement, value: string) => act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
  const press = (name: string) => act(async () => {
    const target = button(name);
    assert.ok(target, `a ${name} button`);
    target.click();
    await tick();
  });
  /** The text an element's aria-describedby points at. */
  const description = (input: Element) => (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  };
  return { body, dialog, field, button, type, press, description, unmount };
}

test("Add Remote Instance shows the name, Connect With, the link and a checked Switch After Adding", async () => {
  const view = await open({ mode: "add", onClose() {} });
  try {
    assert.equal(view.dialog().querySelector("h2")?.textContent, "Add Remote Instance");
    assert.match(view.dialog().textContent ?? "", /Use Wollipog running on another computer from this app\./);
    assert.ok(view.field("Instance Name"));
    assert.match(view.description(view.field("Instance Name")!), /Name the instance so you can find it in the switcher\./);
    const group = view.dialog().querySelector<HTMLElement>('[role="radiogroup"][aria-label="Connect With"]')!;
    assert.ok(group, "Connect With is a segmented radiogroup");
    assert.deepEqual(Array.from(group.querySelectorAll('[role="radio"]')).map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
      [["Pairing Link", "true"], ["Address and Code", "false"]]);
    const link = view.field("Pairing Link")!;
    assert.equal(link.type, "password");
    assert.match(view.description(link), /choose Pair Device… in Connections › People and Devices, then copy the link\./);
    assertNoDomNode(view.field("Server Address"));
    const checkbox = view.dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.closest("label")?.textContent, "Switch After Adding");
    assert.ok(view.button("Add Instance"), "the primary is Add Instance, not Add and Switch");

    await act(async () => { (group.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!).click(); });
    assertNoDomNode(view.field("Pairing Link"), "Address and Code replaces the link");
    assert.ok(view.field("Server Address"));
    assert.equal(view.field("Pairing Code")?.type, "password");
    assert.match(view.dialog().textContent ?? "", /Both come from Pair Device… › Manual Setup on the other computer\./);
  } finally {
    await view.unmount();
  }
});

test("a malformed link shows its error under Pairing Link with focus there, and Address and Code removes it", async () => {
  let adds = 0;
  const view = await open({ mode: "add", onClose() {} }, manager({ async addInstance() { adds += 1; } }));
  try {
    await view.type(view.field("Instance Name")!, "Studio");
    await view.type(view.field("Pairing Link")!, "https://studio.example.test/");
    await view.press("Add Instance");
    assert.equal(adds, 0);
    const link = view.field("Pairing Link")!;
    assert.equal(link.getAttribute("aria-invalid"), "true");
    const error = link.parentElement!.querySelector(".field-error")!;
    assert.equal(error.textContent, NOT_A_PAIRING_LINK);
    assert.equal(link.getAttribute("aria-describedby"), error.id, "the error replaces the helper as the description");
    assertNoDomNode(link.parentElement!.querySelector(".field-helper"), "the helper gives way to the error");
    assertSameDomNode(domWindow.document.activeElement as never, link as never, "focus moves to the invalid field");
    assertNoDomNode(view.dialog().querySelector(".form-error"));
    assertNoDomNode(view.dialog().querySelector('[role="alert"]'), "a field error is announced by focus, not an alert");
    assert.equal(view.dialog().querySelector("form")?.noValidate, true);

    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click(); });
    assert.doesNotMatch(view.dialog().textContent ?? "", /isn't a Wollipog pairing link/, "no link error under the address fields");
    assertNoDomNode(view.dialog().querySelector(".field-error"));
    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[0]!.click(); });
    assertNoDomNode(view.dialog().querySelector(".field-error"), "switching Connect With cleared it");
  } finally {
    await view.unmount();
  }
});

test("submitting an empty form reports each field and focuses the first", async () => {
  const view = await open({ mode: "add", onClose() {} });
  try {
    await view.press("Add Instance");
    const name = view.field("Instance Name")!;
    assert.equal(view.description(name), NAME_REQUIRED);
    assert.equal(view.description(view.field("Pairing Link")!), "Paste the pairing link from the other computer.");
    assertSameDomNode(domWindow.document.activeElement as never, name as never);
    await view.type(name, "S");
    assert.equal(name.getAttribute("aria-invalid"), null, "typing clears that field's error");
    assert.equal(view.field("Pairing Link")!.getAttribute("aria-invalid"), "true", "and only that field's");
  } finally {
    await view.unmount();
  }
});

test("Address and Code reports the address and the code together, in the person's words", async () => {
  const view = await open({ mode: "add", onClose() {} });
  try {
    await view.type(view.field("Instance Name")!, "Studio");
    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click(); });
    await view.type(view.field("Server Address")!, "http://192.168.1.10:4317");
    await view.press("Add Instance");
    assert.equal(view.description(view.field("Server Address")!), HTTPS_REQUIRED);
    assert.equal(view.description(view.field("Pairing Code")!), "Enter the pairing code.");
    assertSameDomNode(domWindow.document.activeElement as never, view.field("Server Address") as never);
  } finally {
    await view.unmount();
  }
});

test("Switch After Adding decides whether the add switches, and the credential leaves the page", async () => {
  const calls: Array<Parameters<InstanceManager["addInstance"]>[0]> = [];
  let closed = 0;
  for (const switchTo of [false, true]) {
    const view = await open({ mode: "add", onClose() { closed += 1; } }, manager({ async addInstance(input) { calls.push(input); } }));
    try {
      await view.type(view.field("Instance Name")!, "Remote A");
      await view.type(view.field("Pairing Link")!, `https://REMOTE.example.test/#pair=${TOKEN}`);
      if (!switchTo) {
        const checkbox = view.dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        await act(async () => { checkbox.click(); });
        assert.equal(checkbox.checked, false);
      }
      await view.press("Add Instance");
      assert.equal(view.field("Pairing Link")!.value, "", "an accepted link is cleared");
      assert.doesNotMatch(view.body.innerHTML, new RegExp(TOKEN));
    } finally {
      await view.unmount();
    }
  }
  assert.deepEqual(calls, [
    { label: "Remote A", origin: "https://remote.example.test", token: TOKEN, switchTo: false },
    { label: "Remote A", origin: "https://remote.example.test", token: TOKEN, switchTo: true },
  ]);
  assert.equal(closed, 2);
});

test("Edit Instance with a changed address requires a link for that address, under its own field", async () => {
  const edits: Array<Parameters<InstanceManager["editInstance"]>[0]> = [];
  const view = await open({ mode: "edit", profile: remote, onClose() {} }, manager({ async editInstance(input) { edits.push(input); } }));
  try {
    assert.equal(view.dialog().querySelector("h2")?.textContent, "Edit Instance");
    assert.match(view.dialog().textContent ?? "", /Change the name or the address this app uses\./);
    assert.equal(view.field("Instance Name")?.value, remote.label);
    assert.equal(view.field("Server Address")?.value, remote.origin);
    assertNoDomNode(view.field("Pairing Link for the New Address"), "the same address needs no link");

    await view.type(view.field("Server Address")!, "https://new.example.test");
    const link = view.field("Pairing Link for the New Address")!;
    assert.match(view.description(link), /A new address needs a fresh pairing link, so the saved credential is never sent to an unverified server\./);
    await view.press("Save Changes");
    assert.equal(view.description(link), "Paste a pairing link created for the new address.");

    await view.type(link, `https://other.example.test/#pair=${TOKEN}`);
    await view.press("Save Changes");
    assert.equal(edits.length, 0);
    assert.equal(link.getAttribute("aria-invalid"), "true");
    assert.match(view.description(link), /This link is for a different address than https:\/\/new\.example\.test\./);
    assertSameDomNode(domWindow.document.activeElement as never, link as never);

    await view.type(link, `https://new.example.test/#pair=${TOKEN}`);
    await view.press("Save Changes");
    assert.deepEqual(edits, [{ profileId: remote.id, label: remote.label, origin: "https://new.example.test", token: TOKEN }]);
  } finally {
    await view.unmount();
  }
});

test("Re-Pair Instance shows the saved address read-only and refuses a link for another address", async () => {
  let repairs: string[] = [];
  const view = await open({ mode: "repair", profile: remote, onClose() {} }, manager({
    statusByProfile: { [remote.id]: { availability: "authentication-required" } },
    async repairInstance(_profileId, token) { repairs.push(token); },
  }));
  try {
    assert.equal(view.dialog().querySelector("h2")?.textContent, "Re-Pair Instance");
    assert.match(view.dialog().textContent ?? "", /Home Workstation no longer accepts this app's saved pairing\./);
    const saved = view.field("Server Address")!;
    assert.equal(saved.readOnly, true);
    assert.equal(saved.value, remote.origin);
    assert.ok(saved.classList.contains("is-read-only"));
    assertNoDomNode(view.field("Instance Name"));
    const link = view.field("Pairing Link")!;
    assert.match(view.description(link), /On Home Workstation, choose Pair Device… in Connections › People and Devices, then paste the new link here\./);

    await view.type(link, `https://other.example.test/#pair=${TOKEN}`);
    await view.press("Re-Pair");
    assert.deepEqual(repairs, []);
    assert.equal(view.description(link), "This link is for a different address than Home Workstation. Create the link on Home Workstation.");
    assert.equal(link.getAttribute("aria-invalid"), "true");

    // Address and Code asks only for the code: the address is the saved one.
    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click(); });
    assert.equal(view.dialog().querySelectorAll('input:not([readonly])').length, 1);
    await view.type(view.field("Pairing Code")!, TOKEN);
    await view.press("Re-Pair");
    assert.deepEqual(repairs, [TOKEN]);
  } finally {
    await view.unmount();
  }
  repairs = [];
  const healthy = await open({ mode: "repair", profile: remote, onClose() {} });
  try {
    assert.match(healthy.dialog().textContent ?? "", /Replace this app's saved pairing for Home Workstation\./);
  } finally {
    await healthy.unmount();
  }
});

test("a failure after submit is a titled danger notice above the footer, its raw words behind Show Details", async () => {
  let closed = 0;
  const view = await open({ mode: "add", onClose() { closed += 1; } }, manager({
    async addInstance() { throw "The pairing token was rejected. Generate a new pairing link."; },
  }));
  try {
    await view.type(view.field("Instance Name")!, "Studio");
    await view.type(view.field("Pairing Link")!, `https://studio.example.test/#pair=${TOKEN}`);
    await view.press("Add Instance");
    assert.equal(closed, 0);
    const notice = view.dialog().querySelector<HTMLElement>(".notice.t-danger")!;
    assert.ok(notice, "a danger notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Add the Instance");
    assert.match(notice.querySelector(".notice-body")?.textContent ?? "", /The other computer didn't accept this pairing\./);
    assert.doesNotMatch(notice.textContent ?? "", /Generate a new pairing link/, "the raw words wait behind Show Details");
    assert.ok(notice.closest("form"), "inside the body, so above the footer");
    assertNoDomNode(view.dialog().querySelector(".form-error"));
    await act(async () => {
      Array.from(notice.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Show Details")!.click();
    });
    assert.match(notice.textContent ?? "", /The pairing token was rejected\. Generate a new pairing link\./);
    assert.equal(view.field("Pairing Link")!.value, `https://studio.example.test/#pair=${TOKEN}`, "a failed link stays to retry");
    assert.doesNotMatch(view.body.innerHTML, new RegExp(TOKEN), "nor does it reach the DOM after a failure");
    await view.type(view.field("Instance Name")!, "Studio 2");
    assertNoDomNode(view.dialog().querySelector(".notice.t-danger"), "a change clears the failure");
  } finally {
    await view.unmount();
  }
});

test("pairing links and codes never reach the DOM while typed or across Connect With (#3814)", async () => {
  const view = await open({ mode: "add", onClose() {} });
  try {
    await view.type(view.field("Pairing Link")!, "https://remote.example.test/#pair=linksecret0000001");
    assert.doesNotMatch(view.body.innerHTML, /linksecret/);
    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click(); });
    await view.type(view.field("Pairing Code")!, "codesecret0000001");
    assert.doesNotMatch(view.body.innerHTML, /codesecret/);
    await act(async () => { view.dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[0]!.click(); });
    assert.equal(view.field("Pairing Link")!.value, "https://remote.example.test/#pair=linksecret0000001", "the link comes back");
    assert.doesNotMatch(view.body.innerHTML, /linksecret|codesecret/);
  } finally {
    await view.unmount();
  }
});
