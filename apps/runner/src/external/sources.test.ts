import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  externalSessionStoreDriver,
  readExternalTranscript,
  readSessionHead,
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
