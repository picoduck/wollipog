/**
 * `turn/start`'s sandboxPolicy applies to "this turn and subsequent turns" (app-server schema), so
 * once one turn of a thread has sent it, the thread stays on it. A later turn must not omit it and
 * leave the driver believing the permission profile is in force (#1336, review finding CR-1.4).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexAppServerDriver } from "./codex-app-server.js";
import type { CodexPermissionProfileBase } from "../codex-permission-profile.js";

const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

/* eslint-disable @typescript-eslint/no-explicit-any */
function driverOn(threadId: string | null, config: Record<string, string> = {}) {
  return new CodexAppServerDriver({
    command: "codex", args: [], cwd: "/repo", env: {},
    config, context: { kind: "native" },
  }, { onEvent() {}, onStderr() {}, onExit() {} }) as any;
}

/** The sandboxPolicy each successive turn sends, as the session's mode changes turn by turn. */
async function turnPolicies(modes: string[], base: CodexPermissionProfileBase | null): Promise<unknown[]> {
  const driver = driverOn("thread-1", { permissionMode: modes[0]! });
  const seen: unknown[] = [];
  driver.permissionProfileBase = base;
  driver.threadId = "thread-1";
  driver.peer = {
    request: async (method: string, params: any) => {
      if (method === "turn/start") seen.push(params.sandboxPolicy ?? null);
      return { turn: { id: `turn-${seen.length}` } };
    },
  };
  for (const mode of modes) {
    driver.setConfig({ permissionMode: mode });
    const turn = driver.prompt("go");
    await nextTask();
    driver.settleTurn("end_turn");
    await turn;
  }
  return seen;
}

test("a thread that once received a legacy policy keeps receiving it", async () => {
  // workspace (profile) -> read-only (mismatch, legacy) -> workspace again: the last turn must NOT
  // fall back to profile-only, because the read-only policy would still be in force on the thread.
  assert.deepEqual(
    await turnPolicies(["auto-review", "read-only", "auto-review"], ":workspace"),
    [null, { type: "readOnly" }, { type: "workspaceWrite" }],
  );
});

test("a thread that never left the profile's mode never receives a legacy policy", async () => {
  assert.deepEqual(
    await turnPolicies(["auto-review", "on-request", "workspace-write"], ":workspace"),
    [null, null, null],
  );
});

test("with no profile, every turn sends exactly the policy it always did", async () => {
  assert.deepEqual(
    await turnPolicies(["auto-review", "read-only"], null),
    [{ type: "workspaceWrite" }, { type: "readOnly" }],
  );
});

test("a cancel that lands while the profile is being proven stops the app-server launch", async () => {
  // Review finding CR-3.3: the proof can take seconds; Stop during it must not be followed by a spawn.
  let release!: () => void;
  let spawned = 0;
  const driver = new CodexAppServerDriver({
    command: "codex", args: [], cwd: "/repo", env: {}, config: {}, context: { kind: "native" },
    hookStateDir: "/data/hooks/abc123",
  }, { onEvent() {}, onStderr() {}, onExit() {} }, undefined, {
    spawn: () => { spawned++; throw new Error("must not spawn"); },
    kill: () => {},
    permissionProfile: () => new Promise((resolve) => {
      release = () => resolve({ active: false, reason: "test" });
    }),
  });
  const initializing = driver.initialize();
  await nextTask();
  driver.cancel();
  release();
  await assert.rejects(initializing, /disposed before provider launch/);
  assert.equal(spawned, 0);
});

test("a new thread starts clean again", async () => {
  const driver = driverOn(null);
  driver.threadCarriesLegacySandboxPolicy = true;
  driver.peer = { request: async () => ({ thread: { id: "thread-2" } }) };
  await driver.newSession("/repo");
  assert.equal(driver.threadCarriesLegacySandboxPolicy, false);
});
/* eslint-enable @typescript-eslint/no-explicit-any */
