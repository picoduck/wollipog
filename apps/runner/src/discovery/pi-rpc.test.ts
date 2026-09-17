import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnAgent } from "../spawn.js";
import { probePiRpc } from "./pi-rpc.js";

const fixture = fileURLToPath(new URL("../drivers/fixtures/fake-pi-rpc.mjs", import.meta.url));

test("Pi discovery derives models, thinking levels, images, commands, and skills from RPC", async () => {
  let observedPrivateProbe = false;
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      spawn: (options) => {
        assert.notEqual(options.cwd, process.cwd());
        assert.equal(existsSync(join(options.cwd, ".pi", "settings.json")), true);
        assert.equal(options.args.includes("--extension"), true);
        assert.equal(options.args.includes("--no-approve"), false,
          "the trust hook must run so the probe can prove it declines project resources");
        observedPrivateProbe = true;
        return spawnAgent(options);
      },
    },
  );
  assert.equal(observedPrivateProbe, true);
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.authStatus, "authenticated");
  assert.deepEqual(result.capabilities.models.map((model) => ({
    id: model.id,
    efforts: model.efforts,
    modalities: model.inputModalities,
    contextWindow: model.contextWindow,
  })), [
    { id: "anthropic/sonnet", efforts: ["off", "low", "high"], modalities: ["text", "image"], contextWindow: 200000 },
    { id: "openai/mini", efforts: ["off"], modalities: ["text"], contextWindow: 128000 },
  ]);
  assert.equal(result.capabilities.supportsImages, true);
  assert.equal(result.capabilities.supportsConversationFork, true);
  assert.deepEqual(result.piAgentControl, { protocolVersion: 1 });
  assert.deepEqual(result.capabilities.effortLevels, ["off", "low", "high"]);
  assert.deepEqual(result.capabilities.slashCommands, [
    { name: "skill:review", description: "Review code", source: "user" },
    { name: "ship", description: "Ship it", source: "user" },
  ]);
  assert.equal(result.capabilities.supportsApprovals, true);
  assert.deepEqual(result.capabilities.permissionModes, ["default", "dontAsk", "bypassPermissions"]);
  assert.deepEqual(result.capabilities.elicitation, {
    default: ["stdio-control"],
    dontAsk: ["none"],
    bypassPermissions: ["none"],
  });
});

test("Pi discovery fails closed when the RPC contract is not compatible", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"] },
    { kind: "native" },
    { cwd: process.cwd(), timeoutMs: 30 },
  );
  assert.equal(result.available, false);
  assert.equal(result.authStatus, "unknown");
  assert.match(result.unavailableReason ?? "", /compatibility probe/u);
  assert.deepEqual(result.capabilities.models, []);
});

test("Pi discovery does not advertise forks without authoritative entry cursors", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    {
      cwd: process.cwd(),
      timeoutMs: 2_000,
      env: { WOLLIPOG_FAKE_PI_SCENARIO: "legacy-no-entries" },
    },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.capabilities.supportsConversationFork, false);
});

test("Pi discovery keeps RPC available without advertising an unproved extension bridge", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    { cwd: process.cwd(), timeoutMs: 2_000, env: { WOLLIPOG_FAKE_PI_SCENARIO: "extension-unsupported" } },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.piAgentControl, undefined);
  assert.equal(result.capabilities.supportsApprovals, false);
  assert.deepEqual(result.capabilities.permissionModes, []);
});

test("Pi discovery requires the extension's session-start readiness proof", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    { cwd: process.cwd(), timeoutMs: 2_000, env: { WOLLIPOG_FAKE_PI_SCENARIO: "extension-no-readiness" } },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.piAgentControl, undefined);
});

test("Pi discovery requires proof that the extension receives project trust before startup", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    { cwd: process.cwd(), timeoutMs: 2_000, env: { WOLLIPOG_FAKE_PI_SCENARIO: "project-trust-unsupported" } },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.piAgentControl, undefined);
  assert.equal(result.capabilities.supportsApprovals, false);
  assert.deepEqual(result.capabilities.permissionModes, []);
});

test("Pi discovery keeps older RPCs available when an unknown entry command never answers", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      env: { WOLLIPOG_FAKE_PI_SCENARIO: "legacy-hanging-entries" },
    },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(result.capabilities.supportsConversationFork, false);
  assert.equal(result.capabilities.models.length, 2, "required model probes still use the remaining budget");
});

test("Pi discovery uses a Linux working directory for WSL probes", async () => {
  let observedCwd: string | undefined;
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "wsl", distro: "Ubuntu" },
    {
      timeoutMs: 2_000,
      spawn: (options) => {
        observedCwd = options.cwd;
        return spawnAgent({ ...options, cwd: process.cwd(), context: { kind: "native" } });
      },
    },
  );
  assert.equal(result.available, true, result.unavailableReason);
  assert.equal(observedCwd, "/");
  assert.equal(result.piAgentControl, undefined, "host probe extensions are never projected into WSL");
});

test("Pi discovery enforces one wall-clock deadline across model enumeration", async () => {
  const startedAt = Date.now();
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    {
      cwd: process.cwd(),
      timeoutMs: 55,
      env: { WOLLIPOG_FAKE_PI_SCENARIO: "slow-discovery" },
    },
  );
  assert.equal(result.available, false);
  assert.ok(Date.now() - startedAt < 1_000, "the catalog size must not multiply the discovery deadline");
});
