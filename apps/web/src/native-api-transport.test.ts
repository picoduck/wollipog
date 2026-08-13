import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createNativeApiTransport, NATIVE_API_METHODS, type NativeInvokeRuntime } from "./native-api-transport.js";

test("every explicit ApiClient method is supported by the native transport contract", () => {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  const methods = [...source.matchAll(/method:\s*"([A-Z]+)"/g)].map((match) => match[1]!);
  assert.ok(methods.length > 0, "the contract test must discover ApiClient methods");
  assert.deepEqual(
    [...new Set(methods)].filter((method) => !NATIVE_API_METHODS.has(method as never)),
    [],
  );
});

test("native API transport rejects unsupported methods before invoking Rust", async () => {
  let calls = 0;
  const desktop: NativeInvokeRuntime = {
    async invoke<T>(): Promise<T> { calls += 1; throw new Error("unexpected"); },
  };
  const transport = createNativeApiTransport({
    instanceId: "a",
    runtimeKey: "a:1",
    publicOrigin: "https://a.test",
    desktop,
  });
  await assert.rejects(() => transport.request("/api/sessions", { method: "HEAD" }), /does not support/);
  assert.equal(calls, 0);
});

function responseFrame(status: number, body: Uint8Array): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({
    status,
    statusText: status === 204 ? "No Content" : "OK",
    headers: [["content-type", "application/octet-stream"]],
    bodyLength: body.length,
  }));
  const frame = new Uint8Array(4 + meta.length + body.length);
  new DataView(frame.buffer).setUint32(0, meta.length, true);
  frame.set(meta, 4);
  frame.set(body, 4 + meta.length);
  return frame;
}

test("native API transport returns standard binary responses without exposing profile targets", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const desktop: NativeInvokeRuntime = {
    async invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> {
      calls.push({ command, args });
      return responseFrame(200, Uint8Array.from([0, 255])) as T;
    },
  };
  const transport = createNativeApiTransport({
    instanceId: "profile-a",
    runtimeKey: "profile-a:1",
    publicOrigin: "https://private.example.test",
    desktop,
  });
  const response = await transport.request("/api/artifacts/id/export", {
    headers: { authorization: "must-not-pass", accept: "application/octet-stream" },
  });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([0, 255]));
  assert.equal(calls[0]?.command, "remote_http_request");
  assert.ok(calls[0]?.args instanceof Uint8Array);
  const serialized = new TextDecoder().decode(calls[0]!.args as Uint8Array);
  assert.doesNotMatch(serialized, /private\.example|must-not-pass/);
});

test("native API transport constructs bodyless 204 responses and aborts on close", async () => {
  let resolve!: (value: Uint8Array) => void;
  let requests = 0;
  const desktop: NativeInvokeRuntime = {
    invoke<T>(command: string): Promise<T> {
      if (command === "remote_transport_close") return Promise.resolve(undefined as T);
      requests += 1;
      if (requests === 1) return Promise.resolve(responseFrame(204, new Uint8Array()) as T);
      return new Promise<Uint8Array>((done) => { resolve = done; }) as Promise<T>;
    },
  };
  const transport = createNativeApiTransport({
    instanceId: "a",
    runtimeKey: "a:1",
    publicOrigin: "https://a.test",
    desktop,
  });
  const empty = await transport.request("/api/sessions/empty");
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), "");
  const pending = transport.request("/api/sessions");
  await Promise.resolve();
  transport.close();
  resolve(responseFrame(200, new Uint8Array()));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  await assert.rejects(() => transport.request("/api/sessions"), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("native API transport cannot miss an abort that races IPC registration", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const desktop: NativeInvokeRuntime = {
    invoke<T>(command: string): Promise<T> {
      calls.push(command);
      if (command === "remote_http_request") {
        controller.abort();
        return new Promise<T>(() => {});
      }
      return Promise.resolve(undefined as T);
    },
  };
  const transport = createNativeApiTransport({
    instanceId: "a",
    runtimeKey: "a:1",
    publicOrigin: "https://a.test",
    desktop,
  });
  await assert.rejects(
    () => transport.request("/api/sessions", { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.deepEqual(calls, ["remote_http_request", "remote_http_cancel"]);
});
