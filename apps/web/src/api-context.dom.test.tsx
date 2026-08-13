import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createApiClient } from "./api.js";
import { ApiProvider, useApi } from "./api-context.js";
import type { ApiTransport } from "./api-transport.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function transport(instanceId: string, calls: string[]): ApiTransport {
  return {
    instanceId,
    publicOrigin: `http://${instanceId}.localhost`,
    close() {},
    async request(path) {
      calls.push(path);
      return new Response(JSON.stringify({
        identity: {
          organizationId: instanceId,
          organizationName: instanceId,
          role: "admin",
          userId: `${instanceId}-user`,
          displayName: instanceId,
          status: "active",
          managedBy: "local",
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

function IdentityConsumer() {
  const api = useApi();
  return <button onClick={() => void api.getIdentity()}>Load Identity</button>;
}

test("a rendered consumer uses only the replacement provider client after a switch", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const callsA: string[] = [];
  const callsB: string[] = [];
  const clientA = createApiClient(transport("instance-a", callsA));
  const clientB = createApiClient(transport("instance-b", callsB));

  await act(async () => {
    root.render(<ApiProvider client={clientA}><IdentityConsumer /></ApiProvider>);
  });
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  assert.deepEqual(callsA, ["/api/identity"]);

  await act(async () => {
    root.render(<ApiProvider client={clientB}><IdentityConsumer /></ApiProvider>);
  });
  await act(async () => {
    (container.querySelector("button") as HTMLButtonElement).click();
  });
  assert.deepEqual(callsA, ["/api/identity"], "the retired client receives no call after switching");
  assert.deepEqual(callsB, ["/api/identity"], "the logical resource path is unchanged on the new client");

  await act(async () => { root.unmount(); });
  container.remove();
});
