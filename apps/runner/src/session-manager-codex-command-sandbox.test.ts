/**
 * A Codex launch whose command sandbox cannot start, with no runner boundary to stand in for it,
 * fails with a typed reason the control plane turns into blocked work for the person (#3843),
 * instead of a session that starts and then has every command escalate or be declined.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AgentDriverKind, RunnerToControlPlane } from "@wollipog/protocol";
import { CodexAppServerDriver } from "./drivers/codex-app-server.js";
import type { Driver, DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { metaToSnapshot, SessionStore, type SessionMeta } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";

const shortDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function stored(root: string): SessionMeta {
  return {
    sessionId: "codex-session", agentId: "codex-native", workspaceId: "workspace", repoPath: root,
    worktreePath: null, driver: "codex-app-server", command: "codex", args: [], env: {}, agentSessionId: null,
    context: { kind: "native" }, status: "idle", title: "codex", config: {}, tokensIn: 0,
    tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
  };
}

/** Answers like codex-cli 0.165.0 on a host whose kernel refuses its bubblewrap a user namespace. */
function namespaceRestrictedAppServer(methods: string[]): AgentProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4243,
  });
  child.stdin.setEncoding("utf8");
  let buffered = "";
  child.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      if (message.id === undefined) continue;
      methods.push(message.method);
      const result = message.method === "initialize" ? { userAgent: "codex-test" }
        : message.method === "command/exec" ? { exitCode: 1, stdout: "",
          stderr: "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n" }
          : message.method === "thread/start" ? { thread: { id: "thread-new" } } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  return child as unknown as AgentProcess;
}

test("a Codex launch whose command sandbox cannot start fails with a typed launch failure", {
  skip: process.platform === "linux" ? false : "the launch probe runs on native Linux only",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-sandbox-"));
  const store = new SessionStore(root);
  store.create(stored(root));
  const sent: RunnerToControlPlane[] = [];
  const methods: string[] = [];
  const factory = (kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    assert.equal(kind, "codex-app-server");
    return new CodexAppServerDriver(options, callbacks, undefined, {
      spawn: () => namespaceRestrictedAppServer(methods), kill: () => {},
      sandboxProbeCommand: () => ["/usr/bin/printf", "WOLLIPOG_CODEX_SANDBOX_PROBE_STARTED"],
    });
  };
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined, factory);
  try {
    manager.prompt("codex-session", "Fix the issue.");
    for (let index = 0; index < 300 && store.readMeta("codex-session")!.status !== "failed"; index += 1) await shortDelay();
    assert.equal(store.readMeta("codex-session")!.status, "failed");
    const failed = sent.filter((message) => message.type === "session_status" && message.status === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.type === "session_status" && failed[0]!.launchFailure, "codex_sandbox_unavailable");
    assert.match(failed[0]!.type === "session_status" ? failed[0]!.detail ?? "" : "",
      /does not let unprivileged processes create user namespaces/);
    assert.deepEqual(methods.filter((method) => method.startsWith("thread/") || method === "turn/start"), [],
      "no thread or turn exists before the probe decides");
    // The reason is kept with the failed state, so a restart or reconnect still reports it (CR-1.2).
    const meta = new SessionStore(root).readMeta("codex-session")!;
    assert.equal(meta.launchFailure, "codex_sandbox_unavailable");
    assert.equal(metaToSnapshot(meta).launchFailure, "codex_sandbox_unavailable");
    assert.equal(metaToSnapshot({ ...meta, status: "idle" }).launchFailure, undefined);
    // Every other failure keeps its untyped status.
    assert.equal(sent.some((message) => message.type === "session_status" && message.status !== "failed" &&
      "launchFailure" in message), false);
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
