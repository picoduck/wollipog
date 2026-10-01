import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { SkillFile } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const owner = "a".repeat(64);
const firstDigest = "1".repeat(64);
const secondDigest = "2".repeat(64);

function invoke(home: string, specification: Record<string, unknown>, helper = WSL_SKILLS_HELPER): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", helper], {
      env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(specification));
  });
}

function instrumentHelper(before: string, after: string): string {
  assert.ok(WSL_SKILLS_HELPER.includes(before), "the crash test seam must match the fixed helper");
  return WSL_SKILLS_HELPER.replace(before, after);
}

function leaseProgram(code: string, helper = WSL_SKILLS_HELPER): string {
  const boundary = helper.lastIndexOf("\ntry:\n    main(bounded_json())");
  assert.ok(boundary > 0);
  return `${helper.slice(0, boundary)}\n${code}\n`;
}

function invokeLease(home: string, code: string): ReturnType<typeof spawnSync> {
  return spawnSync("python3", ["-c", leaseProgram(code)], {
    env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 5_000,
  });
}

const acquireAndRelease = `home_fd, _ = open_root(os.environ["HOME"])
lease = acquire_lease(home_fd, "${owner}")
release_lease(lease)
os.close(home_fd)
print("released")`;

test("native and helper first initializers elect one proof across deterministic interleavings", (t) => {
  for (const phase of ["before-proof", "after-proof"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-wsl-initializer-${phase}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = join(home, ".agent-manager/provider-home-leases-v1");
    let helper: ReturnType<typeof spawnSync> | undefined;
    const race = () => {
      helper = invokeLease(home, acquireAndRelease);
      if (phase === "before-proof") assert.equal(helper.status, 0, String(helper.stderr));
      else {
        assert.notEqual(helper.status, 0);
        assert.match(String(helper.stderr), /already in use.*quarantine the entire/s);
        assert.equal(existsSync(join(root, "mutable-home.lock")), false, "loser does not create mirrors");
      }
    };
    const native = new ProviderHomeLeaseRegistry(owner, {
      ...(phase === "before-proof" ? { beforeMarkerWriteForTest: race } : { afterInitializationPublishForTest: race }),
    });
    assert.equal(native.acquireHome(home), true);
    assert.ok(helper);
    const competing = invokeLease(home, acquireAndRelease);
    assert.notEqual(competing.status, 0, "the native winner excludes the helper");
    const proof = readFileSync(join(root, "mutable-home.recovery.json"));
    native.releaseAll();
    assert.equal(invokeLease(home, acquireAndRelease).status, 0, "orderly handoff remains usable");
    assert.deepEqual(readFileSync(join(root, "mutable-home.recovery.json")), proof);
  }
});

test("killed helper initialization is reclaimable by a new helper and native runner", async (t) => {
  for (const phase of ["before-directory", "empty-directory", "active"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-wsl-killed-${phase}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const ready = join(home, "ready");
    const before = phase === "before-directory" ? '            except FileExistsError: return acquire_external_lease(root, owner)\n'
      : phase === "empty-directory" ? '            lock = child_dir(root, "mutable-home.lock")\n            try:\n                mirror_external_lease(root, lock, "mutable-home.recovery.json", "checkpoint.json", True)\n'
        : '                return root, lock, value["leaseId"]\n';
    const indent = phase === "active" ? "                " : "            ";
    const helper = instrumentHelper(before, phase === "before-directory" ? `${before}${indent}hold()\n` : `${indent}hold()\n${before}`);
    const child = spawn("python3", ["-c", leaseProgram(`
def hold():
    with open(${JSON.stringify(ready)}, "w") as stream: stream.write(str(os.getpid()))
    while True: time.sleep(1)
home_fd, _ = open_root(os.environ["HOME"])
lease = acquire_lease(home_fd, "${owner}")
release_lease(lease)
`, helper)], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    t.after(() => { child.kill("SIGKILL"); });
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reported = existsSync(ready);
    const live = new ProviderHomeLeaseRegistry(owner);
    if (reported) assert.throws(() => live.acquireHome(home), /already in use.*quarantine the entire/s);
    child.kill("SIGKILL");
    await exited;
    assert.ok(reported, stderr);
    const foreign = invokeLease(home, acquireAndRelease.replace(owner, "b".repeat(64)));
    assert.notEqual(foreign.status, 0);
    assert.match(String(foreign.stderr), /another runner owner.*quarantine the entire/s);
    const replacement = invokeLease(home, acquireAndRelease);
    assert.equal(replacement.status, 0, String(replacement.stderr));
    assert.equal(live.acquireHome(home), true);
    live.releaseAll();
  }
});

test("a helper paused before proof publication loses cleanly to a live native initializer", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-wsl-proof-election-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ready = join(home, "ready");
  const resume = join(home, "resume");
  const helper = instrumentHelper(
    '            try: publish_lease(root, root, "mutable-home.recovery.json", value)\n',
    '            hold()\n            try: publish_lease(root, root, "mutable-home.recovery.json", value)\n',
  );
  const child = spawn("python3", ["-c", leaseProgram(`
def hold():
    with open(${JSON.stringify(ready)}, "w") as stream: stream.write("ready")
    while not os.path.exists(${JSON.stringify(resume)}): time.sleep(0.01)
${acquireAndRelease}
`, helper)], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  const deadline = Date.now() + 5_000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(ready), stderr);
  const native = new ProviderHomeLeaseRegistry(owner);
  assert.equal(native.acquireHome(home), true);
  const root = join(home, ".agent-manager/provider-home-leases-v1");
  const proof = readFileSync(join(root, "mutable-home.recovery.json"));
  writeFileSync(resume, "resume");
  assert.notEqual(await exited, 0);
  assert.match(stderr, /already in use.*quarantine the entire/s);
  assert.deepEqual(readFileSync(join(root, "mutable-home.recovery.json")), proof);
  native.releaseAll();
  assert.equal(invokeLease(home, acquireAndRelease).status, 0);
});

test("helper confirming reads tolerate completed mirrors and refuse changed canonical or mirror evidence", (t) => {
  for (const change of ["complete", "tip", "owner", "digest", "retained", "bytes", "malformed", "symlink", "oversized", "extra-link"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-wsl-mirror-${change}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = join(home, ".agent-manager/provider-home-leases-v1");
    const lock = join(root, "mutable-home.lock");
    const retainedName = "next-11111111-1111-4111-8111-111111111111.json";
    if (change === "retained") {
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(join(lock, retainedName), JSON.stringify({
        version: 2, state: "active", ownerHash: owner, leaseId: "22222222-2222-4222-8222-222222222222",
        previousLeaseId: "11111111-1111-4111-8111-111111111111", previousRecordHash: "c".repeat(64),
        pid: 2_147_483_647, hostname: hostname(), provider: "skills", createdAt: "2026-08-19T00:00:00.000Z",
      }));
    }
    const native = new ProviderHomeLeaseRegistry(owner, { isProcessAlive: () => false });
    native.acquireHome(home);
    native.releaseAll();
    const proof = JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8"));
    const releaseName = `next-${proof.leaseId}.json`;
    rmSync(join(lock, releaseName));
    const result = invokeLease(home, `
root_path = ${JSON.stringify(root)}
lock_path = ${JSON.stringify(lock)}
name = ${JSON.stringify(releaseName)}
source = os.path.join(root_path, name)
mirror = os.path.join(lock_path, name)
change = ${JSON.stringify(change)}
original_read = read_owned_lease_chain
reads = 0
evidence = None
def snapshot():
    return [(directory, name, open(os.path.join(directory, name), "rb").read())
        for directory in (root_path, lock_path) for name in sorted(os.listdir(directory)) if name != "mutable-home.lock"]
def interleaved(root, lock, include_snapshot=False, include_details=False):
    global reads, evidence
    if include_snapshot and not include_details:
        reads += 1
        if reads == 2:
            if change == "complete": os.link(source, mirror)
            elif change == "tip":
                tip, tip_hash = original_read(root, lock)
                publish_lease(root, root, "next-%s.json" % tip["leaseId"], lease_value("${owner}", "active", (tip["leaseId"], tip_hash)))
            elif change == "owner":
                value = json.load(open(source))
                value["ownerHash"] = "${"b".repeat(64)}"
                with open(source, "w") as stream: json.dump(value, stream)
            elif change == "digest":
                path = os.path.join(root_path, "mutable-home.recovery.json")
                value = json.load(open(path))
                value["recoveredEntriesHash"] = "${"c".repeat(64)}"
                with open(path, "w") as stream: json.dump(value, stream)
            elif change == "retained":
                with open(os.path.join(lock_path, "${retainedName}"), "a") as stream: stream.write(" ")
            elif change == "symlink": os.symlink(source, mirror)
            elif change == "extra-link":
                os.link(source, mirror)
                os.link(source, os.path.join(os.environ["HOME"], "unexpected-alias"))
            else:
                raw = open(source, "rb").read() + b" " if change == "bytes" else b"{}" if change == "malformed" else b"x" * 4097
                with open(mirror, "wb") as stream: stream.write(raw)
            evidence = snapshot()
    return original_read(root, lock, include_snapshot, include_details)
read_owned_lease_chain = interleaved
home_fd, _ = open_root(os.environ["HOME"])
try:
    lease = acquire_lease(home_fd, "${owner}")
except Exception:
    assert change != "complete"
    assert reads == 2 and snapshot() == evidence, "refusal mutated ownership evidence"
    print("refused unchanged")
else:
    assert change == "complete", "unsafe acquisition granted ownership"
    assert reads == 2
    release_lease(lease)
    print("acquired once")
finally: os.close(home_fd)
`);
    assert.equal(result.status, 0, `${change}: ${String(result.stderr)}`);
    assert.match(String(result.stdout), change === "complete" ? /acquired once/ : /refused unchanged/);
  }
});

test("real native and helper processes elect one winner while a release mirror finishes publication", async (t) => {
  for (const contenders of ["native", "helper", "both"] as const) await t.test(contenders, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "wollipog-wsl-release-window-"));
    const released = join(home, "released");
    const finishMirror = join(home, "finish-mirror");
    const mirrored = join(home, "mirrored");
    const finishWinner = join(home, "finish-winner");
    const nativeReady = join(home, "native-ready");
    const helperReady = join(home, "helper-ready");
    const nativeResult = join(home, "native-result");
    const helperResult = join(home, "helper-result");
    const children: ReturnType<typeof spawn>[] = [];
    const exits: Array<Promise<{ code: number | null; stderr: string }>> = [];
    t.after(async () => {
      for (const child of children) child.kill("SIGKILL");
      await Promise.allSettled(exits);
      rmSync(home, { recursive: true, force: true });
    });
    const launch = (command: string, args: string[]) => {
      const child = spawn(command, args, { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
      children.push(child);
      exits.push(new Promise((resolve, reject) => {
        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
      }));
    };
    const waitFor = async (...paths: string[]) => {
      const deadline = Date.now() + 10_000;
      while (paths.some((path) => !existsSync(path)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(paths.every((path) => existsSync(path)), `publication barrier timed out: ${paths.join(", ")}`);
    };
    const publisher = instrumentHelper(
      '        if canonical: mirror_external_lease(root, lock, name)\n',
      '        if canonical:\n            hold_release(root, name)\n            mirror_external_lease(root, lock, name)\n            with open(' + JSON.stringify(mirrored) + ', "w") as stream: stream.write("done")\n',
    );
    launch("python3", ["-c", leaseProgram(`
def hold_release(root, name):
    with open(${JSON.stringify(released)}, "w") as stream: stream.write(name)
    while not os.path.exists(${JSON.stringify(finishMirror)}): time.sleep(0.01)
${acquireAndRelease}
  `, publisher)]);
    await waitFor(released);
    const root = join(home, ".agent-manager/provider-home-leases-v1");
    const releaseName = readFileSync(released, "utf8");
    assert.ok(existsSync(join(root, releaseName)), "canonical release is already published");
    assert.equal(existsSync(join(root, "mutable-home.lock", releaseName)), false, "release mirror has not been published");
    const nativeProgram = join(home, "native-contender.ts");
    writeFileSync(nativeProgram, `
import { existsSync, writeFileSync } from "node:fs";
import { ProviderHomeLeaseRegistry } from ${JSON.stringify(new URL("./provider-home-lease.ts", import.meta.url).href)};
const wait = (path) => { const deadline = Date.now() + 10000; while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("publication barrier timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
} };
const registry = new ProviderHomeLeaseRegistry(${JSON.stringify(owner)}, {
    beforeTransitionPublishForTest: () => { writeFileSync(${JSON.stringify(nativeReady)}, "ready"); wait(${JSON.stringify(mirrored)}); },
  });
try {
  registry.acquireHome(${JSON.stringify(home)});
  writeFileSync(${JSON.stringify(nativeResult)}, "won");
  wait(${JSON.stringify(finishWinner)});
  registry.releaseAll();
} catch (error) { writeFileSync(${JSON.stringify(nativeResult)}, "lost:" + error.message); }
  `);
    if (contenders !== "helper") launch(process.execPath, ["--import", "tsx", nativeProgram]);
    if (contenders !== "native") launch("python3", ["-c", leaseProgram(`
original_read = read_owned_lease_chain
reads = 0
def interleaved(root, lock, include_snapshot=False, include_details=False):
    global reads
    if include_snapshot and not include_details:
        reads += 1
        if reads == 2:
            with open(${JSON.stringify(helperReady)}, "w") as stream: stream.write("ready")
            while not os.path.exists(${JSON.stringify(mirrored)}): time.sleep(0.01)
    return original_read(root, lock, include_snapshot, include_details)
read_owned_lease_chain = interleaved
home_fd, _ = open_root(os.environ["HOME"])
try:
    lease = acquire_lease(home_fd, "${owner}")
except Exception as error:
    with open(${JSON.stringify(helperResult)}, "w") as stream: stream.write("lost:" + str(error))
else:
    with open(${JSON.stringify(helperResult)}, "w") as stream: stream.write("won")
    while not os.path.exists(${JSON.stringify(finishWinner)}): time.sleep(0.01)
    release_lease(lease)
finally: os.close(home_fd)
  `)]);
    const readyPaths = contenders === "both" ? [nativeReady, helperReady] : [contenders === "native" ? nativeReady : helperReady];
    const resultPaths = contenders === "both" ? [nativeResult, helperResult] : [contenders === "native" ? nativeResult : helperResult];
    await waitFor(...readyPaths);
    writeFileSync(finishMirror, "go");
    await waitFor(...resultPaths);
    const outcomes = resultPaths.map((path) => readFileSync(path, "utf8"));
    assert.equal(outcomes.filter((result) => result === "won").length, 1, outcomes.join("\n"));
    assert.equal(outcomes.filter((result) => result.startsWith("lost:")).length, contenders === "both" ? 1 : 0, outcomes.join("\n"));
    if (contenders === "both") assert.match(outcomes.find((result) => result.startsWith("lost:"))!, /lease changed during recovery/);
    assert.deepEqual(readFileSync(join(root, "mutable-home.lock", releaseName)), readFileSync(join(root, releaseName)));
    writeFileSync(finishWinner, "done");
    const statuses = await Promise.all(exits);
    assert.deepEqual(statuses.map(({ code }) => code), contenders === "both" ? [0, 0, 0] : [0, 0], statuses.map(({ stderr }) => stderr).join("\n"));
    assert.equal(invokeLease(home, acquireAndRelease).status, 0, "winner releases a usable canonical journal");
  });
});

test("legacy helper readers refuse a freshly initialized canonical helper journal", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-wsl-rollback-reader-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(invokeLease(home, acquireAndRelease).status, 0);
  const rollback = invokeLease(home, `home_fd, _ = open_root(os.environ["HOME"])
lock = walk_dir(home_fd, ".agent-manager/provider-home-leases-v1/mutable-home.lock")
read_lease_chain(lock)`);
  assert.notEqual(rollback.status, 0);
  assert.match(String(rollback.stderr), /provider home lease is (unsafe|incomplete or foreign)/);
  const native = new ProviderHomeLeaseRegistry(owner);
  assert.equal(native.acquireHome(home), true);
  native.releaseAll();
});

function compactionSiblings(home: string): string[] {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  return readdirSync(root).filter((name) => name.startsWith(".mutable-home.compact-"));
}

function initializeLegacyLease(home: string): void {
  const lock = join(home, ".agent-manager/provider-home-leases-v1/mutable-home.lock");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  // Existing journals keep using directory-only compaction. New homes use canonical proof.
  const active = {
    version: 2, state: "active", ownerHash: owner, leaseId: "11111111-1111-4111-8111-111111111111",
    previousLeaseId: null, previousRecordHash: null,
    pid: 2_147_483_647, hostname: hostname(), provider: "skills", createdAt: "2026-08-19T00:00:00.000Z",
  };
  const bytes = `${JSON.stringify(active)}\n`;
  writeFileSync(join(lock, `lease-${active.leaseId}.json`), bytes, { mode: 0o600 });
  writeFileSync(join(lock, `next-${active.leaseId}.json`), JSON.stringify({
    ...active, state: "released", leaseId: "22222222-2222-4222-8222-222222222222",
    previousLeaseId: active.leaseId, previousRecordHash: createHash("sha256").update(bytes).digest("hex"),
  }), { mode: 0o600 });
}

async function fillLeaseJournal(home: string, store: string): Promise<Record<string, unknown>> {
  initializeLegacyLease(home);
  const specification = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true };
  for (let pass = 0; pass < 7; pass += 1) {
    const result = await invoke(home, specification);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return specification;
}

function createOrphanCleanupProof(leaseRoot: string, index: number): { aliasName: string; proofName: string } {
  const suffix = index.toString(16);
  const leaseId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const proofHash = suffix.padStart(64, "0");
  const proofToken = suffix.padStart(32, "0");
  const candidateName = `.mutable-home.compact-${leaseId}-${proofHash}-${proofToken}`;
  const proofName = `.mutable-home.cleanup-${proofToken}.json`;
  const aliasName = `.provider-home-lease-00000000-0000-4000-8000-${suffix.padStart(12, "0")}.tmp`;
  const proof = { version: 1, name: candidateName, leaseId, proofHash, device: 1, inode: 1 };
  writeFileSync(join(leaseRoot, proofName), JSON.stringify(proof), { mode: 0o600 });
  linkSync(join(leaseRoot, proofName), join(leaseRoot, aliasName));
  return { aliasName, proofName };
}

async function initializeLeaseRoot(home: string, store: string): Promise<Record<string, unknown>> {
  initializeLegacyLease(home);
  const specification = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true };
  const initialized = await invoke(home, specification);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return specification;
}

test("the fixed WSL helper atomically deploys, switches, and removes owned links", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  for (const digest of [firstDigest, secondDigest]) {
    const version = join(store, "review", digest);
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "SKILL.md"), `---\nname: review\n---\n${digest}\n`);
  }
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const local = join(home, ".codex", "skills", "local");
  mkdirSync(local, { recursive: true, mode: 0o700 });
  writeFileSync(join(local, "SKILL.md"), "---\nname: Code Review\ndescription: Local helper\n---\n");
  const spec = (digest: string, skills: unknown[] = [{
    name: "review", versionDigest: digest,
    targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }],
  }]) => ({ ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings, skills, allowRemovals: true });

  const first = await invoke(home, spec(firstDigest));
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstOutput = JSON.parse(first.stdout);
  assert.equal(firstOutput.deployed[0].links[0].status, "linked");
  assert.deepEqual(firstOutput.unmanaged, [{ agentId: "codex-wsl-Ubuntu", name: "local", description: "Local helper" }]);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", firstDigest));
  assert.equal(readlinkSync(join(home, ".codex/skills/review")), resolve(home, ".agents/skills/review"));

  const second = await invoke(home, spec(secondDigest));
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest));

  const removed = await invoke(home, spec(secondDigest, []));
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout).removedLinks.map((entry: { path: string }) => entry.path).sort(), [
    "~/.agents/skills/review (WSL Ubuntu)",
    "~/.codex/skills/review (WSL Ubuntu)",
  ]);
});

test("the fixed WSL helper leaves a held skill's links in place while it is updated or removed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  for (const digest of [firstDigest, secondDigest]) {
    const version = join(store, "review", digest);
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "SKILL.md"), `---\nname: review\n---\n${digest}\n`);
  }
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const targets = [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }];
  const spec = (skills: unknown[]) => ({ ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings, skills, allowRemovals: true });
  const deployed = await invoke(home, spec([{ name: "review", versionDigest: firstDigest, targets }]));
  assert.equal(deployed.status, 0, deployed.stderr || deployed.stdout);

  const updated = await invoke(home, spec([{ name: "review", versionDigest: secondDigest, targets, held: true }]));
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  const output = JSON.parse(updated.stdout);
  assert.equal(output.deployed[0].links[0].status, "conflict");
  assert.match(output.deployed[0].links[0].detail, /edited on this machine/);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", firstDigest));

  const removed = await invoke(home, spec([{ name: "review", targets: [], held: true }]));
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout).removedLinks, []);
  assert.equal(readlinkSync(join(home, ".codex/skills/review")), resolve(home, ".agents/skills/review"));
});

test("the fixed WSL helper holds a skill whose own links serve an edited native store copy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  for (const digest of [firstDigest, secondDigest]) {
    const version = join(store, "review", digest);
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "SKILL.md"), `---\nname: review\n---\n${digest}\n`);
  }
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const targets = [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }];
  const spec = (digest: string, drifted: string[], skills?: unknown[]) => ({ ownerHash: owner, distro: "Ubuntu",
    storeRoot: resolve(store), bindings, skills: skills ?? [{ name: "review", versionDigest: digest, targets }], drifted,
    allowRemovals: true });
  const deployed = await invoke(home, spec(firstDigest, []));
  assert.equal(deployed.status, 0, deployed.stderr || deployed.stdout);
  assert.deepEqual(JSON.parse(deployed.stdout).held, []);

  // An unrelated edited copy holds nothing; the one this distro's link serves holds the skill.
  const unrelated = await invoke(home, spec(secondDigest, [`review/${secondDigest}-manual`]));
  assert.equal(unrelated.status, 0, unrelated.stderr || unrelated.stdout);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest));
  // A lost ownership record must not let a link that serves an edited copy be repointed.
  rmSync(join(home, ".agent-manager", "runner-instances", owner, "skills", "links.json"));
  const held = await invoke(home, spec(firstDigest, [`review/${secondDigest}`]));
  assert.equal(held.status, 0, held.stderr || held.stdout);
  const output = JSON.parse(held.stdout);
  assert.deepEqual(output.held, ["review"]);
  assert.equal(output.deployed[0].links[0].status, "conflict");
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest),
    "the edited copy stays served instead of being repointed to the desired version");
  const removed = await invoke(home, spec(firstDigest, [`review/${secondDigest}`], []));
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout).removedLinks, []);

  const invalid = await invoke(home, spec(firstDigest, ["../escape/" + firstDigest]));
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /invalid WSL drift list/);
});

test("the fixed WSL helper re-hashes a served copy and holds it when edited after the native scan", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-late-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  const filesFor = (digest: string): SkillFile[] => [
    { path: "SKILL.md", content: `---\nname: review\n---\n${digest}\n`, encoding: "utf8" },
    { path: "reference/ñotes.md", content: "Accented path.\n", encoding: "utf8" },
    { path: "Z.md", content: "Upper case sorts first.\n", encoding: "utf8" },
    { path: "reference/__pycache__/helper.pyc", content: "ignored", encoding: "utf8" },
  ];
  for (const digest of [firstDigest, secondDigest]) {
    for (const file of filesFor(digest)) {
      mkdirSync(dirname(join(store, "review", digest, file.path)), { recursive: true });
      writeFileSync(join(store, "review", digest, file.path), file.content);
    }
  }
  const scanDigest = (digest: string) => skillVersionDigest(filesFor(digest).filter((file) => !file.path.includes("__pycache__")));
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const targets = [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }];
  const spec = (digest: string, movable: Record<string, string>) => ({ ownerHash: owner, distro: "Ubuntu",
    storeRoot: resolve(store), bindings, skills: [{ name: "review", versionDigest: digest, targets }], drifted: [], movable,
    allowRemovals: true });
  assert.equal((await invoke(home, spec(firstDigest, {}))).status, 0);

  // An unedited copy with its scan-time digest moves normally: the helper's digest matches the runner's.
  const moved = await invoke(home, spec(secondDigest, { [`review/${firstDigest}`]: scanDigest(firstDigest) }));
  assert.equal(moved.status, 0, moved.stderr || moved.stdout);
  assert.deepEqual(JSON.parse(moved.stdout).lateDrift, []);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest));

  // The copy the link now serves is edited after the native scan recorded its digest.
  writeFileSync(join(store, "review", secondDigest, "SKILL.md"), "edited after the scan\n");
  const held = await invoke(home, spec(firstDigest, { [`review/${secondDigest}`]: scanDigest(secondDigest) }));
  assert.equal(held.status, 0, held.stderr || held.stdout);
  const output = JSON.parse(held.stdout);
  assert.deepEqual(output.held, ["review"]);
  assert.equal(output.lateDrift[0].version, secondDigest);
  assert.match(output.lateDrift[0].observedDigest, /^[0-9a-f]{64}$/);
  assert.equal(output.deployed[0].links[0].status, "conflict");
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest));
});

test("the WSL helper releases its lease for a distinct native distro runner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-native-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const base = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings: [] };
  const idle = await invoke(home, { ...base, skills: [], allowRemovals: true });
  assert.equal(idle.status, 0, idle.stderr || idle.stdout);
  const lock = join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock");
  assert.equal(existsSync(lock), false, "an idle read-only pass does not claim the shared HOME");

  initializeLegacyLease(home);

  const result = await invoke(home, { ...base,
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readdirSync(lock).some((name) => name.startsWith("next-")), true,
    "the helper publishes an explicit released successor");

  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const record = readdirSync(lock)[0]!;
  const publicationAlias = join(leaseRoot, ".native-publication.tmp");
  linkSync(join(lock, record), publicationAlias);
  const duringNativePublication = await invoke(home, { ...base,
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
  assert.equal(duringNativePublication.status, 0, duringNativePublication.stderr || duringNativePublication.stdout);
  unlinkSync(publicationAlias);

  const registry = new ProviderHomeLeaseRegistry("b".repeat(64), { isProcessAlive: () => false });
  registry.acquireHome(home);
  registry.releaseAll();
  const handedBack = await invoke(home, { ...base,
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
  assert.equal(handedBack.status, 0, handedBack.stderr || handedBack.stdout);

  for (let pass = 0; pass < 12; pass += 1) {
    const repeated = await invoke(home, { ...base,
      skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  }
  assert.ok(readdirSync(lock).length <= 16, "short-lived reconciliation keeps the lease journal bounded");
});

test("the fixed WSL helper refuses a live provider-home owner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const registry = new ProviderHomeLeaseRegistry(owner);
  registry.acquireHome(home);
  const blocked = await invoke(home, { ownerHash: "b".repeat(64), distro: "Ubuntu", storeRoot: resolve(store),
    bindings: [], skills: [], allowRemovals: true });
  assert.equal(blocked.status, 0, "an idle pass does not need the contended lease");
  const mutating = await invoke(home, { ownerHash: "b".repeat(64), distro: "Ubuntu", storeRoot: resolve(store),
    bindings: [], skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
  assert.notEqual(mutating.status, 0);
  assert.match(mutating.stdout, /already in use/u);
  registry.releaseAll();
});

test("native and WSL helper leases hand off through one retained external canonical journal", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-native-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(store);
  const native = new ProviderHomeLeaseRegistry(owner);
  native.acquireHome(home);
  native.releaseAll();
  const leaseRoot = join(home, ".agent-manager/provider-home-leases-v1");
  const proof = readFileSync(join(leaseRoot, "mutable-home.recovery.json"));
  const spec = { ownerHash: "b".repeat(64), distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true };
  const helper = await invoke(home, spec);
  assert.equal(helper.status, 0, helper.stderr || helper.stdout);
  const successors = readdirSync(leaseRoot).filter((name) => name.startsWith("next-"));
  assert.equal(successors.length, 3, "native release, helper acquire, and helper release share the canonical chain");
  assert.deepEqual(readFileSync(join(leaseRoot, "mutable-home.recovery.json")), proof);
  assert.equal(native.acquireHome(home), true, "the helper's explicit release hands back to native");
  native.releaseAll();
  // Exercise negotiated checkpoint selection past the canonical compaction threshold.
  for (let pass = 0; pass < 9; pass++) {
    const result = await invoke(home, spec);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.deepEqual(compactionSiblings(home), []);
  assert.equal(JSON.parse(readFileSync(join(leaseRoot, "mutable-home.recovery.json"), "utf8")).version, 3);
  assert.ok(readdirSync(leaseRoot).length <= 20);
  assert.equal(native.acquireHome(home), true);
  native.releaseAll();
});

test("the helper refuses foreign, malformed, symlinked, or changed external lease proof", async (t) => {
  for (const scenario of ["owner", "host", "malformed", "symlink", "retained"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-wsl-external-${scenario}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const store = join(root, "store");
    const leaseRoot = join(home, ".agent-manager/provider-home-leases-v1");
    const lock = join(leaseRoot, "mutable-home.lock");
    mkdirSync(store);
    if (scenario === "retained") {
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      writeFileSync(join(lock, "next-11111111-1111-4111-8111-111111111111.json"), JSON.stringify({
        version: 2, state: "active", ownerHash: owner, leaseId: "22222222-2222-4222-8222-222222222222",
        previousLeaseId: "11111111-1111-4111-8111-111111111111", previousRecordHash: "c".repeat(64),
        pid: 2_147_483_647, hostname: hostname(), provider: "skills", createdAt: "2026-08-19T00:00:00.000Z",
      }));
    }
    const registry = new ProviderHomeLeaseRegistry(owner, { pid: 2_147_483_647,
      ...(scenario === "host" ? { hostname: "other-host" } : {}) });
    registry.acquireHome(home);
    const proof = join(leaseRoot, "mutable-home.recovery.json");
    if (scenario === "malformed") writeFileSync(proof, "{}\n");
    if (scenario === "symlink") {
      renameSync(proof, join(root, "external-proof"));
      symlinkSync(join(root, "external-proof"), proof);
    }
    if (scenario === "retained") {
      registry.releaseAll();
      const retained = join(lock, "next-11111111-1111-4111-8111-111111111111.json");
      const original = readFileSync(retained);
      const handoff = invokeLease(home, acquireAndRelease);
      assert.equal(handoff.status, 0, String(handoff.stderr));
      assert.deepEqual(readFileSync(retained), original, "helper accepts and retains non-empty recovery digest");
      const path = join(lock, "next-11111111-1111-4111-8111-111111111111.json");
      writeFileSync(path, `${readFileSync(path, "utf8")} `);
    }
    const before = readdirSync(leaseRoot).sort();
    const result = await invoke(home, { ownerHash: scenario === "owner" ? "b".repeat(64) : owner,
      distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
      skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
    assert.notEqual(result.status, 0, scenario);
    assert.match(result.stdout, /quarantine the entire.*do not remove individual records/s);
    assert.deepEqual(readdirSync(leaseRoot).sort(), before, "refusal retains every ownership record");
  }
});

test("a missing mirror directory cannot hide a live native successor from the helper", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-missing-mirrors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(store);
  const initial = new ProviderHomeLeaseRegistry(owner, { pid: 2_147_483_647 });
  initial.acquireHome(home);
  const live = new ProviderHomeLeaseRegistry(owner);
  live.acquireHome(home);
  const lock = join(home, ".agent-manager/provider-home-leases-v1/mutable-home.lock");
  rmSync(lock, { recursive: true });
  const result = await invoke(home, { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store),
    bindings: [], skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /already in use/u);
  assert.equal(existsSync(lock), false, "live-owner refusal does not recreate the directory");
  live.releaseAll();
});

test("the fixed WSL helper prunes stale ownership instead of granting future removal authority", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-stale-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  const version = join(store, "review", firstDigest);
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "SKILL.md"), "---\nname: review\n---\n");
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const base = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings, allowRemovals: true };
  const desired = [{ name: "review", versionDigest: firstDigest,
    targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] }];
  assert.equal((await invoke(home, { ...base, skills: desired })).status, 0);

  const harness = join(home, ".codex/skills/review");
  unlinkSync(harness);
  writeFileSync(harness, "user-owned");
  assert.equal((await invoke(home, { ...base, skills: [] })).status, 0);
  const manifest = join(home, `.agent-manager/runner-instances/${owner}/skills/links.json`);
  assert.ok(!JSON.parse(readFileSync(manifest, "utf8")).links.includes(".codex/skills/review"));

  unlinkSync(harness);
  symlinkSync(join(home, ".agents/skills/review"), harness);
  const result = await invoke(home, { ...base, skills: [] });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readlinkSync(harness), join(home, ".agents/skills/review"));
  assert.ok(!JSON.parse(result.stdout).removedLinks.some((entry: { path: string }) =>
    entry.path === "~/.codex/skills/review (WSL Ubuntu)"));
});

test("the fixed WSL helper rejects a binding whose driver and directory disagree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const result = await invoke(home, { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store),
    bindings: [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".claude/skills" }],
    skills: [], allowRemovals: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /invalid WSL skill binding/u);
});

test("an unsafe harness directory is isolated without surrendering owned-link authority", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-unsafe-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  const version = join(store, "review", firstDigest);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "SKILL.md"), "---\nname: review\n---\n");
  const bindings = [{ agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" }];
  const desired = [{ name: "review", versionDigest: firstDigest,
    targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] }];
  const base = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings, allowRemovals: true };
  assert.equal((await invoke(home, { ...base, skills: desired })).status, 0);
  chmodSync(join(home, ".codex"), 0o770);

  const result = await invoke(home, { ...base, skills: desired });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).deployed[0].links[0].status, "error");
  const manifest = join(home, `.agent-manager/runner-instances/${owner}/skills/links.json`);
  assert.ok(JSON.parse(readFileSync(manifest, "utf8")).links.includes(".codex/skills/review"));
});

test("removal sweeps harness directories whose prior binding disappeared", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-removed-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  const version = join(store, "review", firstDigest);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "SKILL.md"), "---\nname: review\n---\n");
  const claude = { agentId: "claude-wsl-Ubuntu", driver: "claude-code", relDir: ".claude/skills" };
  const codex = { agentId: "codex-wsl-Ubuntu", driver: "codex", relDir: ".codex/skills" };
  const base = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), allowRemovals: true };
  const desired = [{ name: "review", versionDigest: firstDigest,
    targets: [{ agentId: claude.agentId, invocation: "agent" }] }];
  assert.equal((await invoke(home, { ...base, bindings: [claude, codex], skills: desired })).status, 0);
  assert.equal(existsSync(join(home, ".claude/skills/review")), true);

  const removed = await invoke(home, { ...base, bindings: [codex], skills: [] });
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.equal(existsSync(join(home, ".claude/skills/review")), false);
});

test("a later pass recovers compaction crashes on either side of directory exchange", async (t) => {
  for (const crash of ["before", "after"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-wsl-skills-compact-${crash}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const store = join(root, "store");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(store);
    const specification = await fillLeaseJournal(home, store);
    const helper = crash === "before"
      ? instrumentHelper(
          "        exchange_attempted = True\n        if not exchange_directories(root, temporary, \"mutable-home.lock\"):",
          "        os._exit(86)\n        exchange_attempted = True\n        if not exchange_directories(root, temporary, \"mutable-home.lock\"):",
        )
      : instrumentHelper(
          "        if not exchange_directories(root, temporary, \"mutable-home.lock\"):\n            fail(\"provider home lease compaction is unavailable\")\n    except:",
          "        if not exchange_directories(root, temporary, \"mutable-home.lock\"):\n            fail(\"provider home lease compaction is unavailable\")\n        os._exit(87)\n    except:",
        );
    const interrupted = await invoke(home, specification, helper);
    assert.equal(interrupted.status, crash === "before" ? 86 : 87);
    assert.equal(compactionSiblings(home).length, 1, `${crash}-exchange crash leaves one inert sibling`);

    const recovered = await invoke(home, specification);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.deepEqual(compactionSiblings(home), [], `${crash}-exchange sibling is verified and removed`);
    const lock = join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock");
    assert.ok(readdirSync(lock).some((name) => name.startsWith("next-")), "the canonical journal remains valid");
  }
});

test("deferred compaction cleanup is retried while foreign lookalikes remain untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const deferred = instrumentHelper(
    "    os.close(lock)\n    cleanup_compactions(root, fresh)\n    return fresh",
    "    os.close(lock)\n    return fresh",
  );
  const compacted = await invoke(home, specification, deferred);
  assert.equal(compacted.status, 0, compacted.stderr || compacted.stdout);
  assert.equal(compactionSiblings(home).length, 1);

  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const fakeBase = `.mutable-home.compact-00000000-0000-4000-8000-000000000000-${"0".repeat(64)}-${"1".repeat(32)}`;
  const foreignDirectory = join(leaseRoot, fakeBase);
  const foreignSymlink = join(leaseRoot,
    `.mutable-home.compact-00000000-0000-4000-8000-000000000001-${"0".repeat(64)}-${"2".repeat(32)}`);
  mkdirSync(foreignDirectory, { mode: 0o700 });
  writeFileSync(join(foreignDirectory, "unexpected"), "keep", { mode: 0o600 });
  symlinkSync(home, foreignSymlink);

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(existsSync(join(foreignDirectory, "unexpected")), true);
  assert.equal(readlinkSync(foreignSymlink), home);
  assert.deepEqual(compactionSiblings(home).sort(), [fakeBase, foreignSymlink.split("/").at(-1)!].sort());
});

test("a crash partway through verified cleanup is safely resumable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-partial-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const interruptedCleanup = instrumentHelper(
    "            for entry in entries: os.unlink(entry, dir_fd=candidate)\n            os.fsync(candidate)",
    "            for index, entry in enumerate(entries):\n                os.unlink(entry, dir_fd=candidate)\n                if index == 0: os._exit(88)\n            os.fsync(candidate)",
  );
  const interrupted = await invoke(home, specification, interruptedCleanup);
  assert.equal(interrupted.status, 88);
  const [sibling] = compactionSiblings(home);
  assert.ok(sibling);
  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const remaining = readdirSync(join(leaseRoot, sibling));
  assert.ok(remaining.length > 0, "the crash leaves a partial journal");
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), true,
    "an external inode-bound proof survives partial or empty cleanup");

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.deepEqual(compactionSiblings(home), []);
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), false);
});

test("an inode-bound proof recovers a crash after a compaction sibling becomes empty", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-empty-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const interruptedCleanup = instrumentHelper(
    "            for entry in entries: os.unlink(entry, dir_fd=candidate)\n            os.fsync(candidate)",
    "            for entry in entries: os.unlink(entry, dir_fd=candidate)\n            os._exit(89)\n            os.fsync(candidate)",
  );
  const interrupted = await invoke(home, specification, interruptedCleanup);
  assert.equal(interrupted.status, 89);
  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const [sibling] = compactionSiblings(home);
  assert.ok(sibling);
  assert.deepEqual(readdirSync(join(leaseRoot, sibling)), []);
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), true);

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.deepEqual(compactionSiblings(home), []);
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), false);
});

test("a later pass recovers a crash during cleanup-proof publication", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-proof-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const interruptedPublication = instrumentHelper(
    "        os.fsync(lock)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
    "        os.fsync(lock)\n        if target.startswith(\".mutable-home.cleanup-\"): os._exit(90)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
  );
  const specification = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true };
  initializeLegacyLease(home);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (let pass = 0; pass < 7; pass += 1) {
      const result = await invoke(home, specification);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    const interrupted = await invoke(home, specification, interruptedPublication);
    assert.equal(interrupted.status, 90, `cycle ${cycle} reaches cleanup-proof publication`);

    const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
    const proofNames = readdirSync(leaseRoot).filter((name) => name.startsWith(".mutable-home.cleanup-"));
    const aliasNames = readdirSync(leaseRoot).filter((name) =>
      name.startsWith(".provider-home-lease-") && name.endsWith(".tmp"));
    assert.equal(proofNames.length, 1, `cycle ${cycle} leaves one cleanup proof`);
    assert.equal(aliasNames.length, 1, `cycle ${cycle} leaves one publication alias`);
    const proof = statSync(join(leaseRoot, proofNames[0]!));
    const alias = statSync(join(leaseRoot, aliasNames[0]!));
    assert.deepEqual([alias.dev, alias.ino, alias.nlink], [proof.dev, proof.ino, 2]);

    const recovered = await invoke(home, specification);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.deepEqual(compactionSiblings(home), [], `cycle ${cycle} removes the compaction sibling`);
    assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), false);
    assert.equal(readdirSync(leaseRoot).some((name) =>
      name.startsWith(".provider-home-lease-") && name.endsWith(".tmp")), false);
  }
});

test("a later pass removes an orphaned two-link cleanup proof and its publication alias", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-orphan-proof-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const interruptedPublication = instrumentHelper(
    "        os.fsync(lock)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
    "        os.fsync(lock)\n        if target.startswith(\".mutable-home.cleanup-\"): os._exit(90)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
  );
  assert.equal((await invoke(home, specification, interruptedPublication)).status, 90);

  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const [sibling] = compactionSiblings(home);
  assert.ok(sibling);
  rmSync(join(leaseRoot, sibling), { recursive: true });
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), true);
  assert.equal(readdirSync(leaseRoot).some((name) =>
    name.startsWith(".provider-home-lease-") && name.endsWith(".tmp")), true);

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(readdirSync(leaseRoot).some((name) => name.startsWith(".mutable-home.cleanup-")), false);
  assert.equal(readdirSync(leaseRoot).some((name) =>
    name.startsWith(".provider-home-lease-") && name.endsWith(".tmp")), false);
});

test("orphan cleanup pins the verified proof while preserving a replacement", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-orphan-proof-pinned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const interruptedPublication = instrumentHelper(
    "        os.fsync(lock)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
    "        os.fsync(lock)\n        if target.startswith(\".mutable-home.cleanup-\"): os._exit(90)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
  );
  assert.equal((await invoke(home, specification, interruptedPublication)).status, 90);

  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const [sibling] = compactionSiblings(home);
  const [proofName] = readdirSync(leaseRoot).filter((name) => name.startsWith(".mutable-home.cleanup-"));
  assert.ok(sibling);
  assert.ok(proofName);
  rmSync(join(leaseRoot, sibling), { recursive: true });
  const replacedAfterNormalization = instrumentHelper(
    "                verified = os.fstat(proof_fd)\n                named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)",
    "                held = os.fstat(proof_fd)\n                if (held.st_dev, held.st_ino) != proof_identity: os._exit(91)\n                os.unlink(proof_name, dir_fd=root)\n                replacement = os.open(proof_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)\n                try: write_all(replacement, b\"foreign\")\n                finally: os.close(replacement)\n                verified = os.fstat(proof_fd)\n                named = os.stat(proof_name, dir_fd=root, follow_symlinks=False)",
  );

  const result = await invoke(home, specification, replacedAfterNormalization);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(join(leaseRoot, proofName), "utf8"), "foreign");
  assert.equal(readdirSync(leaseRoot).some((name) =>
    name.startsWith(".provider-home-lease-") && name.endsWith(".tmp")), false);
});

test("cleanup reuses one bounded alias inventory for multiple two-link proofs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-alias-inventory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await initializeLeaseRoot(home, store);
  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const artifacts = [createOrphanCleanupProof(leaseRoot, 1), createOrphanCleanupProof(leaseRoot, 2)];
  const counted = instrumentHelper(
    "def discover_cleanup_proof_aliases(root):",
    "cleanup_alias_scan_count = 0\n\ndef discover_cleanup_proof_aliases(root):\n    global cleanup_alias_scan_count\n    cleanup_alias_scan_count += 1\n    if cleanup_alias_scan_count > 1: os._exit(92)",
  );

  const recovered = await invoke(home, specification, counted);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  for (const artifact of artifacts) {
    assert.equal(existsSync(join(leaseRoot, artifact.proofName)), false);
    assert.equal(existsSync(join(leaseRoot, artifact.aliasName)), false);
  }
});

test("cleanup alias inventory tolerates bounded padding and preserves unrelated entries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-alias-padding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await initializeLeaseRoot(home, store);
  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const artifact = createOrphanCleanupProof(leaseRoot, 3);
  const foreignFiles = Array.from({ length: 24 }, (_, index) => `.foreign-padding-${index}`);
  for (const name of foreignFiles) writeFileSync(join(leaseRoot, name), "keep", { mode: 0o600 });
  const unrelatedTemp = ".provider-home-lease-00000000-0000-4000-8000-000000000004.tmp";
  const foreignTemp = ".provider-home-lease-00000000-0000-4000-8000-000000000005.tmp";
  const unrelatedSymlink = ".provider-home-lease-00000000-0000-4000-8000-000000000006.tmp";
  const lock = join(leaseRoot, "mutable-home.lock");
  const [canonicalRecord] = readdirSync(lock);
  assert.ok(canonicalRecord);
  linkSync(join(lock, canonicalRecord), join(leaseRoot, unrelatedTemp));
  const canonicalBytes = readFileSync(join(leaseRoot, unrelatedTemp), "utf8");
  writeFileSync(join(leaseRoot, foreignTemp), "foreign", { mode: 0o600 });
  symlinkSync(artifact.proofName, join(leaseRoot, unrelatedSymlink));

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(existsSync(join(leaseRoot, artifact.proofName)), false);
  assert.equal(existsSync(join(leaseRoot, artifact.aliasName)), false);
  for (const name of foreignFiles) assert.equal(readFileSync(join(leaseRoot, name), "utf8"), "keep");
  assert.equal(readFileSync(join(leaseRoot, unrelatedTemp), "utf8"), canonicalBytes);
  assert.equal(readFileSync(join(leaseRoot, foreignTemp), "utf8"), "foreign");
  assert.equal(readlinkSync(join(leaseRoot, unrelatedSymlink)), artifact.proofName);
});

test("cleanup alias inventory budgets fail closed without blocking lease reconciliation", async (t) => {
  for (const budget of ["scan", "retained"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-wsl-skills-compact-alias-${budget}-budget-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const store = join(root, "store");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(store);
    const specification = await initializeLeaseRoot(home, store);
    const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
    const lock = join(leaseRoot, "mutable-home.lock");
    const artifact = createOrphanCleanupProof(leaseRoot, budget === "scan" ? 6 : 7);
    const beforeRecords = readdirSync(lock).length;
    let helper: string;
    if (budget === "scan") {
      for (let index = 0; index < 4; index += 1) {
        writeFileSync(join(leaseRoot, `.scan-padding-${index}`), "keep", { mode: 0o600 });
      }
      helper = instrumentHelper("MAX_CLEANUP_ALIAS_SCAN_ENTRIES = 4096", "MAX_CLEANUP_ALIAS_SCAN_ENTRIES = 4");
    } else {
      for (const suffix of [8, 9]) {
        const name = `.provider-home-lease-00000000-0000-4000-8000-${suffix.toString(16).padStart(12, "0")}.tmp`;
        writeFileSync(join(leaseRoot, name), "foreign", { mode: 0o600 });
      }
      helper = instrumentHelper("MAX_CLEANUP_ALIASES = 128", "MAX_CLEANUP_ALIASES = 2");
    }

    const reconciled = await invoke(home, specification, helper);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    assert.ok(readdirSync(lock).length > beforeRecords, `${budget} overflow does not block the canonical lease chain`);
    assert.equal(existsSync(join(leaseRoot, artifact.proofName)), true);
    assert.equal(existsSync(join(leaseRoot, artifact.aliasName)), true);
  }
});

test("cleanup revalidates a cached alias after discovery before unlink", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-cached-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await initializeLeaseRoot(home, store);
  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const artifact = createOrphanCleanupProof(leaseRoot, 10);
  const movedAlias = ".foreign-cleanup-proof-alias";
  const substituted = instrumentHelper(
    "    aliases_by_identity = discover_cleanup_proof_aliases(root)\n    for name in names[:MAX_COMPACTION_SIBLINGS]:",
    "    aliases_by_identity = discover_cleanup_proof_aliases(root)\n    if aliases_by_identity is not None:\n        selected = next((value[0] for value in aliases_by_identity.values() if value), None)\n        if selected is not None:\n            os.rename(selected, \".foreign-cleanup-proof-alias\", src_dir_fd=root, dst_dir_fd=root)\n            replacement = os.open(selected, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)\n            try: write_all(replacement, b\"foreign\")\n            finally: os.close(replacement)\n    for name in names[:MAX_COMPACTION_SIBLINGS]:",
  );

  const reconciled = await invoke(home, specification, substituted);
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  assert.equal(existsSync(join(leaseRoot, artifact.proofName)), true);
  assert.equal(readFileSync(join(leaseRoot, artifact.aliasName), "utf8"), "foreign");
  assert.equal(statSync(join(leaseRoot, movedAlias)).ino, statSync(join(leaseRoot, artifact.proofName)).ino);
});

test("cleanup-proof publication recovery fails closed for unaccounted aliases", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-proof-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const interruptedPublication = instrumentHelper(
    "        os.fsync(lock)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
    "        os.fsync(lock)\n        if target.startswith(\".mutable-home.cleanup-\"): os._exit(90)\n    finally:\n        try: os.unlink(temp, dir_fd=root)",
  );
  assert.equal((await invoke(home, specification, interruptedPublication)).status, 90);

  const leaseRoot = join(home, ".agent-manager", "provider-home-leases-v1");
  const [proofName] = readdirSync(leaseRoot).filter((name) => name.startsWith(".mutable-home.cleanup-"));
  const [aliasName] = readdirSync(leaseRoot).filter((name) =>
    name.startsWith(".provider-home-lease-") && name.endsWith(".tmp"));
  assert.ok(proofName);
  assert.ok(aliasName);
  const proofPath = join(leaseRoot, proofName);
  const aliasPath = join(leaseRoot, aliasName);
  const unexpectedAlias = join(leaseRoot, ".foreign-cleanup-proof-alias");
  linkSync(proofPath, unexpectedAlias);

  const extraLink = await invoke(home, specification);
  assert.equal(extraLink.status, 0, extraLink.stderr || extraLink.stdout);
  assert.equal(compactionSiblings(home).length, 1);
  assert.equal(existsSync(proofPath), true);
  assert.equal(existsSync(aliasPath), true);
  assert.equal(existsSync(unexpectedAlias), true);

  unlinkSync(unexpectedAlias);
  renameSync(aliasPath, unexpectedAlias);
  writeFileSync(aliasPath, "foreign", { mode: 0o600 });
  const substituted = await invoke(home, specification);
  assert.equal(substituted.status, 0, substituted.stderr || substituted.stdout);
  assert.equal(compactionSiblings(home).length, 1);
  assert.equal(readFileSync(aliasPath, "utf8"), "foreign");
  assert.equal(existsSync(unexpectedAlias), true);

  unlinkSync(aliasPath);
  renameSync(unexpectedAlias, aliasPath);
  const foreignSymlinkName = ".provider-home-lease-00000000-0000-4000-8000-000000000000.tmp";
  symlinkSync(proofName, join(leaseRoot, foreignSymlinkName));
  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.deepEqual(compactionSiblings(home), []);
  assert.equal(existsSync(proofPath), false);
  assert.equal(existsSync(aliasPath), false);
  assert.equal(readlinkSync(join(leaseRoot, foreignSymlinkName)), proofName);
});

test("unavailable atomic exchange preserves the append-only journal and emits a bounded diagnostic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-compact-unavailable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const specification = await fillLeaseJournal(home, store);
  const unavailable = instrumentHelper(
    "def exchange_directories(root, left, right):\n    try:",
    "def exchange_directories(root, left, right):\n    return False\n    try:",
  );
  const result = await invoke(home, specification, unavailable);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as { warnings: string[] };
  assert.equal(output.warnings.length, 1);
  assert.match(output.warnings[0]!, /remains append-only beyond 16 records/u);
  assert.ok(output.warnings[0]!.length <= 500);
  const lock = join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock");
  assert.ok(readdirSync(lock).length > 16, "the last valid chain remains append-only when exchange is unavailable");
  assert.deepEqual(compactionSiblings(home), [], "the failed pre-exchange staging directory is removed");

  const next = await invoke(home, specification, unavailable);
  assert.equal(next.status, 0, next.stderr || next.stdout);
  assert.ok(readdirSync(lock).length > 16, "later passes continue from the preserved valid chain");
});
