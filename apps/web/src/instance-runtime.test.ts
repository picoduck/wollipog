import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserInstanceRuntime, createNativeInstanceRuntime } from "./instance-runtime.js";
import type { NativeUiChannel, NativeUiEvent } from "./native-ui-transport.js";
import type { UiSocket } from "./ui-transport.js";

interface TrackingSocket extends UiSocket {
  closeCount: number;
}

function inertSocket(): TrackingSocket {
  return {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    closeCount: 0,
    close() { this.closeCount += 1; },
  };
}

test("an instance runtime binds HTTP and WebSocket clients to one identity and credential source", async () => {
  const requests: string[] = [];
  const sockets: string[] = [];
  const runtime = createBrowserInstanceRuntime({
    instanceId: "instance-a",
    runtimeKey: "instance-a:1",
    httpOrigin: "https://instance-a.example.test",
    websocketOrigin: "wss://instance-a.example.test",
    token: () => "paired-secret",
    fetch: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    createWebSocket: (url) => {
      sockets.push(url);
      return inertSocket();
    },
  });

  await runtime.api.getIdentity();
  const socket = runtime.ui.createSocket();
  assert.equal(runtime.instanceId, "instance-a");
  assert.equal(runtime.ui.instanceId, "instance-a");
  assert.equal(runtime.publicOrigin, "https://instance-a.example.test");
  assert.deepEqual(requests, ["https://instance-a.example.test/api/identity"]);
  assert.deepEqual(sockets, ["wss://instance-a.example.test/ui?token=paired-secret"]);

  runtime.close();
  assert.equal((socket as TrackingSocket).closeCount, 1);
  await assert.rejects(() => runtime.api.getIdentity(), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
  await assert.rejects(async () => runtime.ui.createSocket(), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("a native instance runtime opens by profile identity and closes HTTP and UI ownership together", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const channels: NativeUiChannel<NativeUiEvent>[] = [];
  const desktop = {
    isTauri: () => true,
    async invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      calls.push({ command, args });
      if (command === "remote_transport_open") {
        return {
          profileId: "2a8887c1-4f50-4db5-b488-70791119bb7e",
          runtimeKey: "remote:1",
          publicOrigin: "https://remote.example.test",
        } as T;
      }
      return undefined as T;
    },
    channel<T>(): NativeUiChannel<T> {
      const channel = { onmessage: () => {} } as NativeUiChannel<T>;
      channels.push(channel as NativeUiChannel<NativeUiEvent>);
      return channel;
    },
  };
  const runtime = await createNativeInstanceRuntime({
    profileId: "2a8887c1-4f50-4db5-b488-70791119bb7e",
    desktop,
  });
  assert.equal(runtime.publicOrigin, "https://remote.example.test");
  runtime.ui.createSocket();
  await Promise.resolve();
  runtime.close();
  await Promise.resolve();
  assert.deepEqual(calls.map(({ command }) => command), [
    "remote_transport_open",
    "remote_ui_open",
    "remote_transport_close",
    "remote_ui_close",
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /pairing|secret|authorization/);
  assert.equal(channels.length, 1);
});
