import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSlashCommand, SessionSnapshot } from "@wollipog/protocol";
import { SessionCommandAuthorityRegistry } from "./session-command-authority.js";

const commands: AgentSlashCommand[] = [
  {
    name: "review",
    source: "builtin",
    description: "Review changes",
    argumentHint: "[focus]",
    invocation: {
      id: "caller-supplied-id",
      catalogRevision: "caller-supplied-revision",
      executionMode: "structured",
    },
  },
  { name: "plugin-task", source: "plugin" },
];

function snapshot(slashCommands: AgentSlashCommand[] = commands): SessionSnapshot {
  return {
    id: "session-1",
    workspaceId: null,
    agentId: "claude-native",
    title: "Command session",
    status: "idle",
    driver: "claude",
    useWorktree: false,
    worktreePath: null,
    config: {},
    agentCapabilities: { slashCommands },
    preview: null,
    pendingApproval: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("exact catalog and provenance reuse live opaque IDs and strip caller authority", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const first = registry.refresh("session-1", commands, "native:claude:launch-1");
  const second = registry.refresh("session-1", commands.map((command) => ({ ...command })), "native:claude:launch-1");

  assert.deepEqual(second, first);
  assert.notEqual(first[0]?.invocation?.id, "caller-supplied-id");
  assert.notEqual(first[0]?.invocation?.catalogRevision, "caller-supplied-revision");
  assert.match(first[0]?.invocation?.id ?? "", /^command_[0-9a-f-]{36}$/);
  assert.match(first[0]?.invocation?.catalogRevision ?? "", /^catalog_[0-9a-f-]{36}$/);
  assert.equal(first[0]?.invocation?.executionMode, "passthrough");
});

test("catalog or provenance changes rotate the revision and every command ID", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const first = registry.refresh("session-1", commands, "native:claude:launch-1");
  const changedCatalog = registry.refresh("session-1", [
    ...commands,
    { name: "new-command", source: "user" },
  ], "native:claude:launch-1");
  const changedProvenance = registry.refresh("session-1", [
    ...commands,
    { name: "new-command", source: "user" },
  ], "native:claude:launch-2");

  assert.notEqual(changedCatalog[0]?.invocation?.catalogRevision, first[0]?.invocation?.catalogRevision);
  assert.notEqual(changedCatalog[0]?.invocation?.id, first[0]?.invocation?.id);
  assert.notEqual(changedProvenance[0]?.invocation?.catalogRevision, changedCatalog[0]?.invocation?.catalogRevision);
  assert.notEqual(changedProvenance[0]?.invocation?.id, changedCatalog[0]?.invocation?.id);
});

test("execution mode is catalog authority and rotates otherwise identical live catalogs", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const passthrough = registry.refresh(
    "session-1",
    commands,
    "live-provider:launch-1",
    "passthrough",
  );
  const structured = registry.refresh(
    "session-1",
    commands,
    "live-provider:launch-1",
    "structured",
  );
  assert.notEqual(
    structured[0]?.invocation?.catalogRevision,
    passthrough[0]?.invocation?.catalogRevision,
  );
  assert.notEqual(structured[0]?.invocation?.id, passthrough[0]?.invocation?.id);
  assert.equal(structured[0]?.invocation?.executionMode, "structured");

  const invocation = structured[0]?.invocation;
  assert.ok(invocation);
  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: invocation.id,
    catalogRevision: invocation.catalogRevision,
    expectedExecutionMode: "passthrough",
  }), { ok: false, code: "COMMAND_MODE_UNSUPPORTED" });
  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: invocation.id,
    catalogRevision: invocation.catalogRevision,
    expectedExecutionMode: "structured",
  }), {
    ok: true,
    command: {
      name: "review",
      source: "builtin",
      description: "Review changes",
      argumentHint: "[focus]",
    },
    commandName: "review",
    executionMode: "structured",
  });
});

test("resolve distinguishes stale catalogs, missing commands, and unsupported modes", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const [authorized] = registry.refresh("session-1", commands, "native:claude:launch-1");
  assert.ok(authorized?.invocation);

  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: authorized.invocation.id,
    catalogRevision: "stale",
    expectedExecutionMode: "passthrough",
  }), { ok: false, code: "COMMAND_CATALOG_STALE" });
  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: "missing",
    catalogRevision: authorized.invocation.catalogRevision,
    expectedExecutionMode: "passthrough",
  }), { ok: false, code: "COMMAND_UNAVAILABLE" });
  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: authorized.invocation.id,
    catalogRevision: authorized.invocation.catalogRevision,
    expectedExecutionMode: "structured",
  }), { ok: false, code: "COMMAND_MODE_UNSUPPORTED" });
  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: authorized.invocation.id,
    catalogRevision: authorized.invocation.catalogRevision,
    expectedExecutionMode: "passthrough",
  }), {
    ok: true,
    command: {
      name: "review",
      source: "builtin",
      description: "Review changes",
      argumentHint: "[focus]",
    },
    commandName: "review",
    executionMode: "passthrough",
  });
});

test("clear immediately revokes a live catalog", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const [authorized] = registry.refresh("session-1", commands, "native:claude:launch-1");
  assert.ok(authorized?.invocation);
  registry.clear("session-1");

  assert.deepEqual(registry.resolve({
    sessionId: "session-1",
    providerCommandId: authorized.invocation.id,
    catalogRevision: authorized.invocation.catalogRevision,
    expectedExecutionMode: "passthrough",
  }), { ok: false, code: "COMMAND_UNAVAILABLE" });
});

test("snapshot overlay is non-mutating, v75-gated, and never preserves persisted authority", () => {
  const registry = new SessionCommandAuthorityRegistry();
  const original = snapshot();
  const originalJson = JSON.stringify(original);
  const [authorized] = registry.refresh("session-1", commands, "native:claude:launch-1");

  const legacy = registry.overlaySnapshot(original, 74);
  assert.equal(legacy.agentCapabilities?.slashCommands?.[0]?.invocation, undefined);
  assert.equal(JSON.stringify(original), originalJson);

  const current = registry.overlaySnapshot(original, 75);
  assert.deepEqual(current.agentCapabilities?.slashCommands, registry.refresh(
    "session-1",
    commands,
    "native:claude:launch-1",
  ));
  assert.equal(current.agentCapabilities?.slashCommands?.[0]?.invocation?.id, authorized?.invocation?.id);

  registry.clear("session-1");
  const displayOnly = registry.overlaySnapshot(original, 75);
  assert.equal(displayOnly.agentCapabilities?.slashCommands?.[0]?.invocation, undefined);
});
