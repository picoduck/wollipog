import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
