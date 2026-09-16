import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { probePiRpc } from "./pi-rpc.js";

const fixture = fileURLToPath(new URL("../drivers/fixtures/fake-pi-rpc.mjs", import.meta.url));

test("Pi discovery derives models, thinking levels, images, commands, and skills from RPC", async () => {
  const result = await probePiRpc(
    { command: process.execPath, args: [fixture] },
    { kind: "native" },
    { cwd: process.cwd(), timeoutMs: 2_000 },
  );
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
  assert.deepEqual(result.capabilities.effortLevels, ["off", "low", "high"]);
  assert.deepEqual(result.capabilities.slashCommands, [
    { name: "skill:review", description: "Review code", source: "user" },
    { name: "ship", description: "Ship it", source: "user" },
  ]);
  assert.deepEqual(result.capabilities.permissionModes, []);
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

