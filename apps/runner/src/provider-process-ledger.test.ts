import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { gracefulNamespaceExit } from "./claude-namespace-session.js";
import { ProviderProcessLedger, spawnAgent, type AgentProcess } from "./spawn.js";

const posixOnly = { skip: process.platform === "win32", timeout: 20_000 };

async function closed(child: AgentProcess): Promise<void> {
  if (child.closeObserved) return;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a finished provider process with no descendants proves its tree gone", posixOnly, async () => {
  const ledger = new ProviderProcessLedger();
  const child = ledger.record(spawnAgent({
    command: process.execPath, args: ["-e", "process.exit(0)"], cwd: os.tmpdir(),
    windowsShell: false, descendantOwner: ledger.owner,
  }));
  child.stdin.end();
  await closed(child);
  assert.equal(await ledger.prove({ terminate: false }), true);
  assert.throws(() => ledger.assertOpen(), /already ended/, "a proven instance cannot start more processes");
});

test("background work left by an exited provider fails the non-killing proof and is ended by the killing one", posixOnly, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wollipog-ledger-background-"));
  const ready = path.join(dir, "ready.json");
  const background = path.join(dir, "background.cjs");
  const provider = path.join(dir, "provider.cjs");
  let backgroundPid: number | undefined;
  t.after(async () => {
    if (backgroundPid && alive(backgroundPid)) process.kill(backgroundPid, "SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(background, [
    'require("node:fs").writeFileSync(' + JSON.stringify(ready) + ", JSON.stringify({ pid: process.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  await fs.writeFile(provider, [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, [${JSON.stringify(background)}], { detached: true, stdio: "ignore" }).unref();`,
    "process.exit(0);",
  ].join("\n"));
  const ledger = new ProviderProcessLedger();
  const child = ledger.record(spawnAgent({
    command: process.execPath, args: [provider], cwd: dir, windowsShell: false, descendantOwner: ledger.owner,
  }));
  child.stdin.end();
  for (let attempt = 0; attempt < 100 && !backgroundPid; attempt++) {
    try { backgroundPid = (JSON.parse(await fs.readFile(ready, "utf8")) as { pid: number }).pid; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  assert.ok(backgroundPid, "the background descendant started");
  await closed(child);
  assert.equal(await ledger.prove({ terminate: false }), false, "live background work is never proven gone");
  assert.equal(alive(backgroundPid!), true, "the non-killing proof left it running");
  assert.equal(await ledger.prove({ terminate: true }), true, "the killing proof ends it and then proves the tree gone");
  assert.equal(alive(backgroundPid!), false);
});

test("a process without a POSIX boundary makes every proof false", async () => {
  const ledger = new ProviderProcessLedger();
  ledger.record(Object.assign(new EventEmitter(), { pid: 7 }) as unknown as AgentProcess);
  assert.equal(await ledger.prove({ terminate: true }), false);
  assert.equal(await ledger.prove({ terminate: false }), false);
});

test("a child whose boundary belongs to another owner is proven individually, never vacuously", async () => {
  const ledger = new ProviderProcessLedger();
  const foreign = Object.assign(new EventEmitter(), {
    pid: 8, posixBoundary: { owner: {}, terminate: async () => false },
  }) as unknown as AgentProcess;
  ledger.record(foreign);
  assert.equal(await ledger.prove({ terminate: true }), false, "the owner's empty boundary set does not prove it");
});

test("no proof succeeds while untracked work may still be starting processes", async () => {
  const ledger = new ProviderProcessLedger();
  let finish!: () => void;
  const work = ledger.untracked(() => new Promise<void>((resolve) => { finish = resolve; }));
  assert.equal(await ledger.prove({ terminate: true }), false);
  finish();
  await work;
  assert.equal(await ledger.prove({ terminate: true }), false, "a memoized proof does not change afterwards");
});

test("untracked work that has finished still leaves its survivors unproven", posixOnly, async (t) => {
  const ledger = new ProviderProcessLedger();
  let survivor = 0;
  t.after(() => { if (survivor && alive(survivor)) process.kill(survivor, "SIGKILL"); });
  // A probe that starts a helper in its own process group, then exits: the probe's group kill
  // cannot reach the helper, and no boundary recorded it.
  const { stdout } = await ledger.untracked(() => promisify(execFile)(process.execPath, ["-e", [
    'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
    "child.unref(); process.stdout.write(String(child.pid));",
  ].join("\n")]));
  survivor = Number(stdout.trim());
  assert.equal(alive(survivor), true, "the helper outlived the probe");
  assert.equal(await ledger.prove({ terminate: true }), false, "a finished probe's survivor is never proven gone");
});

function separateChild(terminate: () => Promise<boolean>, owner?: object) {
  let calls = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 9,
    posixBoundary: { owner, terminate: () => { calls += 1; return terminate(); } },
  }) as unknown as AgentProcess;
  return { child, calls: () => calls };
}

function separateCount(ledger: ProviderProcessLedger): number {
  return (ledger as unknown as { separate: Set<AgentProcess> }).separate.size;
}

function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a closed ownerless child proven gone is dropped, so per-turn probes do not accumulate", async () => {
  const ledger = new ProviderProcessLedger();
  const probes = Array.from({ length: 3 }, () => separateChild(async () => true));
  for (const probe of probes) ledger.record(probe.child);
  assert.equal(separateCount(ledger), 3, "a live probe stays recorded");
  for (const probe of probes) probe.child.emit("close", 0);
  await settled();
  assert.equal(separateCount(ledger), 0, "proven probes are forgotten");
  assert.equal(await ledger.prove({ terminate: true }), true);
  for (const probe of probes) assert.equal(probe.calls(), 1, "a dropped probe is not proven again");
});

test("a real ownerless probe that exits is proven and dropped", posixOnly, async () => {
  const ledger = new ProviderProcessLedger();
  const child = ledger.record(spawnAgent({
    command: process.execPath, args: ["-e", "process.exit(0)"], cwd: os.tmpdir(), windowsShell: false,
  }));
  child.stdin.end();
  await closed(child);
  for (let attempt = 0; attempt < 200 && separateCount(ledger) > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(separateCount(ledger), 0);
  assert.equal(await ledger.prove({ terminate: false }), true);
});

test("a closed ownerless child that failed its proof makes every later proof false", async () => {
  const ledger = new ProviderProcessLedger();
  let attempts = 0;
  // PosixProcessBoundary retries a failed termination; a retry that succeeds must not count.
  const probe = separateChild(async () => ++attempts > 1);
  ledger.record(probe.child);
  probe.child.emit("close", 0);
  await settled();
  assert.equal(separateCount(ledger), 1, "an unproven probe is never forgotten");
  assert.equal(await ledger.prove({ terminate: true }), false, "the earlier failure is sticky");
  assert.equal(await ledger.prove({ terminate: false }), false);
});

test("an already-closed ownerless child is settled at record time", async () => {
  const ledger = new ProviderProcessLedger();
  const probe = separateChild(async () => true);
  (probe.child as { closeObserved?: boolean }).closeObserved = true;
  ledger.record(probe.child);
  await settled();
  assert.equal(separateCount(ledger), 0);
});

test("a child whose boundary belongs to another owner is not ended when it closes", async () => {
  const ledger = new ProviderProcessLedger();
  const foreign = separateChild(async () => true, {});
  ledger.record(foreign.child);
  foreign.child.emit("close", 0);
  await settled();
  assert.equal(foreign.calls(), 0, "its retained work belongs to its owner until the instance ends");
  assert.equal(await ledger.prove({ terminate: true }), true);
  assert.equal(foreign.calls(), 1);
});

class FakeNamespace {
  ended = false;
  endedGracefully = false;
  disposals = 0;
  private disposal: Promise<boolean> | undefined;
  constructor(private readonly outcome: { graceful: boolean; cleaned: boolean }) {}
  dispose(): Promise<boolean> {
    if (this.disposal) return this.disposal;
    this.disposals += 1;
    this.disposal = Promise.resolve().then(() => {
      this.ended = true;
      this.endedGracefully = this.outcome.graceful;
      return this.outcome.cleaned;
    });
    return this.disposal;
  }
}

function namespacedLedger(namespace: FakeNamespace) {
  const virtual = Object.assign(new EventEmitter(), { pid: 10 }) as unknown as AgentProcess;
  const ledger = new ProviderProcessLedger({ namespaceFor: (child) => child === virtual ? namespace : undefined });
  ledger.record(virtual);
  return ledger;
}

test("a Claude namespace is proven gone only after a graceful TERMINATE", async () => {
  const graceful = new FakeNamespace({ graceful: true, cleaned: true });
  assert.equal(await namespacedLedger(graceful).prove({ terminate: true }), true,
    "a boundary-less virtual provider is covered by its namespace");
  assert.equal(graceful.disposals, 1, "the killing proof disposes the namespace");

  const killed = new FakeNamespace({ graceful: false, cleaned: true });
  assert.equal(await namespacedLedger(killed).prove({ terminate: true }), false, "a SIGKILL fallback is never a proof");

  const uncleaned = new FakeNamespace({ graceful: true, cleaned: false });
  assert.equal(await namespacedLedger(uncleaned).prove({ terminate: true }), false,
    "a failed or timed-out disposal is never a proof");
});

test("the non-killing proof never disposes a Claude namespace and requires it already ended gracefully", async () => {
  const live = new FakeNamespace({ graceful: true, cleaned: true });
  assert.equal(await namespacedLedger(live).prove({ terminate: false }), false, "a live namespace (retained tasks) is unproven");
  assert.equal(live.disposals, 0);

  const ended = new FakeNamespace({ graceful: true, cleaned: true });
  await ended.dispose();
  assert.equal(await namespacedLedger(ended).prove({ terminate: false }), true);
  assert.equal(ended.disposals, 1, "only the earlier disposal ran");

  const killed = new FakeNamespace({ graceful: false, cleaned: true });
  await killed.dispose();
  assert.equal(await namespacedLedger(killed).prove({ terminate: false }), false);
});

test("a Claude namespace is captured at record time, so a later lookup miss does not matter", async () => {
  const namespace = new FakeNamespace({ graceful: true, cleaned: true });
  let lookups = 0;
  const virtual = Object.assign(new EventEmitter(), { pid: 11 }) as unknown as AgentProcess;
  const ledger = new ProviderProcessLedger({ namespaceFor: () => (++lookups === 1 ? namespace : undefined) });
  ledger.record(virtual);
  assert.equal(await ledger.prove({ terminate: true }), true);
  assert.equal(lookups, 1);
});

test("a namespace closes gracefully only after TERMINATE and a normal zero exit", () => {
  const sent = { terminateSent: true, controlFailed: false };
  assert.equal(gracefulNamespaceExit({ ...sent, code: 0, signal: null }), true);
  assert.equal(gracefulNamespaceExit({ ...sent, code: null, signal: "SIGKILL" }), false,
    "an outer killed from outside may close before the pid namespace is torn down");
  assert.equal(gracefulNamespaceExit({ ...sent, code: null, signal: "SIGTERM" }), false);
  assert.equal(gracefulNamespaceExit({ ...sent, code: 125, signal: null }), false, "a failed supervisor proves nothing");
  assert.equal(gracefulNamespaceExit({ terminateSent: false, controlFailed: false, code: 0, signal: null }), false,
    "a namespace that ended on its own was never told to stop its tasks");
  assert.equal(gracefulNamespaceExit({ terminateSent: true, controlFailed: true, code: 0, signal: null }), false);
});
