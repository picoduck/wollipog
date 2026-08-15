import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CheckpointRefOwnershipLedger } from "./checkpoint-ref-ownership.js";
import { runStateDoctor } from "./state-doctor.js";

function fixture(t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-state-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".wollipog-runner-owner-v1.json"), `${JSON.stringify({
    version: 2,
    ownerHash: "a".repeat(64),
  })}\n`, { mode: 0o600 });
  return root;
}

async function capture(argv: string[]): Promise<string> {
  let output = "";
  await runStateDoctor(argv, (value) => { output += value; });
  return output;
}

test("state doctor inventory is redacted, deterministic in shape, and read-only", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  const legacy = join(conductor, "secret-session.mcp.json");
  const canary = "mamwhsec_NEVER_PRINT_ME https://private.example/control-plane";
  writeFileSync(legacy, canary, { mode: 0o600 });
  const before = readFileSync(legacy, "utf8");
  const output = await capture([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]);
  const report = JSON.parse(output) as Record<string, unknown>;
  assert.equal(report.legacyConductorConfigs, 1);
  assert.equal(output.includes(canary), false);
  assert.equal(output.includes("secret-session"), false);
  assert.equal(output.includes(root), false);
  assert.equal(readFileSync(legacy, "utf8"), before);
});

test("state doctor mutations require offline acknowledgment and quarantine without reading bytes", async (t) => {
  const root = fixture(t);
  const conductor = join(root, "conductor");
  mkdirSync(conductor);
  const legacy = join(conductor, "session.mcp.json");
  writeFileSync(legacy, "TOKEN_CANARY", { mode: 0o600 });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
  ]), /ack-all-legacy-runners-stopped/);
  const output = await capture([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
    "--ack-all-legacy-runners-stopped",
  ]);
  assert.equal(existsSync(legacy), false);
  assert.equal(output.includes("TOKEN_CANARY"), false);
  const result = JSON.parse(output) as { quarantined: number; quarantineId: string };
  assert.equal(result.quarantined, 1);
  const target = join(root, "state-quarantine", result.quarantineId, "conductor");
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")) as {
    items: Array<{ itemId: string; originalName: string; storedAs: string }>;
  };
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0]?.originalName, "session.mcp.json");
  assert.equal(manifest.items[0]?.storedAs, "0001.mcp.json");
  assert.match(manifest.items[0]?.itemId ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(readdirSync(target).sort(), ["0001.mcp.json", "manifest.json"]);
});

test("state doctor refuses all work while a runner lease remains", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".wollipog-runner-active-v1.lock"), "{}", { mode: 0o600 });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]), /active or unrecovered lease/);
});

test("checkpoint adoption preserves legacy refs by retiring only their cleanup proof", async (t) => {
  const root = fixture(t);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "checkpoint\n");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "checkpoint"]);
  const oid = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const namespace of ["wollipog", "mam"]) {
    execFileSync("git", ["-C", repo, "update-ref", `refs/${namespace}/s_adopt/turn-1`, oid]);
  }
  const sessionDir = join(root, "sessions", "s_adopt");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), `${JSON.stringify({
    sessionId: "s_adopt",
    repoPath: repo,
    context: { kind: "native" },
    worktreePath: repo,
  })}\n`, { mode: 0o600 });
  const ledger = new CheckpointRefOwnershipLedger(root);
  const legacy = { sessionId: "s_adopt", repoPath: repo, context: { kind: "native" as const } };
  ledger.claim(legacy);

  const output = await capture([
    "runner", "--state-doctor", "adopt-checkpoints", "--data-dir", root,
    "--session-id", "s_adopt", "--ack-all-legacy-runners-stopped",
  ]);
  assert.match(output, /"sourcePreserved":true/u);
  assert.equal(ledger.get(legacy), null, "startup has no stale proof that could delete preserved source refs");
  for (const namespace of ["wollipog", "mam"]) {
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse", `refs/${namespace}/s_adopt/turn-1`],
      { encoding: "utf8" }).trim(), oid);
    assert.equal(execFileSync("git", ["-C", repo, "rev-parse",
      `refs/${namespace}/owners/${"a".repeat(64)}/s_adopt/turn-1`], { encoding: "utf8" }).trim(), oid);
  }
  assert.equal(JSON.parse(readFileSync(join(sessionDir, "meta.json"), "utf8")).checkpointRefVersion, 2);
});

test("state doctor rejects ambiguous arguments and reports unreadable metadata without exposing it", async (t) => {
  const root = fixture(t);
  const sessionDir = join(root, "sessions", "s_secret");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), "SECRET_CANARY:not-json", { mode: 0o600 });

  const output = await capture([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]);
  assert.equal((JSON.parse(output) as { unreadableSessionMetadata: number }).unreadableSessionMetadata, 1);
  assert.equal(output.includes("SECRET_CANARY"), false);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root, "--data-dir", root,
  ]), /duplicate state-doctor argument/);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir",
  ]), /requires a value/);
});
