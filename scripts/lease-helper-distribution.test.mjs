import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectHelperBytes, findInstalledHelper, helperAdmissionInventory, helperAssociationBytes, helperContractBytes, helperDigest, helperPositionName, installLeaseHelper, LEASE_HELPER_LIMITS, LEASE_HELPER_TARGETS, parseHelperAssociation, parseHelperTuple, publishSourceHelperTuple, readSourceHelperTuple } from "./lease-helper-distribution.mjs";

const moduleUrl = new URL("./lease-helper-distribution.mjs", import.meta.url).href;
const target = LEASE_HELPER_TARGETS[`${process.platform}/${process.arch}`];
const posixOnly = process.platform === "win32" ? "Windows has no helper-file producer; its zero-growth refusal contract is tested separately" : false;
function tuple(bytes, revision = "a") { return { schema: "WPLI1", target, protocol: "WPLL4", sourceSha256: revision.repeat(64), imageSha256: helperDigest(bytes), imageBytes: bytes.length, abi: process.platform === "win32" ? "framework4-il64" : "posix64" }; }
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-helper-admission-")));
  const live = new Set();
  t.after(() => {
    if (live.size) { t.diagnostic(`Retained owned fixture: ${root}; child closure unproved`); return; }
    // These are exclusively created synthetic fixtures, never production/legacy inputs.
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) chmodSync(join(root, entry.name), 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, live };
}
function child(f, source, args = []) {
  const p = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  f.live.add(p); let stdout = "", stderr = "", bytes = 0;
  const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
  for (const [stream, kind] of [[p.stdout, "stdout"], [p.stderr, "stderr"]]) stream.on("data", data => {
    bytes += data.length; if (bytes > 65536) p.kill("SIGKILL");
    else if (kind === "stdout") stdout += data; else stderr += data;
  });
  const done = once(p, "close").then(([code, signal]) => { clearTimeout(timer); f.live.delete(p); return { code, signal, stdout, stderr }; });
  return { p, done, ready: async () => {
    if (stdout.includes("ready\n")) return;
    await Promise.race([once(p.stdout, "data"), done.then(receipt => { throw new Error(`owned child exited before readiness: ${receipt.code}/${receipt.signal}: ${receipt.stderr}`); })]);
    assert.match(stdout, /ready\n/u);
  } };
}

test("closed canonical contracts reject duplicates, malformed bytes and arbitrary association additions", () => {
  const t = tuple(Buffer.from("fixture")), bytes = helperContractBytes(t);
  assert.deepEqual(parseHelperTuple(bytes), t);
  assert.throws(() => parseHelperTuple(Buffer.from(bytes.toString().replace('"schema":', '"schema":"WPLI1","schema":'))), /noncanonical/u);
  assert.throws(() => parseHelperTuple(Buffer.alloc(16385)), /byte limit/u);
  const a = { schema: "WPLR1", helper: t, canonical: `wollipog-runner-${target}${process.platform === "win32" ? ".exe" : ""}`, legacy: `agent-manager-runner-${target}${process.platform === "win32" ? ".exe" : ""}`, runnerSha256: "b".repeat(64), storage: process.platform === "win32" ? "embedded" : "external", installerMode: "--lease-helper-install" };
  assert.deepEqual(parseHelperAssociation(helperAssociationBytes(a)), a);
  assert.throws(() => helperAssociationBytes({ ...a, installerMode: "daemon" }), /association/u);
  assert.throws(() => helperAssociationBytes({ ...a, arbitrary: true }), /closed/u);
});

test("oversized and incomplete producers preserve capped partial bytes without publishing completion", { skip: posixOnly }, async t => {
  const f = fixture(t), bytes = Buffer.alloc(17, 1), expected = tuple(bytes);
  await assert.rejects(installLeaseHelper(f.root, expected, [bytes.subarray(0, 8), Buffer.alloc(10)]), /before-write/u);
  const image = join(f.root, helperPositionName(0), process.platform === "win32" ? "lease-io.dll" : "lease-io");
  assert.equal(lstatSync(image).size, 8); assert.equal(existsSync(join(f.root, helperPositionName(0), "contract.json")), false);
  await assert.rejects(installLeaseHelper(f.root, expected, [bytes.subarray(0, 4)]), /incomplete/u);
  assert.equal(lstatSync(join(f.root, helperPositionName(1), process.platform === "win32" ? "lease-io.dll" : "lease-io")).size, 4);
  assert.throws(() => findInstalledHelper(f.root, expected), /unavailable/u);
  assert.deepEqual(readFileSync(image), bytes.subarray(0, 8));
  await assert.rejects(collectHelperBytes([Buffer.alloc(16385)], 16384), /before-write/u);
});

test("producer stops before an excessive chunk and a stalled producer cannot resume disk writes", { skip: posixOnly }, async t => {
  const f = fixture(t), bytes = Buffer.alloc(65537, 7), expected = tuple(bytes);
  const writes = [];
  await assert.rejects(installLeaseHelper(f.root, expected, [bytes], {
    beforeWrite: (offset, length) => writes.push([offset, length]),
  }), /before-write/u);
  assert.deepEqual(writes, [], "an excessive chunk never reaches the filesystem writer");
  const stalled = {
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => { this.resume = resolve; }); },
    return() { return new Promise(() => {}); },
  };
  await assert.rejects(installLeaseHelper(f.root, tuple(Buffer.from("later")), stalled,
    { deadline: performance.now() + 50 }), /deadline exceeded/u);
  const path = join(f.root, helperPositionName(1), "lease-io");
  assert.equal(lstatSync(path).size, 0);
  stalled.resume({ done: false, value: Buffer.from("later") });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lstatSync(path).size, 0, "late iterator completion has no surviving disk writer");
  assert.equal(existsSync(join(f.root, helperPositionName(1), "contract.json")), false);
});

test("32 simultaneous owned producers can reserve only eight fixed positions", { timeout: 20000, skip: posixOnly }, async t => {
  const f = fixture(t);
  const source = `import{installLeaseHelper,helperDigest}from${JSON.stringify(moduleUrl)};const bytes=Buffer.alloc(1024,Number(process.argv[2]));const tuple=JSON.parse(process.argv[3]);tuple.imageSha256=helperDigest(bytes);process.stdout.write('ready\\n');await new Promise(r=>process.stdin.once('data',r));try{await installLeaseHelper(process.argv[1],tuple,[bytes]);process.stdout.write('installed\\n')}catch(e){if(!/budget exhausted/.test(e.message))throw e;process.stdout.write('exhausted\\n')}`;
  const expected = tuple(Buffer.alloc(1024)), children = Array.from({ length: 32 }, (_, i) => child(f, source, [f.root, String(i), JSON.stringify(expected)]));
  await Promise.all(children.map(c => c.ready())); for (const c of children) c.p.stdin.end("go");
  const receipts = await Promise.all(children.map(c => c.done));
  for (const receipt of receipts) assert.equal(receipt.code, 0, receipt.stderr);
  assert.equal(receipts.filter(r => r.stdout.includes("installed")).length, 8);
  assert.equal(receipts.filter(r => r.stdout.includes("exhausted")).length, 24);
  assert.equal(readdirSync(f.root).length, 8);
  const stored = readdirSync(f.root).reduce((sum, name) => sum + readdirSync(join(f.root, name)).reduce((n, file) => n + lstatSync(join(f.root, name, file)).size, 0), 0);
  assert.ok(stored <= LEASE_HELPER_LIMITS.logicalBytes);
  assert.equal(f.live.size, 0); t.diagnostic("32 exact child closures; eight retained complete positions; no ninth reservation");
});

test("real owner deaths preserve every partial/completed phase and do not release admission", { timeout: 20000, skip: posixOnly }, async t => {
  const f = fixture(t), phases = ["reserved", "writing", "image-closed", "contract-closed", "completed"];
  for (const phase of phases) {
    const bytes = Buffer.alloc(32, phases.indexOf(phase)), expected = tuple(bytes);
    const source = `import{installLeaseHelper}from${JSON.stringify(moduleUrl)};const phase=process.argv[2];function stop(p){if(p===phase){process.stdout.write('ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}}await installLeaseHelper(process.argv[1],JSON.parse(process.argv[3]),[Buffer.alloc(16,Number(process.argv[4])),Buffer.alloc(16,Number(process.argv[4]))],{onPhase:stop,beforeWrite:offset=>{if(offset===16)stop('writing')}})`;
    const c = child(f, source, [f.root, phase, JSON.stringify(expected), String(phases.indexOf(phase))]);
    await c.ready(); c.p.kill("SIGKILL"); const receipt = await c.done; assert.equal(receipt.signal, "SIGKILL");
    assert.equal(readdirSync(f.root).length, phases.indexOf(phase) + 1);
  }
  const names = readdirSync(f.root); assert.equal(names.length, 5);
  const partial = join(f.root, helperPositionName(1), process.platform === "win32" ? "lease-io.dll" : "lease-io"); assert.equal(lstatSync(partial).size, 16);
  for (let i = 5; i < 8; i++) mkdirSync(join(f.root, helperPositionName(i)));
  await assert.rejects(installLeaseHelper(f.root, tuple(Buffer.from("new")), [Buffer.from("new")]), /budget exhausted/u);
  const complete = tuple(Buffer.alloc(32, 4)); findInstalledHelper(f.root, complete).verify(); assert.deepEqual(readdirSync(f.root), Array.from({ length: 8 }, (_, i) => helperPositionName(i)));
  assert.equal(f.live.size, 0);
});

test("identity attacks and incomplete inventory refuse while preserving original and unknown evidence", { skip: posixOnly }, async t => {
  const f = fixture(t), bytes = Buffer.from("owned fixture bytes"), expected = tuple(bytes);
  const installed = await installLeaseHelper(f.root, expected, [bytes]);
  const linked = join(f.root, "owned-hardlink"); linkSync(installed.path, linked);
  assert.throws(() => installed.verify(), /unproved/u); assert.deepEqual(readFileSync(linked), bytes);
  // Retain this occupied linked position; the next producer uses another fixed name.
  const next = await installLeaseHelper(f.root, tuple(Buffer.from("second")), [Buffer.from("second")]);
  const old = join(f.root, "owned-old-root"); renameSync(next.root, old); symlinkSync(old, next.root, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => next.verify(), /directory|changed/u);
  const excess = join(f.root, helperPositionName(2)); mkdirSync(excess);
  for (let i = 0; i < 5; i++) writeFileSync(join(excess, `owned-unknown-${i}`), "retain");
  assert.throws(() => helperAdmissionInventory(f.root), /inventory unavailable/u);
  const before = readdirSync(f.root); await assert.rejects(installLeaseHelper(f.root, tuple(Buffer.from("third")), [Buffer.from("third")]), /inventory unavailable/u);
  assert.deepEqual(readdirSync(f.root), before); assert.deepEqual(readFileSync(installed.path), bytes);
});

test("two immutable source publications have a finite migration/refusal boundary", { skip: posixOnly }, async t => {
  const f = fixture(t), first = tuple(Buffer.from("one")), second = tuple(Buffer.from("two"), "b");
  publishSourceHelperTuple(f.root, first); publishSourceHelperTuple(f.root, second);
  assert.deepEqual(readSourceHelperTuple(f.root, target, first.sourceSha256), first);
  assert.equal(publishSourceHelperTuple(f.root, first), join(f.root, "wollipog-lease-helper-source-0.json"));
  assert.throws(() => publishSourceHelperTuple(f.root, tuple(Buffer.from("three"), "c")), /budget exhausted/u);
  assert.equal(readdirSync(f.root).length, 2);
});
