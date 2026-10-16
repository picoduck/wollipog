import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claudeProviderPipeHelper, stageClaudeProviderPipeHelper } from "./claude-provider-pipe-helper.js";

test("staged Claude provider pipe worker is executable and rechecked before use", {
  skip: process.platform !== "linux",
  timeout: 40_000,
}, () => {
  const helper = claudeProviderPipeHelper();
  assert.equal(statSync(helper.path).mode & 0o777, 0o700);
  assert.equal(claudeProviderPipeHelper().path, helper.path);
  assert.equal(spawnSync(helper.path, [], { timeout: 5_000 }).status, 125);
  chmodSync(helper.path, 0o600);
  try {
    assert.throws(() => helper.verify(), /changed after staging/);
    assert.throws(() => claudeProviderPipeHelper(), /changed after staging/);
  } finally {
    chmodSync(helper.path, 0o700);
  }
  helper.verify();
});

test("Claude pipe worker falls back when its temporary staging root cannot execute", {
  skip: process.platform !== "linux",
  timeout: 80_000,
}, () => {
  const dataDir = mkdtempSync(join(tmpdir(), "wollipog-claude-pipe-data-"));
  const rejected: string[] = [];
  try {
    const helper = stageClaudeProviderPipeHelper([tmpdir(), dataDir], (path) => {
      rejected.push(path);
      return dirname(dirname(path)) === dataDir;
    });
    assert.equal(rejected.length, 2);
    assert.equal(dirname(dirname(helper.path)), dataDir);
    assert.equal(spawnSync(helper.path, [], { timeout: 5_000 }).status, 125);
    helper.verify();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
