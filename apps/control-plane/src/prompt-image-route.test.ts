import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { MAX_PROMPT_IMAGE_BYTES } from "@wollipog/protocol";
import { registerPromptImageRoutes } from "./prompt-image-route.js";

const principal = { kind: "human", userId: "u1", actorId: "u1", organizationId: "o1", role: "viewer" } as never;

test("raw prompt-image route authorizes before parsing and returns metadata only", async () => {
  const app = Fastify();
  let allowed = false;
  const uploads: Buffer[] = [];
  const reference = { artifactId: "art1", mimeType: "image/png", sizeBytes: 8, sha256: "a".repeat(64) };
  const db = {
    canAccessSession: () => allowed,
    verifyActiveRunnerCredential: () => false,
    getSession: () => null,
  } as never;
  registerPromptImageRoutes(app, {
    db,
    service: {
      createPromptImageArtifact: (_id, _mime, bytes) => {
        uploads.push(Buffer.from(bytes));
        return { ok: true, status: 201, data: reference };
      },
    },
    requestPrincipal: () => principal,
    actor: () => ({ kind: "human", id: "u1" }),
  });
  try {
    const denied = await app.inject({
      method: "POST", url: "/api/sessions/s1/prompt-images",
      headers: { "content-type": "image/png" }, payload: Buffer.alloc(MAX_PROMPT_IMAGE_BYTES + 1),
    });
    assert.equal(denied.statusCode, 404, "membership denial must win before the body-size parser");
    assert.equal(uploads.length, 0);

    allowed = true;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await app.inject({
      method: "POST", url: "/api/sessions/s1/prompt-images",
      headers: { "content-type": "image/png" }, payload: png,
    });
    assert.equal(uploaded.statusCode, 201);
    assert.deepEqual(uploads, [png]);
    assert.deepEqual(uploaded.json(), reference);
    assert.equal(uploaded.headers["cache-control"], "private, no-store");
    assert.equal(uploaded.body.includes("iVBOR"), false);
  } finally {
    await app.close();
  }
});

test("runner prompt-image route returns exact bytes with hardened headers", async () => {
  const app = Fastify();
  const bytes = Buffer.from([1, 2, 3, 4]);
  const db = {
    canAccessSession: () => false,
    verifyActiveRunnerCredential: (_runner: string, hash: string) => hash.length === 64,
    getSession: () => ({ id: "s1", runnerId: "r1", runId: null }),
    workflowArtifactExportPreflight: () => ({
      artifact: {
        artifactId: "art1", sessionId: "s1", kind: "screenshot", encoding: "base64",
        mimeType: "image/png", name: "image", sizeBytes: bytes.length, sha256: "a".repeat(64),
        createdBy: { kind: "system" }, createdAt: 1,
      }, storedDataBytes: bytes.length,
    }),
    readWorkflowArtifactBytes: () => bytes,
  } as never;
  registerPromptImageRoutes(app, {
    db,
    service: { createPromptImageArtifact: () => ({ ok: false, status: 500, error: "unused" }) },
    requestPrincipal: () => null,
    actor: () => ({ kind: "system" }),
  });
  try {
    const response = await app.inject({
      method: "GET", url: "/runner/r1/sessions/s1/artifacts/art1",
      headers: { authorization: "Bearer exact-runner-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, bytes);
    assert.equal(response.headers["content-length"], String(bytes.length));
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  } finally {
    await app.close();
  }
});
