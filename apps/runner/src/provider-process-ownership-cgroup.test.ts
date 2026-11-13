import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerContainmentIdentity, providerContainmentStatus } from "./linux-cgroup.js";
import { ProviderProcessOwnership } from "./provider-process-ownership.js";

test("the bootstrap rehearsal reaches real daemon registration with isolated empty state", { skip: process.platform !== "linux", timeout: 35_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-empty-bootstrap-"));
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx",
      new URL("./fixtures/provider-retirement-bootstrap.mjs", import.meta.url).pathname, root, "unused", "empty"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.match(output, /bootstrap-empty-ready/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [shape, proof] of [["same", "valid"], ["group", "valid"], ["session", "valid"],
  ["session", "inode"], ["session", "user"], ["session", "live-runner"], ["session", "pid-reuse"]]) {
  test(`real runner bootstrap checks ${proof} ownership of a ${shape} descendant before registration`, {
    skip: process.platform !== "linux", timeout: 40_000,
  }, async t => {
    if (!providerContainmentIdentity()) {
      assert.notEqual(process.env.WOLLIPOG_TEST_REQUIRE_CGROUP, "1", "native validation requires delegation");
      t.skip(`containment unavailable: ${providerContainmentStatus().reason}`); return;
    }
    const root = mkdtempSync(join(tmpdir(), "wollipog-owned-bootstrap-"));
    const helper = join(root, "provider");
    const directory = join(root, "runner-data/provider-processes-v1");
    try {
      execFileSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror",
        new URL("../native/fixtures/owned-provider-tree.c", import.meta.url).pathname, "-o", helper], { timeout: 30_000 });
      const output = execFileSync(process.execPath, ["--import", "tsx",
        new URL("./fixtures/provider-retirement-bootstrap.mjs", import.meta.url).pathname, root, helper, shape!, proof!],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
      assert.match(output, ["inode", "user", "live-runner"].includes(proof!) ? /bootstrap-tree-retained/u : /bootstrap-tree-retired/u);
      const manifest = JSON.parse(readFileSync(join(root, "tree.json"), "utf8")) as {
        root: { pid: number }; descendant: { pid: number; pgid: number; sid: number };
      };
      if (shape === "same") assert.equal(manifest.descendant.pgid, manifest.root.pid);
      else assert.equal(manifest.descendant.pgid, manifest.descendant.pid);
      assert.equal(manifest.descendant.sid, shape === "session" ? manifest.descendant.pid : manifest.root.pid);
    } finally {
      if (existsSync(directory)) {
        const records = readdirSync(directory);
        if (records.length && existsSync(join(root, "original-record.json"))) {
          writeFileSync(join(directory, records[0]!), readFileSync(join(root, "original-record.json")));
        }
        await new ProviderProcessOwnership(directory, "runner").recover();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
