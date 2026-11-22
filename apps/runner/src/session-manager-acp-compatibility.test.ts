import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AcpLaunchRefusedError } from "./acp-compatibility.js";
import type { Driver, DriverOptions } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

// An Antigravity launch (#4779): the runner's launch preparation supplies the agent's credential
// context scrub list and compatibility profile, and the session manager hands both to the driver.
test("launch preparation's credential scrub and ACP compatibility reach the provider driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-compat-"));
  const store = new SessionStore(root);
  let options: DriverOptions | undefined;
  let prepared: SessionMeta | undefined;
  const driver: Driver = {
    get pid() { return undefined; },
    initialize: async () => {},
    newSession: async () => "provider-session",
    agentSessionId: () => "provider-session",
    prompt: async () => "end_turn",
    setConfig: () => {},
    cancel: () => {},
    resolvePermission: () => false,
    dispose: () => {},
  };
  const manager = new SessionManager(
    () => {}, () => {}, store, "compat-runner", undefined,
    (_kind, opts) => { options = opts; return driver; },
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    (meta: SessionMeta) => {
      prepared = meta;
      meta.command = "/resolved/by/setup/agy";
      return { scrubInheritedEnv: ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"], acpCompatibility: { profile: "antigravity", resumable: false } };
    },
  );
  try {
    assert.equal(await manager.start({
      sessionId: "antigravity-session", workspaceId: "workspace", workspacePath: root, agentId: "google-antigravity",
      driver: "acp", command: "agy", args: ["acp"], env: {}, useWorktree: false, title: "", titleSource: "generated",
    }), true);
    assert.ok(prepared);
    assert.equal(options?.command, "/resolved/by/setup/agy", "the executable the setup resolves at launch");
    assert.deepEqual(options?.scrubInheritedEnv, ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT"]);
    assert.deepEqual(options?.acpCompatibility, { profile: "antigravity", resumable: false });
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// A launch whose preparation finds nothing verified to run (#4779) never constructs a driver: the
// session fails with the runner's sentence, as a failed provider start would.
test("a launch refusal from preparation fails the session without spawning a provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-refusal-"));
  const store = new SessionStore(root);
  let constructed = 0;
  const manager = new SessionManager(
    () => {}, () => {}, store, "compat-runner", undefined,
    () => { constructed++; throw new Error("no driver may be constructed"); },
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    () => ({ launchRefusal: "Google Antigravity could not be started on this machine. Check its setup in Connections." }),
  );
  try {
    await manager.start({
      sessionId: "refused", workspaceId: "workspace", workspacePath: root, agentId: "google-antigravity",
      driver: "acp", command: "agy", args: ["acp"], env: {}, useWorktree: false, title: "", titleSource: "generated",
    });
    assert.equal(constructed, 0);
    assert.equal(store.readMeta("refused")?.status, "failed");
    const errors = store.readEvents("refused").flatMap((event) => event.payload.kind === "error" ? [event.payload.message] : []);
    assert.deepEqual(errors, ["agent init failed: Google Antigravity could not be started on this machine. Check its setup in Connections."]);
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// Nothing launchable any more when the client was about to spawn (#4779): the session fails with the
// same launch failure as a refusal at preparation, not as a process that could not be created.
test("a refusal at spawn time fails the session with the agent's start failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-acp-spawn-refusal-"));
  const store = new SessionStore(root);
  const sentence = "Google Antigravity could not be started on this machine. Check its setup in Connections.";
  const manager = new SessionManager(
    () => {}, () => {}, store, "compat-runner", undefined,
    () => { throw new AcpLaunchRefusedError(sentence); },
    undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
    () => ({ acpCompatibility: { profile: "antigravity", resumable: false, resolveLaunch: () => null } }),
  );
  try {
    await manager.start({
      sessionId: "spawn-refused", workspaceId: "workspace", workspacePath: root, agentId: "google-antigravity",
      driver: "acp", command: "agy", args: ["acp"], env: {}, useWorktree: false, title: "", titleSource: "generated",
    });
    assert.equal(store.readMeta("spawn-refused")?.status, "failed");
    const errors = store.readEvents("spawn-refused").flatMap((event) => event.payload.kind === "error" ? [event.payload.message] : []);
    assert.deepEqual(errors, [`agent init failed: ${sentence}`]);
  } finally {
    manager.shutdownAll();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// A refusal at spawn comes before any process exists (#4779), so the launch's provider-HOME
// reference is released rather than kept until shutdown, as it is when a constructor may have started one.
test("a refusal at spawn releases the launch's provider-HOME reference; another construction failure keeps it", async () => {
  for (const refused of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "wollipog-acp-refusal-home-"));
    const store = new SessionStore(root);
    const settled: string[] = [];
    const manager = new SessionManager(
      () => {}, () => {}, store, "compat-runner", undefined,
      () => { throw refused ? new AcpLaunchRefusedError("Google Antigravity could not be started on this machine. Check its setup in Connections.")
        : new Error("constructor failed after a spawn"); },
      undefined, 4, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [],
      () => ({ acpCompatibility: { profile: "antigravity", resumable: false, resolveLaunch: () => null } }),
    );
    (manager as unknown as { providerHomeLeases: unknown }).providerHomeLeases = {
      stopAcquisitions() {},
      async acquire() {},
      async acquireReference() {
        return { first: true, release: async () => { settled.push("released"); return true; }, retain: async () => { settled.push("retained"); } };
      },
    };
    try {
      await manager.start({
        sessionId: "home", workspaceId: "workspace", workspacePath: root, agentId: "google-antigravity",
        driver: "acp", command: "agy", args: ["acp"], env: {}, useWorktree: false, title: "", titleSource: "generated",
      });
      assert.equal(store.readMeta("home")?.status, "failed");
      assert.equal(settled.at(-1), refused ? "released" : "retained", refused ? "no process used the HOME" : "a process may have");
    } finally {
      manager.shutdownAll();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});
