import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
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

function compactionSiblings(home: string): string[] {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  return readdirSync(root).filter((name) => name.startsWith(".mutable-home.compact-"));
}

async function fillLeaseJournal(home: string, store: string): Promise<Record<string, unknown>> {
  const specification = { ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings: [],
    skills: [{ name: "review", versionDigest: firstDigest, targets: [] }], allowRemovals: true };
  for (let pass = 0; pass < 8; pass += 1) {
    const result = await invoke(home, specification);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
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
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (let pass = 0; pass < (cycle === 0 ? 8 : 7); pass += 1) {
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
