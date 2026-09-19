import assert from "node:assert/strict";
import { test } from "node:test";
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
  const { deps, calls } = makeDeps(() => ({
    status: 200, body: { receipt, mimeType: "image/png", sizeBytes: bytes.byteLength, data },
  }));
  assert.equal((await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" })).isError, true,
  "only an Orchestrator can read descendant evidence");
  assert.equal(calls.length, 0);

  deps.orchestrator = true;
  const reviewed = await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(calls.at(-1)?.url, `${CP_URL}/api/sessions/${SELF_ID}/descendant-requests/review-ui-evidence`);
  assert.deepEqual(calls.at(-1)?.body, { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.deepEqual(resultJson(reviewed), { receipt, mimeType: "image/png", sizeBytes: bytes.byteLength },
    "the text block carries identity and digest, never the bytes");
  assert.deepEqual(reviewed.content[1], { type: "image", data, mimeType: "image/png" });

  data = Buffer.from("substituted bytes").toString("base64");
  const substituted = await callTool(deps, "review_descendant_ui_evidence",
    { sessionId: "child", occurrenceId: "workflow_1", evidenceId: "desktop" });
  assert.equal(substituted.isError, true);
  assert.equal(substituted.content.length, 1, "mismatched bytes are never shown to the model");
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
    "dispatch_workflow_node", "create_workflow_artifact", "complete_workflow_attempt",
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

test("get_session_events: after/limit paging, tail truncation, 400-char line cap, lastSeq", async () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1,
    ts: 1000 + i,
    payload: { kind: "agent_message", text: `line ${i + 1} ` + "x".repeat(1000) },
  }));
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { events } }));
  const result = await callTool(deps, "get_session_events", { sessionId: "s_1", after: 3, limit: 5 });
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_1/events?after=3`);
  const data = resultJson(result);
  assert.equal(data.lines.length, 5, "tail-truncated to limit");
  assert.match(data.lines[0], /^\(36\) agent_message: line 36/);
  for (const line of data.lines) assert.ok(line.length <= 401, "capped at 400 chars (+ellipsis)");
  assert.equal(data.lastSeq, 40);
});

test("get_session_events defaults: after=0, limit=30; lastSeq echoes after when empty", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { events: [] } }));
  const data = resultJson(await callTool(deps, "get_session_events", { sessionId: "s_1" }));
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_1/events?after=0`);
  assert.deepEqual(data, { lines: [], lastSeq: 0 });
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
  const { deps, calls } = makeDeps(() => ++attempts === 1
    ? { status: 428, body: { error: "Child creation requires approval" } }
    : { status: 201, body: { id: "s_child", parentSessionId: SELF_ID } });
  const sleeps: number[] = [];
  deps.sleep = async (ms) => { sleeps.push(ms); };
  const result = await callTool(deps, "create_session", {
    runnerId: "r1", agentId: "claude-code", workspaceId: "workspace",
  });
  assert.equal(result.isError, undefined);
  assert.equal(resultJson(result).session.id, "s_child");
  assert.deepEqual(calls[0]!.body, calls[1]!.body);
  assert.deepEqual(sleeps, [1000]);
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
      const { deps, calls } = makeDeps(() => remaining-- > 0
        ? { status: 428, body: { error: "Child approval required" } }
        : { status: terminal, body: terminal === 201 ? { run: { id: "run" }, sessions: [] } : { error: "Rejected" } });
      deps.sleep = async (ms) => { assert.equal(ms, 1000); sleeps++; };
      const result = await callTool(deps, name, { runnerId: "r", workspaceId: "w", agentIds: ["a"], workflowId: "workflow", task: "Build" });
      assert.equal(result.isError === true, terminal === 403);
      assert.equal(sleeps, 2);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map((call) => call.body), Array(3).fill(calls[0]!.body));
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
