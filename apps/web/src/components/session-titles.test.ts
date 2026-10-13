import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionNamingSettingsView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import {
  TITLE_SOURCE_NO_PERMISSION,
  agentDescription,
  connectionResult,
  endpointUrlError,
  fallbackSentence,
  modelIdError,
  plainFailure,
  setupSummary,
  timeoutError,
  titleSourceOptions,
} from "./session-titles.js";

function view(overrides: Partial<SessionNamingSettingsView> = {}): SessionNamingSettingsView {
  return {
    mode: "prompt_text_only",
    effectiveMode: "prompt_text_only",
    source: "organization",
    canManage: true,
    modes: {
      prompt_text_only: { available: true },
      session_agent_account: { available: false, reason: "No machine has a signed-in agent." },
      custom_model_endpoint: { available: false, reason: "Configure a custom endpoint first." },
    },
    ...overrides,
  };
}

test("an option is settable while there is somewhere to set it up, and otherwise says why", () => {
  const unset = titleSourceOptions(view());
  assert.deepEqual(unset.map((option) => [option.label, option.disabled ?? false, option.disabledReason]), [
    ["First Message", false, undefined],
    ["Agent", true, "No machine has a signed-in agent."],
    ["Custom Endpoint", true, "Configure a custom endpoint first."],
  ]);
  const settable = titleSourceOptions(view({
    harnessMachines: [{ runnerId: "r", machineName: "Studio", harnesses: [] }],
    customModelTargets: [{ runnerId: "r", machineName: "Studio", online: true, available: true, configured: false }],
  }));
  assert.equal(settable.some((option) => option.disabled), false, "a machine to set up on makes both choosable");
});

test("without permission, Agent and Custom Endpoint carry the permission reason", () => {
  const options = titleSourceOptions(view({ canManage: false, harnessMachines: [{ runnerId: "r", machineName: "S", harnesses: [] }] }));
  assert.deepEqual(options.slice(1).map((option) => option.disabledReason), [TITLE_SOURCE_NO_PERMISSION, TITLE_SOURCE_NO_PERMISSION]);
  assert.equal(TITLE_SOURCE_NO_PERMISSION, "Only an organization owner or admin can change this.");
});

test("agents read by provider and sign-in", () => {
  assert.equal(agentDescription({ provider: "claude", billingSource: "subscription" }), "Claude, signed in with a subscription");
  assert.equal(agentDescription({ provider: "codex", billingSource: "api" }), "Codex, using an API key");
});

test("a set-up source is summarized in sentence case", () => {
  assert.equal(setupSummary(view()), null);
  assert.deepEqual(setupSummary(view({
    mode: "session_agent_account",
    harnessTarget: {
      runnerId: "r", machineName: "Studio Workstation", agentId: "a", harnessName: "Claude Code", driver: "claude-code",
      model: "haiku", modelName: "Haiku", effort: "low", available: true,
    },
  })), { title: "Claude Code on Studio Workstation", description: "Haiku, low effort" });
  assert.deepEqual(setupSummary(view({ mode: "session_agent_account" })), { title: "Each session uses its own agent" });
  assert.deepEqual(setupSummary(view({
    mode: "custom_model_endpoint",
    customModel: {
      endpointOrigin: "https://models.example:8443", model: "title-1", timeoutMs: 12_000, apiKeyConfigured: false,
      configurationSource: "runner", runnerId: "r", machineName: "Studio Workstation",
    },
  })), { title: "models.example:8443 through Studio Workstation", description: "title-1, 12,000 ms timeout" });
  assert.deepEqual(setupSummary(view({
    mode: "custom_model_endpoint",
    customModel: { endpointOrigin: "https://env.example", model: "m", timeoutMs: 5000, apiKeyConfigured: true, configurationSource: "environment" },
  })), { title: "env.example", description: "m, set on the server" });
});

test("a fallback names the chosen source's reason and what new sessions do", () => {
  assert.equal(fallbackSentence(view()), null);
  assert.equal(
    fallbackSentence(view({ mode: "custom_model_endpoint", effectiveMode: "prompt_text_only" })),
    "Configure a custom endpoint first. New sessions use their first message instead.",
  );
});

test("endpoint URLs follow the server's rules", () => {
  for (const bad of ["not a url", "", "ftp://models.example", "https://user:pw@models.example", "https://models.example/?q=1", "https://models.example/#x"]) {
    assert.equal(endpointUrlError(bad, false), "Enter a full URL, starting with https://.", bad);
  }
  assert.equal(endpointUrlError("http://models.internal/v1", false), null, "http is allowed without a key");
  assert.equal(endpointUrlError("http://models.internal/v1", true), "Use an https:// URL to send an API key.");
  assert.equal(endpointUrlError("http://127.0.0.1:8080/v1", true), null, "loopback may carry a key");
  assert.equal(endpointUrlError(" https://models.example/v1 ", true), null);
});

test("model and timeout errors say how to fix them", () => {
  assert.equal(modelIdError("  "), "Enter the model ID.");
  assert.equal(modelIdError("gpt-title"), null);
  assert.equal(modelIdError("x".repeat(201)), "Enter a model ID of up to 200 characters.");
  for (const bad of ["10", "", "30001", "1.5", "abc"]) assert.equal(timeoutError(bad), "Enter a timeout from 250 to 30,000 ms.", bad);
  for (const good of ["250", "5000", "30000"]) assert.equal(timeoutError(good), null, good);
});

test("failures are plain words, with the server's own kept as detail", () => {
  assert.deepEqual(plainFailure(new TypeError("Failed to fetch"), "Couldn't load session title settings.", ""), {
    message: "Couldn't load session title settings. Check the connection, then try again.",
  });
  assert.deepEqual(plainFailure(new ApiError("organization owner or admin permission is required", 403), "The title source wasn't saved."), {
    message: "The title source wasn't saved. Try again.",
    detail: "organization owner or admin permission is required",
  });
});

test("every connection test result reads as a sentence", () => {
  assert.deepEqual(connectionResult({ ok: true, status: "available" }), { tone: "success", message: "The endpoint answered." });
  for (const status of ["authentication_failed", "endpoint_failed", "timed_out", "unavailable"] as const) {
    assert.equal(connectionResult({ ok: false, status }).tone, "warning");
  }
});
