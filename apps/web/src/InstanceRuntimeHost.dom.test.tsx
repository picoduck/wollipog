import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createApiClient } from "./api.js";
import { useApi } from "./api-context.js";
import type { ApiTransport } from "./api-transport.js";
import { InstanceRuntimeHost } from "./InstanceRuntimeHost.js";
import type { InstanceRuntime } from "./instance-runtime.js";
import type { UiSocket } from "./ui-transport.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface TrackingSocket extends UiSocket { closeCount: number }

function fixtureRuntime(instanceId: string, calls: string[], sockets: TrackingSocket[]): InstanceRuntime {
  const transport: ApiTransport = {
    instanceId,
    publicOrigin: `https://${instanceId}.example.test`,
    close() {},
    async request(path) {
      calls.push(path);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  };
  return {
    instanceId,
    publicOrigin: transport.publicOrigin,
    api: createApiClient(transport),
    ui: {
      instanceId,
      runtimeKey: `${instanceId}:1`,
      createSocket() {
        const socket: TrackingSocket = {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          closeCount: 0,
          send() {},
          close() { this.closeCount += 1; },
        };
        sockets.push(socket);
        return socket;
      },
      close() { for (const socket of sockets) socket.close(); },
    },
    close() {},
  };
}

function ApiProbe() {
  const api = useApi();
  return <button onClick={() => void api.getIdentity()}>Load Identity</button>;
}

test("an opted-in standalone runtime host replaces REST and WebSocket ownership together", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const callsA: string[] = [];
  const callsB: string[] = [];
  const socketsA: TrackingSocket[] = [];
  const socketsB: TrackingSocket[] = [];
  const runtimeA = fixtureRuntime("instance-a", callsA, socketsA);
  const runtimeB = fixtureRuntime("instance-b", callsB, socketsB);
  let closedA = 0;
  let closedB = 0;
  runtimeA.close = () => { closedA += 1; };
  runtimeB.close = () => { closedB += 1; };

  await act(async () => { root.render(<StrictMode><InstanceRuntimeHost runtime={runtimeA} disposeOnUnmount><ApiProbe /></InstanceRuntimeHost></StrictMode>); });
  assert.equal(closedA, 0);
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.deepEqual(callsA, ["/api/identity"]);
  assert.equal(socketsA.length, 2);

  await act(async () => { root.render(<StrictMode><InstanceRuntimeHost runtime={runtimeB} disposeOnUnmount><ApiProbe /></InstanceRuntimeHost></StrictMode>); });
  assert.equal(closedA, 1);
  assert.equal(socketsA.at(-1)!.closeCount, 1);
  assert.equal(socketsB.length, 1);
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.deepEqual(callsA, ["/api/identity"]);
  assert.deepEqual(callsB, ["/api/identity"]);

  await act(async () => { root.unmount(); });
  assert.equal(closedB, 1);
  container.remove();
});

test("a provider-owned desktop runtime survives host remounts", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const runtime = fixtureRuntime("desktop-instance", [], []);
  let closes = 0;
  runtime.close = () => { closes += 1; };

  await act(async () => {
    root.render(<StrictMode><InstanceRuntimeHost runtime={runtime}><span>Ready</span></InstanceRuntimeHost></StrictMode>);
  });
  await act(async () => { root.render(<span>Recovery Shell</span>); });
  assert.equal(closes, 0, "the owning InstanceProvider decides when the desktop runtime closes");

  await act(async () => { root.unmount(); });
  assert.equal(closes, 0);
  container.remove();
});
