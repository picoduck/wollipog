import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { commandTargetsGuardState } from "./managed-worktree-protection.js";

const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
const bashVersion = /version (\d+)\.(\d+)/u.exec(bash.stdout ?? "");
function supportsWitness(label: string, major: number, minor: number): boolean {
  const minimum = label === "@k" ? [5, 2]
    : ["@U", "@u", "@L", "@K"].includes(label) ? [5, 1]
    : label.startsWith("@") ? [4, 4]
    : ["^", "^^", ",", ",,"].includes(label) ? [4, 0] : [3, 2];
  return major > minimum[0]! || (major === minimum[0] && minor >= minimum[1]!);
}

// Each expression produces `alias` (or the relative hook path), not just an arbitrary value.
const cases = [
  ["HOME trim", "cat ${HOME%/}/data/hooks/file"],
  ["HOME default", "cat ${HOME:-x}/data/hooks/file"],
  ["substring", "x=X../data/hooks; cat ${x:1}/file"],
  ["substring length", "x=XaliasZ; cat ${x:1:5}/file"],
  ["suffix write", "x=../data/hooksZ; touch ${x%Z}/new"],
  ...["#", "##"].map(op => [op, `x=prefixalias; cat \${x${op}prefix}/file`]),
  ...["%", "%%"].map(op => [op, `x=aliasZ; cat \${x${op}Z}/file`]),
  ...["/prefix/", "//prefix/", "/#prefix/"].map(op => [op, `x=prefixalias; cat \${x${op}}/file`]),
  ["/%", "x=aliasZ; cat ${x/%Z/}/file"],
  ...["^", "^^", ",", ",,"].map(op => [op, `x=alias; cat \${x${op}}/file`]),
  ...[":-", "-", ":=", "="].map(op => [op, `unset x; cat \${x${op}alias}/file`]),
  ...[":+", "+"].map(op => [op, `x=yes; cat \${x${op}alias}/file`]),
  ...[":?", "?"].map(op => [op, `x=alias; cat \${x${op}missing}/file`]),
  ["indirect", "x=alias; y=x; cat ${!y}/file"],
  ["length", "cat ${#HOME}/file"],
  ["prefix star", "zzguard=ok; cat ${!zzgu*}/file"],
  ["prefix at", "zzguard=ok; cat ${!zzgu@}/file"],
  ...["Q", "E", "P", "A", "a", "U", "u", "L", "K", "k"].map(op =>
    ["@" + op, `x=alias; cat \${x@${op}}/file`]),
  ["partial operand", "x=alias; cat a${x#?}/file"],
  ["nested", "unset x; y=prefixalias; cat ${x:-${y#prefix}}/file"],
  ["assignment", "x=prefixalias; y=${x#prefix}; cat $y/file"],
  ["redirect", "x=prefixalias; cat < ${x#prefix}/file"],
  ["plain HOME control", "cat $HOME/data/hooks/file"],
  ["relative control", "cat ../data/hooks/file"],
  ["tracked control", "x=alias; cat $x/file"],
] as const;

for (const [label, command] of cases) {
  test(`guard refuses parameter paths: ${label}`, t => {
    const home = mkdtempSync(join(tmpdir(), "wollipog-parameter-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const project = join(home, "project");
    const hooks = join(home, "data", "hooks");
    mkdirSync(project);
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "file"), "reached-hook-state");
    const alias = (name: string) => symlinkSync(hooks, join(project, name), process.platform === "win32" ? "junction" : "dir");
    for (const name of ["alias", "Alias", "ALIAS", "zzguard", String(home.length), "'alias'", "x='alias'"]) {
      // Windows filenames cannot contain quotes: the Bash witness runs only on POSIX/WSL.
      if (process.platform === "win32" && /['"]/u.test(name)) continue;
      if (!existsSync(join(project, name))) alias(name);
    }
    // @a, @K and @k on a scalar yield an empty word: their operand becomes /file. Use
    // an array for K/k below; @a instead uses the 'a' attribute of an indexed array.
    alias("a");
    const actual = label === "@a" ? "x=(alias); cat ${x@a}/file"
      : label === "@K" || label === "@k" ? `x=(alias); cat \${x@${label.slice(1)}}/file` : command;
    const envName = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const previous = process.env[envName];
    process.env[envName] = home;
    try {
      assert.notEqual(commandTargetsGuardState(actual, project, hooks), null, actual);
      assert.equal(commandTargetsGuardState("cat ordinary-file", project, hooks), null);
    } finally {
      if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
    }
    if (process.platform === "win32" || bash.status !== 0 || !bashVersion) {
      t.diagnostic("Bash reachability witness unavailable; guard assertion still ran");
      return;
    }
    if (!supportsWitness(label, Number(bashVersion[1]), Number(bashVersion[2]))) {
      t.diagnostic(`Bash ${bashVersion[1]}.${bashVersion[2]} lacks ${label}; guard assertion still ran`);
      return;
    }
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", actual], {
      cwd: project, env: { ...process.env, HOME: home, BASH_ENV: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 0, `${actual}: ${result.stderr}`);
    if (label === "suffix write") assert.equal(readFileSync(join(hooks, "new"), "utf8"), "");
    else assert.equal(result.stdout, "reached-hook-state", actual);
  });
}

test("operator non-path uses deliberately fail closed; plain parameters and inert text retain their reading", () => {
  for (const command of ["echo ${#x}", "echo ${x:-ok}", "x=${y#prefix}; echo ok", "echo ${x:-${y%z}}"])
    assert.notEqual(commandTargetsGuardState(command, "/project", "/state/hooks"), null, command);
  for (const command of ["echo $UNKNOWNVAR", "echo ${plain}", "echo ${1}", "echo ${?}", "echo '${x:-ok}'", "echo \\${x:-ok}"])
    assert.equal(commandTargetsGuardState(command, "/project", "/state/hooks"), null, command);
});

test("Bash witness version gates retain supported older-shell witnesses", () => {
  assert.equal(supportsWitness("substring", 3, 2), true);
  assert.equal(supportsWitness("^^", 3, 2), false);
  assert.equal(supportsWitness("^^", 4, 0), true);
  assert.equal(supportsWitness("@Q", 4, 3), false);
  assert.equal(supportsWitness("@Q", 4, 4), true);
  assert.equal(supportsWitness("@U", 5, 0), false);
  assert.equal(supportsWitness("@U", 5, 1), true);
  assert.equal(supportsWitness("@k", 5, 1), false);
  assert.equal(supportsWitness("@k", 5, 2), true);
});

test("empty tokenizer names retain base behavior for non-operator dollar syntax", t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-dollar-controls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const hooks = join(root, "state", "hooks");
  mkdirSync(project);
  mkdirSync(hooks, { recursive: true });
  for (const command of [
    'echo "$(pwd)"', 'cd "$(git rev-parse --show-toplevel)"', 'grep -E "^foo$" f',
    "printf $'a\\tb'", 'echo $#', 'T=$(mktemp -d)',
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"',
  ]) assert.equal(commandTargetsGuardState(command, project, hooks), null, command);
  // Preserving the sentinel must not suppress direct or relative state access in substitutions.
  for (const command of ['cat $(echo ../state/hooks/file)', `cat "$(cat ${hooks.split(sep).join("/")}/file)"`])
    assert.notEqual(commandTargetsGuardState(command, project, hooks), null, command);
});

test("operators refuse before platform path resolution, including drive/backslash and WSL paths", () => {
  for (const path of ["C:\\Users\\Test\\data\\hooks", "c:/users/test/DATA/hooks", "/mnt/c/Users/Test/data/hooks"]) {
    for (const expression of ["x%Z", "x#prefix", "x:1", "HOME:-x", "!x", "#x", "x@P", "x:-${y%Z}"]) {
      for (const command of [`cat \${${expression}}/file`, `touch pre\${${expression}}\\new`])
        assert.notEqual(commandTargetsGuardState(command, "/project", path), null, command);
    }
  }
});
