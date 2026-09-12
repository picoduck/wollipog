import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPOSER_COMMAND_GROUPS,
  buildComposerCommandRegistry,
  findComposerCommandTrigger,
  groupComposerCommands,
  mapProviderComposerCommands,
  rankComposerCommands,
  replaceComposerCommandTrigger,
  resolveComposerCommandInvocation,
  retainActiveComposerCommandId,
  type ComposerCommand,
  type ProviderComposerCommand,
} from "./composer-commands.js";

function registry(
  providerCommands: readonly ProviderComposerCommand[] = [],
  context = { planSupported: true, canStopTurn: true },
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
    { id: "app", label: "App Commands", order: 0 },
    { id: "provider", label: "Harness Commands", order: 1 },
  ]);
  assert.equal(command(enabled, "app:rename-session").description, "Rename this session from its conversation.");
  assert.equal(command(enabled, "app:rename-session").label, "/rename-session");
  assert.equal(command(enabled, "app:rename-session").displayName, "Rename Session");
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
    groupLabel: "App Commands",
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
      { id: "app:stop", available: false, disabledReason: "There is no active turn to stop." },
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
    groupLabel: "Harness Commands",
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
  assert.deepEqual(wrongSource, { kind: "plaintext", text: "/user:deploy production" });
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
      { kind: "plaintext", text: `/${oldAliases.get(removedId)} production` },
    );
    assert.deepEqual(
      resolveComposerCommandInvocation(`/${oldAliases.get(survivingId)!.replace(/^plugin:/, "user:")} production`, collapsed),
      { kind: "plaintext", text: `/${oldAliases.get(survivingId)!.replace(/^plugin:/, "user:")} production` },
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
    kind: "plaintext",
    text: `/${betaAlias}`,
  });
  assert.deepEqual(resolveComposerCommandInvocation(`/${alphaAlias.replace(/^provider:/, "plugin:")}`, collapsed), {
    kind: "plaintext",
    text: `/${alphaAlias.replace(/^provider:/, "plugin:")}`,
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

test("invocation resolution is case-normalized and unknown text remains byte-for-byte plaintext", () => {
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

  assert.deepEqual(resolveComposerCommandInvocation(" /unknown keep literal ", commands), {
    kind: "plaintext",
    text: " /unknown keep literal ",
  });
  assert.deepEqual(resolveComposerCommandInvocation("/etc/hosts", commands), {
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
      { id: "app", label: "App Commands", order: 0, commands: ["app:rename-session", "app:plan", "app:respond", "app:stop"] },
      {
        id: "provider",
        label: "Harness Commands",
        order: 1,
        commands: ["provider:builtin:review", "provider:plugin:deploy"],
      },
    ],
  );
  assert.equal(retainActiveComposerCommandId("provider:plugin:deploy", ranked), "provider:plugin:deploy",
    "a disabled row may remain active so its reason is readable");
  assert.equal(retainActiveComposerCommandId("removed", ranked), "app:rename-session",
    "fallback chooses the first available ranked row while unavailable rows remain selectable");
  assert.equal(retainActiveComposerCommandId(null, []), null);
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
