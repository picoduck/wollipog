import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import {
  LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import {
  dispatch,
  nextWaitSessionIntervalMs,
  serveConductorMcp,
  TOOLS,
  type McpDeps,
  type McpFetch,
} from "./conductor-mcp.js";

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
      "list_sessions",
      "get_session",
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

test("every mutating tool's description tells the model the user must approve (card legibility)", () => {
  const mutations = [
    "upsert_governance_policy", "delete_governance_policy",
    "create_workflow_definition", "create_workflow_version", "create_workflow_run",
    "dispatch_workflow_node", "create_workflow_artifact", "complete_workflow_attempt",
    "resolve_workflow_gate", "create_session", "prompt_session", "stop_session",
    "set_guardrails", "create_run", "create_worktree", "attach_worktree", "select_worktree", "discard_worktree",
  ];
  for (const name of mutations) {
    const tool = TOOLS.find((t) => t.name === name)!;
    assert.match(tool.description, /The user must approve\.$/, name);
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
  serveConductorMcp(input, output, deps);

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
  serveConductorMcp(input, output, { fetch: stallingFetch, cpUrl: CP_URL, selfSessionId: SELF_ID, token: "" });

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
  assert.equal(data.runners[0].agents[0].command, undefined, "launch params are not the conductor's business");
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
        effort: null,
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
    },
  }));
  await callTool(deps, "create_worktree", { branch: "fix/one", baseRef: "origin/main" });
  await callTool(deps, "attach_worktree", { sessionId: "s_child", path: "/repo/attached" });
  await callTool(deps, "select_worktree", { sessionId: "s_child", path: "/repo/wt" });
  await callTool(deps, "discard_worktree", { sessionId: "s_child", path: "/repo/old" });
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/${SELF_ID}/worktrees`);
  assert.deepEqual(calls[0]!.body, { branch: "fix/one", baseRef: "origin/main" });
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions/s_child/worktrees/attach`);
  assert.deepEqual(calls[1]!.body, { path: "/repo/attached" });
  assert.equal(calls[2]!.url, `${CP_URL}/api/sessions/s_child/worktrees/select`);
  assert.equal(calls[3]!.url, `${CP_URL}/api/sessions/s_child/worktrees/discard`);
  assert.deepEqual(calls[3]!.body, { path: "/repo/old" });
});

test("an exact-session MCP credential cannot manage another session's worktrees", async () => {
  const { deps, calls } = makeDeps();
  deps.actorHeader = WOLLIPOG_AGENT_ACTOR_SESSION_HEADER;
  const result = await callTool(deps, "create_worktree", { sessionId: "s_other", branch: "fix/other" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /only its own worktrees/);
  assert.equal(calls.length, 0);
});

test("create_session -> POST /api/sessions with prompt riding create and config.model/permissionMode", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 201, body: { id: "s_new", title: "t", status: "queued", runnerId: "r1" } }));
  const result = await callTool(deps, "create_session", {
    runnerId: "r1",
    agentId: "claude-code",
    workspaceId: "ws",
    prompt: "fix the flaky test",
    title: "flaky fix",
    useWorktree: true,
    model: "opus",
    permissionMode: "acceptEdits",
  });
  assert.equal(calls.length, 1, "no follow-up config call without budgets");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions`);
  assert.deepEqual(calls[0]!.body, {
    runnerId: "r1",
    agentId: "claude-code",
    workspaceId: "ws",
    title: "flaky fix",
    prompt: "fix the flaky test",
    useWorktree: true,
    config: { model: "opus", permissionMode: "acceptEdits" },
  });
  assert.equal(resultJson(result).session.id, "s_new");
});

test("create_session with budgets issues a follow-up POST /config carrying ONLY guardrail keys", async () => {
  const { deps, calls } = makeDeps((call) =>
    call.url.endsWith("/config")
      ? { status: 200, body: { id: "s_new", costBudgetUsd: 5, maxToolCalls: 40 } }
      : { status: 201, body: { id: "s_new" } },
  );
  const result = await callTool(deps, "create_session", {
    runnerId: "r1",
    agentId: "claude-code",
    workspacePath: "/repos/x",
    model: "opus",
    costBudgetUsd: 5,
    maxToolCalls: 40,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "POST");
  assert.equal(calls[1]!.url, `${CP_URL}/api/sessions/s_new/config`);
  assert.deepEqual(calls[1]!.body, { costBudgetUsd: 5, maxToolCalls: 40 }, "never model/effort/permissionMode");
  assert.equal(resultJson(result).session.costBudgetUsd, 5);
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

test("set_guardrails -> POST /api/sessions/:id/config with ONLY the given guardrail keys", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { id: "s_2", costBudgetUsd: 3 } }));
  await callTool(deps, "set_guardrails", { sessionId: "s_2", costBudgetUsd: 3 });
  assert.equal(calls[0]!.url, `${CP_URL}/api/sessions/s_2/config`);
  assert.deepEqual(calls[0]!.body, { costBudgetUsd: 3 }, "maxToolCalls omitted when not given");
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

test("every request carries exact conductor provenance and bearer auth when configured", async () => {
  const { deps, calls } = makeDeps(() => ({ status: 200, body: { sessions: [] } }));
  await callTool(deps, "list_sessions");
  assert.equal(calls[0]!.headers["authorization"], `Bearer ${TOKEN}`);
  assert.equal(calls[0]!.headers[WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER], SELF_ID);
  assert.equal(calls[0]!.headers[LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER], undefined);

  const bare = makeDeps(() => ({ status: 200, body: { sessions: [] } }), "");
  await callTool(bare.deps, "list_sessions");
  assert.equal(bare.calls[0]!.headers["authorization"], undefined);
  assert.equal(bare.calls[0]!.headers[WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER], SELF_ID);
  assert.equal(bare.calls[0]!.headers[LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER], undefined);
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
    ["set_guardrails", { sessionId: SELF_ID, costBudgetUsd: 1 }],
  ] as const) {
    const { deps, calls } = makeDeps();
    const result = await callTool(deps, tool, args as Record<string, unknown>);
    assert.equal(result.isError, true, tool);
    assert.match(resultText(result), /my own session/, tool);
    assert.equal(calls.length, 0, `${tool} must not reach the control plane`);
  }
});

test("create_session refuses conductor recursion, bypassPermissions, and a missing workspace — no fetch", async () => {
  const base = { runnerId: "r1", agentId: "claude-code", workspaceId: "ws" };
  for (const [args, why] of [
    [{ ...base, agentId: "conductor" }, /conductor/],
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

test("create_run refuses when agentIds contains 'conductor' — no fetch", async () => {
  const { deps, calls } = makeDeps();
  const result = await callTool(deps, "create_run", {
    runnerId: "r1",
    workspaceId: "ws",
    agentIds: ["claude-code", "conductor"],
    task: "do things",
  });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("create_workflow_run refuses a conductor worker binding — no fetch", async () => {
  const { deps, calls } = makeDeps();
  const result = await callTool(deps, "create_workflow_run", {
    runnerId: "r1", workspaceId: "ws", workflowId: "wf", task: "go",
    agentBindings: { builder: "conductor" },
  });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /must not use the conductor/);
  assert.equal(calls.length, 0);
});

test("set_guardrails without either limit refuses — no fetch", async () => {
  const { deps, calls } = makeDeps();
  const result = await callTool(deps, "set_guardrails", { sessionId: "s_2" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /costBudgetUsd or maxToolCalls/);
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
