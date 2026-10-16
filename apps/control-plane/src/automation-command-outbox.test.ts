import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_EXEC_RETIRED_REASON,
  PROTOCOL_VERSION,
  type DurableSessionCommand,
  type DurableSessionCommandErrorCode,
} from "@wollipog/protocol";
import { durableCommandPayloadDigest } from "../../runner/src/durable-command-store.js";
import { AutomationCommandOutbox, automationCommandDigest } from "./automation-command-outbox.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

const DURABLE_RECEIPT_CODES = [
  "COMMAND_ID_CONFLICT",
  "COMMAND_EXPIRED",
  "INVALID_COMMAND",
  "SESSION_NOT_FOUND",
  "QUEUE_FULL",
  "COMMAND_CANCELLED",
  "PROVIDER_AUTHENTICATION_REQUIRED",
  "WORKTREE_RECOVERY_REQUIRED",
  "RECEIPT_STORE_FULL",
] as const satisfies readonly DurableSessionCommandErrorCode[];

test("control-plane and runner canonicalize durable commands identically", () => {
  const command: DurableSessionCommand = {
    type: "prompt_session",
    sessionId: "s-1",
    text: "continue",
    images: undefined,
    slashCommand: undefined,
    config: { model: undefined, effort: "high", maxToolCalls: 12 },
  };
  assert.equal(automationCommandDigest(command), durableCommandPayloadDigest(command));
  assert.equal(
    automationCommandDigest(command),
    automationCommandDigest(JSON.parse(JSON.stringify(command)) as DurableSessionCommand),
    "persisting payload_json must not change its digest",
  );
  const launch = {
    type: "start_session",
    spec: { sessionId: "s-2", env: { Z_TOKEN: "z", a_token: "a" } },
  } as DurableSessionCommand;
  assert.equal(automationCommandDigest(launch), durableCommandPayloadDigest(launch),
    "mixed-case launch keys must use the same code-unit ordering on both sides");
});

test("automation receipts accept every protocol error code and reject unknown values", () => {
  const writes: Array<{ code?: DurableSessionCommandErrorCode }> = [];
  const warnings: string[] = [];
  const db = {
    recordAutomationCommandReceipt: (input: { code?: DurableSessionCommandErrorCode }) => {
      writes.push(input);
      return { advanced: false };
    },
  } as unknown as ControlPlaneDb;
  const outbox = new AutomationCommandOutbox(
    db,
    {} as Hub,
    { warn: (message) => { warnings.push(message); } },
    () => undefined,
  );

  for (const [index, code] of DURABLE_RECEIPT_CODES.entries()) {
    assert.equal(outbox.receipt("runner-1", {
      type: "durable_session_command_update",
      commandId: `command-${index}`,
      sessionId: "session-1",
      state: "failed",
      revision: 1,
      error: `failure-${index}`,
      code,
    }), true, code);
    assert.equal(writes.at(-1)?.code, code);
  }

  const writeCount = writes.length;
  assert.equal(outbox.receipt("runner-1", {
    type: "durable_session_command_update",
    commandId: "command-unknown",
    sessionId: "session-1",
    state: "failed",
    revision: 1,
    code: "UNKNOWN_CODE",
  } as never), false);
  assert.equal(writes.length, writeCount, "unknown codes never reach storage");
  assert.match(warnings.at(-1) ?? "", /malformed durable command receipt/u);
});

test("commands staged before Codex exec was retired are rejected instead of reaching a runner (#3259)", () => {
  const commands: Record<string, DurableSessionCommand> = {
    "exec-start": { type: "start_session", spec: { sessionId: "new-exec", driver: "codex", command: "codex" } } as DurableSessionCommand,
    "exec-prompt": { type: "prompt_session", sessionId: "legacy-exec", text: "continue" } as DurableSessionCommand,
    "exec-answer": { type: "answer_recovered_question", sessionId: "legacy-exec", requestId: "q-1" } as DurableSessionCommand,
    "app-server-start": { type: "start_session", spec: { sessionId: "new-app", driver: "codex-app-server", command: "codex" } } as DurableSessionCommand,
  };
  const rejected: Array<[string, string]> = [];
  const sent: string[] = [];
  const db = {
    getRunner: () => ({ protocolVersion: PROTOCOL_VERSION }),
    getSession: (id: string) => id === "legacy-exec" ? { id, driver: "codex" } : undefined,
    expireAutomationCommands: () => [],
    dueAutomationCommands: () => Object.entries(commands).map(([commandId, command]) => ({
      commandId, executionId: `execution-${commandId}`, runnerId: "runner-1", attemptCount: 0, expiresAt: null,
      payloadJson: JSON.stringify(command), payloadSha256: automationCommandDigest(command),
    })),
    rejectAutomationCommand: (commandId: string, error: string) => { rejected.push([commandId, error]); },
    markAutomationCommandSent: () => true,
  } as unknown as ControlPlaneDb;
  const hub = {
    isRunnerOnline: () => true,
    sendToRunner: (_runnerId: string, message: { commandId: string }) => { sent.push(message.commandId); return true; },
  } as unknown as Hub;
  const outbox = new AutomationCommandOutbox(db, hub, { warn: () => {} }, () => undefined);

  assert.equal(outbox.flush(1_000), 1);
  assert.deepEqual(rejected, [
    ["exec-start", CODEX_EXEC_RETIRED_REASON],
    ["exec-prompt", CODEX_EXEC_RETIRED_REASON],
    ["exec-answer", CODEX_EXEC_RETIRED_REASON],
  ]);
  assert.deepEqual(sent, ["app-server-start"]);
});
