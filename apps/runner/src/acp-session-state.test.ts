import assert from "node:assert/strict";
import test from "node:test";
import {
  acpSessionPresentation,
  normalizeAcpCommands,
  normalizeAcpConfigOptions,
  normalizeAcpModes,
  normalizeAcpSessionInfo,
  normalizeAcpTitle,
  normalizeAcpUsage,
} from "./acp-session-state.js";

test("ACP modes/config/commands normalize into existing session controls without metadata", () => {
  const modes = normalizeAcpModes({
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default", _meta: { secret: "mode-secret" } },
      { id: "plan", name: "Plan\nmode", description: "No edits" },
    ],
  });
  const options = normalizeAcpConfigOptions([
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: "fast",
      options: [{ group: "recommended", name: "Recommended", options: [
        { value: "fast", name: "Fast", _meta: { secret: "model-secret" } },
        { value: "smart", name: "Smart", description: "More capable" },
      ] }],
    },
    {
      id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high",
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
    },
    { id: "preview", name: "Preview", type: "boolean", currentValue: true },
  ]);
  const commands = normalizeAcpCommands([
    { name: "review", description: "Review changes", _meta: { secret: "command-secret" } },
    { name: "bad command", description: "filtered" },
  ]);
  const state = acpSessionPresentation(modes, options, commands, true);
  assert.deepEqual(state.config, { model: "fast", effort: "high", permissionMode: "default" });
  assert.deepEqual(state.capabilities.models.map((model) => [model.id, model.displayName, model.default]), [
    ["fast", "Fast", true],
    ["smart", "Smart", undefined],
  ]);
  assert.deepEqual(state.capabilities.effortLevels, ["low", "high"]);
  assert.deepEqual(state.capabilities.permissionModes, ["default", "plan"]);
  assert.deepEqual(state.capabilities.elicitation, {
    default: ["acp-permission"],
    plan: ["acp-permission"],
  });
  assert.deepEqual(state.capabilities.slashCommands, [
    { name: "review", source: "builtin", description: "Review changes" },
  ]);
  assert.equal(state.capabilities.supportsImages, true);
  assert.doesNotMatch(JSON.stringify(state), /secret|_meta/);
});

test("ACP stable usage/title normalization keeps only bounded provider-neutral fields", () => {
  assert.deepEqual(normalizeAcpUsage({
    used: 12_345,
    size: 200_000,
    cost: { amount: 1.25, currency: "usd", _meta: { secret: "hidden" } },
    _meta: { secret: "hidden" },
  }), { contextTokensUsed: 12_345, contextWindow: 200_000, costUsd: 1.25 });
  assert.deepEqual(normalizeAcpUsage({ used: 7, size: 10, cost: { amount: 4, currency: "EUR" } }), {
    contextTokensUsed: 7,
    contextWindow: 10,
  });
  assert.equal(normalizeAcpUsage({ used: -1, size: 10 }), null);
  assert.equal(normalizeAcpUsage({ used: 1, size: 0 }), null);
  assert.equal(normalizeAcpUsage({ used: 1.5, size: 10 }), null);
  assert.equal(normalizeAcpTitle("  Provider\n title  "), "Provider title");
  assert.equal(normalizeAcpTitle(null), null);
  assert.equal(normalizeAcpTitle({ _meta: { secret: true } }), undefined);
  assert.deepEqual(normalizeAcpSessionInfo({
    title: "  Provider\n title  ",
    updatedAt: "2026-07-11T00:00:00-05:00",
    _meta: { secret: true },
  }), { title: "Provider title", providerUpdatedAt: "2026-07-11T05:00:00.000Z" });
  assert.deepEqual(normalizeAcpSessionInfo({ title: null }), { title: null });
  assert.equal(normalizeAcpSessionInfo({ updatedAt: "not-a-date", _meta: { secret: true } }), null);
});

test("ACP session controls fail closed on invalid ids/current values and deduplicate", () => {
  assert.equal(normalizeAcpModes({ currentModeId: "missing", availableModes: [{ id: "default", name: "Default" }] }), null);
  assert.deepEqual(normalizeAcpConfigOptions([
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "missing", options: [] },
  ]), []);
  assert.deepEqual(normalizeAcpCommands([
    { name: "review", description: "one" },
    { name: "review", description: "two" },
    { name: "../escape", description: "bad" },
  ]), [{ name: "review", description: "one" }]);
});
