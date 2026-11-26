import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHarnessDefaultOption } from "@wollipog/protocol";
import { agentDefaultsDescription, isConfigurable, permissionModesForDraft, repairDraft, uniqueModels } from "./agent-defaults-options.js";

function installation(machineName: string, models: AgentHarnessDefaultOption["installations"][number]["models"]) {
  return {
    runnerId: machineName,
    machineName,
    online: true,
    models,
    effortLevels: ["low", "xhigh"],
    permissionModes: ["approve-for-me"],
  };
}

function option(overrides: Partial<AgentHarnessDefaultOption> = {}): AgentHarnessDefaultOption {
  return {
    agentId: "codex",
    driver: "codex-app-server",
    context: { kind: "native" },
    name: "Codex",
    installations: [installation("Studio", [{ id: "luna", displayName: "Luna", efforts: ["low", "xhigh"] }])],
    compatibleInstallations: 1,
    ...overrides,
  };
}

test("the description lists what is set in sentence case, with no middle dot", () => {
  assert.equal(agentDefaultsDescription(option()), "Uses Wollipog defaults");
  assert.equal(agentDefaultsDescription(option({ preference: { model: "luna", effort: "xhigh" } })), "Luna, extra high effort");
  // Without a model the effort leads, so the sentence starts with a capital.
  assert.equal(agentDefaultsDescription(option({ preference: { effort: "low" } })), "Low effort");
  // A model no machine lists any more shows its id, as spelled, rather than nothing.
  assert.equal(agentDefaultsDescription(option({ preference: { model: "gpt-retired" }, compatibleInstallations: 0 })),
    "gpt-retired. Not available on any machine.");
});

test("the description says where a saved choice applies when that is not every machine", () => {
  const twoMachines = option({
    installations: [
      installation("Studio", [{ id: "luna", displayName: "Luna", efforts: ["low"] }]),
      installation("Laptop", []),
    ],
    preference: { model: "luna", effort: "low" },
    compatibleInstallations: 1,
  });
  assert.equal(agentDefaultsDescription(twoMachines), "Luna, low effort. Available on 1 of 2 machines.");
  // A saved default whose agent is gone is still described, so it can be found and cleared.
  assert.equal(agentDefaultsDescription(option({ installations: [], preference: { effort: "low" }, compatibleInstallations: 0 })),
    "Low effort. Not available on any machine.");
});

test("an agent with no models, efforts or permission modes is not configurable", () => {
  assert.equal(isConfigurable(option()), true);
  assert.equal(isConfigurable(option({
    installations: [{ runnerId: "a", machineName: "A", online: true, models: [], effortLevels: [], permissionModes: [] }],
  })), false);
  assert.equal(isConfigurable(option({ installations: [] })), false);
});

test("repair drops a model the agent no longer offers along with its effort", () => {
  assert.deepEqual(repairDraft(option(), { model: "sol", effort: "xhigh", permissionMode: "approve-for-me" }),
    { permissionMode: "approve-for-me" });
  assert.deepEqual(repairDraft(option(), { model: "luna", effort: "high" }), { model: "luna" });
});

test("repair keeps the saved Antigravity Full Permissions Mode visible when discovery no longer offers it", () => {
  const permissionMode = "antigravity-full-permissions";
  const defaults = option({
    agentId: "google-antigravity",
    driver: "acp",
    name: "Google Antigravity",
    installations: [{ ...installation("Laptop", []), permissionModes: ["auto"] }],
    compatibleInstallations: 0,
    preference: { permissionMode },
  });
  assert.deepEqual(repairDraft(defaults, defaults.preference!), { permissionMode });
  assert.deepEqual(permissionModesForDraft(defaults, { permissionMode }), ["auto"]);
  assert.deepEqual(repairDraft(defaults, { permissionMode: "auto" }), { permissionMode: "auto" });
  assert.equal(agentDefaultsDescription(defaults), "Full Permissions Mode. Not available on any machine.");
});

test("a saved model that resolves differently on two machines says what it is on each (#3248)", () => {
  const installation = (machineName: string, displayName: string) => ({
    runnerId: machineName, machineName, online: true, effortLevels: [], permissionModes: [],
    models: [{ id: "opus", displayName }],
  });
  const option = {
    agentId: "claude-code", driver: "claude-code" as const, context: { kind: "native" as const }, name: "Claude Code",
    installations: [installation("Laptop", "Opus 5.5"), installation("Desktop", "Opus 5")],
    preference: { model: "opus" }, compatibleInstallations: 2,
  };
  assert.equal(agentDefaultsDescription(option), "Opus 5.5. “opus” is Opus 5 on Desktop and Opus 5.5 on Laptop.");
  option.installations[1] = installation("Desktop", "Opus 5.5");
  assert.equal(agentDefaultsDescription(option), "Opus 5.5", "one resolution adds nothing");
});

test("managed Latest describes each machine even when release display names are identical", () => {
  const id = "wollipog:latest:sol";
  const installed = (machine: string, pin: string) => installation(machine, [
    { id: pin, displayName: "Sol" },
    { id, displayName: "Sol Latest", resolvedModelId: pin, description: "Currently Sol." },
  ]);
  const defaults = option({
    installations: [installed("Laptop", "gpt-6.2-sol"), installed("Studio", "gpt-6.1-sol")],
    preference: { model: id },
    compatibleInstallations: 2,
  });
  const resolution = "“Sol Latest” is Sol (gpt-6.2-sol) on Laptop and Sol (gpt-6.1-sol) on Studio.";
  assert.equal(agentDefaultsDescription(defaults), `Sol Latest. ${resolution}`);
  assert.equal(uniqueModels(defaults).find(model => model.id === id)?.description,
    `Wollipog chooses the latest available release when a new session starts. ${resolution}`);
});
