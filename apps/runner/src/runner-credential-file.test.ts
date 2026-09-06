import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRunnerCredentialFile, sweepConductorMcpConfigs, writeRunnerCredentialFile } from "./runner-credential-file.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-credentials-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("runner credential file is mode 600 and startup sweep removes legacy conductor configs", () => {
  withTempDir((dir) => {
    const credential = writeRunnerCredentialFile(dir, "opaque-runner-token");
    assert.equal(readFileSync(credential, "utf8"), "opaque-runner-token");
    if (process.platform !== "win32") assert.equal(statSync(credential).mode & 0o777, 0o600);

    const configs = join(dir, "conductor");
    mkdirSync(configs);
    writeFileSync(join(dir, "keep.txt"), "keep");
    const first = join(configs, "old.mcp.json");
    const second = join(configs, "new.mcp.json");
    writeFileSync(first, '{"MANAGER_TOKEN":"legacy"}');
    writeFileSync(second, "{}", { mode: 0o600 });
    assert.equal(sweepConductorMcpConfigs(configs), 2);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    assert.equal(existsSync(join(dir, "keep.txt")), true);
  });
});

test("pending runner rotation preserves the active conductor token until acknowledged cutover", () => {
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
