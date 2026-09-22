import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  cleanupPiExternalSession,
  externalSessionStoreDriver,
  materializePiExternalSession,
  readExternalTranscript,
  readSessionHead,
  resolveWslPiSourcePath,
  resolveLaunchForAgent,
  resolveLaunchForDriver,
  retargetExternalSession,
} from "./sources.js";

/* resolveLaunchForDriver decides BOTH the descriptor's `resumable` flag (list labeling) and whether
 * an adopt lands promptable or read-only — these tests pin the matching rules it shares. */

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: ["--flag"],
    env: { KEY: "v" },
    driver: "claude-code",
    context: { kind: "native" },
    available: true,
    ...overrides,
  };
}

test("native session discovery reads only a bounded transcript head", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-session-head-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "large.jsonl");
  writeFileSync(path, `header\n${"x".repeat(1024 * 1024)}`, "utf8");

  const head = readSessionHead(path, 64);

  assert.equal(Buffer.byteLength(head, "utf8"), 64);
  assert.equal(head, `header\n${"x".repeat(57)}`);
});

test("Codex App Server discovers the shared Codex rollout store", () => {
  assert.equal(externalSessionStoreDriver("codex-app-server"), "codex");
  assert.equal(externalSessionStoreDriver("codex"), "codex");
  assert.equal(externalSessionStoreDriver("claude-code"), "claude-code");
  assert.equal(externalSessionStoreDriver("pi"), "pi");
});

test("native Pi adoption copies a validated snapshot without changing the external JSONL", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-adopt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceDir = join(root, "external");
  const sessionRoot = join(root, "manager", "s_pi");
  mkdirSync(sourceDir, { recursive: true });
  const id = "019e47e6-3480-7e52-ba8a-e97b85ef7857";
  const fileName = `2026-09-16T12-00-00-000Z_${id}.jsonl`;
  const sourcePath = join(sourceDir, fileName);
  const transcript = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-16T12:00:00.000Z", cwd: "/repo/pi" }),
    JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, message: { role: "user", content: "Continue safely" } }),
  ].join("\n") + "\n";
  writeFileSync(sourcePath, transcript, "utf8");

  const materialized = await materializePiExternalSession({
    path: sourcePath,
    descriptor: {
      agentSessionId: id,
      driver: "pi",
      cwd: "/repo/pi",
      context: { kind: "native" },
      title: "Continue safely",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 1,
    },
  }, "s_pi", sessionRoot);

  assert.equal(readFileSync(sourcePath, "utf8"), transcript, "the external Pi history remains byte-identical");
  assert.equal(readFileSync(join(materialized.sessionDir, fileName), "utf8"), transcript);
  assert.equal(materialized.descriptor.agentSessionId, id);
  assert.deepEqual(materialized.events, [{ kind: "user_message", text: "Continue safely", final: true }]);
  assert.deepEqual(
    await readExternalTranscript(materialized.descriptor, root, materialized.sessionDir),
    materialized.events,
    "reprocessing follows the runner-owned copy instead of the external source",
  );
});

test("Pi adoption rejects an incomplete trailing JSONL record and removes its staging directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-adopt-incomplete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = "019e47e6-3480-7e52-ba8a-e97b85ef7857";
  const sourcePath = join(root, `2026-09-16_${id}.jsonl`);
  const sessionRoot = join(root, "manager", "s_pi");
  writeFileSync(sourcePath, JSON.stringify({ type: "session", version: 3, id, cwd: "/repo/pi" }), "utf8");
  await assert.rejects(materializePiExternalSession({
    path: sourcePath,
    descriptor: {
      agentSessionId: id,
      driver: "pi",
      cwd: "/repo/pi",
      context: { kind: "native" },
      title: "",
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
    },
  }, "s_pi", sessionRoot), /complete JSONL record/u);
  assert.equal(existsSync(sessionRoot), false);
});

test("Pi adoption cleanup never removes sibling runner session state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-pi-adopt-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionRoot = join(root, "s_pi");
  const sessionDir = join(sessionRoot, "pi-adopted-sessions");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionRoot, "meta.json"), "retained", "utf8");
  await cleanupPiExternalSession({ kind: "native" }, sessionDir, "s_pi");
  assert.equal(existsSync(sessionDir), false);
  assert.equal(readFileSync(join(sessionRoot, "meta.json"), "utf8"), "retained");
});

test("WSL Pi adoption resolves listed paths under the verified distro session store", () => {
  assert.equal(
    resolveWslPiSourcePath("/home/demo", ".pi/agent/sessions/--repo--/session_pi-id.jsonl"),
    "/home/demo/.pi/agent/sessions/--repo--/session_pi-id.jsonl",
  );
  assert.throws(
    () => resolveWslPiSourcePath("/home/demo", ".pi/agent/sessions/../../outside.jsonl"),
    /outside the WSL Pi session store/u,
  );
  assert.throws(
    () => resolveWslPiSourcePath("/home/demo", "/tmp/session_pi-id.jsonl"),
    /outside the WSL Pi session store/u,
  );
});

test("Pi cleanup rejects an unrecognized WSL path before invoking the distro", async () => {
  await assert.rejects(
    cleanupPiExternalSession(
      { kind: "wsl", distro: "Ubuntu" },
      "/home/user/.pi/agent/sessions",
      "s_pi",
    ),
    /refusing to remove an unrecognized WSL Pi adoption directory/u,
  );
});

test("an explicit App Server selection retargets only the matching Codex context", () => {
  const found = {
    agentSessionId: "thread-1",
    driver: "codex" as const,
    cwd: "/repo",
    context: { kind: "native" as const },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
  };
  assert.equal(retargetExternalSession(found, { driver: "codex-app-server", context: { kind: "native" } }).driver, "codex-app-server");
  assert.equal(retargetExternalSession(found, { driver: "claude-code", context: { kind: "native" } }).driver, "codex");
  assert.equal(
    retargetExternalSession(found, { driver: "codex-app-server", context: { kind: "wsl", distro: "Ubuntu" } }).driver,
    "codex",
  );
});

test("App Server adoption retargets a discovered Codex rollout and resolves its launch", () => {
  const found = {
    agentSessionId: "thread-1",
    driver: "codex" as const,
    cwd: "/repo",
    context: { kind: "native" as const },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
  };
  const selected = {
    driver: "codex-app-server" as const,
    context: { kind: "native" as const },
  };
  const appServer = agent({
    id: "codex-app-server",
    name: "Codex",
    command: "codex",
    args: ["app-server"],
    driver: "codex-app-server",
  });

  const descriptor = retargetExternalSession(found, selected);
  const launch = resolveLaunchForDriver([appServer], descriptor.driver, descriptor.context);

  assert.equal(descriptor.driver, "codex-app-server");
  assert.deepEqual(launch, { command: "codex", args: ["app-server"], env: { KEY: "v" } });
});

test("App Server transcript backfill reads the shared Codex rollout store", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-app-server-transcript-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessions = join(home, ".codex", "sessions", "2026", "07", "16");
  mkdirSync(sessions, { recursive: true });
  const agentSessionId = "019e47e6-3480-7e52-ba8a-e97b85ef7857";
  writeFileSync(
    join(sessions, `rollout-2026-07-16T00-00-00-${agentSessionId}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: agentSessionId, cwd: "/repo", timestamp: "2026-07-16T00:00:00.000Z" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the work" }] },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Continuing now." } }),
    ].join("\n"),
    "utf8",
  );

  const events = await readExternalTranscript({
    agentSessionId,
    driver: "codex-app-server",
    cwd: "/repo",
    context: { kind: "native" },
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
  }, home);

  assert.deepEqual(events, [
    { kind: "user_message", text: "Continue the work", final: true },
    { kind: "agent_message", text: "Continuing now.", final: true },
  ]);
});

test("matches an agent by driver + native context and returns its launch params", () => {
  const launch = resolveLaunchForDriver([agent()], "claude-code", { kind: "native" });
  assert.deepEqual(launch, { command: "claude", args: ["--flag"], env: { KEY: "v" } });
});

test("driver launch resolution preserves verified signed-out provider recovery", () => {
  const signedOut = agent({
    available: false,
    authStatus: "unauthenticated",
    claudeCode: { status: "unauthenticated" } as AgentDefinition["claudeCode"],
  });
  assert.deepEqual(resolveLaunchForDriver([signedOut], "claude-code", { kind: "native" }), {
    command: "claude",
    args: ["--flag"],
    env: { KEY: "v" },
  });
  assert.equal(resolveLaunchForDriver([
    agent({ available: false, authStatus: "unauthenticated", claudeCode: undefined }),
  ], "claude-code", { kind: "native" }), null, "config-only unavailable rows cannot self-attest recovery");
});

test("returns null when no agent matches the driver (the non-resumable case)", () => {
  assert.equal(resolveLaunchForDriver([agent()], "codex", { kind: "native" }), null);
});

test("a WSL descriptor only matches an agent in the SAME distro", () => {
  const ubuntu = agent({ context: { kind: "wsl", distro: "Ubuntu" } });
  assert.ok(resolveLaunchForDriver([ubuntu], "claude-code", { kind: "wsl", distro: "Ubuntu" }));
  assert.equal(resolveLaunchForDriver([ubuntu], "claude-code", { kind: "wsl", distro: "Debian" }), null);
  // A WSL agent can't resume a native session either — separate ~/.claude stores.
  assert.equal(resolveLaunchForDriver([ubuntu], "claude-code", { kind: "native" }), null);
});

test("absent driver/context on an agent default to acp/native (back-compat)", () => {
  const bare = agent({ driver: undefined, context: undefined });
  assert.ok(resolveLaunchForDriver([bare], "acp", { kind: "native" }));
  assert.equal(resolveLaunchForDriver([bare], "claude-code", { kind: "native" }), null);
});

test("missing args/env on the matched agent normalize to empty", () => {
  const sparse = agent({ args: undefined as unknown as string[], env: undefined as unknown as Record<string, string> });
  assert.deepEqual(resolveLaunchForDriver([sparse], "claude-code", { kind: "native" }), {
    command: "claude",
    args: [],
    env: {},
  });
});

test("exact launch authorization preserves signed-out provider recovery but rejects unavailable rows", () => {
  const signedOut = agent({
    available: false,
    authStatus: "unauthenticated",
    claudeCode: { status: "unauthenticated" } as AgentDefinition["claudeCode"],
  });
  assert.deepEqual(
    resolveLaunchForAgent([signedOut], "claude", "claude-code", { kind: "native" }),
    { command: "claude", args: ["--flag"], env: { KEY: "v" } },
    "the installed signed-out CLI reaches SessionManager authentication remediation",
  );

  const missing = agent({
    available: false,
    authStatus: "unknown",
    claudeCode: { status: "unavailable" } as AgentDefinition["claudeCode"],
  });
  assert.equal(resolveLaunchForAgent([missing], "claude", "claude-code", { kind: "native" }), null);
  assert.equal(
    resolveLaunchForAgent([agent({ available: false })], "claude", "claude-code", { kind: "native" }),
    null,
    "a generic explicit disable is not mistaken for authentication recovery",
  );
});

test("a changed installation target fails closed and schedules rediscovery", () => {
  const missing = join(tmpdir(), "wollipog-replaced-harness-entry");
  let rediscoveries = 0;
  const selected = agent({ command: missing, args: [], installation: {
    id: "selected", path: missing, via: "path", targetIdentity: JSON.stringify([missing]),
  } });
  assert.equal(resolveLaunchForAgent([selected], "claude", "claude-code", { kind: "native" },
    () => { rediscoveries++; }), null);
  assert.equal(rediscoveries, 1);
});
