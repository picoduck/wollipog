import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@wollipog/protocol";
import {
  boundedSessionTitleContext,
  normalizeGeneratedSessionTitle,
  sessionTitleGeneratorFromEnv,
} from "./session-title-generator.js";

function event(seq: number, payload: SessionEvent["payload"]): SessionEvent {
  return { id: seq, sessionId: "session", seq, ts: seq, payload };
}

test("generated titles accept concise plain text or JSON and reject malformed output", () => {
  assert.equal(normalizeGeneratedSessionTitle("  Fix session naming  "), "Fix session naming");
  assert.equal(normalizeGeneratedSessionTitle('{"title":"Semantic Session Names"}'), "Semantic Session Names");
  assert.equal(normalizeGeneratedSessionTitle("one\ntwo"), null);
  assert.equal(normalizeGeneratedSessionTitle("x".repeat(121)), null);
  assert.equal(normalizeGeneratedSessionTitle('{"other":"missing"}'), null);
});

test("title context includes the original objective and recent completed semantic messages only", () => {
  const context = boundedSessionTitleContext([
    event(1, { kind: "user_message", text: "Original objective", final: true, images: [] }),
    event(2, { kind: "agent_thought", text: "private reasoning", final: true }),
    event(3, { kind: "tool_call", toolCallId: "tool", title: "Read secret", status: "completed", text: "secret" }),
    event(4, { kind: "agent_message", text: "Partial", final: false }),
    event(5, { kind: "agent_message", text: "Completed answer", final: true }),
    event(6, { kind: "user_message", text: "/provider", final: true, commandInvocation: {
      invocationId: "i", submissionId: "s", providerCommandId: "p", catalogRevision: "r",
      commandName: "provider", executionMode: "passthrough",
    } }),
    event(7, { kind: "user_message", text: "Recent objective", final: true }),
  ]);
  assert.deepEqual(context, [
    { role: "user", text: "Original objective" },
    { role: "assistant", text: "Completed answer" },
    { role: "user", text: "Recent objective" },
  ]);
});

test("title context transforms sensitive text before applying its character bound", () => {
  const secret = `token=${"s".repeat(2_000)}`;
  let transformedInput = "";
  const context = boundedSessionTitleContext([
    event(1, { kind: "user_message", text: secret, final: true }),
  ], (text) => {
    transformedInput = text;
    return "token=[REDACTED]";
  });
  assert.equal(transformedInput, secret, "the redactor receives the complete value");
  assert.deepEqual(context, [{ role: "user", text: "token=[REDACTED]" }]);
});

test("title generation is opt-in and requires an explicit endpoint and model", () => {
  assert.equal(sessionTitleGeneratorFromEnv({}).generator, undefined);
  assert.equal(sessionTitleGeneratorFromEnv({}).timeoutMs, 5_000);
  assert.equal(sessionTitleGeneratorFromEnv({ WOLLIPOG_TITLE_MODEL_TIMEOUT_MS: "" }).timeoutMs, 5_000);
  assert.equal(sessionTitleGeneratorFromEnv({
    WOLLIPOG_TITLE_MODEL_URL: "https://models.example/v1/chat/completions",
    WOLLIPOG_TITLE_MODEL: "cheap-model",
    WOLLIPOG_TITLE_GENERATION: "disabled",
  }).generator, undefined);
  assert.equal(typeof sessionTitleGeneratorFromEnv({
    WOLLIPOG_TITLE_MODEL_URL: "https://models.example/v1/chat/completions",
    WOLLIPOG_TITLE_MODEL: "cheap-model",
  }).generator, "function");
});
