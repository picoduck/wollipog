import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { mergeWslSkillsResult, reconcileWslSkills } from "./wsl-skills.js";

const ownerHash = "a".repeat(64);
const digest = "b".repeat(64);
const agents: AgentDefinition[] = [
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", context: { kind: "native" } },
  { id: "codex-wsl-Ubuntu", name: "Codex WSL", command: "codex", args: [], env: {}, driver: "codex",
    context: { kind: "wsl", distro: "Ubuntu" } },
];

test("WSL reconciliation sends only distro-local targets through the fixed helper", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const result = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents,
    desired: [{ name: "review", versionDigest: digest, targets: [
      { agentId: "codex", invocation: "agent" },
      { agentId: "codex-wsl-Ubuntu", invocation: "agent" },
    ] }],
    allowRemovals: true,
    storeRoot: async () => "/mnt/c/data/skills/store",
    run: async (_context, command, args, options) => {
      calls.push({ command, args, stdin: options.stdin });
      if (args[0] === "-c") return { stdout: `/home/me/.agent-manager/runner-instances/${ownerHash}/native/wollipog-skills.py\n`, stderr: "" };
      const specification = JSON.parse(options.stdin!);
      assert.deepEqual(specification.skills[0].targets, [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }]);
      assert.equal(specification.allowRemovals, true);
      return { stdout: JSON.stringify({ deployed: [{ name: "review", digest, links: [
        { agentId: "codex-wsl-Ubuntu", status: "linked" },
      ] }], unmanaged: [], removedLinks: [] }), stderr: "" };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.deployed[0]?.links, [{ agentId: "codex-wsl-Ubuntu", status: "linked" }]);
});

test("WSL helper failures are sanitized into per-target error state", async () => {
  const logs: string[] = [];
  const result = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents,
    desired: [{ name: "review", versionDigest: digest,
      targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] }],
    storeRoot: async () => "/mnt/c/data/skills/store",
    run: async () => { throw new Error("private /home/me path\nsecret"); },
    log: (message) => logs.push(message),
  });
  assert.equal(result.deployed[0]?.links[0]?.status, "error");
  assert.equal(result.error, "WSL skill reconciliation failed in Ubuntu.");
  assert.match(logs[0]!, /private \/home\/me path secret/u);
});

test("native placeholders are replaced by authoritative WSL link state", () => {
  const merged = mergeWslSkillsResult({
    deployed: [{ name: "review", digest, links: [
      { agentId: "codex", status: "linked" },
      { agentId: "codex-wsl-Ubuntu", status: "unsupported" },
    ] }], unmanaged: [], removedLinks: [],
  }, {
    deployed: [{ name: "review", digest, links: [{ agentId: "codex-wsl-Ubuntu", status: "linked" }] }],
    unmanaged: [{ agentId: "codex-wsl-Ubuntu", name: "local" }], removedLinks: [],
  }, agents);
  assert.deepEqual(merged.deployed[0]?.links, [
    { agentId: "codex", status: "linked" },
    { agentId: "codex-wsl-Ubuntu", status: "linked" },
  ]);
  assert.equal(merged.unmanaged.length, 1);
});
