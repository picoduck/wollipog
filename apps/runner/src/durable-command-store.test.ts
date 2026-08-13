import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DurableSessionCommandMessage, StartSessionMessage } from "@wollipog/protocol";
import { DurableCommandStore, durableCommandPayloadDigest } from "./durable-command-store.js";

function startCommand(sessionId = "s_test"): StartSessionMessage {
  return {
    type: "start_session",
    spec: {
      sessionId,
      workspaceId: "ws",
      workspacePath: "/secret/workspace",
      agentId: "agent",
      title: "secret title",
      command: "secret-command",
      args: ["--secret-arg"],
      env: { SECRET_TOKEN: "must-not-leak" },
      useWorktree: false,
    },
    initialPrompt: "secret prompt",
  };
}

function message(
  command: StartSessionMessage = startCommand(),
  overrides: Partial<DurableSessionCommandMessage> = {},
): DurableSessionCommandMessage {
  return {
    type: "durable_session_command",
    requestId: "req_1",
    commandId: "cmd_test",
    executionId: "axe_test",
    payloadDigest: durableCommandPayloadDigest(command),
    expiresAt: 10_000,
    command,
    ...overrides,
  };
}

function files(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(root, entry.name))) result.push(join(root, entry.name, file));
  }
  return result;
}

test("durable command claims persist before acknowledgement and retain no command content", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-store-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    const claimed = store.claim(message());
    assert.equal(claimed.kind, "new");
    assert.equal(claimed.receipt.state, "accepted");
    const persisted = files(root).map((file) => readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(persisted, /secret prompt|must-not-leak|secret-command|secret-arg|secret\/workspace|secret title/);
    assert.match(persisted, /cmd_test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same id and payload deduplicates while a conflicting payload fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-dedupe-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    const first = store.claim(message());
    assert.equal(first.kind, "new");
    if (first.kind !== "new") return;
    assert.equal(first.handle.queued().state, "queued");
    const duplicate = store.claim(message());
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(duplicate.receipt.state, "queued");
    assert.equal(duplicate.receipt.duplicate, true);

    const changed = startCommand();
    changed.initialPrompt = "different";
    const conflict = store.claim(message(changed));
    assert.equal(conflict.kind, "conflict");
    assert.equal(conflict.receipt.code, "COMMAND_ID_CONFLICT");
    assert.equal(store.read("cmd_test")?.state, "queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale replay-safe ownership is reclaimed but a started command becomes uncertain", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-reclaim-"));
  let now = 1;
  try {
    const first = new DurableCommandStore(root, { ownerId: "owner-a", now: () => now, ownerStaleMs: 10 });
    const accepted = first.claim(message());
    assert.equal(accepted.kind, "new");
    now = 20;
    const second = new DurableCommandStore(root, { ownerId: "owner-b", now: () => now, ownerStaleMs: 10 });
    const reclaimed = second.claim(message());
    assert.equal(reclaimed.kind, "reclaimed");
    if (reclaimed.kind !== "reclaimed") return;
    assert.equal(reclaimed.handle.started(7).state, "started");

    now = 40;
    const third = new DurableCommandStore(root, { ownerId: "owner-c", now: () => now, ownerStaleMs: 10 });
    const uncertain = third.claim(message());
    assert.equal(uncertain.kind, "duplicate");
    assert.equal(uncertain.receipt.state, "uncertain");
    assert.equal(uncertain.receipt.userEventSeq, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale queued command resets to accepted when a new process reclaims it", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-queued-reclaim-"));
  let now = 1;
  try {
    const first = new DurableCommandStore(root, { ownerId: "owner-a", now: () => now, ownerStaleMs: 10 });
    const claimed = first.claim(message());
    assert.equal(claimed.kind, "new");
    if (claimed.kind !== "new") return;
    assert.equal(claimed.handle.queued().state, "queued");

    now = 20;
    const second = new DurableCommandStore(root, { ownerId: "owner-b", now: () => now, ownerStaleMs: 10 });
    const reclaimed = second.claim(message());
    assert.equal(reclaimed.kind, "reclaimed");
    if (reclaimed.kind !== "reclaimed") return;
    assert.equal(reclaimed.receipt.state, "accepted");
    assert.equal(reclaimed.receipt.duplicate, true);
    assert.equal(reclaimed.handle.started(8).state, "started");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal receipts are immutable and prune only after their dedupe horizon", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-prune-"));
  let now = 1;
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => now });
    const claimed = store.claim(message());
    assert.equal(claimed.kind, "new");
    if (claimed.kind !== "new") return;
    claimed.handle.started(3);
    assert.equal(claimed.handle.completed().state, "completed");
    assert.throws(() => claimed.handle.failed("late"), /invalid durable command transition/);
    assert.equal(store.prune(9_999), 0);
    assert.equal(store.prune(10_001), 1);
    assert.equal(store.read("cmd_test"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an abandoned nonterminal receipt is non-evictable until its explicit horizon", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-abandoned-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    assert.equal(store.claim(message()).kind, "new");
    assert.equal(store.prune(9_999), 0);
    assert.ok(store.read("cmd_test"));
    assert.equal(store.prune(10_001), 1);
    assert.equal(store.read("cmd_test"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full receipt store still acknowledges an existing command identity", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-full-dedupe-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1, maxReceipts: 1 });
    assert.equal(store.claim(message()).kind, "new");
    assert.equal(store.claim(message()).kind, "duplicate");
    const other = startCommand("s_other");
    const full = store.claim(message(other, { commandId: "cmd_other" }));
    assert.notEqual(full.kind, "busy");
    if (full.kind !== "busy") assert.equal(full.receipt.code, "RECEIPT_STORE_FULL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live owner lease prevents time-only command theft", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-owner-lease-"));
  let now = 1;
  try {
    const first = new DurableCommandStore(root, { ownerId: "owner-a", now: () => now, ownerStaleMs: 10 });
    assert.equal(first.claim(message()).kind, "new");
    now = 20;
    assert.equal(first.claim(message()).kind, "duplicate", "an operation refreshes the process lease");
    const second = new DurableCommandStore(root, { ownerId: "owner-b", now: () => now, ownerStaleMs: 10 });
    assert.equal(second.claim(message()).kind, "duplicate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed local journal transition relinquishes replay-safe work for retry", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-transition-retry-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    const first = store.claim(message());
    assert.equal(first.kind, "new");
    if (first.kind !== "new") return;
    const digest = createHash("sha256").update("cmd_test", "utf8").digest("hex");
    const lock = join(root, digest.slice(0, 2), `${digest}.json.lock`);
    writeFileSync(lock, "busy");
    assert.equal(store.claim(message()).kind, "busy", "lock contention must not emit a terminal receipt");
    assert.throws(() => first.handle.queued(), /busy/);
    rmSync(lock);
    assert.equal(store.claim(message()).kind, "reclaimed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed durable envelopes fail closed without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-malformed-envelope-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    const malformed = { ...message(), command: null } as never;
    assert.doesNotThrow(() => store.claim(malformed));
    const rejected = store.claim(malformed);
    assert.notEqual(rejected.kind, "busy");
    if (rejected.kind !== "busy") assert.equal(rejected.receipt.code, "INVALID_COMMAND");

    const hiddenBody = startCommand();
    hiddenBody.initialImages = [{
      artifactId: "art1", mimeType: "image/png", sizeBytes: 1, sha256: "a".repeat(64), data: "hidden",
    } as never];
    const bodyRejected = store.claim(message(hiddenBody, { commandId: "cmd_hidden" }));
    assert.notEqual(bodyRejected.kind, "busy");
    if (bodyRejected.kind !== "busy") assert.equal(bodyRejected.receipt.code, "INVALID_COMMAND");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated final receipt is never overwritten or retried as new", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-command-truncated-record-"));
  try {
    const store = new DurableCommandStore(root, { ownerId: "owner-a", now: () => 1 });
    const digest = createHash("sha256").update("cmd_test", "utf8").digest("hex");
    const file = join(root, digest.slice(0, 2), `${digest}.json`);
    mkdirSync(join(root, digest.slice(0, 2)), { recursive: true });
    writeFileSync(file, '{"version":1');
    const result = store.claim(message());
    assert.equal(result.kind, "conflict");
    assert.equal(result.receipt.code, "INVALID_COMMAND");
    assert.equal(readFileSync(file, "utf8"), '{"version":1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
