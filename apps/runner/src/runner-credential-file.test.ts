import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRunnerCredentialFile, writeRunnerCredentialFile } from "./runner-credential-file.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-credentials-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("runner credential file is mode 600", () => {
  withTempDir((dir) => {
    const credential = writeRunnerCredentialFile(dir, "opaque-runner-token");
    assert.equal(readFileSync(credential, "utf8"), "opaque-runner-token");
    if (process.platform !== "win32") assert.equal(statSync(credential).mode & 0o777, 0o600);
  });
});

test("pending runner rotation preserves the active runner token until acknowledged cutover", () => {
  withTempDir((dir) => {
    const active = writeRunnerCredentialFile(dir, "opaque-active-token");
    const retried = stageRunnerCredentialFile(dir, "opaque-retried-token");
    assert.equal(retried.activePath, active);
    assert.equal(readFileSync(active, "utf8"), "opaque-active-token");
    assert.equal(readFileSync(active, "utf8"), "opaque-active-token", "transient rejection must preserve the working token");
    assert.equal(retried.promote(), active, "the same staged token remains promotable after reconnect");
    assert.equal(readFileSync(active, "utf8"), "opaque-retried-token");

    const accepted = stageRunnerCredentialFile(dir, "opaque-accepted-token");
    assert.equal(readFileSync(active, "utf8"), "opaque-retried-token", "staging must not publish a pending token");
    assert.equal(accepted.promote(), active);
    assert.equal(readFileSync(active, "utf8"), "opaque-accepted-token");
    assert.equal(accepted.promote(), active, "the registered acknowledgement may be replayed safely");
  });
});
