import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserApiTransport } from "./api-transport.js";

test("browser transports bind every request to one immutable instance origin", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let token = "first";
  const transport = createBrowserApiTransport({
    instanceId: "instance-a",
    origin: "https://a.example.test/",
    token: () => token,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });

  await transport.request("/api/sessions");
  token = "second";
  await transport.request("/api/runners");

  assert.equal(transport.publicOrigin, "https://a.example.test");
  assert.deepEqual(calls, [
    { url: "https://a.example.test/api/sessions", authorization: "Bearer first" },
    { url: "https://a.example.test/api/runners", authorization: "Bearer second" },
  ]);
  await assert.rejects(() => transport.request("//b.example.test/api/sessions"), /cannot select another origin|absolute paths/i);
});

test("closing a browser transport aborts in-flight work and rejects future requests", async () => {
  let requestSignal: AbortSignal | undefined;
  const transport = createBrowserApiTransport({
    instanceId: "instance-a",
    origin: "http://127.0.0.1:4317",
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    }) as typeof fetch,
  });

  const pending = transport.request("/api/sessions");
  transport.close();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.equal(requestSignal?.aborted, true);
  await assert.rejects(() => transport.request("/api/sessions"), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});

test("browser transports reject origins containing authority or route ambiguity", () => {
  for (const origin of [
    "ftp://host.example.test",
    ["https://user:", "secret@host.example.test"].join(""),
    "https://host.example.test/path",
    "https://host.example.test/?query=1",
    "https://host.example.test/#fragment",
    "https://host.example.test/?",
    "https://host.example.test/#",
  ]) {
    assert.throws(() => createBrowserApiTransport({ instanceId: "bad", origin }), TypeError, origin);
  }
});
