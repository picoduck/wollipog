import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, chownSync, lchownSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredSessionWritableGrants, configuredSessionWritablePaths, explainSessionWritableRefusal, homeWritableRoots, trustedPath,
} from "./review-trust.js";
import type { SessionMeta } from "./session-store.js";
const uid = process.getuid?.() ?? -1;
const rootUid = statSync("/").uid;
const posixOnly = { skip: process.platform === "win32" };
function executable(path: string, body = "#!/bin/sh\nexit 0\n"): string {
  writeFileSync(path, body, { mode: 0o755 }); return path;
}

test("trustedPath refuses a regular path owned by another user", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-other-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const tool = executable(join(root, "tool"));
  // Root-owned paths are intentionally trusted, so give root-run fixtures a non-root owner.
  const ownerUid = uid === 0 ? 1000 : statSync(root).uid;
  if (uid === 0) {
    chownSync(root, ownerUid, statSync(root).gid);
    chownSync(tool, ownerUid, statSync(tool).gid);
  }
  const otherUid = ownerUid + 1;
  assert.equal(statSync(root).mode & 0o777, 0o700);
  // A temporary ancestor may also belong to the fixture owner rather than root.
  assert.throws(() => trustedPath(tool, [], otherUid, rootUid), /is owned by another user$/);
  assert.equal(trustedPath(tool, [], ownerUid, rootUid), tool);
});

test("trustedPath refuses another user's symlink before following its target", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-other-link-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const tool = executable(join(root, "tool"));
  const link = join(root, "link");
  symlinkSync(tool, link);
  const ownerUid = uid === 0 ? 1000 : statSync(root).uid;
  if (uid === 0) {
    chownSync(root, ownerUid, statSync(root).gid);
    chownSync(tool, ownerUid, statSync(tool).gid);
    lchownSync(link, ownerUid, statSync(root).gid);
  }
  const otherUid = ownerUid + 1;
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.throws(() => trustedPath(link, [], otherUid, rootUid), {
    message: `${link} is owned by another user`,
  }, "the link itself is refused before checking its containing directory or target");
  assert.equal(trustedPath(link, [], ownerUid, rootUid), tool);
});

test("trusted paths refuse session-writable roots and other-user-writable components", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const safe = join(root, "safe"); mkdirSync(safe, { mode: 0o755 });
  const codexHome = join(root, "home", ".codex", "bin"); mkdirSync(codexHome, { recursive: true });
  const tool = executable(join(safe, "tool"));
  const planted = executable(join(codexHome, "codex"));
  assert.equal(trustedPath(tool, [join(root, "home", ".codex")], uid, rootUid), tool);
  assert.throws(() => trustedPath(planted, [join(root, "home", ".codex")], uid, rootUid), /a session can write/);
  chmodSync(tool, 0o757);
  assert.throws(() => trustedPath(tool, [], uid, rootUid), /writable by every user/);
  chmodSync(tool, 0o775);
  assert.equal(trustedPath(tool, [], uid, rootUid, undefined, () => true), tool, "proven user-private group writes are safe");
  assert.throws(() => trustedPath(tool, [], uid, rootUid, undefined, () => false), /writable by its group/,
    "shared groups remain untrusted even below a private ancestor");
  const link = join(root, "link"); symlinkSync(planted, link);
  assert.throws(() => trustedPath(link, [join(root, "home", ".codex")], uid, rootUid), /a session can write/, "symlinks are resolved first");
  // A trusted target reached through a link a session could repoint is refused too.
  const hop = join(root, "home", ".codex", "hop"); symlinkSync(tool, hop);
  assert.throws(() => trustedPath(hop, [join(root, "home", ".codex")], uid, rootUid), /a session can write/);
  const chained = join(safe, "chained"); symlinkSync(hop, chained);
  assert.throws(() => trustedPath(chained, [join(root, "home", ".codex")], uid, rootUid), /a session can write/,
    "every hop's directory is checked, not only the final path");
});

test("a sticky shared directory like /tmp is a safe ancestor even when its group can write it", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-sticky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755); // no private ancestor below the system temporary directory, as on CI
  const shared = join(root, "shared"); mkdirSync(shared); chmodSync(shared, 0o1777);
  const safe = join(shared, "safe"); mkdirSync(safe, { mode: 0o755 });
  const tool = executable(join(safe, "tool"));
  assert.equal(trustedPath(tool, [], uid, rootUid), tool);
  chmodSync(safe, 0o1777);
  assert.throws(() => trustedPath(safe, [], uid, rootUid), /writable by every user/, "the path itself never may be writable");
});

test("provider account, agent, session and host provider homes are session-writable roots", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-roots-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, dataDir: join(root, "data") };
  mkdirSync(f.dataDir);
  const at = (name: string) => join(f.root, name);
  const paths = configuredSessionWritablePaths({
    workspaces: [{ name: "Project", path: at("project"), additionalDirectoryGrants: [at("grant")] }],
    providerAccounts: [{ label: "Claude", directory: at("account-claude") }],
    agents: [
      { id: "codex-custom", env: { CODEX_HOME: at("agent-codex"), HOME: at("agent-home") } },
      { id: "from-env", env: { CLAUDE_CONFIG_DIR: { fromEnv: "WOLLIPOG_TEST_CLAUDE_HOME" }, CODEX_HOME: { fromEnv: "WOLLIPOG_TEST_UNSET" } } },
      { id: "relative", env: { CODEX_HOME: "relative/codex" } },
    ],
    sessions: [{
      sessionId: "s_roots", repoPath: at("project"), worktreePath: at("worktree"),
      worktrees: [{ id: "wt", path: at("attached"), branch: "b", source: "attached" }] as SessionMeta["worktrees"],
      env: { CLAUDE_CONFIG_DIR: at("session-env-claude"), HOME: at("session-home") },
      providerCredentialHome: at("session-credentials"), providerConversationHome: at("session-conversation"),
      pendingProviderCredentialHome: at("session-pending"),
    }],
    hostEnv: { CODEX_HOME: at("host-codex"), WOLLIPOG_TEST_CLAUDE_HOME: at("agent-claude-from-env") },
  });
  for (const expected of [
    "project", "grant", "account-claude", "agent-codex", "agent-home/.claude", "agent-home/.codex", "agent-home/.cache",
    "agent-claude-from-env", "worktree", "attached", "session-env-claude", "session-home/.codex", "session-credentials",
    "session-conversation", "session-pending", "host-codex",
  ]) assert.ok(paths.includes(at(expected)), `${expected} is a session-writable root`);
  assert.ok(paths.every((path) => path.startsWith("/")), "relative values are dropped");
});

const RELOCATION = "install the reviewer where no session can write and set its agent's command to that absolute path";

/** The conventional native Claude Code install: `~/.local/bin/claude` links into a versions tree. */
function conventionalClaude(home: string): { link: string; binary: string } {
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, ".local", "share", "claude", "versions"), { recursive: true });
  const binary = executable(join(home, ".local", "share", "claude", "versions", "2.1.0"));
  const link = join(home, ".local", "bin", "claude");
  symlinkSync(binary, link);
  return { link, binary };
}

function refusal(path: string, roots: readonly string[], grants: Parameters<typeof explainSessionWritableRefusal>[1],
  builtInRoots: readonly string[] = []): string {
  try { trustedPath(path, roots, uid, rootUid); } catch (error) {
    return (explainSessionWritableRefusal(error, grants, RELOCATION, builtInRoots) as Error).message;
  }
  assert.fail(`${path} was trusted`);
}

test("a home-directory workspace refuses the conventional Claude install by naming its grant and recovery (#4122)", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-home-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const home = join(root, "home"); mkdirSync(home);
  const project = join(root, "dev", "project"); mkdirSync(project, { recursive: true });
  const { link, binary } = conventionalClaude(home);
  const projectSession = { sessionId: "s_project", repoPath: project, worktreePath: join(root, "worktrees", "s_project"), env: {} };
  const sources = {
    workspaces: [{ name: "home", path: home }, { name: "Project", path: project }],
    sessions: [projectSession, { sessionId: "s_home", repoPath: home, worktreePath: null, env: {} }],
  };
  const builtIn = homeWritableRoots(home);
  // The review comes from a session in the separate project, yet the reviewer is shared: a session
  // in the home workspace could repoint `~/.local/bin/claude`, so the refusal stands.
  assert.equal(refusal(link, [...builtIn, ...configuredSessionWritablePaths(sources)], configuredSessionWritableGrants(sources), builtIn),
    `${join(home, ".local", "bin")} is inside a directory a session can write (${home}). To use it, ${RELOCATION}, or ` +
    `remove workspace "home" from this machine and delete session s_home. Granted by workspace "home" and session s_home`);

  // Removing only the workspace keeps the independent grant of a session that can resume there.
  const withoutWorkspace = { ...sources, workspaces: [{ name: "Project", path: project }] };
  assert.match(refusal(link, [...builtIn, ...configuredSessionWritablePaths(withoutWorkspace)],
    configuredSessionWritableGrants(withoutWorkspace), builtIn), /, or delete session s_home\. Granted by session s_home$/u);

  // Once neither grants HOME, the same installation is trusted for the separate project's review.
  const supported = { workspaces: [{ name: "Project", path: project }], sessions: [projectSession] };
  assert.equal(trustedPath(link, [...builtIn, ...configuredSessionWritablePaths(supported)], uid, rootUid), binary);
});

test("refusals offer withdrawals only when withdrawing every named grant would be enough", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-grant-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o700);
  const home = join(root, "home"); mkdirSync(home);
  const { link } = conventionalClaude(home);
  const bin = join(home, ".local", "bin");
  const sessions = ["s_1", "s_2", "s_3", "s_4"].map((sessionId) => ({ sessionId, repoPath: home, worktreePath: null, env: {} }));
  assert.match(refusal(link, [home], configuredSessionWritableGrants({ sessions })),
    /, or delete sessions s_1, s_2, s_3, s_4\. Granted by sessions s_1, s_2, s_3, s_4$/u);
  // Every grant that would refuse the path is named, not only the first root found.
  const nested = configuredSessionWritableGrants({
    workspaces: [{ name: "home", path: home }, { name: "Project", path: join(root, "project"), additionalDirectoryGrants: [join(home, ".local")] }],
  });
  assert.match(refusal(link, [home, join(home, ".local")], nested), new RegExp(
    `, or remove workspace "home" from this machine and remove that directory grant from workspace "Project"\\. ` +
    `Granted by workspace "home" and a directory grant of workspace "Project"$`, "u"));
  // A built-in root containing the path, even one a configured grant names too, is never withdrawn.
  const homeWorkspace = configuredSessionWritableGrants({ workspaces: [{ name: "home", path: home }] });
  for (const builtIn of [[join(home, ".local")], [home]]) {
    assert.equal(refusal(link, [...builtIn, home], homeWorkspace, builtIn),
      `${bin} is inside a directory a session can write (${builtIn[0]}). To use it, ${RELOCATION}. Granted by workspace "home"`);
  }
  // So is a grant whose canonical path is a built-in root.
  const alias = join(root, "home-alias"); symlinkSync(home, alias);
  assert.equal(refusal(link, [home], configuredSessionWritableGrants({ workspaces: [{ name: "alias", path: alias }] }), [alias]),
    `${bin} is inside a directory a session can write (${home}). To use it, ${RELOCATION}. Granted by workspace "alias"`);
  // A provider account directory has no withdrawal short of moving the program.
  assert.equal(refusal(link, [home], configuredSessionWritableGrants({ providerAccounts: [{ label: "Work", directory: home }] })),
    `${bin} is inside a directory a session can write (${home}). To use it, ${RELOCATION}. Granted by provider account "Work"`);
  // Built-in roots (provider homes, caches, temporary directories) have no configured grant.
  assert.equal(refusal(link, [home], [], [home]), `${bin} is inside a directory a session can write (${home}). To use it, ${RELOCATION}`);
  const unrelated = new Error("claude is not installed");
  assert.equal(explainSessionWritableRefusal(unrelated, [], RELOCATION, []), unrelated);
});

test("agent and session environments name the variable that grants a root", () => {
  const grants = configuredSessionWritableGrants({
    agents: [{ id: "claude", env: { HOME: "/srv/agent-home" } }],
    sessions: [{ sessionId: "s_env", repoPath: "/srv/project", worktreePath: null, env: { CODEX_HOME: "/srv/codex" } }],
    hostEnv: { CLAUDE_CONFIG_DIR: "/srv/claude" },
  });
  assert.deepEqual(grants.find((grant) => grant.path === "/srv/agent-home/.cache"),
    { path: "/srv/agent-home/.cache", grant: `HOME in agent "claude"'s environment`, recovery: `change HOME in agent "claude"'s environment` });
  assert.deepEqual(grants.find((grant) => grant.path === "/srv/codex"),
    { path: "/srv/codex", grant: "CODEX_HOME in session s_env", recovery: "delete session s_env", sessionId: "s_env" });
  assert.deepEqual(grants.find((grant) => grant.path === "/srv/claude"),
    { path: "/srv/claude", grant: "CLAUDE_CONFIG_DIR in the runner's environment" });
});
