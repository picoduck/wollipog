import assert from "node:assert/strict";
import { test } from "node:test";
import type { DurableSessionCommand, RunnerMetadata } from "@wollipog/protocol";
import { canonicalAutomationCommandJson } from "./automation-command-outbox.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { SessionPromptOutbox } from "./session-prompt-outbox.js";

const RUNNER_ID = "runner-prompt-outbox";
const SESSION_ID = "session-prompt-outbox";
const NOW = 10_000;

const runner: RunnerMetadata = {
  runnerId: RUNNER_ID,
  hostname: "prompt-host",
  os: "linux",
  version: "1",
  agents: [],
  workspaces: [],
};

function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runner, NOW, 96);
  db.createSession({
    id: SESSION_ID,
    runnerId: RUNNER_ID,
    agentId: null,
    workspaceId: null,
    title: "Durable prompt fixture",
    useWorktree: false,
    driver: "acp",
    config: {},
    now: NOW,
  });
  const sent: unknown[] = [];
  const changed: string[] = [];
  const warnings: string[] = [];
  const hub = {
    isRunnerOnline: (runnerId: string) => runnerId === RUNNER_ID,
    sendToRunner: (_runnerId: string, message: unknown) => { sent.push(message); return true; },
    sessionChangedById: (sessionId: string) => { changed.push(sessionId); },
  } as unknown as Hub;
  const outbox = new SessionPromptOutbox(db, hub, { warn: (message) => { warnings.push(message); } });
  return { db, outbox, sent, changed, warnings };
}

function prompt(text = "deliver this prompt"): DurableSessionCommand {
  return { type: "prompt_session", sessionId: SESSION_ID, text };
}

test("durable prompt receipts reject every malformed runner frame without mutating stored state", () => {
  const { db, outbox, warnings } = fixture();
  try {
    const staged = outbox.stage(SESSION_ID, RUNNER_ID, prompt(), NOW);
    const validUpdate = {
      type: "durable_session_command_update",
      commandId: staged.commandId,
      sessionId: SESSION_ID,
      state: "queued",
      revision: 1,
    } as const;
    for (const [name, receipt] of [
      ["negative revision", { ...validUpdate, revision: -1 }],
      ["overlong command id", { ...validUpdate, commandId: "c".repeat(257) }],
      ["unknown state", { ...validUpdate, state: "unknown" }],
      ["overlong error", { ...validUpdate, error: "e".repeat(4_097) }],
      ["unknown code", { ...validUpdate, code: "UNKNOWN_CODE" }],
      ["result without duplicate", {
        ...validUpdate,
        type: "durable_session_command_result",
        requestId: "request-1",
      }],
      ["update with non-integer user event sequence", { ...validUpdate, userEventSeq: 1.5 }],
    ] as const) {
      assert.equal(outbox.receipt(RUNNER_ID, receipt as never, NOW + 1), false, name);
      const stored = db.getSessionPromptCommand(staged.commandId);
      assert.equal(stored?.revision, 0, name);
      assert.equal(stored?.state, "pending", name);
    }
    assert.equal(warnings.length, 7);
    assert.ok(warnings.every((warning) => /malformed durable prompt receipt/u.test(warning)));
  } finally {
    db.close();
  }
});

test("durable prompt receipt database failures are contained", () => {
  const { db, outbox, warnings } = fixture();
  try {
    const staged = outbox.stage(SESSION_ID, RUNNER_ID, prompt(), NOW);
    const original = db.recordSessionPromptCommandReceipt.bind(db);
    db.recordSessionPromptCommandReceipt = () => { throw new Error("receipt database unavailable"); };
    try {
      assert.doesNotThrow(() => {
        assert.equal(outbox.receipt(RUNNER_ID, {
          type: "durable_session_command_update",
          commandId: staged.commandId,
          sessionId: SESSION_ID,
          state: "queued",
          revision: 1,
        }, NOW + 1), false);
      });
    } finally {
      db.recordSessionPromptCommandReceipt = original;
    }
    assert.match(warnings.at(-1) ?? "", /receipt database unavailable/u);
    assert.equal(db.getSessionPromptCommand(staged.commandId)?.state, "pending");
    assert.equal(db.getSessionPromptCommand(staged.commandId)?.revision, 0);
  } finally {
    db.close();
  }
});

test("provider-authentication receipts terminalize durable prompts and stop retries", () => {
  const { db, outbox, sent, changed, warnings } = fixture();
  try {
    const staged = outbox.stage(SESSION_ID, RUNNER_ID, prompt(), NOW);
    assert.equal(outbox.flush(NOW + 1), 1);
    assert.equal(sent.length, 1);

    const error = "provider authentication is required";
    assert.equal(outbox.receipt(RUNNER_ID, {
      type: "durable_session_command_update",
      commandId: staged.commandId,
      sessionId: SESSION_ID,
      state: "failed",
      revision: 1,
      error,
      code: "PROVIDER_AUTHENTICATION_REQUIRED",
    }, NOW + 2), true);

    const failed = db.getSessionPromptCommand(staged.commandId);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.revision, 1);
    assert.equal(failed?.error, error);
    assert.equal(failed?.errorCode, "PROVIDER_AUTHENTICATION_REQUIRED");
    assert.deepEqual(changed, [SESSION_ID]);
    assert.deepEqual(warnings, []);

    sent.length = 0;
    assert.equal(outbox.flush(NOW + 60_000), 0);
    assert.deepEqual(sent, [], "a terminal authentication failure is never resent");
  } finally {
    db.close();
  }
});

test("flush fails an unparseable stored durable prompt without sending it", () => {
  const { db, outbox, sent, changed, warnings } = fixture();
  try {
    const staged = outbox.stage(SESSION_ID, RUNNER_ID, prompt(), NOW);
    db.raw().prepare("UPDATE session_prompt_commands SET payload_json=? WHERE command_id=?")
      .run("{", staged.commandId);

    assert.equal(outbox.flush(NOW + 1), 0);
    assert.deepEqual(sent, []);
    const failed = db.getSessionPromptCommand(staged.commandId);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.revision, 1);
    assert.match(failed?.error ?? "", /payload is malformed/u);
    assert.deepEqual(changed, [SESSION_ID]);
    assert.match(warnings.at(-1) ?? "", /payload is malformed/u);
  } finally {
    db.close();
  }
});

test("flush fails a stored durable prompt whose payload digest no longer matches", () => {
  const { db, outbox, sent, changed, warnings } = fixture();
  try {
    const staged = outbox.stage(SESSION_ID, RUNNER_ID, prompt(), NOW);
    db.raw().prepare("UPDATE session_prompt_commands SET payload_json=? WHERE command_id=?")
      .run(canonicalAutomationCommandJson(prompt("execute a different prompt")), staged.commandId);

    assert.equal(outbox.flush(NOW + 1), 0);
    assert.deepEqual(sent, []);
    const failed = db.getSessionPromptCommand(staged.commandId);
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.revision, 1);
    assert.match(failed?.error ?? "", /digest does not match/u);
    assert.deepEqual(changed, [SESSION_ID]);
    assert.match(warnings.at(-1) ?? "", /digest does not match/u);
  } finally {
    db.close();
  }
});
