import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerConfigWorkspace } from "./config.js";
import { configuredSessionWritablePaths, trustedExecutable } from "./review-trust.js";
import type { SessionMeta } from "./session-store.js";
import { removeConfiguredWorkspace, WORKSPACE_REMOVALS_FILE, WorkspaceRemovals } from "./workspace-removals.js";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "workspace-removals-"));
  const home = join(dataDir, "home");
  mkdirSync(home);
  writeFileSync(join(home, "notes.txt"), "kept");
  const workspaces: RunnerConfigWorkspace[] = [
    { id: "home", name: "home", path: home },
    { id: "site", name: "site", path: "/srv/site" },
  ];
  return { dataDir, home, workspaces, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("removing a configured workspace records it, drops it in place and leaves its folder alone", (t) => {
  const { dataDir, home, workspaces, cleanup } = fixture();
  t.after(cleanup);
  const removals = new WorkspaceRemovals(dataDir);
  const result = removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "home", path: home, sessionRunningIn: () => false, now: 5,
  });
  assert.deepEqual(result, { ok: true, removed: { id: "home", name: "home", path: home } });
  assert.deepEqual(workspaces.map((workspace) => workspace.id), ["site"]);
  assert.equal(readFileSync(join(home, "notes.txt"), "utf8"), "kept");
  const file = join(dataDir, WORKSPACE_REMOVALS_FILE);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, removed: [{ id: "home", path: home, removedAt: 5 }] });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  // A restart reads the same configuration and the removal keeps it out.
  const restarted: RunnerConfigWorkspace[] = [
    { id: "home", name: "home", path: home },
    { id: "site", name: "site", path: "/srv/site" },
  ];
  const dropped = new WorkspaceRemovals(dataDir).apply(restarted);
  assert.deepEqual(dropped.map((workspace) => workspace.id), ["home"]);
  assert.deepEqual(restarted.map((workspace) => workspace.id), ["site"]);

  // A retried request after a lost reply succeeds without writing again.
  assert.deepEqual(removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "home", path: home, sessionRunningIn: () => false,
  }), { ok: true, removed: null });
});

test("a removal matches only the exact folder it removed", (t) => {
  const { dataDir, home, cleanup } = fixture();
  t.after(cleanup);
  const removals = new WorkspaceRemovals(dataDir);
  removals.record({ id: "home", path: home }, 1);
  const reconfigured: RunnerConfigWorkspace[] = [{ id: "home", name: "home", path: "/srv/elsewhere" }];
  assert.deepEqual(removals.apply(reconfigured), []);
  assert.equal(reconfigured.length, 1);
});

test("removal is refused while a session runs there, for a changed folder, and for an unknown workspace", (t) => {
  const { dataDir, home, workspaces, cleanup } = fixture();
  t.after(cleanup);
  const removals = new WorkspaceRemovals(dataDir);
  assert.deepEqual(removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "home", path: home, sessionRunningIn: (id) => id === "home",
  }), { ok: false, error: "A session is running in this workspace. Stop it, then try again." });
  assert.deepEqual(removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "home", path: "/elsewhere", sessionRunningIn: () => false,
  }), { ok: false, error: "This workspace's folder changed on this machine. Reload and try again." });
  assert.deepEqual(removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "missing", path: "/x", sessionRunningIn: () => false,
  }), { ok: false, error: "This workspace is not configured on this machine." });
  assert.equal(workspaces.length, 2);
  assert.equal(existsSync(join(dataDir, WORKSPACE_REMOVALS_FILE)), false);
});

test("a removed workspace's granted directories stay session-writable for reviewer trust, across a restart", { skip: process.platform === "win32" }, (t) => {
  const { dataDir, home, cleanup } = fixture();
  t.after(cleanup);
  const granted = join(dataDir, "granted-tools");
  mkdirSync(granted, { mode: 0o755 });
  chmodSync(granted, 0o755);
  // An earlier, now archived session could write the granted directory and left a reviewer there.
  const planted = join(granted, "codex");
  writeFileSync(planted, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(planted, 0o755);
  const workspaces: RunnerConfigWorkspace[] = [
    { id: "home", name: "home", path: home, additionalDirectoryGrants: [granted], sharedWritableDirectories: [join(dataDir, "shared")] },
  ];
  const uid = process.getuid?.() ?? -1;
  const rootUid = statSync("/").uid;
  const trustRoots = (removals: WorkspaceRemovals) => configuredSessionWritablePaths({
    workspaces: [...workspaces, ...removals.writableHistory()],
    sessions: [{ repoPath: home, worktreePath: null } as SessionMeta],
  });
  const removals = new WorkspaceRemovals(dataDir);
  assert.throws(() => trustedExecutable("codex", granted, trustRoots(removals), uid, rootUid), /a session can write/u);

  assert.equal(removeConfiguredWorkspace({
    workspaces, removals, workspaceId: "home", path: home, sessionRunningIn: () => false,
  }).ok, true);
  assert.equal(workspaces.length, 0);
  assert.throws(() => trustedExecutable("codex", granted, trustRoots(removals), uid, rootUid), /a session can write/u,
    "removal ends new use, not what earlier sessions left");
  assert.throws(() => trustedExecutable("codex", granted, trustRoots(new WorkspaceRemovals(dataDir)), uid, rootUid),
    /a session can write/u, "the record keeps the grant across a restart");
  assert.deepEqual(new WorkspaceRemovals(dataDir).writableHistory(), [{
    path: home, additionalDirectoryGrants: [granted], sharedWritableDirectories: [join(dataDir, "shared")],
  }]);
});

test("an unreadable removal record is reported and leaves the configuration as written", (t) => {
  const { dataDir, workspaces, cleanup } = fixture();
  t.after(cleanup);
  writeFileSync(join(dataDir, WORKSPACE_REMOVALS_FILE), "{not json");
  const warnings: string[] = [];
  assert.deepEqual(new WorkspaceRemovals(dataDir, (message) => warnings.push(message)).apply(workspaces), []);
  assert.equal(workspaces.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /ignoring unreadable/u);
});
