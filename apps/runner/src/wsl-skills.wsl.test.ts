import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentDefinition, MachineSkillCandidate, SkillFile } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { listSkillAdoptionRecoveryWithWsl, restoreSkillAdoptionRecoveryWithWsl } from "./skill-adoption-recovery.js";
import { cacheSkillSyncEntry, skillsStoreRoot } from "./skills.js";
import { listWindowsSkillCandidates, readWindowsSkillCandidate } from "./windows-skill-snapshots.js";
import { adoptWslSkill } from "./wsl-skill-adoption.js";
import { resolveWslHomeUnc } from "./wsl-skill-snapshots.js";
import { reconcileWslSkills } from "./wsl-skills.js";

const distro = process.env.WOLLIPOG_TEST_WSL_DISTRO;
const enabled = process.platform === "win32" && !!distro;

function wslExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("wsl.exe", ["-d", distro!, "--exec", ...args],
    { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => error
      ? reject(new Error(`${args[0]} failed: ${String(stderr || stdout)}`))
      : resolve(String(stdout))));
}

test("the native Windows snapshot adapter reads WSL trees and rejects Linux links", { skip: !enabled }, async (t) => {
  const suffix = String(process.pid);
  const validName = `wollipog-valid-${suffix}`;
  const symlinkName = `wollipog-symlink-${suffix}`;
  const hardlinkName = `wollipog-hardlink-${suffix}`;
  const targetName = `.wollipog-snapshot-target-${suffix}`;
  t.after(async () => {
    await wslExec(["sh", "-c", "rm -rf -- \"$HOME/.codex/skills/$1\" \"$HOME/.codex/skills/$2\" \"$HOME/.codex/skills/$3\" \"$HOME/$4\"",
      "sh", validName, symlinkName, hardlinkName, targetName]);
  });
  await wslExec(["sh", "-c", [
    "set -eu",
    "mkdir -p -- \"$HOME/.codex/skills/$1/nested\" \"$HOME/.codex/skills/$3\" \"$HOME/$4\"",
    "printf '%s\\n' '---' 'name: valid' '---' 'WSL snapshot' > \"$HOME/.codex/skills/$1/SKILL.md\"",
    "printf nested > \"$HOME/.codex/skills/$1/nested/file.txt\"",
    "printf '%s\\n' '---' 'name: target' '---' > \"$HOME/$4/SKILL.md\"",
    "ln -s -- \"$HOME/$4\" \"$HOME/.codex/skills/$2\"",
    "printf '%s\\n' '---' 'name: hardlink' '---' > \"$HOME/.codex/skills/$3/SKILL.md\"",
    "printf secret > \"$HOME/$4/secret\"",
    "ln -- \"$HOME/$4/secret\" \"$HOME/.codex/skills/$3/hard\"",
  ].join("; "), "sh", validName, symlinkName, hardlinkName, targetName]);

  const home = resolveWslHomeUnc(distro!);
  assert.ok(home, "the native runner resolves the distro default HOME");
  const candidates = listWindowsSkillCandidates(home, [".codex/skills"]);
  assert.equal(candidates.some((candidate) => candidate.name === symlinkName), false,
    "a Linux directory symlink is not offered as a candidate");
  const valid = candidates.find((candidate) => candidate.name === validName);
  assert.ok(valid);
  assert.deepEqual(readWindowsSkillCandidate(home, { id: "valid", ...valid }).sort((a, b) => a.path < b.path ? -1 : 1), [
    { path: "SKILL.md", encoding: "utf8", content: "---\nname: valid\n---\nWSL snapshot\n" },
    { path: "nested/file.txt", encoding: "utf8", content: "nested" },
  ]);
  const hardlink = candidates.find((candidate) => candidate.name === hardlinkName);
  assert.ok(hardlink);
  assert.throws(() => readWindowsSkillCandidate(home, { id: "hardlink", ...hardlink } as MachineSkillCandidate),
    /Windows snapshot helper failed/u, "a Linux hard link is rejected through the Windows handle API");
});

test("the Windows runner deploys and removes a managed skill through real WSL", { skip: !enabled }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-real-wsl-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = `wollipog-deploy-${process.pid}`;
  const digest = "d".repeat(64);
  const ownerHash = "c".repeat(64);
  const version = join(skillsStoreRoot(root), name, digest);
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "SKILL.md"), `---\nname: ${name}\n---\nReal WSL deployment\n`);
  const agent: AgentDefinition = { id: `codex-wsl-${distro}`, name: "Codex WSL", command: "codex",
    args: [], env: {}, driver: "codex", context: { kind: "wsl", distro: distro! } };
  const desired = [{ name, versionDigest: digest, targets: [{ agentId: agent.id, invocation: "agent" as const }] }];
  const wslHome = (await wslExec(["printenv", "HOME"])).trim();
  t.after(async () => {
    await reconcileWslSkills({ dataDir: root, ownerHash, agents: [agent], desired: [], allowRemovals: true });
  });

  const deployed = await reconcileWslSkills({ dataDir: root, ownerHash, agents: [agent], desired, allowRemovals: true });
  assert.equal(deployed.error, undefined);
  assert.equal(deployed.deployed[0]?.links[0]?.status, "linked");
  assert.equal((await wslExec(["readlink", `${wslHome}/.codex/skills/${name}`])).trim(),
    `${wslHome}/.agents/skills/${name}`);
  assert.match(await wslExec(["cat", `${wslHome}/.codex/skills/${name}/SKILL.md`]), /Real WSL deployment/u);

  const removed = await reconcileWslSkills({ dataDir: root, ownerHash, agents: [agent], desired: [], allowRemovals: true });
  assert.equal(removed.error, undefined);
  assert.equal(removed.removedLinks.some((entry) =>
    entry.path === `~/.codex/skills/${name} (WSL ${distro})`), true);
  assert.equal((await wslExec(["sh", "-c", "test ! -e \"$HOME/.codex/skills/$1\" && printf removed", "sh", name])).trim(), "removed");
});

test("the Windows runner adopts and restores a WSL skill inside the distro", { skip: !enabled }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-real-wsl-adoption-"));
  const nativeHome = mkdtempSync(join(tmpdir(), "wollipog-real-wsl-native-home-"));
  const name = `wollipog-adopt-${process.pid}-${randomBytes(4).toString("hex")}`;
  const content = `---\nname: ${name}\n---\nAdopted inside WSL\n`;
  const files: SkillFile[] = [{ path: "SKILL.md", encoding: "utf8", content }];
  const digest = skillVersionDigest(files);
  const agent: AgentDefinition = { id: `codex-wsl-adopt-${distro}`, name: "Codex WSL", command: "codex",
    args: [], env: {}, driver: "codex", context: { kind: "wsl", distro: distro! } };
  cacheSkillSyncEntry(root, [agent], { name, files, versionDigest: digest,
    targets: [{ agentId: agent.id, invocation: "agent" }] });
  let operationId = "";
  let created = false;
  // Record the harness directory modes before anything changes, so cleanup can restore them even
  // when setup fails part-way.
  const modes = (await wslExec(["sh", "-c",
    "for d in \"$HOME/.codex\" \"$HOME/.codex/skills\"; do if [ -d \"$d\" ]; then stat -c %a \"$d\"; else echo absent; fi; done",
  ])).trim().split(/\s+/u);
  assert.equal(modes.length, 2);
  t.after(async () => {
    // Remove only the skill this run created and its own journal, then put the harness directories
    // back as found: a developer's distro may hold unrelated skills, journals, or private directories.
    await wslExec(["sh", "-c", [
      "if [ \"$1\" = yes ]; then rm -rf -- \"$HOME/.codex/skills/$2\"; fi",
      "if [ -n \"$3\" ]; then rm -rf -- \"$HOME/.codex/skills/.wollipog-adoption-$3\"; fi",
      "if [ \"$5\" = absent ]; then rmdir \"$HOME/.codex/skills\" 2>/dev/null || true; elif [ -n \"$5\" ]; then chmod \"$5\" \"$HOME/.codex/skills\"; fi",
      "if [ \"$4\" = absent ]; then rmdir \"$HOME/.codex\" 2>/dev/null || true; elif [ -n \"$4\" ]; then chmod \"$4\" \"$HOME/.codex\"; fi",
    ].join("; "), "sh", created ? "yes" : "no", name, /^[0-9a-f-]{36}$/u.test(operationId) ? operationId : "",
    modes[0]!, modes[1]!]);
    rmSync(root, { recursive: true, force: true });
    rmSync(nativeHome, { recursive: true, force: true });
  });
  // WSL reconciliation refuses group- or world-writable harness directories; drop only those bits.
  await wslExec(["sh", "-c", "set -eu; mkdir -p -- \"$HOME/.codex/skills\"; chmod go-w \"$HOME/.codex\" \"$HOME/.codex/skills\""]);
  // The source is created exclusively: an existing path of the same name is never reused or removed.
  await wslExec(["sh", "-c", "mkdir -- \"$HOME/.codex/skills/$1\"", "sh", name]);
  created = true;
  await wslExec(["sh", "-c", [
    "set -euC",
    "printf '%s\\n' '---' \"name: $1\" '---' 'Adopted inside WSL' > \"$HOME/.codex/skills/$1/SKILL.md\"",
  ].join("; "), "sh", name]);
  const environment = { ownerHash: "d".repeat(64), dataDir: root };
  const candidate: MachineSkillCandidate = { id: "real-wsl", name, sourceDirectory: ".codex/skills",
    generation: "a".repeat(64), context: { kind: "wsl", distro: distro! } };
  const adopted = await adoptWslSkill({ ...environment, agents: [agent], candidate, digest,
    assertAuthorized: () => undefined });
  if ("operationId" in adopted && adopted.operationId) operationId = adopted.operationId;
  assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
  if (adopted.status !== "adopted") return;
  const wslHome = (await wslExec(["printenv", "HOME"])).trim();
  const target = (await wslExec(["readlink", `${wslHome}/.codex/skills/${name}`])).trim();
  assert.match(target, new RegExp(`/skills/store/${name}/${digest}$`, "u"), "the managed link names the translated store");
  assert.match(await wslExec(["cat", `${wslHome}/.codex/skills/${name}/SKILL.md`]), /Adopted inside WSL/u);

  const listed = await listSkillAdoptionRecoveryWithWsl(nativeHome, root, [agent], [], environment);
  const operation = listed.operations.find((entry) => entry.operationId === adopted.operationId);
  assert.deepEqual([operation?.state, operation?.context], ["managed_linked", { kind: "wsl", distro }]);
  const restored = await restoreSkillAdoptionRecoveryWithWsl({ home: nativeHome, dataDir: root, agents: [agent],
    operationId: adopted.operationId, acquireProviderHomeLease: () => assert.fail("WSL leases in-distro") }, environment);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal((await wslExec(["readlink", `${wslHome}/.codex/skills/${name}`])).trim(),
    `${wslHome}/.codex/skills/.wollipog-adoption-${adopted.operationId}/original`);
  assert.match(await wslExec(["cat", `${wslHome}/.codex/skills/${name}/SKILL.md`]), /Adopted inside WSL/u);
});
