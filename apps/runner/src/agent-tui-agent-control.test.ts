/**
 * Issue #1379: an Orchestrator TUI open whose session is deleted while it prepares must write no
 * runner-owned agent-control files, exactly as #1337 required of the managed-worktree guard's
 * hook files.
 *
 * These tests drive the REAL credential provisioning (`provisionAgentControl`) into a temp config
 * directory against a REAL `SessionStore`, and delete the session through the store the way
 * `delete_session` does — marking the permanent fence and removing this session's agent-control
 * files — while `prepareAgentTuiLaunch` is still awaiting scratch preparation.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import {
  agentControlTokenPath,
  provisionAgentControl,
  removeAgentControlFiles,
  type AgentControlHost,
} from "./agent-control.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const SESSION = "s1379orc";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: SESSION,
    agentId: "codex",
    workspaceId: "workspace",
    repoPath: "/repo",
    worktreePath: "/repo-wt",
    // A Codex Orchestrator: its configuration probe is what makes TUI preparation slow enough for
    // a delete to land inside the window this fence covers.
    driver: "codex",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "structured-provider-session",
    status: "idle",
    title: "Test",
    config: { permissionMode: "orchestrator" },
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function agentControlHost(configDir: string): AgentControlHost {
  return {
    configDir,
    execPath: process.execPath,
    scriptPath: "/runner/cli.ts",
    execArgv: [],
    isSea: false,
    platform: "linux",
  };
}

/** Exactly the wiring `index.ts` gives `prepareAgentTuiLaunch`, against a temp config directory. */
function dependencies(
  store: SessionStore,
  configDir: string,
  registered: string[],
  prepareScratch: () => Promise<string>,
) {
  return {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    executionIsolationMode: "bwrap" as const,
    platform: "linux" as const,
    prepareScratch,
    // `index.ts` resolves this through the same store fence the guard's protection source uses.
    assertSessionNotDeleted: (sessionId: string) => {
      if (!store.readMeta(sessionId) || store.isDeleted(sessionId)) {
        throw new Error("session is being deleted");
      }
    },
    provision: (prepared: SessionMeta) => provisionAgentControl(prepared, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner",
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "bwrap" as const,
      registerCredential: (sessionId: string) => registered.push(sessionId),
    }, () => {}, agentControlHost(configDir)),
    provisionManagedWorktreeGuard: (spec: SessionMeta) => ({
      protections: [],
      args: spec.args,
      guardActive: false,
    }),
    probe: async () => ["-c", "mcp_servers.ambient.enabled=false"],
  };
}

test("a session deleted while the TUI prepares leaves no agent-control files behind (#1379)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tui-agent-control-"));
  const store = new SessionStore(join(root, "sessions"));
  const configDir = join(root, "agent-control");
  const registered: string[] = [];
  try {
    const source = meta();
    store.create(source);
    let probes = 0;
    await assert.rejects(
      prepareAgentTuiLaunch(source, {
        ...dependencies(store, configDir, registered, async () => {
          // `delete_session` lands while scratch preparation is still in flight: it fences the id
          // and removes this session's runner-owned agent-control files.
          store.markDeleted(SESSION);
          store.remove(SESSION);
          removeAgentControlFiles(SESSION, configDir);
          return join(root, "scratch");
        }),
        probe: async () => { probes++; return []; },
      }),
      /session is being deleted/u,
    );
    // Nothing runner-owned may survive the refusal: not a credential file, not a registration, and
    // not the provider-side probe the launch would have run next.
    assert.deepEqual(existsSync(configDir) ? readdirSync(configDir) : [], []);
    assert.deepEqual(registered, []);
    assert.equal(probes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undeleted Orchestrator TUI still provisions its agent-control credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-tui-agent-control-"));
  const store = new SessionStore(join(root, "sessions"));
  const configDir = join(root, "agent-control");
  const registered: string[] = [];
  try {
    const source = meta();
    store.create(source);
    const launch = await prepareAgentTuiLaunch(
      source,
      dependencies(store, configDir, registered, async () => join(root, "scratch")),
    );
    // The control for the assertions above: provisioning does write and register here, so an empty
    // config directory in the deleted case is the fence's doing and not a launch that never ran.
    assert.ok(launch);
    assert.equal(existsSync(agentControlTokenPath(configDir, SESSION)), true);
    assert.deepEqual(registered, [SESSION]);
    assert.ok(launch.env?.WOLLIPOG_SESSION_TOKEN_FILE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
