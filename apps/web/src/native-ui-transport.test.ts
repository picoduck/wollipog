import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeUiConnection, type NativeUiChannel, type NativeUiEvent, type NativeUiRuntime } from "./native-ui-transport.js";

function harness(options: { failOpen?: boolean } = {}) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const channels: NativeUiChannel<NativeUiEvent>[] = [];
  const desktop: NativeUiRuntime = {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args });
      return command === "remote_ui_open" && options.failOpen
        ? Promise.reject(new Error("failed"))
        : Promise.resolve(undefined as T);
    },
    channel<T>(): NativeUiChannel<T> {
      const channel = { onmessage: () => {} } as NativeUiChannel<T>;
      channels.push(channel as NativeUiChannel<NativeUiEvent>);
      return channel;
    },
  };
  return { calls, channels, desktop };
}

test("native UI sockets buffer early events, send only after open, and preserve close 1008", async () => {
  const { calls, channels, desktop } = harness();
  const connection = createNativeUiConnection({ instanceId: "profile-a", runtimeKey: "profile-a:1", desktop });
  const socket = connection.createSocket();
  const events: string[] = [];
  channels[0]!.onmessage({ type: "open" });
  socket.onopen = () => events.push("open");
  socket.onmessage = ({ data }) => events.push(data);
  socket.onclose = ({ code }) => events.push(`close:${code}`);
  await Promise.resolve();
  assert.deepEqual(events, ["open"]);
  socket.send("hello");
  channels[0]!.onmessage({ type: "message", data: "world" });
  channels[0]!.onmessage({ type: "close", code: 1008 });
  assert.deepEqual(events, ["open", "world", "close:1008"]);
  assert.deepEqual(calls.map(({ command }) => command), ["remote_ui_open", "remote_ui_send"]);
  assert.doesNotMatch(JSON.stringify(calls), /token|https?:\/\//);
});

test("native UI open rejection fails once and closed runtimes reject new sockets", async () => {
  const { desktop } = harness({ failOpen: true });
  const connection = createNativeUiConnection({ instanceId: "a", runtimeKey: "a:1", desktop });
  const socket = connection.createSocket();
  const events: string[] = [];
  socket.onerror = () => events.push("error");
  socket.onclose = ({ code }) => events.push(`close:${code}`);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["error", "close:1006"]);
  connection.close();
  assert.throws(() => connection.createSocket(), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("late native events cannot revive a closed synthetic socket", async () => {
  const { channels, desktop } = harness();
  const connection = createNativeUiConnection({ instanceId: "a", runtimeKey: "a:1", desktop });
  const socket = connection.createSocket();
  let messages = 0;
  socket.onmessage = () => { messages += 1; };
  await Promise.resolve();
  connection.close();
  channels[0]!.onmessage({ type: "open" });
  channels[0]!.onmessage({ type: "message", data: "late" });
  assert.equal(messages, 0);
});

test("closing during native open waits until the backend has reserved the socket", async () => {
  const calls: string[] = [];
  let acceptOpen!: () => void;
  const desktop: NativeUiRuntime = {
    invoke<T>(command: string): Promise<T> {
      calls.push(command);
      if (command === "remote_ui_open") {
        return new Promise<void>((resolve) => { acceptOpen = resolve; }) as Promise<T>;
      }
      return Promise.resolve(undefined as T);
    },
    channel<T>(): NativeUiChannel<T> {
      return { onmessage: () => {} };
    },
  };
  const connection = createNativeUiConnection({ instanceId: "a", runtimeKey: "a:1", desktop });
  connection.createSocket().close();
  assert.deepEqual(calls, ["remote_ui_open"]);
  acceptOpen();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["remote_ui_open", "remote_ui_close"]);
});
