import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode, textBefore } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PeopleDevicesPanel } from "./PeopleDevicesPanel.js";

/** The panel inside the state RunnersView keeps for it, so an identity it reports is rendered back. */
function PanelHost({ initial, offline, reported }: {
  initial: IdentityAdministrationView;
  offline: boolean;
  reported: IdentityAdministrationView[];
}) {
  const [identity, setIdentity] = React.useState(initial);
  return (
    <PeopleDevicesPanel
      identity={identity}
      offline={offline}
      onIdentityChange={(next) => {
        reported.push(next);
        setIdentity(next);
      }}
    />
  );
}

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
    // The identity chip is gone (#2997); your own row says "You" instead.
    assertNoDomNode(container.querySelector(".access-context"));
    const rows = [...container.querySelectorAll(".access-row")];
    const [owner, member, device] = rows;
    assert.equal(rows.length, 3, "two people and one device");
    // The value is an email, not a name, so the row says whose it is (#1954 review).
    assert.equal(labelled(owner!.querySelector(".row-title")!), "Person");
    assert.equal(labelled(member!.querySelector(".row-title")!), "Person");
    // A device row names the device first; the person it belongs to is labelled on line 2.
    assert.equal(device!.querySelector(".row-title")?.textContent, "Pat's Phone");
    assert.equal(labelled(device!.querySelector(".access-row-meta")!), "Person");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an earlier refresh that answers after a newer one changes nothing (#2997 review)", async () => {
  const directory = (role: "owner" | "viewer") => ({
    context: { userId: "user-1", userName: "Misko", role, localBootstrap: true },
    memberships: [
      { userId: "user-1", userName: "Misko", role, userStatus: "active" },
      { userId: "user-2", userName: "Pat", role: "operator", userStatus: "active" },
    ],
    teams: [],
  }) as unknown as IdentityAdministrationView;
  // The first refresh waits; the reconnect's refresh answers at once, with a demoted role.
  let answerFirst: (identity: IdentityAdministrationView) => void = () => {};
  let identityCalls = 0;
  let deviceCalls = 0;
  const client = {
    ...api,
    getIdentity: () => {
      identityCalls += 1;
      return identityCalls === 1
        ? new Promise<IdentityAdministrationView>((resolve) => { answerFirst = resolve; })
        : Promise.resolve(directory("viewer"));
    },
    listDevices: async () => {
      deviceCalls += 1;
      return { devices: [] };
    },
  } as unknown as ApiClient;
  const reported: IdentityAdministrationView[] = [];
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  const render = (offline: boolean) => act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <PanelHost initial={directory("owner")} offline={offline} reported={reported} />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); });
  try {
    await render(false);
    await render(true);
    await render(false);
    await settle();
    assert.equal(identityCalls, 2, "the reconnect asked again while the first refresh was still out");
    assert.deepEqual(reported.map((identity) => identity.context.role), ["viewer"]);
    assert.equal(deviceCalls, 0, "a viewer asks for no devices");
    const actions = () => [...container.querySelectorAll("button")].map((button) => button.textContent);
    assert.equal(actions().includes("Add Person…"), false);

    await act(async () => answerFirst(directory("owner")));
    await settle();
    assert.deepEqual(reported.map((identity) => identity.context.role), ["viewer"], "the older owner identity is dropped");
    assert.equal(deviceCalls, 0, "and asks for no devices on that older role's behalf");
    assert.equal(actions().includes("Add Person…"), false, "no administration controls come back");
    assert.match(container.textContent ?? "", /Only owners and admins can see paired devices\./);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
