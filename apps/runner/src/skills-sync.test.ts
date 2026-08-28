import assert from "node:assert/strict";
import test from "node:test";
import type { SkillSyncEntry, SkillsSyncManifestMessage } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ChunkedSkillsSyncAssembler } from "./skills-sync.js";

const files = [{ path: "SKILL.md", content: "---\nname: alpha\n---\n", encoding: "utf8" as const }];
const digest = skillVersionDigest(files);
const manifest = (syncId = "sync-1", requestId = "request-1"): SkillsSyncManifestMessage => ({
  type: "skills_sync_manifest",
  runnerId: "runner-1",
  syncId,
  requestId,
  skills: [{
    name: "alpha",
    versionDigest: digest,
    targets: [{ agentId: "claude", invocation: "manual" }],
  }],
});

test("chunked assembly caches one frame immediately and promotes only after exact completion", () => {
  const cached: SkillSyncEntry[] = [];
  const assembler = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => true,
    cacheContent: (entry) => cached.push(entry),
  });
  assert.equal(assembler.inProgress, false);
  const begun = assembler.begin(manifest());
  assert.equal(begun.kind, "accepted");
  assert.equal(assembler.inProgress, true);
  if (begun.kind !== "accepted") return;
  assert.deepEqual(begun.need.missing, [{ name: "alpha", versionDigest: digest }]);

  const premature = assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "sync-1" });
  assert.equal(premature.kind, "rejected");
  assert.equal(cached.length, 0);

  assembler.begin(manifest("sync-2"));
  const accepted = assembler.acceptContent({
    type: "skills_sync_content",
    runnerId: "runner-1",
    syncId: "sync-2",
    name: "alpha",
    versionDigest: digest,
    files,
  });
  assert.equal(accepted.kind, "accepted");
  assert.equal(cached.length, 1, "content is published immediately instead of retained in assembly memory");
  const completed = assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "sync-2" });
  assert.equal(completed.kind, "accepted");
  assert.equal(assembler.inProgress, false);
  if (completed.kind !== "accepted") return;
  assert.equal(completed.requestId, "request-1");
  assert.equal("files" in completed.desired[0]!, false);
});

test("new manifests supersede old state and stale frames cannot complete it", () => {
  const assembler = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => true,
    cacheContent: () => {},
  });
  assembler.begin(manifest("old"));
  assembler.begin(manifest("new", "request-new"));
  assert.equal(assembler.acceptContent({
    type: "skills_sync_content",
    runnerId: "runner-1",
    syncId: "old",
    name: "alpha",
    versionDigest: digest,
    files,
  }).kind, "ignored");
  assert.equal(assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "old" }).kind, "ignored");
  const incomplete = assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "new" });
  assert.equal(incomplete.kind, "rejected");
  if (incomplete.kind === "rejected") assert.equal(incomplete.requestId, "request-new");
});

test("duplicate, invalid, and wrong-runner content fail closed without promotion", () => {
  let cacheCalls = 0;
  const assembler = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => true,
    cacheContent: () => { cacheCalls += 1; },
  });
  const wrong = assembler.begin({ ...manifest(), runnerId: "runner-2" });
  assert.equal(wrong.kind, "rejected");

  assembler.begin(manifest());
  assert.equal(assembler.acceptContent({
    type: "skills_sync_content",
    runnerId: "runner-2",
    syncId: "sync-1",
    name: "alpha",
    versionDigest: digest,
    files,
  }).kind, "ignored");
  const content = {
    type: "skills_sync_content" as const,
    runnerId: "runner-1",
    syncId: "sync-1",
    name: "alpha",
    versionDigest: digest,
    files,
  };
  assert.equal(assembler.acceptContent(content).kind, "accepted");
  assert.equal(assembler.acceptContent(content).kind, "rejected");
  assert.equal(cacheCalls, 1);

  const rejecting = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => true,
    cacheContent: () => { throw new Error("version digest does not match the delivered files"); },
  });
  rejecting.begin(manifest());
  const invalid = rejecting.acceptContent(content);
  assert.equal(invalid.kind, "rejected");
  assert.equal(rejecting.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "sync-1" }).kind,
    "ignored");
});

test("verified cached manifests require no content and complete directly", () => {
  const assembler = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => false,
    cacheContent: () => assert.fail("cached content must not be requested"),
  });
  const begun = assembler.begin(manifest());
  assert.equal(begun.kind, "accepted");
  if (begun.kind === "accepted") assert.deepEqual(begun.need.missing, []);
  assert.equal(assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "sync-1" }).kind,
    "accepted");
});

test("chunked assembly expires after stalled progress and extends its deadline per accepted frame", () => {
  let now = 100;
  const assembler = new ChunkedSkillsSyncAssembler({
    runnerId: "runner-1",
    needsContent: () => true,
    cacheContent: () => {},
    assemblyTtlMs: 10,
    now: () => now,
  });
  assembler.begin(manifest());
  now = 109;
  assert.equal(assembler.acceptContent({
    type: "skills_sync_content",
    runnerId: "runner-1",
    syncId: "sync-1",
    name: "alpha",
    versionDigest: digest,
    files,
  }).kind, "accepted");
  now = 118;
  assert.equal(assembler.inProgress, true, "accepted content extends the assembly deadline");
  now = 119;
  assert.equal(assembler.inProgress, false, "stalled assembly no longer suppresses removal indefinitely");
  assert.equal(assembler.complete({ type: "skills_sync_complete", runnerId: "runner-1", syncId: "sync-1" }).kind,
    "ignored");
});
