import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RunnerSessionNamingCustomModel,
  sessionNamingCustomModelDigest,
} from "./session-naming-custom-model.js";

async function endpoint(
  handler: Parameters<typeof createServer>[0],
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("runner-local custom model stores the key separately, survives restart, and deletes only the key", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-naming-secret-"));
  try {
    const store = new RunnerSessionNamingCustomModel(root);
    const config = { endpoint: "https://models.example/v1/chat/completions", model: "title-model", timeoutMs: 900 };
    const status = store.configure(config, "secret-key-sentinel");
    assert.deepEqual(status, {
      configured: true,
      apiKeyConfigured: true,
      configDigest: sessionNamingCustomModelDigest(config),
    });
    assert.doesNotMatch(readFileSync(join(root, "custom-model.json"), "utf8"), /secret-key-sentinel/);
    assert.equal(readFileSync(join(root, "custom-model.key"), "utf8"), "secret-key-sentinel");
    if (process.platform !== "win32") {
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "custom-model.key")).mode & 0o777, 0o600);
    }
    assert.deepEqual(new RunnerSessionNamingCustomModel(root).status(), status, "restart re-reads protected state");
    assert.deepEqual(store.deleteApiKey(), {
      configured: true,
      apiKeyConfigured: false,
      configDigest: status.configDigest,
    });
    assert.equal(readFileSync(join(root, "custom-model.json"), "utf8").includes("title-model"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom model validation rejects credential-bearing URLs, unsafe keys, and symlink replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-naming-validation-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "wollipog-naming-outside-"));
  const outside = join(outsideRoot, "target");
  try {
    const store = new RunnerSessionNamingCustomModel(root);
    assert.throws(() => store.configure({
      endpoint: "https://models.example/v1?api_key=secret",
      model: "title-model",
      timeoutMs: 500,
    }), /invalid_configuration/);
    assert.throws(() => store.configure({
      endpoint: "https://models.example/v1",
      model: "title-model",
      timeoutMs: 500,
    }, "bad\nheader"), /invalid_configuration/);
    assert.throws(() => store.configure({
      endpoint: "http://models.example/v1",
      model: "title-model",
      timeoutMs: 500,
    }, "plaintext-bearer"), /invalid_configuration/);
    assert.equal(store.status().configured, false, "invalid key does not publish configuration first");

    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "custom-model.json"));
    assert.throws(() => store.configure({
      endpoint: "https://models.example/v1",
      model: "title-model",
      timeoutMs: 500,
    }), /symlinked/);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally {
    chmodSync(root, 0o700);
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("custom model generation sends the key only as authorization and returns a normalized bounded title", async () => {
  let authorization = "";
  let requestText = "";
  const remote = await endpoint((request, response) => {
    authorization = String(request.headers.authorization ?? "");
    request.setEncoding("utf8");
    request.on("data", (chunk) => { requestText += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "  Secure Runner Naming  " } }] }));
    });
  });
  const root = await mkdtemp(join(tmpdir(), "wollipog-naming-fetch-"));
  try {
    const store = new RunnerSessionNamingCustomModel(root);
    store.configure({ endpoint: remote.url, model: "title-model", timeoutMs: 1_000 }, "bearer-sentinel");
    const result = await store.generateResult({
      type: "generate_session_title",
      requestId: "request-1",
      sessionId: "session-1",
      mode: "custom_model_endpoint",
      messages: [{ role: "user", text: "Fix the runner" }],
      timeoutMs: 1_000,
    });
    assert.deepEqual(result, {
      type: "generate_session_title_result",
      requestId: "request-1",
      ok: true,
      title: "Secure Runner Naming",
      provider: "custom",
      billingSource: "api",
    });
    assert.equal(authorization, "Bearer bearer-sentinel");
    assert.doesNotMatch(requestText, /bearer-sentinel/);
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("custom model test classifies authentication failure without returning provider text", async () => {
  const remote = await endpoint((_request, response) => {
    response.statusCode = 401;
    response.end("provider-secret-diagnostic");
  });
  const root = await mkdtemp(join(tmpdir(), "wollipog-naming-auth-"));
  try {
    const store = new RunnerSessionNamingCustomModel(root);
    store.configure({ endpoint: remote.url, model: "title-model", timeoutMs: 1_000 }, "key");
    assert.deepEqual(await store.testResult("test-1"), {
      type: "session_naming_custom_model_result",
      requestId: "test-1",
      operation: "test",
      ok: false,
      code: "authentication_failed",
    });
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("custom model naming admits at most two concurrent requests", async () => {
  const responses: Array<import("node:http").ServerResponse> = [];
  const remote = await endpoint((_request, response) => {
    responses.push(response);
  });
  const root = await mkdtemp(join(tmpdir(), "wollipog-naming-admission-"));
  try {
    const store = new RunnerSessionNamingCustomModel(root);
    store.configure({ endpoint: remote.url, model: "title-model", timeoutMs: 1_000 });
    const message = (requestId: string) => ({
      type: "generate_session_title" as const,
      requestId,
      sessionId: "session-1",
      mode: "custom_model_endpoint" as const,
      messages: [{ role: "user" as const, text: "Name this" }],
      timeoutMs: 1_000,
    });
    const first = store.generateResult(message("one"));
    const second = store.generateResult(message("two"));
    await new Promise<void>((resolve) => {
      const check = () => responses.length === 2 ? resolve() : setTimeout(check, 5);
      check();
    });
    assert.deepEqual(await store.generateResult(message("three")), {
      type: "generate_session_title_result",
      requestId: "three",
      ok: false,
      code: "rate_limited",
    });
    for (const response of responses) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "Bounded Naming" } }] }));
    }
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
  } finally {
    await remote.close();
    await rm(root, { recursive: true, force: true });
  }
});
