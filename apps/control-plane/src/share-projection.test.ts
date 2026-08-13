import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import type { SessionEvent, SessionEventKind, SessionEventPayload } from "@wollipog/protocol";
import {
  buildOperationalTranscriptProjection,
  canonicalOperationalTranscriptJson,
  operationalTranscriptMarkdown,
  redactOperationalTranscriptText,
} from "./share-projection.js";

type PayloadByKind = { [K in SessionEventKind]: Extract<SessionEventPayload, { kind: K }> };

const FAKE_GITHUB_TOKEN = ["gh", "p_", "a".repeat(30)].join("");
const FAKE_OPENAI_TOKEN = ["sk", "-proj-", "a".repeat(26)].join("");
const FAKE_AWS_ACCESS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const FAKE_SLACK_TOKEN = ["xo", "xb-", "1".repeat(10), "-", "a".repeat(10)].join("");
const PRIVATE_KEY_BEGIN = ["-----BEGIN OPENSSH", " PRIVATE KEY-----"].join("");
const PRIVATE_KEY_END = ["-----END OPENSSH", " PRIVATE KEY-----"].join("");
const RSA_PRIVATE_KEY_END = ["-----END RSA", " PRIVATE KEY-----"].join("");

// `satisfies PayloadByKind` is intentional: adding a SessionEventPayload kind makes this test
// fail to compile until its public/non-public disposition is reviewed explicitly.
const EVERY_PAYLOAD = {
  user_message: {
    kind: "user_message",
    text: "visible user",
    images: [{ mimeType: "image/png", data: "IMAGE_LEAK" }],
    commandId: "COMMAND_ID_LEAK",
  },
  agent_message: { kind: "agent_message", text: "visible assistant", final: true },
  agent_thought: { kind: "agent_thought", text: "AGENT_THOUGHT_LEAK", final: true },
  tool_call: {
    kind: "tool_call",
    toolCallId: "TOOL_ID_LEAK",
    title: "TOOL_TITLE_LEAK",
    status: "completed",
    text: "TOOL_TEXT_LEAK",
  },
  tool_call_update: {
    kind: "tool_call_update",
    toolCallId: "TOOL_UPDATE_ID_LEAK",
    status: "completed",
    text: "TOOL_UPDATE_TEXT_LEAK",
  },
  plan: { kind: "plan", entries: [{ content: "PLAN_LEAK", status: "pending" }] },
  command_output: { kind: "command_output", text: "COMMAND_OUTPUT_LEAK" },
  file_edit: { kind: "file_edit", path: "FILE_PATH_LEAK", diff: "DIFF_LEAK" },
  stderr: { kind: "stderr", text: "STDERR_LEAK" },
  status: { kind: "status", status: "running" },
  turn_interrupted: { kind: "turn_interrupted" },
  error: { kind: "error", message: "ERROR_LEAK" },
  policy_transport: { kind: "policy_transport", state: "open", openedAt: 123 },
  review_decision: {
    kind: "review_decision",
    reviewId: "REVIEW_ID_LEAK",
    reviewer: { kind: "agent", id: "REVIEWER_LEAK" },
    outcome: "denied",
    rationale: "REVIEW_RATIONALE_LEAK",
  },
  permission_request: {
    kind: "permission_request",
    requestId: "PERMISSION_REQUEST_LEAK",
    title: "PERMISSION_TITLE_LEAK",
    options: [{ optionId: "OPTION_ID_LEAK", name: "OPTION_NAME_LEAK" }],
    context: { toolName: "shell", input: "PERMISSION_INPUT_LEAK", path: "/home/permission/leak" },
  },
  permission_resolved: { kind: "permission_resolved", requestId: "RESOLUTION_ID_LEAK", optionId: "allow" },
  question_request: {
    kind: "question_request",
    requestId: "QUESTION_ID_LEAK",
    questions: [{ id: "ANSWER_KEY_LEAK", question: "QUESTION_TEXT_LEAK", options: [] }],
  },
  question_resolved: { kind: "question_resolved", requestId: "QUESTION_RESOLUTION_LEAK", answered: true },
  checkpoint: { kind: "checkpoint", turn: 1, tree: "CHECKPOINT_TREE_LEAK" },
  checkpoint_restored: { kind: "checkpoint_restored", turn: 2 },
  conversation_checkpoint: { kind: "conversation_checkpoint", turn: 3 },
  conversation_forked: { kind: "conversation_forked", sourceSessionId: "SOURCE_SESSION_LEAK", turn: 4 },
  token_usage: {
    kind: "token_usage",
    inputTokens: 101,
    outputTokens: 202,
    cachedInputTokens: 303,
    costUsd: 4.04,
    durationMs: 505,
    parentToolUseId: "USAGE_PARENT_LEAK",
  },
} satisfies PayloadByKind;

function event(seq: number, payload: SessionEventPayload): SessionEvent {
  return { id: 10_000 + seq, sessionId: "INTERNAL_SESSION_ID", seq, ts: 1_700_000_000_000 + seq, payload };
}

function requireProjection(events: readonly SessionEvent[], options?: Parameters<typeof buildOperationalTranscriptProjection>[1]) {
  const result = buildOperationalTranscriptProjection(events, options);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  return result;
}

test("strict projection exhaustively allowlists user, top-level assistant, and interruption boundaries", () => {
  const events = Object.values(EVERY_PAYLOAD).map((payload, index) => event(index + 1, payload));
  const result = requireProjection(events);

  assert.deepEqual(result.projection, {
    schemaVersion: 1,
    source: "control-plane-cache",
    completeness: "possibly-partial",
    messages: [
      { role: "user", text: "visible user" },
      { role: "assistant", text: "visible assistant" },
      { role: "assistant", text: "[Turn interrupted]" },
    ],
  });
  assert.deepEqual(Object.keys(result.projection), ["schemaVersion", "source", "completeness", "messages"]);
  const serialized = result.canonicalJson;
  for (const forbidden of [
    "IMAGE_LEAK", "COMMAND_ID_LEAK", "AGENT_THOUGHT_LEAK", "TOOL_", "PLAN_LEAK",
    "COMMAND_OUTPUT_LEAK", "FILE_PATH_LEAK", "DIFF_LEAK", "STDERR_LEAK", "ERROR_LEAK",
    "REVIEW_", "PERMISSION_", "OPTION_", "QUESTION_", "ANSWER_KEY_LEAK", "CHECKPOINT_",
    "SOURCE_SESSION_LEAK", "USAGE_PARENT_LEAK", "INTERNAL_SESSION_ID", "1700000000000",
  ]) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not cross the operational projection`);
  }
});

test("operational shares preserve an interruption boundary after truncated assistant output", () => {
  const result = requireProjection([
    event(1, { kind: "user_message", text: "Do the work" }),
    event(2, { kind: "agent_message", text: "Partial answer" }),
    event(3, { kind: "turn_interrupted" }),
    event(4, { kind: "user_message", text: "Take another direction" }),
  ]);
  assert.deepEqual(result.projection.messages, [
    { role: "user", text: "Do the work" },
    { role: "assistant", text: "Partial answer" },
    { role: "assistant", text: "[Turn interrupted]" },
    { role: "user", text: "Take another direction" },
  ]);
});

test("parented assistant output is omitted and hidden events break streaming coalescing", () => {
  const events = [
    event(1, { kind: "agent_message", text: "first " }),
    event(2, { kind: "agent_message", text: "message" }),
    event(3, { kind: "agent_message", text: "SUBAGENT_LEAK", parentToolUseId: "task-1" }),
    event(4, { kind: "agent_message", text: "second" }),
    event(5, { kind: "tool_call", toolCallId: "t", title: "hidden", status: "completed" }),
    event(6, { kind: "agent_message", text: "third" }),
    event(7, { kind: "agent_message", text: "complete", final: true }),
    event(8, { kind: "agent_message", text: "fourth" }),
  ];
  const result = requireProjection(events);
  assert.deepEqual(result.projection.messages, [
    { role: "assistant", text: "first message" },
    { role: "assistant", text: "second" },
    { role: "assistant", text: "third" },
    { role: "assistant", text: "complete" },
    { role: "assistant", text: "fourth" },
  ]);
  assert.ok(!result.canonicalJson.includes("SUBAGENT_LEAK"));
});

test("stream chunks are joined before redaction", () => {
  const result = requireProjection([
    event(1, { kind: "agent_message", text: "Authorization: Bear" }),
    event(2, { kind: "agent_message", text: "er split-secret-value" }),
  ]);
  assert.deepEqual(result.projection.messages, [
    { role: "assistant", text: "Authorization: <redacted-secret>" },
  ]);
});

test("provider message ids preserve assistant boundaries while same-id chunks redact as one", () => {
  const split = requireProjection([
    event(1, { kind: "agent_message", text: "Authorization: Bear", messageId: "a" }),
    event(2, { kind: "agent_message", text: "er split-secret-value", messageId: "a" }),
    event(3, { kind: "agent_message", text: "Second", messageId: "b" }),
  ]);
  assert.deepEqual(split.projection.messages, [
    { role: "assistant", text: "Authorization: <redacted-secret>" },
    { role: "assistant", text: "Second" },
  ]);

  const joined = requireProjection([
    event(1, { kind: "agent_message", text: "one", messageId: "a" }),
    event(2, { kind: "agent_message", text: " two", messageId: "a" }),
    event(3, { kind: "agent_message", text: " three", messageId: "a" }),
  ]);
  assert.deepEqual(joined.projection.messages, [{ role: "assistant", text: "one two three" }]);

  const reconciled = requireProjection([
    event(1, { kind: "agent_message", text: "Hel", messageId: "complete" }),
    event(2, { kind: "agent_message", text: "lo", messageId: "complete" }),
    event(3, { kind: "agent_message", text: "Hello!", messageId: "complete", final: true }),
  ]);
  assert.deepEqual(reconciled.projection.messages, [{ role: "assistant", text: "Hello!" }],
    "an authoritative same-id final replaces its streamed prefix just as the timeline does");
});

test("redaction removes credential forms and absolute home/workspace paths", () => {
  const input = [
    "TOKEN=super-secret",
    '"apiKey":"json-secret"',
    "Authorization: Bearer authorization-secret",
    "Cookie: session=cookie-secret",
    ["https://alice:", "password@example.test/private"].join(""),
    FAKE_GITHUB_TOKEN,
    FAKE_OPENAI_TOKEN,
    FAKE_SLACK_TOKEN,
    FAKE_AWS_ACCESS_KEY,
    "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl",
    `${PRIVATE_KEY_BEGIN}\nPRIVATE_KEY_LEAK\n${PRIVATE_KEY_END}`,
    String.raw`C:\Users\developer\Dev\private\file.ts`,
    "/home/developer/private/file.ts",
    "/Users/developer/private/file.ts",
    "/root/.ssh/id_ed25519",
    "/workspace/private/file.ts",
    "/mnt/c/Users/developer/Dev/private/file.ts",
    String.raw`\\server\share\private\file.ts`,
    "~/.config/private",
    String.raw`D:/Projects/Acme/private/file.ts`,
  ].join("\n");
  const redacted = redactOperationalTranscriptText(input, [String.raw`D:\Projects\Acme`]);

  for (const forbidden of [
    "super-secret", "json-secret", "authorization-secret", "cookie-secret", "alice:password",
    "ghp_", "sk-proj-", "xoxb-", FAKE_AWS_ACCESS_KEY, "eyJhbGci", "PRIVATE_KEY_LEAK",
    "developer", "server", "Projects", "private/file.ts",
  ]) {
    assert.ok(!redacted.includes(forbidden), `${forbidden} should be redacted`);
  }
  assert.ok((redacted.match(/<redacted-secret>|\*{3,}/g) ?? []).length >= 10);
  assert.ok((redacted.match(/<redacted-path>/g) ?? []).length >= 9);
});

test("canonical JSON and Markdown are deterministic and omit non-schema properties", () => {
  const events = [
    event(2, { kind: "agent_message", text: "world", final: true }),
    event(1, { kind: "user_message", text: "hello" }),
  ];
  const first = requireProjection(events);
  const second = requireProjection([...events].reverse());
  const expected = '{"schemaVersion":1,"source":"control-plane-cache","completeness":"possibly-partial","messages":[{"role":"user","text":"hello"},{"role":"assistant","text":"world"}]}';
  assert.equal(first.canonicalJson, expected);
  assert.equal(second.canonicalJson, expected);
  assert.equal(canonicalOperationalTranscriptJson({ ...first.projection, ignored: "no" } as never), expected);
  assert.equal(first.markdown, second.markdown);
  assert.equal(first.utf8Bytes, Math.max(Buffer.byteLength(first.canonicalJson), Buffer.byteLength(first.markdown)));

  const escaped = requireProjection([event(1, { kind: "user_message", text: "quote=\" slash=\\ control=\u0001 emoji=🙂 lone=\ud800" })]);
  assert.equal(escaped.utf8Bytes, Math.max(Buffer.byteLength(escaped.canonicalJson), Buffer.byteLength(escaped.markdown)));
});

test("Markdown renderer neutralizes HTML, images, headings, links, and embedded fences", () => {
  const dangerous = "<script>alert(1)</script>\n![pixel](https://evil.test/p)\n# injected\n[click](https://evil.test)\n```\nclose";
  const result = requireProjection([event(1, { kind: "user_message", text: dangerous })]);
  const markdown = result.markdown;
  assert.equal(markdown, operationalTranscriptMarkdown(result.projection));
  const lines = markdown.split("\n");
  const opening = lines.findIndex((line) => /^`{4,}text$/.test(line));
  assert.ok(opening >= 0, "a fence longer than the embedded triple fence is required");
  const fence = lines[opening]!.slice(0, -4);
  const closing = lines.indexOf(fence, opening + 1);
  assert.ok(closing > opening);
  assert.equal(lines.slice(opening + 1, closing).join("\n"), dangerous);
  assert.equal(lines.filter((line) => line === fence).length, 1, "content cannot close the generated fence early");
});

test("event and UTF-8 byte bounds reject rather than truncate", () => {
  const eventLimited = buildOperationalTranscriptProjection([
    event(1, { kind: "agent_thought", text: "omitted" }),
    event(2, { kind: "status", status: "idle" }),
  ], { maxEvents: 1 });
  assert.deepEqual(eventLimited, {
    ok: false,
    code: "event_limit",
    error: "transcript contains 2 events; maximum is 1",
    limit: 1,
    actual: 2,
  });

  const message = "🙂".repeat(30);
  const byteLimited = buildOperationalTranscriptProjection([
    event(1, { kind: "user_message", text: message }),
  ], { maxUtf8Bytes: 100 });
  assert.equal(byteLimited.ok, false);
  if (byteLimited.ok) return;
  assert.equal(byteLimited.code, "byte_limit");
  assert.equal(byteLimited.limit, 100);
  assert.ok(byteLimited.actual >= Buffer.byteLength(message, "utf8"));
  assert.ok(!("projection" in byteLimited), "oversized content must not be returned in truncated form");

  const redactsSmallButStartsLarge = buildOperationalTranscriptProjection([
    event(1, { kind: "user_message", text: `TOKEN=${"s".repeat(200)}` }),
  ], { maxUtf8Bytes: 100 });
  assert.equal(redactsSmallButStartsLarge.ok, false, "redaction must not bypass the source allocation bound");

  assert.throws(() => buildOperationalTranscriptProjection([], { maxEvents: 0 }), /positive safe integer/);
  assert.throws(() => buildOperationalTranscriptProjection([], { maxUtf8Bytes: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);
});

test("relative workspace roots are ignored while absolute roots are case-normalized", () => {
  const text = "Hello. Keep punctuation. /mnt/c/DEV/REPO/Secret File.ts";
  const redacted = redactOperationalTranscriptText(text, [".", "/mnt/c/dev/repo"]);
  assert.match(redacted, /^Hello\. Keep punctuation\. /);
  assert.ok(!redacted.includes("DEV/REPO"));
  assert.ok(!redacted.includes("Secret File.ts"));
});

test("quoted and unquoted home paths with spaces do not leak trailing components", () => {
  for (const value of [
    String.raw`C:\Users\developer\My Secret Project\customer.ts`,
    String.raw`"C:\Users\developer\My Secret Project\customer.ts"`,
    "/home/developer/My Secret Project/customer.ts",
  ]) {
    const redacted = redactOperationalTranscriptText(value);
    assert.ok(!redacted.includes("Secret Project"));
    assert.ok(!redacted.includes("customer.ts"));
  }
});

test("bounded valid input cannot overflow fence discovery or quadratic key scanning", () => {
  const manyFences = "` ".repeat(250_000);
  const fenced = buildOperationalTranscriptProjection([event(1, { kind: "user_message", text: manyFences })]);
  assert.equal(fenced.ok, true, fenced.ok ? undefined : fenced.error);

  const repeatedHeaders = `${PRIVATE_KEY_BEGIN}\n`.repeat(20_000);
  const keys = buildOperationalTranscriptProjection([event(1, { kind: "user_message", text: repeatedHeaders })]);
  assert.equal(keys.ok, true, keys.ok ? undefined : keys.error);
  if (keys.ok) assert.ok(!keys.canonicalJson.includes("OPENSSH"));

  const mismatchedEnd = redactOperationalTranscriptText(
    `${PRIVATE_KEY_BEGIN}\ninside\n${RSA_PRIVATE_KEY_END}\nAFTER_LEAK`,
  );
  assert.ok(!mismatchedEnd.includes("inside"));
  assert.ok(!mismatchedEnd.includes("AFTER_LEAK"));
});

test("malformed or future event payloads fail closed", () => {
  for (const payload of [
    null,
    { kind: "future_event", text: "leak" },
    { kind: "user_message", text: 17 },
    { kind: "agent_message", text: "leak", messageId: 17 },
  ]) {
    const result = buildOperationalTranscriptProjection([event(1, payload as never)]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_source");
  }
  const emptyParent = requireProjection([event(1, { kind: "agent_message", text: "subagent", parentToolUseId: "" })]);
  assert.deepEqual(emptyParent.projection.messages, []);
});
