import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { antigravityWorktreeAutoAllows } from "./antigravity-worktree-auto.js";

test("Antigravity worktree Auto allows literal local commands and keeps other requests interactive", {
  skip: process.platform !== "linux",
}, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-antigravity-auto-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "notes.txt"), "fixture");
  writeFileSync(join(root, "space name.txt"), "fixture");
  mkdirSync(join(root, "subdir"));
  const allows = (CommandLine: string, Cwd = root, extra = {}) => antigravityWorktreeAutoAllows(root, {
    name: "run_command", kind: "execute", title: "git status", rawInput: { CommandLine, Cwd, ...extra },
  });
  for (const command of [
    "pwd", "ls -lah", 'cat "space name.txt"', "rg -n 'note|text' notes.txt", "rg --files subdir",
    "grep -r fixture subdir", "git status", "git status --short", "git diff --cached -- notes.txt",
    "git log -3 --oneline", "git show HEAD", "git branch --list", "git rev-parse --show-toplevel",
    "git ls-files --others --exclude-standard", "git add -A", 'git add -- "space name.txt"',
    'git commit -m "Update the notes (Refs #123)"', "git restore --staged notes.txt", "git stash list",
    "git checkout -- notes.txt", "git reset",
    "git reset --mixed -- notes.txt", "git rm --cached notes.txt", "git mv notes.txt new.txt",
  ]) assert.equal(allows(command), true, command);
  for (const command of [
    "git push --dry-run", "git fetch", "git pull", "git clone origin", "git remote -v", "git submodule update",
    "git config core.hooksPath tmp", "git -c core.hooksPath=tmp commit -m test", "git --git-dir=.git status",
    "git --work-tree=/etc status", "git -C subdir status", "git merge main", "git rebase main",
    "git reset --hard", "git reset --mixed HEAD^", "git reset main", "git checkout origin/main",
    "git checkout --no-guess origin/main", "git switch origin/main", "git switch --detach HEAD",
    "git switch --no-guess main", "git checkout --recurse-submodules -- notes.txt", "git branch -D main",
    "git stash", "git stash push -u", "git stash apply", "git stash pop", "git stash drop", "git stash show",
    "git commit --no-verify -m test", "git commit -F /etc/passwd", "git add --pathspec-from-file=notes.txt",
    "git diff --output=../other", "git diff --no-index notes.txt /etc/passwd", "git show --ext-diff HEAD",
    "git rev-parse --sq", "git add -- .git", "git add -- ../outside", "git add -- ':(glob)*'",
    "git status && git push", "git status; pwd", "pwd | cat", "git status > ../outside",
    "git status\nls", "git status # comment", "GIT_DIR=/tmp git status", "bash -c 'git status'",
    'git commit -m "$(pwd)"', 'git commit -m "`pwd`"', "git add notes*", "git add 'notes*'",
    "git add -- ./subdir/../../outside", "rg --pre=sh test notes.txt", "rg test notes.txt --pre=sh",
    "ls -R", "cat /etc/passwd", "cat ../notes.txt", "cat .git", "curl https://example.invalid",
  ]) assert.equal(allows(command), false, command);
  assert.equal(allows("git status", join(root, "subdir")), false, "Git must run at the protected repository root");
  assert.equal(allows("ls", join(root, "subdir")), true);
  assert.equal(allows("git status", dirname(root)), false);
  assert.equal(allows("git status", root, { workingDirectory: "/etc" }), false, "unknown input fields fail closed");
});

test("Antigravity worktree Auto checks tool identity and the physical location of every file", {
  skip: process.platform !== "linux",
}, (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-antigravity-files-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "worktree");
  mkdirSync(root);
  writeFileSync(join(root, "inside"), "");
  const outside = join(dir, "outside");
  writeFileSync(outside, "");
  symlinkSync(outside, join(root, "alias"), "file");
  symlinkSync(join(dir, "missing"), join(root, "dangling"), "file");
  const allowsEdit = (path: string, extra = {}) => antigravityWorktreeAutoAllows(root, {
    name: "write_file", kind: "edit", rawInput: { path }, ...extra,
  });
  assert.equal(allowsEdit("inside"), true);
  assert.equal(allowsEdit("new"), true);
  assert.equal(allowsEdit("new/subdir/file"), true);
  assert.equal(antigravityWorktreeAutoAllows(root, {
    name: "view_file", kind: "read", rawInput: { TargetFile: join(root, "inside") },
  }), true);
  for (const path of [".git", outside, "../outside", "alias", "dangling", "dangling/new", "*"]) {
    assert.equal(allowsEdit(path), false, path);
  }
  assert.equal(allowsEdit("inside", { locations: [{ path: outside }] }), false);
  assert.equal(allowsEdit("inside", { rawInput: { path: "inside", TargetFile: outside } }), false);
  assert.equal(allowsEdit("inside", { rawInput: { path: "inside", destination: outside } }), false);
  assert.equal(allowsEdit("inside", { kind: "execute" }), false);
  assert.equal(allowsEdit("inside", { name: "unknown" }), false);
  assert.equal(allowsEdit("inside", { rawInput: undefined, title: "Edit inside" }), false);
  assert.equal(antigravityWorktreeAutoAllows(root, {
    name: "run_command", kind: "execute", rawInput: { CommandLine: "cat alias" },
  }), false);
});
