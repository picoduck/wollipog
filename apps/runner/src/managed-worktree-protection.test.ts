import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  commandTargetsManagedWorktree,
  MANAGED_WORKTREE_REFUSAL,
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
