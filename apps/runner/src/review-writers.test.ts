import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReviewWriterRegistry } from "./review-writers.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";

const bootId = "12345678-1234-1234-1234-123456789abc";
function probe(overrides: Partial<LeaseProcessProbe> = {}): LeaseProcessProbe {
  return {
    bootId: () => bootId,
    startTime: () => "100",
    scan: () => ({ marked: [], uninspectable: [] }),
    ...overrides,
  };
}

function marker(directory: string) {
  const name = readdirSync(directory)[0]!;
  return { file: join(directory, name), record: JSON.parse(readFileSync(join(directory, name), "utf8")) };
}

test("each provider or TUI writer keeps its own durable proof obligation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-review-writers-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new ReviewWriterRegistry(directory);
  const provider = registry.acquire("s_writer", "provider");
  const tui = registry.acquire("s_writer", "agent_tui");
  assert.equal(readdirSync(directory).length, 2);
  assert.deepEqual(registry.sessions(), ["s_writer"]);
  assert.equal(registry.retire(provider, false), false);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions("provider"), ["s_writer"]);
  assert.equal(registry.retire(provider, true), true);
  assert.deepEqual(registry.sessions("provider"), []);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions(), ["s_writer"]);
  assert.equal(registry.retire(tui, true), true);
  assert.deepEqual(new ReviewWriterRegistry(directory).sessions(), []);
});

test("startup retires a recovered writer only with complete runner-wide exit proof", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-writer-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ReviewWriterRegistry(directory, probe()).acquire("s_writer", "provider");
  const { record } = marker(directory);
  assert.equal(record.runnerPid, process.pid);
  assert.equal(record.process.bootId, bootId);
  assert.equal(record.process.startTime, "100");
  assert.match(record.process.marker, /^[0-9a-f]{32}$/u);

  const refused = [
    probe(), // the exact runner is still live, even if no marked child was found
    probe({ startTime: () => null, scan: () => ({ marked: [42], uninspectable: [] }) }),
    probe({ startTime: () => "101", scan: () => ({ marked: [], uninspectable: [43] }) }),
    probe({ startTime: () => { throw new Error("unreadable stat"); } }),
    probe({ startTime: () => null, scan: () => { throw new Error("unreadable process table"); } }),
  ];
  for (const view of refused) {
    assert.deepEqual(new ReviewWriterRegistry(directory, view).sessions(), ["s_writer"]);
    assert.equal(readdirSync(directory).length, 1);
  }
  let scans = 0;
  const registry = new ReviewWriterRegistry(directory, probe({
    startTime: () => "101", // PID reuse alone is insufficient; the scan is also required.
    scan: (inherited, start) => {
      scans++;
      assert.equal(inherited, record.process.marker);
      assert.equal(start, "100");
      return { marked: [], uninspectable: [] };
    },
  }));
  assert.equal(scans, 1);
  assert.deepEqual(registry.sessions(), []);
  assert.deepEqual(readdirSync(directory), []);
});

test("a later reconciliation and a proven different kernel boot can retire recovered markers", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-writer-later-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ReviewWriterRegistry(directory, probe()).acquire("s_writer", "agent_tui");
  let live = true;
  const recovered = new ReviewWriterRegistry(directory, probe({ startTime: () => live ? "100" : null }));
  assert.deepEqual(recovered.sessions(), ["s_writer"]);
  live = false;
  recovered.reconcileRecovered();
  assert.deepEqual(recovered.sessions(), []);

  new ReviewWriterRegistry(directory, probe()).acquire("s_reboot", "provider");
  const rebooted = new ReviewWriterRegistry(directory, probe({
    bootId: () => "87654321-4321-4321-4321-cba987654321",
    startTime: () => { throw new Error("must not inspect a PID from another boot"); },
  }));
  assert.deepEqual(rebooted.sessions(), []);
});

test("legacy, malformed, partial and unsupported evidence stays fail-closed even after reboot", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-writer-malformed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  new ReviewWriterRegistry(directory, probe()).acquire("s_template", "provider");
  const { file, record } = marker(directory);
  rmSync(file);
  const invalid = [
    "{", "null", "[]", "42", JSON.stringify({ sessionId: "legacy", kind: "provider" }),
    JSON.stringify({ ...record, runnerPid: 0 }),
    JSON.stringify({ ...record, runnerPid: "42" }),
    JSON.stringify({ ...record, kind: "unknown" }),
    JSON.stringify({ ...record, process: { ...record.process, startTime: "" } }),
    JSON.stringify({ ...record, process: { ...record.process, marker: null } }),
    JSON.stringify({ ...record, process: { ...record.process, bootId: "" } }),
  ];
  invalid.forEach((text, index) => writeFileSync(join(directory, `${index}.json`), text));
  const recovered = new ReviewWriterRegistry(directory, probe({ bootId: () => "87654321-4321-4321-4321-cba987654321" }));
  assert.ok(recovered.sessions().length > 0);
  assert.equal(readdirSync(directory).length, invalid.length);
  recovered.reconcileRecovered();
  assert.equal(readdirSync(directory).length, invalid.length);

  // A failed identity capture must not prevent the pre-spawn marker from being written.
  const unavailable = new ReviewWriterRegistry(directory, probe({ bootId: () => { throw new Error("unavailable"); } }));
  unavailable.acquire("s_no_identity", "provider");
  assert.equal(readdirSync(directory).length, invalid.length + 1);
  assert.ok(new ReviewWriterRegistry(directory, probe()).sessions().includes("s_no_identity"));
});

test("a launch interrupted after marker publication leaves real kernel identity for recovery", { skip: process.platform !== "linux" }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-writer-launch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = new URL("./review-writers.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { ReviewWriterRegistry } from ${JSON.stringify(module)}; new ReviewWriterRegistry(${JSON.stringify(directory)}).acquire("s_interrupted", "provider");`,
  ]);
  const { record } = marker(directory);
  assert.notEqual(record.runnerPid, process.pid);
  assert.match(record.process.startTime, /^[1-9][0-9]*$/u);
  assert.match(record.process.bootId, /^[0-9a-f-]{36}$/u);
  assert.throws(() => process.kill(record.runnerPid, 0), { code: "ESRCH" });
  // Deterministic scan seam: host-wide unreadable processes may legitimately refuse a live scan.
  const recovered = new ReviewWriterRegistry(directory, probe({
    bootId: () => record.process.bootId, startTime: () => null,
    scan: (value) => { assert.equal(value, record.process.marker); return { marked: [], uninspectable: [] }; },
  }));
  assert.deepEqual(recovered.sessions(), []);
});
