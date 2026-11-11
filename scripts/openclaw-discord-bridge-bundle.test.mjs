import assert from "node:assert/strict";
import {execFileSync} from "@wollipog/test-support/bounded-child-process";
import {DatabaseSync} from "node:sqlite";
import {test} from "node:test";
import {WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE} from "../packages/protocol/src/index.ts";

test("the OpenClaw delivery bundle loads without workspace runtime dependencies and serves the signed receiver contract", async () => {
  execFileSync(process.execPath, [new URL("./build-openclaw-discord-bridge.mjs", import.meta.url).pathname], {stdio: "pipe"});
  const {startDiscordBridge} = await import("../integrations/openclaw-discord/dist/bridge.mjs");
  const sql = new DatabaseSync(":memory:"), diagnostics = [];
  const bridge = await startDiscordBridge({sql, settings: () => ({bridge: {port: 38003, gatewayOrigin: "http://127.0.0.1:38001", hookTokenEnv: "HOOK_FIXTURE"},
    connections: [{name: "fixture", controlPlaneId: "plane-fixture", connectionId: "connection-fixture", origin: "http://127.0.0.1:38000",
      assistantTokenEnv: "ASSISTANT_FIXTURE", bindings: [], events: {subscriptionId: "subscription-fixture", path: "fixture", signingSecretEnv: "SIGNING_FIXTURE"}}]}),
    secret: () => "synthetic-fixture", currentPolicy: () => false, diagnostic: reason => diagnostics.push(reason), listen: false});
  try {
    const rejected = await bridge.app.inject({method: "POST", url: "/events/fixture/wollipog/events",
      headers: {"content-type": WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE}, payload: Buffer.from("{}")});
    assert.equal(rejected.statusCode, 401);
    await bridge.tick();
    assert.deepEqual(diagnostics, ["signed_event_invalid_signature", "bridge_reconciliation_unavailable"]);
  } finally {await bridge.close(); sql.close();}
});
