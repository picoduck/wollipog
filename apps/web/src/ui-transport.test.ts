import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserUiConnection, type UiSocket } from "./ui-transport.js";

function inertSocket(): UiSocket {
  return {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send() {},
    close() {},
  };
}

test("browser UI connections snapshot a credential into each new socket URL", async () => {
  const urls: string[] = [];
  let token: string | null = "paired secret";
  const connection = createBrowserUiConnection({
    instanceId: "instance-a",
    runtimeKey: "instance-a:1",
    websocketOrigin: "wss://a.example.test/",
    token: () => token,
    createWebSocket: (url) => {
      urls.push(url);
      return inertSocket();
    },
  });

  connection.createSocket();
  token = null;
  connection.createSocket();
  assert.deepEqual(urls, ["wss://a.example.test/ui?token=paired%20secret", "wss://a.example.test/ui"]);
  connection.close();
  await assert.rejects(async () => connection.createSocket(), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("browser UI connections reject ambiguous origins", () => {
  for (const origin of [
    "https://a.example.test",
    "wss://user:secret@a.example.test",
    "wss://a.example.test/ui",
    "wss://a.example.test/?query=1",
    "wss://a.example.test/?",
    "wss://a.example.test/#",
  ]) {
    assert.throws(() => createBrowserUiConnection({
      instanceId: "bad",
      runtimeKey: "bad:0",
      websocketOrigin: origin,
    }), TypeError, origin);
  }
});

test("browser UI connections prune naturally closed sockets during repeated reconnects", () => {
  const sockets: UiSocket[] = [];
  const connection = createBrowserUiConnection({
    instanceId: "local",
    runtimeKey: "local:0",
    websocketOrigin: "ws://127.0.0.1:4317",
    createWebSocket: () => {
      const socket = inertSocket();
      sockets.push(socket);
      return socket;
    },
  });
  for (let index = 0; index < 100; index += 1) {
    const previous = sockets.at(-1);
    if (previous) Object.defineProperty(previous, "readyState", { value: 3 });
    connection.createSocket();
  }
  connection.close();
  assert.equal(sockets.filter((socket) => socket.readyState !== 3).length, 1);
});
