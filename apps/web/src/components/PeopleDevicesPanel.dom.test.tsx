import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { textBefore } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PeopleDevicesPanel } from "./PeopleDevicesPanel.js";

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

test("every masked name on People & Devices says what it hides after a visible label (#1954)", async () => {
  const emailIdentity = {
    context: { userId: "user-1", userName: "owner@example.com", role: "owner", localBootstrap: true },
    memberships: [
      { userId: "user-1", userName: "owner@example.com", role: "owner", userStatus: "active" },
      { userId: "user-2", userName: "pat@example.org", role: "operator", userStatus: "active" },
    ],
    teams: [],
  } as unknown as IdentityAdministrationView;
  const client = {
    ...api,
    getIdentity: async () => emailIdentity,
    listDevices: async () => ({ devices: [{
      deviceId: "device-1", name: "Pat's Phone", userId: "user-2", userName: "pat@example.org", role: "operator",
      createdAt: Date.now(), lastSeenAt: null,
    }] }),
  } as unknown as ApiClient;
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <FeedbackProvider>
            <PeopleDevicesPanel identity={emailIdentity} onIdentityChange={() => {}} />
          </FeedbackProvider>
        </ApiProvider>,
      );
    });
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
    assert.equal(container.innerHTML.includes("@example."), false);
    const labelled = (scope: Element) => {
      const mask = scope.querySelector(".pid-mask")!;
      assert.equal(mask.textContent, "Email Hidden");
      return textBefore(scope, mask);
    };
    assert.equal(labelled(container.querySelector(".access-context")!), "Signed in as");
    const rows = [...container.querySelectorAll(".access-row-main")];
    const [owner, member, device] = rows;
    assert.equal(rows.length, 3, "two people and one device");
    // The value is an email, not a name, so the row says whose it is (#1954 review).
    assert.equal(labelled(owner!), "Person");
    assert.equal(labelled(member!), "Person");
    // A device row names the device first; the person it belongs to is labelled on its own line.
    assert.equal(device!.querySelector("strong")?.textContent, "Pat's Phone");
    assert.equal(labelled(device!.children[1]!), "Person");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
