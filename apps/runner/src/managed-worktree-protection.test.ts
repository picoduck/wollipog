import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { initRepo } from "./git-test-repo.js";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL,
  MANAGED_WORKTREE_ESCAPE_REFUSAL,
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
  // Leaving the worktree is refused first, with its own message: the escape is what stops these.
  for (const command of [
    "cd /runner/worktrees/session/requested && rm -rf managed",
    "cd ..",
    "pushd /runner/worktrees/session/requested",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection), MANAGED_WORKTREE_ESCAPE_REFUSAL,
      command);
  }
});

test("direct writes to linked-worktree registration files are refused before redirection can run", () => {
  for (const command of [
    "printf corrupt > /projects/repo/.git/worktrees/managed/gitdir",
    "printf corrupt >> /projects/repo/.git/worktrees/managed/commondir",
    "printf corrupt > /projects/repo/.git/worktrees/managed/config.worktree",
    "printf corrupt > /tmp/new && mv /tmp/new /projects/repo/.git/worktrees/managed/commondir",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, protectedPath, protection), MANAGED_WORKTREE_REFUSAL, command);
  }
  assert.equal(commandTargetsManagedWorktree(
    "printf harmless > /projects/repo/.git/worktrees-backup/note", protectedPath, protection,
  ), null, "a sibling path that merely extends the registry name remains unrelated");
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
  assert.equal(commandTargetsManagedWorktree("cd ..", protectedPath, protection), MANAGED_WORKTREE_ESCAPE_REFUSAL);
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
    MANAGED_WORKTREE_ESCAPE_REFUSAL, "a cd whose physical target leaves the worktree is an escape");
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
  assert.equal(commandTargetsManagedWorktree("cd ..", physical, protections), MANAGED_WORKTREE_ESCAPE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("cd .. && ln -s . jump && rm -rf 'jump/m*'", physical, protections),
    MANAGED_WORKTREE_ESCAPE_REFUSAL);
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
    `cd ${protectedPath} && rm -rf .`, `cd ${protectedPath}/apps && rm -rf ..`,
    `git -C ${protectedPath} worktree prune`, `rm -rf ${"../".repeat(80)}`]) {
    assert.equal(commandTargetsManagedWorktree(command, PLACELESS_CWD, protection), MANAGED_WORKTREE_REFUSAL, command);
  }
  assert.equal(commandTargetsManagedWorktree(`cd ${protectedPath} && cd ..`, PLACELESS_CWD, protection),
    MANAGED_WORKTREE_ESCAPE_REFUSAL);
});

test("leaving a managed worktree is refused as an escape, never blamed on the worktree (#1632)", () => {
  // The evidence upload refused while delivering #1696, from inside the worktree it ran in. It named
  // nothing in the worktree; only the `cd` leaving it stopped it, and the refusal now says so.
  const upload = readFileSync(new URL("./fixtures/guard-refusals-1632/evidence-upload.txt", import.meta.url), "utf8");
  assert.equal(commandTargetsManagedWorktree(upload, protectedPath, protection), MANAGED_WORKTREE_ESCAPE_REFUSAL);
  // The same work, naming its files instead of changing directory, is not refused at all.
  assert.equal(commandTargetsManagedWorktree(
    "node ~/.claude/skills/issue-workflow/scripts/evidence.mjs put --prefix pr-1701 /tmp/wp-1696-evidence/a.png; " +
      "sha256sum /tmp/wp-1696-evidence/*.png", protectedPath, protection), null);
  // The escape message is only for the escape: a removal of the worktree keeps the worktree refusal.
  assert.equal(commandTargetsManagedWorktree(`rm -rf ${protectedPath} && cd /tmp`, "/tmp", protection),
    MANAGED_WORKTREE_REFUSAL);
  assert.notEqual(MANAGED_WORKTREE_ESCAPE_REFUSAL, MANAGED_WORKTREE_REFUSAL);
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

test("a leading tilde is resolved from the provider's home before judging a destructive operand", () => {
  const providerHome = "/provider/home";
  const homeWorktree = `${providerHome}/worktrees/managed`;
  const homeProtection = [{ worktreePath: homeWorktree, repoPath: "/projects/repo" }];
  const environment = { ...providerEnvironment, HOME: providerHome };

  for (const command of [
    "rm -rf ~",
    "rmdir ~/worktrees/managed",
    "unlink ~/worktrees/managed",
    "trash-put ~/worktrees/managed",
    "gio trash ~/worktrees/managed",
    "mv ~/worktrees/managed /tmp/away",
    "git worktree remove ~/worktrees/managed",
    "git worktree move ~/worktrees/managed /tmp/moved",
    "find ~/worktrees/managed -delete",
    "find ~/worktrees/managed -name '*.tmp' -exec rm -rf {} +",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, "/elsewhere", homeProtection, environment),
      MANAGED_WORKTREE_REFUSAL, command);
  }

  for (const command of [
    "rm -rf ~/scratch",
    "mv ~/scratch /tmp/away",
    "git worktree remove ~/scratch",
    "find ~/scratch -delete",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, "/elsewhere", homeProtection, environment), null, command);
  }

  assert.equal(commandTargetsManagedWorktree("rm -rf ~+/worktrees/managed", providerHome,
    homeProtection, environment), MANAGED_WORKTREE_REFUSAL, "~+ expands from the shell's current directory");
  assert.equal(commandTargetsManagedWorktree('rm -rf "$TILDE"', "/elsewhere", homeProtection,
    { ...environment, TILDE: "~" }), null, "a tilde produced by parameter expansion stays literal");
  assert.equal(commandTargetsManagedWorktree("rm -rf $TWO_FIELDS", "/elsewhere", homeProtection,
    { ...environment, TWO_FIELDS: "~ /tmp/scratch" }), null,
    "a tilde produced by a split parameter expansion stays literal");
  assert.equal(commandTargetsManagedWorktree("rm -rf ~/$HOME_RELATIVE", "/elsewhere", homeProtection,
    { ...environment, HOME_RELATIVE: "worktrees/managed" }), MANAGED_WORKTREE_REFUSAL,
    "a syntactic tilde still expands when the rest of its word comes from a parameter");
  assert.equal(commandTargetsManagedWorktree("rm -rf ~", "/provider",
    [{ worktreePath: homeWorktree, repoPath: "/projects/repo" }], { HOME: "home" }),
    MANAGED_WORKTREE_REFUSAL, "a relative provider HOME is resolved from the provider's cwd");

  // shell-quote does not retain whether the tilde was quoted, so the classifier deliberately
  // over-refuses this literal spelling even though a real shell would leave the `~` unexpanded.
  assert.equal(commandTargetsManagedWorktree('rm -rf "~"', "/elsewhere", homeProtection, environment),
    MANAGED_WORKTREE_REFUSAL);

  const runnerHomeWorktree = join(homedir(), "worktrees", "managed");
  assert.equal(commandTargetsManagedWorktree("rm -rf ~", "/elsewhere",
    [{ worktreePath: runnerHomeWorktree, repoPath: "/projects/repo" }]), MANAGED_WORKTREE_REFUSAL,
    "the runner home is the fallback when the provider environment has no HOME");
});

test("tilde and absolute provider-home spellings have the same destructive verdict", () => {
  const providerHome = "/provider/home";
  const homeProtection = [{
    worktreePath: `${providerHome}/worktrees/managed`,
    repoPath: "/projects/repo",
  }];
  const relativePath = fc.oneof(
    fc.constantFrom("", "worktrees/managed", "worktrees/managed/.git", "scratch"),
    fc.array(fc.constantFrom("worktrees", "managed", "scratch", "src", ".", ".."),
      { minLength: 1, maxLength: 5 }).map((segments) => segments.join("/")),
  );
  const command = fc.constantFrom<(target: string) => string>(
    (target) => `rm -rf -- ${target}`,
    (target) => `rmdir ${target}`,
    (target) => `mv ${target} /tmp/away`,
    (target) => `git worktree remove ${target}`,
    (target) => `git worktree move ${target} /tmp/moved`,
    (target) => `find ${target} -delete`,
  );

  fc.assert(fc.property(relativePath, command, (relative, render) => {
    const tilde = relative ? `~/${relative}` : "~";
    const absolute = relative ? `${providerHome}/${relative}` : providerHome;
    assert.equal(
      commandTargetsManagedWorktree(render(tilde), "/elsewhere", homeProtection, { HOME: providerHome }),
      commandTargetsManagedWorktree(render(absolute), "/elsewhere", homeProtection, { HOME: providerHome }),
    );
  }));
});

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

test("the shell's own expansion order and field splitting are what is judged", () => {
  const environment = { ...providerEnvironment, TARGET: `/tmp/scratch:${protectedPath}`, CMD: "rm -rf" };
  // A prefix assignment does not reach the words of its own command: the shell expands them first,
  // so `$W` here is the value from the environment, and the assignment dies with the command.
  assert.equal(
    commandTargetsManagedWorktree('W=/tmp rm -rf "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection, environment),
    MANAGED_WORKTREE_REFUSAL, "the pre-assignment value is the one that is removed");
  assert.equal(
    commandTargetsManagedWorktree('WOLLIPOG_WORKTREE_PATH=/tmp rm -rf "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere",
      protection, environment),
    MANAGED_WORKTREE_REFUSAL, "and a prefix cannot shadow the protected value for its own command");
  // A standalone assignment IS in effect for the commands after it.
  assert.equal(commandTargetsManagedWorktree('safe=/tmp/x; rm -rf "$safe"', "/elsewhere", protection, environment),
    null);
  assert.equal(commandTargetsManagedWorktree('W2=$WOLLIPOG_WORKTREE_PATH; rm -rf "$W2"', "/elsewhere", protection,
    environment), MANAGED_WORKTREE_REFUSAL);
  // `IFS` decides where an unquoted expansion splits, so a protected root can be one field of a
  // value that contains no whitespace at all.
  assert.equal(commandTargetsManagedWorktree("IFS=:; rm -rf $TARGET", "/elsewhere", protection, environment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf $TARGET", "/elsewhere", protection,
    { ...environment, IFS: ":" }), MANAGED_WORKTREE_REFUSAL, "including an IFS inherited from the environment");
  assert.equal(commandTargetsManagedWorktree("rm -rf $TWO_WORDS", "/elsewhere", protection,
    { ...environment, TWO_WORDS: `/tmp/scratch ${protectedPath}` }), MANAGED_WORKTREE_REFUSAL);
  // An unquoted COMMAND word is field-split the same way, so the remover is found and its operand
  // is judged rather than the whole value being mistaken for one executable name.
  assert.equal(commandTargetsManagedWorktree('$CMD "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection, environment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('$CMD "$WOLLIPOG_WORKTREE_PATH/dist"', "/elsewhere", protection,
    environment), null, "while the same split command against scratch stays allowed");
});

test("an option word is not a path when the working directory is unknown", () => {
  // After a `cd` that cannot be followed, an operand that needs that directory is unresolved and
  // one that does not is judged on its own: the refusal must follow the operand, not the flags.
  const after = 'cd "$(git rev-parse --show-toplevel)" && ';
  assert.equal(commandTargetsManagedWorktree(`${after}rm -rf build`, protectedPath, protection, providerEnvironment),
    MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`${after}rm -rf /tmp/scratch`, protectedPath, protection,
    providerEnvironment), null);
  assert.equal(commandTargetsManagedWorktree(`${after}rm -rf ${protectedPath}`, protectedPath, protection,
    providerEnvironment), MANAGED_WORKTREE_REFUSAL, "and an absolute protected operand is still refused");
});

test("an assignment reaches the command it introduces, in shell order", () => {
  // A prefix assignment is not in scope for its own command's words, but it IS in the environment
  // of the command that runs: a nested shell expands `$W` from it, and the root is removed.
  const stale = { ...providerEnvironment, W: "/tmp" };
  assert.equal(commandTargetsManagedWorktree(`W=${protectedPath} sh -c 'rm -rf "$W"'`, "/elsewhere", protection,
    stale), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`env W=${protectedPath} sh -c 'rm -rf "$W"'`, "/elsewhere", protection,
    stale), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`W=${protectedPath} eval 'rm -rf "$W"'`, "/elsewhere", protection,
    stale), MANAGED_WORKTREE_REFUSAL);
  // ...and it does not outlive that command, so the next one sees the environment's own value.
  assert.equal(commandTargetsManagedWorktree(`W=${protectedPath} pnpm test && rm -rf "$W"`, "/elsewhere", protection,
    stale), null);
  // Standalone assignments apply left to right, exactly once: `A` ends up holding B's old value.
  assert.equal(commandTargetsManagedWorktree('A=$B B=$A; rm -rf "$A"', "/elsewhere", protection,
    { A: "/tmp", B: protectedPath }), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('A=$B B=$A; rm -rf "$B"', "/elsewhere", protection,
    { A: "/tmp", B: protectedPath }), MANAGED_WORKTREE_REFUSAL);
  // A self-referential assignment applied twice would append twice, landing one level BELOW the
  // root, which is ordinary scratch — so this is refused only when it is applied exactly once.
  assert.equal(commandTargetsManagedWorktree('A=$A/managed; rm -rf "$A"', "/elsewhere", protection,
    { A: "/runner/worktrees/session/requested" }), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('A=$A/managed; rm -rf "$A"', "/elsewhere", protection,
    { A: "/tmp" }), null);
});

test("a command expansion is field-split before the wrapper prefixes are read", () => {
  // The value carries the wrapper AND the remover, so the wrapper has to be seen inside it.
  for (const command of ["command rm -rf", "sudo rm -rf", "env rm -rf", "nohup rm -rf", "timeout 30 rm -rf"]) {
    assert.equal(commandTargetsManagedWorktree('$CMD "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection,
      { ...providerEnvironment, CMD: command }), MANAGED_WORKTREE_REFUSAL, command);
  }
  // An expansion with no fields at all disappears, and the word after it is the command.
  assert.equal(commandTargetsManagedWorktree('$EMPTY rm -rf "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection,
    { ...providerEnvironment, EMPTY: "" }), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('$EMPTY $EMPTY rm -rf "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere",
    protection, { ...providerEnvironment, EMPTY: "" }), MANAGED_WORKTREE_REFUSAL);
  // The same splitting must not invent a remover where the value holds ordinary work.
  assert.equal(commandTargetsManagedWorktree('$CMD "$WOLLIPOG_WORKTREE_PATH"', "/elsewhere", protection,
    { ...providerEnvironment, CMD: "git status --short" }), null);
});

test("an expanded env option stays an option inside nested argv", () => {
  for (const command of [
    `xargs env $OPTION PATH rm -rf ${protectedPath}`,
    `find . -exec env $OPTION PATH rm -rf ${protectedPath} +`,
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, "/elsewhere", protection, { OPTION: "-u" }),
      MANAGED_WORKTREE_REFUSAL, command);
  }
});

test("after `--` a dashed word is an operand, not an option", () => {
  // A worktree whose own name begins with a dash is reached by `rm -- -managed`, and the option
  // exemption that keeps `rm -rf /tmp/x` placeable must not extend past the terminator.
  const dashed: ManagedWorktreeProtection[] = [{ worktreePath: "/tmp/-managed", repoPath: "/projects/repo" }];
  assert.equal(commandTargetsManagedWorktree("rm -rf -- -managed", "/tmp", dashed), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('cd "$(printf /tmp)" && rm -rf -- -managed', "/elsewhere", dashed),
    MANAGED_WORKTREE_UNRESOLVED_REFUSAL, "and where the directory is unknown it cannot be placed");
  assert.equal(commandTargetsManagedWorktree('cd "$(printf /tmp)" && rm -rf -- /tmp/scratch', "/elsewhere", dashed),
    null, "while an absolute operand after the terminator is still placeable");
  assert.equal(commandTargetsManagedWorktree("mv -- -managed /tmp/away", "/tmp", dashed), MANAGED_WORKTREE_REFUSAL);
});

test("a quoted expansion carrying an IFS character is refused rather than missed", () => {
  // `shell-quote` does not report whether an expansion was quoted, so an operand built from a
  // variable is judged field by field as if it were unquoted. Splitting too eagerly can only
  // refuse; not splitting at all would MISS `IFS=:; rm -rf $TARGET`, which is the hole this
  // guards. The cost is pinned here rather than left to be discovered: a genuinely quoted path
  // that contains a separator AND a protected field is refused.
  const environment = { ...providerEnvironment, IFS: ":", TARGET: `/tmp/scratch:${protectedPath}` };
  assert.equal(commandTargetsManagedWorktree('rm -rf "$TARGET"', "/elsewhere", protection, environment),
    MANAGED_WORKTREE_REFUSAL);
  // An ordinary quoted value with a separator in it and no protected field stays allowed.
  assert.equal(commandTargetsManagedWorktree('rm -rf "$SAFE"', "/elsewhere", protection,
    { ...environment, SAFE: "/tmp/a:/tmp/b" }), null);
});

test("argv is expanded by the outer shell, not by the process that receives it", () => {
  // `xargs` and `find -exec` receive ARGV: the outer shell expanded these words before the prefix
  // assignment applied, so the stale prefix cannot hide the root behind them.
  const stale = { W: protectedPath };
  assert.equal(commandTargetsManagedWorktree('W=/tmp xargs rm -rf "$W"', "/elsewhere", protection, stale),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('W=/tmp find . -name x -exec rm -rf "$W" +', "/elsewhere", protection,
    stale), MANAGED_WORKTREE_REFUSAL);
  // A bare `cd` enters the HOME of the environment the builtin is GIVEN, prefix included.
  assert.equal(commandTargetsManagedWorktree(`HOME=${protectedPath} cd && rm -rf .`, "/tmp", protection,
    { HOME: "/tmp" }), MANAGED_WORKTREE_REFUSAL);
  // In `/bin/sh` a prefix assignment before a POSIX special builtin survives the command, and in
  // bash outside POSIX mode it does not. The two readings name different directories — the root
  // under `/bin/sh`, the stale `/tmp` under bash — and which shell runs is not knowable here, so
  // the name stops being readable and the removal is refused as unplaceable rather than guessed.
  assert.equal(commandTargetsManagedWorktree(`sh -c 'W=${protectedPath} :; rm -rf "$W"'`, "/elsewhere", protection,
    { W: "/tmp" }), MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  assert.equal(commandTargetsManagedWorktree(`sh -c 'W=${protectedPath} export X=1; rm -rf "$W"'`, "/elsewhere",
    protection, { W: "/tmp" }), MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  // The other direction of the same ambiguity: the launch value is the protected one, and a
  // prefix that bash would discard must not talk the classifier out of refusing it.
  assert.equal(commandTargetsManagedWorktree(`sh -c 'W=/tmp :; rm -rf "$W"'`, "/elsewhere", protection,
    { W: protectedPath }), MANAGED_WORKTREE_UNRESOLVED_REFUSAL);
  // An ordinary command's prefix still dies with it, so a later reference reads the launch value.
  assert.equal(commandTargetsManagedWorktree(`sh -c 'W=/tmp pnpm test; rm -rf "$W"'`, "/elsewhere", protection,
    { W: protectedPath }), MANAGED_WORKTREE_REFUSAL);
  // `env` reads its own argv, so an assignment that arrived through an expansion is one.
  assert.equal(commandTargetsManagedWorktree(`env "$ASSIGNMENT" sh -c 'rm -rf "$W"'`, "/tmp", protection,
    { ASSIGNMENT: `W=${protectedPath}` }), MANAGED_WORKTREE_REFUSAL);
});

test("roles are assigned to fields, not to the text that produced them", () => {
  // `mv $PAIR` supplies TWO operands, so the root is a source and not the destination it would be
  // if the expansion were counted as one word.
  assert.equal(commandTargetsManagedWorktree("mv $PAIR", "/tmp", protection,
    { PAIR: `${protectedPath} /tmp/away` }), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("mv $PAIR", "/tmp", protection, { PAIR: "/tmp/a /tmp/b" }), null,
    "while an ordinary pair of scratch paths still moves");
  // The same splitting reveals a `find` action hidden inside an expansion.
  assert.equal(commandTargetsManagedWorktree("find $ARGS", "/tmp", protection,
    { ARGS: `${protectedPath} -delete` }), MANAGED_WORKTREE_REFUSAL);
  // ...and the UNSPLIT reading is judged too, so a protected path that itself contains a separator
  // is still matched where field splitting would have torn it apart.
  const spaced: ManagedWorktreeProtection[] = [{ worktreePath: "/runner/my worktree", repoPath: "/projects/repo" }];
  assert.equal(commandTargetsManagedWorktree('rm -rf "$W"', "/elsewhere", spaced, { W: "/runner/my worktree" }),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('mv "$W" /tmp/away', "/elsewhere", spaced, { W: "/runner/my worktree" }),
    MANAGED_WORKTREE_REFUSAL);
});

test("moving files INTO a protected worktree is ordinary work", () => {
  // The unsplit reading of a field-split expansion belongs to the role its first field takes. A
  // protected path with a space in it splits, but as a DESTINATION it receives the move: the
  // worktree is not retired by it, and refusing would break ordinary work (#1324 review round 4).
  const spaced: ManagedWorktreeProtection[] = [{ worktreePath: "/runner/my worktree", repoPath: "/projects/repo" }];
  const environment = { W: "/runner/my worktree" };
  assert.equal(commandTargetsManagedWorktree('mv /tmp/a "$W"', "/elsewhere", spaced, environment), null);
  assert.equal(commandTargetsManagedWorktree('mv -t "$W" /tmp/a', "/elsewhere", spaced, environment), null);
  assert.equal(commandTargetsManagedWorktree('cp -r /tmp/a "$W"', "/elsewhere", spaced, environment), null);
  // ...while the same path as a SOURCE is the worktree being moved away, and is refused.
  assert.equal(commandTargetsManagedWorktree('mv "$W" /tmp/away', "/elsewhere", spaced, environment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('mv -t /tmp/away "$W"', "/elsewhere", spaced, environment),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree('rm -rf "$W"', "/elsewhere", spaced, environment),
    MANAGED_WORKTREE_REFUSAL);
  // A read of the same destination is untouched.
  assert.equal(commandTargetsManagedWorktree('ls "$W"', "/elsewhere", spaced, environment), null);
});

// A session's own default worktree is verified to be on its `agent/<session-id>` branch before
// every turn, so moving it elsewhere parked the session in worktree recovery with nothing saying
// why (#1650). The pin rides on the protection the runner already publishes.
const ownWorktree = "/runner/worktrees/s_own";
const ownBranch = "agent/s_own";
const pinned: ManagedWorktreeProtection[] = [{ worktreePath: ownWorktree, repoPath: "/projects/repo", pinnedBranch: ownBranch }];

test("switching a session's own worktree off its branch is refused with a pointer to wollipog worktree create (#1650)", () => {
  assert.match(MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL, /wollipog worktree create --branch/u);
  for (const command of [
    "git checkout -b fix/issue-1650-guard",
    "git checkout -B fix/issue-1650-guard origin/main",
    "git checkout -bfix/issue-1650-guard",
    "git checkout -qb fix/issue-1650-guard",
    "git checkout --orphan scratch",
    "git checkout --orph=scratch",
    "git checkout --detach",
    "git checkout --detach origin/main",
    "git checkout main",
    "git checkout -t origin/feature",
    "git checkout -",
    "git checkout main --",
    // `@` detaches where `HEAD` does not, and `-d` is checkout's own short `--detach`.
    "git checkout @",
    "git checkout -d",
    "git checkout -qd",
    "git checkout -d origin/main",
    // Revision syntax names a commit, never a file.
    "git checkout HEAD~1",
    "git checkout main^",
    "git checkout @{-1}",
    "git checkout HEAD@{2}",
    "git checkout main...feature",
    "git checkout ':/fix the guard'",
    "git checkout refs/heads/agent/s_own",
    "git checkout origin/agent/s_own",
    "git switch -c fix/issue-1650-guard",
    "git switch -C fix/issue-1650-guard",
    "git switch -cfix/issue-1650-guard",
    "git switch --create fix/issue-1650-guard",
    "git switch --create=fix/issue-1650-guard",
    "git switch --cr fix/issue-1650-guard",
    "git switch --force-create fix/issue-1650-guard",
    "git switch --orphan scratch",
    "git switch main",
    "git switch -",
    "git switch --detach",
    "git switch -d origin/main",
    "git switch --track origin/feature",
    "git branch -m renamed",
    "git branch -M renamed",
    `git branch --move ${ownBranch} renamed`,
    "git stash branch fix/from-stash",
    // A forge CLI's checkout switches the repository in the current directory.
    "gh pr checkout 1749",
    "gh pr checkout 1749 --detach",
    "glab mr checkout 12",
    // Git's own options before the subcommand do not hide it.
    "git --no-pager -c core.pager=cat checkout -b fix/x",
    `git -C ${ownWorktree} switch -c fix/x`,
    `git -C ${ownWorktree}/apps/runner switch -c fix/x`,
    `git --git-dir=${ownWorktree}/.git switch -c fix/x`,
    // Nor does a nested shell, a later segment, or a directory change that stays inside the root.
    "sh -c 'git switch -c fix/x'",
    "git status && git checkout -b fix/x",
    "cd apps/runner && git switch -c fix/x",
    'B=fix/x; git switch -c "$B"',
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, ownWorktree, pinned), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL,
      command);
  }
  // From anywhere, naming the worktree with -C is the same command.
  assert.equal(commandTargetsManagedWorktree(`git -C ${ownWorktree} checkout -b fix/x`, "/tmp", pinned),
    MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  // A new branch whose name cannot be read is still a new branch.
  assert.equal(commandTargetsManagedWorktree('git checkout -b "$(date +%s)"', ownWorktree, pinned),
    MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
});

test("restoring files and returning a session's own worktree to its branch stay available (#1650)", () => {
  for (const command of [
    `git switch ${ownBranch}`,
    `git checkout ${ownBranch}`,
    `git checkout -B ${ownBranch}`,
    "git checkout",
    "git checkout HEAD",
    "git checkout HEAD --",
    "git checkout -- apps/runner/src/deleted.ts",
    "git checkout HEAD -- apps/runner/src/deleted.ts",
    "git checkout origin/main apps/runner/src/a.ts apps/runner/src/b.ts",
    "git checkout -p",
    "git checkout --patch apps/runner",
    "git checkout --ours conflicted.ts",
    "git checkout --theirs conflicted.ts",
    "git checkout --pathspec-from-file=paths.txt",
    // Spellings no branch can have are paths or pathspecs, whether or not they exist.
    "git checkout .",
    "git checkout ./apps",
    "git checkout apps/",
    "git checkout '*.ts'",
    "git checkout ':(glob)**/*.ts'",
    `git checkout ${ownWorktree}/README.md`,
    "git status && git diff",
    "git branch --list",
    "git branch -d merged-branch",
    "git branch --merged",
    "git stash push -m wip",
    "git worktree add -b fix/elsewhere ../elsewhere",
    "gh pr view 1749",
    "gh pr create --fill",
    "glab mr view 12",
    // A switch this code cannot place is not refused: a branch switch is recoverable.
    'git switch "$UNKNOWN_BRANCH"',
    'git -C "$(mktemp -d)" switch -c fix/x',
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, ownWorktree, pinned), null, command);
  }
});

test("branch work outside a session's own worktree is unaffected (#1650)", () => {
  // A worktree the session created with `wollipog worktree create` carries no pin.
  const created = "/runner/worktrees/s_own.requested/abc123";
  const both: ManagedWorktreeProtection[] = [...pinned, { worktreePath: created, repoPath: "/projects/repo" }];
  for (const command of [
    "git checkout -b fix/issue-1650-part-2",
    "git switch -c fix/issue-1650-part-2",
    "git switch main",
    "git checkout main",
    "git branch -m fix/renamed",
    "gh pr checkout 1749",
  ]) {
    assert.equal(commandTargetsManagedWorktree(command, created, both), null, `created worktree: ${command}`);
    assert.equal(commandTargetsManagedWorktree(command, "/projects/repo", both), null, `primary checkout: ${command}`);
    assert.equal(commandTargetsManagedWorktree(command, "/tmp/scratch-repo", both), null, `unrelated repository: ${command}`);
    assert.equal(commandTargetsManagedWorktree(command, ownWorktree, [{ worktreePath: ownWorktree, repoPath: "/projects/repo" }]),
      null, `unpinned protection: ${command}`);
    if (command.startsWith("git ")) {
      assert.equal(commandTargetsManagedWorktree(`git -C ${created} ${command.slice(4)}`, ownWorktree, both), null,
        `-C to the created worktree: ${command}`);
    }
  }
  // The innermost protected root decides: a worktree nested beneath the pinned one is its own.
  const nested = `${ownWorktree}/.claude/worktrees/agent`;
  assert.equal(commandTargetsManagedWorktree("git switch -c fix/x", nested,
    [...pinned, { worktreePath: nested, repoPath: "/projects/repo" }]), null);
});

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("a lone checkout operand is a file only when Git would read it as one (#1650)", { skip: !gitAvailable() }, (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-branch-pin-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(repo);
  initRepo(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "guide.md"), "guide");
  writeFileSync(join(repo, "README"), "readme");
  writeFileSync(join(repo, "feature"), "a file that shares its name with a branch");
  writeFileSync(join(repo, "cafe"), "a file whose name could abbreviate an object id");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "feature");
  const worktree = join(base, "own");
  git(repo, "worktree", "add", "-q", "-b", ownBranch, worktree);
  const protections = [{ worktreePath: worktree, repoPath: repo, pinnedBranch: ownBranch }];
  const verdict = (command: string, cwd = worktree) => commandTargetsManagedWorktree(command, cwd, protections);

  // Git tries a commit before a path: a file that is not also a ref is restored...
  assert.equal(verdict("git checkout README"), null);
  assert.equal(verdict("git checkout docs"), null);
  assert.equal(verdict("git checkout docs/guide.md"), null);
  // ...while a name that is both switches to the branch, as does one that exists only as a branch.
  assert.equal(verdict("git checkout feature"), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  assert.equal(verdict("git checkout no-such-branch"), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  assert.equal(verdict("git checkout cafe"), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL,
    "a name that could abbreviate an object id is treated as a commit");
  assert.equal(verdict("git checkout -- feature"), null, "the explicit restore form stays available");
  // Packed refs are refs too.
  git(repo, "pack-refs", "--all");
  assert.equal(verdict("git checkout feature"), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  assert.equal(verdict("git checkout README"), null);

  // A `--git-dir` naming the worktree's administrative directory is the worktree. Spelled
  // absolutely it names the worktree registry, which the registry veto already refuses outright;
  // a relative spelling reaches the branch pin.
  const adminDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8" }).trim();
  assert.equal(verdict(`git --git-dir=${adminDir} --work-tree=. switch -c fix/x`), MANAGED_WORKTREE_REFUSAL);
  assert.equal(verdict("git --git-dir ../repo/.git/worktrees/own --work-tree=. switch -c fix/x"),
    MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  assert.equal(verdict("git --git-dir=../repo/.git/worktrees/own switch -c fix/x"),
    MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
  assert.equal(verdict(`git --git-dir=${join(repo, ".git")} switch -c fix/x`, base), null,
    "the repository's own Git directory is the primary checkout, which is not pinned");

  // Git takes its repository from the nearest `.git`, so a repository nested beneath the worktree
  // (a fixture, a clone) is that repository, and switching its branch is not the worktree's.
  const fixture = join(worktree, "fixtures", "repo");
  mkdirSync(join(fixture, ".git"), { recursive: true });
  mkdirSync(join(fixture, "src"));
  assert.equal(verdict("git checkout -b fixture-branch", fixture), null);
  assert.equal(verdict("git switch main", join(fixture, "src")), null);
  assert.equal(verdict(`git -C ${fixture} switch main`), null);
  assert.equal(verdict("git switch main", join(worktree, "fixtures")), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL,
    "a directory above the nested repository is still the worktree");

  // A worktree reached through a symlinked prefix is the same worktree.
  const alias = join(base, "alias");
  symlinkSync(worktree, alias);
  assert.equal(verdict("git switch -c fix/x", alias), MANAGED_WORKTREE_BRANCH_SWITCH_REFUSAL);
});
