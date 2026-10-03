import assert from "node:assert/strict";
import { test } from "node:test";
import { codexHttpFallbackWarning, codexInferenceConfiguration } from "./codex-inference-transport.js";

test("native OpenAI WebSocket default is verified independently of removed flags", () => {
  for (const version of ["0.147.0", "0.160.0"]) {
    assert.deepEqual(codexInferenceConfiguration("openai", null, `codex_vscode/${version} (Linux)`), {
      provider: "openai", configuredTransport: "websocket", reason: "native_openai_default",
    });
  }
  assert.equal(codexInferenceConfiguration("openai", null, "wollipog/0.160.0 (Linux)").configuredTransport, "websocket");
  for (const identity of ["fake", "codex/0.146.0", "codex/0.147.0-pre.1"]) {
    assert.equal(codexInferenceConfiguration("openai", {}, identity).reason, "version_unverified");
  }
});

test("custom providers keep explicit WebSocket opt-in and default to HTTP", () => {
  for (const value of [false, undefined, "true"]) {
    assert.deepEqual(codexInferenceConfiguration("private-provider", {
      model_providers: { "private-provider": { supports_websockets: value, base_url: "https://secret.invalid", experimental_bearer_token: "secret" } },
    }, "codex/0.160.0"), {
      provider: "custom", configuredTransport: "http", reason: "provider_websockets_disabled",
    });
  }
  assert.equal(codexInferenceConfiguration("private-provider", {
    model_providers: { "private-provider": { supports_websockets: true } },
  }, "codex/0.160.0").reason, "custom_provider_opt_in");
});

test("missing, malformed, or inherited provider config never claims successful transport", () => {
  for (const provider of [undefined, null, {}, ""]) {
    assert.equal(codexInferenceConfiguration(provider, {}, "codex/0.160.0").configuredTransport, "unknown");
  }
  for (const config of [null, [], {}, { model_providers: [] }, { model_providers: {} }]) {
    assert.equal(codexInferenceConfiguration("custom", config, "codex/0.160.0").configuredTransport, "unknown");
  }
  assert.equal(codexInferenceConfiguration("toString", { model_providers: {} }, "codex/0.160.0").configuredTransport, "unknown");
});

test("fallback warnings classify without returning provider-controlled text", () => {
  assert.equal(codexHttpFallbackWarning("Falling back from WebSockets to HTTPS transport. token=secret; private prompt"), true);
  assert.equal(codexHttpFallbackWarning("WARN codex_core::client: falling back to HTTP"), true);
  assert.equal(codexHttpFallbackWarning({ message: "Falling back from WebSockets to HTTPS transport" }), false);
  assert.equal(codexHttpFallbackWarning("HTTPS configured by custom provider"), false);
});
