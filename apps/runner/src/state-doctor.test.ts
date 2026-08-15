import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

async function capture(run: () => Promise<void>): Promise<string> {
  let output = "";
  const original = process.stdout.write;
  (process.stdout as any).write = (value: string | Uint8Array) => { output += value.toString(); return true; };
  try { await run(); } finally { (process.stdout as any).write = original; }
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
  const output = await capture(() => runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]));
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
  const output = await capture(() => runStateDoctor([
    "runner", "--state-doctor", "quarantine-conductor", "--data-dir", root,
    "--ack-all-legacy-runners-stopped",
  ]));
  assert.equal(existsSync(legacy), false);
  assert.equal(output.includes("TOKEN_CANARY"), false);
  assert.equal((JSON.parse(output) as { quarantined: number }).quarantined, 1);
});

test("state doctor refuses all work while a runner lease remains", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".wollipog-runner-active-v1.lock"), "{}", { mode: 0o600 });
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]), /active or unrecovered lease/);
});

test("state doctor rejects ambiguous arguments and reports unreadable metadata without exposing it", async (t) => {
  const root = fixture(t);
  const sessionDir = join(root, "sessions", "s_secret");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "meta.json"), "SECRET_CANARY:not-json", { mode: 0o600 });

  const output = await capture(() => runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root,
  ]));
  assert.equal((JSON.parse(output) as { unreadableSessionMetadata: number }).unreadableSessionMetadata, 1);
  assert.equal(output.includes("SECRET_CANARY"), false);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir", root, "--data-dir", root,
  ]), /duplicate state-doctor argument/);
  await assert.rejects(runStateDoctor([
    "runner", "--state-doctor", "inventory", "--data-dir",
  ]), /requires a value/);
});
