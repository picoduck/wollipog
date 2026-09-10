import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
    "            for entry in entries: os.unlink(entry, dir_fd=candidate)\n            os.unlink(CLEANUP_MARKER, dir_fd=candidate)",
    "            for index, entry in enumerate(entries):\n                os.unlink(entry, dir_fd=candidate)\n                if index == 0: os._exit(88)\n            os.unlink(CLEANUP_MARKER, dir_fd=candidate)",
  );
  const interrupted = await invoke(home, specification, interruptedCleanup);
  assert.equal(interrupted.status, 88);
  const [sibling] = compactionSiblings(home);
  assert.ok(sibling);
  const remaining = readdirSync(join(home, ".agent-manager", "provider-home-leases-v1", sibling));
  assert.ok(remaining.includes(".cleanup-ready.json"));
  assert.ok(remaining.length > 1, "the crash leaves a marked partial journal");

  const recovered = await invoke(home, specification);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.deepEqual(compactionSiblings(home), []);
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
