import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableSessionCommand } from "@wollipog/protocol";
import { durableCommandPayloadDigest } from "../../runner/src/durable-command-store.js";
import { automationCommandDigest } from "./automation-command-outbox.js";

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
