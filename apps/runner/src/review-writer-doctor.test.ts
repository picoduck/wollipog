import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseReviewWriterDoctorArgs, runReviewWriterDoctor } from "./review-writer-doctor.js";
import { ReviewWriterRegistry } from "./review-writers.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";

test("the admin parser rejects ambiguous targets and requires an exact inspected digest", () => {
  for (const args of [[], ["force"], ["inspect"], ["inspect", "--data-dir", "/tmp", "--record-id", "a"],
    ["retire-legacy", "--data-dir", "/tmp"], ["inspect", "--data-dir", "/tmp", "--data-dir", "/tmp"],
    ["retire-legacy", "--data-dir", "/tmp", "--record-id", "../a", "--sha256", "a".repeat(64)]]) {
    assert.throws(() => parseReviewWriterDoctorArgs(args));
  }
  assert.equal(parseReviewWriterDoctorArgs(["inspect", "--data-dir", "/tmp"]).command, "inspect");
});

test("the admin command inspects without retiring, reports every blocker, and retires only exact proven legacy evidence", { skip: process.getuid === undefined }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-writer-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const view: LeaseProcessProbe = { bootId: () => "12345678-1234-1234-1234-123456789abc", startTime: () => "100",
    scan: () => ({ marked: [], uninspectable: [] }) };
  new ReviewWriterRegistry(dir, view, { createGroup: () => undefined }).acquire("s_legacy", "provider");
  let blocked = true;
  const blockers = [{ pid: 42, startTime: "101", command: "sshd", reason: "uninspectable" as const }];
  const registry = new ReviewWriterRegistry(dir, { ...view, startTime: () => null,
    scan: () => blocked ? { marked: [], uninspectable: [42], blockers } : { marked: [], uninspectable: [] },
  }, { reconcile: false });
  let output = "";
  const write = (text: string) => { output += text; };
  runReviewWriterDoctor({ command: "inspect", dataDir: dir }, write, registry);
  const row = JSON.parse(output).writers[0];
  assert.equal(registry.sessions().length, 1);
  output = "";
  const args = { command: "retire-legacy" as const, dataDir: dir, recordId: row.recordId, sha256: row.sha256 };
  assert.throws(() => runReviewWriterDoctor(args, write, registry), /uninspectable/);
  assert.deepEqual(JSON.parse(output).blockers, blockers);
  assert.match(JSON.parse(output).guidance, /Stop the runner first/);
  output = ""; blocked = false;
  runReviewWriterDoctor(args, write, registry);
  assert.deepEqual(JSON.parse(output), { retired: true, reason: "process_scan" });
  assert.deepEqual(registry.sessions(), []);
});
