import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { commandTargetsGuardState } from "./managed-worktree-protection.js";

test("quoted interpreter heredocs have script-file parity while literal state and alias paths refuse (Refs #1734)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guard-interpreter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const nested = join(project, "nested");
  const directory = join(root, "data", "hooks");
  for (const path of [project, nested, directory]) mkdirSync(path, { recursive: true });
  const alias = join(project, "alias");
  symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  symlinkSync(directory, join(nested, "nested-alias"), process.platform === "win32" ? "junction" : "dir");
  const judge = (command: string) => commandTargetsGuardState(command, project, directory);
  // These baseline calls already permit arbitrary script-file execution. The quoted body below
  // has the same interpreter reach; it must not be mistaken for shell-expanded words.
  for (const command of ["python3 ./x.py", "node x.mjs"]) assert.equal(judge(command), null, command);
  for (const interpreter of ["python3", "node"]) {
    for (const prefix of ["", `cd ${project.replaceAll("\\", "/")} && `, "cd ./nested && "]) {
      for (const delimiter of ["'PY'", '"PY"']) {
        const body = interpreter === "python3"
          ? "ratio = 3 / 2\n# // a comment\nprint('${spec.sessionId}')"
          : "const ratio = 3 / 2; // a comment\nconst spec = {sessionId: 'safe'}; console.log(`${spec.sessionId}`);";
        const command = `${prefix}${interpreter} - <<${delimiter}\n${body}\nPY`;
        assert.equal(judge(command), null, command);
      }
    }
    for (const path of [directory.replaceAll("\\", "/"), relative(project, directory).replaceAll("\\", "/"), "alias", "alias/secret"]) {
      for (const body of [`open('${path}')`, `open("${path}")`, `os.system("cat ${path}")`, `// ${path}`]) {
        const command = `${interpreter} - <<'PY'\n${body}\nPY`;
        assert.notEqual(judge(command), null, command);
      }
    }
    for (const body of ["open('nested-alias/secret')", "os.system('cat nested-alias/secret')"]) {
      assert.notEqual(judge(`cd ./nested && ${interpreter} - <<'PY'\n${body}\nPY`), null);
    }
    for (const body of ["open('a\\lias/secret')", "open('\\x61lias/secret')", "os.system('rm -rf /')"]) {
      // Encoded/unknown escapes are outside the body whitelist, never silently decoded or ignored.
      assert.notEqual(judge(`${interpreter} - <<'PY'\n${body}\nPY`), null, body);
    }
    for (const suffix of ["\ncat alias/secret", "\n# note\ncat alias/secret"]) {
      assert.notEqual(judge(`${interpreter} - <<'PY'\nconsole.log('safe');\nPY${suffix}`), null);
    }
    assert.notEqual(commandTargetsGuardState(`${interpreter} - <<'PY'\nopen('~/.wollipog/hooks/secret')\nPY`, project,
      join(homedir(), ".wollipog", "hooks")), null);
  }
  symlinkSync(directory, join(project, "alias#"), process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(judge("node - <<'PY'\nread('alias#/secret')\nPY"), null);
  assert.notEqual(judge("python3 - <<'PY'\nos.system('$(cat alias/secret)')\nPY"), null);
  assert.notEqual(judge("python3 - <<'PY'\nopen('ali''as/secret')\nPY"), null);
  assert.notEqual(judge("cd alias && node - <<'PY'\nconsole.log('safe');\nPY"), null);
  for (const cd of ["-", "--", "nested"]) {
    assert.notEqual(judge(`cd ${cd} && node - <<'PY'\nconsole.log('safe');\nPY`), null, cd);
  }
  symlinkSync(nested, join(root, "cwd-alias"), process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(commandTargetsGuardState("cd .. && node - <<'PY'\nread('alias/secret')\nPY",
    join(root, "cwd-alias"), directory), null, "cd .. follows the physical parent of a symlink cwd");
  assert.notEqual(commandTargetsGuardState("python3 - <<'PY'\nos.system('cat $HOME/.wollipog/hooks/secret')\nPY", project,
    join(homedir(), ".wollipog", "hooks")), null);
  assert.notEqual(commandTargetsGuardState("python3 - <<'PY'\nos.system('cat ${HOME:-unused}/.wollipog/hooks/secret')\nPY", project,
    join(homedir(), ".wollipog", "hooks")), null);
});

test("bounded inspection pipelines admit only fixed stdin consumers (Refs #1734)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guard-pipeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const directory = join(root, "data", "hooks");
  mkdirSync(project, { recursive: true });
  mkdirSync(directory, { recursive: true });
  symlinkSync(directory, join(project, "alias"), process.platform === "win32" ? "junction" : "dir");
  const judge = (command: string) => commandTargetsGuardState(command, project, directory);
  for (const command of ["ls / | wc -l", "ls // | head -n 5", "stat / | cat", "ls ~ | tail -n 2",
    `ls ${root.replaceAll("\\", "/")} | wc -l`, "ls / | grep -- '//'", "ls / | wc -l | head -n 1"]) {
    assert.equal(judge(command), null, command);
  }
  for (const command of ["ls alias | wc -l", "ls 'alias' | head", "ls a\\lias | cat", "ls -R / | wc -l",
    "ls / | xargs rm -rf", "ls / | wc -l > alias/x", "ls / | cat alias/secret", "ls / | head -n $(cat alias/secret)",
    "ls / | grep -f alias/secret", "ls / | grep -- 'x' alias/secret", "ls / | wc -l; cat alias/secret"]) {
    assert.notEqual(judge(command), null, command);
  }
  for (const path of [directory.replaceAll("\\", "/"), relative(project, directory).replaceAll("\\", "/")]) {
    assert.notEqual(judge(`ls ${path} | wc -l`), null);
  }
  // Here ~ and HOME really enclose the synthetic guard directory, unlike the temporary layout.
  const homeState = join(homedir(), ".wollipog-data", "hooks");
  for (const command of ["ls ~ | wc -l", "ls ~/.wollipog-data | cat"]) {
    assert.equal(commandTargetsGuardState(command, project, homeState), null, command);
  }
  assert.notEqual(commandTargetsGuardState("ls ~/.wollipog-data/hooks | wc -l", project, homeState), null);
});

test("cd-prefixed copy heredocs classify targets at the new cwd (Refs #1734)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guard-copy-cd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const nested = join(project, "nested");
  const directory = join(root, "data", "hooks");
  mkdirSync(nested, { recursive: true });
  mkdirSync(directory, { recursive: true });
  symlinkSync(directory, join(nested, "alias"), process.platform === "win32" ? "junction" : "dir");
  const judge = (command: string) => commandTargetsGuardState(command, project, directory);
  assert.equal(judge("cd ./nested && cat > notes.txt <<'EOF'\n/ // ${example}\nEOF"), null);
  assert.notEqual(judge("cd ./nested && cat > alias/secret <<'EOF'\nsafe\nEOF"), null);
  assert.notEqual(judge("cd ./nested && cat > notes.txt <<'EOF'\nsafe\nEOF\ncat nested/alias/secret"), null);
});
