import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { api } from "../api.js";
import { ManagePersonDialog, PairDeviceDialog } from "./PeopleDevicesPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const identity = {
  context: {
    userId: "user-1",
    userName: "Misko",
    role: "owner",
    localBootstrap: true,
  },
  memberships: [{
    userId: "user-1",
    userName: "Misko",
    role: "owner",
    userStatus: "active",
  }],
  teams: [],
} as unknown as IdentityAdministrationView;

test("pairing reveals the one-time credential even when the follow-up refresh fails", async () => {
  const priorPairDevice = api.pairDevice;
  const token = "one_time_device_token";
  api.pairDevice = async () => ({
    device: { deviceId: "device-1", name: "Phone" } as never,
    token,
    pairing: {
      hosts: ["100.114.88.27", "192.168.1.197"],
      port: 443,
      webServed: true,
      boundBeyondLoopback: true,
    },
  });

  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <PairDeviceDialog
          identity={identity}
          onClose={() => {}}
          onSaved={async () => {
            throw new Error("refresh offline");
          }}
        />,
      );
    });

    const continueButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Continue") as unknown as HTMLButtonElement;
    await act(async () => { continueButton.click(); });

    const input = container.querySelector("input") as unknown as HTMLInputElement;
    await act(async () => {
      input.value = "Phone";
      fireDomEvent.change(input);
    });
    const createButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Create Pairing") as unknown as HTMLButtonElement;
    await act(async () => {
      createButton.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });

    assert.match(container.textContent ?? "", /Device Ready to Pair/);
    assert.match(container.textContent ?? "", /This credential is shown once/);
    assert.match(container.textContent ?? "", /Scan to Pair/);
    assert.match(container.textContent ?? "", /open the camera and scan this code/);
    const qr = container.querySelector('.access-pairing-qr svg[role="img"]');
    assert.ok(qr, "the reachable pairing link should render as an accessible QR code");
    assert.equal(qr.querySelector("title")?.textContent, "Pair Phone with Wollipog");
    const address = container.querySelector(".access-pairing-address select") as unknown as HTMLSelectElement;
    assert.equal(address.value, `http://100.114.88.27:443/#pair=${token}`);
    const firstQr = qr.innerHTML;
    await act(async () => {
      address.value = `http://192.168.1.197:443/#pair=${token}`;
      fireDomEvent.change(address);
    });
    assert.equal(address.value, `http://192.168.1.197:443/#pair=${token}`);
    assert.notEqual(qr.innerHTML, firstQr, "changing the reachable address should regenerate the QR code");
    assert.match(container.textContent ?? "", /Device created, but the device list could not be refreshed: refresh offline/);
    assert.match(container.textContent ?? "", new RegExp(token));
  } finally {
    await act(async () => { root.unmount(); });
    api.pairDevice = priorPairDevice;
    container.remove();
  }
});

test("managing an email-named person keeps the stored name out of the form until shown", async () => {
  const priorUpdate = api.updateIdentityMember;
  const updates: Array<{ displayName?: string }> = [];
  api.updateIdentityMember = (async (_userId: string, body: { displayName?: string }) => {
    updates.push(body);
    return {} as never;
  }) as typeof api.updateIdentityMember;
  const member = { userId: "user-2", userName: "pat@example.com", role: "operator", userStatus: "active" } as never;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const button = (text: string) => Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === text) as unknown as HTMLButtonElement | undefined;
  const nameInput = () => Array.from(container.querySelectorAll("input"))
    .find((input) => (input as unknown as HTMLInputElement).value.includes("@")) as unknown as HTMLInputElement | undefined;
  try {
    await act(async () => {
      root.render(<ManagePersonDialog actorRole="owner" member={member} onClose={() => {}} onSaved={async () => {}} />);
    });
    assert.equal(container.innerHTML.includes("@example."), false, "neither the title nor the field shows the name");
    assert.equal(nameInput(), undefined);

    await act(async () => { button("Show Person Name")!.click(); });
    assert.equal(nameInput()?.value, "pat@example.com");
    await act(async () => { button("Hide Person Name")!.click(); });
    assert.equal(container.innerHTML.includes("@example."), false, "the name can be hidden again while the dialog is open");

    // Changing only the role never needs the name revealed, and saves it unchanged.
    await act(async () => {
      button("Save Changes")!.click();
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });
    assert.equal(updates[0]?.displayName, "pat@example.com");
  } finally {
    await act(async () => { root.unmount(); });
    api.updateIdentityMember = priorUpdate;
    container.remove();
  }
});

test("the pairing person picker masks email-named people until one deliberate reveal", async () => {
  const emailIdentity = {
    ...identity,
    memberships: [
      { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" },
      { userId: "user-2", userName: "pat@example.com", role: "operator", userStatus: "active" },
      { userId: "user-3", userName: "pat@example.org", role: "viewer", userStatus: "active" },
    ],
  } as unknown as IdentityAdministrationView;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<PairDeviceDialog identity={emailIdentity} onClose={() => {}} onSaved={async () => {}} />);
    });
    const names = () => Array.from(container.querySelectorAll(".access-choice strong")).map((node) => node.textContent);
    assert.equal(container.innerHTML.includes("@example."), false);
    assert.deepEqual(names(), ["Misko", "Hidden Name 1", "Hidden Name 2"]);
    const reveal = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Show Person Names") as unknown as HTMLButtonElement;
    assert.ok(reveal);
    await act(async () => { reveal.click(); });
    assert.deepEqual(names(), ["Misko", "pat@example.com", "pat@example.org"]);

    // A refreshed membership list is a different set of values: the earlier reveal does not carry over.
    const refreshed = {
      ...emailIdentity,
      memberships: [
        ...emailIdentity.memberships,
        { userId: "user-4", userName: "sam@example.net", role: "viewer", userStatus: "active" },
      ],
    } as unknown as IdentityAdministrationView;
    await act(async () => {
      root.render(<PairDeviceDialog identity={refreshed} onClose={() => {}} onSaved={async () => {}} />);
    });
    assert.equal(container.innerHTML.includes("@example."), false);
    assert.deepEqual(names(), ["Misko", "Hidden Name 1", "Hidden Name 2", "Hidden Name 3"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
