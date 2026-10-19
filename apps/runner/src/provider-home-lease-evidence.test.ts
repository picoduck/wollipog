import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  currentLeaseProcessEvidence, currentProviderHomeRunnerMarker, isLeaseProcessEvidence, linuxLeaseProcessProbe,
  PROVIDER_HOME_RUNNER_MARKER_ENV, proveLeaseAbandoned, providerHomeRunnerMarker, type LeaseProcessProbe,
} from "./provider-home-lease-evidence.js";

const BOOT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_BOOT = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const MARKER = "0123456789abcdef0123456789abcdef";
const OTHER_MARKER = "fedcba9876543210fedcba9876543210";
const UID = 1000;

function fakeProc(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-lease-evidence-proc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
  writeFileSync(join(root, "sys/kernel/random/boot_id"), `${BOOT}\n`);
  const add = (pid: number, options: { uid?: [number, number]; env?: string[]; start?: string; command?: string; environ?: "directory"; state?: string; ppid?: number }) => {
    const dir = join(root, String(pid));
    mkdirSync(dir);
    const [real, effective] = options.uid ?? [UID, UID];
    writeFileSync(join(dir, "status"), `Name:\tx\nUid:\t${real}\t${effective}\t${effective}\t${effective}\n`);
    const fields = [options.state ?? "S", String(options.ppid ?? 1), ...Array.from({ length: 17 }, () => "0"), options.start ?? "4242", "0"];
    writeFileSync(join(dir, "stat"), `${pid} (${options.command ?? "node"}) ${fields.join(" ")}\n`);
    if (options.environ === "directory") mkdirSync(join(dir, "environ"));
    else writeFileSync(join(dir, "environ"), Buffer.from((options.env ?? []).map((entry) => `${entry}\0`).join("")));
  };
  return { root, add };
}

test("the Linux probe reads the boot, start times with spaced command names, and marked processes", { skip: process.platform !== "linux" }, (t) => {
  const proc = fakeProc(t);
  proc.add(101, { start: "777", command: "node (runner) x" });
  proc.add(201, { env: ["PATH=/bin", `${PROVIDER_HOME_RUNNER_MARKER_ENV}=${MARKER}`] });
  proc.add(202, { env: [`${PROVIDER_HOME_RUNNER_MARKER_ENV}=${OTHER_MARKER}`] });
  proc.add(203, { env: [`${PROVIDER_HOME_RUNNER_MARKER_ENV}=${MARKER}`], uid: [0, 0] });
  proc.add(204, { uid: [UID, 0] });
  proc.add(205, { environ: "directory" });
  proc.add(206, { environ: "directory", state: "Z" });
  proc.add(207, { environ: "directory", ppid: 208 });
  proc.add(208, { environ: "directory", ppid: 300 });
  proc.add(209, { environ: "directory", ppid: 999 });
  proc.add(300, { env: [`${PROVIDER_HOME_RUNNER_MARKER_ENV}=${MARKER}`] });
  const probe = linuxLeaseProcessProbe(proc.root, UID, 300)!;
  assert.equal(probe.bootId(), BOOT);
  assert.equal(probe.startTime(101), "777");
  assert.equal(probe.startTime(999), null, "a missing process has no start time");
  assert.deepEqual(probe.scan(MARKER, "100"), {
    marked: [201],
    // A set-id process (204) keeps our real uid but hides its environment, and a non-dumpable one
    // (205) hides it too: hidden is never unmarked. Skipped: another user's process (203), a zombie
    // (206), descendants of the scanning runner (207, 208), and the scanner itself (300). A process
    // whose ancestry cannot be read (209) stays uninspectable.
    uninspectable: [204, 205, 209],
  });
  assert.deepEqual(probe.scan(MARKER, "5000"), { marked: [201], uninspectable: [] },
    "processes that started before the recorded runner cannot descend from it");
});

test("the real procfs probe finds a live marked process and stops finding it once it exits", { skip: process.platform !== "linux" }, async (t) => {
  const marker = randomBytes(16).toString("hex");
  const child = spawn("sleep", ["30"], { env: { ...process.env, [PROVIDER_HOME_RUNNER_MARKER_ENV]: marker }, stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); });
  await once(child, "spawn");
  const probe = linuxLeaseProcessProbe()!;
  assert.match(probe.bootId(), /^[0-9a-f-]{36}$/u);
  assert.match(probe.startTime(process.pid) ?? "", /^[1-9][0-9]*$/u);
  assert.ok(probe.scan(marker, "1").marked.includes(child.pid!), "the marked child is found");
  assert.equal(proveLeaseAbandoned({ bootId: probe.bootId(), startTime: "1", marker }, 2_147_483_646, probe).proven, false);
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.ok(!probe.scan(marker, "1").marked.includes(child.pid!), "an exited process no longer carries the marker");
});

test("this runner's evidence needs a probe, a valid marker, and its own start time", () => {
  const probe: LeaseProcessProbe = { bootId: () => BOOT, startTime: (pid) => pid === 101 ? "777" : null, scan: () => ({ marked: [], uninspectable: [] }) };
  assert.deepEqual(currentLeaseProcessEvidence(probe, 101, MARKER), { bootId: BOOT, startTime: "777", marker: MARKER });
  assert.equal(currentLeaseProcessEvidence(undefined, 101, MARKER), undefined, "no probe, no evidence (other platforms)");
  assert.equal(currentLeaseProcessEvidence(probe, 101, undefined), undefined, "no marker, no evidence");
  assert.equal(currentLeaseProcessEvidence(probe, 101, "not-a-marker"), undefined);
  assert.equal(currentLeaseProcessEvidence(probe, 102, MARKER), undefined, "an unknown process records nothing");
  assert.equal(currentLeaseProcessEvidence({ ...probe, bootId: () => { throw new Error("no boot id"); } }, 101, MARKER), undefined);
  assert.ok(isLeaseProcessEvidence({ bootId: BOOT, startTime: "777", marker: MARKER }));
  for (const bad of [null, [], { bootId: BOOT, startTime: "777" }, { bootId: "x", startTime: "777", marker: MARKER },
    { bootId: BOOT, startTime: "0", marker: MARKER }, { bootId: BOOT, startTime: "777", marker: MARKER, extra: 1 }]) {
    assert.equal(isLeaseProcessEvidence(bad), false, JSON.stringify(bad));
  }
});

test("abandonment is proved by a reboot or a clean same-boot scan, never by a dead PID alone", () => {
  const evidence = { bootId: BOOT, startTime: "777", marker: MARKER };
  const probe = (overrides: Partial<LeaseProcessProbe> = {}): LeaseProcessProbe => ({
    bootId: () => BOOT, startTime: () => null, scan: () => ({ marked: [], uninspectable: [] }), ...overrides,
  });
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ bootId: () => OTHER_BOOT, startTime: () => "777" })),
    { proven: true, proof: "reboot" }, "a new boot ends every process of the old one");
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe()), { proven: true, proof: "process_scan" });
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ startTime: () => "777" })), { proven: false, reason: "runner_alive" });
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ startTime: () => "778" })), { proven: true, proof: "process_scan" },
    "a reused PID with another start time is not the recorded runner");
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ scan: () => ({ marked: [5], uninspectable: [] }) })),
    { proven: false, reason: "marked_process" }, "a surviving descendant blocks the handoff");
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ scan: () => ({ marked: [], uninspectable: [6] }) })),
    { proven: false, reason: "uninspectable" });
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ scan: () => { throw new Error("EACCES"); } })),
    { proven: false, reason: "uninspectable" });
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, undefined), { proven: false, reason: "uninspectable" });
  let checks = 0;
  assert.deepEqual(proveLeaseAbandoned(evidence, 101, probe({ startTime: () => (++checks === 2 ? "777" : null) })),
    { proven: false, reason: "runner_alive" }, "the recorded runner is checked again after the scan");
});

test("the runner marker is created once and replaces an inherited value in the environment", () => {
  const before = process.env[PROVIDER_HOME_RUNNER_MARKER_ENV];
  const first = currentProviderHomeRunnerMarker();
  try {
    if (!first) process.env[PROVIDER_HOME_RUNNER_MARKER_ENV] = OTHER_MARKER;
    const marker = providerHomeRunnerMarker();
    assert.match(marker, /^[0-9a-f]{32}$/u);
    assert.equal(providerHomeRunnerMarker(), marker);
    assert.equal(currentProviderHomeRunnerMarker(), marker);
    assert.equal(process.env[PROVIDER_HOME_RUNNER_MARKER_ENV], marker, "launches inherit this runner's marker, not a predecessor's");
    if (!first) assert.notEqual(marker, OTHER_MARKER);
  } finally {
    if (!first) {
      if (before === undefined) delete process.env[PROVIDER_HOME_RUNNER_MARKER_ENV];
      else process.env[PROVIDER_HOME_RUNNER_MARKER_ENV] = before;
    }
  }
});
