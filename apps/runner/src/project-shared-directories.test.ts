import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { projectSharedDirectories, validateSharedDirectoryConfiguration } from "./project-shared-directories.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { resolveConfig } from "./config.js";
import { buildCodexTurnParams } from "./drivers/codex-app-server.js";
import { configuredSessionWritablePaths } from "./review-trust.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";
import type { IsolationStateOptions } from "./execution-isolation.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "wollipog-project-shared-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), runtime = join(root, "qa/runtime"), state = join(root, "state");
  for (const path of [repo, runtime, state]) mkdirSync(path, { recursive: true });
  const workspace = { id: "project", name: "Project", path: repo, sharedWritableDirectories: [runtime] };
  const session = { workspaceId: "project", repoPath: repo, context: { kind: "native" as const } };
  return { root, repo, runtime, state, workspace, session };
}

test("operator config accepts bounded absolute shared runtime paths and rejects malformed input", () => {
  assert.deepEqual(validateSharedDirectoryConfiguration(["/srv/qa/runtime"]), ["/srv/qa/runtime"]);
  for (const value of ["/srv/qa", ["relative"], ["/srv/../qa"], ["/srv/qa\0"], [1], Array(17).fill("/srv/qa")]) {
    assert.throws(() => validateSharedDirectoryConfiguration(value), /sharedWritableDirectories/);
  }
  assert.throws(() => resolveConfig({ runnerId: "r", controlPlaneUrl: "ws://localhost", workspaces: [
    { id: "p", name: "P", path: "/srv/project", sharedWritableDirectories: ["./qa"] },
  ] }), /sharedWritableDirectories/);
});

test("grants match both workspace identity and repository, never reviews, WSL or another project", (t) => {
  const f = fixture(t);
  assert.deepEqual(projectSharedDirectories([f.workspace], f.session, [f.state]), [f.runtime]);
  for (const changed of [{ workspaceId: "other" }, { repoPath: join(f.root, "other") },
    { context: { kind: "wsl" as const, distro: "Ubuntu" } }, { review: {} }]) {
    assert.deepEqual(projectSharedDirectories([f.workspace], { ...f.session, ...changed }, [f.state]), []);
  }
});

test("a grant cannot expose HOME, a checkout, runner state, credentials or a symlink alias", (t) => {
  const f = fixture(t), alias = join(f.root, "alias"); symlinkSync(f.runtime, alias);
  for (const grant of ["/", homedir(), f.repo, join(f.repo, "cache"), f.state, f.root, alias]) {
    assert.throws(() => projectSharedDirectories([{ ...f.workspace, sharedWritableDirectories: [grant] }], f.session, [f.state]));
  }
  assert.throws(() => projectSharedDirectories([{ ...f.workspace, sharedWritableDirectories: [join(f.root, "missing")] }], f.session, []));
});

test("the actual provider launch receives the operator grant, while another project and a review do not", {
  skip: process.platform !== "linux",
}, async (t) => {
  const f = fixture(t); let captured: IsolationStateOptions | undefined;
  const manager = new SessionManager(() => {}, () => {}, new SessionStore(join(f.root, "sessions")), "runner",
    undefined, undefined, f.state, 1, undefined, undefined, { agentLimits: {}, agentWeights: {} },
    { mode: "bwrap", network: "inherit" }, async (_policy, _context, _deps, state) => {
      captured = state; return { backend: "bwrap", command: "bwrap", args: [], network: "inherit" };
    });
  manager.configureSharedDirectories([f.workspace]);
  t.after(() => manager.shutdownAll());
  const internal = manager as unknown as { resolveLaunchIsolation(meta: SessionMeta, cwd: string): Promise<unknown> };
  const meta = { ...f.session, sessionId: "s1", config: {}, driver: "claude-code", env: {} } as SessionMeta;
  await internal.resolveLaunchIsolation(meta, f.repo);
  assert.deepEqual(captured?.projectSharedWritableRoots, [f.runtime]);
  assert.ok(captured?.additionalWritableRoots?.includes(f.runtime));
  captured = undefined;
  await internal.resolveLaunchIsolation({ ...meta, workspaceId: "other" }, f.repo);
  assert.equal((captured as IsolationStateOptions | undefined)?.projectSharedWritableRoots, undefined);
  captured = undefined;
  assert.equal(await internal.resolveLaunchIsolation({ ...meta, review: {} } as SessionMeta, f.repo), undefined);
  assert.equal(captured, undefined);
});

test("bubblewrap carries the exact shared root and fails closed when it becomes an alias", async () => {
  const state = { driver: "acp" as const, dataDir: "/state", cwd: "/repo", env: {}, sessionId: "s",
    projectSharedWritableRoots: ["/qa/runtime"], additionalWritableRoots: ["/qa/runtime"] };
  const deps = { platform: "linux" as const, uid: () => 1000,
    existsNative: async () => true, realpathNative: async (path: string) => path, mkdirNative: async () => {},
    resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path" as const, launch: { command: "/usr/bin/bwrap", args: [] } }) };
  const result = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, deps, state);
  assert.equal(result?.backend, "bwrap");
  if (result?.backend !== "bwrap") return;
  assert.deepEqual(result.projectSharedWritableRoots, ["/qa/runtime"]);
  assert.ok(result.writableBinds?.some(bind => bind.source === "/qa/runtime" && bind.target === "/qa/runtime"));
  await assert.rejects(() => resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" },
    { ...deps, realpathNative: async () => "/other" }, state), /changed before sandbox/);
  await assert.rejects(() => resolveExecutionIsolation({ mode: "provider", network: "inherit" }, { kind: "native" }, deps, state),
    /require a native Linux/);
});

test("Codex inner workspace includes shared runtime, while read-only and Orchestrator modes stay narrow", () => {
  const params = buildCodexTurnParams({ permissionMode: "auto-review" }, "t", "/repo", [], undefined,
    [], ":workspace", false, [], ["/qa/runtime"]);
  assert.deepEqual(params.sandboxPolicy, { type: "workspaceWrite", writableRoots: ["/repo", "/qa/runtime"] });
  const readOnly = buildCodexTurnParams({ permissionMode: "read-only" }, "t", "/repo", [], undefined,
    [], null, false, [], ["/qa/runtime"]);
  assert.deepEqual(readOnly.sandboxPolicy, { type: "readOnly" });
  const orchestrator = buildCodexTurnParams({ permissionMode: "orchestrator" }, "t", "/repo", [], undefined,
    [], null, false, [], ["/qa/runtime"]);
  assert.deepEqual((orchestrator.sandboxPolicy as { writableRoots: string[] }).writableRoots, ["/repo"]);
});

test("shared runtime is untrusted for the independent review bootstrap", (t) => {
  const f = fixture(t);
  assert.ok(configuredSessionWritablePaths({ workspaces: [f.workspace] }).includes(f.runtime));
});
