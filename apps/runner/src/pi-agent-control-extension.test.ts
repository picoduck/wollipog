import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PI_AGENT_CONTROL_PROBE_COMMAND,
  piAgentControlExtensionSource,
  piAgentControlProbeSource,
} from "./pi-agent-control-extension.js";

test("generated Pi Agent Control extensions are standalone valid modules", async () => {
  const source = piAgentControlExtensionSource();
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const probeSource = piAgentControlProbeSource();
  const probe = await import(`data:text/javascript;base64,${Buffer.from(probeSource).toString("base64")}`);
  assert.equal(typeof bridge.default, "function");
  assert.equal(typeof probe.default, "function");
  assert.match(source, /tools\/list/);
  assert.match(source, /request_user_input/);
  assert.match(source, /WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE/);
  assert.doesNotMatch(source, /WOLLIPOG_SESSION_TOKEN_FILE\s*=/,
    "the extension inherits a token-file reference and never embeds credential bytes");
  assert.match(probeSource, new RegExp(PI_AGENT_CONTROL_PROBE_COMMAND));
});
