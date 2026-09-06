import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@wollipog/protocol";
import {
  boundedSessionTitleContext,
  normalizeGeneratedSessionTitle,
  sessionTitleGeneratorFromEnv,
  TITLE_CONTEXT_REDACTION_MAX_CHARS,
  TITLE_CONTEXT_MAX_CHARS,
  TITLE_CONTEXT_MESSAGE_MAX_CHARS,
  isLessSpecificSessionTitle,
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

test("title context includes the original objective and visible current-turn semantic messages only", () => {
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
    { role: "assistant", text: "Partial" },
    { role: "assistant", text: "Completed answer" },
    { role: "user", text: "Recent objective" },
  ]);
});

test("long opening and recent messages cannot crowd out other context or durable targets", () => {
  const context = boundedSessionTitleContext([
    event(1, { kind: "user_message", text: "Opening ".repeat(12_000), final: true }),
    event(3, { kind: "agent_message", text: "Fix issues #123 and #124", final: true }),
    event(4, { kind: "agent_message", text: "Recent ".repeat(12_000), final: true }),
  ], (text) => text.replace(/secret-value/g, "[REDACTED]"), [{
    id: "work", path: "/private/path", branch: "fix/issue-123-secret-value", source: "created",
    pullRequest: { url: "https://private.example/org/repo/pull/456?token=secret-value", state: "open" },
  }]);
  assert.ok(context.every((message) => message.text.length <= TITLE_CONTEXT_MESSAGE_MAX_CHARS));
  assert.ok(context.reduce((sum, message) => sum + message.text.length, 0) <= TITLE_CONTEXT_MAX_CHARS);
  assert.match(context[0]!.text, /^Opening/);
  assert.ok(context.some((message) => message.text.includes("#123 and #124")));
  assert.match(context.at(-1)!.text, /Branch: fix\/issue-123-\[REDACTED\]; PR #456/);
  assert.doesNotMatch(JSON.stringify(context), /private|secret-value/);
});

test("title regression guard preserves numbered targets and concrete work over generic delegation", () => {
  assert.equal(isLessSpecificSessionTitle("Fix Issues #123 and #124", "Fix Priority Issues"), true);
  assert.equal(isLessSpecificSessionTitle("Fix Parser Crash", "Choose Highest-Priority Issues"), true);
  assert.equal(isLessSpecificSessionTitle("Choose Priority Issues", "Fix Parser Crash"), false);
});

test("malformed worktree metadata cannot break isolated naming", () => {
  const metadata = JSON.parse('[{},null,{"branch":27,"pullRequest":{"url":13}}]');
  assert.deepEqual(boundedSessionTitleContext([
    event(1, { kind: "user_message", text: "Original objective", final: true }),
  ], (text) => text, metadata), [{ role: "user", text: "Original objective" }]);
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

test("title context bounds each raw message before synchronous redaction", () => {
  let transformedLength = 0;
  boundedSessionTitleContext([
    event(1, {
      kind: "agent_message",
      text: "x".repeat(TITLE_CONTEXT_REDACTION_MAX_CHARS * 2),
      final: true,
    }),
  ], (text) => {
    transformedLength = text.length;
    return text;
  });
  assert.equal(transformedLength, TITLE_CONTEXT_REDACTION_MAX_CHARS);
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
