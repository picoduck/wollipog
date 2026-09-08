import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const owner = "a".repeat(64);
const firstDigest = "1".repeat(64);
const secondDigest = "2".repeat(64);

function invoke(home: string, specification: Record<string, unknown>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", WSL_SKILLS_HELPER], {
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
  const spec = (digest: string, skills: unknown[] = [{
    name: "review", versionDigest: digest,
    targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }],
  }]) => ({ ownerHash: owner, distro: "Ubuntu", storeRoot: resolve(store), bindings, skills, allowRemovals: true });

  const first = await invoke(home, spec(firstDigest));
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).deployed[0].links[0].status, "linked");
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", firstDigest));
  assert.equal(readlinkSync(join(home, ".codex/skills/review")), resolve(home, ".agents/skills/review"));

  const second = await invoke(home, spec(secondDigest));
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(readlinkSync(join(home, ".agents/skills/review")), resolve(store, "review", secondDigest));

  const removed = await invoke(home, spec(secondDigest, []));
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.deepEqual(JSON.parse(removed.stdout).removedLinks.map((entry: { path: string }) => entry.path).sort(), [
    "WSL Ubuntu: ~/.agents/skills/review",
    "WSL Ubuntu: ~/.codex/skills/review",
  ]);
});

test("the fixed WSL helper refuses a different durable provider-home owner", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-wsl-skills-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const store = join(root, "store");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(store);
  const base = { distro: "Ubuntu", storeRoot: resolve(store), bindings: [], skills: [], allowRemovals: true };
  assert.equal((await invoke(home, { ...base, ownerHash: owner })).status, 0);
  const blocked = await invoke(home, { ...base, ownerHash: "b".repeat(64) });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /leased by another runner owner/u);
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
    entry.path === "WSL Ubuntu: ~/.codex/skills/review"));
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
