import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./verify-runner-release-version.sh", import.meta.url));
const windowsBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const shell = process.platform === "win32" ? windowsBash : "sh";
const haveShell = process.platform !== "win32" || existsSync(windowsBash);

function shellPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/\\/gu, "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
}

test("runner release version verification normalizes source and executable CRLF", {
  skip: haveShell ? false : "requires a POSIX shell",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-runner-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "version.ts");
  const canonical = join(root, "wollipog-runner.exe");
  const legacy = join(root, "agent-manager-runner.exe");
  writeFileSync(source, 'export const VERSION = "1.2.3";\r\n');
  for (const path of [canonical, legacy]) {
    writeFileSync(path, "#!/bin/sh\nprintf '1.2.3\\r\\n'\n");
    chmodSync(path, 0o755);
  }

  const result = spawnSync(shell, [
    shellPath(helper),
    shellPath(source),
    shellPath(canonical),
    shellPath(legacy),
  ], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replace(/\r/gu, ""), "1.2.3\n");

  writeFileSync(legacy, "#!/bin/sh\nprintf '1.2.4\\r\\n'\n");
  chmodSync(legacy, 0o755);
  const mismatch = spawnSync(shell, [
    shellPath(helper),
    shellPath(source),
    shellPath(canonical),
    shellPath(legacy),
  ], { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /expected 1\.2\.3, received 1\.2\.4/u);
});
