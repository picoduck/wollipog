import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_REFUSAL,
  PLACELESS_CWD,
  type ManagedWorktreeProtection,
} from "./managed-worktree-protection.js";

const protectedPath = "/runner/worktrees/session/requested/managed";
const protection: ManagedWorktreeProtection[] = [{
  worktreePath: protectedPath,
  repoPath: "/projects/repo",
}];

test("raw Git and filesystem retirement forms are refused with managed-discard guidance", () => {
  for (const command of [
    `git -C /projects/repo worktree remove ${protectedPath}`,
    `git worktree remove --force ${protectedPath}`,
    `git -c gc.auto=0 worktree remove ${protectedPath}`,
    `git --git-dir /projects/repo/.git worktree remove ${protectedPath}`,
    `git -C "$(git rev-parse --show-toplevel)" worktree remove ${protectedPath}`,
    `git worktree move ${protectedPath} /tmp/moved`,
    "git -C /projects/repo worktree prune",
    `rm -rf -- ${protectedPath}`,
    `rmdir ${protectedPath}`,
    `unlink ${protectedPath}`,
    `mv ${protectedPath} /tmp/away`,
    `sh -c 'rm -rf ${protectedPath}'`,
    `python -c "import shutil; shutil.rmtree('${protectedPath}')"`,
    "rm -rf .",
    "p=. ; rm -rf \"$p\"",
    "cd /runner/worktrees/session/requested && rm -rf managed",
    "cd ..",
    "pushd /runner/worktrees/session/requested",
    "rm -rf /runner/worktrees/session/requested/manage*",
    `rm -rf ./*.tmp ${protectedPath}`,
    "rm -rf /runner/worktrees/session/requested/{managed,other}",
    "rm -rf .git",
    "rm -rf /projects/repo/.git/worktrees",
    "rm -rf /projects/repo/.git/worktrees/*",
    "bash -lc 'rm -rf .'",
    "nohup rm -rf .",
    "setsid rm -rf .",
    "nice -n 5 rm -rf .",
    "timeout 30 rm -rf .",
    "eval 'rm -rf .'",
    "sudo -u root rm -rf .",
    "env -u PATH rm -rf .",
    "env -S 'rm -rf .'",
    "find -L . -delete",
    "find . -exec rm -rf {} +",
    `find ${protectedPath} -execdir rm -rf {} +`,
    `mv -t /tmp/destination scratch.ts ${protectedPath}`,
    `mv -t/tmp/destination scratch.ts ${protectedPath}`,
    `mv -ft/tmp/destination scratch.ts ${protectedPath}`,
    `mv --target-directory=/tmp/destination scratch.ts ${protectedPath}`,
    `mv --targ=/tmp/destination scratch.ts ${protectedPath}`,
    `mv scratch.ts ${protectedPath} /tmp/destination`,
    `move -Lit ${protectedPath} -Destination /tmp/moved`,
    `move -LiteralPath ${protectedPath} -Destination /tmp/moved`,
    "env -S'rm -rf .'",
    "env -iS'rm -rf .'",
    "env --split-str='rm -rf .'",
    "env --uns PATH rm -rf .",
    "env --chd /tmp rm -rf .",
    // GNU env -S separates arguments on \_, which shell-quote reads as quoting and joins instead,
    // and concatenates ${VAR} with its neighbours, which shell-quote keeps as a separate token.
    String.raw`env -S'rm\_-rf\_.'`,
    String.raw`env --split-string='rm\_-rf\_.'`,
    "X=m env -S'r${X} -rf .'",
    "env -S'${REMOVER} -rf .'",
    `env -S'rm -rf scratch x#foo ${protectedPath}'`,
    "printf '.\\0' | xargs -0 rm -rf",
    "printf '.\\0' | xargs -0 sudo -u root rm -rf",
    "rm -rf /runner/worktrees/session/requested/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{managed,other}",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection), MANAGED_WORKTREE_REFUSAL, command);
  }
});

test("normal work inside a managed worktree and unmanaged retirement remain available", () => {
  for (const command of [
    "git status --short",
    "git add -A && git commit -m change",
    "pnpm test",
    "touch new-file && rm -rf node_modules/.cache",
    "rm -rf ./*.tmp node_modules/*",
    "cd src",
    "git -C /projects/repo worktree remove /user/worktrees/unmanaged",
    "rm -rf /user/worktrees/unmanaged",
    "mv src/old.ts src/new.ts",
    "mv -t . ../scratch.ts",
    "mv -t. ../scratch.ts",
    "mv --target-directory=. ../scratch.ts",
    "mv -S.bak src/old.ts src/new.ts",
    "mv --suffix=.bak src/old.ts src/new.ts",
    // PowerShell's Move-Item aliases name their arguments, so -LiteralPath is not a GNU -t cluster.
    `move -Path ../scratch.ts -Destination ${protectedPath}`,
    `mv -LiteralPath ../scratch.ts -Destination ${protectedPath}`,
    "rename-item -Path src/old.ts -NewName new.ts",
    "env -S 'pnpm test'",
    "find . -type f -exec grep -l TODO {} +",
  ]) assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection), null, command);
  assert.equal(commandTargetsManagedWorktree("cd apps/web", "/projects/repo", protection), null,
    "a provider still outside its newly selected worktree may navigate in the original repository");
});

// Each level re-parses its own payload, so an unbounded chain would let a 32 KiB command drive
// quadratic parsing. The classifier expands a fixed number of levels and refuses past that.
const splitStringChain = (levels: number, payload: string) =>
  `env ${"--split-string=env ".repeat(levels - 1)}--split-string=${payload}`;

test("env split-string expansion is bounded and fails closed past its bound", () => {
  assert.equal(commandTargetsManagedWorktree(splitStringChain(8, "pnpm test"), protectedPath, protection), null,
    "a chain within the expansion bound is still classified on its merits");
  assert.equal(commandTargetsManagedWorktree(splitStringChain(9, "pnpm test"), protectedPath, protection),
    MANAGED_WORKTREE_REFUSAL, "a chain past the expansion bound retains the worktree rather than parsing on");

  // Expansion stops after a fixed number of levels rather than after however many the 32 KiB
  // command budget affords, so chains of any length stop at the same point.
  for (const levels of [10, 100, 1_500]) {
    assert.equal(commandTargetsManagedWorktree(splitStringChain(levels, "pnpm test"), protectedPath, protection),
      MANAGED_WORKTREE_REFUSAL, `a ${levels}-level chain expands no further than the bound`);
  }
});

test("all literal spellings of the protected root stay refused while descendants stay editable", () => {
  const safeSegment = fc.array(fc.constantFrom("a", "b", "src", "node_modules"), { minLength: 1, maxLength: 4 })
    .map((segments) => segments.join("/"));
  const remover = fc.constantFrom("rm -rf", "rm -r", "rmdir", "unlink", "trash-put");
  fc.assert(fc.property(remover, fc.constantFrom(protectedPath, `${protectedPath}/..//managed`, "."),
    (prefix, target) => {
      assert.equal(commandTargetsManagedWorktree(`${prefix} -- ${target}`, protectedPath, protection),
        MANAGED_WORKTREE_REFUSAL);
    }));
  fc.assert(fc.property(remover, safeSegment, (prefix, child) => {
    assert.equal(commandTargetsManagedWorktree(`${prefix} -- ${child}`, protectedPath, protection), null);
  }));
});

test("a relative removal is judged from where the shell actually is", () => {
  // From a subdirectory, `cd ..` stays inside the worktree; from the root it leaves it.
  assert.equal(commandTargetsManagedWorktree("cd ..", `${protectedPath}/apps/runner`, protection), null);
  assert.equal(commandTargetsManagedWorktree("cd ..", protectedPath, protection), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf ../..", `${protectedPath}/apps/runner`, protection), MANAGED_WORKTREE_REFUSAL);
});

test("operands are judged from the physical form of the directory as well as its spelling", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(join(worktree, "apps"), { recursive: true });
  mkdirSync(join(worktree, "deep", "target"), { recursive: true });
  mkdirSync(join(worktree, "x"));
  mkdirSync(join(base, "escape"));
  symlinkSync(base, join(worktree, "link"));
  symlinkSync(join("deep", "target"), join(worktree, "inner"));
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  // An external operand from a symlinked directory resolves through the kernel.
  assert.equal(commandTargetsManagedWorktree("rm -rf ../managed", join(worktree, "link", "escape"), protections),
    MANAGED_WORKTREE_REFUSAL, "physically ../managed IS the worktree");
  assert.equal(commandTargetsManagedWorktree("rm -rf managed", join(worktree, "link"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("cd inner && cd .. && rm -rf .", worktree, protections),
    MANAGED_WORKTREE_REFUSAL, "the shell's own cd chain is logical and reaches the root");
  assert.equal(commandTargetsManagedWorktree("cd link/escape", worktree, protections),
    MANAGED_WORKTREE_REFUSAL, "a cd whose physical target leaves the worktree is an escape");
  // From a physical directory two levels down, both spellings of the way back up are judged.
  assert.equal(commandTargetsManagedWorktree("rm -rf ../../managed", join(worktree, "x"), protections),
    MANAGED_WORKTREE_REFUSAL, "../../managed from managed/x is the worktree itself");
  assert.equal(commandTargetsManagedWorktree("rm -rf ../../managed", join(worktree, "deep", "target"), protections), null,
    "from managed/deep/target it is managed/managed, an ordinary descendant");
  assert.equal(
    commandTargetsManagedWorktree(`git --git-dir=${join(base, "repo", ".git")} -C ../.. worktree remove --force managed`,
      join(worktree, "x"), protections),
    MANAGED_WORKTREE_REFUSAL,
  );
  // Through the symlink `inner` the shell is physically in deep/target, whatever it prints.
  assert.equal(commandTargetsManagedWorktree("rm -rf ../../../managed", join(worktree, "inner"), protections),
    MANAGED_WORKTREE_REFUSAL, "physically three levels up from deep/target is the worktree's parent");
  assert.equal(commandTargetsManagedWorktree("rm -rf build", join(worktree, "apps"), protections), null);
  assert.equal(commandTargetsManagedWorktree("rm -rf target", join(worktree, "inner"), protections), null);
});

test("a worktree reached through a symlinked prefix is not refused against itself", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "real", "managed", "apps"), { recursive: true });
  symlinkSync(join(base, "real"), join(base, "alias"));
  const worktree = join(base, "alias", "managed");
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  assert.equal(commandTargetsManagedWorktree("cd ..", join(worktree, "apps"), protections), null);
  assert.equal(commandTargetsManagedWorktree("rm -rf build", join(worktree, "apps"), protections), null);
  assert.equal(commandTargetsManagedWorktree("git worktree prune", join(worktree, "apps"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf ../..", join(worktree, "apps"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${join(base, "real", "managed")}`, join(worktree, "apps"), protections),
    MANAGED_WORKTREE_REFUSAL, "the physical spelling of the worktree is the worktree");
});

test("removing a symlink that merely points at the worktree is not removing the worktree", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(worktree);
  mkdirSync(join(base, "sibling"));
  symlinkSync(worktree, join(base, "sibling", "alias"));
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  const sibling = join(base, "sibling");
  // rm, unlink, and an mv source act on the link itself.
  assert.equal(commandTargetsManagedWorktree("rm alias", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree("unlink alias", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree("mv alias renamed", sibling, protections), null);
  // A trailing slash makes the kernel follow it, and git resolves the path it is given.
  assert.equal(commandTargetsManagedWorktree("rm -rf alias/", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf alias/.", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("git worktree remove alias", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  // An INTERMEDIATE symlink is always followed: alias/.. is the worktree's parent.
  assert.equal(commandTargetsManagedWorktree("rm -rf alias/../managed", sibling, protections), MANAGED_WORKTREE_REFUSAL);
});

test("an operand too deep to walk is refused, never collapsed textually", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(worktree);
  mkdirSync(join(base, "sibling", "d"), { recursive: true });
  symlinkSync(worktree, join(base, "sibling", "alias"));
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  const deep = `${"d/../".repeat(127)}alias/../managed`;
  assert.equal(deep.split("/").length, 257);
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${deep}`, join(base, "sibling"), protections),
    MANAGED_WORKTREE_REFUSAL);
  // The same shape within the bound is walked, and still reaches the worktree.
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${"d/../".repeat(20)}alias/../managed`, join(base, "sibling"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${"d/../".repeat(20)}scratch`, join(base, "sibling"), protections), null);
});

test("on POSIX a backslash is a filename character, not a separator", { skip: process.platform === "win32" }, (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(worktree);
  mkdirSync(join(base, "sibling"));
  symlinkSync(worktree, join(base, "sibling", "\\alias"));
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  assert.equal(commandTargetsManagedWorktree("rm -rf '\\alias/../managed'", join(base, "sibling"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf '\\alias/../scratch'", join(base, "sibling"), protections), null);
});


test("from the placeless directory only refusals that hold wherever the shell is survive", () => {
  // Relative operands and relative directory changes cannot be placed, so they are not refused...
  for (const command of ["cd ..", "cd .. && pnpm typecheck", "rm -rf .", "rm -rf ../..", "rm -rf build",
    "git worktree prune", `cd ${"../".repeat(40)}`]) {
    assert.equal(commandTargetsManagedWorktree(command, PLACELESS_CWD, protection), null, command);
  }
  // ...while anything that names the worktree, or moves into it before acting, still is.
  for (const command of [`rm -rf ${protectedPath}`, `git worktree remove ${protectedPath}`,
    `cd ${protectedPath} && rm -rf .`, `cd ${protectedPath}/apps && rm -rf ..`, `cd ${protectedPath} && cd ..`,
    `git -C ${protectedPath} worktree prune`, `rm -rf ${"../".repeat(80)}`]) {
    assert.equal(commandTargetsManagedWorktree(command, PLACELESS_CWD, protection), MANAGED_WORKTREE_REFUSAL, command);
  }
});

test("the filesystem root is an ancestor of the worktree like any other", () => {
  assert.equal(commandTargetsManagedWorktree("rm -rf /", protectedPath, protection), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${"../".repeat(40)}`, protectedPath, protection), MANAGED_WORKTREE_REFUSAL);
});
