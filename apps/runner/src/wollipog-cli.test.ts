import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
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
      const body = url.endsWith("/healthz")
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
        agentId: null, runId: null, costBudgetUsd: null, maxToolCalls: null, pendingApproval: null,
        archived: false,
      }],
    });
    assert.equal(calls[1]!.url, "http://127.0.0.1:4317/api/sessions");
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
    if (url.endsWith("/healthz")) {
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
    text: async () => JSON.stringify({ protocolVersion: PROTOCOL_VERSION - 1 }),
  });
  assert.equal(await runWollipogCli(
    ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
    env,
    { stdout: (text) => { incompatible += text; }, stderr: () => {} },
    oldFetch,
  ), 1);
  assert.match(JSON.parse(incompatible).error, /incompatible/);
});
