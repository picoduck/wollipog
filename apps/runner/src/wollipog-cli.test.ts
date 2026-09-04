import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import type { McpFetch } from "./conductor-mcp.js";
import { runWollipogCli } from "./wollipog-cli.js";

test("CLI emits stable JSON and authenticates list requests as the exact session", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-cli-"));
  try {
    const tokenFile = join(root, "token");
    const readyFile = join(root, "ready");
    writeFileSync(tokenFile, "session-secret", { mode: 0o600 });
    writeFileSync(readyFile, createHash("sha256").update("session-secret").digest("hex"), { mode: 0o600 });
    const calls: Array<{ url: string; init: Parameters<McpFetch>[1] }> = [];
    const fetch: McpFetch = async (url, init) => {
      calls.push({ url, init });
      const body = url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { sessions: [{ id: "s_child", status: "running", runnerId: "r1", title: "Child" }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let stdout = "";
    let stderr = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
      {
        WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317",
        WOLLIPOG_SESSION_ID: "s_parent",
        WOLLIPOG_SESSION_TOKEN_FILE: tokenFile,
        WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
      },
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      fetch,
    );
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      sessions: [{
        id: "s_child", title: "Child", status: "running", runnerId: "r1", workspaceId: null,
        agentId: null, runId: null, costBudgetUsd: null, costCheckpointsUsd: null, costCheckpointApprovedUsd: null, maxToolCalls: null, pendingApproval: null,
        archived: false,
      }],
    });
    assert.equal(calls[1]!.url, "http://127.0.0.1:4317/api/sessions");
    assert.equal(calls[0]!.url, "http://127.0.0.1:4317/api/compatibility");
    assert.equal(calls[0]!.init?.headers?.authorization, "Bearer session-secret");
    assert.equal(calls[0]!.init?.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], "s_parent");
    assert.equal(calls[1]!.init?.headers?.authorization, "Bearer session-secret");
    assert.equal(calls[1]!.init?.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], "s_parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI JSON create and prompt commands reuse the manager routes and reject incompatible control planes", async () => {
  const requests: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
    if (url.endsWith("/api/compatibility")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "s_new", status: "starting", runnerId: "r1", title: "New" }) };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "create", "--runner", "r1", "--agent", "codex", "--workspace", "ws", "--prompt", "Do it", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(JSON.parse(output).session.id, "s_new");
  assert.equal(requests[1]!.url, "http://cp/api/sessions");
  assert.deepEqual(JSON.parse(requests[1]!.body!), {
    runnerId: "r1", agentId: "codex", workspaceId: "ws", prompt: "Do it", useWorktree: false,
  });
  assert.equal(requests[1]!.headers?.[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER], undefined,
    "paired-device CLI calls do not fabricate a session principal");

  let incompatible = "";
  const oldFetch: McpFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl - 1 }),
  });
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
    env,
    { stdout: (text) => { incompatible += text; }, stderr: () => {} },
    oldFetch,
  ), 1);
  assert.match(JSON.parse(incompatible).error, /incompatible/);
});

test("CLI keeps v100 core commands compatible while gating worktree commands on v101", async () => {
  const requests: string[] = [];
  const fetch: McpFetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/api/compatibility")) {
      return { ok: false, status: 404, text: async () => "not found" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/healthz")
        ? { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl }
        : { sessions: [] }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.deepEqual(JSON.parse(output), { sessions: [] });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 1);
  assert.match(JSON.parse(output).error, /requires v101/);
  assert.deepEqual(requests, [
    "http://cp/api/compatibility",
    "http://cp/healthz",
    "http://cp/api/sessions",
    "http://cp/api/compatibility",
    "http://cp/healthz",
  ]);
});

test("CLI gates destructive worktree discard on v102 without disabling v101 selection", async () => {
  const requests: string[] = [];
  const fetch: McpFetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/api/compatibility")
        ? { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktrees }
        : { session: { id: "s1" } }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: () => {}, stderr: () => {} },
    fetch,
  ), 0);
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "discard", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 1);
  assert.match(JSON.parse(output).error, /requires v102/);
  assert.deepEqual(requests, [
    "http://cp/api/compatibility",
    "http://cp/api/sessions/s1/worktrees/select",
    "http://cp/api/compatibility",
  ]);
});

test("CLI emits JSON for get, events, prompt, wait, and stop core commands", async () => {
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  const cases = [
    { argv: ["session", "get", "s_child"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "events", "s_child", "--after", "4", "--limit", "2"], method: "GET", path: "/api/sessions/s_child/events?after=4" },
    { argv: ["session", "prompt", "s_child", "Keep", "going"], method: "POST", path: "/api/sessions/s_child/prompt" },
    { argv: ["session", "wait", "s_child", "--for", "completed", "--timeout", "50"], method: "GET", path: "/api/sessions/s_child" },
    { argv: ["session", "stop", "s_child"], method: "POST", path: "/api/sessions/s_child/stop" },
  ] as const;

  for (const testCase of cases) {
    const requests: Array<{ url: string; method?: string }> = [];
    const fetch: McpFetch = async (url, init) => {
      requests.push({ url, method: init?.method });
      if (url.endsWith("/api/compatibility")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) };
      }
      const session = { id: "s_child", status: "completed", runnerId: "r1", title: "Child" };
      const body = url.includes("/events?")
        ? { events: [] }
        : url.endsWith("/api/sessions/s_child")
          ? { session }
          : session;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let output = "";
    assert.equal(await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", ...testCase.argv, "--json"],
      env,
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    ), 0, testCase.argv.join(" "));
    assert.doesNotThrow(() => JSON.parse(output), testCase.argv.join(" "));
    assert.equal(requests[1]!.method, testCase.method);
    assert.equal(requests[1]!.url, `http://cp${testCase.path}`);
  }
});

test("CLI recognizes installed POSIX and Windows alias invocation names", async () => {
  for (const executable of ["/opt/bin/wollipog", String.raw`C:\Users\agent\wollipog.exe`]) {
    const requests: string[] = [];
    const fetch: McpFetch = async (url) => {
      requests.push(url);
      const body = url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { sessions: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    let output = "";
    assert.equal(await runWollipogCli(
      [executable, "session", "list", "--json"],
      { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" },
      { stdout: (text) => { output += text; }, stderr: () => {} },
      fetch,
    ), 0, executable);
    assert.deepEqual(JSON.parse(output), { sessions: [] });
    assert.deepEqual(requests, ["http://cp/api/compatibility", "http://cp/api/sessions"]);
  }
});

test("CLI worktree commands adapt to the shared MCP operations", async () => {
  const requests: Array<{ url: string; body?: string }> = [];
  const fetch: McpFetch = async (url, init) => {
    requests.push({ url, body: init?.body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(url.endsWith("/api/compatibility")
        ? { protocolVersion: PROTOCOL_VERSION }
        : { worktree: { id: "wt", path: "/repo/wt", branch: "fix/583", source: "created" }, session: { id: "s1" } }),
    };
  };
  const env = { WOLLIPOG_CONTROL_PLANE_URL: "http://cp", WOLLIPOG_TOKEN: "paired-device" };
  let output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "create", "--session", "s1", "--branch", "fix/583", "--base", "origin/main", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(JSON.parse(output).worktree.branch, "fix/583");
  assert.equal(requests[1]!.url, "http://cp/api/sessions/s1/worktrees");
  assert.deepEqual(JSON.parse(requests[1]!.body!), { branch: "fix/583", baseRef: "origin/main" });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "select", "--session", "s1", "--path", "/repo/wt", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(requests[3]!.url, "http://cp/api/sessions/s1/worktrees/select");
  assert.deepEqual(JSON.parse(requests[3]!.body!), { path: "/repo/wt" });

  output = "";
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "worktree", "discard", "--session", "s1", "--path", "/repo/old", "--json"],
    env,
    { stdout: (text) => { output += text; }, stderr: () => {} },
    fetch,
  ), 0);
  assert.equal(requests[5]!.url, "http://cp/api/sessions/s1/worktrees/discard");
  assert.deepEqual(JSON.parse(requests[5]!.body!), { path: "/repo/old" });
});
