import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import {
  dispatch,
  nextWaitSessionIntervalMs,
  serveSessionManagementMcp,
  SPAWN_APPROVAL_POLL_WINDOW_MS,
  TOOLS,
  type McpDeps,
  type McpFetch,
} from "./session-management-mcp.js";

/* -------------------------------------------------------------------------- */
/* Fixtures: an injected fetch stub recording every request                    */
/* -------------------------------------------------------------------------- */

const CP_URL = "http://127.0.0.1:4317";
const SELF_ID = "s_self";
const TOKEN = "tok-secret-123";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

type StubHandler = (call: RecordedCall) => { status: number; body: unknown };

function makeDeps(handler?: StubHandler, token = TOKEN): { deps: McpDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchStub: McpFetch = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body != null ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    const res = handler ? handler(call) : { status: 200, body: {} };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => JSON.stringify(res.body),
    };
  };
  return { deps: { fetch: fetchStub, cpUrl: CP_URL, selfSessionId: SELF_ID, token }, calls };
}

/** tools/call through the real dispatch; returns the TOOL result ({content, isError?}). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(deps: McpDeps, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await dispatch({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, deps);
  assert.ok(res && res.result, `tools/call ${name} should produce a result`);
  return res.result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resultJson(result: any): any {
  return JSON.parse(result.content[0].text);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resultText(result: any): string {
  return result.content.map((c: { text: string }) => c.text).join("\n");
}

test("orchestrator MCP lists only management tools and leaves self-worktree policy to the control plane", async () => {
  const { deps, calls } = makeDeps();
  deps.orchestrator = true;
  const response = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" }, deps);
  const names = (response!.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  assert.ok(names.includes("create_session"));
  assert.ok(names.includes("list_governance_policies"));
  for (const name of [
    "get_campaign", "record_campaign_follow_up", "verify_campaign_child",
    "list_descendant_requests", "answer_descendant_question", "dismiss_descendant_question",
    "resolve_descendant_approval", "resolve_descendant_workflow_decision", "review_descendant_ui_evidence",
  ]) assert.ok(names.includes(name), name);
  for (const name of ["create_run", "set_session_config", "upsert_governance_policy", "create_workflow"]) {
    assert.equal(names.includes(name), false);
    assert.equal((await callTool(deps, name)).isError, true);
  }
  assert.equal(calls.length, 0);
  assert.equal((await callTool(deps, "create_worktree", { sessionId: SELF_ID, branch: "fix/self" })).isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/${SELF_ID}/worktrees`);
});

test("Parent Control tools are orchestrator-only and bind resolutions to exact occurrences", async () => {
  const ordinary = makeDeps();
  const ordinaryList = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ordinary.deps);
  const ordinaryNames = (ordinaryList!.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  assert.equal(ordinaryNames.includes("list_descendant_requests"), false);
  assert.equal((await callTool(ordinary.deps, "list_descendant_requests")).isError, true);
  assert.equal(ordinary.calls.length, 0);

  const { deps, calls } = makeDeps((call) => call.method === "GET"
    ? { status: 200, body: { requests: [{ sessionId: "child", occurrenceId: "request_1" }] } }
    : { status: 200, body: { session: { id: "child", status: "running" } } });
  deps.orchestrator = true;
  const listed = await callTool(deps, "list_descendant_requests");
  assert.deepEqual(resultJson(listed), {
    requests: [{ sessionId: "child", occurrenceId: "request_1" }],
    truncated: false,
    limit: 128,
  });
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests`);

  await callTool(deps, "answer_descendant_question", {
    sessionId: "child", occurrenceId: "request_1", answers: { q: "Continue" },
  });
  assert.deepEqual(calls.at(-1)?.body, {
    sessionId: "child", occurrenceId: "request_1",
    resolution: { action: "answer", answers: { q: "Continue" } },
  });
  await callTool(deps, "dismiss_descendant_question", {
    sessionId: "child", occurrenceId: "request_2",
  });
  assert.deepEqual(calls.at(-1)?.body, {
    sessionId: "child", occurrenceId: "request_2", resolution: { action: "dismiss" },
  });
  await callTool(deps, "resolve_descendant_approval", {
    sessionId: "child", occurrenceId: "request_3", decision: "deny", optionId: "deny-once",
  });
  assert.deepEqual(calls.at(-1)?.body, {
    sessionId: "child", occurrenceId: "request_3",
    resolution: { action: "deny", optionId: "deny-once" },
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests/resolve`);
    assert.equal(call.headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], SELF_ID);
  }
});

test("typed workflow decision tools preserve exact request, resolution, and consume snapshots", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { occurrenceId: "workflow_1", status: "pending" } }));
  deps.controlPlaneProtocolVersion = PROTOCOL_VERSION;
  const snapshot = {
    category: "pr_merge",
    repository: "picoduck/wollipog",
    pullRequest: 42,
    headSha: "a".repeat(40),
    reviewResult: "merge",
    requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 1,
      checks: [{ name: "Required", state: "passed" }] },
  };
  assert.equal((await callTool(deps, "request_workflow_decision", {
    requestId: "merge-42", resourceKey: "picoduck/wollipog#42", resourceSnapshot: snapshot,
  })).isError, undefined);
  assert.deepEqual(calls.at(-1)?.body, {
    requestId: "merge-42", resourceKey: "picoduck/wollipog#42", resourceSnapshot: snapshot,
  });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/workflow-decisions`);

  await callTool(deps, "get_workflow_decision", { occurrenceId: "workflow_1" });
  assert.equal(calls.at(-1)?.method, "GET");
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/workflow-decisions/workflow_1`);

  const action = {
    kind: "pr_merge_enqueue",
    command: `gh pr merge https://github.com/picoduck/wollipog/pull/42 --squash --match-head-commit ${snapshot.headSha}`,
  };
  await callTool(deps, "consume_workflow_decision", {
    occurrenceId: "workflow_1", resourceSnapshot: snapshot, action,
  });
  assert.deepEqual(calls.at(-1)?.body, { resourceSnapshot: snapshot, action });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/workflow-decisions/workflow_1/consume`);

  await callTool(deps, "reconcile_workflow_decision", {
    occurrenceId: "workflow_1", resourceSnapshot: snapshot,
  });
  assert.deepEqual(calls.at(-1)?.body, { resourceSnapshot: snapshot });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/workflow-decisions/workflow_1/reconcile`);

  deps.orchestrator = true;
  const resolution = await callTool(deps, "resolve_descendant_workflow_decision", {
    sessionId: "child", occurrenceId: "workflow_1", outcome: "approve",
    evidenceReviewed: ["desktop"], rationale: "Inspected the exact evidence.",
  });
  assert.equal(resultJson(resolution).decision.occurrenceId, "workflow_1");
  assert.deepEqual(calls.at(-1)?.body, {
    sessionId: "child", occurrenceId: "workflow_1",
    resolution: { action: "resolve_workflow_decision", outcome: "approve",
      evidenceReviewed: ["desktop"], rationale: "Inspected the exact evidence." },
  });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests/resolve`);
});

test("review_descendant_ui_evidence returns the verified image and refuses bytes that miss the bound digest", async () => {
  const bytes = Buffer.from("exact evidence bytes");
  const receipt = {
    receiptId: "uireceipt_1", occurrenceId: "workflow_1", reviewerSessionId: SELF_ID, childSessionId: "child",
    policyRevision: 3, evidenceId: "desktop", artifactId: "art_1",
    sha256: createHash("sha256").update(bytes).digest("hex"), deliveredAt: 10,
  };
  let data = bytes.toString("base64");
  let acknowledgeStatus = 200;
  const { deps, calls } = makeDeps((call) => call.url.endsWith("/acknowledge")
    ? { status: acknowledgeStatus, body: acknowledgeStatus === 200 ? { acknowledged: true } : { error: "replaced" } }
    : { status: 200, body: { receipt, mimeType: "image/png", sizeBytes: bytes.byteLength, data } });
  assert.equal((await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" })).isError, true,
  "only an Orchestrator can read descendant evidence");
  assert.equal(calls.length, 0);

  deps.orchestrator = true;
  const reviewed = await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(calls.at(-2)?.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests/review-ui-evidence`);
  assert.deepEqual(calls.at(-2)?.body, { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests/review-ui-evidence/acknowledge`);
  assert.deepEqual(calls.at(-1)?.body, { receiptId: "uireceipt_1", sha256: receipt.sha256 },
    "the verified handoff is acknowledged before the image is shown");
  assert.deepEqual(resultJson(reviewed), { receipt, mimeType: "image/png", sizeBytes: bytes.byteLength },
    "the text block carries identity and digest, never the bytes");
  assert.deepEqual(reviewed.content[1], { type: "image", data, mimeType: "image/png" });

  acknowledgeStatus = 409;
  const unrecorded = await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(unrecorded.isError, true);
  assert.equal(unrecorded.content.length, 1, "an image is never shown without a usable receipt");

  acknowledgeStatus = 200;
  data = Buffer.from("substituted bytes").toString("base64");
  const before = calls.length;
  const substituted = await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(substituted.isError, true);
  assert.equal(substituted.content.length, 1, "mismatched bytes are never shown to the model");
  assert.equal(calls.length, before + 1, "refused bytes are never acknowledged");
});

test("ordered video-frame deliveries retain one image and exact source-manifest metadata per call", async () => {
  const sourceSha256 = "a".repeat(64);
  const manifestSha256 = "b".repeat(64);
  const frames = [Buffer.from("frame zero"), Buffer.from("frame one")];
  const { deps, calls } = makeDeps((call) => {
    if (call.url.endsWith("/acknowledge")) return { status: 200, body: { acknowledged: true } };
    const index = call.body && typeof call.body === "object" &&
      (call.body as { evidenceId?: string }).evidenceId === "frame-1" ? 1 : 0;
    const bytes = frames[index]!;
    return { status: 200, body: { receipt: {
      receiptId: `uireceipt_${index}`, occurrenceId: "workflow_video", reviewerSessionId: SELF_ID,
      childSessionId: "child", policyRevision: 4, evidenceId: `frame-${index}`,
      artifactId: `art_frame_${index}`, sha256: createHash("sha256").update(bytes).digest("hex"),
      deliveredAt: 10 + index, deliveryOrder: index + 1,
      videoFrame: { sourceArtifactId: "art_source", sourceSha256, manifestSha256,
        index, ptsMs: index * 250 },
    }, mimeType: "image/png", sizeBytes: bytes.length, data: bytes.toString("base64") } };
  });
  deps.orchestrator = true;
  for (let index = 0; index < frames.length; index++) {
    const result = await callTool(deps, "review_descendant_ui_evidence",
      { sessionId: "child", occurrenceId: "workflow_video", evidenceId: `frame-${index}` });
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 2, "each call delivers exactly one text block and one image");
    assert.equal(result.content[1].data, frames[index]!.toString("base64"));
    assert.equal(resultJson(result).receipt.deliveryOrder, index + 1);
    assert.deepEqual(resultJson(result).receipt.videoFrame,
      { sourceArtifactId: "art_source", sourceSha256, manifestSha256, index, ptsMs: index * 250 });
  }
  assert.equal(calls.length, 4, "each image is independently fetched and acknowledged");
});

test("PR merge action admission fails closed against mixed-version control planes", async () => {
  const { deps, calls } = makeDeps();
  deps.controlPlaneProtocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionAdmission - 1;
  const result = await callTool(deps, "consume_workflow_decision", {
    occurrenceId: "workflow_old",
    resourceSnapshot: {
      category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 42,
      headSha: "a".repeat(40), reviewResult: "merge",
      requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 1,
        checks: [{ name: "Required", state: "passed" }] },
    },
    action: {
      kind: "pr_merge_enqueue",
      command: `gh pr merge https://github.com/picoduck/wollipog/pull/42 --squash --match-head-commit ${"a".repeat(40)}`,
    },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), new RegExp(
    `protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionAdmission}`,
    "u",
  ));
  assert.equal(calls.length, 0, "an old peer never receives an action-bearing consume request");
});

test("PR merge reconciliation fails closed against mixed-version control planes", async () => {
  const { deps, calls } = makeDeps();
  deps.controlPlaneProtocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation - 1;
  const result = await callTool(deps, "reconcile_workflow_decision", {
    occurrenceId: "workflow_old",
    resourceSnapshot: {
      category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 42,
      headSha: "a".repeat(40), reviewResult: "merge",
      requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 1,
        checks: [{ name: "Required", state: "passed" }] },
    },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), new RegExp(
    `protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation}`,
    "u",
  ));
  assert.equal(calls.length, 0, "an old peer never receives a reconciliation request");
});

test("a child-facing decision message is forwarded to a current control plane and refused by an older one", async () => {
  const current = makeDeps();
  current.deps.orchestrator = true;
  current.deps.controlPlaneProtocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionChildMessage;
  await callTool(current.deps, "resolve_descendant_workflow_decision", {
    sessionId: "child", occurrenceId: "workflow_2", outcome: "deny",
    rationale: "Audit note.", childMessage: "Re-run review over the full diff.",
  });
  assert.deepEqual(current.calls.at(-1)?.body, {
    sessionId: "child", occurrenceId: "workflow_2",
    resolution: { action: "resolve_workflow_decision", outcome: "deny",
      rationale: "Audit note.", childMessage: "Re-run review over the full diff." },
  });

  const older = makeDeps();
  older.deps.orchestrator = true;
  older.deps.controlPlaneProtocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionChildMessage - 1;
  const refused = await callTool(older.deps, "resolve_descendant_workflow_decision", {
    sessionId: "child", occurrenceId: "workflow_2", outcome: "deny", childMessage: "Re-run review.",
  });
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), new RegExp(
    `protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionChildMessage}`, "u",
  ));
  assert.equal(older.calls.length, 0,
    "an older control plane would drop the message and still resolve, so it is never asked to");
  await callTool(older.deps, "resolve_descendant_workflow_decision", {
    sessionId: "child", occurrenceId: "workflow_2", outcome: "deny",
  });
  assert.equal(older.calls.length, 1, "a resolution without a message still reaches an older control plane");
});

/* -------------------------------------------------------------------------- */
/* Protocol surface                                                            */
/* -------------------------------------------------------------------------- */

test("initialize returns the protocol version, tools capability, and serverInfo", async () => {
  const { deps } = makeDeps();
  const res = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    deps,
  );
  assert.equal(res!.id, 1);
  assert.equal(res!.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res!.result.capabilities, { tools: {} });
  assert.equal(res!.result.serverInfo.name, "wollipog-manager");
  assert.ok(res!.result.serverInfo.version);
});

test("notifications/initialized is a silent no-op; ping answers {}", async () => {
  const { deps } = makeDeps();
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }, deps), null);
  const pong = await dispatch({ jsonrpc: "2.0", id: 2, method: "ping" }, deps);
  assert.deepEqual(pong, { jsonrpc: "2.0", id: 2, result: {} });
});

test("tools/list returns the curated session and workflow tools with schemas", async () => {
  const { deps } = makeDeps();
  const res = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list" }, deps);
  const tools = res!.result.tools as { name: string; description: string; inputSchema: unknown }[];
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "list_runners",
      "get_agent_capabilities",
      "list_sessions",
      "get_session",
      "request_workflow_decision",
      "get_workflow_decision",
      "consume_workflow_decision",
      "reconcile_workflow_decision",
      "get_session_events",
      "wait_session",
      "list_runs",
      "list_governance_policies",
      "get_governance_policy",
      "list_workflows",
      "get_workflow",
      "get_workflow_node",
      "list_workflow_instances",
      "get_workflow_instance",
      "upsert_governance_policy",
      "delete_governance_policy",
      "create_workflow_definition",
      "create_workflow_version",
      "create_workflow_run",
      "dispatch_workflow_node",
      "attach_session_artifact",
      "create_workflow_artifact",
      "complete_workflow_attempt",
      "resolve_workflow_gate",
      "create_worktree",
      "attach_worktree",
      "select_worktree",
      "discard_worktree",
      "create_session",
      "prompt_session",
      "stop_session",
      "stop_background_job",
      "restart_session",
      "archive_session",
      "set_guardrails",
      "create_run",
    ],
  );
  for (const t of tools) {
    assert.ok(t.description.length > 10, `${t.name} has a description`);
    assert.ok(t.inputSchema, `${t.name} has an input schema`);
  }
});

test("wait-session polling backs off to the existing ten-second ceiling", () => {
  const intervals = [500];
  for (let i = 0; i < 10; i++) intervals.push(nextWaitSessionIntervalMs(intervals.at(-1)!));
  assert.deepEqual(intervals.slice(0, 6), [500, 750, 1125, 1688, 2532, 3798]);
  assert.equal(intervals.at(-1), 10_000);
  assert.equal(nextWaitSessionIntervalMs(10_000), 10_000);
});

test("wait_session uses adaptive delays and preserves its exact timeout boundary", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: { session: { id: "s_wait", status: "running", runnerId: "r1", title: "Waiting" } },
  }));
  let now = 0;
  const delays: number[] = [];
  deps.now = () => now;
  deps.sleep = async (milliseconds) => {
    delays.push(milliseconds);
    now += milliseconds;
  };

  const result = await callTool(deps, "wait_session", {
    sessionId: "s_wait",
    states: ["completed"],
    timeoutMs: 4_000,
    intervalMs: 500,
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /timed out/);
  assert.deepEqual(delays, [500, 750, 1125, 1625]);
  assert.equal(now, 4_000);
  assert.equal(calls.length, 5, "one immediate read plus four adaptively delayed reads");
});

test("mutating tools describe governance instead of promising a now-optional human gate", () => {
  const mutations = [
    "upsert_governance_policy", "delete_governance_policy",
    "create_workflow_definition", "create_workflow_version", "create_workflow_run",
    "dispatch_workflow_node", "attach_session_artifact", "create_workflow_artifact", "complete_workflow_attempt",
    "resolve_workflow_gate", "create_session", "prompt_session", "stop_session", "restart_session",
    "set_guardrails", "create_run", "create_worktree", "attach_worktree", "select_worktree", "discard_worktree",
  ];
  for (const name of mutations) {
    const tool = TOOLS.find((t) => t.name === name)!;
    assert.match(tool.description, /Subject to session permissions and governance policies\.$/, name);
  }
});

test("unknown method -> -32601; tools/call without a name -> -32602", async () => {
  const { deps } = makeDeps();
  const unknown = await dispatch({ jsonrpc: "2.0", id: 4, method: "resources/list" }, deps);
  assert.equal(unknown!.error.code, -32601);
  const badParams = await dispatch({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} }, deps);
  assert.equal(badParams!.error.code, -32602);
});

test("unknown tool name in tools/call -> isError TOOL result (not a protocol error)", async () => {
  const { deps, calls } = makeDeps();
  const result = await callTool(deps, "does_not_exist");
  assert.equal(result.isError, true);
  assert.match(resultText(result), /unknown tool/);
  assert.equal(calls.length, 0);
});

test("non-request noise (a response frame, a notification for an unknown method) is ignored", async () => {
  const { deps } = makeDeps();
  assert.equal(await dispatch({ jsonrpc: "2.0", id: 9, result: {} }, deps), null);
  assert.equal(await dispatch({ jsonrpc: "2.0", method: "something/else" }, deps), null);
  assert.equal(await dispatch("just a string", deps), null);
});

/* -------------------------------------------------------------------------- */
/* Newline framing over PassThrough streams                                    */
/* -------------------------------------------------------------------------- */

test("framing round-trip: split chunks are reassembled, non-JSON lines skipped, replies in order", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const { deps } = makeDeps();
  serveSessionManagementMcp(input, output, deps);

  let out = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => (out += c));

  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  // Split one JSON message across two chunks mid-token.
  input.write(init.slice(0, 12));
  input.write(init.slice(12));
  input.write("this is not json\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");

  // Responses drain through an async chain — poll briefly for both frames.
  for (let i = 0; i < 50 && out.split("\n").filter(Boolean).length < 2; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const frames = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(frames.length, 2, "one reply per request; the notification and noise produce none");
  assert.equal(frames[0].id, 1);
  assert.equal(frames[0].result.protocolVersion, "2025-06-18");
  assert.deepEqual(frames[1], { jsonrpc: "2.0", id: 2, result: {} });
});

test("a stalled CP request does not head-of-line block other tools (concurrent dispatch)", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  // A half-open tunnel: the fetch never settles. Serialized dispatch would park ping,
  // tools/list, and every pre-allowed read behind it, bricking the whole server.
  let stalled = 0;
  const stallingFetch: McpFetch = () => {
    stalled++;
    return new Promise(() => {});
  };
  serveSessionManagementMcp(input, output, { fetch: stallingFetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: "" });

  let out = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => (out += c));

  input.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } }) + "\n",
  );
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) + "\n");

  for (let i = 0; i < 50 && out.split("\n").filter(Boolean).length < 2; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const ids = out.split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
  assert.ok(ids.includes(2), "ping answered while the fetch is stalled");
  assert.ok(ids.includes(3), "tools/list answered while the fetch is stalled");
  assert.ok(!ids.includes(1), "the stalled call itself is still pending");
  assert.equal(stalled, 1);
});

test("MCP cancellation promptly interrupts a long wait_session request", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let fetches = 0;
  const fetch: McpFetch = async () => {
    fetches++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session: { id: "child", status: "running" } }),
    };
  };
  serveSessionManagementMcp(input, output, {
    fetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: "",
  });

  let out = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { out += chunk; });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: {
    name: "wait_session", arguments: { sessionId: "child", states: ["completed"], timeoutMs: 600_000 },
  } }) + "\n");
  for (let i = 0; i < 50 && fetches === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 41, reason: "user stopped the turn" } }) + "\n");
  for (let i = 0; i < 50 && !out.includes("\n"); i++) await new Promise((resolve) => setTimeout(resolve, 10));

  const response = JSON.parse(out.trim());
  assert.equal(response.id, 41);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/);
  assert.equal(fetches, 1, "cancellation stops the polling loop before another side effect");
});

test("cancelling an in-flight mutation reports its potentially committed outcome", async () => {
  const controller = new AbortController();
  const fetch: McpFetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted after dispatch")), { once: true });
  });
  const pending = callTool({
    fetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: "", signal: controller.signal,
  }, "prompt_session", { sessionId: "s_child", text: "continue" });
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(resultText(result), /may already have applied it/);
  assert.match(resultText(result), /inspect current state before retrying/);
});

/* -------------------------------------------------------------------------- */
/* Per-tool dispatch: exact method + URL + body                                */
/* -------------------------------------------------------------------------- */

test("list_runners -> GET /api/runners, field-mapped", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: {
      runners: [
        {
          runnerId: "r1",
          hostname: "box",
          os: "linux",
          status: "online",
          version: "0.6.0",
          connectedAt: 1,
          agents: [
            { id: "claude-code", name: "Claude Code", command: "/x/claude", args: [], env: {}, driver: "claude-code", available: true, authStatus: "authenticated" },
          ],
          workspaces: [{ id: "ws", name: "ws", path: "/repo" }],
        },
      ],
    },
  }));
  const result = await callTool(deps, "list_runners");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `${CP_URL}/api/runners`);
  const data = resultJson(result);
  assert.deepEqual(data.runners[0].workspaces, [{ id: "ws", name: "ws", path: "/repo" }]);
  assert.equal(data.runners[0].agents[0].id, "claude-code");
  assert.equal(data.runners[0].agents[0].command, undefined, "launch params are not the calling session's business");
});

test("get_agent_capabilities projects advertised metadata and exact effort fallback semantics", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: {
      runners: [{
        runnerId: "r1", hostname: "box", agents: [{
          id: "codex", name: "Codex", driver: "codex-app-server", available: true,
          authStatus: "authenticated", command: "/secret/codex", env: { SECRET: "nope" },
          capabilities: {
            modelSource: "cached",
            effortLevels: ["low", "high"],
            models: [
              {
                id: "model-own", displayName: "Model Own", default: true,
                description: "Provider description", contextWindow: 200_000,
                inputModalities: ["text", "image"], efforts: ["medium", "xhigh"], defaultEffort: "medium",
              },
              { id: "model-fallback", displayName: "Model Fallback" },
              { id: "model-hidden", displayName: "Model Hidden", hidden: true, efforts: ["ultra"] },
            ],
          },
        }],
      }],
    },
  }));
  deps.orchestrator = true;

  const result = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "codex", limit: 1,
  }));
  assert.equal(calls[0]!.url, `${CP_URL}/api/runners`);
  assert.equal(result.agent.command, undefined);
  assert.equal(result.discovery.modelSource, "cached");
  assert.deepEqual(result.harnessEfforts, ["low", "high"]);
  assert.deepEqual(result.models, [{
    id: "model-own", displayName: "Model Own", default: true, hidden: false,
    description: "Provider description", contextWindow: 200_000, inputModalities: ["text", "image"],
    defaultEffort: "medium", efforts: ["medium", "xhigh"], effortSource: "model", configurableEffort: true,
  }]);
  assert.deepEqual(result.page, { offset: 0, limit: 1, returned: 1, total: 2, nextOffset: 1, truncated: true });
  assert.equal(result.hiddenModelsExcluded, 1);

  const continued = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "codex", offset: result.page.nextOffset, limit: 1,
  }));
  assert.deepEqual(continued.models[0], {
    id: "model-fallback", displayName: "Model Fallback", hidden: false,
    efforts: ["low", "high"], effortSource: "harness", configurableEffort: true,
  });
  assert.equal(continued.page.truncated, false);

  const hidden = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "codex", modelId: "model-hidden",
  }));
  assert.equal(hidden.models[0].hidden, true);
  assert.equal(hidden.models[0].effortSource, "model");
  assert.equal(hidden.page.targeted, true);
});

test("get_agent_capabilities distinguishes missing discovery from supported no-effort models", async () => {
  const { deps } = makeDeps(() => ({
    status: 200,
    body: { runners: [{ runnerId: "r1", agents: [
      { id: "legacy", name: "Legacy" },
      {
        id: "fixed", name: "Fixed", capabilities: {
          models: [{ id: "fixed-model" }], effortLevels: [], slashCommands: [],
          supportsImages: false, supportsApprovals: false,
        },
      },
    ] }] },
  }));
  const missing = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "legacy",
  }));
  assert.deepEqual(missing.discovery, { status: "unavailable", reason: "not_advertised", modelSource: null });
  assert.deepEqual(missing.models, []);

  const fixed = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "fixed",
  }));
  assert.deepEqual(fixed.discovery, { status: "available", modelSource: null });
  assert.deepEqual(fixed.models[0], {
    id: "fixed-model", hidden: false, efforts: [], effortSource: "none", configurableEffort: false,
  });
});

test("get_agent_capabilities treats the orchestrator-only ACP marker as session-negotiated discovery", async () => {
  const { deps } = makeDeps(() => ({
    status: 200,
    body: { runners: [{ runnerId: "r1", agents: [{
      id: "claude-acp",
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        permissionModes: ["orchestrator"], elicitation: { orchestrator: ["none"] },
      },
    }] }] },
  }));
  const result = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "r1", agentId: "claude-acp",
  }));
  assert.deepEqual(result.discovery, {
    status: "unavailable", reason: "session_negotiated", modelSource: null,
  });
  assert.deepEqual(result.models, []);
});

test("get_agent_capabilities fails closed for invisible installations and invalid bounds", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { runners: [] } }));
  const invisible = await callTool(deps, "get_agent_capabilities", { runnerId: "foreign", agentId: "codex" });
  assert.equal(invisible.isError, true);
  assert.match(resultText(invisible), /not found or not visible/u);
  assert.equal(calls.length, 1);

  for (const input of [{ offset: -1 }, { limit: 0 }, { limit: 101 }]) {
    const invalid = await callTool(deps, "get_agent_capabilities", {
      runnerId: "r1", agentId: "codex", ...input,
    });
    assert.equal(invalid.isError, true);
  }
  for (const input of [{ modelId: "gpt", offset: 1 }, { modelId: "gpt", limit: 1 }, { modelId: "gpt", includeHidden: true }]) {
    const invalid = await callTool(deps, "get_agent_capabilities", {
      runnerId: "r1", agentId: "codex", ...input,
    });
    assert.equal(invalid.isError, true);
    assert.match(resultText(invalid), /cannot be combined/u);
  }
  assert.equal(calls.length, 1, "invalid bounds are rejected before requesting visible runner metadata");
});

test("get_agent_capabilities reaches an exact installation beyond list display caps", async () => {
  const fillers = Array.from({ length: 100 }, (_, index) => ({
    runnerId: `filler-${index}`,
    agents: Array.from({ length: 100 }, (_unused, agentIndex) => ({ id: `agent-${agentIndex}` })),
  }));
  const { deps } = makeDeps(() => ({
    status: 200,
    body: { runners: [...fillers, {
      runnerId: "target-runner",
      agents: [...fillers[0]!.agents, {
        id: "target-agent",
        capabilities: { models: [{ id: "target-model" }], effortLevels: [] },
      }],
    }] },
  }));
  const result = resultJson(await callTool(deps, "get_agent_capabilities", {
    runnerId: "target-runner", agentId: "target-agent",
  }));
  assert.equal(result.models[0].id, "target-model");
});

test("get_agent_capabilities retrieves a large catalog completely through bounded pages", async () => {
  const catalog = Array.from({ length: 205 }, (_, index) => ({ id: `model-${String(index).padStart(3, "0")}` }));
  const { deps } = makeDeps(() => ({
    status: 200,
    body: { runners: [{
      runnerId: "r1",
      agents: [{ id: "codex", capabilities: { models: catalog, effortLevels: ["medium"] } }],
    }] },
  }));
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const result = resultJson(await callTool(deps, "get_agent_capabilities", {
      runnerId: "r1", agentId: "codex", offset, limit: 100,
    }));
    assert.ok(result.models.length <= 100);
    ids.push(...result.models.map((model: { id: string }) => model.id));
    if (!result.page.truncated) break;
    assert.equal(typeof result.page.nextOffset, "number");
    offset = result.page.nextOffset;
  }
  assert.deepEqual(ids, catalog.map((model) => model.id));
});

test("child creation revalidates a pair after advisory capability discovery", async () => {
  const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/runners")
    ? {
        status: 200,
        body: { runners: [{ runnerId: "r1", agents: [{
          id: "codex", capabilities: { models: [{ id: "gpt" }], effortLevels: ["high"] },
        }] }] },
      }
    : { status: 409, body: { error: "selected model and effort are no longer supported" } });
  deps.controlPlaneProtocolVersion = PROTOCOL_VERSION;
  await callTool(deps, "get_agent_capabilities", { runnerId: "r1", agentId: "codex" });
  const created = await callTool(deps, "create_session", {
    runnerId: "r1", agentId: "codex", workspaceId: "ws", model: "gpt", effort: "high",
  });
  assert.equal(created.isError, true);
  assert.match(resultText(created), /no longer supported/u);
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", `${CP_URL}/api/runners`],
    ["POST", `${CP_URL}/api/sessions`],
  ]);
});

test("list_sessions -> GET /api/sessions (+?archived=true), mapped with pendingApproval title only", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: {
      sessions: [
        {
          id: "s_1",
          title: "work",
          status: "input_required",
          runnerId: "r1",
          workspaceId: "ws",
          agentId: "claude-code",
          runId: null,
          maxChildSessions: 7,
          orchestratorPolicy: {
            version: 1,
            behavior: { childModel: "sol", childEffort: "high", maximumConcurrentChildren: 7, followUps: "recommend_only", completion: "retain" },
            delegation: { parentControl: "off", decisions: { implementation_question: "human", pr_merge: "human", merged_branch_deletion: "human", follow_up_issue_publication: "human", ui_evidence_approval: "human" } },
            sources: { behavior: { childModel: "user_default", childEffort: "user_default", maximumConcurrentChildren: "session_override", followUps: "user_default", completion: "user_default" }, delegation: { parentControl: "user_default", decisions: { implementation_question: "user_default", pr_merge: "user_default", merged_branch_deletion: "user_default", follow_up_issue_publication: "user_default", ui_evidence_approval: "user_default" } } },
          },
          liveChildCapacity: { limit: 7, occupied: 5, remaining: 2 },
          costUsd: 1.5,
          costBudgetUsd: 5,
          maxToolCalls: null,
          toolCallCount: 3,
          pendingApproval: { requestId: "req-1", title: "Bash: rm -rf", options: [] },
          preview: "should not leak",
          updatedAt: 42,
          archived: false,
        },
      ],
    },
  }));
  let result = await callTool(deps, "list_sessions");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions`);
  const s = resultJson(result).sessions[0];
  assert.equal(s.pendingApproval, "Bash: rm -rf", "title only — no requestId to replay");
  assert.equal(s.costBudgetUsd, 5);
  assert.equal(s.maxChildSessions, 7);
  assert.deepEqual(s.liveChildCapacity, { limit: 7, occupied: 5, remaining: 2 });
  assert.equal(s.orchestratorPolicy.behavior.childModel, "sol",
    "the active campaign can inspect its immutable-at-creation policy and sources");
  assert.equal(s.preview, undefined);

  result = await callTool(deps, "list_sessions", { archived: true });
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions?archived=true`);
});

test("list_sessions caps the array at 100 items", async () => {
  const sessions = Array.from({ length: 250 }, (_, i) => ({ id: `s_${i}`, title: "t", status: "idle" }));
  const { deps } = makeDeps(() => ({ status: 200, body: { sessions } }));
  const result = await callTool(deps, "list_sessions");
  assert.equal(resultJson(result).sessions.length, 100);
});

test("get_session -> GET /api/sessions/:id", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { session: { id: "s_9", title: "x" } } }));
  const result = await callTool(deps, "get_session", { sessionId: "s_9" });
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_9`);
  assert.equal(resultJson(result).session.id, "s_9");
});

test("campaign tools read policy state, deduplicate follow-ups, and verify exact reports", async () => {
  const campaign = {
    status: "waiting_human",
    policyRevision: 4,
    decisionOwners: { pr_merge: "human" },
    limits: { maximumConcurrentChildren: 3, occupied: 2, remaining: 1, costBudgetUsd: 5, maxToolCalls: 20 },
  };
  const { deps, calls } = makeDeps((call) => {
    if (call.url.endsWith("/orchestrator-campaign") && call.method === "GET") return { status: 200, body: campaign };
    if (call.url.endsWith("/follow-ups")) return { status: 201, body: { id: "followup_1", duplicate: true, executionDisposition: "duplicate_stop" } };
    if (call.url.endsWith("/verify-child")) return { status: 202, body: { campaign, child: { id: "s_child", archiveStatus: "stop_pending" } } };
    return { status: 404, body: { error: "unexpected" } };
  });
  deps.orchestrator = true;
  assert.deepEqual(resultJson(await callTool(deps, "get_campaign")).campaign, campaign);
  const followUp = resultJson(await callTool(deps, "record_campaign_follow_up", {
    originSessionId: "s_child", repository: "picoduck/wollipog", title: "Bounded Fix", recommendationKey: "key",
  })).followUp;
  assert.equal(followUp.duplicate, true);
  const verified = resultJson(await callTool(deps, "verify_campaign_child", {
    childSessionId: "s_child", reportEventSeq: 12, followUpsAccounted: true,
  }));
  assert.equal(verified.child.archiveStatus, "stop_pending");
  assert.deepEqual(calls[1]!.body, {
    originSessionId: "s_child", repository: "picoduck/wollipog", title: "Bounded Fix", recommendationKey: "key",
  });
  assert.deepEqual(calls[2]!.body, {
    childSessionId: "s_child", reportEventSeq: 12, followUpsAccounted: true,
  });
});

test("get_session redacts pendingApproval to its title and caps the preview (no requestId to replay)", async () => {
  const { deps } = makeDeps(() => ({
    status: 200,
    body: {
      session: {
        id: "s_9",
        title: "parked worker",
        status: "input_required",
        runnerId: "r1",
        workspaceId: "ws",
        agentId: "claude-code",
        driver: "claude-code",
        model: "opus",
        effort: "high",
        permissionMode: "default",
        useWorktree: true,
        worktreePath: "/repos/x/.agent-worktrees/s_9",
        workspaceName: "demo",
        agentName: "Claude Code",
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 3,
        messageCount: 4,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.5,
        // The credential a tool could one day replay against /approve — must never surface.
        pendingApproval: {
          requestId: "req-secret-77",
          title: "Bash: rm -rf /",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        preview: "p".repeat(2000),
      },
    },
  }));
  const result = await callTool(deps, "get_session", { sessionId: "s_9" });
  assert.equal(resultJson(result).session.model, "opus");
  assert.equal(resultJson(result).session.effort, "high");
  const text = resultText(result);
  assert.ok(!text.includes("req-secret-77"), "no requestId to replay");
  assert.ok(!text.includes("allow_once"), "no options array either");
  const s = resultJson(result).session;
  assert.equal(s.pendingApproval, "Bash: rm -rf /", "title only, like every other session-returning tool");
  assert.ok(s.preview.length <= 401, "preview capped at the line limit");
  // The whitelisted full-metadata extras survive the funnel.
  assert.equal(s.model, "opus");
  assert.equal(s.permissionMode, "default");
  assert.equal(s.worktreePath, "/repos/x/.agent-worktrees/s_9");
  assert.equal(s.workspaceName, "demo");
  assert.equal(s.messageCount, 4);
  assert.equal(s.tokensOut, 20);
});

/** A control plane that serves `GET /api/sessions/:id` and the bounded and unbounded events routes
 * over `total` events, with a forward-hydrated cache holding the first `cached` of them. */
function eventsCp(
  total: number,
  options: {
    cached?: number;
    eventEpoch?: number;
    text?: (seq: number) => string;
    runnerOffline?: boolean;
    replaceDuringFallback?: boolean;
  } = {},
) {
  const events = Array.from({ length: total }, (_, i) => ({
    seq: i + 1,
    ts: 1000 + i,
    payload: { kind: "agent_message", text: options.text?.(i + 1) ?? `line ${i + 1}` },
  }));
  let cached = options.cached ?? total;
  let eventEpoch = options.eventEpoch ?? 2;
  return makeDeps((call) => {
    const url = new URL(call.url);
    if (url.pathname === "/api/sessions/s_1") return { status: 200, body: { session: { id: "s_1", eventEpoch } } };
    assert.equal(url.pathname, "/api/sessions/s_1/events");
    const q = url.searchParams;
    const after = Number(q.get("after") ?? 0);
    if (!q.has("limit")) {
      // The unbounded read awaits hydration, which completes the cache unless the runner is offline.
      if (!options.runnerOffline) cached = total;
      if (options.replaceDuringFallback) eventEpoch += 1;
      return { status: 200, body: { events: events.slice(0, cached).filter((e) => e.seq > after) } };
    }
    if (Number(q.get("eventEpoch")) !== eventEpoch) {
      return { status: 409, body: { error: "session event history was replaced", code: "stale_event_epoch", eventEpoch } };
    }
    const limit = Number(q.get("limit"));
    const cache = events.slice(0, cached);
    const cacheComplete = cached >= total;
    if (q.get("direction") === "backward") {
      return { status: 200, body: { events: cache.slice(-limit), eventEpoch, hasMoreOlder: cache.length > limit, cacheComplete } };
    }
    const rest = cache.filter((e) => e.seq > after);
    const page = rest.slice(0, limit);
    return {
      status: 200,
      body: { events: page, eventEpoch, nextAfter: page.at(-1)?.seq ?? after, hasMoreCached: rest.length > limit, cacheComplete },
    };
  });
}

const seqOf = (line: string) => Number(/^\((\d+)\)/.exec(line)![1]);

test("get_session_events: after/limit pages forward through a bounded read, 400-char line cap, lastSeq", async () => {
  const { deps, calls } = eventsCp(40, { text: (seq) => `line ${seq} ` + "x".repeat(1000) });
  const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after: 3, limit: 5 }));
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_1`);
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions/s_1/events?after=3&limit=5&eventEpoch=2`);
  assert.equal(calls.length, 2, "one page never fetches the full history");
  assert.deepEqual(data.lines.map(seqOf), [4, 5, 6, 7, 8], "the first events after the cursor, ascending");
  assert.match(data.lines[0], /^\(4\) agent_message: line 4/);
  for (const line of data.lines) assert.ok(line.length <= 401, "capped at 400 chars (+ellipsis)");
  assert.equal(data.lastSeq, 8, "lastSeq is the last returned event");
  assert.equal(data.hasMore, true);
});

test("get_session_events: repeated after=lastSeq reads every event exactly once", async () => {
  const { deps } = eventsCp(23);
  const seen: number[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after, limit: 5 }));
    pages += 1;
    seen.push(...data.lines.map(seqOf));
    assert.equal(data.lastSeq, data.lines.length ? seqOf(data.lines.at(-1)) : after);
    after = data.lastSeq;
    if (!data.hasMore) break;
    assert.ok(pages < 10, "paging terminates");
  }
  assert.equal(pages, 5);
  assert.deepEqual(seen, Array.from({ length: 23 }, (_, i) => i + 1));
});

test("get_session_events: an empty page keeps the cursor and reports no more events", async () => {
  const { deps } = eventsCp(10);
  const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5 }));
  assert.deepEqual(data, { lines: [], lastSeq: 10, hasMore: false, eventEpoch: 2 });
});

test("get_session_events without after reads the newest events through a bounded backward read", async () => {
  const { deps, calls } = eventsCp(40);
  const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", limit: 5 }));
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions/s_1/events?direction=backward&limit=5&eventEpoch=2`);
  assert.deepEqual(data.lines.map(seqOf), [36, 37, 38, 39, 40]);
  assert.equal(data.lastSeq, 40, "the newest seq, ready to page forward for what happens next");
  assert.equal("hasMore" in data, false);

  const empty = eventsCp(0);
  const none = resultJson(await callTool(empty.deps, "get_session_events", { sessionId: "s_1" }));
  assert.equal(empty.calls[1]!.url, `${CP_URL}/api/sessions/s_1/events?direction=backward&limit=30&eventEpoch=2`);
  assert.deepEqual(none, { lines: [], lastSeq: 0, eventEpoch: 2 });
});

test("get_session_events falls back to the hydrating read only when the cache cannot answer", async () => {
  // The cache holds seq 1-12 of 30. A full forward page inside it is exact and stays bounded.
  const full = eventsCp(30, { cached: 12 });
  const inside = resultJson(await callTool(full.deps, "get_session_events", { sessionId: "s_1", after: 2, limit: 5 }));
  assert.deepEqual(inside.lines.map(seqOf), [3, 4, 5, 6, 7]);
  assert.equal(inside.hasMore, true);
  assert.equal(inside.historyIncomplete, true, "a full page from an incomplete cache still says so");
  assert.equal(full.calls.length, 2);

  // A short page at the cache edge is not the end of the log; the unbounded read waits for hydration.
  const edge = eventsCp(30, { cached: 12 });
  const past = resultJson(await callTool(edge.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5 }));
  assert.equal(edge.calls[2]!.url, `${CP_URL}/api/sessions/s_1/events?after=10`);
  assert.deepEqual(past.lines.map(seqOf), [11, 12, 13, 14, 15], "still the first events after the cursor");
  assert.equal(past.lastSeq, 15);
  assert.equal(past.hasMore, true);

  // The cached tail of an incomplete cache is an old prefix, never the newest events.
  const tail = eventsCp(30, { cached: 12 });
  const newest = resultJson(await callTool(tail.deps, "get_session_events", { sessionId: "s_1", limit: 3 }));
  assert.equal(tail.calls[2]!.url, `${CP_URL}/api/sessions/s_1/events?after=0`);
  assert.deepEqual(newest.lines.map(seqOf), [28, 29, 30]);
});

test("get_session_events never reports the end of the log while hydration cannot finish", async () => {
  // The runner is offline: the cache holds seq 1-12 of 30 and the hydrating read cannot add more.
  const offline = eventsCp(30, { cached: 12, runnerOffline: true });
  const page = resultJson(await callTool(offline.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5 }));
  assert.deepEqual(page.lines.map(seqOf), [11, 12]);
  assert.equal(page.lastSeq, 12);
  assert.equal(page.hasMore, true, "unread events exist beyond the cache");
  assert.equal(page.historyIncomplete, true);
  const drained = resultJson(await callTool(offline.deps, "get_session_events", { sessionId: "s_1", after: 12, limit: 5 }));
  assert.deepEqual(drained, { lines: [], lastSeq: 12, hasMore: true, historyIncomplete: true, eventEpoch: 2 });
  const newest = resultJson(await callTool(offline.deps, "get_session_events", { sessionId: "s_1", limit: 3 }));
  assert.equal(newest.historyIncomplete, true, "a stale cached tail is flagged");

  // Hydration completes during the fallback read: the short page is the true end of the log.
  const online = eventsCp(14, { cached: 12 });
  const end = resultJson(await callTool(online.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5 }));
  assert.deepEqual(end, {
    lines: ["(11) agent_message: line 11", "(12) agent_message: line 12", "(13) agent_message: line 13", "(14) agent_message: line 14"],
    lastSeq: 14,
    hasMore: false,
    eventEpoch: 2,
  });
});

test("get_session_events retries once when the event history is replaced between reads", async () => {
  let epoch = 1;
  const events = [{ seq: 1, ts: 1, payload: { kind: "agent_message", text: "fresh" } }];
  const { deps, calls } = makeDeps((call) => {
    const url = new URL(call.url);
    if (url.pathname === "/api/sessions/s_1") return { status: 200, body: { session: { id: "s_1", eventEpoch: epoch++ } } };
    if (url.searchParams.get("eventEpoch") !== "2") return { status: 409, body: { error: "session event history was replaced" } };
    return { status: 200, body: { events, eventEpoch: 2, nextAfter: 1, hasMoreCached: false, cacheComplete: true } };
  });
  const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after: 0, limit: 5 }));
  assert.equal(calls.length, 4);
  assert.deepEqual(data, { lines: ["(1) agent_message: fresh"], lastSeq: 1, hasMore: false, eventEpoch: 2 });

  const stale = makeDeps((call) => new URL(call.url).pathname === "/api/sessions/s_1"
    ? { status: 200, body: { session: { id: "s_1", eventEpoch: 1 } } }
    : { status: 409, body: { error: "session event history was replaced" } });
  const result = await callTool(stale.deps, "get_session_events", { sessionId: "s_1", after: 0 });
  assert.equal(result.isError, true, "a second replacement is reported rather than retried forever");
  assert.equal(stale.calls.length, 4);
});

test("get_session_events fails instead of applying a cursor to a replaced history", async () => {
  // The caller's cursor came from epoch 1; the history has since been replaced (epoch 2).
  const { deps, calls } = eventsCp(30);
  const result = await callTool(deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5, eventEpoch: 1 });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /history was replaced/);
  assert.equal(calls.length, 1, "a pinned epoch skips the metadata read and never retries");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_1/events?after=10&limit=5&eventEpoch=1`);

  const pinned = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5, eventEpoch: 2 }));
  assert.deepEqual(pinned.lines.map(seqOf), [11, 12, 13, 14, 15]);
  assert.equal(pinned.eventEpoch, 2);

  const invalid = await callTool(deps, "get_session_events", { sessionId: "s_1", after: 10, eventEpoch: -1 });
  assert.equal(invalid.isError, true);
});

test("get_session_events rejects a fallback page read across a history replacement", async () => {
  // The history is replaced while the unbounded fallback runs; its rows belong to the new log.
  const pinned = eventsCp(30, { cached: 12, replaceDuringFallback: true });
  const result = await callTool(pinned.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5, eventEpoch: 2 });
  assert.equal(result.isError, true, "the old cursor is never applied to the new log");
  assert.match(resultText(result), /history was replaced/);

  // Without a pinned epoch the read restarts once at the new epoch.
  const unpinned = eventsCp(30, { cached: 12, replaceDuringFallback: true });
  const data = resultJson(await callTool(unpinned.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5 }));
  assert.equal(data.eventEpoch, 3);
  assert.deepEqual(data.lines.map(seqOf), [11, 12, 13, 14, 15]);

  // The same-epoch proof itself fails: the unverified fallback page is never returned.
  let fallbackRead = false;
  const events = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, ts: i, payload: { kind: "agent_message", text: "t" } }));
  const failing = makeDeps((call) => {
    const q = new URL(call.url).searchParams;
    if (!q.has("limit")) {
      fallbackRead = true;
      return { status: 200, body: { events: events.filter((e) => e.seq > Number(q.get("after"))) } };
    }
    if (fallbackRead) return { status: 500, body: { error: "database unavailable" } };
    return { status: 200, body: { events: events.slice(10), eventEpoch: 2, nextAfter: 12, hasMoreCached: false, cacheComplete: false } };
  });
  const unverified = await callTool(failing.deps, "get_session_events", { sessionId: "s_1", after: 10, limit: 5, eventEpoch: 2 });
  assert.equal(unverified.isError, true);
  assert.match(resultText(unverified), /database unavailable/);
});

test("get_session_events pages forward against a control plane without bounded pages", async () => {
  const events = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, ts: i, payload: { kind: "agent_message", text: "t" } }));
  const { deps } = makeDeps((call) => new URL(call.url).pathname === "/api/sessions/s_1"
    ? { status: 200, body: { session: { id: "s_1" } } }
    : { status: 200, body: { events: events.filter((e) => e.seq > Number(new URL(call.url).searchParams.get("after") ?? 0)) } });
  const forward = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", after: 4, limit: 3 }));
  assert.deepEqual(forward.lines.map(seqOf), [5, 6, 7]);
  assert.equal(forward.lastSeq, 7);
  assert.equal(forward.hasMore, true);
  const newest = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1", limit: 3 }));
  assert.deepEqual(newest.lines.map(seqOf), [18, 19, 20]);
});

test("list_runs -> GET /api/runs", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: { runs: [{ id: "r_1", title: "fanout", prompt: "task", workspaceId: "ws", sessionIds: ["s_1", "s_2"], createdAt: 1, updatedAt: 2 }] },
  }));
  const result = await callTool(deps, "list_runs");
  assert.equal(calls[0]!.url, `${CP_URL}/api/runs`);
  assert.deepEqual(resultJson(result).runs[0].sessionIds, ["s_1", "s_2"]);
});

test("worktree tools use the canonical routes and default to the calling session", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: {
      worktree: { id: "wt_1", path: "/repo/wt", branch: "fix/one", baseRef: "origin/main", source: "created" },
      session: { id: SELF_ID, status: "running", runnerId: "r1" },
      retirement: { status: "deferred", reason: "provider_active" },
    },
  }));
  deps.controlPlaneProtocolVersion = PROTOCOL_VERSION;
  await callTool(deps, "create_worktree", { branch: "fix/one", baseRef: "origin/main" });
  await callTool(deps, "attach_worktree", { sessionId: "s_child", path: "/repo/attached" });
  await callTool(deps, "select_worktree", { sessionId: "s_child", path: "/repo/wt" });
  const discarded = await callTool(deps, "discard_worktree", { sessionId: "s_child", path: "/repo/old" });
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/${SELF_ID}/worktrees`);
  assert.deepEqual(calls[0]!.body, { branch: "fix/one", baseRef: "origin/main", progress: true });
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions/s_child/worktrees/attach`);
  assert.deepEqual(calls[1]!.body, { path: "/repo/attached" });
  assert.equal(calls[2]!.url, `${CP_URL}/api/sessions/s_child/worktrees/select`);
  assert.equal(calls[3]!.url, `${CP_URL}/api/sessions/s_child/worktrees/discard`);
  assert.deepEqual(calls[3]!.body, { path: "/repo/old" });
  assert.deepEqual(resultJson(discarded).retirement, { status: "deferred", reason: "provider_active" });
});

test("discard_worktree refuses peers that cannot report deferred retirement", async () => {
  const { deps, calls } = makeDeps();
  deps.controlPlaneProtocolVersion = RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement - 1;
  const result = await callTool(deps, "discard_worktree", { path: "/repo/old" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /requires control plane protocol v159/);
  assert.equal(calls.length, 0);
});

test("discard_worktree relays a legacy runner's explicit non-replaying refusal to the agent", async () => {
  const { deps } = makeDeps(() => ({
    status: 409,
    body: {
      error: "worktree retained: the worktree is still handling a provider turn or queued input — " +
        "this runner reports protocol v158, and durable deferred worktree retirement requires v159. " +
        "No retirement was recorded, so this refusal will not replay on its own: retry the discard " +
        "once the session's provider has exited, or update and restart the runner to receive a " +
        "durable receipt instead.",
      retirement: { status: "unsupported", reason: "legacy_runner" },
    },
  }));
  deps.controlPlaneProtocolVersion = PROTOCOL_VERSION;
  const result = await callTool(deps, "discard_worktree", { sessionId: "s_child", path: "/repo/old" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /will not replay on its own/);
  assert.match(resultText(result), /retry the discard once the session's provider has exited/);
});

test("create_worktree can finish after the ordinary control-plane request deadline", async () => {
  const { deps } = makeDeps();
  deps.requestTimeoutMs = 1;
  deps.fetch = async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      }, { once: true });
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        worktree: { id: "wt_slow", path: "/repo/slow", branch: "fix/slow", source: "created" },
        session: { id: SELF_ID, status: "running", runnerId: "r1" },
      }),
    };
  };

  const result = await callTool(deps, "create_worktree", { branch: "fix/slow" });

  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).worktree.id, "wt_slow");
});

test("create_worktree polls the same coordinates while a progress-aware operation is healthy", async () => {
  let attempt = 0;
  const { deps, calls } = makeDeps(() => {
    attempt += 1;
    if (attempt < 3) {
      return { status: 202, body: { operation: { id: "worktree_1", status: "in_progress", phase: "fetching_remote" } } };
    }
    return {
      status: 200,
      body: {
        operation: { id: "worktree_1", status: "completed" },
        worktree: { id: "wt_1", path: "/repo/wt", branch: "fix/one", source: "created" },
        session: { id: SELF_ID, status: "running", runnerId: "r1" },
      },
    };
  });
  const sleeps: number[] = [];
  deps.sleep = async (milliseconds) => { sleeps.push(milliseconds); };

  const result = await callTool(deps, "create_worktree", { branch: "fix/one", baseRef: "origin/main" });

  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).worktree.id, "wt_1");
  assert.deepEqual(sleeps, [1_000, 1_000]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === `${CP_URL}/api/sessions/${SELF_ID}/worktrees`));
  assert.ok(calls.every((call) => JSON.stringify(call.body) === JSON.stringify(calls[0]!.body)));
});

test("cancelling an acknowledged create_worktree reports that the operation may still complete", async () => {
  const controller = new AbortController();
  const { deps, calls } = makeDeps(() => ({
    status: 202,
    body: { operation: { id: "worktree_acknowledged", status: "in_progress", phase: "materializing" } },
  }));
  deps.signal = controller.signal;
  deps.sleep = () => new Promise(() => {});

  const pending = callTool(deps, "create_worktree", { branch: "fix/cancelled-after-ack" });
  for (let index = 0; index < 50 && calls.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  const result = await pending;

  assert.equal(result.isError, true);
  assert.match(resultText(result), /acknowledged the worktree operation/u);
  assert.match(resultText(result), /may still complete/u);
  assert.match(resultText(result), /inspect current state before retrying/u);
  assert.equal(calls.length, 1, "cancellation does not resubmit an already acknowledged operation");
});

test("create_worktree reports a bounded progress-aware stall as a terminal error", async () => {
  let attempt = 0;
  const { deps } = makeDeps(() => {
    attempt += 1;
    return attempt === 1
      ? { status: 202, body: { operation: { id: "worktree_stalled", status: "in_progress", phase: "materializing" } } }
      : { status: 409, body: { operation: { id: "worktree_stalled", status: "failed" }, error: "runner request timed out" } };
  });
  deps.sleep = async () => {};

  const result = await callTool(deps, "create_worktree", { branch: "fix/stalled" });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /runner request timed out/);
});

test("an exact-session MCP credential cannot manage another session's worktrees", async () => {
  const { deps, calls } = makeDeps();
  deps.actorHeader = WOLLIPOG_AGENT_ACTOR_SESSION_HEADER;
  const result = await callTool(deps, "create_worktree", { sessionId: "s_other", branch: "fix/other" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /only its own worktrees/);
  assert.equal(calls.length, 0);
});

test("create_session asks for a worktree by default and honours an explicit opt-out", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 201, body: { id: "s_new", title: "t", status: "queued", runnerId: "r1" } }));
  await callTool(deps, "create_session", { runnerId: "r1", agentId: "claude-code", workspaceId: "ws" });
  // A child started in the primary checkout has no branch, so every Git surface goes blind to it.
  assert.equal(calls[0]!.body.useWorktree, true);
  await callTool(deps, "create_session", {
    runnerId: "r1", agentId: "claude-code", workspaceId: "ws", useWorktree: false,
  });
  assert.equal(calls[1]!.body.useWorktree, false, "an explicit opt-out keeps the in-place behavior");
});

test("attach_worktree reports the platform-isolation boundary the runner returned", async () => {
  const { deps } = makeDeps(() => ({
    status: 200,
    body: {
      worktree: { id: "wt_1", path: "/repos-worktrees/example", branch: "fix/example", source: "attached" },
      session: { id: SELF_ID, status: "running", runnerId: "r1" },
      isolation: { writableNow: false, writableAtNextLaunch: true },
    },
  }));
  const attached = resultJson(await callTool(deps, "attach_worktree", { path: "/repos-worktrees/example" }));
  assert.deepEqual(attached.isolation, { writableNow: false, writableAtNextLaunch: true });
  // A pre-v133 runner reports nothing, and the tool says unknown rather than inventing a claim.
  const { deps: older } = makeDeps(() => ({
    status: 200,
    body: {
      worktree: { id: "wt_1", path: "/repos-worktrees/example", branch: "fix/example", source: "attached" },
      session: { id: SELF_ID, status: "running", runnerId: "r1" },
    },
  }));
  const legacy = resultJson(await callTool(older, "attach_worktree", { path: "/repos-worktrees/example" }));
  assert.equal(legacy.isolation, null);
});

test("create_session applies model and effort in the original create request and reports the effective pair", async () => {
  const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/compatibility")
    ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
    : {
        status: 201,
        body: { id: "s_new", title: "t", status: "queued", runnerId: "r1", model: "opus", effort: "high" },
      });
  const result = await callTool(deps, "create_session", {
    runnerId: "r1",
    agentId: "claude-code",
    workspaceId: "ws",
    prompt: "fix the flaky test",
    title: "flaky fix",
    useWorktree: true,
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
  });
  assert.equal(calls.length, 2, "compatibility is proven before the one atomic create call");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url, `${CP_URL}/api/compatibility`);
  assert.equal(calls[1]!.method, "POST");
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions`);
  assert.deepEqual(calls[1]!.body, {
    runnerId: "r1",
    agentId: "claude-code",
    workspaceId: "ws",
    title: "flaky fix",
    prompt: "fix the flaky test",
    useWorktree: true,
    config: { model: "opus", effort: "high", permissionMode: "acceptEdits" },
  });
  assert.equal(resultJson(result).session.id, "s_new");
  assert.equal(resultJson(result).session.model, "opus");
  assert.equal(resultJson(result).session.effort, "high");
  assert.equal(resultJson(result).session.costBudgetUsd, null);
  assert.equal(resultJson(result).session.maxToolCalls, null);
});

test("create_session fails closed on explicit effort with an older control plane and preserves omitted-effort creation", async () => {
  const older = makeDeps(() => ({
    status: 200,
    body: { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControlReasoningEffort - 1 },
  }));
  const rejected = await callTool(older.deps, "create_session", {
    runnerId: "r1", agentId: "claude-code", workspaceId: "ws", model: "opus", effort: "high",
  });
  assert.equal(rejected.isError, true);
  assert.match(resultText(rejected), /requires control plane protocol v138/u);
  assert.match(resultText(rejected), /omit effort to preserve default resolution/u);
  assert.equal(older.calls.length, 1);
  assert.equal(older.calls[0]!.url, `${CP_URL}/api/compatibility`);

  const omitted = makeDeps(() => ({
    status: 201, body: { id: "s_default", title: "t", status: "queued", runnerId: "r1" },
  }));
  const created = await callTool(omitted.deps, "create_session", {
    runnerId: "r1", agentId: "claude-code", workspaceId: "ws", model: "opus",
  });
  assert.equal(created.isError, undefined);
  assert.equal(omitted.calls.length, 1);
  assert.deepEqual((omitted.calls[0]!.body as { config: unknown }).config, { model: "opus" });
});

test("create_session polls an exact pending spawn approval until it can create the child", async () => {
  let attempts = 0;
  const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/compatibility")
    ? { status: 200, body: { protocolVersion: 185, spawnApprovalAbandonmentMs: 600_000 } }
    : ++attempts === 1
      ? { status: 428, body: { error: "Child creation requires approval" } }
      : { status: 201, body: { id: "s_child", parentSessionId: SELF_ID } });
  const sleeps: number[] = [];
  deps.sleep = async (ms) => { sleeps.push(ms); };
  const result = await callTool(deps, "create_session", {
    runnerId: "r1", agentId: "claude-code", workspaceId: "workspace",
  });
  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).session.id, "s_child");
  const creates = calls.filter((call) => call.method === "POST");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0]!.body, creates[1]!.body);
  assert.deepEqual(sleeps, [1000]);
});

test("create tools return the control plane's retry instruction when an approval outlives the poll window", async () => {
  const pending = `Child creation requires approval in parent session ${SELF_ID} (request spawn_abc). ` +
    "Retry the same request after approval.";
  const cases = [
    { name: "create_session", args: { runnerId: "r1", agentId: "claude-code", workspaceId: "workspace" }, created: { id: "s_child" } },
    { name: "create_run", args: { runnerId: "r", workspaceId: "w", agentIds: ["a"], task: "Build" }, created: { run: { id: "run" }, sessions: [] } },
    { name: "create_workflow_run", args: { runnerId: "r", workspaceId: "w", workflowId: "workflow", task: "Build" }, created: { run: { id: "run" }, sessions: [] } },
  ];
  // Each control plane generation answers the fence probe differently: a newer one publishes the
  // spawn fence it enforces; an older one (or one that cannot be reached) enforces the 30 s hook
  // fence, so the note must keep quoting that.
  const hookFence = /Do not wait for the approval first: if no identical request arrives within 30 s, the approval is withdrawn as abandoned\.$/;
  const controlPlanes = [
    { label: "newer", compatibility: { status: 200, body: { protocolVersion: 185, spawnApprovalAbandonmentMs: 600_000 } },
      withdrawal: /Do not wait for the approval first or end your turn: the approval is withdrawn as abandoned if no identical request arrives within 600 s, and shortly after this session's turn ends\.$/ },
    { label: "older", compatibility: { status: 200, body: { protocolVersion: 185 } }, withdrawal: hookFence },
    { label: "unreachable", compatibility: { status: 503, body: { error: "unavailable" } }, withdrawal: hookFence },
    { label: "malformed", compatibility: { status: 200, body: { protocolVersion: 185, spawnApprovalAbandonmentMs: "600000" } },
      withdrawal: hookFence },
  ];
  for (const controlPlane of controlPlanes) {
    for (const { name, args, created } of cases) {
      const label = `${name} against a ${controlPlane.label} control plane`;
      let approved = false;
      let clock = 0;
      const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/compatibility")
        ? controlPlane.compatibility
        : approved
          ? { status: 201, body: created }
          : { status: 428, body: { error: pending } });
      deps.now = () => clock;
      deps.sleep = async (ms) => { clock += ms; };

      const result = await callTool(deps, name, args);
      assert.equal(result.isError, true, label);
      const text = resultText(result);
      assert.ok(text.startsWith(`HTTP 428: ${pending}`), `${label} surfaces the control plane text: ${text}`);
      assert.match(text, new RegExp(`As your next action, repeat the same ${name} call`), label);
      assert.match(text, controlPlane.withdrawal, label);
      assert.equal(text.includes("wollipog session create"), name === "create_session", label);
      assert.match(TOOLS.find((tool) => tool.name === name)!.description,
        /stating how long the control plane keeps it pending between calls; repeat the identical call promptly, without ending your turn/, label);
      assert.ok(clock <= SPAWN_APPROVAL_POLL_WINDOW_MS, `${label} returned within the window`);
      const creates = () => calls.filter((call) => call.method === "POST");
      assert.equal(creates().length, SPAWN_APPROVAL_POLL_WINDOW_MS / 1000 + 1, label);
      const probes = calls.filter((call) => call.url === `${CP_URL}/api/compatibility`);
      assert.equal(probes.length, 1, `${label} probes the fence once`);
      assert.equal(calls.length, creates().length + 1, label);
      assert.equal(probes[0]!.method, "GET", label);
      assert.equal(probes[0]!.headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], SELF_ID, `${label} probes as the calling session`);
      const polled = calls.length;

      approved = true;
      const retried = await callTool(deps, name, args);
      assert.equal(retried.isError, undefined, label);
      assert.equal(calls.length, polled + 1, `${label} creates on the identical retry without probing`);
      assert.deepEqual(creates().map((call) => call.body), Array(creates().length).fill(creates()[0]!.body), label);
    }
  }
});

test("create_session arms budgets before the initial prompt can execute", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 201, body: { id: "s_new", parentSessionId: SELF_ID, costBudgetUsd: 5, maxToolCalls: 40 },
  }));
  const result = await callTool(deps, "create_session", {
    runnerId: "r1",
    agentId: "claude-code",
    workspacePath: "/repos/x",
    model: "opus",
    costBudgetUsd: 5,
    maxToolCalls: 40,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions`);
  assert.deepEqual((calls[0]!.body as any).config, { model: "opus", costBudgetUsd: 5, maxToolCalls: 40 });
  assert.equal(resultJson(result).session.costBudgetUsd, 5);
  assert.equal(resultJson(result).session.maxToolCalls, 40);
  assert.equal(resultJson(result).session.parentSessionId, SELF_ID);
  const description = TOOLS.find((tool) => tool.name === "create_session")!.description;
  assert.match(description, /Omitted cost and tool-call limits remain unlimited/);
  assert.match(description, /explicit 0 opts out/);
  assert.match(description, /value or null \(none\)/);
});

test("prompt_session -> POST /api/sessions/:id/prompt {text}", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_2", status: "running" } }));
  await callTool(deps, "prompt_session", { sessionId: "s_2", text: "carry on" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_2/prompt`);
  assert.deepEqual(calls[0]!.body, { text: "carry on" });
});

test("stop_session -> POST /api/sessions/:id/stop", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_2", status: "stopped" } }));
  await callTool(deps, "stop_session", { sessionId: "s_2" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_2/stop`);
});

test("stop_background_job -> POST /api/sessions/:id/background-jobs/:jobId/stop, and refuses its own session (#1780)", async () => {
  const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/compatibility")
    ? { status: 200, body: { protocolVersion: 190 } }
    : { status: 200, body: { sessionId: "s_child", jobId: "b 1/x", outcome: "stopped", terminalStatus: "killed" } });
  deps.orchestrator = true;
  const result = await callTool(deps, "stop_background_job", { sessionId: "s_child", jobId: "b 1/x" });
  assert.equal(result.isError, undefined);
  const stop = calls.find((call) => call.method === "POST")!;
  assert.equal(stop.url, `${CP_URL}/api/sessions/s_child/background-jobs/b%201%2Fx/stop`);
  assert.equal(stop.body, undefined);
  assert.deepEqual(JSON.parse(resultText(result)),
    { sessionId: "s_child", jobId: "b 1/x", outcome: "stopped", terminalStatus: "killed" });

  const before = calls.length;
  assert.equal((await callTool(deps, "stop_background_job", { sessionId: SELF_ID, jobId: "b1" })).isError, true);
  assert.equal((await callTool(deps, "stop_background_job", { sessionId: "s_child" })).isError, true);
  assert.equal(calls.length, before, "refused before contacting the control plane");

  const old = makeDeps(() => ({ status: 200, body: { protocolVersion: 189 } }));
  const refused = await callTool(old.deps, "stop_background_job", { sessionId: "s_child", jobId: "b1" });
  assert.equal(refused.isError, true);
  assert.match(resultText(refused), /requires control plane protocol v190/);
  assert.equal(old.calls.some((call) => call.method === "POST"), false);

  const denied = makeDeps((call) => call.url.endsWith("/api/compatibility")
    ? { status: 200, body: { protocolVersion: 190 } }
    : { status: 403, body: { error: "only the session owner or its controlling Orchestrator may stop its background jobs" } });
  const deniedResult = await callTool(denied.deps, "stop_background_job", { sessionId: "s_grandchild", jobId: "b1" });
  assert.equal(deniedResult.isError, true);
  assert.match(resultText(deniedResult), /controlling Orchestrator/);
});

test("session results list unfinished background jobs by id for stop_background_job (#1780)", async () => {
  const { deps } = makeDeps(() => ({ status: 200, body: { session: {
    id: "s_child", status: "queued",
    backgroundJobs: [
      { id: "monitor-1", launchType: "monitor", parentTurnId: "turn-1", registeredAt: 10 },
      { id: "agent-1", launchType: "agent", parentTurnId: "turn-1", registeredAt: 11, terminalStatus: "completed" },
    ],
  } } }));
  const result = await callTool(deps, "get_session", { sessionId: "s_child" });
  const session = JSON.parse(resultText(result)).session;
  assert.deepEqual(session.unfinishedBackgroundJobs,
    [{ id: "monitor-1", launchType: "monitor", parentTurnId: "turn-1", registeredAt: 10 }]);
});

test("archive_session sends only archived true, preserves scoped errors, and refuses self", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_child", archived: true } }));
  deps.orchestrator = true;
  const result = await callTool(deps, "archive_session", { sessionId: "s_child" });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_child/archive`);
  assert.deepEqual(calls[0]!.body, { archived: true });
  assert.equal((await callTool(deps, "archive_session", { sessionId: SELF_ID })).isError, true);
  assert.equal(calls.length, 1);
  const denied = makeDeps(() => ({ status: 404, body: { error: "session not found" } }));
  assert.equal((await callTool(denied.deps, "archive_session", { sessionId: "s_sibling" })).isError, true);
});

test("compact archive and inspection responses retain lifecycle progress without inventing legacy state", async () => {
  for (const archiveStatus of ["stop_pending", "stop_failed", null, undefined]) {
    const session = { id: "s_child", archived: archiveStatus === null, archiveStatus };
    const { deps } = makeDeps((call) => ({ status: call.method === "POST" && archiveStatus ? 202 : 200,
      body: call.url.endsWith("/api/sessions") ? { sessions: [session] } : call.method === "GET" ? { session } : session }));
    for (const name of ["archive_session", "get_session", "list_sessions"]) {
      const result = resultJson(await callTool(deps, name, { sessionId: "s_child" }));
      const mapped = name === "list_sessions" ? result.sessions[0] : result.session;
      assert.equal(mapped.archiveStatus, archiveStatus, name);
      assert.equal(mapped.archived, archiveStatus === null, name);
      if (archiveStatus === undefined) assert.equal(Object.hasOwn(mapped, "archiveStatus"), false);
    }
  }
});

test("run creation tools keep the exact batch request alive until spawn approval resolves", async () => {
  for (const name of ["create_run", "create_workflow_run"]) {
    for (const terminal of [201, 403]) {
      let remaining = 2;
      let sleeps = 0;
      const { deps, calls } = makeDeps((call) => call.method === "GET"
        ? { status: 200, body: { protocolVersion: 185, spawnApprovalAbandonmentMs: 600_000 } }
        : remaining-- > 0
          ? { status: 428, body: { error: "Child approval required" } }
          : { status: terminal, body: terminal === 201 ? { run: { id: "run" }, sessions: [] } : { error: "Rejected" } });
      deps.sleep = async (ms) => { assert.equal(ms, 1000); sleeps++; };
      const result = await callTool(deps, name, { runnerId: "r", workspaceId: "w", agentIds: ["a"], workflowId: "workflow", task: "Build" });
      assert.equal(result.isError === true, terminal === 403);
      assert.equal(sleeps, 2);
      const creates = calls.filter((call) => call.method === "POST");
      assert.equal(creates.length, 3);
      assert.deepEqual(creates.map((call) => call.body), Array(3).fill(creates[0]!.body));
    }
  }
});

test("set_guardrails -> POST /api/sessions/:id/config with ONLY the given guardrail keys", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_2", costBudgetUsd: 3, maxChildSessions: 8 } }));
  const result = await callTool(deps, "set_guardrails", { sessionId: "s_2", costBudgetUsd: 3, maxChildSessions: 8 });
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_2/config`);
  assert.deepEqual(calls[0]!.body, { costBudgetUsd: 3, maxChildSessions: 8 }, "maxToolCalls omitted when not given");
  assert.equal(resultJson(result).session.maxChildSessions, 8);
});

test("set_guardrails lets a session change only its own live-child limit", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 200,
    body: { id: SELF_ID, maxChildSessions: 8 },
  }));
  const result = await callTool(deps, "set_guardrails", {
    sessionId: SELF_ID,
    maxChildSessions: 8,
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/${SELF_ID}/config`);
  assert.deepEqual(calls[0]!.body, { maxChildSessions: 8 });
});

test("restart_session uses the descendant restart route and refuses self", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_2", status: "starting" } }));
  assert.equal((await callTool(deps, "restart_session", { sessionId: "s_2" })).isError, undefined);
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_2/restart`);
  assert.equal((await callTool(deps, "restart_session", { sessionId: SELF_ID })).isError, true);
  assert.equal(calls.length, 1);
});

test("create_run -> POST /api/runs with the full body", async () => {
  const { deps, calls } = makeDeps(() => ({
    status: 201,
    body: { run: { id: "r_9", title: "compare", sessionIds: ["s_a", "s_b"] }, sessions: [{ id: "s_a" }, { id: "s_b" }] },
  }));
  const result = await callTool(deps, "create_run", {
    runnerId: "r1",
    workspaceId: "ws",
    agentIds: ["claude-code", "codex"],
    task: "implement X",
    title: "compare",
    costBudgetUsd: 2,
    maxToolCalls: 50,
  });
  assert.equal(calls[0]!.url, `${CP_URL}/api/runs`);
  assert.deepEqual(calls[0]!.body, {
    runnerId: "r1",
    workspaceId: "ws",
    agentIds: ["claude-code", "codex"],
    task: "implement X",
    title: "compare",
    costBudgetUsd: 2,
    maxToolCalls: 50,
  });
  assert.deepEqual(resultJson(result).run.sessionIds, ["s_a", "s_b"]);
});

test("workflow reads are bounded, mapped, and routed to the inspection API", async () => {
  const { deps, calls } = makeDeps((call) => {
    if (call.url.includes("/api/workflows?")) return { status: 200, body: [{ workflowId: "wf", version: 2, name: "Review", nodes: [{ nodeId: "build", kind: "agent", role: "builder", prompt: "secretly long" }] }] };
    if (call.url.endsWith("/api/workflows/wf")) return {
      status: 200,
      body: {
        workflowId: "wf", version: 2, name: "Review", nodes: [{
          nodeId: "build", kind: "agent", role: "builder", agentId: "claude", prompt: "x".repeat(500),
          inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 60_000,
        }],
        edges: Array.from({ length: 150 }, (_, index) => ({ edgeId: `edge-${index}`, from: "build", to: "build", on: "success" })),
      },
    };
    if (call.url.includes("/api/workflow-instances/i1")) return {
      status: 200,
      body: { instanceId: "i1", workflowId: "wf", workflowVersion: 2, runId: "r1", status: "running", nodeStates: [], definition: { workflowId: "wf", version: 2, name: "Review", nodes: [], edges: [] }, attempts: [], events: [] },
    };
    return { status: 404, body: { error: "unexpected" } };
  });
  const listed = resultJson(await callTool(deps, "list_workflows", { limit: 5 }));
  assert.equal(calls[0]!.url, `${CP_URL}/api/workflows?limit=5`);
  assert.equal(listed.workflows[0].nodes[0].prompt, undefined, "list summaries omit graph prompt bodies");
  const definition = resultJson(await callTool(deps, "get_workflow", { workflowId: "wf" }));
  assert.equal(definition.workflow.edges.length, 150, "exact graph inspection does not apply the generic list cap");
  assert.equal(definition.workflow.nodes[0].promptPreview.length, 401);
  assert.equal(definition.workflow.nodes[0].promptTruncated, true);
  const node = resultJson(await callTool(deps, "get_workflow_node", { workflowId: "wf", nodeId: "build" }));
  assert.equal(node.node.prompt.length, 500, "single-node inspection preserves the complete validated prompt");
  const detail = resultJson(await callTool(deps, "get_workflow_instance", { instanceId: "i1" }));
  assert.equal(calls[3]!.url, `${CP_URL}/api/workflow-instances/i1`);
  assert.equal(detail.instance.definition.workflowId, "wf");
});

test("governance policy inspection and authoring tools preserve exact validated shapes", async () => {
  const stored = {
    policyId: "review:protected", name: "Protected review", effect: "ask", priority: 50, enabled: true,
    scope: { runnerId: "runner", branch: "main" }, conditions: { statuses: ["running"], minToolCalls: 2 },
    askTimeout: 90,
    createdAt: 1, updatedAt: 2,
  };
  const { deps, calls } = makeDeps((call) => {
    if (call.method === "GET") return { status: 200, body: { policies: [stored] } };
    if (call.method === "PUT") return { status: 200, body: { ...call.body, createdAt: 1, updatedAt: 3 } };
    if (call.method === "DELETE") return { status: 204, body: null };
    return { status: 500, body: { error: "unexpected" } };
  });
  const listed = resultJson(await callTool(deps, "list_governance_policies"));
  assert.deepEqual(listed.policies[0].scope, stored.scope);
  assert.equal(listed.truncated, false);
  const exact = resultJson(await callTool(deps, "get_governance_policy", { policyId: stored.policyId }));
  assert.equal(exact.policy.conditions.minToolCalls, 2);
  const written = resultJson(await callTool(deps, "upsert_governance_policy", stored));
  assert.equal(written.policy.updatedAt, 3);
  const removed = resultJson(await callTool(deps, "delete_governance_policy", { policyId: stored.policyId }));
  assert.deepEqual(removed, { deleted: true, policyId: stored.policyId });
  assert.deepEqual(calls.map((call) => call.method), ["GET", "GET", "PUT", "DELETE"]);
  assert.equal(calls[2]!.url, `${CP_URL}/api/governance/policies/review%3Aprotected`);
  assert.deepEqual(calls[2]!.body, {
    policyId: stored.policyId,
    name: stored.name,
    effect: stored.effect,
    priority: stored.priority,
    enabled: stored.enabled,
    scope: stored.scope,
    conditions: stored.conditions,
    askTimeout: stored.askTimeout,
  });
});

test("Parent Control MCP reports when descendant requests exceed its response bound", async () => {
  const source = Array.from({ length: 129 }, (_, index) => ({
    sessionId: `child-${index}`,
    occurrenceId: `request-${index}`,
  }));
  const { deps } = makeDeps(() => ({ status: 200, body: { requests: source } }));
  deps.orchestrator = true;

  const listed = resultJson(await callTool(deps, "list_descendant_requests")) as {
    requests: typeof source;
    truncated: boolean;
    limit: number;
  };
  assert.equal(listed.requests.length, 128);
  assert.deepEqual(listed.requests, source.slice(0, 128));
  assert.equal(listed.truncated, true);
  assert.equal(listed.limit, 128);

  const exact = makeDeps(() => ({ status: 200, body: { requests: source.slice(0, 128) } }));
  exact.deps.orchestrator = true;
  assert.deepEqual(resultJson(await callTool(exact.deps, "list_descendant_requests")), {
    requests: source.slice(0, 128),
    truncated: false,
    limit: 128,
  });
});

test("workflow authoring and execution tools route exact mutation bodies", async () => {
  const { deps, calls } = makeDeps((call) => {
    if (call.url.endsWith("/api/workflow-runs")) return { status: 201, body: { run: { id: "r1", title: "Run", sessionIds: ["s1"] }, sessions: [{ id: "s1" }], instance: { instanceId: "i1", nodeStates: [], definition: { nodes: [], edges: [] }, attempts: [], events: [] } } };
    if (call.url.includes("/dispatch")) return { status: 200, body: { attempt: { attemptId: "a1" }, idempotent: false } };
    if (call.url.endsWith("/api/artifacts")) return { status: 201, body: { artifactId: "art1", data: "large", kind: "patch" } };
    if (call.url.includes("/complete") || call.url.includes("/resolve")) return { status: 200, body: { instanceId: "i1", nodeStates: [], definition: { nodes: [], edges: [] }, attempts: [], events: [] } };
    return { status: 201, body: { workflowId: "wf", version: call.url.includes("/versions") ? 2 : 1, name: "Flow", nodes: [], edges: [] } };
  });
  const spec = { name: "Flow", maxTransitions: 4, nodes: [{ nodeId: "work" }], edges: [] };
  await callTool(deps, "create_workflow_definition", spec);
  await callTool(deps, "create_workflow_version", { workflowId: "wf", ...spec, name: "Flow v2" });
  await callTool(deps, "create_workflow_run", {
    runnerId: "runner", workspaceId: "ws", workflowId: "wf", task: "Do it", agentBindings: { worker: "claude" },
  });
  await callTool(deps, "dispatch_workflow_node", { instanceId: "i1", nodeId: "work", dispatchKey: "i1:work:1" });
  const artifact = resultJson(await callTool(deps, "create_workflow_artifact", {
    runId: "r1", sessionId: "s1", kind: "patch", name: "change.diff", mimeType: "text/x-diff", encoding: "utf8", data: "+done",
  }));
  await callTool(deps, "complete_workflow_attempt", { attemptId: "a1", outcome: "success", outputs: { patch: "art1" } });
  await callTool(deps, "resolve_workflow_gate", { instanceId: "i1", nodeId: "gate", outcome: "success" });

  assert.equal(calls[0]!.url, `${CP_URL}/api/workflows`);
  assert.equal(calls[1]!.url, `${CP_URL}/api/workflows/wf/versions`);
  assert.deepEqual(calls[2]!.body.agentBindings, { worker: "claude" });
  assert.deepEqual(calls[3]!.body, { dispatchKey: "i1:work:1" });
  assert.equal(artifact.artifact.data, undefined, "artifact payload is never echoed into model context");
  assert.deepEqual(calls[5]!.body, { outcome: "success", outputs: { patch: "art1" } });
  assert.deepEqual(calls[6]!.body, { outcome: "success" });
});

/* -------------------------------------------------------------------------- */
/* Auth header + token hygiene                                                 */
/* -------------------------------------------------------------------------- */

test("every request carries exact session provenance and bearer auth when configured", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { sessions: [] } }));
  await callTool(deps, "list_sessions");
  assert.equal(calls[0]!.headers["authorization"], `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], SELF_ID);

  const bare = makeDeps(() => ({ status: 200, body: { sessions: [] } }), "");
  await callTool(bare.deps, "list_sessions");
  assert.equal(bare.calls[0]!.headers["authorization"], undefined);
  assert.equal(bare.calls[0]!.headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], SELF_ID);
});

test("every CP round-trip carries an abort timeout signal (no ~300s undici stall on a half-open link)", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { sessions: [] } }));
  await callTool(deps, "list_sessions");
  await callTool(deps, "prompt_session", { sessionId: "s_2", text: "go" });
  for (const call of calls) {
    assert.ok(call.signal instanceof AbortSignal, `${call.method} ${call.url} must be time-bounded`);
    assert.equal(call.signal.aborted, false, "not already aborted at dispatch time");
  }
});

test("the token never appears in any tool result text (success or error)", async () => {
  const { deps } = makeDeps(() => ({ status: 500, body: { error: "boom" } }));
  for (const tool of ["list_runners", "list_sessions", "list_runs"]) {
    const result = await callTool(deps, tool);
    assert.ok(!resultText(result).includes(TOKEN), `${tool} must not leak the token`);
  }
  const ok = makeDeps(() => ({ status: 200, body: { sessions: [] } }));
  const result = await callTool(ok.deps, "list_sessions");
  assert.ok(!resultText(result).includes(TOKEN));
});

/* -------------------------------------------------------------------------- */
/* Guards: refuse before any fetch                                             */
/* -------------------------------------------------------------------------- */

test("self-targeting mutations refuse with isError and make NO fetch", async () => {
  for (const [tool, args] of [
    ["prompt_session", { sessionId: SELF_ID, text: "hi" }],
    ["stop_session", { sessionId: SELF_ID }],
  ] as const) {
    const { deps, calls } = makeDeps();
    const result = await callTool(deps, tool, args as Record<string, unknown>);
    assert.equal(result.isError, true, tool);
    assert.match(resultText(result), /my own session/, tool);
    assert.equal(calls.length, 0, `${tool} must not reach the control plane`);
  }

  const { deps, calls } = makeDeps();
  const guardrails = await callTool(deps, "set_guardrails", { sessionId: SELF_ID, costBudgetUsd: 1 });
  assert.equal(guardrails.isError, true);
  assert.match(resultText(guardrails), /only its own maxChildSessions/);
  assert.equal(calls.length, 0, "self spend/tool changes must not reach the control plane");
});

test("create_session refuses bypassPermissions and a missing workspace — no fetch", async () => {
  const base = { runnerId: "r1", agentId: "claude-code", workspaceId: "ws" };
  for (const [args, why] of [
    [{ ...base, permissionMode: "bypassPermissions" }, /bypassPermissions/],
    [{ runnerId: "r1", agentId: "claude-code" }, /workspaceId or workspacePath/],
  ] as const) {
    const { deps, calls } = makeDeps();
    const result = await callTool(deps, "create_session", args as Record<string, unknown>);
    assert.equal(result.isError, true);
    assert.match(resultText(result), why);
    assert.equal(calls.length, 0);
  }
});

test("set_guardrails without either limit refuses — no fetch", async () => {
  const { deps, calls } = makeDeps();
  const result = await callTool(deps, "set_guardrails", { sessionId: "s_2" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /costBudgetUsd, maxToolCalls, or maxChildSessions/);
  assert.equal(calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* HTTP error mapping                                                          */
/* -------------------------------------------------------------------------- */

test("REST errors map to isError results carrying the status + CP error text verbatim", async () => {
  for (const [status, error] of [
    [404, "session not found"],
    [409, "cost budget reached — choose Continue or Stop before sending another prompt"],
    [500, "internal error"],
  ] as const) {
    const { deps } = makeDeps(() => ({ status, body: { error } }));
    const result = await callTool(deps, "prompt_session", { sessionId: "s_2", text: "go" });
    assert.equal(result.isError, true);
    const text = resultText(result);
    assert.ok(text.includes(`HTTP ${status}`), text);
    assert.ok(text.includes(error), "the CP's own error text is preserved verbatim");
  }
});

test("a network-level fetch rejection maps to an isError result", async () => {
  const failingFetch: McpFetch = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:4317");
  };
  const deps: McpDeps = { fetch: failingFetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: TOKEN };
  const result = await callTool(deps, "list_sessions");
  assert.equal(result.isError, true);
  assert.match(resultText(result), /ECONNREFUSED/);
});

test("a non-JSON error body still surfaces the status (no crash)", async () => {
  const htmlFetch: McpFetch = async () => ({
    ok: false,
    status: 502,
    text: async () => "<html>Bad Gateway</html>",
  });
  const deps: McpDeps = { fetch: htmlFetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: "" };
  const result = await callTool(deps, "list_runs");
  assert.equal(result.isError, true);
  assert.match(resultText(result), /HTTP 502/);
});

test("attach_session_artifact uploads a file from disk and returns metadata only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-tool-"));
  try {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("desktop-after")]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = join(dir, "desktop after.png");
    writeFileSync(file, bytes);
    let stored: Record<string, unknown> = { sha256, sizeBytes: bytes.length };
    const { deps, calls } = makeDeps((call) => call.url.endsWith("/api/compatibility")
      ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
      : { status: 201, body: {
          artifactId: "art_1", sessionId: SELF_ID, kind: "screenshot", name: call.body.name,
          mimeType: call.body.mimeType, encoding: "base64", createdAt: 1, ...stored,
        } });

    const listed = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps);
    assert.ok((listed!.result as { tools: { name: string }[] }).tools.some((tool) => tool.name === "attach_session_artifact"));

    const attached = await callTool(deps, "attach_session_artifact", { path: file });
    assert.equal(attached.isError, undefined, resultText(attached));
    const upload = calls.at(-1)!;
    assert.equal(upload.method, "POST");
    assert.equal(upload.url, `${CP_URL}/api/sessions/${SELF_ID}/artifacts/screenshots`);
    assert.deepEqual(Object.keys(upload.body).sort(), ["data", "mimeType", "name"],
      "kind, encoding, and session are fixed by the route, never sent by the client");
    assert.equal(upload.body.name, "desktop after.png");
    assert.equal(upload.body.mimeType, "image/png", "the type is sniffed from the content");
    assert.equal(upload.body.data, bytes.toString("base64"));
    assert.deepEqual(resultJson(attached), { artifact: {
      artifactId: "art_1", sessionId: SELF_ID, kind: "screenshot", name: "desktop after.png",
      mediaType: "image/png", sizeBytes: bytes.length, sha256,
    } });
    assert.equal(attached.content.length, 1);
    assert.ok(!resultText(attached).includes(bytes.toString("base64")), "the file's bytes never reach the tool result");

    const named = await callTool(deps, "attach_session_artifact", { path: file, name: "  Desktop After  " });
    assert.equal(calls.at(-1)?.body.name, "Desktop After");
    assert.equal(named.isError, undefined);

    // The digest an agent cites must be the digest of what was stored.
    stored = { sha256: "0".repeat(64), sizeBytes: bytes.length };
    const altered = await callTool(deps, "attach_session_artifact", { path: file });
    assert.equal(altered.isError, true);
    assert.match(resultText(altered), /stored different bytes/u);
    assert.ok(!resultText(altered).includes("art_1"), "an unusable artifact id is not handed back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach_session_artifact uploads video to the gated route without returning its bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-video-tool-"));
  try {
    const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84]), Buffer.from("webm"), Buffer.alloc(8)]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = join(dir, "video.txt");
    writeFileSync(file, bytes);
    const old = makeDeps((call) => call.url.endsWith("/api/compatibility")
      ? { status: 200, body: { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionVideoArtifactAttach - 1 } }
      : { status: 201, body: {} });
    const refused = await callTool(old.deps, "attach_session_artifact", { path: file });
    assert.equal(refused.isError, true);
    assert.match(resultText(refused), new RegExp(
      `requires control plane protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL.sessionVideoArtifactAttach}`, "u",
    ));
    assert.equal(old.calls.some((call) => call.method === "POST"), false);

    const current = makeDeps((call) => call.url.endsWith("/api/compatibility")
      ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
      : { status: 201, body: { artifactId: "art_video", sessionId: SELF_ID, kind: "video",
          name: call.body.name, mimeType: call.body.mimeType, sizeBytes: bytes.length, sha256 } });
    const attached = await callTool(current.deps, "attach_session_artifact", { path: file });
    assert.equal(attached.isError, undefined, resultText(attached));
    const upload = current.calls.find((call) => call.method === "POST")!;
    assert.equal(upload.url, `${CP_URL}/api/sessions/${SELF_ID}/artifacts/videos`);
    assert.equal(upload.body.mimeType, "video/webm");
    assert.deepEqual(resultJson(attached).artifact.kind, "video");
    assert.equal(resultText(attached).includes(bytes.toString("base64")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("attach_session_artifact refuses before reading or uploading when the request cannot succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-tool-"));
  try {
    const file = join(dir, "after.png");
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("x")]));

    const own = makeDeps(() => ({ status: 200, body: { protocolVersion: PROTOCOL_VERSION } }));
    const foreign = await callTool(own.deps, "attach_session_artifact", { path: file, sessionId: "someone-else" });
    assert.equal(foreign.isError, true);
    assert.match(resultText(foreign), /only to its own session/u);
    assert.equal(own.calls.length, 0, "a cross-session attempt makes no request at all");

    const orchestrator = makeDeps();
    orchestrator.deps.orchestrator = true;
    assert.equal((await callTool(orchestrator.deps, "attach_session_artifact", { path: file })).isError, true,
      "an Orchestrator reviews evidence; it does not produce it");
    assert.equal(orchestrator.calls.length, 0);

    const old = makeDeps(() => ({
      status: 200, body: { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionArtifactFileAttach - 1 },
    }));
    const outdated = await callTool(old.deps, "attach_session_artifact", { path: file });
    assert.equal(outdated.isError, true);
    assert.match(resultText(outdated), /requires control plane protocol v\d+.*Update the Wollipog control plane/u);
    assert.deepEqual(old.calls.map((call) => call.url), [`${CP_URL}/api/compatibility`],
      "an older control plane is named, not probed with an upload and not worked around");

    const current = makeDeps(() => ({ status: 200, body: { protocolVersion: PROTOCOL_VERSION } }));
    for (const [args, expected] of [
      [{}, /path is required/u],
      [{ path: file, name: "   " }, /non-empty string/u],
      [{ path: "relative/after.png" }, /absolute file path is required/u],
      [{ path: join(dir, "absent.png") }, /file not found/u],
      [{ path: dir }, /not a regular file/u],
    ] as const) {
      const refused = await callTool(current.deps, "attach_session_artifact", args);
      assert.equal(refused.isError, true, JSON.stringify(args));
      assert.match(resultText(refused), expected, JSON.stringify(args));
    }
    assert.ok(current.calls.every((call) => call.method === "GET"), "an unusable file is never uploaded");

    // A request that dies in transit may already have been committed. The tool must say so and say
    // what is safe, rather than report a plain failure that invites a blind duplicate.
    const dropped = makeDeps((call) => {
      if (call.url.endsWith("/api/compatibility")) return { status: 200, body: { protocolVersion: PROTOCOL_VERSION } };
      throw new Error("socket hang up");
    });
    const unknown = await callTool(dropped.deps, "attach_session_artifact", { path: file });
    assert.equal(unknown.isError, true);
    assert.match(resultText(unknown), /outcome is unknown\. Attach the same file again/u);
    // Committed, success status sent, body lost: the same unknown outcome one step later. It must
    // not be reported as the control plane having stored different bytes.
    for (const body of [null, "", { ok: true }, { artifactId: "art_1" }]) {
      const truncated = makeDeps((call) => call.url.endsWith("/api/compatibility")
        ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
        : { status: 201, body });
      const lost = await callTool(truncated.deps, "attach_session_artifact", { path: file });
      assert.equal(lost.isError, true, JSON.stringify(body));
      assert.match(resultText(lost), /answer did not arrive intact\. The upload's outcome is unknown\. Attach the same file again/u);
      assert.doesNotMatch(resultText(lost), /stored different bytes/u, JSON.stringify(body));
    }
    const rejected = makeDeps((call) => call.url.endsWith("/api/compatibility")
      ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
      : { status: 409, body: { error: "this session already has 256 attached screenshots" } });
    assert.doesNotMatch(resultText(await callTool(rejected.deps, "attach_session_artifact", { path: file })),
      /outcome is unknown/u, "a definite refusal is not dressed up as uncertainty");

    // A paired device has no session of its own, so it names one; nothing is refused client-side.
    const device = makeDeps((call) => call.url.endsWith("/api/compatibility")
      ? { status: 200, body: { protocolVersion: PROTOCOL_VERSION } }
      : { status: 404, body: { error: "session not found" } });
    device.deps.selfSessionId = "";
    device.deps.actorHeader = null;
    assert.match(resultText(await callTool(device.deps, "attach_session_artifact", { path: file })), /sessionId is required/u);
    const denied = await callTool(device.deps, "attach_session_artifact", { path: file, sessionId: "s_hidden" });
    assert.match(resultText(denied), /HTTP 404: session not found/u, "the control plane's answer is relayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held child reports its hold and recovery action through get_session and list_descendant_requests (#1650)", async () => {
  const recovery = {
    recoveryId: "worktree-recovery:switched",
    detectedAt: 5,
    selectedPath: "/repos/x/.agent-worktrees/s_child",
    expectedBranch: "agent/s_child",
    detail: "the selected worktree could not be verified before a live turn: it is now on branch fix/x instead of agent/s_child",
  };
  const hold = {
    kind: "worktree_recovery",
    holdId: recovery.recoveryId,
    since: 5,
    reason: recovery.detail,
    recoveryAction: "Restore branch agent/s_child in /repos/x/.agent-worktrees/s_child and select that worktree again with select_worktree.",
    heldResumes: [{ kind: "workflow_decision_resolution", occurrenceId: "wd_1", since: 6 }],
  };
  const blockedChild = {
    sessionId: "s_child", sessionTitle: "Held child", runnerId: "r1", runnerOnline: true, eventEpoch: 0,
    status: "input_required", holds: [hold],
  };
  const { deps } = makeDeps((call) => call.url.endsWith("/descendant-requests")
    ? { status: 200, body: { requests: [], blockedChildren: [blockedChild] } }
    : { status: 200, body: { session: {
      id: "s_child", title: "Held child", status: "input_required", pendingApproval: null,
      worktreeRecovery: recovery, holds: [hold],
    } } });
  deps.orchestrator = true;
  const session = resultJson(await callTool(deps, "get_session", { sessionId: "s_child" })).session;
  assert.deepEqual(session.holds, [hold], "the hold and its recovery action survive the field map");
  assert.deepEqual(session.worktreeRecovery, recovery);
  assert.deepEqual(resultJson(await callTool(deps, "list_descendant_requests")), {
    requests: [], truncated: false, limit: 128, blockedChildren: [blockedChild],
  });

  // A session with nothing holding it carries no hold field at all.
  const idle = makeDeps(() => ({ status: 200, body: { session: { id: "s_idle", title: "Idle", status: "idle" } } }));
  const plain = resultJson(await callTool(idle.deps, "get_session", { sessionId: "s_idle" })).session;
  assert.equal(Object.hasOwn(plain, "holds"), false);
  assert.equal(plain.worktreeRecovery, null);
});
