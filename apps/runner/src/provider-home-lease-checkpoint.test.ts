import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import fc from "fast-check";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ProviderHomeLeaseRegistry, observeLeaseVerificationWorkForTest, verifyLeaseCheckpointForTest, verifyLeaseRetirementForTest } from "./provider-home-lease.js";
import { LEASE_CHECKPOINT_LIMITS as LIMITS } from "./provider-home-lease-checkpoint.js";
import { observeLeaseIoRunsForTest, observeLeaseIoWorkForTest, readLeaseIoSnapshot, type LeaseIoRun } from "./provider-home-lease-io.js";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const owner = "a".repeat(64);
const nativeModule = new URL("./provider-home-lease.ts", import.meta.url).href;
const boundaries = ["before-guard", "guard-temp-written", "guard-file-durable", "guard-published", "guard-durable", "before-candidate", "candidate-written", "candidate-file-durable", "candidate-durable", "before-selection", "selection-published", "selection-durable", "before-retire", "after-retire", "retirement-durable"];

function fixture(t: Pick<TestContext, "after">, reapers: Array<() => Promise<void>> = [], parent = tmpdir()): string {
  const home = fs.mkdtempSync(join(parent, "wollipog-canonical-checkpoint-"));
  t.after(async () => {
    // Parent timeouts can start this hook before a child's async after-hook ends.
    // Share its idempotent reaper rather than depending on hook nesting order.
    await Promise.all(reapers.map(reap => reap()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}
function paths(home: string) {
  const root = join(home, ".agent-manager/provider-home-leases-v1");
  return { root, lock: join(root, "mutable-home.lock"), anchor: join(root, "mutable-home.recovery.json") };
}
function nativePass(home: string, options: ConstructorParameters<typeof ProviderHomeLeaseRegistry>[1] = {}) {
  const registry = new ProviderHomeLeaseRegistry(owner, options);
  const deadline = performance.now() + 1_000;
  for (;;) {
    try { registry.acquireHome(home); break; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("publication is in progress") || performance.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  assert.equal(registry.releaseHome(home), true);
  return registry;
}
function seed(home: string, passes = 8) {
  for (let i = 0; i < passes; i++) nativePass(home);
}

test("Python orderly release waits for a real reader and transfers authority after the owner exits", { skip: process.platform !== "linux", timeout: 60_000 }, async (t) => {
  const home = fixture(t); seed(home);
  const marker = join(home, "helper-ready"), go = join(home, "release-go"), readerMarker = join(home, "reader-ready");
  const code = `home_fd,_=open_root(os.environ["HOME"])\nlease=acquire_lease(home_fd,"${owner}")\nopen(${JSON.stringify(marker)},"w").write("ready")\nwhile not os.path.exists(${JSON.stringify(go)}): time.sleep(0.01)\nrelease_lease(lease)\nos.close(home_fd)\nprint("released")`;
  const origin = spawn("python3", ["-c", program(code)], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (origin.exitCode === null && origin.signalCode === null) origin.kill("SIGKILL"); });
  let output = ""; origin.stdout.on("data", b => { output += b; }); origin.stderr.on("data", b => { output += b; });
  const exited = new Promise<number | null>(resolve => origin.once("close", code => resolve(code)));
  await ready(origin, marker, () => output);
  const guard = join(paths(home).lock, "protocol-v4.json");
  const reader = spawn("python3", ["-c", `import fcntl,time;f=open(${JSON.stringify(guard)},'rb');fcntl.flock(f,fcntl.LOCK_SH);open(${JSON.stringify(readerMarker)},'w').write('ready');time.sleep(2)`]);
  t.after(() => { if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL"); });
  await ready(reader, readerMarker, () => "reader"); fs.writeFileSync(go, "go");
  assert.equal(await exited, 0, output); assert.match(output, /released/);
  const next = new ProviderHomeLeaseRegistry("b".repeat(64));
  assert.equal(next.acquireHome(home), true); assert.equal(next.releaseHome(home), true);
});

test("Python retains a private pending completion across an actual exclusive-fence deadline", { skip: process.platform !== "linux", timeout: 60_000 }, (t) => {
  const home = fixture(t); seed(home, 9);
  const code = `import subprocess
original_publish=publish_lease
holder=None
def interrupted_publish(root, lock, target, value):
    global holder
    original_publish(root, lock, target, value)
    if value.get("state")=="active" and target.startswith("next-"):
        marker=os.path.join(os.environ["HOME"],"fence-ready")
        guard=os.path.join(fd_path(root),"mutable-home.lock",FORMAT_GUARD)
        source="import fcntl,time;f=open(%r,'rb');fcntl.flock(f,fcntl.LOCK_EX);open(%r,'w').write('ready');time.sleep(13)" % (guard,marker)
        holder=subprocess.Popen([sys.executable,"-c",source])
        deadline=time.monotonic()+5
        while not os.path.exists(marker):
            assert holder.poll() is None and time.monotonic()<deadline, "test fence did not become ready"
            time.sleep(0.01)
publish_lease=interrupted_publish
home_fd,_=open_root(os.environ["HOME"])
started=time.monotonic()
try: acquire_lease(home_fd,"${owner}"); raise AssertionError("HOME granted during deadline")
except RuntimeError as error:
    assert "publication is in progress" in str(error) and "quarantine" not in str(error), str(error)
assert 9.9 <= time.monotonic()-started < 20
assert len(helper_pending_completions)==1 and len(helper_acquired_proofs)==1
root=next(iter(helper_pending_completions))
def canonical():
    return {name:hashlib.sha256(open(os.path.join(fd_path(root),name),"rb").read()).hexdigest() for name in os.listdir(root) if name!="mutable-home.lock"}
before=canonical()
holder.wait(timeout=10)
publish_lease=original_publish
lease=acquire_lease(home_fd,"${owner}")
assert lease[0]==root and not helper_pending_completions and canonical()==before
release_lease(lease)
assert not helper_acquired_proofs
os.close(home_fd)
print("exact pending completion released")`;
  const result = spawnSync("python3", ["-c", program(code)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /exact pending completion released/);
  const next = new ProviderHomeLeaseRegistry("b".repeat(64));
  assert.equal(next.acquireHome(home), true); assert.equal(next.releaseHome(home), true);
});
function program(code: string, helper = WSL_SKILLS_HELPER): string {
  const boundary = helper.lastIndexOf("\ntry:\n    main(bounded_json())");
  assert.ok(boundary > 0);
  return `${helper.slice(0, boundary)}\n${code}\n`;
}
function helperPass(home: string, code = "", helper = WSL_SKILLS_HELPER, timeout = 10_000) {
  const result = spawnSync("python3", ["-c", program(`${code}\nhome_fd, _ = open_root(os.environ["HOME"])\nlease = acquire_lease(home_fd, "${owner}")\nrelease_lease(lease)\nos.close(home_fd)`, helper)],
    { env: { ...process.env, HOME: home }, encoding: "utf8", timeout });
  return result;
}
function evidence(home: string): Map<string, string> {
  const { root, lock } = paths(home);
  return new Map([root, lock].flatMap((directory) => fs.readdirSync(directory).filter((name) => name !== "mutable-home.lock")
    .map((name) => [join(directory, name), createHash("sha256").update(fs.readFileSync(join(directory, name))).digest("hex")] as [string, string])));
}
function storage(home: string) {
  const { root, lock } = paths(home);
  const entries = [root, lock].flatMap((directory) => fs.readdirSync(directory).filter((name) => name !== "mutable-home.lock").map((name) => join(directory, name)));
  return { records: entries.length, bytes: entries.reduce((n, path) => n + fs.statSync(path).size, 0) };
}
async function ready(child: ChildProcess, path: string, output: () => string, signal?: AbortSignal) {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(path)) {
    signal?.throwIfAborted();
    assert.equal(child.signalCode, null, output());
    assert.equal(child.exitCode, null, output());
    assert.ok(Date.now() < deadline, `barrier timeout: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function kill(child: ChildProcess) {
  const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await ended;
  // The native helper observes the parent's lifecycle independently and releases its fence.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("large native/helper/mixed handoffs bound records, bytes, and verification reads", { timeout: 300_000, skip: process.platform !== "linux" }, async (t) => {
  const measurements: Array<Record<string, unknown>> = [];
  for (const mode of ["native", "helper", "mixed"] as const) {
    const home = fixture(t);
    const passes = process.env.WOLLIPOG_LEASE_LONG_RUN === "1" ? 512 : 64;
    let maxRecords = 0; let maxBytes = 0; let maxReads = 0; let maxReadBytes = 0;
    if (mode === "helper") {
      const result = spawnSync("python3", ["-c", program(`
original = read_lease_record
reads, read_bytes = 0, 0
def measured(directory, name, max_links=3):
    global reads, read_bytes
    reads += 1; read_bytes += os.stat(name, dir_fd=directory, follow_symlinks=False).st_size
    return original(directory, name, max_links)
read_lease_record = measured
maximum = {"records": 0, "bytes": 0, "reads": 0, "readBytes": 0}
home_fd, _ = open_root(os.environ["HOME"])
for index in range(${passes}):
    reads, read_bytes = 0, 0
    lease = acquire_lease(home_fd, "${owner}")
    root, lock, _ = lease
    entries = [(directory, name) for directory in (root, lock) for name in os.listdir(directory) if name != "mutable-home.lock"]
    maximum["records"] = max(maximum["records"], len(entries))
    maximum["bytes"] = max(maximum["bytes"], sum(os.stat(name, dir_fd=directory).st_size for directory, name in entries))
    release_lease(lease)
    maximum["reads"] = max(maximum["reads"], reads)
    maximum["readBytes"] = max(maximum["readBytes"], read_bytes)
os.close(home_fd)
print(json.dumps(maximum))`)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 120_000 });
      assert.equal(result.status, 0, String(result.stderr));
      const maximum = JSON.parse(String(result.stdout));
      ({ records: maxRecords, bytes: maxBytes, reads: maxReads, readBytes: maxReadBytes } = maximum);
    } else {
      const original = fs.readSync;
      let reads = 0; let readBytes = 0;
      fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
        const count = original(...args);
        reads++; readBytes += count;
        return count;
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      observeLeaseIoWorkForTest((work) => { reads += work.records; readBytes += work.bytes; });
      try {
        for (let i = 0; i < passes; i++) {
          reads = 0; readBytes = 0;
          const registry = new ProviderHomeLeaseRegistry(owner);
          registry.acquireHome(home);
          const size = storage(home);
          maxRecords = Math.max(maxRecords, size.records); maxBytes = Math.max(maxBytes, size.bytes);
          assert.equal(registry.releaseHome(home), true);
          assert.deepEqual(registry.getDiagnostics(), []);
          maxReads = Math.max(maxReads, reads); maxReadBytes = Math.max(maxReadBytes, readBytes);
          if (mode === "mixed") {
            const result = helperPass(home);
            assert.equal(result.status, 0, String(result.stderr));
          }
        }
      } finally { observeLeaseIoWorkForTest(); fs.readSync = original; syncBuiltinESMExports(); }
    }
    assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 4);
    assert.ok(maxRecords <= 36, `${mode}: ${maxRecords} records`);
    assert.ok(maxBytes < 100_000, `${mode}: ${maxBytes} bytes`);
    assert.ok(maxReads < 10_000, `${mode}: ${maxReads} reads`);
    assert.ok(maxReadBytes < LIMITS.verificationBytes, `${mode}: ${maxReadBytes} read bytes`);
    measurements.push({ mode, passes: mode === "mixed" ? passes * 2 : passes, maxRecords, maxBytes, maxReads, maxReadBytes });
    t.diagnostic(JSON.stringify(measurements.at(-1)));
  }
});

test("same UUID and PID cannot replace a private acquired immutable proof", { skip: process.platform !== "linux" }, (t) => {
  for (const change of [{ ownerHash: "b".repeat(64) }, { padding: "changed-after-acquisition" }]) {
    const home = fixture(t);
    nativePass(home);
    const registry = new ProviderHomeLeaseRegistry(owner);
    registry.acquireHome(home);
    const { root } = paths(home);
    const tipPath = fs.readdirSync(root).filter((name) => name.startsWith("next-")).map((name) => join(root, name))
      .find((path) => JSON.parse(fs.readFileSync(path, "utf8")).state === "active")!;
    const tip = JSON.parse(fs.readFileSync(tipPath, "utf8"));
    fs.writeFileSync(tipPath, `${JSON.stringify({ ...tip, ...change })}\n`);
    const changed = evidence(home);
    assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
    assert.equal(registry.releaseHome(home), false);
    assert.deepEqual(evidence(home), changed);
    const helperHome = fixture(t);
    nativePass(helperHome);
    const result = spawnSync("python3", ["-c", program(`
home_fd, _ = open_root(os.environ["HOME"])
lease = acquire_lease(home_fd, "${owner}")
root, lock, lease_id = lease
current, _ = read_owned_lease_chain(root, lock)
name = "next-%s.json" % current["previousLeaseId"]
current.update(${JSON.stringify(change)})
with open(name, "wb", opener=lambda path, flags: os.open(path, flags, dir_fd=root)) as stream: stream.write(lease_bytes(current))
directories = [fd_path(root), fd_path(lock)]
before = {os.path.join(directory, name): open(os.path.join(directory, name), "rb").read() for directory in directories for name in os.listdir(directory) if name != "mutable-home.lock"}
try: release_lease(lease)
except RuntimeError as error:
    assert "changed before release" in str(error), str(error)
    print("immutable acquired proof refused")
else: raise AssertionError("rewritten acquired proof was released")
after = {os.path.join(directory, name): open(os.path.join(directory, name), "rb").read() for directory in directories for name in os.listdir(directory) if name != "mutable-home.lock"}
assert after == before, "refusal changed evidence"
os.close(home_fd)`)], { env: { ...process.env, HOME: helperHome }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /immutable acquired proof refused/);
    // A helper refusal leaves its rewritten active tip and no released successor.
    assert.ok(fs.readdirSync(paths(helperHome).root).filter((name) => name.startsWith("next-")).map((name) =>
      JSON.parse(fs.readFileSync(join(paths(helperHome).root, name), "utf8"))).some((record) => record.state === "active" && Object.entries(change).every(([key, value]) => value === record[key])));
  }
});

// Keep the original aggregate budgets and give each named case a 45s budget
// (normal cases measured 2-6s). Report the active phase on cancellation.
function crashPhases(t: TestContext) {
  let active: { name: string; started: number } | undefined;
  const interrupted = () => {
    // A completed/cancelled node:test context can discard late diagnostics.
    // Emit at abort time so the stalled phase survives cancellation reporting.
    if (active) console.error(`[lease-crash] ${t.name}: interrupted during ${active.name} after ${Math.round(performance.now() - active.started)}ms`);
  };
  t.signal.addEventListener("abort", interrupted, { once: true });
  t.after(() => t.signal.removeEventListener("abort", interrupted));
  return async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    t.signal.throwIfAborted();
    active = { name, started: performance.now() };
    try { return await run(); }
    catch (cause) { throw new Error(`${t.name}: ${name} failed after ${Math.round(performance.now() - active.started)}ms`, { cause }); }
    finally {
      t.diagnostic(`${t.name}: ${name} ${Math.round(performance.now() - active.started)}ms`);
      active = undefined;
    }
  };
}

function crashWriter(t: Pick<TestContext, "signal" | "after">, home: string, command: string, args: string[], reapers: Array<() => Promise<void>> = []) {
  t.signal.throwIfAborted();
  const child = spawn(command, args, { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const capture = (chunk: Buffer) => { output = (output + String(chunk)).slice(-8192); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  child.on("error", error => capture(Buffer.from(String(error))));
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let reaping: Promise<void> | undefined;
  const reap = () => reaping ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  })();
  reapers.push(reap);
  t.after(reap);
  return { child, output: () => output };
}

function recoveredHandoffs(home: string, passes: number) {
  const before = fs.readFileSync(paths(home).anchor);
  // Repeated native passes account for most fixture time. Exercise the same
  // number of real handoffs in one Python process, then read/release natively.
  // The separate long-run matrix still covers 64 native/helper/mixed passes.
  const result = spawnSync("python3", ["-c", program(`
home_fd, _ = open_root(os.environ["HOME"])
try:
    for _ in range(${passes - 1}):
        lease = acquire_lease(home_fd, "${owner}")
        release_lease(lease)
        assert not diagnostics, diagnostics
finally: os.close(home_fd)
print(${passes - 1})`)], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(String(result.stdout).trim(), String(passes - 1), "every subsequent helper handoff completed");
  assert.equal(nativePass(home).getDiagnostics().length, 0, "native reader accepts the recovered and compacted journal");
  assert.notDeepEqual(fs.readFileSync(paths(home).anchor), before, "subsequent handoffs complete another checkpoint");
}

test("crash fixture refuses a writer after cancellation between phases", { skip: process.platform !== "linux" }, (t) => {
  const reapers: Array<() => Promise<void>> = [];
  const home = fixture(t, reapers);
  const cancelled = new AbortController();
  const reason = new Error("fixture cancelled between writers");
  cancelled.abort(reason);
  // Model the same late call after an awaited kill phase. Keep real teardown
  // registered on the parent so a reverted spawn guard cannot leak the probe.
  const context = { signal: cancelled.signal, after: t.after.bind(t) };
  assert.throws(() => crashWriter(context, home, process.execPath,
    ["-e", "setInterval(() => {}, 1000)"], reapers), error => error === reason);
});

test("crash fixture teardown reaps an unfinished writer before returning", { skip: process.platform !== "linux" }, async (t) => {
  const reapers: Array<() => Promise<void>> = [];
  const home = fixture(t, reapers);
  let writer: ChildProcess | undefined;
  await t.test("unfinished synthetic writer", (t) => {
    writer = crashWriter(t, home, "python3", ["-c", "import time; time.sleep(60)"], reapers).child;
  });
  assert.equal(writer!.signalCode, "SIGKILL");
});

test("crash fixture parent awaits writer close before removing HOME", { skip: process.platform !== "linux" }, async (t) => {
  const reapers: Array<() => Promise<void>> = [];
  const parentHooks: Array<() => Promise<void>> = [];
  // Run the real fixture's parent hook first, as node:test does on a parent timeout.
  const parent = { after: (hook: () => Promise<void>) => { parentHooks.push(hook); } };
  const home = fixture(parent, reapers);
  t.after(() => parentHooks[0]!());
  const { child } = crashWriter(t, home, "python3", ["-c", "import time; time.sleep(60)"], reapers);
  let homeExistedAtClose = false;
  child.once("close", () => { homeExistedAtClose = fs.existsSync(home); });
  await parentHooks[0]!();
  assert.equal(child.signalCode, "SIGKILL", "parent cleanup reaps its writer");
  assert.equal(homeExistedAtClose, true, "HOME exists until the writer has closed");
  assert.equal(fs.existsSync(home), false);
});

test("SIGKILL at every native/helper checkpoint boundary recovers across readers", { timeout: 180_000, skip: process.platform !== "linux" }, async (t) => {
  for (const writer of ["native", "helper"] as const) for (const boundary of boundaries) {
    // Parent teardown removes HOME only after the child's async teardown reaps its writer.
    if (t.signal.aborted) return;
    const reapers: Array<() => Promise<void>> = [];
    const home = fixture(t, reapers);
    await t.test(`${writer}/${boundary}`, { timeout: 45_000 }, async (t) => {
      const phase = crashPhases(t);
      await phase("seed", () => seed(home));
      const marker = join(home, "ready");
      const script = join(home, "writer.mts");
      fs.writeFileSync(script, `import { ProviderHomeLeaseRegistry } from ${JSON.stringify(nativeModule)};\nimport { writeFileSync } from "node:fs";\nconst registry = new ProviderHomeLeaseRegistry(${JSON.stringify(owner)}, { nativeCheckpointBarrierForTest: { boundary: ${JSON.stringify(boundary)}, marker: ${JSON.stringify(marker)} } });\nregistry.acquireHome(${JSON.stringify(home)});\nregistry.releaseAll();`);
      const helper = program(`
def checkpoint_boundary(stage):
    if stage == ${JSON.stringify(boundary)}:
        with open(${JSON.stringify(marker)}, "w") as stream: stream.write("ready")
        while True: time.sleep(1)
home_fd, _ = open_root(os.environ["HOME"])
lease = acquire_lease(home_fd, "${owner}")
release_lease(lease)
os.close(home_fd)`);
      const { child, output } = crashWriter(t, home, writer === "native" ? process.execPath : "python3",
        writer === "native" ? ["--import", "tsx", script] : ["-c", helper], reapers);
      await phase("writer barrier", () => ready(child, marker, output, t.signal));
      await phase("live-owner refusal and evidence preservation", () => {
        const before = evidence(home);
        // While alive, the same owner and the other reader refuse; no implicit cleanup runs.
        assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/);
        assert.notEqual(helperPass(home).status, 0);
        assert.deepEqual(evidence(home), before);
      });
      await phase("kill writer", () => kill(child));
      await phase("cross-reader recovery", () => {
        if (writer === "native") {
          const recovered = helperPass(home);
          assert.equal(recovered.status, 0, `${writer}/${boundary}: ${String(recovered.stderr)}`);
        } else nativePass(home);
      });
      await phase("10 subsequent handoffs", () => recoveredHandoffs(home, 10));
      await phase("bounded storage and staging cleanup", () => {
        assert.ok(storage(home).records <= 36, `${writer}/${boundary} did not return to bounded storage`);
        assert.equal(fs.readdirSync(paths(home).root).filter((name) => name.includes("checkpoint.pending")).length, 0);
      });
    });
  }
});

test("repeated killed candidate publishers recover without exhausting bounded staging", { timeout: 120_000, skip: process.platform !== "linux" }, async (t) => {
  for (const sequence of [["native", "native"], ["helper", "helper"], ["native", "helper"], ["helper", "native"]]) {
    if (t.signal.aborted) return;
    const reapers: Array<() => Promise<void>> = [];
    const home = fixture(t, reapers);
    await t.test(sequence.join("/"), { timeout: 45_000 }, async (t) => {
      const phase = crashPhases(t);
      await phase("seed", () => seed(home));
      for (const [index, writer] of sequence.entries()) {
        t.signal.throwIfAborted();
        const marker = join(home, "ready");
        fs.rmSync(marker, { force: true });
        const script = join(home, "writer.mts");
        fs.writeFileSync(script, `import { ProviderHomeLeaseRegistry } from ${JSON.stringify(nativeModule)};\nimport { writeFileSync } from "node:fs";\nnew ProviderHomeLeaseRegistry(${JSON.stringify(owner)}, { nativeCheckpointBarrierForTest: { boundary: "candidate-durable", marker: ${JSON.stringify(marker)} } }).acquireHome(${JSON.stringify(home)});`);
        const helper = program(`
def checkpoint_boundary(stage):
    if stage == "candidate-durable":
        with open(${JSON.stringify(marker)}, "w") as stream: stream.write("ready")
        while True: time.sleep(1)
home_fd, _ = open_root(os.environ["HOME"])
acquire_lease(home_fd, "${owner}")`);
        const { child, output } = crashWriter(t, home, writer === "native" ? process.execPath : "python3",
          writer === "native" ? ["--import", "tsx", script] : ["-c", helper], reapers);
        await phase(`writer ${index + 1} (${writer}) candidate-durable barrier`, () => ready(child, marker, output, t.signal));
        await phase(`kill writer ${index + 1} (${writer})`, () => kill(child));
      }
      await phase("native recovery", () => {
        assert.equal(nativePass(home).getDiagnostics().length, 0, `${sequence.join("/")} must recover completed candidates`);
      });
      await phase("64 subsequent handoffs", () => recoveredHandoffs(home, 64));
      await phase("bounded storage and staging cleanup", () => {
        assert.ok(storage(home).records <= 36);
        assert.equal(fs.readdirSync(paths(home).root).filter((name) => name.includes("checkpoint.pending")).length, 0);
      });
    });
  }
});

test("unavailable native/helper checkpoints cap growth and reserve release without changing old evidence", { skip: process.platform !== "linux" }, (t) => {
  for (const mode of ["native", "helper"] as const) {
    const home = fixture(t);
    let messages = 0;
    const helper = WSL_SKILLS_HELPER.replace('def checkpoint_boundary(boundary):\n    pass', 'def checkpoint_boundary(boundary):\n    if boundary == "before-candidate": fail("unavailable test filesystem")');
    let before!: Map<string, string>;
    for (let i = 0; i < 16; i++) {
      if (mode === "native") {
        const registry = nativePass(home, { disableCompactionForTest: true, onDiagnostic: () => messages++ });
        assert.equal(registry.getDiagnostics().length, 1);
      } else {
        const result = helperPass(home, "", helper);
        assert.equal(result.status, 0, String(result.stderr));
      }
      if (i === 0) before = evidence(home);
    }
    for (const [path, hash] of before) assert.equal(createHash("sha256").update(fs.readFileSync(path)).digest("hex"), hash);
    const reservation = new ProviderHomeLeaseRegistry(owner, { disableCompactionForTest: true });
    assert.throws(() => reservation.acquireHome(home), /bounded catch-up/);
    // A legacy journal permits one bounded private reservation for migration. No HOME is
    // granted until catch-up succeeds, and retrying that token appends no further records.
    const atCap = evidence(home);
    assert.throws(() => reservation.acquireHome(home), /bounded catch-up/);
    assert.notEqual(helperPass(home, "", helper).status, 0);
    assert.deepEqual(evidence(home), atCap);
    assert.equal(fs.readdirSync(paths(home).root).filter((name) => name.startsWith("next-")).length, 32);
    if (mode === "native") assert.equal(messages, 16);
  }
});

test("checkpoint proof rejects arbitrary traversal manifests in both readers without changing evidence", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t);
  seed(home, 9);
  const anchor = fs.readFileSync(paths(home).anchor, "utf8");
  verifyLeaseCheckpointForTest(anchor);
  fc.assert(fc.property(fc.string({ maxLength: 128 }), (segment) => {
    const value = JSON.parse(anchor);
    const proof = value.checkpoint;
    const tip = JSON.parse(proof.previousTip);
    // Keep the mandatory previous-tip witness intact so only the name guard rejects this proof.
    const entry = proof.retired.find((item: { directory: string; name: string }) =>
      item.directory !== "root" || item.name !== `next-${tip.previousLeaseId}.json`);
    assert.ok(entry);
    entry.name = `../${segment}`;
    proof.historyHash = createHash("sha256").update(JSON.stringify([
      proof.previousHistoryHash, proof.previousAnchorHash, proof.previousTipHash, proof.guardHash,
      proof.guardDevice, proof.guardInode, proof.migration,
      proof.retired.map((item: { directory: string; name: string; hash: string; device: string; inode: string }) =>
        [item.directory, item.name, item.hash, item.device, item.inode]),
    ])).digest("hex");
    const raw = `${JSON.stringify(value)}\n`;
    assert.throws(() => verifyLeaseCheckpointForTest(raw), /unexpected/);
    const helperProof = spawnSync("python3", ["-c", program(`value=json.loads(${JSON.stringify(JSON.stringify(value))})\nverify_checkpoint(value)\n`)], { encoding: "utf8", timeout: 10_000 });
    assert.notEqual(helperProof.status, 0);
    assert.match(helperProof.stderr, /checkpoint manifest is invalid/);
    fs.writeFileSync(paths(home).anchor, raw);
    const before = evidence(home);
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /unexpected|cannot be verified/);
    assert.notEqual(helperPass(home).status, 0);
    assert.deepEqual(evidence(home), before);
  }), { numRuns: 20 });
});

test("the fixed retirement witness accepts only exact currently committed tuples in both validators", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t), { root, lock } = paths(home);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  const alias = join(root, ".mutable-home.retired"), source = join(root, `next-${randomUUID()}.json`);
  const raw = () => `${JSON.stringify({ version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(),
    previousLeaseId: null, previousRecordHash: null, pid: process.pid, hostname: hostname(), provider: "skills", createdAt: "2026-10-01" })}\n`;
  fs.writeFileSync(alias, raw(), { mode: 0o600 }); fs.writeFileSync(source, raw(), { mode: 0o600 });
  const snapshot = readLeaseIoSnapshot(root);
  const retired = snapshot.entries.map(entry => ({ directory: entry.directory, name: entry.name, device: entry.device, inode: entry.inode,
    hash: createHash("sha256").update(entry.raw).digest("hex") }));
  const helper = (code = "") => spawnSync("python3", ["-c", program(`root=os.open(${JSON.stringify(root)},os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\nlock=child_dir(root,"mutable-home.lock")\nretired=json.loads(${JSON.stringify(JSON.stringify(retired))})\n${code}\nverify_retired(root,lock,retired)\nos.close(lock);os.close(root)\n`)], { encoding: "utf8", timeout: 10_000 });
  verifyLeaseRetirementForTest(snapshot, retired); assert.equal(helper().status, 0);
  fs.renameSync(source, alias);
  verifyLeaseRetirementForTest(readLeaseIoSnapshot(root), retired);
  assert.equal(helper().status, 0, "moving another current manifest source into the fixed witness is valid");
  const bytes = fs.readFileSync(alias);
  for (const scenario of ["body", "inode", "uncommitted", "symlink"]) {
    const replacement = join(home, `replacement-${scenario}`);
    if (scenario === "body") fs.appendFileSync(alias, " ");
    else if (scenario === "symlink") { fs.renameSync(alias, replacement); fs.symlinkSync(replacement, alias); }
    else { fs.writeFileSync(replacement, scenario === "inode" ? bytes : raw(), { mode: 0o600 }); fs.renameSync(replacement, alias); }
    const before = fs.readFileSync(alias);
    assert.throws(() => verifyLeaseRetirementForTest(readLeaseIoSnapshot(root), retired));
    assert.notEqual(helper().status, 0, scenario);
    assert.deepEqual(fs.readFileSync(alias), before, "refusal did not delete or reset the witness");
    if (scenario === "body") fs.writeFileSync(alias, bytes);
    else if (scenario === "symlink") { fs.unlinkSync(alias); fs.renameSync(replacement, alias); }
    // Re-establish a proof for the deliberately replaced fixture inode before the next case.
    const current = fs.lstatSync(alias, { bigint: true });
    const tuple = retired.find(entry => entry.name !== ".mutable-home.retired")!;
    tuple.device = String(current.dev); tuple.inode = String(current.ino); tuple.hash = createHash("sha256").update(fs.readFileSync(alias)).digest("hex");
  }
  assert.equal(helper().status, 0, "the final named-identity race begins with a valid committed fixture");
  const replacement = join(home, "changed-during-read"); fs.writeFileSync(replacement, fs.readFileSync(alias), { mode: 0o600 });
  const changed = helper(`original_read=read_lease_record\ndef replaced_read(directory,name,*args):\n    result=original_read(directory,name,*args)\n    if name==".mutable-home.retired": os.replace(${JSON.stringify(replacement)},${JSON.stringify(alias)})\n    return result\nread_lease_record=replaced_read`);
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /retirement identity changed/);
  assert.equal(fs.existsSync(alias), true);
});

test("compaction preserves partial historical evidence and both readers refuse a changed retained digest", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t);
  const { lock } = paths(home);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  const previous = randomUUID();
  const retained = join(lock, `next-${previous}.json`);
  assert.throws(() => process.kill(999_999, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  fs.writeFileSync(retained, `${JSON.stringify({ version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(),
    previousLeaseId: previous, previousRecordHash: "b".repeat(64), pid: 999_999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01" })}\n`, { mode: 0o600 });
  const bytes = fs.readFileSync(retained);
  seed(home, 24);
  assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 4);
  assert.deepEqual(fs.readFileSync(retained), bytes);
  assert.equal(helperPass(home).status, 0);
  fs.appendFileSync(retained, " ");
  const before = evidence(home);
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /unexpected|cannot be verified/);
  assert.notEqual(helperPass(home).status, 0);
  assert.deepEqual(evidence(home), before);
});

test("selected checkpoints refuse damaged guards, proofs, resurrected identities, links, and exhausted storage", { skip: process.platform !== "linux" }, (t) => {
  for (const mutation of ["guard-bytes", "guard-missing", "guard-link", "proof", "new-version", "retired-inode", "retired-link", "storage", "oversized-stage"]) {
    const home = fixture(t);
    seed(home, 9);
    const { root, lock, anchor } = paths(home);
    const value = JSON.parse(fs.readFileSync(anchor, "utf8"));
    const guard = join(lock, "protocol-v4.json");
    if (mutation === "guard-bytes") fs.appendFileSync(guard, " ");
    if (mutation === "guard-missing") fs.unlinkSync(guard);
    if (mutation === "guard-link") { fs.renameSync(guard, join(home, "guard")); fs.symlinkSync(join(home, "guard"), guard); }
    if (mutation === "proof") { value.checkpoint.historyHash = "f".repeat(64); fs.writeFileSync(anchor, JSON.stringify(value)); }
    if (mutation === "new-version") { value.version = 5; fs.writeFileSync(anchor, JSON.stringify(value)); }
    if (mutation === "retired-inode" || mutation === "retired-link") {
      const entry = value.checkpoint.retired.find((entry: { directory: string }) => entry.directory === "root");
      const path = join(root, entry.name);
      if (mutation === "retired-link") fs.symlinkSync(anchor, path);
      else fs.writeFileSync(path, value.checkpoint.previousTip, { mode: 0o600 });
    }
    if (mutation === "storage") for (let i = 0; i < LIMITS.directoryEntries; i++) {
      fs.writeFileSync(join(root, `.provider-home-lease-${randomUUID()}.tmp`), "{}", { mode: 0o600 });
    }
    if (mutation === "oversized-stage") fs.writeFileSync(join(root, ".mutable-home.checkpoint.pending"), "x".repeat(LIMITS.checkpointBytes + 1), { mode: 0o600 });
    const before = evidence(home);
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /unsafe|unexpected|limit|cap|verified/);
    assert.notEqual(helperPass(home).status, 0, mutation);
    assert.deepEqual(evidence(home), before, mutation);
  }
});

test("same-PID registries cannot adopt checkpoint cleanup authority and metadata ancestry links refuse", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t);
  seed(home, 9);
  const registry = new ProviderHomeLeaseRegistry(owner);
  registry.acquireHome(home);
  const before = evidence(home);
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/);
  assert.deepEqual(evidence(home), before);
  assert.equal(registry.releaseHome(home), true);
  const outside = fixture(t);
  fs.renameSync(join(home, ".agent-manager"), join(outside, "metadata"));
  fs.symlinkSync(join(outside, "metadata"), join(home, ".agent-manager"));
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /unsafe.*ancestry/);
  assert.notEqual(helperPass(home).status, 0);
});

test("real native and helper contenders elect one owner on a compacted chain", { skip: process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const home = fixture(t);
  seed(home, 9);
  const gate = join(home, "go");
  const finish = join(home, "finish");
  const nativeReady = join(home, "native-ready");
  const helperReady = join(home, "helper-ready");
  const nativeResult = join(home, "native-result");
  const helperResult = join(home, "helper-result");
  const script = join(home, "contender.mts");
  fs.writeFileSync(script, `import { ProviderHomeLeaseRegistry } from ${JSON.stringify(nativeModule)};\nimport { existsSync, writeFileSync } from "node:fs";\nconst wait = (path) => { while (!existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };\nconst registry = new ProviderHomeLeaseRegistry(${JSON.stringify(owner)}, { beforeTransitionPublishForTest: () => { writeFileSync(${JSON.stringify(nativeReady)}, "ready"); wait(${JSON.stringify(gate)}); } });\ntry { registry.acquireHome(${JSON.stringify(home)}); writeFileSync(${JSON.stringify(nativeResult)}, "won"); wait(${JSON.stringify(finish)}); registry.releaseAll(); } catch { writeFileSync(${JSON.stringify(nativeResult)}, "lost"); }`);
  const code = program(`
original_publish = publish_lease
def publish_lease(root, lock, target, value):
    if target.startswith("next-") and value.get("state") == "active":
        with open(${JSON.stringify(helperReady)}, "w") as stream: stream.write("ready")
        while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)
    return original_publish(root, lock, target, value)
home_fd, _ = open_root(os.environ["HOME"])
try: lease = acquire_lease(home_fd, "${owner}")
except:
    with open(${JSON.stringify(helperResult)}, "w") as stream: stream.write("lost")
else:
    with open(${JSON.stringify(helperResult)}, "w") as stream: stream.write("won")
    while not os.path.exists(${JSON.stringify(finish)}): time.sleep(0.01)
    release_lease(lease)
os.close(home_fd)`);
  const children = [spawn(process.execPath, ["--import", "tsx", script]), spawn("python3", ["-c", code], { env: { ...process.env, HOME: home } })];
  let output = "";
  for (const child of children) {
    child.stderr?.on("data", (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  }
  await Promise.all([ready(children[0]!, nativeReady, () => output), ready(children[1]!, helperReady, () => output)]);
  fs.writeFileSync(gate, "go");
  await Promise.all([ready(children[0]!, nativeResult, () => output), ready(children[1]!, helperResult, () => output)]);
  const results = [nativeResult, helperResult].map((path) => fs.readFileSync(path, "utf8")).sort();
  assert.deepEqual(results, ["lost", "won"]);
  const ended = children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => child.once("close", () => resolve())));
  fs.writeFileSync(finish, "go");
  await Promise.all(ended);
  nativePass(home);
  assert.equal(helperPass(home).status, 0);
});

test("retained evidence stays within the complete checkpoint work budget", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t);
  const { lock } = paths(home);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  for (let i = 0; i < LIMITS.retainedEntries; i++) {
    const previous = randomUUID();
    fs.writeFileSync(join(lock, `next-${previous}.json`), `${JSON.stringify({ version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(),
      previousLeaseId: previous, previousRecordHash: "b".repeat(64), pid: 999_999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01",
      padding: "p".repeat(3500) })}\n`, { mode: 0o600 });
  }
  const retained = new Map(fs.readdirSync(lock).map((name) => [join(lock, name), fs.readFileSync(join(lock, name), "utf8")]));
  let diagnostics = 0;
  for (let i = 0; i < 12; i++) nativePass(home, { onDiagnostic: () => diagnostics++ });
  assert.equal(diagnostics, 0, "retained evidence stays within the configured complete-attempt work budget");
  for (const [path, raw] of retained) assert.equal(fs.readFileSync(path, "utf8"), raw);
  assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 4);
  assert.equal(helperPass(home).status, 0);
  assert.ok(storage(home).records < LIMITS.retainedEntries + 72);
});

function oldCanonicalJournal(home: string, transitions: number) {
  const { root, lock, anchor } = paths(home);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  let previous = { version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(), previousLeaseId: null as string | null,
    previousRecordHash: null as string | null, recoveredEntriesHash: createHash("sha256").update("[]").digest("hex") as string | undefined,
    pid: 999999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01", padding: "p".repeat(3300) };
  let raw = `${JSON.stringify(previous)}\n`;
  fs.writeFileSync(anchor, raw, { mode: 0o600 });
  fs.linkSync(anchor, join(lock, "checkpoint.json")); fs.linkSync(anchor, join(lock, `lease-${previous.leaseId}.json`));
  for (let index = 0; index < transitions; index++) {
    const next = { ...previous, recoveredEntriesHash: undefined, state: index % 2 === 0 ? "released" : "active", leaseId: randomUUID(),
      previousLeaseId: previous.leaseId, previousRecordHash: createHash("sha256").update(raw).digest("hex") };
    raw = `${JSON.stringify(next)}\n`;
    const name = `next-${previous.leaseId}.json`;
    fs.writeFileSync(join(root, name), raw, { mode: 0o600 }); fs.linkSync(join(root, name), join(lock, name));
    previous = next;
  }
}

test("pending migration still withholds HOME after checkpoint selection until exact retry reports success", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t); oldCanonicalJournal(home, 64);
  const registry = new ProviderHomeLeaseRegistry(owner);
  const transaction = registry as unknown as { compactHeld(root: string, lock: string, leaseId: string): boolean };
  const compact = transaction.compactHeld.bind(registry); let attempts = 0;
  transaction.compactHeld = (...args) => {
    if (attempts++ === 0) assert.equal(compact(...args), true, "select the real checkpoint before simulating a lost completion");
    return false;
  };
  assert.throws(() => registry.acquireHome(home), /bounded catch-up/);
  assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 4);
  const before = evidence(home);
  assert.throws(() => registry.acquireHome(home), /bounded catch-up/, "selected checkpoint cannot clear the pending migration obligation");
  assert.deepEqual(evidence(home), before);
  transaction.compactHeld = compact;
  assert.equal(registry.acquireHome(home), true); assert.equal(registry.releaseHome(home), true);
});

/** Migration retires every legacy record with an unlink and a directory fsync, all inside one
 * fixed-helper call. On a disk shared with other builds that fsync latency, not lease behavior,
 * decided whether the call fit its 120-second deadline (#2335). tmpfs keeps every lease rule and
 * makes the fsyncs free; the fallback stays correct, only slower. The fixtures peak near 45 MB
 * and 8,200 inodes (both refusal journals stay until the test ends, one 4 KiB page per record),
 * so a small container /dev/shm falls back rather than failing with ENOSPC. */
function memoryBackedParent(): string {
  try {
    const volume = fs.statfsSync("/dev/shm", { bigint: true });
    if (volume.type === 0x01021994n && volume.bavail * volume.bsize >= 128n * 1024n * 1024n && volume.ffree >= 32_768n) {
      fs.accessSync("/dev/shm", fs.constants.W_OK | fs.constants.X_OK); return "/dev/shm";
    }
  } catch { /* fall back to the ordinary temporary directory */ }
  return tmpdir();
}

test("bounded migration catches up legacy journals at the admission bound and refuses one above unchanged", { timeout: 300_000, skip: process.platform !== "linux" }, (t) => {
  const parent = memoryBackedParent();
  const pythonTimeoutMs = 120_000;
  for (const writer of ["native", "helper"] as const) for (const transitions of [64, 512, LIMITS.migrationEntries - 6]) {
    const home = fixture(t, [], parent); oldCanonicalJournal(home, transitions);
    const started = performance.now();
    const maximum = { records: 0, bytes: 0 };
    // Every step reports its timing even when it fails, so a fixed-helper or Python-writer call
    // killed at its deadline on a slow host reads differently from a missing helper.
    const calls: LeaseIoRun[] = [];
    let python: { durationMs: number; timeoutMs: number; status: number | null; signal: string | null; error?: string } | undefined;
    let outcome = "failed";
    observeLeaseIoRunsForTest((run) => calls.push(run));
    try {
      if (writer === "native") {
        observeLeaseVerificationWorkForTest((work) => { maximum.records = Math.max(maximum.records, work.records); maximum.bytes = Math.max(maximum.bytes, work.bytes); });
        try { assert.deepEqual(nativePass(home, { onCheckpointFailureForTest: (error) => { throw error; } }).getDiagnostics(), []); } finally { observeLeaseVerificationWorkForTest(); }
      } else {
        const pythonStarted = performance.now();
        const finished = (exit: { status: number | null; signal: string | null; error?: string }) => {
          python = { durationMs: Math.round(performance.now() - pythonStarted), timeoutMs: pythonTimeoutMs, ...exit };
        };
        let result: ReturnType<typeof helperPass>;
        // The bounded spawnSync throws ETIMEDOUT instead of returning it; record the exit either way.
        try {
          result = helperPass(home, `
original_spend = spend_verification_work
maximum = {"records": 0, "bytes": 0}
def measured_spend(records, byte_count):
    original_spend(records, byte_count)
    if verification_work is not None:
        for key in maximum: maximum[key] = max(maximum[key], verification_work[key])
spend_verification_work = measured_spend
import atexit
atexit.register(lambda: print(json.dumps(maximum)))`, WSL_SKILLS_HELPER, pythonTimeoutMs);
        } catch (error) { finished({ status: null, signal: null, error: (error as NodeJS.ErrnoException).code }); throw error; }
        finished({ status: result.status, signal: result.signal, error: (result.error as NodeJS.ErrnoException | undefined)?.code });
        assert.equal(result.status, 0, String(result.stderr)); Object.assign(maximum, JSON.parse(String(result.stdout)));
      }
      assert.ok(maximum.records > 0 && maximum.records <= LIMITS.verificationRecords);
      assert.ok(maximum.bytes > 0 && maximum.bytes <= LIMITS.verificationBytes);
      assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 4);
      assert.ok(storage(home).records <= 5);
      assert.equal(helperPass(home).status, 0); nativePass(home);
      outcome = "passed";
    } finally {
      observeLeaseIoRunsForTest();
      const slowest = calls.reduce<LeaseIoRun | undefined>((found, call) => (!found || call.durationMs > found.durationMs ? call : found), undefined);
      t.diagnostic(JSON.stringify({ writer, legacyTransitions: transitions, outcome, fixtureParent: parent, durationMs: Math.round(performance.now() - started),
        helperCalls: calls.length, helperDeadlinesExceeded: calls.filter((call) => call.error === "ETIMEDOUT").length,
        slowestHelperCall: slowest && { ...slowest, durationMs: Math.round(slowest.durationMs) },
        ...(python && { pythonWriter: { ...python, deadlineExceeded: python.error === "ETIMEDOUT" } }),
        verificationWork: maximum, ...(outcome === "passed" && storage(home)) }));
    }
  }
  for (const writer of ["native", "helper"] as const) {
    const home = fixture(t, [], parent); oldCanonicalJournal(home, LIMITS.migrationEntries - 5);
    const before = evidence(home);
    if (writer === "native") assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /storage cap/);
    else assert.notEqual(helperPass(home).status, 0);
    assert.deepEqual(evidence(home), before);
  }
});

test("physical snapshot refuses an exhausted remaining budget without changing evidence", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t); seed(home, 9);
  const before = evidence(home);
  assert.throws(() => readLeaseIoSnapshot(paths(home).root, { records: 0, bytes: 0 }), /work limit/);
  assert.deepEqual(evidence(home), before);
  assert.throws(() => readLeaseIoSnapshot(paths(home).root, { records: LIMITS.verificationRecords, bytes: 0 }), /work limit/);
  assert.deepEqual(evidence(home), before);
});
