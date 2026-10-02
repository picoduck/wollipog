// Opt-in #2316 experiment. Offline compiler/package writes are observations, not quotas.
// This is not the production runner/worker, cache authority, or release packaging.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const MAX_DLL = 65536;
const MAX_OUTPUT = 65536;
const children = new Set();
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const log = (record) => console.log(JSON.stringify(record));

// Also serialized into the self-contained source/SEA fixture. Never signals a PID lookup.
function start(executable, args, milliseconds, input) {
  const began = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - began) / 1e6;
  const fileIndex = args.indexOf("-File");
  const phaseEnabled = fileIndex >= 0 && path.basename(args[fileIndex + 1]) === "probe-lease-cache-prebuilt.ps1";
  const modeIndex = args.indexOf("-Mode");
  const mode = phaseEnabled && modeIndex >= 0 ? args[modeIndex + 1] : undefined;
  if (phaseEnabled) log({ launchPhase: "before-spawn", mode, elapsedMs: elapsed(), deadlineMs: milliseconds });
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (phaseEnabled) log({ launchPhase: "spawn-returned", mode, pid: child.pid, elapsedMs: elapsed() });
  children.add(child);
  const stdout = [], stderr = [];
  let size = 0, reason = null, readyValue, lineBuffer = "", phaseBuffer = "", phaseCount = 0, lastPhase = null;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const kill = (why) => { reason ??= why; if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  const timer = setTimeout(() => kill("deadline"), milliseconds);
  const capture = (target, bytes) => {
    size += bytes.length;
    if (size > 65536) { kill("maxBuffer"); return; }
    target.push(bytes);
    if (phaseEnabled && target === stderr) {
      phaseBuffer += bytes.toString("utf8");
      for (let index; (index = phaseBuffer.indexOf("\n")) >= 0;) {
        const line = phaseBuffer.slice(0, index).replace(/\r$/, ""); phaseBuffer = phaseBuffer.slice(index + 1);
        if (!line.startsWith('{"probePhase":true,')) continue;
        let phase;
        try { phase = JSON.parse(line); } catch { kill("phaseProtocol"); continue; }
        if (++phaseCount > 48 || Buffer.byteLength(line) + 2 > 256 || !/^[a-z0-9-]{1,64}$/.test(phase.stage) || (phase.elapsedMs !== undefined && (!Number.isSafeInteger(phase.elapsedMs) || phase.elapsedMs < 0))) { kill("phaseProtocol"); continue; }
        lastPhase = phase.stage;
        log({ phaseReceipt: true, mode, pid: child.pid, stage: phase.stage, scriptElapsedMs: phase.elapsedMs ?? null, launchElapsedMs: elapsed() });
      }
    }
    if (target !== stdout) return;
    lineBuffer += bytes.toString("utf8");
    for (let index; (index = lineBuffer.indexOf("\n")) >= 0;) {
      const line = lineBuffer.slice(0, index); lineBuffer = lineBuffer.slice(index + 1);
      try {
        const value = JSON.parse(line);
        if (value.ready && !readyValue) { readyValue = value; readyResolve(value); }
      } catch { /* Binary helper responses have no readiness records. */ }
    }
  };
  child.stdout.on("data", (bytes) => capture(stdout, bytes));
  child.stderr.on("data", (bytes) => capture(stderr, bytes));
  child.stdin.on("error", (error) => { if (error.code !== "EPIPE") kill("inputError"); });
  child.on("error", (error) => { reason ??= `spawn:${error.code}`; });
  const done = new Promise((resolve) => child.on("close", (code, signal) => {
    clearTimeout(timer); children.delete(child); readyResolve(null);
    if (phaseEnabled) log({ launchPhase: "closed", mode, pid: child.pid, elapsedMs: elapsed(), phaseCount, lastPhase, code, signal, reason });
    resolve({ code, signal, reason, pid: child.pid, elapsedMs: elapsed(), phaseCount, lastPhase, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
  }));
  if (input !== undefined) child.stdin.end(input);
  return { child, done, ready, kill };
}

// Only bounded, known bytes can reach a write. The fresh synthetic parent has no legacy seal.
async function copyRuntime(asset) {
  const [mode, cache, ps, script, root] = process.argv.slice(2);
  const sourceDigest = asset.sourceDigest;
  let hex = asset.hex, digest = asset.digest, declaredSource = sourceDigest;
  if (mode === "oversized") hex = "00".repeat(65537);
  if (mode === "empty") hex = "";
  if (mode === "encoding") hex = "gg";
  if (mode === "digest") digest = "0".repeat(64);
  if (mode === "stale") declaredSource = "0".repeat(64);
  try {
    assert(hex.length > 0 && hex.length <= 131072 && hex.length % 2 === 0 && /^[0-9a-f]+$/.test(hex), "encoding/length refusal");
    assert.equal(declaredSource, sourceDigest, "source binding refusal");
    const bytes = Buffer.from(hex, "hex");
    assert.equal(hash(bytes), digest, "digest refusal");
    let slot;
    for (let index = 0; index < 64; index++) {
      const candidate = path.join(cache, `slot-${String(index).padStart(2, "0")}`);
      try { fs.mkdirSync(candidate); slot = candidate; break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    assert(slot, "fixed synthetic slot range exhausted");
    const receipt = Buffer.from(JSON.stringify({ pid: process.pid, sourceDigest, digest, bytes: bytes.length }));
    assert(receipt.length <= 4096);
    fs.writeFileSync(path.join(slot, "receipt.json"), receipt, { flag: "wx" });
    const pause = async (phase) => {
      log({ ready: true, phase, pid: process.pid });
      await new Promise(() => { setInterval(() => {}, 1000); });
    };
    if (mode === "constructor") await pause(mode);
    const dll = path.join(slot, "helper.dll");
    const fd = fs.openSync(dll, "wx");
    try {
      let offset = 0;
      const writeTo = (end) => {
        assert(end <= bytes.length);
        while (offset < end) {
          const count = fs.writeSync(fd, bytes, offset, end - offset, offset);
          assert(count > 0 && count <= end - offset); offset += count;
        }
      };
      writeTo(Math.floor(bytes.length / 2));
      if (mode === "partial") await pause(mode);
      writeTo(bytes.length);
    } finally { fs.closeSync(fd); }
    if (mode === "full") await pause(mode);
    if (mode === "copy") { log({ copied: true, bytes: bytes.length }); return; }
    const psMode = ({ malformed: "Malformed", probeFailure: "ProbeFailure", snapshot: "Snapshot", hold: "Hold" })[mode];
    assert(psMode, "unknown runtime mode");
    const helper = start(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Mode", psMode, "-Root", root, "-Assembly", dll, "-Digest", digest], 10000);
    try {
      if (mode === "snapshot") {
        const rootBytes = Buffer.from(root, "utf8");
        const frame = Buffer.alloc(30 + rootBytes.length);
        frame.write("WPLL4"); frame[5] = 0; frame.writeUInt32LE(process.pid, 6);
        frame.writeUInt32LE(128, 10); frame.writeBigUInt64LE(1048576n, 14);
        frame.writeUInt32LE(0, 22); frame.writeUInt32LE(rootBytes.length, 26); rootBytes.copy(frame, 30);
        helper.child.stdin.end(frame);
      } else if (mode === "hold") {
        const metadata = await helper.ready;
        assert(metadata, "DLL user never became ready");
        log({ ready: true, phase: "dllUser", metadata, wrapperPid: process.pid });
        const control = await new Promise((resolve) => {
          let text = "";
          process.stdin.on("data", (chunk) => { text += chunk; assert(text.length <= 16); if (text.includes("\n")) resolve(text.trim()); });
          process.stdin.on("end", () => resolve(text.trim()));
        });
        if (control === "kill") helper.kill("injectedNativeDeath");
        else { assert.equal(control, "stop"); helper.child.stdin.end("stop\n"); }
      } else helper.child.stdin.end();
      const result = await helper.done;
      log({ helperReceipt: true, mode, pid: result.pid, code: result.code, signal: result.signal, reason: result.reason, outputBytes: result.stdout.length, diagnosticBytes: result.stderr.length, elapsedMs: result.elapsedMs, phaseCount: result.phaseCount, lastPhase: result.lastPhase });
      if (mode === "probeFailure") { assert.notEqual(result.code, 0); assert.equal(result.reason, null); }
      else if (mode === "hold" && result.reason === "injectedNativeDeath") assert(result.code !== 0 || result.signal !== null);
      else {
        assert.equal(result.reason, null); assert.equal(result.code, 0);
        if (mode === "snapshot") { assert.equal(result.stdout[0], 83, "native snapshot refused"); log({ nativeSnapshot: true, responseBytes: result.stdout.length, responseDigest: hash(result.stdout) }); }
        if (mode === "malformed") assert(JSON.parse(result.stdout.toString()).expectedFailure);
      }
    } finally {
      if (children.has(helper.child)) helper.kill("ownerFinally");
      await helper.done;
    }
  } catch (error) {
    if (["oversized", "empty", "encoding", "digest", "stale"].includes(mode)) { log({ refusal: true, mode, beforeEntry: true }); return; }
    throw error;
  }
}

function inventory(root) {
  const rows = [];
  function visit(directory, depth) {
    assert(depth <= 4, "inventory depth refused");
    const iterator = fs.opendirSync(directory);
    try {
      for (let entry; (entry = iterator.readSync()) !== null;) {
        assert(rows.length < 128, "inventory entry refusal");
        const name = path.join(directory, entry.name), stat = fs.lstatSync(name);
        assert(!stat.isSymbolicLink(), "inventory symlink refused");
        assert(stat.isDirectory() || (stat.isFile() && stat.nlink === 1), "inventory unknown/hardlink refused");
        rows.push({ relative: path.relative(root, name), bytes: stat.isFile() ? stat.size : 0, directory: stat.isDirectory() });
        if (stat.isDirectory()) visit(name, depth + 1);
      }
    } finally { iterator.closeSync(); }
  }
  visit(root, 0);
  return { entries: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), rows };
}

async function checked(executable, args, milliseconds = 10000) {
  const owned = start(executable, args, milliseconds, "");
  const result = await owned.done;
  log({ processReceipt: true, pid: result.pid, code: result.code, signal: result.signal, reason: result.reason, outputBytes: result.stdout.length, diagnosticBytes: result.stderr.length, elapsedMs: result.elapsedMs, phaseCount: result.phaseCount, lastPhase: result.lastPhase });
  if (result.code !== 0 || result.reason) {
    // Compiler/packager diagnostics are already capped; no source or binary contents logged.
    // Phase lines were already streamed above; keep them from crowding out the bounded error.
    const diagnostic = result.stderr.toString("utf8").split(/\r?\n/).filter(line => !line.startsWith('{"probePhase":true,')).join("\n");
    log({ failedDiagnostic: diagnostic.slice(0, 4096), stdoutDiagnostic: result.stdout.toString("utf8").slice(0, 4096) });
  }
  assert.equal(result.reason, null, "bounded child failed"); assert.equal(result.code, 0, "child failed");
  return result.stdout;
}

function fixtureProgram(asset) {
  const text = `const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');\nconst children=new Set(),hash=${hash.toString()},log=${log.toString()},start=${start.toString()};\n(${copyRuntime.toString()})(${JSON.stringify(asset)}).catch(error=>{console.error(JSON.stringify({error:error.message}));process.exitCode=1;});\n`;
  assert(Buffer.byteLength(text) <= 262144, "fixture module cap refused");
  return text;
}

function validateRuntime(metadata, expected) {
  assert.equal(metadata.loadedClrMachine, expected === "arm64" ? "0xaa64" : "0x8664", "loaded CLR is not the requested native ABI");
  assert.equal(metadata.pointerBytes, 8); assert(metadata.powerShellVersion.startsWith("5."));
}

function anyCpuImage(bytes) {
  assert.equal(bytes.readUInt16LE(0), 0x5a4d);
  const pe = bytes.readUInt32LE(60); assert(pe >= 64 && pe + 24 < bytes.length);
  assert.equal(bytes.readUInt32LE(pe), 0x4550);
  const machine = bytes.readUInt16LE(pe + 4), sections = bytes.readUInt16LE(pe + 6), size = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24; assert.equal(bytes.readUInt16LE(optional), 0x10b, "AnyCPU PE32 expected");
  assert(optional + size <= bytes.length && size >= 216 && sections <= 32);
  const cliRva = bytes.readUInt32LE(optional + 96 + 14 * 8);
  let cli;
  for (let index = 0; index < sections; index++) {
    const header = optional + size + index * 40; assert(header + 40 <= bytes.length);
    const rva = bytes.readUInt32LE(header + 12), rawSize = bytes.readUInt32LE(header + 16), raw = bytes.readUInt32LE(header + 20);
    if (cliRva >= rva && cliRva - rva + 20 <= rawSize) cli = raw + cliRva - rva;
  }
  assert(cli !== undefined && cli + 20 <= bytes.length);
  const flags = bytes.readUInt32LE(cli + 16);
  assert.equal(machine, 0x14c); assert(flags & 1); assert.equal(flags & (2 | 0x20000), 0);
  return { imageMachine: "0x014c", cliFlags: flags, ilOnly: true, anyCpu: true };
}

async function exercise(executable, prefix, cache, ps, script, root, expected, native) {
  const args = (mode) => [...prefix, mode, cache, ps, script, root];
  for (const mode of ["oversized", "empty", "encoding", "digest", "stale"]) {
    const before = inventory(cache);
    const result = JSON.parse((await checked(executable, args(mode))).toString());
    assert(result.refusal && result.beforeEntry); assert.deepEqual(inventory(cache), before);
  }
  for (const mode of ["constructor", "partial", "full"]) {
    const owned = start(executable, args(mode), 10000);
    const ready = await owned.ready; assert(ready && ready.phase === mode, "copy death readiness missing");
    owned.kill("injectedOwnerDeath"); const result = await owned.done;
    assert.equal(result.reason, "injectedOwnerDeath");
    log({ copyDeath: mode, pid: result.pid, code: result.code, signal: result.signal, retained: inventory(cache) });
  }
  if (!native) return;
  for (const mode of ["malformed", "probeFailure", "snapshot"]) await checked(executable, args(mode));
  const users = Array.from({ length: 8 }, () => start(executable, args("hold"), 10000));
  const ready = await Promise.all(users.map((user) => user.ready));
  for (const receipt of ready) { assert(receipt?.metadata, "concurrent DLL readiness missing"); validateRuntime(receipt.metadata, expected); }
  const live = inventory(cache);
  for (let index = 0; index < users.length; index++) users[index].child.stdin.end(index < 4 ? "stop\n" : "kill\n");
  const results = await Promise.all(users.map((user) => user.done));
  for (const result of results) { assert.equal(result.code, 0); assert.equal(result.reason, null); log({ concurrentUserReceipt: result.stdout.toString("utf8").trim() }); }
  assert.deepEqual(inventory(cache), live, "live/native-death fixtures must remain retained");
  log({ concurrentNativeUsers: 8, nativeGracefulCloses: 4, nativeDeaths: 4, retained: live });
}

let fixture;
try {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wollipog-2316-prebuilt-"));
  log({ fixtureRetained: fixture, nodeArch: process.arch, hostMachine: os.machine(), nodeVersion: process.version, scope: "offline packaging observed; runtime byte-copy bounded; minimal SEA is not runner/worker" });
  const cache = path.join(fixture, "cache"), root = path.join(fixture, "synthetic-ntfs-root"), offline = path.join(fixture, "offline-build");
  for (const directory of [cache, root, offline]) fs.mkdirSync(directory);
  const selfCheck = process.argv.includes("--self-check");
  let bytes, sourceDigest, ps = "", script = "", expected = process.env.PROBE_EXPECTED_ARCH;
  if (selfCheck) { bytes = Buffer.alloc(MAX_DLL, 7); sourceDigest = hash(Buffer.from("synthetic generic-copy self-check only")); }
  else {
    assert.equal(process.platform, "win32"); assert(["x64", "arm64"].includes(expected)); assert.equal(process.arch, expected);
    assert(expected === "arm64" ? /arm64|aarch64/i.test(os.machine()) : /amd64|x86_64/i.test(os.machine()), "host machine is not requested native ABI");
    ps = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    script = fileURLToPath(new URL("./probe-lease-cache-prebuilt.ps1", import.meta.url));
    const describe = JSON.parse((await checked(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Mode", "Describe", "-Root", offline])).toString());
    log({ nativeRuntime: describe }); validateRuntime(describe, expected); assert(fs.statSync(describe.compiler).isFile(), "built-in Framework compiler unavailable");
    const { WINDOWS_LEASE_IO_TYPES } = await import("../src/provider-home-lease-windows-io.ts");
    const source = Buffer.from(WINDOWS_LEASE_IO_TYPES); assert(source.length <= MAX_DLL); sourceDigest = hash(source);
    const cs = path.join(offline, "lease.cs"), dll = path.join(offline, "lease.dll");
    fs.writeFileSync(cs, source, { flag: "wx" });
    // Exactly one offline compile. A size check AFTER this command is not a compiler quota.
    await checked(describe.compiler, ["/nologo", "/target:library", "/platform:anycpu", "/debug-", "/optimize+", "/reference:System.dll", `/out:${dll}`, cs], 30000);
    const dllHandle = fs.openSync(dll, "r");
    try {
      const stat = fs.fstatSync(dllHandle); assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= MAX_DLL, "offline image unusable");
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(dllHandle, bytes, offset, bytes.length - offset, offset);
        assert(count > 0); offset += count;
      }
      assert.equal(fs.readSync(dllHandle, Buffer.alloc(1), 0, 1, offset), 0, "offline image changed during bounded capture");
    } finally { fs.closeSync(dllHandle); }
    log({ offlineCompiler: "one compile; descendants not exhaustively proved; fixture retained", sourceBytes: source.length, dllBytes: bytes.length, sourceDigest, dllDigest: hash(bytes), image: anyCpuImage(bytes), inventory: inventory(offline) });
    const metadata = JSON.parse((await checked(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Mode", "Metadata", "-Root", offline, "-Assembly", dll, "-Digest", hash(bytes)])).toString());
    validateRuntime(metadata, expected); assert.equal(metadata.assemblyArchitecture, "MSIL"); assert(metadata.loadedFromBytes);
    for (const reference of metadata.references) { assert(["mscorlib", "System"].includes(reference.name)); assert.equal(reference.version, "4.0.0.0"); }
    log({ verifiedImageMetadata: metadata });
  }
  const program = path.join(offline, "fixture.cjs");
  fs.writeFileSync(program, fixtureProgram({ hex: bytes.toString("hex"), digest: hash(bytes), sourceDigest }), { flag: "wx" });
  await exercise(process.execPath, [program], cache, ps, script, root, expected, !selfCheck);
  log({ sourceProbePassed: true, syntheticOnly: selfCheck, cache: inventory(cache) });
  if (!selfCheck) {
    const blob = path.join(offline, "sea.blob"), config = path.join(offline, "sea.json"), exe = path.join(offline, "probe.exe");
    const configuration = Buffer.from(JSON.stringify({ main: program, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
    assert(configuration.length <= 4096); fs.writeFileSync(config, configuration, { flag: "wx" });
    await checked(process.execPath, ["--experimental-sea-config", config], 30000);
    const executableSize = fs.statSync(process.execPath).size; assert(executableSize <= 128 * 1024 * 1024);
    fs.copyFileSync(process.execPath, exe, fs.constants.COPYFILE_EXCL);
    const injector = path.join(offline, "inject.cjs");
    fs.writeFileSync(injector, "const fs=require('node:fs');require(process.argv[2]).inject(process.argv[3],'NODE_SEA_BLOB',fs.readFileSync(process.argv[4]),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'}).catch(e=>{console.error(e.message);process.exitCode=1;});", { flag: "wx" });
    const require = createRequire(import.meta.url);
    await checked(process.execPath, [injector, require.resolve("postject"), exe, blob], 30000);
    log({ minimalSea: true, copiedNodeBytes: executableSize, offlineInventory: inventory(offline), scope: "packaging observed, no pre-write compiler/package quota; no real runner/worker bootstrap" });
    await exercise(exe, [], cache, ps, script, root, expected, true);
    log({ minimalSeaProbePassed: true, cache: inventory(cache) });
  }
} catch (error) {
  log({ failure: error.message, fixtureRetained: fixture, nativeEvidenceIncomplete: true }); process.exitCode = 1;
} finally {
  // Even on a failed assertion, only exact spawned children are signalled and reaped.
  const pending = [...children];
  for (const child of pending) if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(pending.map((child) => new Promise((resolve) => child.once("close", resolve))));
  log({ ownedChildrenRemaining: children.size, retainedUncertainty: "offline compiler/packager descendant proof not exhaustive; no fixture deletion", outputCap: MAX_OUTPUT, allSixProductionCriteriaUnfinished: true });
}
