import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationHandoff, handoffDestinationError } from "./conversation-handoff.js";
import type { AgentDefinition, SessionEventPayload, PromptImageReference } from "./index.js";

const agent: AgentDefinition = {
  id: "claude", name: "Claude", driver: "claude-code", command: "claude", args: [], env: {},
  available: true, authStatus: "authenticated",
  capabilities: { models: [{ id: "model", name: "Model", inputModalities: ["text", "image"] }],
    effortLevels: ["high"], permissionModes: ["default"], slashCommands: [], supportsImages: true, supportsApprovals: true },
};
const events = (...payloads: SessionEventPayload[]) => payloads.map((payload, i) => ({ seq: i + 1, payload }));
const image: PromptImageReference = { artifactId: "source-image", mimeType: "image/png", sizeBytes: 10, sha256: "a".repeat(64) };

test("handoff reconstructs deltas before redaction and honors the checkpoint boundary", () => {
  const draft = buildConversationHandoff(events(
    { kind: "user_message", text: "Fix the selected issue", final: true },
    { kind: "agent_message", messageId: "private-id", text: "Use api_" },
    { kind: "tool_call", toolCallId: "t", title: "shell", status: "completed", text: "RAW_TOOL_SECRET" },
    { kind: "agent_message", messageId: "private-id", text: "key=opaque-secret-value" },
    { kind: "agent_message", messageId: "private-id", final: true, text: "Use api_key=opaque-secret-value to fix issue #538" },
    { kind: "agent_thought", text: "HIDDEN_REASONING" },
    { kind: "user_message", text: "UNSENT_PROMPT", final: false },
    { kind: "user_message", text: "LATER_HISTORY" },
  ), 7, agent, { model: "model" });
  assert.match(draft.text, /issue #538/);
  assert.equal(draft.text.match(/Assistant:/g)?.length, 1);
  for (const secret of ["opaque-secret-value", "private-id", "RAW_TOOL_SECRET", "HIDDEN_REASONING", "UNSENT_PROMPT", "LATER_HISTORY"]) assert.ok(!draft.text.includes(secret), secret);
  assert.match(draft.disclosure, /redacted/);
});

test("handoff filters private values, quoted credentials, environment assignments and incomplete keys", () => {
  const draft = buildConversationHandoff(events({ kind: "user_message", text: [
    "Keep issue #123 and src/example.ts", "API_ENDPOINT=https://private.example", "Password: 'passphrase-value'",
    "Authorization: Bearer opaque-auth", "https://user:pwd@example.test", "threadId=private-thread",
    "The known credential is bare-source-value", "-----BEGIN PRIVATE KEY-----", "UNTERMINATED_KEY",
  ].join("\n") }), 1, agent, { model: "model" }, { privateValues: ["bare-source-value"] });
  for (const secret of ["https://private.example", "passphrase-value", "opaque-auth", "user:pwd", "private-thread", "bare-source-value", "UNTERMINATED_KEY"]) assert.ok(!draft.text.includes(secret), secret);
  assert.match(draft.text, /issue #123 and src\/example.ts/);
});

test("handoff retains opening objective and recent decisions with fair per-message bounds", () => {
  const source = events(
    { kind: "user_message", text: "ORIGINAL_OBJECTIVE " + "o".repeat(30_000) },
    ...Array.from({ length: 10 }, (_, i): SessionEventPayload => ({ kind: "agent_message", final: true, text: `DECISION_${i} ` + "x".repeat(6_000) })),
    { kind: "agent_message", final: true, text: "LATEST_DECISION fix issue #538" },
  );
  const draft = buildConversationHandoff(source, source.length, agent, { model: "model" });
  assert.match(draft.text, /ORIGINAL_OBJECTIVE/);
  assert.match(draft.text, /LATEST_DECISION fix issue #538/);
  assert.ok(!draft.text.includes("DECISION_0 "));
  assert.ok(draft.text.length < 25_000);
  assert.match(draft.disclosure, /truncated/);
});

test("handoff excludes oversized streams instead of exposing partial credentials", () => {
  const draft = buildConversationHandoff(events(
    { kind: "user_message", text: "objective" },
    { kind: "agent_message", messageId: "m", text: "secret=" + "s".repeat(70_000) },
    { kind: "agent_message", messageId: "m", text: "still-secret" },
    { kind: "agent_message", final: true, text: "newest completed result" },
  ), 4, agent, { model: "model" });
  assert.ok(!draft.text.includes("still-secret"));
  assert.match(draft.disclosure, /over 64 KiB were excluded/);
  assert.match(draft.text, /newest completed result/);
});

test("handoff preserves authorized image references once and rejects incompatible formats and count", () => {
  const source = events({ kind: "user_message", text: "image", images: [image] }, { kind: "user_message", text: "same", images: [image] });
  assert.deepEqual(buildConversationHandoff(source, 2, agent, { model: "model" }).images, [image]);
  const codex = { ...agent, driver: "codex-app-server" as const };
  assert.throws(() => buildConversationHandoff(events({ kind: "user_message", text: "gif", images: [{ ...image, mimeType: "image/gif" }] }), 1, codex, { model: "model" }), /incompatible attachments/);
  assert.throws(() => buildConversationHandoff(source, 2, { ...agent, capabilities: { ...agent.capabilities!, supportsImages: false } }, { model: "model" }), /incompatible with the destination/);
  assert.throws(() => buildConversationHandoff(events({ kind: "user_message", text: "many", images: Array.from({ length: 7 }, (_, i) => ({ ...image, artifactId: `image-${i}` })) }), 1, agent, { model: "model" }), /incompatible attachments/);
});

test("handoff rejects oversized or misordered input before returning a portable draft", () => {
  assert.throws(() => buildConversationHandoff(Array.from({ length: 10_001 }, (_, i) => ({ seq: i + 1, payload: { kind: "status" as const, status: "idle" as const } })), 10_001, agent, { model: "model" }), /10,000 events/);
  assert.throws(() => buildConversationHandoff([{ seq: 2, payload: { kind: "user_message", text: "later" } }, { seq: 1, payload: { kind: "user_message", text: "earlier" } }], 2, agent, { model: "model" }), /ordering/);
});

test("handoff destination settings fail closed for unsupported or unauthenticated peers", () => {
  assert.equal(handoffDestinationError(agent, "codex-app-server", { model: "model", effort: "high", permissionMode: "default" }), null);
  assert.match(handoffDestinationError(agent, "claude-code", { model: "model" })!, /different agent/);
  assert.match(handoffDestinationError({ ...agent, authStatus: "unknown" }, "codex-app-server", { model: "model" })!, /authenticate/);
  assert.match(handoffDestinationError(agent, "codex-app-server", { model: "missing" })!, /supported destination model/);
  assert.match(handoffDestinationError(agent, "codex-app-server", { model: "model", effort: "unsupported" })!, /effort/);
});

test("a handoff carries the source service tier and refuses one the destination cannot honour", () => {
  const tiered = {
    ...agent,
    capabilities: {
      ...agent.capabilities!,
      models: [{ id: "model", serviceTiers: [{ id: "priority", name: "Priority" }] }],
    },
  };
  // The tier is a deliberate cost and latency choice, so it must survive the handoff.
  assert.equal(handoffDestinationError(tiered, "codex-app-server", { model: "model", serviceTier: "priority" }), null);
  // `default` is the provider-standard tier and needs no per-model advertisement.
  assert.equal(handoffDestinationError(tiered, "codex-app-server", { model: "model", serviceTier: "default" }), null);
  assert.equal(handoffDestinationError(agent, "codex-app-server", { model: "model", serviceTier: "default" }), null);
  assert.equal(handoffDestinationError(tiered, "codex-app-server", { model: "model" }), null);

  // A tier this model does not advertise is refused with an explanation rather than silently
  // replaced by the destination default, which is the whole point of #875.
  assert.match(
    handoffDestinationError(tiered, "codex-app-server", { model: "model", serviceTier: "flex" })!,
    /does not support this service tier/,
  );
  assert.match(
    handoffDestinationError(agent, "codex-app-server", { model: "model", serviceTier: "priority" })!,
    /does not support this service tier/,
  );
  // The allowlist still fails closed for anything genuinely unsupported.
  assert.match(
    handoffDestinationError(tiered, "codex-app-server", { model: "model", costBudgetUsd: 5 } as never)!,
    /Unsupported handoff settings/,
  );
});
