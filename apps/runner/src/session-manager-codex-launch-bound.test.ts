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
import { SessionManager, type DurableCommandLifecycle } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import type { AgentProcess } from "./spawn.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const shortDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function stored(root: string): SessionMeta {
  return {
    sessionId: "codex-session",
    agentId: "codex-native",
    workspaceId: "workspace",
    repoPath: root,
    worktreePath: null,
    driver: "codex-app-server",
    command: "codex",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "thread-persisted",
    status: "idle",
    title: "codex",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A fake app server that answers every request except `silent`, whose response never arrives,
 * as when the record carrying it was lost or the server hung. */
function silentAppServer(silent: string, methods: string[]): AgentProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 4242,
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
      if (message.method === silent) continue;
      const result = message.method === "initialize" ? { userAgent: "codex-test" } :
        message.method === "thread/read" ? { thread: { id: "thread-persisted", status: { type: "idle" } } } : {};
      child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    }
  });
  return child as unknown as AgentProcess;
}

test("a Codex launch whose thread/resume is never answered fails within the bound and settles held prompts as never sent (#3099)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-codex-launch-"));
  const store = new SessionStore(root);
  store.create(stored(root));
  const sent: RunnerToControlPlane[] = [];
  const methods: string[] = [];
  const killed: AgentProcess[] = [];
  const factory = (kind: AgentDriverKind, options: DriverOptions, callbacks: DriverCallbacks): Driver => {
    assert.equal(kind, "codex-app-server");
    return new CodexAppServerDriver(options, callbacks, undefined, {
      spawn: () => silentAppServer("thread/resume", methods),
      kill: (child) => { killed.push(child); },
      initializationRequestTimeoutMs: 50,
    });
  };
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner", undefined, factory);
  const receipts = new Map<string, string[]>();
  const lifecycle = (commandId: string): DurableCommandLifecycle => {
    const transitions: string[] = [];
    receipts.set(commandId, transitions);
    return {
      commandId,
      queued: () => transitions.push("queued"),
      started: () => transitions.push("started"),
      completed: () => transitions.push("completed"),
      failed: (error) => transitions.push(`failed:${error}`),
      uncertain: (error) => transitions.push(`uncertain:${error}`),
    };
  };
  try {
    manager.prompt("codex-session", "Continue the campaign.", [], undefined, undefined, lifecycle("launching-prompt"));
    for (let index = 0; index < 100 && !methods.includes("thread/resume"); index += 1) await tick();
    assert.ok(methods.includes("thread/resume"), "the launch is waiting on thread/resume");
    // Admitted while the launch is still Starting, so providerLaunchPending holds it (#3096).
    manager.prompt("codex-session", "Also check the tests.", [], undefined, undefined, lifecycle("held-prompt"));
    for (let index = 0; index < 5; index += 1) await tick();
    assert.equal(store.readMeta("codex-session")!.status, "starting");
    assert.deepEqual(receipts.get("held-prompt"), ["queued"]);

    for (let index = 0; index < 200 && store.readMeta("codex-session")!.status === "starting"; index += 1) await shortDelay();
    assert.equal(store.readMeta("codex-session")!.status, "failed");
    const errors = store.readEvents("codex-session").flatMap((event) =>
      event.payload.kind === "error" ? [event.payload.message] : []);
    assert.deepEqual(errors, [
      "agent init failed: could not resume Codex thread thread-persisted: " +
        "Codex app-server did not answer thread/resume within 50 ms",
    ]);
    assert.deepEqual(receipts.get("held-prompt"), ["queued", "failed:the provider launch ended before this message was sent"]);
    // The prompt that started the launch settles through the resume-failure path, also never sent.
    assert.equal(receipts.get("launching-prompt")!.at(-1), "failed:provider session could not be resumed");
    assert.equal(receipts.get("launching-prompt")!.includes("started"), false);
    // No correlated user event, so a fresh delivery of either command remains stageable.
    assert.equal(store.readEvents("codex-session").some((event) => event.payload.kind === "user_message"), false);
    assert.equal(methods.includes("turn/start"), false, "no turn reached the provider");
    assert.equal(killed.length, 1, "the unresponsive app server is stopped");
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});
