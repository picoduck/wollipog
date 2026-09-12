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

test("legacy malformed target collections cannot collapse a failing WSL distribution", async () => {
  const malformed = [
    { name: "missing", versionDigest: digest },
    { name: "scalar", versionDigest: digest, targets: "codex-wsl-Ubuntu" },
    { name: "mixed", versionDigest: digest, targets: [null, { agentId: 42 },
      { agentId: "codex-wsl-Ubuntu", invocation: "agent" }] },
  ] as unknown as Parameters<typeof reconcileWslSkills>[0]["desired"];
  const wsl = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents, desired: malformed,
    storeRoot: async () => "/mnt/c/data/skills/store",
    run: async () => { throw new Error("private\nbootstrap failure"); },
  });
  assert.deepEqual(wsl.deployed.map((row) => row.name), ["mixed"]);
  assert.equal(wsl.deployed[0]?.links[0]?.status, "error");
  assert.equal(wsl.error, "WSL skill reconciliation failed in Ubuntu.");

  const merged = mergeWslSkillsResult({
    deployed: [
      { name: "missing", digest, links: [], error: "invalid skill targets" },
      { name: "native", digest, links: [{ agentId: "codex", status: "linked" }] },
    ], unmanaged: [], removedLinks: [],
  }, wsl, agents);
  assert.equal(merged.deployed.find((row) => row.name === "missing")?.error, "invalid skill targets");
  assert.equal(merged.deployed.find((row) => row.name === "native")?.links[0]?.status, "linked");
  assert.equal(merged.deployed.find((row) => row.name === "mixed")?.links[0]?.status, "error");
});

test("bounded helper diagnostics are sanitized into runner logs", async () => {
  const logs: string[] = [];
  const result = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents, desired: [], allowRemovals: true,
    storeRoot: async () => "/mnt/c/data/skills/store",
    run: async (_context, _command, args) => args[0] === "-c"
      ? { stdout: "/home/me/.agent-manager/helper.py\n", stderr: "" }
      : { stdout: JSON.stringify({ deployed: [], unmanaged: [], removedLinks: [],
          warnings: [`journal\n${"x".repeat(600)}`] }), stderr: "" },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(result, { deployed: [], unmanaged: [], removedLinks: [] });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^WSL skill helper: journal x+$/u);
  assert.ok(logs[0]!.length <= 518);
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

test("native placeholders remain for WSL agents the adapter cannot safely reconcile", () => {
  const unreconciled: AgentDefinition[] = [
    { ...agents[1]!, id: "invalid-distro", context: { kind: "wsl", distro: "../Ubuntu" } },
    { ...agents[1]!, id: "unsupported-driver", driver: "acp" },
  ];
  const merged = mergeWslSkillsResult({
    deployed: [{ name: "review", digest, links: unreconciled.map((agent) =>
      ({ agentId: agent.id, status: "unsupported" as const })) }], unmanaged: [], removedLinks: [],
  }, { deployed: [], unmanaged: [], removedLinks: [] }, unreconciled);
  assert.deepEqual(merged.deployed[0]?.links.map((link) => link.agentId), ["invalid-distro", "unsupported-driver"]);
});

test("non-authoritative untargeted passes do not boot a WSL distro", async () => {
  let calls = 0;
  const result = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents, desired: [], allowRemovals: false,
    storeRoot: async () => { calls += 1; return "/mnt/c/data/skills/store"; },
    run: async () => { calls += 1; throw new Error("should not run"); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { deployed: [], unmanaged: [], removedLinks: [] });
});

test("an invalid WSL skill row does not collapse valid distro results", async () => {
  const result = await reconcileWslSkills({
    dataDir: "C:\\data", ownerHash, agents,
    desired: [
      { name: "broken", versionDigest: "invalid", targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] },
      { name: "review", versionDigest: digest, targets: [{ agentId: "codex-wsl-Ubuntu", invocation: "agent" }] },
    ],
    storeRoot: async () => "/mnt/c/data/skills/store",
    run: async (_context, _command, args) => args[0] === "-c"
      ? { stdout: "/home/me/.agent-manager/helper.py\n", stderr: "" }
      : { stdout: JSON.stringify({ deployed: [{ name: "review", digest, links: [
        { agentId: "codex-wsl-Ubuntu", status: "linked" },
      ] }], unmanaged: [], removedLinks: [] }), stderr: "" },
  });
  assert.equal(result.deployed.find((row) => row.name === "review")?.links[0]?.status, "linked");
  assert.equal(result.deployed.find((row) => row.name === "broken")?.error, "invalid WSL skill manifest");
  assert.equal(result.error, undefined);
});
