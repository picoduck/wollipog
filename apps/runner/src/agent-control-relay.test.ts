import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CONTROL_RELAY_ENDPOINT_ENV,
  AGENT_CONTROL_RELAY_KEY_ENV,
  AgentControlRelaySockets,
  agentControlRelayFetch,
  type AgentControlRelayRequest,
} from "./agent-control-relay.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { runWollipogCli } from "./wollipog-cli.js";

test("the Agent Control relay carries one bounded round-trip without a bearer", async () => {
  const seen: AgentControlRelayRequest[] = [];
  const sockets = new AgentControlRelaySockets(async (sessionId, request) => {
    assert.equal(sessionId, "s_relay");
    seen.push(request);
    return { status: 201, body: '{"ok":true}' };
  });
  try {
    const endpoint = await sockets.ensure("s_relay");
    const fetchImpl = agentControlRelayFetch(endpoint, "k".repeat(32));
    const response = await fetchImpl("https://provider-supplied.invalid/api/sessions?limit=1", {
      method: "POST",
      headers: {
        authorization: "Bearer provider-must-not-forward-this",
        "content-type": "application/json",
      },
      body: '{"value":1}',
    });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), '{"ok":true}');
    assert.deepEqual(seen, [{
      key: "k".repeat(32),
      method: "POST",
      path: "/api/sessions?limit=1",
      contentType: "application/json",
      body: '{"value":1}',
    }]);
    assert.equal(JSON.stringify(seen).includes("provider-must-not-forward-this"), false);
  } finally {
    await sockets.closeAll();
  }
});

test("the relay carries a video-sized JSON upload beyond the old 16 MiB frame bound", async () => {
  const body = JSON.stringify({ data: "a".repeat(17 * 1024 * 1024) });
  const sockets = new AgentControlRelaySockets(async (_sessionId, request) => {
    assert.equal(request.body, body);
    return { status: 201, body: '{"artifactId":"art_video"}' };
  });
  try {
    const fetchImpl = agentControlRelayFetch(await sockets.ensure("s_video_relay"), "k".repeat(32));
    const response = await fetchImpl("http://unused/api/sessions/s_video_relay/artifacts/videos", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), '{"artifactId":"art_video"}');
  } finally { await sockets.closeAll(); }
});

test("the Agent Control relay rejects non-loopback endpoints and non-JSON request shapes", async () => {
  assert.throws(() => agentControlRelayFetch("tcp://example.com:4318", "k".repeat(32)), /invalid Agent Control relay endpoint/);
  const sockets = new AgentControlRelaySockets(async () => ({ status: 200, body: "{}" }));
  try {
    const endpoint = await sockets.ensure("s_relay_shape");
    const fetchImpl = agentControlRelayFetch(endpoint, "k".repeat(32));
    await assert.rejects(() => fetchImpl("http://unused/api/sessions", {
      method: "PATCH",
    }), /permits only GET, POST, PUT, and DELETE/);
    await assert.rejects(() => fetchImpl("http://unused/api/sessions", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "x",
    }), /permits only JSON/);
  } finally {
    await sockets.closeAll();
  }
});

test("the Agent Control relay preserves every method used by the control-plane allowlist", async () => {
  const methods: AgentControlRelayRequest["method"][] = ["GET", "POST", "PUT", "DELETE"];
  const seen: AgentControlRelayRequest[] = [];
  const sockets = new AgentControlRelaySockets(async (_sessionId, request) => {
    seen.push(request);
    return { status: 204, body: "" };
  });
  try {
    const endpoint = await sockets.ensure("s_relay_methods");
    const fetchImpl = agentControlRelayFetch(endpoint, "k".repeat(32));
    for (const method of methods) {
      const response = await fetchImpl("http://unused/api/governance/policies/p_example", { method });
      assert.equal(response.status, 204);
    }
    assert.deepEqual(seen.map((request) => request.method), methods);
  } finally {
    await sockets.closeAll();
  }
});

test("closing a session relay refuses subsequent connections to its former endpoint", async () => {
  const sockets = new AgentControlRelaySockets(async () => ({ status: 200, body: "{}" }));
  try {
    const endpoint = await sockets.ensure("s_relay_close");
    const fetchImpl = agentControlRelayFetch(endpoint, "k".repeat(32));
    await sockets.close("s_relay_close");
    await assert.rejects(() => fetchImpl("http://unused/api/sessions"), /ECONNREFUSED|closed/u);
  } finally {
    await sockets.closeAll();
  }
});

test("the injected CLI works through the relay without any token file or token environment", async () => {
  const sockets = new AgentControlRelaySockets(async (_sessionId, request) => request.path === "/api/compatibility"
    ? { status: 200, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }) }
    : { status: 200, body: JSON.stringify({ sessions: [] }) });
  try {
    const endpoint = await sockets.ensure("s_cli_relay");
    let stdout = "";
    let stderr = "";
    const code = await runWollipogCli(
      ["node", "cli.js", "--wollipog-cli", "session", "list", "--json"],
      {
        WOLLIPOG_CONTROL_PLANE_URL: "http://127.0.0.1:4317",
        WOLLIPOG_SESSION_ID: "s_cli_relay",
        [AGENT_CONTROL_RELAY_ENDPOINT_ENV]: endpoint,
        [AGENT_CONTROL_RELAY_KEY_ENV]: "k".repeat(32),
      },
      { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    );
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { sessions: [] });
  } finally {
    await sockets.closeAll();
  }
});
