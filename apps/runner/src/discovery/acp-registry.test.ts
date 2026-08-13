import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ACP_REGISTRY_URL,
  discoverRegistryAgents,
  parseRegistryIndex,
  registryEntriesToAgents,
  updateRegistryApproval,
} from "./acp-registry.js";

function registryResponse(body: BodyInit, init: ResponseInit = {}, url = ACP_REGISTRY_URL): Response {
  const response = new Response(body, { status: 200, ...init });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const index = {
  version: "1.0.0",
  agents: [
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.50.0",
      description: "Google's official CLI for Gemini",
      repository: "https://github.com/google-gemini/gemini-cli",
      distribution: { npx: { package: "@google/gemini-cli@0.50.0", args: ["--acp"] } },
    },
    {
      id: "opencode",
      name: "OpenCode",
      version: "1.17.18",
      description: "The open source coding agent",
      distribution: {
        binary: {
          "windows-x86_64": {
            archive: "https://github.com/anomalyco/opencode/releases/download/v1.17.18/opencode-windows-x64.zip",
            cmd: "./opencode.exe",
            args: ["acp"],
          },
        },
      },
    },
    {
      id: "cursor",
      name: "Cursor",
      version: "2026.07.09",
      description: "Cursor's coding agent",
      license: "proprietary",
      distribution: {
        binary: {
          "windows-x86_64": {
            archive: "https://downloads.cursor.com/lab/2026.07.09/windows/x64/agent-cli-package.zip",
            cmd: "./dist-package\\cursor-agent.cmd",
            args: ["acp"],
          },
        },
      },
    },
  ],
};

test("Registry v1 parser retains bounded launch metadata but no manifest capabilities/auth claims", () => {
  const parsed = parseRegistryIndex(index);
  assert.equal(parsed.version, "1.0.0");
  assert.deepEqual(parsed.agents.map((agent) => agent.id), ["gemini", "opencode", "cursor"]);
  assert.equal("capabilities" in parsed.agents[0]!, false);
  assert.equal("auth" in parsed.agents[0]!, false);
  assert.throws(() => parseRegistryIndex({ ...index, version: "2.0.0" }), /supported v1/);
});

test("priority adapters are allowlisted, platform-selected, and fail closed before install approval", async () => {
  const agents = await registryEntriesToAgents(parseRegistryIndex(index), ["gemini", "opencode", "cursor"], {
    platform: "win32",
    arch: "x64",
    resolveCommand: async () => null,
  });
  assert.deepEqual(agents.map((agent) => agent.id), ["gemini", "opencode", "cursor"]);
  assert.ok(agents.every((agent) => agent.available === false));
  assert.equal(agents[0]!.registry?.distribution, "npx");
  assert.equal(agents[0]!.registry?.installPreview, "npx --yes @google/gemini-cli@0.50.0 --acp");
  assert.equal(agents[1]!.registry?.distribution, "binary");
  assert.match(agents[1]!.registry!.installPreview, /opencode-windows-x64\.zip/);
  assert.equal(agents[2]!.registry?.authentication, "required-live-verification");
  assert.equal(agents[0]!.registry?.installStatus, "approval-required");
  assert.equal(agents[1]!.registry?.installStatus, "manual-only");
  assert.equal(agents[2]!.registry?.installStatus, "manual-only");
});

test("an already installed priority binary uses its resolved launch and remains stdio ACP", async () => {
  const resolvedArgs = ["-e", "if (process.argv.includes('--version')) console.log('9.8.7')", "--"];
  const [agent] = await registryEntriesToAgents(parseRegistryIndex(index), ["gemini"], {
    platform: process.platform,
    arch: process.arch,
    resolveCommand: async (bin) => bin === "gemini"
      ? {
          launch: {
            command: process.execPath,
            args: resolvedArgs,
          },
          via: "path",
        }
      : null,
  });
  assert.equal(agent!.available, true);
  assert.equal(agent!.bin, "gemini");
  assert.equal(agent!.version, "9.8.7");
  assert.equal(agent!.registry?.installStatus, "installed");
  assert.equal(agent!.registry?.transport, "stdio");
  assert.deepEqual(agent!.args, [...resolvedArgs, "--acp"]);
  assert.equal(agent!.args.includes("--yes"), false);
  assert.equal(agent!.args.includes("@google/gemini-cli@0.50.0"), false);
});

test("an incompatible binary distribution and an unranked manifest command cannot become executable", async () => {
  let resolves = 0;
  const [opencode] = await registryEntriesToAgents(parseRegistryIndex(index), ["opencode"], {
    platform: "linux",
    arch: "arm64",
    resolveCommand: async () => { resolves++; return { launch: { command: "opencode", args: [] }, via: "path" }; },
  });
  assert.equal(resolves, 0, "unsupported platform does not probe an ambient same-name binary");
  assert.equal(opencode!.available, false);
  assert.equal(opencode!.registry?.installStatus, "unsupported-platform");
  assert.deepEqual(opencode!.args, []);

  const custom = parseRegistryIndex({
    version: "1.0.0",
    agents: [{
      id: "custom-agent",
      name: "Custom Agent",
      version: "1.0.0",
      description: "Unranked agent",
      distribution: { binary: { "windows-x86_64": {
        archive: "https://example.com/custom.zip",
        cmd: "./git.exe",
        args: ["acp"],
      } } },
    }],
  });
  const [agent] = await registryEntriesToAgents(custom, ["custom-agent"], {
    platform: "win32",
    arch: "x64",
    resolveCommand: async () => { resolves++; return { launch: { command: "git.exe", args: [] }, via: "path" }; },
  });
  assert.equal(resolves, 0, "manifest-derived PATH names are never probed");
  assert.equal(agent!.available, false);
  assert.equal(agent!.registry?.installStatus, "manual-only");
});

test("validated registry cache is reused when a forced refresh is offline", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "wollipog-registry-"));
  let calls = 0;
  const online: typeof fetch = async (input) => {
    calls++;
    assert.equal(String(input), ACP_REGISTRY_URL);
    return registryResponse(JSON.stringify(index), { headers: { "content-type": "application/json" } });
  };
  try {
    const first = await discoverRegistryAgents({
      dataDir,
      allowedAgentIds: ["gemini"],
      fetchImpl: online,
      resolveCommand: async () => null,
    });
    assert.equal(first.length, 1);
    const offline: typeof fetch = async () => { throw new Error("offline"); };
    const second = await discoverRegistryAgents({
      dataDir,
      allowedAgentIds: ["gemini"],
      fetchImpl: offline,
      resolveCommand: async () => null,
      refresh: true,
    });
    assert.equal(second[0]!.id, "gemini");
    assert.equal(calls, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an exact package launch requires explicit approval, is fingerprint-bound, and can be revoked", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "wollipog-registry-approval-"));
  let currentIndex = index;
  const online: typeof fetch = async () => registryResponse(JSON.stringify(currentIndex));
  const base = {
    dataDir,
    allowedAgentIds: ["gemini"],
    fetchImpl: online,
    resolveCommand: async (bin: string) => bin === "npx"
      ? { launch: { command: "npx", args: [] }, via: "path" as const }
      : null,
    platform: "win32" as const,
    arch: "x64",
  };
  try {
    await updateRegistryApproval({
      ...base,
      agentId: "gemini",
      schemaVersion: "1.0.0",
      adapterVersion: "0.50.0",
      action: "approve",
    });
    const [approved] = await discoverRegistryAgents(base);
    assert.equal(approved!.available, true);
    assert.equal(approved!.registry?.installStatus, "approved");
    assert.equal(approved!.command, "npx");
    assert.deepEqual(approved!.args, ["--yes", "@google/gemini-cli@0.50.0", "--acp"]);

    const [runnerMissing] = await discoverRegistryAgents({
      ...base,
      resolveCommand: async () => null,
    });
    assert.equal(runnerMissing!.available, false);
    assert.equal(runnerMissing!.registry?.installStatus, "approved");
    assert.equal(runnerMissing!.command, "npx");

    const changed = structuredClone(index);
    changed.agents[0]!.distribution.npx!.args.push("--changed");
    currentIndex = changed;
    const [invalidated] = await discoverRegistryAgents({ ...base, refresh: true });
    assert.equal(invalidated!.available, false, "a different launch tuple is not authorized");

    await updateRegistryApproval({
      ...base,
      agentId: "gemini",
      schemaVersion: "1.0.0",
      adapterVersion: "0.50.0",
      action: "revoke",
    });
    const [revoked] = await discoverRegistryAgents(base);
    assert.equal(revoked!.available, false);
    assert.equal(revoked!.registry?.installStatus, "approval-required");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("binary and unpinned package distributions remain manual-only", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "wollipog-registry-manual-"));
  const online: typeof fetch = async () => registryResponse(JSON.stringify(index));
  try {
    await assert.rejects(() => updateRegistryApproval({
      dataDir,
      allowedAgentIds: ["opencode"],
      agentId: "opencode",
      schemaVersion: "1.0.0",
      adapterVersion: "1.17.18",
      action: "approve",
      platform: "win32",
      arch: "x64",
      fetchImpl: online,
    }), /integrity digest.*manual-only/);
    await assert.rejects(() => updateRegistryApproval({
      dataDir,
      allowedAgentIds: ["gemini"],
      agentId: "gemini",
      schemaVersion: "1.0.0",
      adapterVersion: "0.50.0",
      action: "approve",
      fetchImpl: online,
      resolveCommand: async () => null,
    }), /npx is not installed/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent approvals serialize without losing another agent's authorization", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "wollipog-registry-concurrent-"));
  const catalog = structuredClone(index);
  catalog.agents.push({
    id: "other-agent",
    name: "Other Agent",
    version: "1.2.3",
    description: "Another exact package",
    distribution: { npx: { package: "other-agent@1.2.3", args: ["--acp"] } },
  } as typeof catalog.agents[number]);
  const fetchImpl: typeof fetch = async () => registryResponse(JSON.stringify(catalog));
  const base = {
    dataDir,
    allowedAgentIds: ["gemini", "other-agent"],
    fetchImpl,
    resolveCommand: async (bin: string) => bin === "npx"
      ? { launch: { command: "npx", args: [] }, via: "path" as const }
      : null,
  };
  try {
    await Promise.all([
      updateRegistryApproval({ ...base, agentId: "gemini", schemaVersion: "1.0.0", adapterVersion: "0.50.0", action: "approve" }),
      updateRegistryApproval({ ...base, agentId: "other-agent", schemaVersion: "1.0.0", adapterVersion: "1.2.3", action: "approve" }),
    ]);
    const agents = await discoverRegistryAgents(base);
    assert.deepEqual(agents.map((agent) => [agent.id, agent.registry?.installStatus]), [
      ["gemini", "approved"],
      ["other-agent", "approved"],
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("registry fetch rejects off-origin redirects and stops an undeclared oversized stream", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "wollipog-registry-origin-"));
  const secondDir = await mkdtemp(join(tmpdir(), "wollipog-registry-size-"));
  try {
    await assert.rejects(() => discoverRegistryAgents({
      dataDir: firstDir,
      allowedAgentIds: ["gemini"],
      fetchImpl: async () => registryResponse(JSON.stringify(index), {}, "https://evil.example/registry.json"),
      resolveCommand: async () => null,
    }), /outside the trusted CDN origin/);
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    await assert.rejects(() => discoverRegistryAgents({
      dataDir: secondDir,
      allowedAgentIds: ["gemini"],
      fetchImpl: async () => registryResponse(oversized),
      resolveCommand: async () => null,
    }), /too large/);
  } finally {
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});
