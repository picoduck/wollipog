import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
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
