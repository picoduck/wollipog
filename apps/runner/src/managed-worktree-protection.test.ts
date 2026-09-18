import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_REFUSAL,
  shellCwdAfterCommand,
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

test("shellCwdAfterCommand follows literal directory changes and gives up on invisible ones", () => {
  const root = protectedPath;
  const cases: Array<[string, string | null, string | null]> = [
    ["ls", root, root],
    ["cd apps/runner", root, `${root}/apps/runner`],
    ["cd apps/runner && pnpm typecheck", root, `${root}/apps/runner`],
    ["cd apps && cd runner && ls", root, `${root}/apps/runner`],
    ["ls; pwd", root, root],
    ["ls || true", root, root],
    ["cd ..", `${root}/apps/runner`, `${root}/apps`],
    ["cd .. && cd ..", `${root}/apps/runner`, root],
    ["cd -P apps && ls", root, null],
    ["cd -- apps", root, `${root}/apps`],
    ["cd /tmp/elsewhere", root, "/tmp/elsewhere"],
    ["cd -L apps", root, `${root}/apps`],
    // Unknown after these: the text does not say where the shell ends up.
    ["cd $DIR", root, null],
    // Exit 0 does not prove a `cd` beside `;` or `||` ran or succeeded; unknown, never deeper.
    ["cd apps; ls", root, null],
    ["cd apps && cd runner; ls", root, null],
    ["cd apps || true", root, null],
    ["true || cd apps", root, null],
    ["ls; cd apps", root, null],
    ["cd -", root, null],
    ["cd ~", root, null],
    ["popd", root, null],
    // The directory stack and indirect evaluation move the shell without a top-level `cd`.
    ["pushd apps", root, null],
    ["pushd -n apps", root, null],
    ["cd apps && eval 'cd ..'", root, null],
    ["cd apps && builtin cd ..", root, null],
    ["cd apps && command cd ..", root, root],
    ["cd apps && source ./env.sh", root, null],
    ["cd apps && . ./env.sh", root, null],
    ["cd apps && exec sh", root, null],
    ["cd -q apps", root, null],
    // A launcher prefix runs an external cd that never moves the shell (and exits 0 on macOS).
    ["nice cd apps", root, null],
    ["env cd apps", root, null],
    ["sudo cd apps", root, null],
    ["timeout 5 cd apps", root, null],
    ["FOO=1 cd apps", root, null],
    ["cd apps && nice cd ..", root, null],
    // Newlines are whitespace to the tokenizer: a multi-line command that could move the shell
    // is unknown; one that cannot has not moved it.
    ["cd apps\ncd ..", root, null],
    ["cd apps\n", root, null],
    ["ls\npwd", root, root],
    ["python3 - <<'EOF'\nprint(1)\nEOF", root, root],
    ["cat <<'EOF'\ncd ..\nEOF", root, null],
    // Compound commands run their body in the current shell.
    ["if true; then cd ..; fi", `${root}/apps`, null],
    ["{ cd ..; }", `${root}/apps`, null],
    ["while true; do cd ..; break; done", `${root}/apps`, null],
    ["time cd apps", root, null],
    // A DEBUG/EXIT trap body runs before Claude's appended `pwd -P`.
    ["trap 'cd /elsewhere' DEBUG", `${root}/apps`, null],
    ["cd apps && trap 'cd ..' EXIT", root, null],
    ["trap 'cd ..' DEBUG\nls", `${root}/apps`, null],
    // Forms the shell expands or joins into something the text does not spell out.
    ["cd link{1..1}", root, null],
    ["cd ap\\ps", root, `${root}/apps`],
    ["c\\\nd apps", root, null],
    ["cd apps && ls \\\n  -la", root, null],
    ["ls \\\n  -la", root, root],
    ["command -v cd", root, null],
    ["command -pv cd", root, null],
    ["command -p cd apps", root, `${root}/apps`],
    ["(cd apps && ls)", root, null],
    ["cd apps | cat", root, null],
    ["ls && cd apps | cat", root, null],
    // An unknown directory stays unknown until an absolute change re-establishes it.
    ["ls", null, null],
    ["cd apps", null, null],
    ["cd /tmp/known", null, "/tmp/known"],
    ["cd /tmp/known && cd sub", null, "/tmp/known/sub"],
  ];
  for (const [command, cwd, expected] of cases) {
    assert.equal(shellCwdAfterCommand(command, cwd), expected, `${cwd} + \`${command}\``);
  }
});

test("a relative removal is judged from where the shell actually is", () => {
  // From a subdirectory, `cd ..` stays inside the worktree; from the root it leaves it.
  assert.equal(commandTargetsManagedWorktree("cd ..", `${protectedPath}/apps/runner`, protection), null);
  assert.equal(commandTargetsManagedWorktree("cd ..", protectedPath, protection), MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("rm -rf ../..", `${protectedPath}/apps/runner`, protection), MANAGED_WORKTREE_REFUSAL);
});

test("the tracked directory is the physical end of a logical walk, as Claude's pwd -P records it", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const worktree = join(base, "managed");
  mkdirSync(join(worktree, "apps"), { recursive: true });
  mkdirSync(join(worktree, "deep", "target"), { recursive: true });
  mkdirSync(join(base, "escape"));
  symlinkSync(base, join(worktree, "link"));
  symlinkSync(join("deep", "target"), join(worktree, "inner"));
  const protections = [{ worktreePath: worktree, repoPath: join(base, "repo") }];
  // Within one command the walk is logical; the recorded end is physical.
  assert.equal(shellCwdAfterCommand("cd inner", worktree), join(worktree, "deep", "target"));
  assert.equal(shellCwdAfterCommand("cd inner && cd ..", worktree), worktree, "a logical chain ends at the root");
  assert.equal(shellCwdAfterCommand("cd link/escape", worktree), join(base, "escape"));
  assert.equal(shellCwdAfterCommand("cd apps", worktree), join(worktree, "apps"));
  assert.equal(shellCwdAfterCommand("ls", join(worktree, "inner")), join(worktree, "inner"), "no cd, no change");
  // An external operand from a symlinked directory resolves through the kernel.
  assert.equal(commandTargetsManagedWorktree("rm -rf ../managed", join(worktree, "link", "escape"), protections),
    MANAGED_WORKTREE_REFUSAL, "physically ../managed IS the worktree");
  assert.equal(commandTargetsManagedWorktree("rm -rf managed", join(worktree, "link"), protections),
    MANAGED_WORKTREE_REFUSAL);
  assert.equal(commandTargetsManagedWorktree("cd inner && cd .. && rm -rf .", worktree, protections),
    MANAGED_WORKTREE_REFUSAL, "the logical chain reaches the root");
  assert.equal(commandTargetsManagedWorktree("cd link/escape", worktree, protections),
    MANAGED_WORKTREE_REFUSAL, "a cd whose physical target leaves the worktree is an escape");
  assert.equal(commandTargetsManagedWorktree("rm -rf build", join(worktree, "apps"), protections), null);
  assert.equal(commandTargetsManagedWorktree("rm -rf target", join(worktree, "inner"), protections), null);
});

test("a symlink retargeted after the shell entered it does not move the tracked directory", (t) => {
  // /base/wt/a/b/link -> /base/wt/x. The shell enters it; the link is then re-pointed. The shell is
  // still physically in x, which is what was recorded when the command finished.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-cwd-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const wt = join(base, "wt");
  mkdirSync(join(wt, "a", "b"), { recursive: true });
  mkdirSync(join(wt, "x"));
  mkdirSync(join(wt, "deep", "y"), { recursive: true });
  symlinkSync(join(wt, "x"), join(wt, "a", "b", "link"));
  const protections = [{ worktreePath: wt, repoPath: join(base, "repo") }];
  const tracked = shellCwdAfterCommand("cd a/b/link", wt);
  assert.equal(tracked, join(wt, "x"));
  rmSync(join(wt, "a", "b", "link"));
  symlinkSync(join(wt, "deep", "y"), join(wt, "a", "b", "link"));
  assert.equal(commandTargetsManagedWorktree("rm -rf ../../wt", tracked!, protections), MANAGED_WORKTREE_REFUSAL);
  // git -C is resolved from the same physical directory: ../.. from wt/x is /base.
  assert.equal(
    commandTargetsManagedWorktree(`git --git-dir=${join(base, "repo", ".git")} -C ../.. worktree remove --force wt`, tracked!, protections),
    MANAGED_WORKTREE_REFUSAL,
  );
  assert.equal(commandTargetsManagedWorktree("rm -rf scratch", tracked!, protections), null);
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
