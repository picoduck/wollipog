import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentModel } from "@wollipog/protocol";
import {
  advertisedContextWindow,
  baseDisplayName,
  collapseContextWindowVariants,
  contextWindowChoice,
  contextWindowDiscrepancy,
  contextWindowOptionAcceptsEffort,
  formatContextWindow,
} from "./context-window-options.js";

const catalog: AgentModel[] = [
  { id: "default", displayName: "Default (Opus 5)", default: true, contextWindow: 1_000_000, description: "Opus 5 with 1M context" },
  { id: "opus", displayName: "Opus 5", contextWindow: 200_000, description: "Opus 5 with 200K context" },
  { id: "opus[1m]", displayName: "Opus 5 (1M Context)", baseModelId: "opus", contextWindow: 1_000_000 },
  { id: "sonnet", displayName: "Sonnet 5" },
  { id: "claude-fable-5-1[1m]", displayName: "Fable 5.1", baseModelId: "claude-fable-5-1" },
  { id: "haiku", displayName: "Haiku 4.5", contextWindow: 200_000 },
  { id: "fable", displayName: "Fable", hidden: true },
];

test("formatContextWindow renders provider sizes the way the CLI names them", () => {
  assert.equal(formatContextWindow(200_000), "200K");
  assert.equal(formatContextWindow(1_000_000), "1M");
  assert.equal(formatContextWindow(272_000), "272K");
  assert.equal(formatContextWindow(1_500_000), "1.5M");
  assert.equal(formatContextWindow(512), "512");
});

test("a real Context Window choice needs two provider-stated windows on one base", () => {
  assert.deepEqual(contextWindowChoice(catalog, "opus"), {
    baseModelId: "opus",
    options: [
      { id: "opus", contextWindow: 200_000, label: "200K" },
      { id: "opus[1m]", contextWindow: 1_000_000, label: "1M" },
    ],
    selectedId: "opus",
  });
  assert.equal(contextWindowChoice(catalog, "opus[1m]")?.selectedId, "opus[1m]");
  // The default alias is its own base even though it resolves to the 1M Opus variant.
  assert.equal(contextWindowChoice(catalog, "default"), null);
  // A lone [1m] alias with no stated window is never a choice — nothing is synthesized from the name.
  assert.equal(contextWindowChoice(catalog, "claude-fable-5-1[1m]"), null);
  assert.equal(contextWindowChoice(catalog, "sonnet"), null);
  assert.equal(contextWindowChoice(catalog, "haiku"), null);
  assert.equal(contextWindowChoice(catalog, null), null);
  assert.equal(contextWindowChoice(catalog, "unknown"), null);
});

test("a hidden variant still counts when the session selected it, not otherwise", () => {
  const withHidden: AgentModel[] = [
    { id: "sonnet", displayName: "Sonnet 5", contextWindow: 200_000 },
    { id: "sonnet[1m]", displayName: "Sonnet 5 (1M Context)", baseModelId: "sonnet", contextWindow: 1_000_000, hidden: true },
  ];
  assert.equal(contextWindowChoice(withHidden, "sonnet"), null);
  assert.equal(contextWindowChoice(withHidden, "sonnet[1m]")?.options.length, 2);
});

test("collapseContextWindowVariants shows one base entry and keeps the explicit variant selected", () => {
  const picker = collapseContextWindowVariants(catalog, "opus[1m]");
  assert.deepEqual(picker.map((model) => model.id), ["default", "opus[1m]", "sonnet", "claude-fable-5-1[1m]", "haiku", "fable"]);
  const opus = picker.find((model) => model.id === "opus[1m]")!;
  assert.equal(opus.displayName, "Opus 5", "the window belongs to the Context Window control, not the model label");
  assert.equal(opus.baseModelId, "opus");
  // With no explicit variant selected the plain base id represents the group.
  assert.equal(collapseContextWindowVariants(catalog, "sonnet").find((model) => modelBase(model) === "opus")?.id, "opus");
  // A group whose variants all lack windows is left exactly as the provider listed it.
  assert.deepEqual(collapseContextWindowVariants(catalog.filter((model) => !model.contextWindow), null).map((model) => model.id),
    ["sonnet", "claude-fable-5-1[1m]", "fable"]);
});

test("collapsed entries carry the group's default flag rather than one variant's", () => {
  const models: AgentModel[] = [
    { id: "opus", displayName: "Opus", contextWindow: 200_000 },
    { id: "opus[1m]", displayName: "Opus (1M context)", baseModelId: "opus", contextWindow: 1_000_000, default: true },
  ];
  const [entry] = collapseContextWindowVariants(models, null);
  assert.equal(entry!.id, "opus");
  assert.equal(entry!.default, true);
  assert.equal(entry!.displayName, "Opus");
});

test("baseDisplayName strips only a trailing context parenthetical", () => {
  assert.equal(baseDisplayName({ id: "x", displayName: "Opus 5 (1M Context)" }), "Opus 5");
  assert.equal(baseDisplayName({ id: "x", displayName: "Opus (1M context)" }), "Opus");
  assert.equal(baseDisplayName({ id: "x", displayName: "Opus Plan (beta)" }), "Opus Plan (beta)");
  assert.equal(baseDisplayName({ id: "opus[1m]" }), "opus[1m]");
});

test("contextWindowDiscrepancy names a served window that differs from the advertised one", () => {
  assert.deepEqual(contextWindowDiscrepancy(1_000_000, 200_000), { advertised: 1_000_000, served: 200_000, kind: "smaller" });
  assert.deepEqual(contextWindowDiscrepancy(200_000, 1_000_000), { advertised: 200_000, served: 1_000_000, kind: "larger" });
  assert.equal(contextWindowDiscrepancy(1_000_000, 1_000_000), null);
  assert.equal(contextWindowDiscrepancy(undefined, 200_000), null);
  assert.equal(contextWindowDiscrepancy(1_000_000, null), null);
  assert.equal(advertisedContextWindow(catalog, "opus[1m]"), 1_000_000);
  assert.equal(advertisedContextWindow(catalog, "sonnet"), null, "no family fallback: the exact entry states nothing");
  assert.equal(advertisedContextWindow(catalog, "missing"), null);
});

function modelBase(model: AgentModel): string {
  return model.baseModelId ?? model.id;
}

test("a window option carries the variant's own efforts, and only those accept the current effort", () => {
  // Variants of one base normally share their effort levels, but the catalog may advertise
  // different sets. Sending an effort the target variant does not list is a 409 from the control
  // plane's capability check, so the switch has to drop it and let the target default apply.
  const asymmetric: AgentModel[] = [
    { id: "opus", displayName: "Opus 5", contextWindow: 200_000, efforts: ["low", "high"] },
    { id: "opus[1m]", displayName: "Opus 5 (1M Context)", baseModelId: "opus", contextWindow: 1_000_000, efforts: ["high"] },
  ];
  const choice = contextWindowChoice(asymmetric, "opus");
  assert.ok(choice);
  assert.deepEqual(choice!.options.map((option) => option.efforts), [["low", "high"], ["high"]]);
  const [narrow, wide] = choice!.options;
  assert.equal(contextWindowOptionAcceptsEffort(wide!, "low"), false, "the 1M variant does not list low");
  assert.equal(contextWindowOptionAcceptsEffort(wide!, "high"), true);
  assert.equal(contextWindowOptionAcceptsEffort(narrow!, "low"), true);
  assert.equal(contextWindowOptionAcceptsEffort(wide!, ""), false, "an unset effort is never sent");

  // A variant advertising no efforts inherits the agent's levels, the same set the current
  // selection came from, so it accepts whatever is selected.
  const inherited = contextWindowChoice(catalog, "opus[1m]");
  assert.ok(inherited);
  assert.deepEqual(inherited!.options.map((option) => option.efforts), [undefined, undefined]);
  assert.equal(contextWindowOptionAcceptsEffort(inherited!.options[0]!, "low"), true);
});
