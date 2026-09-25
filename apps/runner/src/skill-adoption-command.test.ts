import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, SkillAdoptionMessage } from "@wollipog/protocol";
import { handleSkillAdoption } from "./skill-adoption-command.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { listSkillAdoptionRecovery, restoreSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import { cacheSkillSyncEntry, type ReconcileSkillEntry } from "./skills.js";

const linux = { skip: process.platform !== "linux" };
const agents: AgentDefinition[] = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" }];

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "skill-adoption-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), dataDir = join(root, "data");
  fs.mkdirSync(join(home, ".codex/skills/alpha"), { recursive: true });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(home, ".codex/skills/alpha/SKILL.md"), "---\nname: alpha\n---\nOriginal");
  let now = 1;
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents, now: () => now });
  const listed = snapshots.handle({ type: "skill_snapshot", runnerId: "runner", requestId: "list", operation: "list" });
  const candidate = listed.candidates![0]!;
  const snapshot = snapshots.handle({ type: "skill_snapshot", runnerId: "runner", requestId: "read", operation: "read", candidateId: candidate.id }).snapshot!;
  const desired: ReconcileSkillEntry = { name: "alpha", versionDigest: snapshot.digest, files: snapshot.files,
    targets: [{ agentId: "codex", invocation: "agent" }] };
  cacheSkillSyncEntry(dataDir, agents, desired);
  const message: SkillAdoptionMessage = { type: "skill_adoption", runnerId: "runner", requestId: "adopt",
    candidate, digest: snapshot.digest, confirmation: "explicit", acceptSharedImpact: false };
  return { home, dataDir, snapshots, desired, message, advance: () => { now += 600_001; } };
}

test("runner command revalidates desired state and adopts an exact live candidate", linux, async (t) => {
  const f = fixture(t);
  let lease = 0;
  const result = await handleSkillAdoption({ ...f, runnerId: "runner", agents, desired: [f.desired],
    acquireProviderHomeLease: () => { lease++; } });
  assert.equal(result.status, "adopted", JSON.stringify(result));
  assert.equal(lease, 1);
  assert.ok(fs.lstatSync(join(f.home, ".codex/skills/alpha")).isSymbolicLink());
});

test("runner command rejects stale, retargeted, manual and unconfirmed commands before mutation", linux, async (t) => {
  for (const problem of ["expired", "digest", "unassigned", "manual", "runner", "confirmation"] as const) {
    const f = fixture(t);
    let message = f.message;
    let desired: ReconcileSkillEntry[] | null = [f.desired];
    if (problem === "expired") f.advance();
    if (problem === "digest") message = { ...message, digest: "f".repeat(64) };
    if (problem === "unassigned") desired = [];
    if (problem === "manual") desired = [{ ...f.desired, targets: [{ agentId: "codex", invocation: "manual" }] }];
    if (problem === "runner") message = { ...message, runnerId: "other" };
    if (problem === "confirmation") message = { ...message, confirmation: "missing" as "explicit" };
    const result = await handleSkillAdoption({ ...f, message, runnerId: "runner", agents, desired,
      acquireProviderHomeLease: () => assert.fail("must not lease") });
    assert.equal(result.status, "rejected", problem);
    assert.ok(fs.lstatSync(join(f.home, ".codex/skills/alpha")).isDirectory(), problem);
  }
});

test("shared directory readers require explicit impact consent", linux, async (t) => {
  const f = fixture(t);
  const sharedAgents = [...agents, { id: "codex-two", name: "Codex Two", command: "codex", args: [], env: {}, driver: "codex" as const }];
  const base = { ...f, runnerId: "runner", agents: sharedAgents, desired: [f.desired],
    acquireProviderHomeLease: () => undefined };
  assert.equal((await handleSkillAdoption(base)).status, "rejected");
  assert.equal((await handleSkillAdoption({ ...base, message: { ...f.message, acceptSharedImpact: true } })).status,
    "adopted");
});

test("account-scoped adoption and recovery use and retain the selected credential home", linux, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), "skill-adoption-account-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), dataDir = join(root, "data"), accountHome = join(root, "work");
  const accounts = [{ id: "work", label: "Work", provider: "codex" as const, directory: accountHome }];
  fs.mkdirSync(join(accountHome, "skills/alpha"), { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(accountHome, "skills/alpha/SKILL.md"), "---\nname: alpha\n---\nAccount original");
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents,
    providerAccounts: () => accounts, accountScopesEnabled: () => true });
  const candidate = snapshots.handle({ type: "skill_snapshot", runnerId: "runner", requestId: "list",
    operation: "list" }).candidates![0]!;
  const snapshot = snapshots.handle({ type: "skill_snapshot", runnerId: "runner", requestId: "read",
    operation: "read", candidateId: candidate.id }).snapshot!;
  const desired: ReconcileSkillEntry = { name: "alpha", versionDigest: snapshot.digest, files: snapshot.files,
    targets: [{ agentId: "codex", invocation: "agent" }] };
  cacheSkillSyncEntry(dataDir, agents, desired);
  const leased: string[] = [];
  const result = await handleSkillAdoption({
    message: { type: "skill_adoption", runnerId: "runner", requestId: "adopt", candidate,
      digest: snapshot.digest, confirmation: "explicit", acceptSharedImpact: false },
    runnerId: "runner", home, dataDir, agents, snapshots, desired: [desired],
    providerAccounts: () => accounts,
    acquireProviderHomeLease: (credentialHome) => { leased.push(credentialHome); },
  });
  assert.equal(result.status, "adopted", JSON.stringify(result));
  assert.equal(result.providerAccountId, "work");
  assert.deepEqual(leased, [accountHome]);
  assert.ok(fs.lstatSync(join(accountHome, "skills/alpha")).isSymbolicLink());
  const listed = listSkillAdoptionRecovery(home, dataDir, agents, accounts);
  assert.deepEqual(listed.operations.map((operation) =>
    [operation.providerAccountId, operation.sourceDirectory, operation.state]), [
    ["work", ".codex/skills", "managed_linked"],
  ]);
  const restored = restoreSkillAdoptionRecovery({ home, dataDir, agents, providerAccounts: accounts,
    operationId: result.operationId!, acquireProviderHomeLease: (credentialHome) => {
      assert.equal(credentialHome, accountHome);
    } });
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.providerAccountId, "work");
});
