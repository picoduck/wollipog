import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.js";

const reference = {
  artifactId: "art_image",
  mimeType: "image/png",
  sizeBytes: 8,
  sha256: "a".repeat(64),
};

test("web uploads raw image bytes before sending a metadata-only prompt", async () => {
  const prior = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) return new Response(JSON.stringify(reference), {
      status: 201, headers: { "content-type": "application/json" },
    });
    return new Response(JSON.stringify({ id: "s1" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await api.prompt("s1", "inspect", [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    assert.match(calls[0]!.url, /\/api\/sessions\/s1\/prompt-images$/);
    assert.equal((calls[0]!.init?.headers as Record<string, string>)["content-type"], "image/png");
    assert.deepEqual(Buffer.from(calls[0]!.init?.body as Uint8Array), Buffer.from("iVBORw0KGgo=", "base64"));
    const promptBody = String(calls[1]!.init?.body);
    assert.deepEqual(JSON.parse(promptBody).images, [reference]);
    assert.equal(promptBody.includes("iVBORw0KGgo="), false);

    calls.length = 0;
    await api.prompt("s1", "reuse", [reference]);
    assert.equal(calls.length, 1, "an existing reference must not upload again");
    assert.match(calls[0]!.url, /\/prompt$/);
  } finally {
    globalThis.fetch = prior;
  }
});

test("web externalizes direct steering images while promotions remain metadata-only", async () => {
  const prior = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/prompt-images")) {
      return new Response(JSON.stringify(reference), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      submissionId: "submission-1",
      turnId: "turn-1",
      source: "direct",
      text: "Inspect",
      state: "accepted",
      createdAt: 1,
      updatedAt: 1,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await api.steer("s1", {
      submissionId: "submission-1",
      turnId: "turn-1",
      text: "Inspect",
      images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }],
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/api\/sessions\/s1\/prompt-images$/);
    const steerBody = String(calls[1]!.init?.body);
    assert.match(calls[1]!.url, /\/api\/sessions\/s1\/steer$/);
    assert.deepEqual(JSON.parse(steerBody).images, [reference]);
    assert.equal(steerBody.includes("iVBORw0KGgo="), false);

    calls.length = 0;
    await api.steer("s1", {
      submissionId: "submission-2",
      turnId: "turn-1",
      promotePromptId: "queue-1",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      submissionId: "submission-2",
      turnId: "turn-1",
      promotePromptId: "queue-1",
    });
  } finally {
    globalThis.fetch = prior;
  }
});
