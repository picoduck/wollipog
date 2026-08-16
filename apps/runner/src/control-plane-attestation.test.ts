import assert from "node:assert/strict";
import { test } from "node:test";
import { WOLLIPOG_CONTROL_PLANE_SERVICE } from "@wollipog/protocol";
import {
  attestRunnerControlPlane,
  ControlPlaneAttestationError,
  waitForRunnerControlPlaneAttestation,
} from "./control-plane-attestation.js";

const INSTANCE_ID = "8ded292f-18b6-4d36-a82f-f506ad207f2f";
const valid = { service: WOLLIPOG_CONTROL_PLANE_SERVICE, instanceId: INSTANCE_ID, protocolVersion: 77 };

test("runner attestation sends the credential only in Authorization and validates identity", async () => {
  let requested = "";
  let authorization = "";
  let priorHash = "";
  const result = await attestRunnerControlPlane({
    controlPlaneUrl: "wss://manager.example.test/prefix/runner?transport=websocket#local-only",
    runnerId: "runner-α",
    token: "top-secret",
    priorCredentialHash: "a".repeat(64),
    fetchImpl: (async (input, init) => {
      requested = String(input);
      authorization = (init?.headers as Record<string, string>).authorization;
      priorHash = (init?.headers as Record<string, string>)["x-wollipog-prior-runner-credential-sha256"];
      return new Response(JSON.stringify(valid), { headers: { "content-length": "107" } });
    }) as typeof fetch,
  });
  assert.deepEqual(result, valid);
  assert.equal(
    requested,
    "https://manager.example.test/prefix/runner/attestation/runner-%CE%B1?transport=websocket",
  );
  assert.equal(requested.includes("top-secret"), false);
  assert.equal(authorization, "Bearer top-secret");
  assert.equal(priorHash, "a".repeat(64));
  assert.equal(JSON.stringify((result)).includes("top-secret"), false);
});

test("runner attestation never retries deterministic URL or header configuration errors", async () => {
  for (const options of [
    { controlPlaneUrl: "not a URL", runnerId: "runner-one", token: "token", priorCredentialHash: undefined },
    { controlPlaneUrl: "https://manager.example.test/runner", runnerId: "runner-one", token: "token", priorCredentialHash: undefined },
    { controlPlaneUrl: "ws://user:password@manager.example.test/runner", runnerId: "runner-one", token: "token", priorCredentialHash: undefined },
    { controlPlaneUrl: "ws://manager.example.test/runner", runnerId: "runner/one", token: "token", priorCredentialHash: undefined },
    { controlPlaneUrl: "ws://manager.example.test/runner", runnerId: "..", token: "token", priorCredentialHash: undefined },
    { controlPlaneUrl: "ws://manager.example.test/runner", runnerId: "runner-one", token: "line\nbreak", priorCredentialHash: undefined },
    { controlPlaneUrl: "ws://manager.example.test/runner", runnerId: "runner-one", token: "token", priorCredentialHash: "not-sha256" },
  ]) {
    let fetched = false;
    await assert.rejects(
      () => waitForRunnerControlPlaneAttestation({
        ...options,
        fetchImpl: (async () => {
          fetched = true;
          return new Response(JSON.stringify(valid));
        }) as typeof fetch,
        wait: async () => assert.fail("deterministic configuration errors must not retry"),
      }),
      (error) => error instanceof ControlPlaneAttestationError && !error.retryable,
    );
    assert.equal(fetched, false);
  }
});

test("runner attestation retries transient failures but rejects credentials permanently", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await waitForRunnerControlPlaneAttestation({
    controlPlaneUrl: "ws://localhost:4317/runner",
    runnerId: "runner-one",
    token: "token",
    fetchImpl: (async () => {
      calls++;
      return calls === 1 ? new Response("busy", { status: 429 })
        : calls === 2 ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify(valid));
    }) as typeof fetch,
    wait: async (delay) => { delays.push(delay); },
  });
  assert.deepEqual(result, valid);
  assert.deepEqual(delays, [1_000, 2_000]);

  await assert.rejects(
    () => waitForRunnerControlPlaneAttestation({
      controlPlaneUrl: "ws://localhost:4317/runner",
      runnerId: "runner-one",
      token: "wrong",
      fetchImpl: (async () => new Response("no", { status: 401 })) as typeof fetch,
      wait: async () => assert.fail("permanent auth failure must not retry"),
    }),
    (error) => error instanceof ControlPlaneAttestationError && !error.retryable,
  );
});

test("runner attestation retries a transient response-body failure", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await waitForRunnerControlPlaneAttestation({
    controlPlaneUrl: "ws://localhost:4317/runner",
    runnerId: "runner-one",
    token: "token",
    fetchImpl: (async () => {
      calls++;
      if (calls > 1) return new Response(JSON.stringify(valid));
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new TypeError("terminated")); },
      }));
    }) as typeof fetch,
    wait: async (delay) => { delays.push(delay); },
  });
  assert.deepEqual(result, valid);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
});

test("runner attestation fails closed on malformed or oversized identity", async () => {
  await assert.rejects(() => attestRunnerControlPlane({
    controlPlaneUrl: "ws://localhost/runner", runnerId: "r", token: "t",
    fetchImpl: (async () => new Response(JSON.stringify({ ...valid, instanceId: "not-a-uuid" }))) as typeof fetch,
  }), /invalid identity/);
  await assert.rejects(() => attestRunnerControlPlane({
    controlPlaneUrl: "ws://localhost/runner", runnerId: "r", token: "t",
    fetchImpl: (async () => new Response("{}", { headers: { "content-length": "4097" } })) as typeof fetch,
  }), /too large/);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3_000));
      controller.enqueue(new Uint8Array(3_000));
      controller.close();
    },
  });
  await assert.rejects(() => attestRunnerControlPlane({
    controlPlaneUrl: "ws://localhost/runner", runnerId: "r", token: "t",
    fetchImpl: (async () => new Response(oversized)) as typeof fetch,
  }), /too large/);
  const oversizedWithBrokenCancel = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3_000));
      controller.enqueue(new Uint8Array(3_000));
    },
    cancel() { throw new Error("cancel failed"); },
  });
  await assert.rejects(() => attestRunnerControlPlane({
    controlPlaneUrl: "ws://localhost/runner", runnerId: "r", token: "t",
    fetchImpl: (async () => new Response(oversizedWithBrokenCancel)) as typeof fetch,
  }), (error) => {
    assert.equal(error instanceof ControlPlaneAttestationError, true);
    assert.equal((error as ControlPlaneAttestationError).retryable, false);
    assert.match((error as Error).message, /too large/);
    return true;
  });
});
