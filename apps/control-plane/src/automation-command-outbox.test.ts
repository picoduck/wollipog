import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableSessionCommand, DurableSessionCommandErrorCode } from "@wollipog/protocol";
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
