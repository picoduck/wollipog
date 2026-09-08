import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "@wollipog/protocol";
import { adoptMachineSkill, type SkillAdoptionOptions } from "./skill-adoption.js";
import { listSkillAdoptionRecovery, restoreSkillAdoptionRecovery } from "./skill-adoption-recovery.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { cacheSkillSyncEntry } from "./skills.js";

const linux = { skip: process.platform !== "linux" };
const agents: AgentDefinition[] = [
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
];

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "skill-adoption-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const parent = join(home, ".codex/skills");
  const source = join(parent, "alpha");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(dataDir);
  fs.writeFileSync(join(source, "SKILL.md"), "---\nname: alpha\n---\nOriginal instructions");
  fs.writeFileSync(join(source, "payload"), "original bytes");
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents });
  const list = { type: "skill_snapshot" as const, operation: "list" as const,
    runnerId: "runner", requestId: "list" };
  const candidate = snapshots.handle(list).candidates![0]!;
  const snapshot = snapshots.handle({ ...list, operation: "read", candidateId: candidate.id }).snapshot!;
  cacheSkillSyncEntry(dataDir, agents, { name: "alpha", versionDigest: snapshot.digest,
    files: snapshot.files, targets: [{ agentId: "codex", invocation: "agent" }] });
  const options: SkillAdoptionOptions = { home, dataDir, agents, candidate, digest: snapshot.digest,
    acquireProviderHomeLease: () => undefined, assertAuthorized: () => undefined };
  const recovery = (operationId: string, checkpoint?: (stage: string) => void) =>
    restoreSkillAdoptionRecovery({ home, dataDir, agents, operationId,
      acquireProviderHomeLease: () => undefined, checkpoint });
  return { home, dataDir, parent, source, options, recovery };
}

test("lists and restores an adopted source while preserving its managed link in the journal", linux, (t) => {
  const f = fixture(t);
  const before = fs.statSync(f.source);
  const adopted = adoptMachineSkill(f.options);
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.operations.map((entry) => [entry.operationId, entry.state]),
    [[adopted.operationId, "managed_linked"]]);
  const restored = f.recovery(adopted.operationId);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
  assert.equal(fs.statSync(f.source).ino, before.ino);
  assert.equal(fs.readFileSync(join(f.source, "payload"), "utf8"), "original bytes");
  const backup = join(f.home, adopted.backupDirectory);
  assert.equal(fs.lstatSync(join(backup, "managed-link")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(join(backup, "original/SKILL.md")), true);
  assert.equal(fs.existsSync(join(backup, "restored.json")), true);
  assert.equal(f.recovery(adopted.operationId).status, "not_needed");
});

test("restores an operation interrupted after preserving the original", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => { if (stage === "source_preserved") throw new Error("interrupt"); };
  const interrupted = adoptMachineSkill(f.options);
  assert.equal(interrupted.status, "recovery_required");
  if (interrupted.status !== "recovery_required") return;
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(f.recovery(interrupted.operationId).status, "restored");
  assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(join(f.source, "payload"), "utf8"), "original bytes");
});

for (const stage of ["restore_intent_durable", "managed_link_preserved", "recovery_link_created"] as const) {
  test(`restore retries safely after interruption at ${stage}`, linux, (t) => {
    const f = fixture(t);
    const adopted = adoptMachineSkill(f.options);
    assert.equal(adopted.status, "adopted");
    if (adopted.status !== "adopted") return;
    const first = f.recovery(adopted.operationId, (current) => {
      if (current === stage) throw new Error("interrupt");
    });
    assert.equal(first.status, "recovery_required", stage);
    const retry = f.recovery(adopted.operationId);
    assert.ok(retry.status === "restored" || retry.status === "not_needed", JSON.stringify(retry));
    assert.equal(fs.lstatSync(f.source).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(join(f.source, "payload"), "utf8"), "original bytes");
  });
}

test("never overwrites a source occupant and rejects malformed or unsupported requests", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => {
    if (stage === "source_preserved") {
      fs.mkdirSync(f.source);
      fs.writeFileSync(join(f.source, "new-user-file"), "keep me");
      throw new Error("interrupt");
    }
  };
  const interrupted = adoptMachineSkill(f.options);
  assert.equal(interrupted.status, "recovery_required");
  if (interrupted.status !== "recovery_required") return;
  const result = f.recovery(interrupted.operationId);
  assert.equal(result.status, "blocked");
  assert.equal(fs.readFileSync(join(f.source, "new-user-file"), "utf8"), "keep me");
  assert.equal(f.recovery("../../outside").status, "blocked");
  assert.equal(restoreSkillAdoptionRecovery({ home: "/does-not-exist", dataDir: "/none", agents,
    operationId: interrupted.operationId, platform: "darwin",
    acquireProviderHomeLease: () => assert.fail("must not lease") }).status, "blocked");
});

test("an intent-only journal is inspectable and does not mutate the original", linux, (t) => {
  const f = fixture(t);
  f.options.checkpoint = (stage) => { if (stage === "intent_durable") throw new Error("interrupt"); };
  const interrupted = adoptMachineSkill(f.options);
  assert.equal(interrupted.status, "recovery_required");
  if (interrupted.status !== "recovery_required") return;
  const listed = listSkillAdoptionRecovery(f.home, f.dataDir, agents);
  assert.deepEqual(listed.operations.map((entry) => entry.state), ["intent_only"]);
  assert.equal(f.recovery(interrupted.operationId).status, "not_needed");
  assert.equal(fs.readFileSync(join(f.source, "payload"), "utf8"), "original bytes");
});
