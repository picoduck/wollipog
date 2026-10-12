import assert from "node:assert/strict";
import { test } from "node:test";
import type { PacedVideoTransportGrant } from "@wollipog/protocol";
import { scopedVideoReviewTools, findScopedVideoReviewTool } from "./video-evidence-review-mcp.js";
import type { VideoReviewTransport } from "./video-evidence-review-transport.js";

/** Registry/credential guard tests only; no actual Session, model or image handoff. */
test("media MCP discovery and dispatch exclude generic files, management, uploads and code-review jobs", () => {
  const transport: VideoReviewTransport = {
    grant: { reviewerSessionId: "actual-media-session" } as PacedVideoTransportGrant,
    request: async () => { throw new Error("No transport should be called."); }, now: () => 1_000,
  };
  const tools = scopedVideoReviewTools({ transport, actualSessionId: "actual-media-session", current: () => false });
  assert.deepEqual(tools.map((tool) => tool.name), ["review_video_evidence_frame", "submit_video_evidence_verdict"]);
  for (const name of ["Read", "Bash", "get_session", "attach_session_artifact", "run_campaign_review_job", "fetch_url"]) {
    assert.equal(findScopedVideoReviewTool(tools, name), null);
  }
  assert.equal(findScopedVideoReviewTool([...tools, { ...tools[0]!, name: "Read" }], tools[0]!.name), null);
});
test("changed current admission and a code-job identity cannot borrow the actual media Session's tool grant", async () => {
  let requests = 0;
  const transport: VideoReviewTransport = {
    grant: { reviewerSessionId: "media-session" } as PacedVideoTransportGrant,
    request: async () => { requests++; throw new Error("No actual model or media."); }, now: () => 1_000,
  };
  for (const [actualSessionId, current] of [["media-session", false], ["review_code_job", true], ["implementer", true]] as const) {
    const tools = scopedVideoReviewTools({ transport, actualSessionId, current: () => current });
    for (const tool of tools) {
      const result = await tool.handler({ index: 0, report: { outcome: "accept" } });
      assert.equal(result.isError, true);
    }
  }
  assert.equal(requests, 0);
});


import { PassThrough } from "node:stream";
import { dispatchScopedVideoReviewRpc, serveScopedVideoReviewMcp } from "./video-evidence-review-mcp.js";

test("scoped JSON-RPC advertises only media tools and refuses filesystem resources, manager APIs and caller-selected URLs", async () => {
  const transport: VideoReviewTransport = { grant: { reviewerSessionId: "media" } as PacedVideoTransportGrant,
    request: async () => { assert.fail("No resource or manager transport is allowed"); }, now: () => 1 };
  const tools = scopedVideoReviewTools({ transport, actualSessionId: "media", current: () => false });
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });
  const initialized = await dispatchScopedVideoReviewRpc(rpc("initialize"), tools);
  assert.deepEqual((initialized?.result as { capabilities: unknown }).capabilities, { tools: {} });
  const listed = await dispatchScopedVideoReviewRpc(rpc("tools/list"), tools);
  assert.equal((listed?.result as { tools: unknown[] }).tools.length, 2);
  for (const method of ["resources/read", "resources/list", "prompts/list", "get_session", "fetch_url"]) {
    const denied = await dispatchScopedVideoReviewRpc(rpc(method, { uri: "PRIVATE_URL_SENTINEL" }), tools);
    assert.equal(denied?.error?.code, -32601);
    assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_URL_SENTINEL/);
  }
  const denied = await dispatchScopedVideoReviewRpc(rpc("tools/call", { name: "Read", arguments: { path: "PRIVATE_PATH_SENTINEL" } }), tools);
  assert.equal((denied?.result as { isError: boolean }).isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /PRIVATE_PATH_SENTINEL/);
});

test("scoped RPC never serializes internal exceptions, namespace secrets or untrusted registry handlers", async () => {
  const transport: VideoReviewTransport = { grant: { reviewerSessionId: "media" } as PacedVideoTransportGrant,
    request: async () => { throw new Error("PRIVATE_TOKEN_SENTINEL"); }, now: () => 1 };
  const tools = scopedVideoReviewTools({ transport, actualSessionId: "media", current: () => { throw new Error("PRIVATE_ROOT_SENTINEL"); } });
  const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tools[0]!.name, arguments: { index: 0 } } };
  const result = await dispatchScopedVideoReviewRpc(request, tools);
  assert.equal((result?.result as { isError: boolean }).isError, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal((await dispatchScopedVideoReviewRpc(request, [...tools, { ...tools[0]!, name: "Read" }]))?.error?.code, -32600);
});

test("actual stdio endpoint serializes media calls and drains the final request after input EOF", async (t) => {
  const input = new PassThrough(), output = new PassThrough();
  t.after(() => { input.destroy(); output.destroy(); });
  let release!: () => void; const waiting = new Promise<void>((r) => { release = r; });
  let requests = 0;
  const grant = { reviewerSessionId: "media", expiresAt: 10_000, sourceSha256: "a".repeat(64),
    manifestSha256: "a".repeat(64), bindingSha256: "a".repeat(64), criteriaSha256: "a".repeat(64),
    frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: "a".repeat(64), sizeBytes: 1 }] } as PacedVideoTransportGrant;
  const transport: VideoReviewTransport = { grant, now: () => 1,
    request: async () => { requests++; await waiting; throw new Error("PRIVATE_NETWORK_SENTINEL"); } };
  const responses: Array<{ id: number; result: { isError: boolean; content: Array<{ text: string }> } }> = [];
  let received = ""; output.setEncoding("utf8");
  output.on("data", (chunk: string) => { received += chunk; });
  serveScopedVideoReviewMcp(input, output, { transport, actualSessionId: "media", current: () => true });
  const call = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "review_video_evidence_frame", arguments: { index: 0 } } }) + "\n";
  input.write(call(1) + call(2)); input.end();
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(requests, 1);
  release();
  await new Promise<void>((r) => setImmediate(r));
  responses.push(...received.trim().split("\n").map((line) => JSON.parse(line)));
  assert.equal(responses.length, 2);
  assert.ok(responses.find((r) => r.id === 2)?.result.content[0]?.text.includes("pending"));
  assert.equal(responses.find((r) => r.id === 1)?.result.isError, true);
  assert.doesNotMatch(received, /PRIVATE_NETWORK_SENTINEL/);
});

test("unterminated oversized UTF-8 request closes the media endpoint before parsing or retrieving any media", () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport: VideoReviewTransport = { grant: { reviewerSessionId: "media" } as PacedVideoTransportGrant,
    request: async () => { assert.fail("Oversized input must never retrieve media"); }, now: () => 1 };
  serveScopedVideoReviewMcp(input, output, { transport, actualSessionId: "media", current: () => true });
  input.write("😀".repeat(131_073));
  assert.equal(input.destroyed, true);
  output.destroy();
});

test("media admission remains busy while the model-facing output is backpressured", async (t) => {
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
  t.after(() => { input.destroy(); output.destroy(); });
  let requests = 0;
  const transport: VideoReviewTransport = { now: () => 1,
    grant: { reviewerSessionId: "media", expiresAt: 10_000, sourceSha256: "a".repeat(64),
      manifestSha256: "a".repeat(64), bindingSha256: "a".repeat(64), criteriaSha256: "a".repeat(64),
      frames: [{ index: 0, ptsUs: 0, durationUs: 33_333, sha256: "a".repeat(64), sizeBytes: 1 }] } as PacedVideoTransportGrant,
    request: async () => { requests++; throw new Error("No actual media in this endpoint test."); } };
  serveScopedVideoReviewMcp(input, output, { transport, actualSessionId: "media", current: () => true });
  const call = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name: "review_video_evidence_frame", arguments: { index: 0 } } }) + "\n";
  input.write(call(1));
  await new Promise<void>((r) => setImmediate(r));
  input.write(call(2));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(requests, 1, "the second media request cannot race a response stalled at the provider");
  let received = ""; output.setEncoding("utf8"); output.on("data", (chunk: string) => { received += chunk; });
  await new Promise<void>((r) => setImmediate(r));
  const replies = received.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.match(replies.find((reply) => reply.id === 2).result.content[0].text, /pending/);
});
