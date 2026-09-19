import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_REFUSAL,
  MANAGED_WORKTREE_UNRESOLVED_REFUSAL,
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
  // The guard hook is handed the PHYSICAL directory. The shell is still inside the worktree, so
  // leaving it is still an escape, and moving around inside it still is not.
  const physical = join(base, "real", "managed");
  assert.equal(commandTargetsManagedWorktree("cd ..", physical, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("cd .. && ln -s . jump && rm -rf 'jump/m*'", physical, protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("cd apps && cd ..", physical, protections), null);
  assert.equal(commandTargetsManagedWorktree("cd ..", join(physical, "apps"), protections), null);
  assert.equal(commandTargetsManagedWorktree(`cd ${join(worktree, "apps")}`, physical, protections), null,
    "the aliased spelling of a directory inside the worktree is inside it");
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
  // find defaults to -P and unlinks a symlinked search root itself; -H and -L follow it.
  assert.equal(commandTargetsManagedWorktree("find alias -delete", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree("find -P alias -delete", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree("find -L alias -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find -H alias -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find alias/ -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find alias -follow -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  // Every pre-root option is stepped over, so the real roots and a later -L are examined.
  assert.equal(commandTargetsManagedWorktree("find -P -D search -L alias -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find -L -- alias -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find -O2 -L alias -delete", sibling, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("find -D search alias -delete", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree("find -- alias -delete", sibling, protections), null);
  assert.equal(commandTargetsManagedWorktree(`find -D search -L ${sibling} -delete`, sibling, protections), null,
    "a followed root that is not the worktree");
  assert.equal(commandTargetsManagedWorktree("find alias -name x -follow -exec rm -rf {} +", sibling, protections),
    MANAGED_WORKTREE_REFUSAL);
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

/* ---------------------------------------------------------------------------------------------
 * The removal contract inside a managed worktree (#1393).
 *
 * #1393 was filed on the premise that the guard refuses every removal inside a runner-owned
 * worktree, leaving an agent unable to delete a scratch file it had just created. It does not, and
 * never did: `protectedTarget` matches the worktree ROOT and its ancestors, anything inside either
 * Git administrative tree, and any ancestor of those trees. A path beneath the root and OUTSIDE
 * those trees — which `<worktree>/.git` is not — has always been an ordinary mutation, exactly what
 * #1209 asked for ("Normal file creation, editing, Git commits, tests, and other expected work
 * inside the selected worktree remain available").
 *
 * The tests below pin that contract in both directions so neither half can drift: an agent's own
 * cleanup keeps working, and the root and administrative state stay unreachable.
 * ------------------------------------------------------------------------------------------ */

test("an agent may remove scratch it created inside its managed worktree", () => {
  for (const [command, cwd] of [
    // The issue's own examples: a one-off harness, a capture script, a temporary fixture.
    ["rm -f scratch.txt", protectedPath],
    ["rm -rf tmp-harness", protectedPath],
    ["rm -rf tmp-harness/", protectedPath],
    ["rmdir tmp-harness", protectedPath],
    ["unlink scratch.txt", protectedPath],
    ["trash-put scratch.txt", protectedPath],
    ["gio trash scratch.txt", protectedPath],
    // The same file named absolutely is the same file; spelling it out is not an escalation.
    [`rm -f ${protectedPath}/scratch.txt`, protectedPath],
    [`rm -rf ${protectedPath}/tmp-harness`, protectedPath],
    // ...and from a subdirectory, including a `..` that stays inside the worktree.
    ["rm -f scratch.txt", `${protectedPath}/apps`],
    ["rm -rf ../tmp-harness", `${protectedPath}/apps`],
    // Cleaning up before retirement, which `discard_worktree` requires to leave a clean tree.
    ["git clean -fd", protectedPath],
  ] as const) {
    assert.equal(commandTargetsManagedWorktree(command, cwd, protection), null, command);
  }
});

test("piping filenames into a remover is refused even when they are all scratch", () => {
  // The allowance above stops at the pipe. What reaches `xargs` on stdin is decided at runtime and
  // is INVISIBLE here, so the classifier cannot tell a list of scratch files from one naming the
  // root, and refuses every remover run through `xargs` from inside a managed worktree. That is a
  // deliberate over-refusal standing in for a judgement it cannot make — not root matching.
  assert.equal(commandTargetsManagedWorktree("printf 'scratch.txt\\0' | xargs -0 rm -f", protectedPath, protection),
    MANAGED_WORKTREE_REFUSAL);
  // Both halves of the fallback's condition, isolated: it needs a managed cwd AND a remover.
  assert.equal(commandTargetsManagedWorktree("printf 'scratch.txt\\0' | xargs -0 rm -f", "/elsewhere", protection),
    null, "outside a managed worktree the fallback does not apply");
  assert.equal(commandTargetsManagedWorktree("printf 'scratch.txt\\0' | xargs -0 cat", protectedPath, protection),
    null, "the fallback is scoped to removers, not to pipelines in general");
  assert.equal(commandTargetsManagedWorktree("rm -f scratch.txt", protectedPath, protection), null,
    "and naming the same operand directly stays allowed");
  // The cost of that blindness, stated rather than implied: piping the root itself is NOT caught
  // by root matching. From outside a managed worktree nothing refuses it, because the operand only
  // ever exists at runtime. Only a root named in the command text is an operand the guard can see.
  assert.equal(commandTargetsManagedWorktree(`printf '${protectedPath}\\0' | xargs -0 rm -rf`, "/elsewhere", protection),
    null, "stdin is opaque, so a piped root is not matched as an operand");
  assert.equal(commandTargetsManagedWorktree(`xargs -0 rm -rf ${protectedPath}`, "/elsewhere", protection),
    MANAGED_WORKTREE_REFUSAL, "while a root named in the command IS matched, wherever the shell is");
});

test("removal of the worktree root and its Git administrative state stays refused", () => {
  for (const [command, cwd] of [
    // The root itself, by every spelling.
    ["rm -rf .", protectedPath],
    [`rm -rf ${protectedPath}`, protectedPath],
    [`rm -rf ${protectedPath}/`, protectedPath],
    [`rm -rf ${protectedPath}/tmp-harness/..`, protectedPath],
    // An ancestor of the root takes the root with it.
    ["rm -rf ..", `${protectedPath}/apps`],
    [`rm -rf ${protectedPath}/tmp-harness/../..`, protectedPath],
    // The worktree's own `.git` link file, which Git needs to find the real admin directory. It
    // sits BENEATH the root, so "beneath the root is allowed" holds only outside the admin trees.
    ["rm -rf .git", protectedPath],
    [`rm -rf ${protectedPath}/.git`, protectedPath],
    [`rm -rf ${protectedPath}/.git/config`, protectedPath],
    // The repository's registry entry for it, anything inside that entry, and any ancestor of it.
    ["rm -rf /projects/repo/.git/worktrees", protectedPath],
    ["rm -rf /projects/repo/.git/worktrees/managed", protectedPath],
    ["rm -rf /projects/repo/.git", protectedPath],
    ["rm -rf /projects/repo", protectedPath],
    // Bulk removal forms whose ROOT is the worktree, which `-delete`/`-exec` would walk.
    ["find . -delete", protectedPath],
    ["find . -name '*.tmp' -delete", protectedPath],
    ["find . -maxdepth 1 -name '*.tmp' -exec rm -f {} +", protectedPath],
    // `xargs` appends its stdin to the command it is given, so a root named in the command itself
    // IS an operand the classifier can see. What arrives on stdin is not; that is the next test.
    [`xargs -0 rm -rf ${protectedPath}`, protectedPath],
    // Moving the root away retires it just as surely as deleting it.
    ["mv . /tmp/moved", protectedPath],
  ] as const) {
    assert.equal(commandTargetsManagedWorktree(command, cwd, protection), MANAGED_WORKTREE_REFUSAL, command);
  }
});

test("a sibling whose name merely extends the worktree's is not the worktree", () => {
  // `pathContains` compares separator-terminated prefixes, so a neighbouring path that begins with
  // the same characters is a different directory and remains the operator's to remove.
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${protectedPath}-backup`, protectedPath, protection), null);
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${protectedPath}.old`, protectedPath, protection), null);
});

test("the guard classifies by path, not by Git status", () => {
  // #1393's third criterion allows either refusing untracked files the agent did not create, or
  // documenting a decision to allow them. This is that decision, made explicit: the guard consults
  // no Git index, so a tracked file, an ignored build artifact, and another session's stray scratch
  // are all ordinary contents of the worktree and are treated identically. Git itself is the
  // recovery path for anything tracked; the runner-owned boundary is the root, not the file.
  for (const command of [
    "rm -f apps/runner/src/managed-worktree-protection.ts", // tracked
    "rm -rf dist", // ignored build output
    "rm -f someone-elses-scratch.txt", // untracked, not created by this session
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection), null, command);
  }
});

test("a symlink inside the worktree cannot be used to reach the root", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-1393-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(join(worktree, "tmp-harness"), { recursive: true });
  // Exactly the alias an agent could create while tidying up inside its own worktree.
  symlinkSync(worktree, join(worktree, "self"));
  const protections: ManagedWorktreeProtection[] = [{ worktreePath: worktree, repoPath: join(base, "repo") }];

  // Removing the alias removes the link itself, which is scratch like any other.
  assert.equal(commandTargetsManagedWorktree("rm -f self", worktree, protections), null);
  // A trailing slash (or `/.`) makes the kernel follow it, and then it IS the root.
  assert.equal(commandTargetsManagedWorktree("rm -rf self/", worktree, protections), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf self/.", worktree, protections), MANAGED_WORKTREE_REFUSAL);
  // Climbing through the alias lands where it points, not where the spelling suggests.
  assert.equal(commandTargetsManagedWorktree("rm -rf self/tmp-harness/..", worktree, protections),
    MANAGED_WORKTREE_REFUSAL);
  // Scratch reached THROUGH the alias is still scratch.
  assert.equal(commandTargetsManagedWorktree("rm -rf self/tmp-harness", worktree, protections), null);
});

/* ---------------------------------------------------------------------------------------------
 * The environment an operand resolves in, and what happens when it resolves nowhere (#1324).
 *
 * The runner exports the protected worktree's own path into the environment it launches the
 * provider with, so `rm -rf "$WOLLIPOG_WORKTREE_PATH"` was the shortest spelling of the exact
 * attack this classifier exists to prevent — and it was allowed, because a variable that is not
 * assigned inside the command resolved to nothing and the operand was then simply dropped.
 *
 * Both halves are pinned below: a reference that DOES resolve is the path it names, and a
 * destructive operand that does not resolve is refused with its own message rather than waved
 * through. Reads and ordinary commands keep their unresolved variables.
 * ------------------------------------------------------------------------------------------ */

/** The worktree setup keys the runner really exports, plus the ordinary ones a shell carries. */
const providerEnvironment = {
  WOLLIPOG_WORKTREE_PATH: protectedPath,
  WOLLIPOG_PRIMARY_CHECKOUT: "/projects/repo",
  WOLLIPOG_WORKTREE_BRANCH: "fix/issue-1324",
  HOME: "/home/agent",
  TMPDIR: "/tmp",
  OLDPWD: protectedPath,
};

test("a protected root held in the provider's environment is the protected root", () => {
  for (const command of [
    // The issue's own reproduction, in both spellings and unquoted.
    'rm -rf "$WOLLIPOG_WORKTREE_PATH"',
    "rm -rf ${WOLLIPOG_WORKTREE_PATH}",
    "rm -rf $WOLLIPOG_WORKTREE_PATH",
    // A reference concatenated with literal text stays ONE word, so the admin trees and the
    // climbing forms are reached through it exactly as they are through a literal path.
    'rm -rf "$WOLLIPOG_WORKTREE_PATH/"',
    'rm -rf "$WOLLIPOG_WORKTREE_PATH/.git"',
    'rm -rf "$WOLLIPOG_WORKTREE_PATH/apps/.."',
    'rm -rf "$WOLLIPOG_PRIMARY_CHECKOUT/.git/worktrees"',
    // Every other destructive branch, not only `rm`.
    'rmdir "$WOLLIPOG_WORKTREE_PATH"',
    'unlink "$WOLLIPOG_WORKTREE_PATH/"',
    'trash-put "$WOLLIPOG_WORKTREE_PATH/"',
    'gio trash "$WOLLIPOG_WORKTREE_PATH/"',
    'mv "$WOLLIPOG_WORKTREE_PATH" /tmp/away',
    'mv -t /tmp/destination scratch.ts "$WOLLIPOG_WORKTREE_PATH"',
    'git worktree remove "$WOLLIPOG_WORKTREE_PATH"',
    'git worktree move "$WOLLIPOG_WORKTREE_PATH" /tmp/moved',
    'git -C "$WOLLIPOG_PRIMARY_CHECKOUT" worktree prune',
    'find "$WOLLIPOG_WORKTREE_PATH" -delete',
    'find "$WOLLIPOG_WORKTREE_PATH" -name "*.tmp" -exec rm -rf {} +',
    // The reference survives a nested shell, an interpreter, and a `cd` into what it names.
    'sh -c "rm -rf $WOLLIPOG_WORKTREE_PATH"',
    "sh -c 'rm -rf $WOLLIPOG_WORKTREE_PATH'",
    'python -c "import shutil; shutil.rmtree(\'$WOLLIPOG_WORKTREE_PATH\')"',
    'cd "$WOLLIPOG_WORKTREE_PATH" && rm -rf .',
    // An assignment made from a reference carries the value with it.
    'root="$WOLLIPOG_WORKTREE_PATH" && rm -rf "$root"',
    // An unquoted reference is split into words by the shell, and a field of it is an operand.
    "rm -rf $TWO_FIELDS",
  ]) {
    assert.equal(
      commandTargetsManagedWorktree(command, "/elsewhere", protection,
        { ...providerEnvironment, TWO_FIELDS: `/tmp/scratch ${protectedPath}` }),
      MANAGED_WORKTREE_REFUSAL, command);
  }
  // `PWD` is answered from the tracked working directory rather than from the launch environment,
  // which is stale the moment the shell moves.
  assert.equal(commandTargetsManagedWorktree('rm -rf "$PWD"', protectedPath, protection, providerEnvironment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('rm -rf "$PWD"', "/elsewhere", protection, providerEnvironment),
    null, "and from outside the worktree the same command is an ordinary removal");
});

test("a reference that resolves beneath the root is ordinary work, not a retirement", () => {
  for (const command of [
    'rm -rf "$WOLLIPOG_WORKTREE_PATH/node_modules/.cache"',
    'rm -rf "$WOLLIPOG_WORKTREE_PATH/dist"',
    'rm -f "$WOLLIPOG_WORKTREE_PATH/scratch.txt"',
    'rm -rf "$TMPDIR/scratch"',
    'mv "$WOLLIPOG_WORKTREE_PATH/src/old.ts" "$WOLLIPOG_WORKTREE_PATH/src/new.ts"',
    'git -C "$WOLLIPOG_WORKTREE_PATH" status --short',
    'cat "$WOLLIPOG_WORKTREE_PATH/package.json"',
    'echo "$WOLLIPOG_WORKTREE_PATH"',
    // The existing allowances are unchanged by resolution.
    "rm -rf node_modules/.cache",
    "rm -rf ./*.tmp",
    "rm -rf tmp-harness",
    "pnpm test",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection, providerEnvironment),
      null, command);
  }
});

test("a destructive operand that resolves nowhere is refused on its own terms", () => {
  for (const command of [
    // A variable neither the environment nor the command defines. It may be unset, or set by
    // something this process cannot see; either way the shell knows where it points and this
    // classifier does not.
    'rm -rf "$SCRATCH_DIR"',
    "rm -rf ${SCRATCH_DIR}",
    'rm -rf "$SCRATCH_DIR/build"',
    'rm -rf "${SCRATCH_DIR:-/tmp/fallback}"',
    // A command substitution and a backtick are the same blindness by another spelling.
    'rm -rf "$(pwd)"',
    "rm -rf $(git rev-parse --show-toplevel)",
    "rm -rf `pwd`",
    // The one-command scratch idiom is refused too: the path exists only at runtime. Splitting it
    // across two calls, where the second names the directory literally, still works.
    'T=$(mktemp -d) && rm -rf "$T"',
    // Every other destructive branch fails closed the same way.
    'rmdir "$SCRATCH_DIR"',
    'trash-put "$SCRATCH_DIR"',
    'gio trash "$SCRATCH_DIR"',
    'mv "$SCRATCH_DIR" /tmp/away',
    'git worktree remove "$SCRATCH_DIR"',
    'git -C "$(pwd)" worktree prune',
    'find "$SCRATCH_DIR" -delete',
    'find "$SCRATCH_DIR" -name "*.tmp" -exec rm -rf {} +',
    // Through a nested shell, where the nested parse inherits the same environment.
    "sh -c 'rm -rf $SCRATCH_DIR'",
    "eval 'rm -rf $SCRATCH_DIR'",
    // A variable the shell rewrites as it runs is stale in the launch environment, so it never
    // resolves even though a value for it was passed in.
    'rm -rf "$OLDPWD"',
    // A relative operand after a directory change this code could not follow is unplaceable.
    'cd "$(git rev-parse --show-toplevel)/.." && rm -rf managed',
    "cd $SCRATCH_DIR && rm -rf build",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, "/elsewhere", protection, providerEnvironment),
      MANAGED_WORKTREE_UNRESOLVED_REFUSAL, command);
  }
});

test("an unresolved operand outside a destructive position is left alone", () => {
  for (const command of [
    // Reads and ordinary work reference variables constantly; none of them retires a worktree.
    'cat "$SCRATCH_DIR/notes.txt"',
    'ls "$SCRATCH_DIR"',
    'grep -r TODO "$SCRATCH_DIR"',
    'mkdir -p "$SCRATCH_DIR"',
    'echo "$(pwd)"',
    "git log --oneline -1 $REF",
    'find "$SCRATCH_DIR" -name "*.ts"',
    'find "$SCRATCH_DIR" -type f -exec grep -l TODO {} +',
    // A `cd` that cannot be followed is not itself refused; only a later destructive operand is.
    'cd "$(git rev-parse --show-toplevel)"',
    'cd "$SCRATCH_DIR" && pnpm test',
    // The destination of a move receives the files; it is the sources that are retired.
    'mv src/old.ts "$DESTINATION"',
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection, providerEnvironment),
      null, command);
  }
});

test("a protected target outranks an unresolved one in the same command", () => {
  // Both messages are actionable, but only one of them names the lifecycle the agent must use.
  assert.equal(
    commandTargetsManagedWorktree(`rm -rf "$SCRATCH_DIR" && rm -rf ${protectedPath}`, "/elsewhere", protection,
      providerEnvironment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(
    commandTargetsManagedWorktree('rm -rf "$SCRATCH_DIR" "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection,
      providerEnvironment),
    MANAGED_WORKTREE_REFUSAL);
  // With no environment supplied at all, nothing resolves and every reference fails closed.
  assert.equal(commandTargetsManagedWorktree('rm -rf "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection),
    MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  // An unprotected session is not policed at all, resolvable or not.
  assert.equal(commandTargetsManagedWorktree('rm -rf "$SCRATCH_DIR"', "/elsewhere", [], providerEnvironment), null);
});
