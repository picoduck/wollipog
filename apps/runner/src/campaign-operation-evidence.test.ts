import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { campaignOperationEvidence, campaignOperationEvidenceCurrent } from "./campaign-operation-evidence.js";

test("canonical operation evidence rejects dangling links and catches a replaced target without reading contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-operation-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/auth.ts"), "fixture\n");
    const link = join(directory, "src/link.ts");
    symlinkSync(join(directory, "src/auth.ts"), link);
    const evidence = campaignOperationEvidence("Read", { kind: "file", path: link });
    assert.equal(evidence.filesystem?.targets[0]?.resolvedPath, join(directory, "src/auth.ts"));
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), true);
    unlinkSync(link); symlinkSync(join(directory, "absent.ts"), link);
    assert.equal(campaignOperationEvidence("Read", { kind: "file", path: link }).filesystem, undefined);
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), false);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "git status --short", cwd: join(directory, "missing") }).filesystem, undefined);
    assert.equal(campaignOperationEvidence("Write", { kind: "file", path: join(directory, "src/new.ts") }).filesystem?.targets[0]?.resolvedPath, join(directory, "src/new.ts"));
    assert.equal(campaignOperationEvidence("Unknown", { kind: "file", path: link, filesystem: { targets: [{ path: link, resolvedPath: link }] } }).filesystem, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
