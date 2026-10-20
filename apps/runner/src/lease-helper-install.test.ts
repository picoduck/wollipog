import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runnerAssociationDigest } from "./lease-helper-install.js";

test("runner association accepts only the complete known installer alias set", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-runner-association-"));
  try {
    const executable = join(root, "wollipog-runner"), signal = new AbortController().signal;
    const bytes = Buffer.from("owned runner fixture"); writeFileSync(executable, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(await runnerAssociationDigest(executable, signal), expected);
    const legacy = join(root, "agent-manager-runner"), cli = join(root, "wollipog");
    linkSync(executable, legacy); linkSync(executable, cli);
    for (const path of [executable, legacy, cli]) assert.equal(await runnerAssociationDigest(path, signal), expected);
    const foreign = join(root, "unrecognized"); linkSync(executable, foreign);
    await assert.rejects(runnerAssociationDigest(executable, signal), /unproved runner hardlinks/u);
    assert.deepEqual(readFileSync(foreign), bytes);
    const symbolic = join(root, "symbolic"); symlinkSync(executable, symbolic);
    await assert.rejects(runnerAssociationDigest(symbolic, signal), /identity unavailable/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
