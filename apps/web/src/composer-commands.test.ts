import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSlashCommand } from "@wollipog/protocol";
import {
  COMPOSER_COMMAND_GROUPS,
  buildComposerCommandRegistry,
  commandEditDistance,
  composerRejectsUnknownCommands,
  composerCommandsForTrigger,
  composerCommandsInPickerOrder,
  composerCommandsIncludeSkills,
  findComposerCommandTrigger,
  groupComposerCommands,
  groupRankedComposerCommands,
  mapProviderComposerCommands,
  rankComposerCommands,
  replaceComposerCommandTrigger,
  replaceLeadingCommandToken,
  resolveComposerCommandInvocation,
  retainActiveComposerCommandId,
  stepComposerCommandId,
  suggestComposerCommands,
  type ComposerCommand,
  type ComposerCommandContext,
  type ProviderComposerCommand,
} from "./composer-commands.js";

function registry(
  providerCommands: readonly ProviderComposerCommand[] = [],
  context: ComposerCommandContext = { planSupported: true, canStopTurn: true },
) {
  return buildComposerCommandRegistry({ context, providerCommands });
}

function command(commands: readonly ComposerCommand[], id: string): ComposerCommand {
  const found = commands.find((candidate) => candidate.id === id);
  assert.ok(found, `missing command ${id}`);
  return found;
}

test("the registry exposes stable typed app commands and explicit gate reasons", () => {
  const enabled = registry();
  assert.deepEqual(COMPOSER_COMMAND_GROUPS, [
    { id: "app", label: "Wollipog", order: 0 },
    { id: "provider", label: "Agent", order: 1 },
    { id: "skill", label: "Skills", order: 1 },
    { id: "mcp", label: "MCP Prompts", order: 1 },
  ]);
  assert.equal(command(enabled, "app:rename-session").description, "Rename this session from its conversation.");
  assert.equal(command(enabled, "app:rename-session").label, "/rename-session");
  assert.equal("displayName" in command(enabled, "app:rename-session"), false,
    "the picker shows the typed token, not a separate action name");
  assert.deepEqual(command(enabled, "app:plan"), {
    id: "app:plan",
    name: "plan",
    label: "/plan",
    invocationAlias: "plan",
    description: "Toggle plan mode without allowing edits.",
    source: "app",
    sourceLabel: "App",
    executionMode: "app",
    available: true,
    argumentHint: "[on|off]",
    attachmentPolicy: "preserve",
    groupId: "app",
    groupLabel: "Wollipog",
  });
  assert.equal(command(enabled, "app:stop").available, true);
  assert.equal(command(enabled, "app:stop").attachmentPolicy, "preserve");
  assert.equal(command(enabled, "app:respond").available, false);
  assert.equal(command(enabled, "app:respond").disabledReason, "There is no pending question.");

  const withQuestion = registry([], { planSupported: true, canStopTurn: true, canRespond: true });
  assert.equal(command(withQuestion, "app:respond").available, true);
  assert.equal(command(withQuestion, "app:respond").label, "/respond");

  const disabled = registry([], { planSupported: false, canStopTurn: false });
  assert.deepEqual(
    disabled.map(({ id, available, disabledReason }) => ({ id, available, disabledReason })),
    [
      { id: "app:rename-session", available: true, disabledReason: undefined },
      { id: "app:plan", available: false, disabledReason: "Plan mode is unavailable for this provider." },
      { id: "app:respond", available: false, disabledReason: "There is no pending question." },
      { id: "app:stop", available: false, disabledReason: "There's no turn to stop right now." },
    ],
  );
});

test("provider commands retain metadata and app collisions receive durable aliases", () => {
  const commands = registry([
    {
      id: "catalog.plan",
      name: "PLAN",
      description: "Provider-owned planning flow.",
      providerSource: "project",
      argumentHint: "<goal>",
      executionMode: "structured",
      attachmentPolicy: "forbid",
    },
    {
      name: "Review",
      description: "Review the current changes.",
      providerSource: "builtin",
    },
    {
      name: "Deploy",
      providerSource: "plugin",
      available: false,
      disabledReason: "Deployment is unavailable in this workspace.",
    },
  ]);

  assert.deepEqual(command(commands, "provider:catalog.plan"), {
    id: "provider:catalog.plan",
    name: "PLAN",
    label: "/provider:plan",
    invocationAlias: "provider:plan",
    description: "Provider-owned planning flow.",
    source: "provider",
    sourceLabel: "Project",
    providerSource: "project",
    executionMode: "structured",
    available: true,
    argumentHint: "<goal>",
    attachmentPolicy: "forbid",
    groupId: "provider",
    groupLabel: "Agent",
  });
  assert.equal(command(commands, "provider:builtin:review").invocationAlias, "review");
  assert.equal(command(commands, "provider:builtin:review").sourceLabel, "Built-In");
  assert.equal(command(commands, "provider:builtin:review").executionMode, "passthrough");
  assert.equal(command(commands, "provider:builtin:review").attachmentPolicy, "send");
  assert.deepEqual(
    (({ available, disabledReason }) => ({ available, disabledReason }))(command(commands, "provider:plugin:deploy")),
    { available: false, disabledReason: "Deployment is unavailable in this workspace." },
  );

  const gatedAgain = registry([
    { id: "catalog.plan", name: "plan", providerSource: "project" },
  ], { planSupported: false, canStopTurn: false });
  assert.equal(command(gatedAgain, "provider:catalog.plan").invocationAlias, "provider:plan",
    "the provider alias must not change when the app command becomes unavailable");
});

test("protocol command metadata maps to passthrough registry inputs without losing argument hints", () => {
  const mapped = mapProviderComposerCommands([{
    name: "Review",
    source: "project",
    description: "Review the current changes.",
    argumentHint: "[focus]",
  }]);
  assert.deepEqual(mapped, [{
    name: "Review",
    providerSource: "project",
    description: "Review the current changes.",
    argumentHint: "[focus]",
    executionMode: "passthrough",
    attachmentPolicy: "send",
  }]);
  assert.equal(mapProviderComposerCommands([{ name: "deploy", source: "plugin" }], "forbid")[0]?.attachmentPolicy,
    "forbid", "transport-owned metadata can reach the existing composer guard");
});

test("authorized protocol commands retain opaque invocation coordinates and preserve attachments", () => {
  const mapped = mapProviderComposerCommands([{
    name: "Review",
    source: "project",
    description: "Review the current changes.",
    argumentHint: "[focus]",
    invocation: {
      id: "opaque-command-1",
      catalogRevision: "catalog-revision-7",
      executionMode: "structured",
    },
  }], "forbid");

  assert.deepEqual(mapped, [{
    name: "Review",
    providerSource: "project",
    description: "Review the current changes.",
    argumentHint: "[focus]",
    executionMode: "structured",
    attachmentPolicy: "preserve",
    providerCommandId: "opaque-command-1",
    catalogRevision: "catalog-revision-7",
  }]);

  const registered = command(registry(mapped), "provider:project:review");
  assert.equal(registered.providerCommandId, "opaque-command-1");
  assert.equal(registered.catalogRevision, "catalog-revision-7");
  assert.equal(registered.executionMode, "structured");
  assert.equal(registered.attachmentPolicy, "preserve");
});

test("present but malformed invocation authority fails closed instead of using legacy prompt dispatch", () => {
  const [mapped] = mapProviderComposerCommands([{
    name: "deploy",
    source: "plugin",
    invocation: {
      id: "opaque-command-1",
      catalogRevision: "",
      executionMode: "structured",
    },
  }]);
  assert.equal(mapped?.available, false);
  assert.equal(mapped?.providerCommandId, undefined);
  assert.equal(mapped?.catalogRevision, undefined);
  assert.equal(mapped?.attachmentPolicy, "preserve");
  const registered = command(registry(mapped ? [mapped] : []), "provider:plugin:deploy");
  assert.equal(registered.available, false);
  assert.match(registered.disabledReason ?? "", /authority is invalid/i);
});

test("provider-provider collisions are source-qualified and deterministic", () => {
  const inputs: ProviderComposerCommand[] = [
    { name: "deploy", providerSource: "user" },
    { name: "deploy", providerSource: "project" },
  ];
  const forward = registry(inputs).filter((candidate) => candidate.name === "deploy");
  const reverse = registry([...inputs].reverse()).filter((candidate) => candidate.name === "deploy");
  assert.deepEqual(
    forward.map(({ id, invocationAlias }) => ({ id, invocationAlias })),
    [
      { id: "provider:project:deploy", invocationAlias: "project:deploy" },
      { id: "provider:user:deploy", invocationAlias: "user:deploy" },
    ],
  );
  assert.deepEqual(reverse, forward);
});

test("the reserved rename command keeps the bare alias when a provider uses the same name", () => {
  const commands = registry([{ name: "rename-session", providerSource: "user" }]);
  const app = resolveComposerCommandInvocation("/rename-session", commands);
  assert.equal(app.kind, "command");
  if (app.kind === "command") assert.equal(app.command.id, "app:rename-session");
  const provider = resolveComposerCommandInvocation("/provider:rename-session", commands);
  assert.equal(provider.kind, "command");
  if (provider.kind === "command") assert.equal(provider.command.id, "provider:user:rename-session");
});

test("a stored bare provider alias remains resolvable when a same-name command appears", () => {
  const original = registry([{ name: "deploy", providerSource: "user" }]);
  assert.equal(command(original, "provider:user:deploy").invocationAlias, "deploy");

  const expandedInputs: ProviderComposerCommand[] = [
    { name: "deploy", providerSource: "user" },
    { name: "deploy", providerSource: "project" },
  ];
  for (const providerCommands of [expandedInputs, [...expandedInputs].reverse()]) {
    const expanded = registry(providerCommands);
    const resolved = resolveComposerCommandInvocation("/deploy production", expanded);
    assert.equal(resolved.kind, "command");
    if (resolved.kind === "command") {
      assert.equal(resolved.command.id, "provider:user:deploy",
        "the personal provider identity owns the durable legacy alias");
      assert.equal(resolved.arguments, "production");
    }
    const exact = resolveComposerCommandInvocation("/user:deploy production", expanded);
    assert.equal(exact.kind, "command");
    if (exact.kind === "command") assert.equal(exact.command.id, "provider:user:deploy");
  }
});

test("a legacy bare provider alias follows explicit user, project, plugin, builtin precedence", () => {
  const inputs: ProviderComposerCommand[] = [
    { name: "deploy", providerSource: "builtin" },
    { name: "deploy", providerSource: "plugin" },
    { name: "deploy", providerSource: "user" },
    { name: "deploy", providerSource: "project" },
  ];
  for (const providerCommands of [inputs, [...inputs].reverse()]) {
    const resolved = resolveComposerCommandInvocation("/deploy production", registry(providerCommands));
    assert.equal(resolved.kind, "command");
    if (resolved.kind === "command") assert.equal(resolved.command.id, "provider:user:deploy");
  }
});

test("a stored source-qualified alias follows only its exact surviving provider scope", () => {
  const userOnly = registry([{ name: "deploy", providerSource: "user" }]);
  const retainedUser = resolveComposerCommandInvocation("/user:deploy production", userOnly);
  assert.equal(retainedUser.kind, "command");
  if (retainedUser.kind === "command") assert.equal(retainedUser.command.id, "provider:user:deploy");

  const projectOnly = registry([{ name: "deploy", providerSource: "project" }]);
  const wrongSource = resolveComposerCommandInvocation("/user:deploy production", projectOnly);
  // A stored alias whose scope is gone names no command, so it is refused rather than sent (#2176).
  assert.deepEqual(wrongSource, { kind: "unknown", token: "/user:deploy", suggestions: [] });
  const retainedProject = resolveComposerCommandInvocation("/project:deploy production", projectOnly);
  assert.equal(retainedProject.kind, "command");
  if (retainedProject.kind === "command") assert.equal(retainedProject.command.id, "provider:project:deploy");
});

test("same-source provider duplicates with explicit ids receive unique stable aliases", () => {
  const commands = registry([
    { id: "catalog.alpha", name: "deploy", providerSource: "plugin" },
    { id: "catalog.beta", name: "deploy", providerSource: "plugin" },
    { id: "catalog.fallback", name: "inspect" },
  ]).filter((candidate) => candidate.source === "provider");
  assert.deepEqual(
    commands.map(({ id, invocationAlias, sourceLabel }) => ({ id, invocationAlias, sourceLabel })),
    [
      {
        id: "provider:catalog.alpha",
        invocationAlias: "plugin:deploy:catalog.alpha",
        sourceLabel: "Plugin",
      },
      {
        id: "provider:catalog.beta",
        invocationAlias: "plugin:deploy:catalog.beta",
        sourceLabel: "Plugin",
      },
      { id: "provider:catalog.fallback", invocationAlias: "inspect", sourceLabel: "Harness" },
    ],
  );
});

test("stored same-source identity aliases resolve only their surviving command", () => {
  const inputs: ProviderComposerCommand[] = [
    { id: "catalog.alpha", name: "deploy", providerSource: "plugin" },
    { id: "catalog.beta", name: "deploy", providerSource: "plugin" },
  ];
  const expanded = registry(inputs).filter((candidate) => candidate.source === "provider");
  const oldAliases = new Map(expanded.map((candidate) => [candidate.id, candidate.invocationAlias]));

  for (const surviving of inputs) {
    const survivingId = `provider:${surviving.id}`;
    const removedId = survivingId.endsWith("alpha") ? "provider:catalog.beta" : "provider:catalog.alpha";
    const collapsed = registry([surviving]);
    const retained = resolveComposerCommandInvocation(`/${oldAliases.get(survivingId)} production`, collapsed);
    assert.equal(retained.kind, "command");
    if (retained.kind === "command") {
      assert.equal(retained.command.id, survivingId);
      assert.equal(retained.arguments, "production");
    }
    assert.deepEqual(
      resolveComposerCommandInvocation(`/${oldAliases.get(removedId)} production`, collapsed),
      { kind: "unknown", token: `/${oldAliases.get(removedId)}`, suggestions: [] },
    );
    assert.deepEqual(
      resolveComposerCommandInvocation(`/${oldAliases.get(survivingId)!.replace(/^plugin:/, "user:")} production`, collapsed),
      { kind: "unknown", token: `/${oldAliases.get(survivingId)!.replace(/^plugin:/, "user:")}`, suggestions: [] },
    );
  }
});

test("stored default-provider identity aliases survive collision collapse without crossing identity", () => {
  const inputs: ProviderComposerCommand[] = [
    { id: "catalog.alpha", name: "deploy" },
    { id: "catalog.beta", name: "deploy" },
  ];
  const expanded = registry(inputs).filter((candidate) => candidate.source === "provider");
  const alphaAlias = command(expanded, "provider:catalog.alpha").invocationAlias;
  const betaAlias = command(expanded, "provider:catalog.beta").invocationAlias;
  const collapsed = registry([inputs[0]!]);
  const retained = resolveComposerCommandInvocation(`/${alphaAlias}`, collapsed);
  assert.equal(retained.kind, "command");
  if (retained.kind === "command") assert.equal(retained.command.id, "provider:catalog.alpha");
  assert.deepEqual(resolveComposerCommandInvocation(`/${betaAlias}`, collapsed), {
    kind: "unknown",
    token: `/${betaAlias}`,
    suggestions: [],
  });
  assert.deepEqual(resolveComposerCommandInvocation(`/${alphaAlias.replace(/^provider:/, "plugin:")}`, collapsed), {
    kind: "unknown",
    token: `/${alphaAlias.replace(/^provider:/, "plugin:")}`,
    suggestions: [],
  });
});

test("provider wire names preserve advertised casing while aliases and resolution stay normalized", () => {
  const commands = registry([
    { id: "catalog.mixed", name: "ReviewChanges", providerSource: "plugin", executionMode: "structured" },
  ]);
  const mixed = command(commands, "provider:catalog.mixed");
  assert.equal(mixed.name, "ReviewChanges");
  assert.equal(mixed.invocationAlias, "reviewchanges");

  const resolved = resolveComposerCommandInvocation("/REVIEWCHANGES focus on tests", commands);
  assert.equal(resolved.kind, "command");
  if (resolved.kind === "command") {
    assert.equal(resolved.command.name, "ReviewChanges", "dispatch receives the provider-advertised wire name");
    assert.equal(resolved.arguments, "focus on tests");
  }
});

test("case-only provider collisions keep one deterministic wire spelling", () => {
  const inputs: ProviderComposerCommand[] = [
    { name: "review", providerSource: "builtin" },
    { name: "Review", providerSource: "builtin" },
  ];
  const summarize = (providerCommands: readonly ProviderComposerCommand[]) => registry(providerCommands)
    .filter((candidate) => candidate.source === "provider")
    .map(({ id, name, invocationAlias }) => ({ id, name, invocationAlias }));

  assert.deepEqual(summarize(inputs), [{
    id: "provider:builtin:review",
    name: "Review",
    invocationAlias: "review",
  }]);
  assert.deepEqual(summarize([...inputs].reverse()), summarize(inputs));
});

test("ACP command names may contain colons", () => {
  const commands = registry([
    { id: "catalog.project-scan", name: "Project:Scan", providerSource: "builtin" },
  ]);
  const scan = command(commands, "provider:catalog.project-scan");
  assert.equal(scan.name, "Project:Scan");
  assert.equal(scan.invocationAlias, "project:scan");
  assert.deepEqual(findComposerCommandTrigger("/project:sc", 11), {
    start: 0,
    end: 11,
    query: "project:sc",
    raw: "/project:sc",
  });
  const resolved = resolveComposerCommandInvocation("/PROJECT:SCAN src", commands);
  assert.equal(resolved.kind, "command");
  if (resolved.kind === "command") assert.equal(resolved.command.name, "Project:Scan");
});

test("sanitized explicit-id qualifier collisions remain unique and catalog-order independent", () => {
  const inputs: ProviderComposerCommand[] = [
    { id: "catalog/a", name: "deploy", providerSource: "plugin" },
    { id: "catalog-a", name: "deploy", providerSource: "plugin" },
  ];
  const summarize = (providerCommands: readonly ProviderComposerCommand[]) => registry(providerCommands)
    .filter((candidate) => candidate.source === "provider")
    .map(({ id, invocationAlias }) => ({ id, invocationAlias }));
  const forward = summarize(inputs);
  const reverse = summarize([...inputs].reverse());

  assert.deepEqual(reverse, forward);
  assert.equal(new Set(forward.map(({ invocationAlias }) => invocationAlias)).size, 2);
  assert.ok(forward.every(({ invocationAlias }) => invocationAlias.startsWith("plugin:deploy:catalog-a:")));
  for (const { id, invocationAlias } of forward) {
    const resolved = resolveComposerCommandInvocation(`/${invocationAlias}`, registry(inputs));
    assert.equal(resolved.kind, "command");
    if (resolved.kind === "command") assert.equal(resolved.command.id, id);
  }
});

test("invocation resolution is case-normalized and, where unknown tokens are sent, they stay byte-for-byte plaintext", () => {
  const commands = registry([
    { name: "review", providerSource: "builtin", executionMode: "structured" },
    { name: "plan", providerSource: "project" },
  ]);

  const review = resolveComposerCommandInvocation("  /ReViEw focus on tests  ", commands);
  assert.equal(review.kind, "command");
  if (review.kind === "command") {
    assert.equal(review.command.id, "provider:builtin:review");
    assert.equal(review.arguments, "focus on tests");
    assert.equal(review.originalText, "  /ReViEw focus on tests  ");
  }

  const providerPlan = resolveComposerCommandInvocation("/PROVIDER:PLAN provider goal", commands);
  assert.equal(providerPlan.kind, "command");
  if (providerPlan.kind === "command") assert.equal(providerPlan.command.id, "provider:project:plan");
  const appPlan = resolveComposerCommandInvocation("/plan on", commands);
  assert.equal(appPlan.kind, "command");
  if (appPlan.kind === "command") assert.equal(appPlan.command.id, "app:plan");

  const sendUnknown = { unknownCommands: "plaintext" } as const;
  assert.deepEqual(resolveComposerCommandInvocation(" /unknown keep literal ", commands, sendUnknown), {
    kind: "plaintext",
    text: " /unknown keep literal ",
  });
  assert.deepEqual(resolveComposerCommandInvocation("/etc/hosts", commands, sendUnknown), {
    kind: "plaintext",
    text: "/etc/hosts",
  });
});

test("triggers require a leading whole-composer command context and reject paths or prose", () => {
  assert.deepEqual(findComposerCommandTrigger("/rev", 4), {
    start: 0,
    end: 4,
    query: "rev",
    raw: "/rev",
  });
  assert.equal(findComposerCommandTrigger("first line\n/review", 15), null);
  assert.deepEqual(findComposerCommandTrigger(" \n\n/review", 7), {
    start: 3,
    end: 10,
    query: "rev",
    raw: "/review",
  });
  assert.equal(findComposerCommandTrigger("prefix /rev", 11), null);
  assert.equal(findComposerCommandTrigger("  /rev", 6), null);
  assert.equal(findComposerCommandTrigger("/etc/hosts", 10), null);
  assert.equal(findComposerCommandTrigger("/review args", 12), null);
  assert.equal(findComposerCommandTrigger("/review", -1), null);
});

test("trigger replacement edits only the current slash token and leaves one argument separator", () => {
  const commands = registry([{ name: "review", providerSource: "builtin" }]);
  const review = command(commands, "provider:builtin:review");
  const text = " \n/rev   existing args\nleave this";
  const caret = text.indexOf("/rev") + 4;
  const trigger = findComposerCommandTrigger(text, caret);
  assert.ok(trigger);
  assert.deepEqual(replaceComposerCommandTrigger(text, trigger, review), {
    text: " \n/review existing args\nleave this",
    caret: " \n/review ".length,
  });
});

test("ranking is exact then prefix then boundary then substring then fuzzy", () => {
  const commands = registry([
    { name: "cat", providerSource: "builtin" },
    { name: "catalog", providerSource: "builtin" },
    { name: "run-cat", providerSource: "builtin" },
    { name: "educate", providerSource: "builtin" },
    { name: "create", providerSource: "builtin" },
    { name: "unrelated", providerSource: "builtin" },
  ]).filter((candidate) => candidate.source === "provider");
  const ranked = rankComposerCommands(commands, "cat");
  assert.deepEqual(
    ranked.map(({ command: candidate, matchKind }) => [candidate.name, matchKind]),
    [
      ["cat", "exact"],
      ["catalog", "prefix"],
      ["run-cat", "boundary"],
      ["educate", "substring"],
      ["create", "fuzzy"],
    ],
  );
});

test("description-only fuzzy matches do not capture literal slash text", () => {
  const commands = registry([], { planSupported: true, canStopTurn: false });
  assert.deepEqual(rankComposerCommands(commands, "no"), []);
});

test("available commands rank ahead of unavailable commands at the same match score", () => {
  const commands = registry([
    { name: "prime", providerSource: "user" },
  ], { planSupported: false, canStopTurn: false });
  const ranked = rankComposerCommands(commands, "p");
  assert.equal(ranked[0]?.command.id, "provider:user:prime");
  assert.equal(ranked.find(({ command: candidate }) => candidate.id === "app:plan")?.command.available, false);
});

test("grouping and active-id retention preserve stable ranked selection", () => {
  const commands = registry([
    { name: "review", providerSource: "builtin" },
    { name: "deploy", providerSource: "plugin", available: false },
  ], { planSupported: false, canStopTurn: false });
  const ranked = rankComposerCommands(commands, "").map(({ command: candidate }) => candidate);
  assert.deepEqual(
    groupComposerCommands(ranked).map(({ id, label, order, commands: grouped }) => ({
      id,
      label,
      order,
      commands: grouped.map((candidate) => candidate.id),
    })),
    [
      { id: "app", label: "Wollipog", order: 0, commands: ["app:rename-session", "app:plan", "app:respond", "app:stop"] },
      {
        id: "provider",
        label: "Agent",
        order: 1,
        commands: ["provider:builtin:review", "provider:plugin:deploy"],
      },
    ],
  );
  assert.equal(retainActiveComposerCommandId("provider:builtin:review", ranked), "provider:builtin:review");
  assert.equal(retainActiveComposerCommandId("provider:plugin:deploy", ranked), "app:rename-session",
    "an unavailable row is never active: its reason is already visible on its row");
  assert.equal(retainActiveComposerCommandId("removed", ranked), "app:rename-session",
    "fallback chooses the first available row");
  assert.equal(retainActiveComposerCommandId(null, ranked.filter((candidate) => !candidate.available)), null,
    "nothing is active when nothing can run");
  assert.equal(retainActiveComposerCommandId(null, []), null);
});

test("arrow steps skip unavailable rows and wrap at either end", () => {
  const commands = registry([
    { name: "review", providerSource: "builtin" },
    { name: "deploy", providerSource: "plugin", available: false },
    { name: "zebra", providerSource: "builtin" },
  ], { planSupported: false, canStopTurn: false });
  const offered = composerCommandsInPickerOrder(rankComposerCommands(commands, "").map(({ command: candidate }) => candidate));
  const runnable = offered.filter((candidate) => candidate.available).map((candidate) => candidate.id);
  assert.deepEqual(runnable, ["app:rename-session", "provider:builtin:review", "provider:builtin:zebra"]);
  assert.equal(stepComposerCommandId("app:rename-session", offered, 1), "provider:builtin:review");
  assert.equal(stepComposerCommandId("provider:builtin:review", offered, 1), "provider:builtin:zebra",
    "skips the unavailable deploy row");
  assert.equal(stepComposerCommandId("provider:builtin:zebra", offered, 1), "app:rename-session");
  assert.equal(stepComposerCommandId("app:rename-session", offered, -1), "provider:builtin:zebra");
  assert.equal(stepComposerCommandId(null, offered, 1), "app:rename-session");
  assert.equal(stepComposerCommandId(null, offered, -1), "provider:builtin:zebra");
  assert.equal(stepComposerCommandId(null, offered.filter((candidate) => !candidate.available), 1), null);
  assert.equal(stepComposerCommandId(null, [], 1), null);
});

test("groups name the source once each, in the order their best command ranks", () => {
  const commands = registry([
    { name: "review", providerSource: "builtin" },
    { name: "release-notes", providerSource: "skill" },
    { name: "summarize", providerSource: "user" },
  ], { planSupported: true, canStopTurn: true, agentLabel: "Codex" });
  assert.equal(command(commands, "provider:builtin:review").groupLabel, "Codex");
  assert.equal(command(commands, "provider:user:summarize").groupLabel, "Codex");
  assert.equal(command(commands, "provider:skill:release-notes").groupId, "skill");
  assert.equal(command(commands, "provider:skill:release-notes").groupLabel, "Skills");
  assert.equal(registry([{ name: "review", providerSource: "builtin" }], { planSupported: true, canStopTurn: true, agentLabel: "  " })
    .find((candidate) => candidate.name === "review")?.groupLabel, "Agent", "a blank agent name falls back");

  const ranked = rankComposerCommands(commands, "re").map(({ command: candidate }) => candidate);
  const sections = groupRankedComposerCommands(ranked);
  assert.deepEqual(sections.map((section) => section.label), [...new Set(ranked.map((candidate) => candidate.groupLabel))]);
  assert.equal(sections[0]!.label, ranked[0]!.groupLabel, "the best match's group leads");
  assert.equal(new Set(sections.map((section) => section.groupId)).size, sections.length);
  assert.deepEqual(composerCommandsInPickerOrder(ranked).map((candidate) => candidate.id).sort(),
    ranked.map((candidate) => candidate.id).sort(), "grouping drops nothing");
  // Interleaved groups are gathered under their first appearance.
  const interleaved = [command(commands, "provider:builtin:review"), command(commands, "app:plan"),
    command(commands, "provider:user:summarize")];
  assert.deepEqual(groupRankedComposerCommands(interleaved).map((section) => [section.label, section.commands.map((candidate) => candidate.name)]), [
    ["Codex", ["review", "summarize"]],
    ["Wollipog", ["plan"]],
  ]);
});

test("invalid command names are excluded before they can become path-like aliases", () => {
  const commands = registry([
    { name: "valid-command", providerSource: "builtin" },
    { name: "_scratch", providerSource: "user" },
    { name: "/compact", providerSource: "builtin" },
    { name: "etc/hosts", providerSource: "project" },
    { name: "two words", providerSource: "user" },
  ]);
  assert.deepEqual(
    commands.filter((candidate) => candidate.source === "provider")
      .map((candidate) => ({ name: candidate.name, invocationAlias: candidate.invocationAlias })),
    [
      { name: "valid-command", invocationAlias: "valid-command" },
      { name: "_scratch", invocationAlias: "_scratch" },
    ],
  );
});

function codexRegistry() {
  return registry(mapProviderComposerCommands([
    { name: "summarize", source: "user", description: "Summarize the branch" },
    { name: "review", source: "user", description: "Review prompt" },
    { name: "review", source: "skill", description: "Review skill" },
    { name: "deploy-check", source: "skill", description: "Check a deploy" },
  ]));
}

test("Codex prompts are labeled User and skills Skill, with source-qualified aliases on collision", () => {
  const commands = codexRegistry().filter((candidate) => candidate.source === "provider");
  assert.deepEqual(commands.map(({ label, sourceLabel }) => [label, sourceLabel]), [
    ["/deploy-check", "Skill"],
    ["/skill:review", "Skill"],
    ["/user:review", "User"],
    ["/summarize", "User"],
  ]);
  const resolved = (text: string) => {
    const resolution = resolveComposerCommandInvocation(text, codexRegistry());
    return resolution.kind === "command"
      ? [resolution.command.providerSource, resolution.command.name, resolution.arguments]
      : resolution.text;
  };
  assert.deepEqual(resolved("/skill:review pr 42"), ["skill", "review", "pr 42"]);
  assert.deepEqual(resolved("/review a.ts"), ["user", "review", "a.ts"], "a bare collided alias prefers the user prompt");
  assert.equal(
    registry(mapProviderComposerCommands([{ name: "future", source: "workflow" as never }]))
      .find((candidate) => candidate.name === "future")?.sourceLabel,
    "Harness",
    "an unknown future source still renders a label",
  );
});

test("$name resolves to the same skill command as /name and leaves other $ text alone", () => {
  const skillOnly = registry(mapProviderComposerCommands([{ name: "review", source: "skill", description: "Review skill" }]));
  const dollar = resolveComposerCommandInvocation("$review pr 42", skillOnly);
  const slash = resolveComposerCommandInvocation("/review pr 42", skillOnly);
  assert.equal(dollar.kind, "command");
  assert.equal(slash.kind, "command");
  assert.equal(dollar.kind === "command" && slash.kind === "command" && dollar.command.id, slash.kind === "command" && slash.command.id);
  assert.equal(dollar.kind === "command" && dollar.arguments, "pr 42");
  assert.equal(resolveComposerCommandInvocation("$REVIEW", skillOnly).kind, "command", "matching is case-insensitive");
  assert.deepEqual(resolveComposerCommandInvocation("$HOME is set", skillOnly), { kind: "plaintext", text: "$HOME is set" });
  const collided = resolveComposerCommandInvocation("$review now", codexRegistry());
  assert.equal(collided.kind === "command" && collided.command.providerSource, "skill",
    "$name names the skill even when a same-named prompt exists");
  const promptOnly = registry(mapProviderComposerCommands([{ name: "summarize", source: "user" }]));
  assert.deepEqual(resolveComposerCommandInvocation("$summarize", promptOnly), { kind: "plaintext", text: "$summarize" });
});

test("a $ trigger opens only when skills exist, offers only skills, and inserts $name", () => {
  const commands = codexRegistry();
  assert.equal(composerCommandsIncludeSkills(commands), true);
  assert.equal(composerCommandsIncludeSkills(registry()), false);
  assert.equal(findComposerCommandTrigger("$re", 3), null, "without skills a $ stays text");
  const trigger = findComposerCommandTrigger("$re", 3, { skillSigil: true });
  assert.deepEqual(trigger, { start: 0, end: 3, query: "re", raw: "$re", sigil: "$" });
  assert.equal(findComposerCommandTrigger("say $re", 7, { skillSigil: true }), null, "only a leading token triggers");
  const slash = findComposerCommandTrigger("/re", 3, { skillSigil: true });
  assert.equal(slash?.sigil, undefined, "slash triggers are unchanged");
  const offered = composerCommandsForTrigger(commands, trigger!);
  assert.deepEqual(offered.map(({ label, sourceLabel }) => [label, sourceLabel]), [
    ["$deploy-check", "Skill"],
    ["$review", "Skill"],
  ]);
  assert.equal(composerCommandsForTrigger(commands, slash!).length, commands.length);
  const review = offered.find((candidate) => candidate.name === "review")!;
  assert.deepEqual(replaceComposerCommandTrigger("$re  rest", trigger!, review), { text: "$review rest", caret: 8 });
});

/** A Claude Code session with the init-time catalog (#1224). */
function claudeInitRegistry() {
  return buildComposerCommandRegistry({
    context: { planSupported: true, canStopTurn: false, agentLabel: "Claude Code" },
    providerCommands: mapProviderComposerCommands([
      { name: "compact", source: "builtin", description: "Summarize the conversation to free up context." },
      { name: "brainstorming", source: "skill", description: "Explore an idea." },
      { name: "mcp__docs__summarize", source: "mcp" },
      { name: "release", source: "project" },
    ]),
    unsupportedCommands: [
      { name: "doctor", reason: "Claude Code's /doctor needs its own terminal, so Wollipog doesn't send it." },
      { name: "compact", reason: "A reason that must never shadow a runnable command." },
      { name: "plan", reason: "Nor an app command." },
      { name: "bad name", reason: "Invalid names are dropped." },
    ],
  });
}

test("an unsupported command never appears in a menu but resolves typed in full to its reason (#1224)", () => {
  const commands = claudeInitRegistry();
  const doctor = commands.find((command) => command.name === "doctor");
  assert.ok(doctor);
  assert.equal(doctor.hidden, true);
  assert.equal(doctor.available, false);
  assert.equal(doctor.disabledReason, "Claude Code's /doctor needs its own terminal, so Wollipog doesn't send it.");
  assert.equal(commands.filter((command) => command.hidden).length, 1,
    "an unsupported name never shadows a runnable provider or app command");

  const slash = findComposerCommandTrigger("/do", 3)!;
  assert.ok(!composerCommandsForTrigger(commands, slash).some((command) => command.hidden));
  assert.ok(!rankComposerCommands(composerCommandsForTrigger(commands, slash), "doctor")
    .some((match) => match.command.name === "doctor"));

  const typed = resolveComposerCommandInvocation("/doctor", commands);
  assert.equal(typed.kind, "command");
  if (typed.kind === "command") {
    assert.equal(typed.command.available, false, "the composer shows the reason instead of sending it");
    assert.match(typed.command.disabledReason ?? "", /needs its own terminal/);
  }
});

test("MCP prompts carry their own source label and qualified alias (#1224)", () => {
  const commands = claudeInitRegistry();
  const mcp = commands.find((command) => command.name === "mcp__docs__summarize");
  assert.equal(mcp?.sourceLabel, "MCP");
  assert.equal(mcp?.groupLabel, "MCP Prompts", "the picker names an MCP prompt's source by its group");
  const qualified = resolveComposerCommandInvocation("/mcp:mcp__docs__summarize now", commands);
  assert.equal(qualified.kind === "command" && qualified.command.id, mcp?.id);
});

test("without the skill sigil a $ reference stays text, and a skill still runs as /name (#1224)", () => {
  const commands = claudeInitRegistry();
  assert.deepEqual(resolveComposerCommandInvocation("$brainstorming pricing", commands, { skillSigil: false }), {
    kind: "plaintext",
    text: "$brainstorming pricing",
  });
  const slashed = resolveComposerCommandInvocation("/brainstorming pricing", commands, { skillSigil: false });
  assert.equal(slashed.kind === "command" && slashed.command.providerSource, "skill");
  const codex = resolveComposerCommandInvocation("$brainstorming pricing", commands);
  assert.equal(codex.kind, "command", "Codex keeps its $name spelling by default");
});
function unknownCommandRegistry() {
  return registry([
    { name: "compact", providerSource: "builtin" },
    { name: "review", providerSource: "builtin" },
    { name: "context", providerSource: "builtin" },
    { name: "deploy", providerSource: "project", available: false, disabledReason: "Deploys are off." },
  ]);
}

test("a message that starts with an unknown slash token resolves as unknown, with close matches", () => {
  const commands = unknownCommandRegistry();
  const compat = resolveComposerCommandInvocation("/compat", commands);
  assert.equal(compat.kind, "unknown");
  if (compat.kind === "unknown") {
    assert.equal(compat.token, "/compat");
    assert.deepEqual(compat.suggestions.map((command) => command.label), ["/compact"]);
  }
  // Prose after the token doesn't make it text; a swapped pair of letters is one edit.
  const reveiw = resolveComposerCommandInvocation("  /reveiw please check the diff ", commands);
  assert.equal(reveiw.kind, "unknown");
  if (reveiw.kind === "unknown") {
    assert.equal(reveiw.token, "/reveiw");
    assert.deepEqual(reveiw.suggestions.map((command) => command.label), ["/review"]);
  }
  // A path at the start of the message is a token too, and nothing is close to it.
  assert.deepEqual(resolveComposerCommandInvocation("/tmp/out.log", commands), {
    kind: "unknown",
    token: "/tmp/out.log",
    suggestions: [],
  });
});

test("text that doesn't start with a slash, or escapes it, is sent as text", () => {
  const commands = unknownCommandRegistry();
  assert.deepEqual(resolveComposerCommandInvocation("see /tmp/out.log", commands), {
    kind: "plaintext",
    text: "see /tmp/out.log",
  });
  assert.deepEqual(resolveComposerCommandInvocation("\\/literal", commands), { kind: "plaintext", text: "/literal" });
  assert.deepEqual(resolveComposerCommandInvocation("//literal", commands), { kind: "plaintext", text: "/literal" });
  // Only the escape goes: the rest, an escaped known command included, is sent as written.
  assert.deepEqual(resolveComposerCommandInvocation("  //compact now ", commands), {
    kind: "plaintext",
    text: "  /compact now ",
  });
  assert.deepEqual(resolveComposerCommandInvocation("/", commands), { kind: "plaintext", text: "/" });
  // The escape applies in a session that still sends unknown tokens as text.
  assert.deepEqual(resolveComposerCommandInvocation("//x", commands, { unknownCommands: "plaintext" }), {
    kind: "plaintext",
    text: "/x",
  });
  assert.deepEqual(resolveComposerCommandInvocation("/compat", commands, { unknownCommands: "plaintext" }), {
    kind: "plaintext",
    text: "/compat",
  });
});

test("known commands, unavailable ones included, and $ references resolve as before", () => {
  const commands = unknownCommandRegistry();
  const plan = resolveComposerCommandInvocation("/plan please", commands);
  assert.equal(plan.kind === "command" && plan.command.id, "app:plan",
    "an app command with arguments it doesn't take is still a command here; send treats it as text");
  const deploy = resolveComposerCommandInvocation("/deploy", commands);
  assert.equal(deploy.kind === "command" && deploy.command.available, false);
  assert.deepEqual(resolveComposerCommandInvocation("$HOME", commands), { kind: "plaintext", text: "$HOME" });
});

test("close matches are available commands within one edit per three letters, closest first, at most three", () => {
  const commands = registry([
    { name: "review", providerSource: "builtin" },
    { name: "reviews", providerSource: "project" },
    { name: "preview", providerSource: "project" },
    { name: "revie", providerSource: "user" },
    { name: "rewiew", providerSource: "plugin", available: false },
  ]);
  // /rewiew is one edit away but unavailable; the three at two edits tie and keep the label order,
  // so the fourth, /reviews, is left out.
  assert.deepEqual(suggestComposerCommands("reveiw", commands).map((command) => command.label),
    ["/review", "/preview", "/revie"]);
  assert.equal(suggestComposerCommands("Review", commands)[0]?.label, "/review", "matching ignores case");
  assert.deepEqual(suggestComposerCommands("zz", commands), [], "a short token allows one edit");
  assert.deepEqual(suggestComposerCommands("", commands), []);
  assert.equal(commandEditDistance("reveiw", "review"), 1);
  assert.equal(commandEditDistance("compat", "compact"), 1);
  assert.equal(commandEditDistance("", "abc"), 3);
});

test("a bounded edit distance agrees with the full one up to its limit and stops early past it", () => {
  const words = ["", "a", "ab", "ba", "review", "reveiw", "rveiew", "preview", "compact", "compat", "cmopact",
    "context", "kontext", "deploy", "ploy", "abcdef", "badcfe", "release-notes", "relaese-ntoes"];
  for (const left of words) {
    for (const right of words) {
      const full = commandEditDistance(left, right);
      for (const limit of [0, 1, 2, 3]) {
        assert.equal(commandEditDistance(left, right, limit), Math.min(full, limit + 1), `${left} → ${right} ≤ ${limit}`);
      }
    }
  }
  // A pasted path at the start of a message is rejected by length before any table is built.
  assert.equal(commandEditDistance("some-path/".repeat(100), "review", 3), 4);
});

test("Use /review replaces only the leading token and keeps the rest of the message", () => {
  const review = command(unknownCommandRegistry(), "provider:builtin:review");
  assert.deepEqual(replaceLeadingCommandToken("/reveiw please check the diff", review), {
    text: "/review please check the diff",
    caret: 8,
  });
  assert.deepEqual(replaceLeadingCommandToken("  /reveiw", review), { text: "  /review ", caret: 10 });
  assert.deepEqual(replaceLeadingCommandToken("/reveiw\nsecond line", review), {
    text: "/review \nsecond line",
    caret: 8,
  });
});

test("unknown tokens are refused except on a Claude Code runner without the init-time catalog", () => {
  const disk: Pick<AgentSlashCommand, "source">[] = [{ source: "user" }, { source: "project" }];
  // An older runner reports only Claude Code's disk commands, so its built-ins still need the
  // plain-text fallback.
  assert.equal(composerRejectsUnknownCommands("claude-code", disk), false);
  assert.equal(composerRejectsUnknownCommands("claude-code", []), false);
  // A #1224 runner forwards the init-time catalog, whose built-ins carry source `builtin`.
  assert.equal(composerRejectsUnknownCommands("claude-code", [...disk, { source: "builtin" }]), true);
  for (const driver of ["codex", "codex-app-server", "pi", "acp", undefined] as const) {
    assert.equal(composerRejectsUnknownCommands(driver, []), true, `${driver} never runs unadvertised slash text`);
  }
});
