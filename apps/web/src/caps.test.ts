import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentCapabilities, RunnerView, SessionView } from "@wollipog/protocol";
import {
  defaultPermissionMode,
  effectiveModelEffortForDisplay,
  elicitationAvailability,
  modelSupportsImages,
  resolveCaps,
  resolveEffectiveCaps,
} from "./caps.js";

const caps: AgentCapabilities = {
  models: [
    { id: "image-model", default: true, inputModalities: ["text", "image"] },
    { id: "text-model", inputModalities: ["text"] },
    { id: "legacy-model" },
  ],
  effortLevels: [],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
};

test("effective display resolution matches deterministic server fallback semantics", () => {
  const modelCaps: AgentCapabilities = {
    models: [
      { id: "default", displayName: "Default (Sonnet)", default: true },
      { id: "hidden", hidden: true, efforts: ["xhigh"] },
      { id: "opus", displayName: "Opus 5", efforts: ["low", "medium"] },
    ],
    effortLevels: ["low", "medium", "xhigh"], slashCommands: [], supportsImages: true, supportsApprovals: true,
  };
  const resolved = effectiveModelEffortForDisplay(modelCaps, "claude-code");
  assert.equal(resolved.model?.id, "opus");
  assert.equal(resolved.effort, "medium");
  assert.equal(effectiveModelEffortForDisplay(modelCaps, "claude-code", "hidden", "xhigh").model?.id, "hidden");
  assert.deepEqual(effectiveModelEffortForDisplay(undefined, "claude-code"), {
    model: undefined, efforts: [], effort: undefined,
  });
  assert.deepEqual(effectiveModelEffortForDisplay(
    { ...modelCaps, effortLevels: [], models: [{ id: "opus" }] },
    "claude-code",
  ), { model: undefined, efforts: [], effort: undefined });
});

test("effective capability resolution does not claim built-in fallbacks as runner metadata", () => {
  const session = { agentId: "missing", driver: "claude-code" } as SessionView;
  assert.equal(resolveEffectiveCaps(undefined, session), undefined);
  const otherCaps = { ...caps, models: [{ id: "opus" }], effortLevels: ["high"] };
  const runner = { agents: [{ id: "other", driver: "claude-code", capabilities: otherCaps }] } as RunnerView;
  assert.equal(resolveEffectiveCaps(runner, session), undefined);
  assert.equal(resolveCaps(undefined, session)?.models.some((model) => model.id === "opus"), true);
});

test("modelSupportsImages follows selected-model modalities and falls back for old runners", () => {
  assert.equal(modelSupportsImages(caps, "image-model"), true);
  assert.equal(modelSupportsImages(caps, "text-model"), false);
  assert.equal(modelSupportsImages(caps, "legacy-model"), true);
  assert.equal(modelSupportsImages(caps, "missing-model"), true, "missing selection uses the advertised default");
  assert.equal(modelSupportsImages(undefined, "image-model"), true, "unknown old-runner capability stays compatible");
});

test("elicitation availability preserves unknown and distinguishes explicit unavailability", () => {
  assert.equal(elicitationAvailability(caps, "acceptEdits"), "unknown", "legacy field absence is unknown");
  assert.equal(elicitationAvailability({ ...caps, elicitation: {} }, "acceptEdits"), "unknown", "missing mode is unknown");
  assert.equal(
    elicitationAvailability({ ...caps, elicitation: { acceptEdits: ["none"] } }, "acceptEdits"),
    "unavailable",
  );
  assert.equal(
    elicitationAvailability({ ...caps, elicitation: { acceptEdits: [] } }, "acceptEdits"),
    "unavailable",
  );
  assert.equal(
    elicitationAvailability({ ...caps, elicitation: { default: ["stdio-control"] } }, "default"),
    "available",
  );
});

test("default permission modes match the transport used by each fixed driver", () => {
  assert.equal(defaultPermissionMode("claude-code"), "acceptEdits");
  assert.equal(defaultPermissionMode("codex"), "workspace-write");
  assert.equal(defaultPermissionMode("codex-app-server"), "auto-review");
  assert.equal(defaultPermissionMode("acp"), undefined);
});

test("session-scoped ACP controls override the shared runner-agent capability row", () => {
  const shared = { ...caps, models: [{ id: "shared" }], slashCommands: [] };
  const sessionCaps = { ...caps, models: [{ id: "session" }], slashCommands: [{ name: "review", source: "builtin" as const }] };
  const runner = { agents: [{ id: "gemini", capabilities: shared }] } as RunnerView;
  const session = { agentId: "gemini", driver: "acp", agentCapabilities: sessionCaps } as SessionView;
  assert.equal(resolveCaps(runner, session), sessionCaps);
});

test("native session elicitation overlays do not freeze live catalog controls", () => {
  const live = {
    ...caps,
    models: [{ id: "opus-next" }],
    effortLevels: ["high"],
    permissionModes: ["acceptEdits"],
  };
  const runner = { agents: [{ id: "claude", driver: "claude-code", capabilities: live }] } as RunnerView;
  const session = {
    agentId: "claude",
    driver: "claude-code",
    agentCapabilities: { elicitation: { acceptEdits: ["hook"] } },
  } as SessionView;
  assert.deepEqual(resolveCaps(runner, session), {
    ...live,
    elicitation: { acceptEdits: ["hook"] },
  });
});

test("native session slash commands override the catalog without freezing its other controls", () => {
  const live = {
    ...caps,
    models: [{ id: "opus-next" }],
    effortLevels: ["high"],
    permissionModes: ["acceptEdits"],
    slashCommands: [{ name: "global-review", source: "user" as const }],
  };
  const sessionCommands = [{
    name: "project-review",
    source: "project" as const,
    argumentHint: "<scope>",
  }];
  const runner = { agents: [{ id: "claude", driver: "claude-code", capabilities: live }] } as RunnerView;
  const session = {
    agentId: "claude",
    driver: "claude-code",
    agentCapabilities: { slashCommands: sessionCommands },
  } as SessionView;

  assert.deepEqual(resolveCaps(runner, session), {
    ...live,
    slashCommands: sessionCommands,
  });
  assert.deepEqual(resolveCaps(runner, {
    ...session,
    agentCapabilities: { slashCommands: [] },
  }), {
    ...live,
    slashCommands: [],
  }, "an explicit empty session list must not resurrect catalog commands");
});

test("Claude controls use live runner models and never substitute a browser-side version catalog", () => {
  const live = {
    ...caps,
    models: [{ id: "opus[1m]", displayName: "Opus 5 (1M Context)", default: true }],
  };
  const runner = { agents: [{ id: "claude", driver: "claude-code", capabilities: live }] } as RunnerView;
  const session = { agentId: "claude", driver: "claude-code" } as SessionView;
  assert.deepEqual(resolveCaps(runner, session)?.models, live.models);
  assert.deepEqual(
    resolveCaps(undefined, session)?.models.map((model) => model.displayName),
    ["Default", "Opus", "Fable", "Sonnet", "Haiku"],
  );
  const adoptedLiveId = { ...session, model: "opus[1m]" };
  assert.equal(resolveCaps(undefined, adoptedLiveId)?.models[0]?.id, "opus[1m]");
  assert.equal(resolveCaps(undefined, adoptedLiveId)?.models[0]?.contextWindow, 1_000_000);
});
