import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, createApiClient, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { createNativeApiTransport, type NativeInvokeRuntime } from "../native-api-transport.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { RunnersView } from "./RunnersView.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const ipcFailure = "The remote HTTP command requires a binary request frame.";
const client = { ...api, getIdentity: async () => { throw ipcFailure; } } as ApiClient;

async function render(children: React.ReactNode, activeClient: ApiClient = client) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ApiProvider client={activeClient}>{children}</ApiProvider>);
    await Promise.resolve();
  });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("Create Project shows a native IPC string rejection and stops loading access scopes", async () => {
  const { container, unmount } = await render(<CreateProjectDialog
    accessScopeManagementSupported
    onClose={() => {}}
    onCreated={() => {}}
  />);
  try {
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /binary request frame/u);
    assert.doesNotMatch(container.textContent ?? "", /Loading permitted access scopes/u);
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create Project");
    assert.ok(create);
    assert.equal(create.disabled, true);
  } finally {
    await unmount();
  }
});

test("Create Project shows an IPC string error when submission fails", async () => {
  const desktop: NativeInvokeRuntime = {
    async invoke<T>(): Promise<T> { throw "native request failed"; },
  };
  const transport = createNativeApiTransport({
    instanceId: "a",
    runtimeKey: "a:1",
    publicOrigin: "https://a.test",
    desktop,
  });
  const { container, unmount } = await render(<CreateProjectDialog
    accessScopeManagementSupported={false}
    onClose={() => {}}
    onCreated={() => {}}
  />, createApiClient(transport));
  try {
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      fireDomEvent.change(input, { target: { value: "Test Project" } });
    });
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Create Project");
    assert.ok(create);
    assert.equal(create.disabled, false);
    await act(async () => {
      fireDomEvent.submit(container.querySelector<HTMLFormElement>("form")!);
      await Promise.resolve();
    });
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "native request failed");
    assert.equal(create.disabled, false);
  } finally {
    await unmount();
  }
});

test("People & Devices shows a native IPC string rejection and stops loading organization access", async () => {
  const socket: UiSocket = {
    readyState: UI_SOCKET_OPEN,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send() {}, close() {},
  };
  const connection: UiConnectionRuntime = {
    instanceId: "desktop-ipc-error-test",
    runtimeKey: "desktop-ipc-error-test:1",
    createSocket: () => socket,
    close() {},
  };
  const { container, unmount } = await render(<FeedbackProvider><StoreProvider
    connection={connection}
    navigation={{ current: () => ({ name: "runners", section: "people" }), push() {}, listen: () => () => {} }}
  ><RunnersView /></StoreProvider></FeedbackProvider>);
  try {
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /binary request frame/u);
    assert.doesNotMatch(container.textContent ?? "", /Loading organization access/u);
  } finally {
    await unmount();
  }
});
