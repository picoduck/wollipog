import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act, useContext } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ViewerIdentityContext } from "../resolver-identity.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { ViewerIdentityProvider } from "./ViewerIdentityProvider.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

installDomTestCleanup(domWindow);

const identity: IdentityAdministrationView = {
  context: {
    userId: "user-ada", userName: "Ada Lovelace", organizationId: "org", organizationName: "Release Team",
    role: "operator", deviceId: "device-ada", localBootstrap: false,
  },
  organizations: [],
  memberships: [
    { organizationId: "org", organizationName: "Release Team", userId: "user-ada", userName: "Ada Lovelace", userStatus: "active", role: "operator", createdAt: 1 },
    { organizationId: "org", organizationName: "Release Team", userId: "user-grace", userName: "Grace Hopper", userStatus: "active", role: "admin", createdAt: 1 },
  ],
  teams: [],
};

function Viewer() {
  const viewer = useContext(ViewerIdentityContext);
  return <output>{viewer ? `${viewer.userId} shared=${viewer.shared} ${viewer.names.get("user-grace")}` : "unknown"}</output>;
}

async function mount(getIdentity: ApiClient["getIdentity"], runtimeKey: string) {
  const sockets: UiSocket[] = [];
  const credentialListeners: Array<() => void> = [];
  const connection: UiConnectionRuntime = {
    instanceId: runtimeKey, runtimeKey,
    onCredentialChange: (listener) => {
      credentialListeners.push(listener);
      return () => {};
    },
    createSocket: () => {
      const socket: UiSocket = { readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
        onclose: null, onerror: null, send() {}, close() {} };
      sockets.push(socket);
      return socket;
    },
    close() {},
  };
  const container = domWindow.document.createElement("div");
  domWindow.document.body.append(container);
  const root = createRoot(container as unknown as HTMLDivElement);
  await act(async () => {
    root.render(<ApiProvider client={{ ...api, getIdentity }}><StoreProvider connection={connection}>
      <ViewerIdentityProvider><Viewer /></ViewerIdentityProvider>
    </StoreProvider></ApiProvider>);
  });
  return {
    text: () => container.textContent,
    online: () => act(async () => { sockets.at(-1)!.onmessage?.({ data: "{}" }); }),
    switchCredentials: () => act(async () => { for (const listener of credentialListeners) listener(); }),
    unmount: () => act(async () => { root.unmount(); }),
  };
}

test("every transcript surface learns who is viewing once the connection is online (#2527)", async () => {
  let calls = 0;
  const view = await mount(async () => { calls += 1; return identity; }, "viewer-identity");
  try {
    assert.equal(view.text(), "unknown");
    assert.equal(calls, 0, "identity waits for an authenticated connection");
    await view.online();
    assert.equal(calls, 1);
    assert.equal(view.text(), "user-ada shared=true Grace Hopper");
  } finally {
    await view.unmount();
  }
});

test("a failed identity load leaves resolver wording neutral rather than guessing", async () => {
  const view = await mount(async () => { throw new Error("forbidden"); }, "viewer-identity-failure");
  try {
    await view.online();
    assert.equal(view.text(), "unknown");
  } finally {
    await view.unmount();
  }
});

test("a reconnect with other credentials drops the previous viewer before the new one loads", async () => {
  // Ada's tab re-pairs as Grace on the same client. If Grace's identity cannot load, Ada must not
  // remain "you": every answer and decision reads neutrally instead.
  let reject = false;
  const view = await mount(async () => {
    if (reject) throw new Error("identity unavailable");
    return identity;
  }, "viewer-identity-credential-switch");
  try {
    await view.online();
    assert.equal(view.text(), "user-ada shared=true Grace Hopper");
    reject = true;
    await view.switchCredentials();
    assert.equal(view.text(), "unknown", "the reconnecting connection shows no viewer");
    await view.online();
    assert.equal(view.text(), "unknown", "a failed reload keeps the previous viewer dropped");
  } finally {
    await view.unmount();
  }
});
