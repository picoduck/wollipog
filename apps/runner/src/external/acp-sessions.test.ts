import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  acpSessionKey,
  configuredAcpAgent,
  findAcpExternalSession,
  listAcpExternalSessions,
} from "./acp-sessions.js";

const mockAgent = fileURLToPath(new URL("../../../mock-agent/index.mjs", import.meta.url));

function agent(id: string, cwd: string, extraEnv: Record<string, string> = {}): AgentDefinition {
  return {
    id,
    name: id,
    command: process.execPath,
    args: [mockAgent],
    env: {
      WOLLIPOG_MOCK_SESSION_LIST: "1",
      WOLLIPOG_MOCK_SESSION_LIST_IDS: "shared-session",
      WOLLIPOG_MOCK_SESSION_CWD: cwd,
      WOLLIPOG_MOCK_SESSION_TITLE: `${id}\n title`,
      ...extraEnv,
    },
    driver: "acp",
    context: { kind: "native" },
    available: true,
  };
}

test("ACP discovery preserves exact adapter identity and deduplicates by agent plus session id", async () => {
  const cwdA = await mkdtemp(join(tmpdir(), "wollipog-acp-list-a-"));
  const cwdB = await mkdtemp(join(tmpdir(), "wollipog-acp-list-b-"));
  const capabilities: string[] = [];
  try {
    const sessions = await listAcpExternalSessions(
      [
        agent("agent-a", cwdA),
        agent("agent-b", cwdB, { WOLLIPOG_MOCK_SESSION_LIFECYCLE: "load" }),
        { ...agent("broken-agent", cwdA), command: "wollipog-definitely-missing-acp-agent" },
      ],
      new Set([acpSessionKey("agent-a", "shared-session")]),
      (agentId) => capabilities.push(agentId),
    );
    assert.deepEqual(capabilities.sort(), ["agent-a", "agent-b"]);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.descriptor.agentId, "agent-b");
    assert.equal(sessions[0]!.descriptor.agentSessionId, "shared-session");
    assert.equal(sessions[0]!.descriptor.cwd, cwdB);
    assert.equal(sessions[0]!.descriptor.title, "agent-b title shared-session");
    assert.equal(sessions[0]!.descriptor.resumable, true, "load support is sufficient for continuation");
    assert.doesNotMatch(JSON.stringify(sessions), /fake-list-(meta|response)-secret-sentinel/);
  } finally {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwdA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(cwdB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ACP adoption lookup re-queries only the selected configured adapter", async () => {
  const cwdA = await mkdtemp(join(tmpdir(), "wollipog-acp-find-a-"));
  const cwdB = await mkdtemp(join(tmpdir(), "wollipog-acp-find-b-"));
  const agents = [agent("agent-a", cwdA), agent("agent-b", cwdB)];
  try {
    const found = await findAcpExternalSession(agents, "agent-b", "shared-session");
    assert.equal(found?.descriptor.agentId, "agent-b");
    assert.equal(found?.descriptor.cwd, cwdB);
    assert.equal(await findAcpExternalSession(agents, "missing-agent", "shared-session"), null);
    assert.equal(configuredAcpAgent([
      { ...agent("native", cwdA), driver: "codex" },
    ], "native"), null);
  } finally {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await rm(cwdA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(cwdB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ACP discovery drops invalid relative working directories", async () => {
  const sessions = await listAcpExternalSessions([agent("agent-invalid", "relative/path")], new Set());
  assert.deepEqual(sessions, []);
});

test("ACP discovery bounds excessive fanout without suppressing successful results", async () => {
  const agents = Array.from({ length: 17 }, (_, index) => agent(`agent-${index}`, tmpdir()));
  const warnings: string[] = [];
  const sessions = await listAcpExternalSessions(agents, new Set(), undefined, (warning) => warnings.push(warning));
  assert.equal(sessions.length, 16);
  assert.match(warnings[0]!, /first 16 of 17 configured adapters/);
  assert.equal(sessions.some((session) => session.descriptor.agentId === "agent-16"), false);
});
