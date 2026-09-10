import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentDefinition, MachineSkillCandidate } from "@wollipog/protocol";
import { skillsStoreRoot } from "./skills.js";
import { listWindowsSkillCandidates, readWindowsSkillCandidate } from "./windows-skill-snapshots.js";
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
  assert.deepEqual(readWindowsSkillCandidate(home, { id: "valid", ...valid }), [
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
  assert.equal(removed.removedLinks.some((entry) => entry.path.endsWith(`.codex/skills/${name}`)), true);
  assert.equal((await wslExec(["sh", "-c", "test ! -e \"$HOME/.codex/skills/$1\" && printf removed", "sh", name])).trim(), "removed");
});
