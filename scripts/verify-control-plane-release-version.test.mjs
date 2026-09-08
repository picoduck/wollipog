import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./verify-control-plane-release-version.sh", import.meta.url));
const windowsBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const shell = process.platform === "win32" ? windowsBash : "sh";
const haveShell = process.platform !== "win32" || existsSync(windowsBash);

function shellPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/\\/gu, "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
}

test("control-plane release version verification matches APP_RELEASE_VERSION and fails closed", {
  skip: haveShell ? false : "requires a POSIX shell",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-control-plane-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "release-version.ts");
  const binary = join(root, "wollipog-control-plane.exe");
  writeFileSync(source, 'export const APP_RELEASE_VERSION = "1.2.3";\r\n\nexport const RUNNER_RELEASE_TAG = "v1.2.3";\n');
  writeFileSync(binary, "#!/bin/sh\nprintf '1.2.3\\r\\n'\n");
  chmodSync(binary, 0o755);

  const ok = spawnSync(shell, [shellPath(helper), shellPath(source), shellPath(binary)], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), "1.2.3");

  writeFileSync(binary, "#!/bin/sh\nprintf '9.9.9\\n'\n");
  const mismatch = spawnSync(shell, [shellPath(helper), shellPath(source), shellPath(binary)], { encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /control-plane version mismatch: expected 1\.2\.3, received 9\.9\.9/u);

  writeFileSync(binary, "#!/bin/sh\nprintf '1.2.3\\n'\nexit 1\n");
  const failing = spawnSync(shell, [shellPath(helper), shellPath(source), shellPath(binary)], { encoding: "utf8" });
  assert.notEqual(failing.status, 0, "a binary that prints the version but exits non-zero must fail the gate");
  assert.match(failing.stderr, /failed to report its version/u);

  const missing = spawnSync(shell, [shellPath(helper), shellPath(source), shellPath(join(root, "absent"))], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /control-plane binary is missing/u);
});
