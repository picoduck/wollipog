import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilitiesFor, CAPABILITY_CATALOG } from "./catalog.js";

test("capabilitiesFor keeps Claude optional flags conservative until discovery", () => {
  const claude = capabilitiesFor("claude-code");
  assert.ok(claude, "claude-code has caps");
  assert.ok(claude!.models.length > 0);
  // the catalog derives from claudeModels() — pin the alias that a drifting copy once dropped
  assert.ok(claude!.models.some((m) => m.id === "fable"), "claude-code offers the fable alias");
  assert.deepEqual(claude!.permissionModes, []);
  assert.deepEqual(claude!.effortLevels, []);
  assert.equal(claude!.supportsImages, false);
  assert.equal(claude!.supportsApprovals, false);
  assert.equal(claude!.supportsConversationFork, false);
  assert.equal(claude!.supportsSteering, undefined);
  assert.equal(claude!.elicitation, undefined);

  const codex = capabilitiesFor("codex");
  assert.ok(codex, "codex has caps");
  assert.deepEqual(codex!.permissionModes, ["read-only", "workspace-write", "danger-full-access"]);
  assert.deepEqual(codex!.elicitation, {
    "read-only": ["none"],
    "workspace-write": ["none"],
    "danger-full-access": ["none"],
  });
  assert.ok(codex!.effortLevels.includes("high"));
  assert.equal(codex!.supportsSteering, undefined);

  const codexApp = capabilitiesFor("codex-app-server");
  assert.ok(codexApp, "codex app-server has caps");
  assert.deepEqual(codexApp!.permissionModes, ["read-only", "on-request", "auto-review", "danger-full-access"]);
  assert.deepEqual(codexApp!.elicitation, {
    "read-only": ["app-server"],
    "on-request": ["app-server"],
    "auto-review": ["app-server"],
    "danger-full-access": ["app-server"],
  });
  assert.equal(codexApp!.supportsConversationFork, true);
  assert.equal(codexApp!.supportsSteering, undefined, "steering requires a verified live app-server probe");
});

test("acp driver has no curated caps (advertised from the live agent)", () => {
  assert.equal(capabilitiesFor("acp"), undefined);
});

test("every catalog driver advertises exactly one default model", () => {
  for (const [driver, caps] of Object.entries(CAPABILITY_CATALOG)) {
    const defaults = caps.models.filter((m) => m.default);
    assert.equal(defaults.length, 1, `${driver} should have exactly one default model`);
  }
});

test("the default model id is 'default' (the skip-the-flag sentinel)", () => {
  for (const caps of Object.values(CAPABILITY_CATALOG)) {
    const def = caps.models.find((m) => m.default);
    assert.equal(def?.id, "default");
  }
});

test("model ids are unique within a driver", () => {
  for (const [driver, caps] of Object.entries(CAPABILITY_CATALOG)) {
    const ids = caps.models.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${driver} model ids must be unique`);
  }
});
