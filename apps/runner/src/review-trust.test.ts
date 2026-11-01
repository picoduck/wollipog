import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, chownSync, lchownSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedPath, configuredSessionWritablePaths } from "./review-trust.js";
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
    workspaces: [{ path: at("project"), additionalDirectoryGrants: [at("grant")] }],
    providerAccounts: [{ directory: at("account-claude") }],
    agents: [
      { id: "codex-custom", env: { CODEX_HOME: at("agent-codex"), HOME: at("agent-home") } },
      { id: "from-env", env: { CLAUDE_CONFIG_DIR: { fromEnv: "WOLLIPOG_TEST_CLAUDE_HOME" }, CODEX_HOME: { fromEnv: "WOLLIPOG_TEST_UNSET" } } },
      { id: "relative", env: { CODEX_HOME: "relative/codex" } },
    ],
    sessions: [{
      repoPath: at("project"), worktreePath: at("worktree"),
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
