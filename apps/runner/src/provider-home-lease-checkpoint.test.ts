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
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { LEASE_CHECKPOINT_LIMITS as LIMITS } from "./provider-home-lease-checkpoint.js";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const owner = "a".repeat(64);
const nativeModule = new URL("./provider-home-lease.ts", import.meta.url).href;
const boundaries = ["before-guard", "guard-temp-written", "guard-file-durable", "guard-published", "guard-durable", "before-candidate", "candidate-written", "candidate-file-durable", "candidate-durable", "before-selection", "selection-published", "selection-durable", "before-retire", "after-retire", "retirement-durable"];

function fixture(t: TestContext): string {
  const home = fs.mkdtempSync(join(tmpdir(), "wollipog-canonical-checkpoint-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function paths(home: string) {
  const root = join(home, ".agent-manager/provider-home-leases-v1");
  return { root, lock: join(root, "mutable-home.lock"), anchor: join(root, "mutable-home.recovery.json") };
}
function nativePass(home: string, options: ConstructorParameters<typeof ProviderHomeLeaseRegistry>[1] = {}) {
  const registry = new ProviderHomeLeaseRegistry(owner, options);
  registry.acquireHome(home);
  assert.equal(registry.releaseHome(home), true);
  return registry;
}
function seed(home: string, passes = 8) {
  for (let i = 0; i < passes; i++) nativePass(home);
}
function program(code: string, helper = WSL_SKILLS_HELPER): string {
  const boundary = helper.lastIndexOf("\ntry:\n    main(bounded_json())");
  assert.ok(boundary > 0);
  return `${helper.slice(0, boundary)}\n${code}\n`;
}
function helperPass(home: string, code = "", helper = WSL_SKILLS_HELPER) {
  const result = spawnSync("python3", ["-c", program(`${code}\nhome_fd, _ = open_root(os.environ["HOME"])\nlease = acquire_lease(home_fd, "${owner}")\nrelease_lease(lease)\nos.close(home_fd)`, helper)],
    { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000 });
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
async function ready(child: ChildProcess, path: string, output: () => string) {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(path)) {
    assert.equal(child.exitCode, null, output());
    assert.ok(Date.now() < deadline, `barrier timeout: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function kill(child: ChildProcess) {
  const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await ended;
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
def measured(directory, name, max_links=2):
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
      } finally { fs.readSync = original; syncBuiltinESMExports(); }
    }
    assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 3);
    assert.ok(maxRecords <= 36, `${mode}: ${maxRecords} records`);
    assert.ok(maxBytes < 100_000, `${mode}: ${maxBytes} bytes`);
    assert.ok(maxReads < 10_000, `${mode}: ${maxReads} reads`);
    assert.ok(maxReadBytes < 10_000_000, `${mode}: ${maxReadBytes} read bytes`);
    measurements.push({ mode, passes: mode === "mixed" ? passes * 2 : passes, maxRecords, maxBytes, maxReads, maxReadBytes });
    t.diagnostic(JSON.stringify(measurements.at(-1)));
  }
  fs.writeFileSync("/tmp/issue2239-checkpoint-measurements.json", JSON.stringify(measurements, null, 2));
});

test("SIGKILL at every native/helper checkpoint boundary recovers across readers", { timeout: 180_000, skip: process.platform !== "linux" }, async (t) => {
  for (const writer of ["native", "helper"] as const) for (const boundary of boundaries) {
    const home = fixture(t);
    seed(home);
    const marker = join(home, "ready");
    let output = "";
    const hold = `if (stage === ${JSON.stringify(boundary)}) { writeFileSync(${JSON.stringify(marker)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }`;
    const script = join(home, "writer.mts");
    fs.writeFileSync(script, `import { ProviderHomeLeaseRegistry } from ${JSON.stringify(nativeModule)};\nimport { writeFileSync } from "node:fs";\nconst registry = new ProviderHomeLeaseRegistry(${JSON.stringify(owner)}, { checkpointBoundaryForTest: (stage) => { ${hold} } });\nregistry.acquireHome(${JSON.stringify(home)});\nregistry.releaseAll();`);
    const helper = program(`
def checkpoint_boundary(stage):
    if stage == ${JSON.stringify(boundary)}:
        with open(${JSON.stringify(marker)}, "w") as stream: stream.write("ready")
        while True: time.sleep(1)
home_fd, _ = open_root(os.environ["HOME"])
lease = acquire_lease(home_fd, "${owner}")
release_lease(lease)
os.close(home_fd)`);
    const child = writer === "native" ? spawn(process.execPath, ["--import", "tsx", script]) :
      spawn("python3", ["-c", helper], { env: { ...process.env, HOME: home } });
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await ready(child, marker, () => output);
    const before = evidence(home);
    // While alive, the same owner and the other reader refuse; no implicit cleanup runs.
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/);
    assert.notEqual(helperPass(home).status, 0);
    assert.deepEqual(evidence(home), before);
    await kill(child);
    if (writer === "native") {
      const recovered = helperPass(home);
      assert.equal(recovered.status, 0, `${writer}/${boundary}: ${String(recovered.stderr)}`);
    } else nativePass(home);
    for (let i = 0; i < 10; i++) nativePass(home);
    assert.ok(storage(home).records <= 36, `${writer}/${boundary} did not return to bounded storage`);
    assert.equal(fs.readdirSync(paths(home).root).filter((name) => name.includes("checkpoint.pending")).length, 0);
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
    const atCap = evidence(home);
    assert.throws(() => new ProviderHomeLeaseRegistry(owner, { disableCompactionForTest: true }).acquireHome(home), /growth cap/);
    assert.notEqual(helperPass(home, "", helper).status, 0);
    assert.deepEqual(evidence(home), atCap);
    assert.equal(fs.readdirSync(paths(home).root).filter((name) => name.startsWith("next-")).length, 31);
    if (mode === "native") assert.equal(messages, 16);
  }
});

test("checkpoint proof rejects arbitrary traversal manifests in both readers without changing evidence", { skip: process.platform !== "linux" }, (t) => {
  const home = fixture(t);
  seed(home, 9);
  const anchor = fs.readFileSync(paths(home).anchor, "utf8");
  fc.assert(fc.property(fc.string({ maxLength: 128 }), (segment) => {
    const value = JSON.parse(anchor);
    value.checkpoint.retired[0].name = `../${segment}`;
    fs.writeFileSync(paths(home).anchor, `${JSON.stringify(value)}\n`);
    const before = evidence(home);
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /unexpected|cannot be verified/);
    assert.notEqual(helperPass(home).status, 0);
    assert.deepEqual(evidence(home), before);
  }), { numRuns: 20 });
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
  assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 3);
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
    const guard = join(lock, "protocol-v3.json");
    if (mutation === "guard-bytes") fs.appendFileSync(guard, " ");
    if (mutation === "guard-missing") fs.unlinkSync(guard);
    if (mutation === "guard-link") { fs.renameSync(guard, join(home, "guard")); fs.symlinkSync(join(home, "guard"), guard); }
    if (mutation === "proof") { value.checkpoint.historyHash = "f".repeat(64); fs.writeFileSync(anchor, JSON.stringify(value)); }
    if (mutation === "new-version") { value.version = 4; fs.writeFileSync(anchor, JSON.stringify(value)); }
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

test("verification work exhaustion preserves checkpoint evidence and resumes bounded retirement", { skip: process.platform !== "linux" }, (t) => {
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
  assert.ok(diagnostics > 0, "the real verification byte budget interrupts expensive retirement");
  for (const [path, raw] of retained) assert.equal(fs.readFileSync(path, "utf8"), raw);
  assert.equal(JSON.parse(fs.readFileSync(paths(home).anchor, "utf8")).version, 3);
  assert.equal(helperPass(home).status, 0);
  assert.ok(storage(home).records < LIMITS.retainedEntries + 72);
});
