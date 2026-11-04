import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { commandTargetsGuardState } from "./managed-worktree-protection.js";

test("inert builtins and copy-only heredocs allow ancestors without opening state (Refs #1734)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guard-1734-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const state = join(root, "data", "hooks");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(state, { recursive: true });
  const alias = join(cwd, "alias");
  symlinkSync(state, alias, process.platform === "win32" ? "junction" : "dir");
  const judge = (command: string) => commandTargetsGuardState(command, cwd, state);
  for (const command of ["true /", "false //", ": /", "printf '%s\\n' //", "printf '%s' ~"]) {
    assert.equal(judge(command), null, command);
  }
  for (const path of [state, relative(cwd, state), "alias", "'alias'", "a\\lias"]) {
    for (const prefix of ["true", "false", ":", "printf '%s\\n'"]) {
      const command = `${prefix} ${path}`;
      assert.notEqual(judge(command), null, command);
    }
  }
  for (const prefix of ["true", ":", "printf '%s\\n'"]) {
    assert.notEqual(commandTargetsGuardState(`${prefix} ~/.wollipog/hooks/secret`, cwd,
      join(homedir(), ".wollipog", "hooks")), null);
  }
  for (const operator of ["<<", "<<-"]) {
    const body = `/ // \${spec.sessionId}\n${state}`;
    assert.equal(judge(`cat ${operator}'EOF'\n${body}\n\tEOF`.replace("\tEOF", operator === "<<-" ? "\tEOF" : "EOF")), null);
    assert.equal(judge(`cat > out.txt ${operator}'EOF'\n${body}\nEOF`), null);
    for (const path of [state, "alias", relative(cwd, state)]) {
      assert.notEqual(judge(`cat > ${path}/out ${operator}'EOF'\n${body}\nEOF`), null);
      assert.notEqual(judge(`cat ${operator}'EOF'\n${body}\nEOF\ncat ${path}/secret`), null);
    }
  }
  for (const command of [
    "printf -v 'arr[$(cat alias/secret)]' /", "printf '%b' /", "true $(cat alias/secret) /",
    "cat <<'EOF' > >(bash)\ncat alias/secret\nEOF",
    "cat <<-'EOF'\n\tEOF\ncat alias/secret",
    `python3 - <<'PY'\nopen('${state}/secret').read()\nPY`,
    "node - <<'EOF'\nrequire('fs').readFileSync('alias/secret')\nEOF",
  ]) assert.notEqual(judge(command), null, command);
});
