/** Opt-in experiment for #2316. Never imports the lease registry or touches real HOME evidence.
 * Results are observations/counterexamples, not a production quota or retirement authority.
 * Deliberately retain every owned fixture: interrupted/unknown producer evidence is not deleted.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url), repo = resolve(dirname(self), "../../..");
const BYTE_LIMIT = 2 * 1024 * 1024, OUTPUT_LIMIT = 64 * 1024;
const COMPILE_MS = 30_000, PROBE_MS = 10_000;
// Darwin's /bin/sh reports file limits in 1024-byte units; Linux dash uses 512.
// The real over-limit write below must verify the resulting kernel limit on each host.
const SHELL_FILE_LIMIT = process.platform === "darwin" ? 2048 : 4096;
const source = join(repo, "apps/runner/native/provider-home-lease-io.c");

// Child modes are fixture-only; no engine entrypoint, configuration or public runner mode changes.
if (process.argv[2]?.startsWith("--child-")) {
  const mode = process.argv[2], root = process.argv[3];
  if (mode === "--child-slot") {
    const { first, end } = JSON.parse(readFileSync(join(root, "accounting.json"), "utf8"));
    for (let slot = first; slot < end; slot++) {
      try { mkdirSync(join(root, `slot-${slot}`)); console.log("admitted"); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } else if (mode === "--child-create-window") {
    const fd = openSync(join(root, "created-before-unlink"), "wx+", 0o600);
    console.log("ready"); setInterval(() => fstatSync(fd), 1000);
  } else if (mode === "--child-hold") {
    console.log("ready"); setInterval(() => {}, 1000);
  } else if (mode === "--child-noise") {
    writeFileSync(join(root, "bounded-partial-output"), Buffer.alloc(64 * 1024), { flag: "wx" });
    process.stdout.write(Buffer.alloc(256 * 1024)); setInterval(() => {}, 1000);
  } else if (mode === "--child-compiler") {
    const output = join(root, "descriptor-output"), fd = openSync(output, "wx+", 0o600);
    unlinkSync(output); console.log(JSON.stringify({ ownerPid: process.pid }));
    try {
      const result = spawnSync("/bin/sh", ["-c", 'ulimit -f 4096 || exit 1; exec "$@"', "owned-compiler",
        "/usr/bin/cc", "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static", source, "-o", "/dev/fd/3"],
      { stdio: ["ignore", "pipe", "pipe", fd], env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: join(root, "temporary") },
        timeout: COMPILE_MS, maxBuffer: OUTPUT_LIMIT });
      console.log(JSON.stringify({ status: result.status, error: result.error?.code }));
    } finally { closeSync(fd); }
  } else throw new Error("unknown owned child fixture");
} else {
  await main();
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-lease-producer-probe-"));
  const live = new Set(), phases = [], blockers = [];
  const insensitive = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
  const cleanText = value => String(value).replace(insensitive(root), "<OwnedScratch>")
    .replace(insensitive(repo), "<Repository>").slice(-2048);
  const record = (phase, evidence) => { const row = { phase, ...evidence }; phases.push(row); console.log(JSON.stringify(row)); };
  const fixture = name => { const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const envFor = path => ({ ...process.env, TMPDIR: path, TMP: path, TEMP: path });
  const listing = (path, depth = 0) => {
    const names = readdirSync(path); assert.ok(names.length <= 128, "owned fixture inventory exceeded 128 entries");
    return names.flatMap(name => {
      const full = join(path, name);
      let stat;
      try { stat = statSync(full); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      if (stat.isDirectory()) { assert.ok(depth < 4, "owned fixture depth exceeded"); return listing(full, depth + 1).map(x => ({ ...x, name: `${name}/${x.name}` })); }
      return [{ name, bytes: stat.size }];
    });
  };
  function start(command, args, options = {}) {
    const { deadlineMs = COMPILE_MS, ...childOptions } = options;
    assert.ok(deadlineMs <= COMPILE_MS);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...childOptions });
    const item = { child, stdout: "", stderr: "", overflow: false, timeout: false };
    live.add(item);
    const timer = setTimeout(() => { item.timeout = true; child.kill("SIGKILL"); }, deadlineMs);
    let outputBytes = 0;
    for (const key of ["stdout", "stderr"]) child[key]?.on("data", bytes => {
      outputBytes += bytes.length;
      if (outputBytes > OUTPUT_LIMIT) { item.overflow = true; child.kill("SIGKILL"); }
      else item[key] += bytes;
    });
    item.done = new Promise(resolveDone => {
      let spawnError;
      child.on("error", error => { spawnError = error.code; });
      child.on("close", (status, signal) => {
        clearTimeout(timer); live.delete(item);
        resolveDone({ status, signal, spawnError, overflow: item.overflow, timeout: item.timeout,
          stdout: item.stdout, stderr: cleanText(item.stderr), nativeCloseObserved: true });
      });
    });
    return item;
  }
  async function until(predicate, label, ms = PROBE_MS) {
    const end = performance.now() + ms;
    while (!predicate()) { assert.ok(performance.now() < end, `${label} deadline`); await pause(5); }
  }
  const checked = async (command, args, options) => {
    const result = await start(command, args, options).done;
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
    assert.equal(result.timeout || result.overflow, false); return result;
  };
  const terminal = result => ({ status: result.status, signal: result.signal, timeout: result.timeout,
    overflow: result.overflow, nativeCloseObserved: result.nativeCloseObserved });
  const anonymous = (path, name) => { const named = join(path, name), fd = openSync(named, "wx+", 0o600); unlinkSync(named); return fd; };
  const limited = (command, args, descriptors, path) => start("/bin/sh",
    ["-c", `ulimit -f ${SHELL_FILE_LIMIT} || exit 1; exec "$@"`, "bounded-producer", command, ...args],
    { env: { PATH: "/usr/bin:/bin", LANG: "C", TMPDIR: path }, stdio: ["ignore", "pipe", "pipe", ...descriptors] });
  try {
    const admission = fixture("admission");
    for (let i = 0; i < 63; i++) mkdirSync(join(admission, `legacy-${i}`));
    writeFileSync(join(admission, "accounting.json"), JSON.stringify({ first: 63, end: 64 }), { flag: "wx", mode: 0o600 });
    const contenders = Array.from({ length: 32 }, () => start(process.execPath, [self, "--child-slot", admission]));
    const arrivals = await Promise.all(contenders.map(item => item.done));
    assert.ok(arrivals.every(r => r.status === 0 && r.nativeCloseObserved));
    const admitted = arrivals.filter(r => r.stdout.includes("admitted")).length;
    assert.equal(admitted, 1);
    record("combined-admission", { legacy: 63, contenders: 32, range: "[63,64)", admitted, total: 64,
      proofScope: "exclusive mkdir prototype only; production inventory/seal validation remains unproved" });

    const window = fixture("create-window"), owner = start(process.execPath, [self, "--child-create-window", window]);
    await until(() => owner.stdout.includes("ready"), "create-before-unlink readiness");
    owner.child.kill("SIGKILL"); const death = await owner.done;
    assert.equal(statSync(join(window, "created-before-unlink")).size, 0);
    record("create-before-unlink-death", { ...terminal(death), retained: listing(window), preserved: true });

    const noise = fixture("max-buffer"), overflow = await start(process.execPath, [self, "--child-noise", noise]).done;
    assert.equal(overflow.overflow, true);
    record("max-buffer-failure", { ...terminal(overflow), outputLimit: OUTPUT_LIMIT, retained: listing(noise),
      proofScope: "bounded fixture producer; does not establish compiler-descendant death" });
    const held = start(process.execPath, [self, "--child-hold", root]);
    await until(() => held.stdout.includes("ready"), "timeout fixture readiness");
    // Tightened fixture timeout after actual readiness; no production deadline is enlarged.
    await pause(200); held.child.kill("SIGKILL");
    record("ready-producer-timeout", { ...terminal(await held.done), injectedDeadlineMs: 200 });

    if (process.platform === "win32") await windows(); else await posix();
  } catch (error) {
    blockers.push(cleanText(error.stack));
  } finally {
    // Signal only the ChildProcess instances this exact probe spawned; never name/PID sweep.
    for (const item of live) item.child.kill("SIGKILL");
    await Promise.all([...live].map(item => item.done));
    record("summary", { probeOnly: true, platform: process.platform, arch: process.arch,
      headSha: process.env.GITHUB_SHA ?? "local-uncommitted-probe", fixture: basename(root),
      status: blockers.length ? "blocked" : "observations-only", blockers,
      knownSpawnedProcessesClosed: live.size === 0, fixturesPreserved: true,
      claim: "No all-platform production entry/byte bound or retirement authority established." });
    if (blockers.length) process.exitCode = 1;
  }

  async function posix() {
    const cap = fixture("kernel-cap"), fd = anonymous(cap, "output");
    try {
      const attempt = await limited(process.execPath, ["-e",
        "const fs=require('fs');for(let i=0;i<40;i++)fs.writeSync(3,Buffer.alloc(65536));"], [fd], cap).done;
      assert.equal(fstatSync(fd).size, BYTE_LIMIT); assert.notEqual(attempt.status, 0);
      record("kernel-before-write-cap", { ...terminal(attempt), shellFileLimit: SHELL_FILE_LIMIT,
        attemptedBytes: 2621440, actualBytes: fstatSync(fd).size });
    } finally { closeSync(fd); }
    if (process.platform === "linux") await linuxDeath();
    const path = fixture("explicit-descriptors"), temporary = join(path, "temporary"); mkdirSync(temporary);
    const object = anonymous(path, "object"), output = anonymous(path, "output");
    let peakAnonymous = 0, peakNamedBytes = 0, peakNamedEntries = 0, samplingError;
    const sampler = setInterval(() => {
      try {
        const files = listing(temporary); peakAnonymous = Math.max(peakAnonymous, fstatSync(object).size + fstatSync(output).size);
        peakNamedBytes = Math.max(peakNamedBytes, files.reduce((n, file) => n + file.bytes, 0)); peakNamedEntries = Math.max(peakNamedEntries, files.length);
      } catch (error) { samplingError = error; clearInterval(sampler); }
    }, 2);
    try {
      const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc";
      const flags = ["-pipe", "-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fno-lto",
        ...(process.platform === "darwin" ? ["-fintegrated-cc1", "-fintegrated-as"] : []), "-c", source, "-o", "/dev/fd/3"];
      const compiled = await limited(compiler, flags, [object], temporary).done;
      record("explicit-object-compile", { ...terminal(compiled), bytes: fstatSync(object).size, diagnostics: compiled.stderr });
      assert.equal(compiled.status, 0, "explicit descriptor compiler incompatible; no fallback or retry");
      let link;
      if (process.platform === "linux") {
        assert.equal(process.arch, "x64", "Linux linking recipe is x64-only; other ABI remains a blocker");
        const get = async name => {
          const r = await checked(compiler, [`-print-file-name=${name}`], { env: { PATH: "/usr/bin:/bin", LANG: "C" } });
          const file = r.stdout.trim(); assert.ok(file.startsWith("/") && existsSync(file)); return file;
        };
        const [crt1, crti, begin, gcc, gccEH, libc, end, crtn] = await Promise.all(
          ["crt1.o", "crti.o", "crtbeginT.o", "libgcc.a", "libgcc_eh.a", "libc.a", "crtend.o", "crtn.o"].map(get));
        link = limited("/usr/bin/ld", ["-static", "--eh-frame-hdr", "-m", "elf_x86_64", "-o", "/dev/fd/4",
          crt1, crti, begin, "/dev/fd/3", "--start-group", gcc, gccEH, libc, "--end-group", end, crtn], [object, output], temporary);
      } else {
        // Investigate the native driver/linker path rather than claim GNU ld flags apply on macOS.
        link = limited(compiler, ["-Wl,-no_uuid", "/dev/fd/3", "-o", "/dev/fd/4"], [object, output], temporary);
      }
      const linked = await link.done;
      assert.ifError(samplingError);
      record("explicit-descriptor-link", { ...terminal(linked), bytes: fstatSync(output).size, diagnostics: linked.stderr });
      assert.equal(linked.status, 0, "native linker/descriptor incompatible; producer containment unresolved");
      const size = fstatSync(output).size; assert.ok(size > 0 && size <= BYTE_LIMIT);
      const bytes = readFileSync(output), executable = join(path, "lease-io");
      writeFileSync(executable, bytes, { flag: "wx", mode: 0o700 });
      const probe = await checked(executable, ["--probe"], { env: {}, deadlineMs: PROBE_MS });
      record("fixed-helper-probe", { ...terminal(probe), sha256: createHash("sha256").update(bytes).digest("hex") });
      const invalid = join(path, "invalid.c"); writeFileSync(invalid, "this is deliberately invalid C\n", { flag: "wx" });
      const rejected = await limited(compiler, ["-pipe", "-c", invalid, "-o", "/dev/fd/3"], [object], temporary).done;
      assert.notEqual(rejected.status, 0);
      record("compiler-error", { ...terminal(rejected), retainedTemporary: listing(temporary), diagnostics: rejected.stderr });
    } finally {
      clearInterval(sampler);
      record("producer-storage-observation", { peakAnonymous, peakNamedBytes, peakNamedEntries,
        anonymousCapacityBytes: 2 * BYTE_LIMIT, finalPublicationLimitBytes: BYTE_LIMIT,
        retainedTemporary: listing(temporary), scope: "sampled peaks are not hard bounds; linkage/descendant/ABI audit still required" });
      closeSync(object); closeSync(output);
    }
  }

  async function linuxDeath() {
    assert.ok(existsSync("/usr/bin/strace"), "built-in strace unavailable; no OS install permitted");
    const path = fixture("compiler-death"); mkdirSync(join(path, "temporary"));
    const tracing = start("/usr/bin/strace", ["-ff", "-o", join(path, "trace"), "-e", "trace=process,openat,unlink,prlimit64",
      "-e", "inject=execve:delay_enter=80ms", process.execPath, self, "--child-compiler", path]);
    let ownerPid, driverPid;
    await until(() => {
      ownerPid = Number(tracing.stdout.match(/"ownerPid":(\d+)/u)?.[1]);
      const files = listing(join(path, "temporary"));
      if (!ownerPid || !files.some(file => file.name.endsWith(".s") && file.bytes > 0)) return false;
      for (const name of readdirSync(path).filter(name => /^trace\.\d+$/u.test(name))) {
        if (readFileSync(join(path, name), "utf8").includes('execve("/usr/bin/cc"')) driverPid = Number(name.split(".")[1]);
      }
      return Boolean(driverPid);
    }, "actual compiler assembly-write boundary", COMPILE_MS);
    const atDeath = listing(join(path, "temporary"));
    // Exact PIDs came from this owned traced launch; no process-name lookup or global kill.
    process.kill(ownerPid, "SIGKILL");
    try { process.kill(driverPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const result = await tracing.done;
    const traces = readdirSync(path).filter(name => /^trace\.\d+$/u.test(name)).map(name => readFileSync(join(path, name), "utf8"));
    const terminals = traces.map(text => text.trim().split("\n").at(-1));
    assert.ok(terminals.every(line => /\+\+\+ (exited with|killed by)/u.test(line)), "traced descendant terminal proof incomplete");
    record("compiler-driver-death", { ...terminal(result), atDeath, retained: listing(join(path, "temporary")),
      trackedNativeTerminalReceipts: terminals.length, allTracedProcessesTerminal: true,
      scope: "driver death did not imply descendant death; retained compiler output is preserved" });
  }

  async function windows() {
    const ps = join(dirname(self), "probe-lease-cache-producers.ps1"), path = fixture("windows");
    const { WINDOWS_LEASE_IO_TYPES } = await import("../src/provider-home-lease-windows-io.ts");
    const sourceBytes = Buffer.byteLength(WINDOWS_LEASE_IO_TYPES);
    assert.ok(sourceBytes <= 64 * 1024); writeFileSync(join(path, "lease.cs"), WINDOWS_LEASE_IO_TYPES, { flag: "wx" });
    const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const run = async mode => checked(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", ps,
      "-Mode", mode, "-Root", path], { env: envFor(path) });
    const described = JSON.parse((await run("Describe")).stdout.trim());
    assert.ok(existsSync(described.compiler));
    record("windows-runtime", { runtime: described.runtime, sourceBytes });
    const deletion = JSON.parse((await run("DeleteOnClose")).stdout.trim());
    assert.ok(deletion.actualBytes > BYTE_LIMIT && deletion.deletedAfterClose);
    record("delete-on-close-counterexample", deletion);
    const compiled = JSON.parse((await run("AddType")).stdout.trim());
    record("actual-add-type", compiled);
    assert.equal(compiled.success, true, "baseline fixed Add-Type failed; no fallback/retry");
    const sharing = JSON.parse((await run("Sharing")).stdout.trim());
    record("delete-on-close-add-type-sharing", sharing);
    const pipeName = `wollipog-lease-probe-${process.pid}-${Date.now()}`;
    const sink = start(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", ps, "-Mode", "PipeSink",
      "-Root", path, "-PipeName", pipeName], { env: envFor(path) });
    await until(() => sink.stdout.includes("pipe-ready"), "owned named-pipe sink readiness");
    const producer = start(described.compiler, ["/nologo", "/target:library", "/debug-", "/optimize+",
      `/out:\\\\.\\pipe\\${pipeName}`, "/reference:System.dll", join(path, "lease.cs")], { env: envFor(path) });
    const compiledPipe = await producer.done;
    // On compiler rejection before connection, reap the exact waiting server instead of waiting
    // for its full deadline; the candidate is still reported as incompatible, not retried.
    if (compiledPipe.status !== 0) sink.child.kill("SIGKILL");
    const served = await sink.done;
    record("direct-csc-pipe", { compiler: terminal(compiledPipe), sink: terminal(served),
      compilerDiagnostics: cleanText(compiledPipe.stdout + compiledPipe.stderr), sinkReport: cleanText(served.stdout),
      retained: listing(path), scope: "named-pipe output compatibility experiment; no prior all-platform size bound" });
    assert.equal(compiledPipe.status, 0, "direct csc cannot emit through bounded pipe; Windows producer containment remains blocked");
    assert.equal(served.status, 0, "bounded pipe sink failed; no disk-output fallback is authorized");
    const lines = served.stdout.trim().split(/\r?\n/u), metadata = JSON.parse(lines.at(-1));
    assert.equal(metadata.peHeader, true); assert.ok(metadata.bytes > 0 && metadata.bytes <= BYTE_LIMIT);
    blockers.push("Windows pipe observation alone does not prove absence/bounds of all compiler intermediates or interrupted descendants.");
  }
}
