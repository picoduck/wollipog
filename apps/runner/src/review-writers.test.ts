import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { ReviewWriterRegistry } from "./review-writers.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";
import type { LinuxCgroupGroup } from "./linux-cgroup.js";

const bootId = "12345678-1234-1234-1234-123456789abc";
const containment = { kind: "linux-cgroup-v2", bootId, mountRoot: "/", cgroupPath: "runner.service/writer", inode: "123" } as const;
function probe(overrides: Partial<LeaseProcessProbe> = {}): LeaseProcessProbe {
  return { bootId: () => bootId, startTime: () => "100", scan: () => ({ marked: [], uninspectable: [] }), ...overrides };
}
function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-review-writers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function uncontained(dir: string, view = probe()) {
  return new ReviewWriterRegistry(dir, view, { createGroup: () => undefined });
}
function marker(dir: string) {
  const file = join(dir, readdirSync(dir)[0]!);
  return { file, record: JSON.parse(readFileSync(file, "utf8")) };
}
function contained(dir: string, view: LeaseProcessProbe, group: LinuxCgroupGroup = {
  identity: containment, run: (work) => work(), releaseIfEmpty: () => true,
}) { return new ReviewWriterRegistry(dir, view, { createGroup: () => group }); }

test("each provider or TUI writer keeps its own durable proof obligation", (t) => {
  const dir = directory(t), registry = uncontained(dir);
  const provider = registry.acquire("s_writer", "provider"), tui = registry.acquire("s_writer", "agent_tui");
  assert.equal(readdirSync(dir).length, 2);
  assert.deepEqual(registry.sessions(), ["s_writer"]);
  assert.equal(registry.retire(provider, false), false);
  assert.equal(registry.retire(provider, true), true);
  assert.deepEqual(registry.sessions("provider"), []);
  assert.deepEqual(uncontained(dir).sessions(), ["s_writer"]);
  assert.equal(registry.retire(tui, true), true);
  assert.deepEqual(uncontained(dir).sessions(), []);
});

test("acquire persists the exact writer parent before launch and live exit requires its empty boundary", (t) => {
  const dir = directory(t);
  let state: "populated" | "empty" = "populated", released = 0;
  const registry = contained(dir, probe({ containment: () => state, scan: () => { throw new Error("unrelated unreadable process"); } }), {
    identity: containment, run: (work) => { assert.deepEqual(marker(dir).record.process.containment, containment); return work(); },
    releaseIfEmpty: () => { assert.deepEqual(readdirSync(dir), []); released++; return true; },
  });
  const id = registry.acquire("s_contained", "provider");
  assert.equal(marker(dir).record.process.version, 2);
  assert.equal(marker(dir).record.runnerPid, process.pid);
  assert.equal(registry.group(id)!.run(() => 42), 42);
  assert.equal(registry.retire(id, true), false, "root exit cannot settle surviving descendants");
  state = "empty";
  assert.equal(registry.retire(id, false), false, "empty-before-admission is not a live exit proof");
  assert.equal(registry.retire(id, true), true);
  assert.equal(released, 1);
});

for (const state of ["empty", "unit_removed"] as const) test(`startup retires a ${state} writer boundary despite unrelated unreadable processes`, (t) => {
  const dir = directory(t);
  contained(dir, probe()).acquire("s_contained", "agent_tui");
  for (const blocked of ["populated", "unverifiable"] as const) {
    assert.deepEqual(uncontained(dir, probe({ startTime: () => null, containment: () => blocked,
      scan: () => { throw new Error("must not scan"); },
    })).sessions(), ["s_contained"]);
  }
  let live = true;
  const recovered = uncontained(dir, probe({ startTime: () => live ? "100" : null, containment: () => state,
    scan: () => { throw new Error("must not scan"); },
  }));
  assert.deepEqual(recovered.sessions(), ["s_contained"]);
  live = false;
  recovered.reconcileRecovered();
  assert.deepEqual(recovered.sessions(), []);
  assert.deepEqual(readdirSync(dir), []);
});

test("legacy evidence stays blocked automatically and only explicit exact admin proof retires it", (t) => {
  const dir = directory(t); uncontained(dir).acquire("s_legacy", "provider");
  const { file, record } = marker(dir);
  delete record.process.version; delete record.process.containment;
  writeFileSync(file, JSON.stringify(record));
  for (const view of [probe({ startTime: () => null }), probe({ bootId: () => "87654321-4321-4321-4321-cba987654321" })]) {
    const recovered = uncontained(dir, view); recovered.reconcileRecovered();
    assert.deepEqual(recovered.sessions(), ["s_legacy"]);
  }
  const refused = [probe(), probe({ startTime: () => null, scan: () => ({ marked: [42], uninspectable: [] }) }),
    probe({ startTime: () => "101", scan: () => ({ marked: [], uninspectable: [43] }) }),
    probe({ startTime: () => { throw new Error("unreadable stat"); } }),
    probe({ startTime: () => null, scan: () => { throw new Error("unreadable table"); } })];
  for (const view of refused) {
    const recovered = uncontained(dir, view), row = recovered.inspect()[0]!;
    assert.equal(recovered.retireLegacy(row.recordId, row.sha256!).retired, false);
  }
  const recovered = uncontained(dir, probe({ startTime: () => "101" })), row = recovered.inspect()[0]!;
  assert.equal(recovered.retireLegacy(row.recordId, "0".repeat(64)).retired, false);
  writeFileSync(file, JSON.stringify({ ...record, sessionId: "replacement" }));
  assert.deepEqual(recovered.retireLegacy(row.recordId, row.sha256!), { retired: false, reason: "record_changed" });
  writeFileSync(file, JSON.stringify(record));
  assert.deepEqual(recovered.retireLegacy(row.recordId, row.sha256!), { retired: true, reason: "process_scan" });
});

test("a proven current writer retries retirement after temporary boundary uncertainty, while unproved writers remain", (t) => {
  const dir = directory(t);
  let empty = false;
  const registry = contained(dir, probe({ containment: () => empty ? "empty" : "unverifiable" }));
  const proven = registry.acquire("s_proven", "provider");
  registry.acquire("s_not_proven", "provider");
  assert.equal(registry.retire(proven, true), false);
  empty = true;
  registry.reconcileRecovered("admission");
  assert.deepEqual(registry.sessions(), ["s_not_proven"]);
});

test("unknown identity recovery does not promise that legacy administration can retire it", (t) => {
  const dir = directory(t);
  writeFileSync(join(dir, "unknown.json"), JSON.stringify({ sessionId: "s_unknown", kind: "provider" }));
  const row = uncontained(dir).inspect()[0]!;
  assert.match(row.recovery, /independent operator investigation/);
  assert.doesNotMatch(row.recovery, /then retire-legacy/);
});

test("a live writer keeps exact-exit recovery guidance when kernel identity is unreadable", (t) => {
  const registry = uncontained(directory(t), probe({ bootId: () => { throw new Error("unreadable"); } }));
  registry.acquire("s_live", "provider");
  const row = registry.inspect()[0]!;
  assert.match(row.recovery, /End this writer's complete process tree; exact exit settlement/);
  assert.match(row.recovery, /independent operator investigation/);
  assert.doesNotMatch(row.recovery, /then retire-legacy/);
});

test("remote writer recovery never suggests host cgroup delegation", (t) => {
  const dir = directory(t), registry = uncontained(dir);
  registry.acquire("s_remote", "provider", false);
  assert.match(registry.inspect()[0]!.recovery, /execution target/);
  assert.doesNotMatch(registry.inspect()[0]!.recovery, /delegat|Delegate=yes/);
  const recovered = uncontained(dir, probe({ startTime: () => "101" }));
  assert.doesNotMatch(recovered.inspect()[0]!.recovery, /delegat|Delegate=yes/);
});

test("unsandboxed observations never acquire durable obligations and retire only their exact launch", (t) => {
  const dir = directory(t), registry = uncontained(dir);
  const first = registry.observeUnsandboxed("s_live", "provider");
  const second = registry.observeUnsandboxed("s_live", "provider");
  registry.observeUnsandboxed("s_live", "agent_tui");
  assert.deepEqual(registry.sessions(), []);
  assert.deepEqual(registry.inspect(), []);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(registry.retire(first, false), false);
  assert.equal(registry.retire(first, true), true);
  assert.equal(registry.unsandboxedSessions().length, 2, "another provider instance still lives");
  registry.retire(second, true);
  assert.deepEqual(registry.unsandboxedSessions(), [{ sessionId: "s_live", kind: "agent_tui" }]);
});

test("legacy administration reports all blocking identities from the proof's same scan", (t) => {
  const dir = directory(t); uncontained(dir).acquire("s_legacy", "provider");
  const blockers = [{ pid: 42, startTime: "101", command: "provider", reason: "marked" as const },
    { pid: 43, startTime: "102", command: "sshd", reason: "uninspectable" as const }];
  let scans = 0;
  const registry = uncontained(dir, probe({ startTime: () => null, scan: () => {
    scans++; return { marked: [42], uninspectable: [43], blockers };
  } }));
  const row = registry.inspect()[0]!;
  assert.deepEqual(registry.retireLegacy(row.recordId, row.sha256!), { retired: false, reason: "marked_process", blockers });
  assert.equal(scans, 1);
});

test("malformed, partial and missing identity records never acquire retirement authority", (t) => {
  const dir = directory(t); uncontained(dir).acquire("s_template", "provider");
  const { file, record } = marker(dir); rmSync(file);
  const invalid = ["{", "null", "[]", "42", JSON.stringify({ sessionId: "legacy", kind: "provider" }),
    JSON.stringify({ ...record, runnerPid: 0 }), JSON.stringify({ ...record, kind: "unknown" }),
    JSON.stringify({ ...record, process: { ...record.process, startTime: "" } }),
    JSON.stringify({ ...record, process: { ...record.process, marker: null } })];
  invalid.forEach((value, index) => writeFileSync(join(dir, `${index}.json`), value));
  const registry = uncontained(dir, probe({ bootId: () => "87654321-4321-4321-4321-cba987654321" }));
  for (const row of registry.inspect()) assert.equal(registry.retireLegacy(row.recordId, row.sha256 ?? "0".repeat(64)).retired, false);
  assert.equal(readdirSync(dir).length, invalid.length);
  uncontained(dir, probe({ bootId: () => { throw new Error("unavailable"); } })).acquire("s_no_identity", "provider");
  assert.ok(uncontained(dir).sessions().includes("s_no_identity"));
});

test("a launch interrupted after publication keeps real kernel identity for explicit recovery", { skip: process.platform !== "linux" }, (t) => {
  const dir = directory(t), module = new URL("./review-writers.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import { ReviewWriterRegistry } from ${JSON.stringify(module)}; new ReviewWriterRegistry(${JSON.stringify(dir)}, undefined, {createGroup: () => undefined}).acquire("s_interrupted", "provider");`]);
  const { record } = marker(dir);
  assert.notEqual(record.runnerPid, process.pid);
  assert.match(record.process.startTime, /^[1-9][0-9]*$/u);
  assert.throws(() => process.kill(record.runnerPid, 0), { code: "ESRCH" });
  const recovered = uncontained(dir, probe({ bootId: () => record.process.bootId, startTime: () => null }));
  const row = recovered.inspect()[0]!;
  assert.equal(row.state, "previous_runner");
  assert.equal(recovered.retireLegacy(row.recordId, row.sha256!).retired, true);
});
