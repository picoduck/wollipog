import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createApiClient } from "./api.js";
import {
  API_REQUEST_DEADLINE_MS,
  API_UPLOAD_FLOOR_BYTES_PER_SECOND,
  apiRequestDeadlineMs,
  createBrowserApiTransport,
  RequestTimeoutError,
  SESSION_RETITLE_DEADLINE_MS,
} from "./api-transport.js";

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

/** A fetch that never answers on its own and rejects with its signal's reason when aborted. */
function stalledFetch(seen: { signal?: AbortSignal; calls: number } = { calls: 0 }): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.calls += 1;
    seen.signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
}

/** Settles `promise` into an inspectable outcome without leaving a rejection unhandled. */
function outcome<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then((value) => { Object.assign(state, { settled: true, value }); },
    (error: unknown) => { Object.assign(state, { settled: true, error }); });
  return state;
}

// Body reads settle across I/O turns, which the mocked `setTimeout` does not affect.
const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

function withMockedTimeouts(body: () => Promise<void>) {
  return async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await body();
    } finally {
      mock.timers.reset();
    }
  };
}

test("a stalled mutation rejects at the default deadline with a timeout, not an abort", withMockedTimeouts(async () => {
  const seen: { signal?: AbortSignal; calls: number } = { calls: 0 };
  const transport = createBrowserApiTransport({ instanceId: "a", origin: "http://127.0.0.1:4317", fetch: stalledFetch(seen) });
  const pending = outcome(transport.request("/api/sessions/s_1/parent-control", { method: "PUT", body: "{}" }));

  mock.timers.tick(API_REQUEST_DEADLINE_MS - 1);
  await settle();
  assert.equal(pending.settled, false, "still pending just before the deadline");
  mock.timers.tick(1);
  await settle();
  assert.ok(pending.error instanceof RequestTimeoutError);
  assert.equal(pending.error.name, "TimeoutError", "an abort-ignoring caller still sees a failure");
  assert.notEqual(pending.error.name, "AbortError");
  assert.equal(pending.error.timeoutMs, API_REQUEST_DEADLINE_MS);
  assert.match(pending.error.message, /didn't answer within 45 seconds/);
  assert.equal(seen.signal?.aborted, true, "the fetch itself is abandoned");
  assert.equal(seen.signal?.reason, pending.error);
}));

test("a fetch that ignores its signal still fails at the deadline", withMockedTimeouts(async () => {
  const transport = createBrowserApiTransport({
    instanceId: "a",
    origin: "http://127.0.0.1:4317",
    fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
  });
  const pending = outcome(transport.request("/api/sessions"));
  mock.timers.tick(API_REQUEST_DEADLINE_MS);
  await settle();
  assert.ok(pending.error instanceof RequestTimeoutError);
}));

test("a fetch that answers its abort with a fresh AbortError still reports the timeout", withMockedTimeouts(async () => {
  const transport = createBrowserApiTransport({
    instanceId: "a",
    origin: "http://127.0.0.1:4317",
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    })) as typeof fetch,
  });
  const pending = outcome(transport.request("/api/sessions"));
  mock.timers.tick(API_REQUEST_DEADLINE_MS);
  await settle();
  assert.ok(pending.error instanceof RequestTimeoutError, "the timeout wins over the abort it causes");
}));

test("a caller's signal still aborts before the deadline, with the caller's reason", withMockedTimeouts(async () => {
  const transport = createBrowserApiTransport({ instanceId: "a", origin: "http://127.0.0.1:4317", fetch: stalledFetch() });
  const controller = new AbortController();
  const pending = outcome(transport.request("/api/sessions/s_1/campaign/work-items", { signal: controller.signal }));
  mock.timers.tick(1_000);
  controller.abort();
  await settle();
  assert.ok(pending.error instanceof DOMException);
  assert.equal(pending.error.name, "AbortError", "a cancellation stays a cancellation");
  // Its deadline was cleared with it: nothing fires later.
  mock.timers.tick(API_REQUEST_DEADLINE_MS);
  await settle();
  assert.equal((pending.error as DOMException).name, "AbortError");
}));

test("closing the connection still aborts in-flight requests before their deadline", withMockedTimeouts(async () => {
  const transport = createBrowserApiTransport({ instanceId: "a", origin: "http://127.0.0.1:4317", fetch: stalledFetch() });
  const pending = outcome(transport.request("/api/sessions"));
  transport.close();
  await settle();
  assert.ok(pending.error instanceof DOMException);
  assert.equal(pending.error.name, "AbortError");
}));

test("a response before the deadline clears its timer", withMockedTimeouts(async () => {
  let aborted: AbortSignal | undefined;
  const transport = createBrowserApiTransport({
    instanceId: "a",
    origin: "http://127.0.0.1:4317",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      aborted = init?.signal ?? undefined;
      return new Response("{}");
    }) as typeof fetch,
  });
  const response = await transport.request("/api/sessions");
  mock.timers.tick(API_REQUEST_DEADLINE_MS);
  assert.equal(response.status, 200);
  assert.equal(aborted?.aborted, false, "a late deadline never aborts a request that answered");
}));

test("the deadline table names retitle and the two exports, and bounds everything else", () => {
  assert.ok(API_REQUEST_DEADLINE_MS > 30_000, "outlasts the runner's 30s GIT_TIMEOUT_MS");
  assert.ok(API_REQUEST_DEADLINE_MS <= 60_000, "within the desktop transport's 60s total");
  assert.ok(SESSION_RETITLE_DEADLINE_MS > API_REQUEST_DEADLINE_MS);
  assert.ok(SESSION_RETITLE_DEADLINE_MS > 35_000, "outlasts the desktop's 35s session-naming read budget");
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/retitle"), SESSION_RETITLE_DEADLINE_MS);
  assert.equal(apiRequestDeadlineMs("post", "/api/sessions/s_1/retitle?source=command"), SESSION_RETITLE_DEADLINE_MS);
  assert.equal(apiRequestDeadlineMs("GET", "/api/sessions/s_1/export?format=json"), null);
  assert.equal(apiRequestDeadlineMs("GET", "/api/artifacts/a_1/export"), null);
  for (const [method, path] of [
    ["GET", "/api/sessions/s_1/retitle"],
    ["POST", "/api/sessions/s_1/retitle/extra"],
    ["POST", "/api/sessions/s_1/export"],
    ["GET", "/api/sessions/s_1"],
    ["POST", "/api/sessions/s_1/parent-control-policy"],
    ["GET", "/api/sessions/s_1/events?after=0&limit=200"],
    ["POST", "/api/runners/r_1/orphaned-skill-copies/preview"],
  ] as const) {
    assert.equal(apiRequestDeadlineMs(method, path), API_REQUEST_DEADLINE_MS, `${method} ${path}`);
  }
});

test("routes the server bounds past the default get that bound plus a margin, or none", () => {
  // Each server bound is the one the control plane applies to that route today.
  for (const [method, path, serverBoundMs] of [
    ["POST", "/api/sessions/s_1/git", 60_000],
    ["POST", "/api/sessions/s_1/authentication/account", 60_000],
    ["POST", "/api/usage/subscriptions/refresh", 60_000],
    ["POST", "/api/sessions/adopt", 45_000],
    ["POST", "/api/sessions/s_1/worktrees/select", 150_000],
    ["POST", "/api/sessions/s_1/worktrees/generate-setup", 150_000],
    ["GET", "/api/projects/p_1/locations/l_1/worktree-setup", 150_000],
    ["POST", "/api/projects/p_1/locations/l_1/worktree-setup", 150_000],
    ["POST", "/api/pods/pod_1/reconcile", 120_000],
    ["POST", "/api/skill-git/preview", 90_000],
  ] as const) {
    const deadline = apiRequestDeadlineMs(method, path);
    assert.ok(deadline !== null && deadline > serverBoundMs, `${method} ${path} outlasts its ${serverBoundMs}ms server bound`);
  }
  for (const [method, path] of [
    ["POST", "/api/sessions/s_1/fork"],
    ["POST", "/api/sessions/s_1/worktrees"],
    ["POST", "/api/sessions/s_1/worktrees/retry-setup"],
    ["POST", "/api/boxes/b_1/update-runner"],
    ["POST", "/api/runners/r_1/skills/sync"],
    ["POST", "/api/skill-machine/m_1/adopt"],
    ["POST", "/api/skill-drift/d_1/import"],
    ["POST", "/api/runners/r_1/skill-drift/restore"],
    ["POST", "/api/orphaned-skill-copies/o_1/import"],
    ["POST", "/api/runners/r_1/orphaned-skill-copies/discard"],
    ["GET", "/api/sessions/s_1/child-sessions?limit=50"],
  ] as const) {
    assert.equal(apiRequestDeadlineMs(method, path), null, `${method} ${path} is bounded in minutes or not at all`);
  }
});

test("a request body extends its deadline by its size at the upload floor", () => {
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/prompt", JSON.stringify({ text: "hi" })), API_REQUEST_DEADLINE_MS,
    "a small JSON body keeps the exact default");
  const image = new Uint8Array(8 * 1024 * 1024);
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/prompt-images", image), API_REQUEST_DEADLINE_MS + 128_000,
    "an 8 MB image gets 128s more at 64 KiB/s");
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/prompt-images", new Blob([image])), API_REQUEST_DEADLINE_MS + 128_000);
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/git", "x".repeat(API_UPLOAD_FLOOR_BYTES_PER_SECOND * 2)), 90_000 + 2_000);
  assert.equal(apiRequestDeadlineMs("POST", "/api/sessions/s_1/fork", image), null, "an opt-out stays opted out");
  assert.equal(apiRequestDeadlineMs("POST", "/api/skills", new FormData()), null, "a body of unknown size opts out");
});

/** A transport whose fetch answers `path` only after `delayMs`, under mocked timers. */
function slowTransport(delayMs: number, body: () => Response) {
  return createBrowserApiTransport({
    instanceId: "a",
    origin: "http://127.0.0.1:4317",
    fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      setTimeout(() => resolve(body()), delayMs);
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch,
  });
}

type Client = ReturnType<typeof createApiClient>;
const slowCases: Array<{
  name: string;
  delayMs: number;
  body: () => Response;
  call: (client: Client) => Promise<unknown>;
  expected: (value: unknown) => void | Promise<void>;
}> = [
  {
    name: "session retitle",
    delayMs: SESSION_RETITLE_DEADLINE_MS - 1,
    body: () => Response.json({ title: "Named Late" }),
    call: (client) => client.retitleSession("s_1"),
    expected: (value) => assert.deepEqual(value, { title: "Named Late" }),
  },
  {
    name: "transcript export",
    delayMs: API_REQUEST_DEADLINE_MS * 4,
    body: () => new Response("# Transcript"),
    call: (client) => client.transcriptExport("s_1", "markdown"),
    expected: async (value) => assert.equal(await (value as { blob: Blob }).blob.text(), "# Transcript"),
  },
  {
    name: "artifact export",
    delayMs: API_REQUEST_DEADLINE_MS * 4,
    body: () => new Response("artifact bytes"),
    call: (client) => client.artifactExport("a_1"),
    expected: async (value) => assert.equal(await (value as Blob).text(), "artifact bytes"),
  },
];

for (const { name, delayMs, body, call, expected } of slowCases) {
  test(`${name} slower than the default deadline still succeeds`, withMockedTimeouts(async () => {
    const client = createApiClient(slowTransport(delayMs, body));
    const pending = outcome(call(client));
    mock.timers.tick(API_REQUEST_DEADLINE_MS);
    await settle();
    assert.equal(pending.settled, false, "still waiting past the default deadline");
    mock.timers.tick(delayMs - API_REQUEST_DEADLINE_MS);
    await settle();
    assert.equal(pending.error, undefined);
    await expected(pending.value);
  }));
}
