import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  applyAgentModelDiscovery,
  commandDirectoriesForDriver,
  codexAgentDefinitions,
  mergeAgents,
  probedAuthFileStatus,
  parseVersion,
  unavailableCodexAgentDefinition,
  unavailableClaudeAgentDefinition,
} from "./discover.js";

test("Codex prompts and skills are not advertised as slash commands", () => {
  assert.deepEqual(commandDirectoriesForDriver("codex"), []);
  assert.deepEqual(commandDirectoriesForDriver("codex-app-server"), []);
  assert.deepEqual(commandDirectoriesForDriver("claude-code"), [{ dir: ".claude/commands", source: "user" }]);
});

test("parseVersion extracts a semver token from --version noise", () => {
  assert.equal(parseVersion("1.2.3"), "1.2.3");
  assert.equal(parseVersion("claude 1.2.3 (Claude Code)"), "1.2.3");
  assert.equal(parseVersion("codex-cli 0.142.3\n"), "0.142.3");
  assert.equal(parseVersion("v2.39.3-beta1 extra"), "2.39.3-beta1");
});

test("parseVersion falls back to the first line, or undefined when empty", () => {
  assert.equal(parseVersion("some-build-id"), "some-build-id");
  assert.equal(parseVersion("   \n  "), undefined);
  assert.equal(parseVersion(""), undefined);
});

const SUPPORTED_APP_SERVER = {
  status: "supported" as const,
  installedVersion: "0.144.1",
  appServerAvailable: true,
  transport: "stdio" as const,
  contractFingerprint: "contract",
};

test("supported Codex discovery emits app-server primary then stable exec compatibility target", () => {
  const native = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", bin: "codex", version: "0.144.1", source: "discovered" }),
    SUPPORTED_APP_SERVER,
    [{ name: "review", source: "user" }],
  );
  assert.deepEqual(native.map((agent) => [agent.id, agent.driver, agent.available]), [
    ["codex", "codex-app-server", true],
    ["codex-exec", "codex", true],
  ]);
  assert.deepEqual(native[0]!.capabilities?.slashCommands, [{ name: "review", source: "user" }]);
  assert.equal(native[0]!.capabilities?.supportsSteering, true);
  assert.equal(native[1]!.capabilities?.supportsSteering, undefined);
  assert.equal(native[1]!.codexAppServer?.status, "supported");

  const wsl = codexAgentDefinitions(
    cfg({ id: "codex-wsl-Ubuntu", name: "Codex (WSL: Ubuntu)", driver: "codex", context: { kind: "wsl", distro: "Ubuntu" } }),
    SUPPORTED_APP_SERVER,
    [],
  );
  assert.deepEqual(wsl.map((agent) => agent.id), ["codex-wsl-Ubuntu", "codex-exec-wsl-Ubuntu"]);
});

test("a signed-out Codex is discovered but not ready, and signing in restores both rows", () => {
  const base = cfg({ id: "codex", name: "Codex", driver: "codex", source: "discovered" });
  const signedOut = codexAgentDefinitions({ ...base, authStatus: "unauthenticated" }, SUPPORTED_APP_SERVER, []);
  assert.deepEqual(signedOut.map((agent) => [agent.id, agent.available, agent.authStatus]), [
    ["codex", false, "unauthenticated"],
    ["codex-exec", false, "unauthenticated"],
  ]);
  // Only a confirmed missing login gates; unknown auth must not disable a working install.
  const unknown = codexAgentDefinitions({ ...base, authStatus: "unknown" }, SUPPORTED_APP_SERVER, []);
  assert.deepEqual(unknown.map((agent) => agent.available), [true, true]);
  const signedIn = codexAgentDefinitions({ ...base, authStatus: "authenticated" }, SUPPORTED_APP_SERVER, []);
  assert.deepEqual(signedIn.map((agent) => agent.available), [true, true]);
});

test("a config-declared OPENAI_API_KEY keeps Codex available despite a missing auth file", () => {
  const discovered = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", command: "/usr/bin/codex", source: "discovered", authStatus: "unauthenticated" }),
    SUPPORTED_APP_SERVER,
    [],
  );
  // Production shape: the runner redacts config env to {} and carries the declared key only as
  // a non-secret auth assertion, so the merge must honor the assertion, not the key value.
  const apiKeyed = mergeAgents(
    [cfg({ id: "codex", command: "/usr/bin/codex", driver: "codex-app-server", env: {}, authStatus: "authenticated" })],
    discovered,
  )[0]!;
  assert.equal(apiKeyed.available, true, "deliberate API-billing config stays selectable");
  assert.equal(apiKeyed.authStatus, "authenticated");
  const disabled = mergeAgents(
    [cfg({ id: "codex", command: "/usr/bin/codex", driver: "codex-app-server", env: {}, authStatus: "authenticated", available: false })],
    discovered,
  )[0]!;
  assert.equal(disabled.available, false, "explicit config availability wins over the assertion");
  // A key-less config row must not resurrect a gated discovery result.
  const plain = mergeAgents([cfg({ id: "codex", command: "/usr/bin/codex", driver: "codex-app-server" })], discovered)[0]!;
  assert.equal(plain.available, false);
});

test("a failed or timed-out auth-file probe reports unknown, not signed-out", () => {
  assert.equal(probedAuthFileStatus({ code: 0 }), "authenticated");
  assert.equal(probedAuthFileStatus({ code: 1 }), "unauthenticated");
  assert.equal(probedAuthFileStatus({ code: null, timedOut: true }), "unknown");
  assert.equal(probedAuthFileStatus({ code: 1, errorCode: "ENOENT" }), "unknown");
});

test("unsupported Codex keeps a disabled primary and an enabled exec row carrying the fallback reason", () => {
  const compatibility = {
    status: "unsupported" as const,
    installedVersion: "0.143.0",
    appServerAvailable: true,
    failure: { code: "version_unverified" as const, message: "Upgrade Codex for app-server." },
  };
  const agents = codexAgentDefinitions(cfg({ id: "codex", name: "Codex", driver: "codex" }), compatibility, []);
  assert.equal(agents[0]!.driver, "codex-app-server");
  assert.equal(agents[0]!.available, false);
  assert.equal(agents[0]!.capabilities?.supportsSteering, undefined);
  assert.equal(agents[1]!.available, true);
  assert.equal(agents[1]!.codexAppServer?.failure?.message, "Upgrade Codex for app-server.");
});

test("missing Codex produces one explicit unavailable primary and no fake exec fallback", () => {
  const unavailable = unavailableCodexAgentDefinition("codex", "Codex", { kind: "native" });
  assert.equal(unavailable.driver, "codex-app-server");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.capabilities?.supportsSteering, undefined);
  assert.equal(unavailable.codexAppServer?.status, "unavailable");
  assert.equal(unavailable.codexAppServer?.failure?.code, "codex_unavailable");
});

test("missing Claude produces an explicit unavailable row with safe remediation", () => {
  const unavailable = unavailableClaudeAgentDefinition("claude-code", "Claude Code", { kind: "native" });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.claudeCode?.status, "unavailable");
  assert.equal(unavailable.claudeCode?.failure?.code, "claude_unavailable");
});

test("merge applies explicit API billing and preserves an explicit config disable", () => {
  const diagnostic = {
    status: "unauthenticated" as const,
    installedVersion: "2.1.205",
    effortLevels: ["low"], permissionModes: ["acceptEdits"], streamJsonInput: true,
    streamJsonImages: true, controlProtocol: true, forkSession: true, replayUserMessages: true,
    auth: { status: "unauthenticated" as const, billingSource: "unknown" as const },
    failure: { code: "unauthenticated" as const, message: "not signed in" },
  };
  const discovered = [cfg({ id: "claude-code", command: "/usr/bin/claude", source: "discovered", available: false, claudeCode: diagnostic })];
  const api = mergeAgents([cfg({ id: "api", command: "/usr/bin/claude", env: { ANTHROPIC_API_KEY: "secret" } })], discovered)[0]!;
  assert.equal(api.available, true);
  assert.equal(api.claudeCode?.auth.billingSource, "api");
  assert.equal(JSON.stringify(api.claudeCode).includes("secret"), false);
  const disabled = mergeAgents([cfg({ id: "off", command: "/usr/bin/claude", env: { ANTHROPIC_API_KEY: "secret" }, available: false })], discovered)[0]!;
  assert.equal(disabled.available, false, "explicit config availability wins");
});

test("model enrichment excludes hidden capabilities from aggregate knobs while retaining their metadata", () => {
  const base = cfg({
    id: "codex",
    driver: "codex-app-server",
    capabilities: { models: [], effortLevels: ["catalog"], slashCommands: [], supportsImages: true, supportsApprovals: true },
  });
  const enriched = applyAgentModelDiscovery(base, {
    source: "live",
    models: [
      { id: "text", default: true, efforts: ["low"], inputModalities: ["text"] },
      { id: "hidden-image", hidden: true, efforts: ["ultra"], inputModalities: ["text", "image"] },
    ],
  });
  assert.equal(enriched.capabilities?.models.length, 2, "hidden model remains addressable for persisted sessions");
  assert.deepEqual(enriched.capabilities?.effortLevels, ["low"]);
  assert.equal(enriched.capabilities?.supportsImages, false, "hidden image model does not advertise picker capability");
  assert.equal(enriched.capabilities?.modelSource, "live");
});

test("Claude model metadata cannot re-enable unverified effort or image transport", () => {
  const base = cfg({
    capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false },
    claudeCode: {
      status: "ready", installedVersion: "2.1.100", effortLevels: [], permissionModes: ["acceptEdits"],
      streamJsonInput: true, streamJsonImages: false, controlProtocol: false, forkSession: false,
      replayUserMessages: false, auth: { status: "unknown", billingSource: "unknown" },
    },
  });
  const enriched = applyAgentModelDiscovery(base, {
    source: "live",
    models: [{ id: "future", efforts: ["max"], inputModalities: ["text", "image"] }],
  });
  assert.deepEqual(enriched.capabilities?.effortLevels, []);
  assert.equal(enriched.capabilities?.models[0]?.efforts, undefined);
  assert.equal(enriched.capabilities?.supportsImages, false);
});

test("Claude model-specific efforts are limited to help-verified installation levels", () => {
  const base = cfg({
    capabilities: { models: [], effortLevels: ["low"], slashCommands: [], supportsImages: false, supportsApprovals: false },
    claudeCode: {
      status: "ready", installedVersion: "2.1.220", effortLevels: ["low"], permissionModes: ["dontAsk"],
      streamJsonInput: true, streamJsonImages: false, controlProtocol: true, forkSession: false,
      replayUserMessages: false, auth: { status: "unknown", billingSource: "unknown" },
    },
  });
  const enriched = applyAgentModelDiscovery(base, {
    source: "live",
    models: [{ id: "opus", efforts: ["low", "high"] }],
  });
  assert.deepEqual(enriched.capabilities?.effortLevels, ["low"]);
  assert.deepEqual(enriched.capabilities?.models[0]?.efforts, ["low"]);
});

const cfg = (over: Partial<AgentDefinition>): AgentDefinition => ({
  id: "x",
  name: "X",
  command: "claude",
  args: [],
  env: {},
  driver: "claude-code",
  context: { kind: "native" },
  source: "config",
  ...over,
});

test("mergeAgents appends discovered agents not present in config", () => {
  const config = [cfg({ id: "mock", driver: "acp", command: "node" })];
  const discovered = [cfg({ id: "claude-code", command: "/usr/bin/claude", source: "discovered" })];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((a) => a.id),
    ["mock", "claude-code"],
  );
});

test("mergeAgents drops a discovered agent that shares an id with config", () => {
  const config = [cfg({ id: "claude-code", command: "/custom/claude" })];
  const discovered = [cfg({ id: "claude-code", command: "/usr/bin/claude", source: "discovered" })];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.command, "/custom/claude", "config command wins");
});

test("mergeAgents drops a discovered agent with the same launch target (driver/context/command)", () => {
  const config = [cfg({ id: "my-claude", command: "/usr/bin/claude" })];
  const discovered = [cfg({ id: "claude-code", command: "/usr/bin/claude", source: "discovered" })];
  assert.equal(mergeAgents(config, discovered).length, 1, "same command+driver+context dedupes");
});

test("mergeAgents enriches a matching config agent with discovered version/auth/commands", () => {
  const config = [cfg({ id: "my-claude", command: "/usr/bin/claude", capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false } })];
  const discovered = [
    cfg({
      id: "claude-code",
      command: "/usr/bin/claude",
      source: "discovered",
      version: "2.1.0",
      authStatus: "authenticated",
      capabilities: { models: [], effortLevels: [], slashCommands: [{ name: "deploy", source: "user" }], supportsImages: false, supportsApprovals: false },
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1, "enriched in place, not appended");
  assert.equal(merged[0]!.id, "my-claude", "config identity kept");
  assert.equal(merged[0]!.command, "/usr/bin/claude");
  assert.equal(merged[0]!.version, "2.1.0", "version enriched from discovery");
  assert.equal(merged[0]!.authStatus, "authenticated", "auth enriched from discovery");
  assert.deepEqual(merged[0]!.capabilities?.slashCommands, [{ name: "deploy", source: "user" }]);
});

test("Claude discovery replaces stale configured optional capabilities", () => {
  const stale = {
    models: [],
    effortLevels: ["max"],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    supportsConversationFork: false,
    permissionModes: ["auto"],
    elicitation: { auto: ["stdio-control" as const] },
  };
  const verified = {
    models: [],
    effortLevels: ["low"],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: false,
    supportsConversationFork: true,
    permissionModes: ["acceptEdits"],
    elicitation: { acceptEdits: ["none" as const] },
  };
  const merged = mergeAgents(
    [cfg({ id: "configured", command: "/usr/bin/claude", capabilities: stale })],
    [cfg({ id: "discovered", command: "/usr/bin/claude", source: "discovered", capabilities: verified })],
  )[0]!;
  assert.deepEqual(merged.capabilities?.effortLevels, ["low"]);
  assert.deepEqual(merged.capabilities?.permissionModes, ["acceptEdits"]);
  assert.deepEqual(merged.capabilities?.elicitation, { acceptEdits: ["none"] });
  assert.equal(merged.capabilities?.supportsImages, false);
  assert.equal(merged.capabilities?.supportsApprovals, false);
  assert.equal(merged.capabilities?.supportsConversationFork, true);
});

test("Claude discovery clears stale elicitation when a re-probe no longer verifies the transport", () => {
  const stale = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: true,
    permissionModes: ["default"],
    elicitation: { default: ["stdio-control" as const] },
  };
  const downgraded = {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: false,
    permissionModes: ["acceptEdits"],
  };
  const merged = mergeAgents(
    [cfg({ id: "configured", command: "/usr/bin/claude", capabilities: stale })],
    [cfg({ id: "discovered", command: "/usr/bin/claude", source: "discovered", capabilities: downgraded })],
  )[0]!;
  assert.equal(merged.capabilities?.elicitation, undefined);
});

test("mergeAgents keeps a discovered native agent even when its id matches a config ACP agent (P1)", () => {
  const config = [cfg({ id: "codex", driver: "acp", command: "npx", context: { kind: "native" } })];
  const discovered = [
    cfg({ id: "codex", driver: "codex", command: "/usr/bin/codex", context: { kind: "native" }, source: "discovered", version: "0.1" }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 2, "ACP config agent and native discovered agent both survive");
  const ids = merged.map((a) => a.id);
  assert.ok(ids.includes("codex"), "config ACP id kept");
  assert.ok(ids.includes("codex-native"), "discovered native renamed to avoid the id collision");
  assert.equal(merged.find((a) => a.id === "codex")!.driver, "acp");
  assert.equal(merged.find((a) => a.id === "codex-native")!.version, "0.1");
});

test("mergeAgents enriches a config agent that uses a bare command name (P2 basename match)", () => {
  const config = [
    cfg({
      id: "claude",
      driver: "claude-code",
      command: "claude",
      context: { kind: "native" },
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false },
    }),
  ];
  const discovered = [
    cfg({
      id: "claude-code",
      driver: "claude-code",
      command: "/home/u/.local/bin/claude",
      context: { kind: "native" },
      source: "discovered",
      version: "2.0",
      authStatus: "authenticated",
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1, "bare-name config matched the resolved path, no duplicate");
  assert.equal(merged[0]!.id, "claude");
  assert.equal(merged[0]!.version, "2.0");
  assert.equal(merged[0]!.authStatus, "authenticated");
});

test("mergeAgents matches a node-wrapped npm shim to a bare config name (nvm codex)", () => {
  // A version-manager install launches as `node .../codex.js`; launchKey must key on the
  // SCRIPT basename so a config entry naming "codex" still enriches instead of duplicating.
  const config = [
    cfg({
      id: "my-codex",
      driver: "codex",
      command: "codex",
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false },
    }),
  ];
  const discovered = [
    cfg({
      id: "codex",
      driver: "codex",
      command: "/home/u/.nvm/versions/node/v25.2.1/bin/node",
      args: ["/home/u/.nvm/versions/node/v25.2.1/lib/node_modules/@openai/codex/bin/codex.js"],
      source: "discovered",
      version: "0.142.5",
      authStatus: "authenticated",
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1, "node-wrapped shim matched the bare config name");
  assert.equal(merged[0]!.id, "my-codex");
  assert.equal(merged[0]!.version, "0.142.5");
  // The bare name is a POINTER, not a launch override — and it can't spawn from the daemon's
  // non-login PATH (the whole reason discovery had to node-wrap). Adopt the resolved launch.
  assert.equal(merged[0]!.command, "/home/u/.nvm/versions/node/v25.2.1/bin/node", "resolved launch adopted");
  assert.equal(merged[0]!.args?.length, 1);
});

test("mergeAgents keeps a path-ful config command as a genuine launch override", () => {
  const config = [cfg({ id: "mine", driver: "codex", command: "/opt/custom/codex" })];
  const discovered = [
    cfg({ id: "codex", driver: "codex", command: "/u/.nvm/v/bin/node", args: ["/u/lib/codex.js"], source: "discovered", version: "1.0" }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.find((a) => a.id === "mine")!.command, "/opt/custom/codex", "path-ful config launch kept");
});

test("mergeAgents keeps node-wrapped shims of DIFFERENT scripts distinct", () => {
  const discovered = [
    cfg({ id: "codex", driver: "codex", command: "/u/.nvm/v/bin/node", args: ["/u/lib/codex.js"], source: "discovered" }),
    cfg({ id: "other", driver: "codex", command: "/u/.nvm/v/bin/node", args: ["/u/lib/other.js"], source: "discovered" }),
  ];
  assert.equal(mergeAgents([], discovered).length, 2, "same node, different scripts — different targets");
});

test("mergeAgents: generic entry names (index.js/cli.js) key on the full script path", () => {
  // Two DIFFERENT agents whose npm entry files are both dist/index.js must not unify.
  const discovered = [
    cfg({ id: "a", driver: "acp", command: "/u/.nvm/v/bin/node", args: ["/u/lib/codex-acp/dist/index.js"], source: "discovered" }),
    cfg({ id: "b", driver: "acp", command: "/u/.nvm/v/bin/node", args: ["/u/lib/claude-acp/dist/index.js"], source: "discovered" }),
  ];
  assert.equal(mergeAgents([], discovered).length, 2, "index.js entries of different packages stay distinct");

  // WITHOUT a `bin` stamp (pre-v18 data), a bare config name can't match a generic entry file —
  // it duplicates (safe fallback) rather than risking a mis-merge.
  const config = [cfg({ id: "my-claude", driver: "claude-code", command: "claude" })];
  const nvmClaude = [
    cfg({ id: "claude-code", driver: "claude-code", command: "/u/.nvm/v/bin/node", args: ["/u/lib/claude/cli.js"], source: "discovered" }),
  ];
  assert.equal(mergeAgents(config, nvmClaude).length, 2, "no bin + cli.js entry — appended, not merged");
});

test("mergeAgents: discovery's `bin` stamp matches a bare config name even for generic entry files", () => {
  // The R32 review case: nvm claude launches as `node .../cli.js`; the generic-entry rule alone
  // can't match config "claude", but discovery KNOWS it resolved the binary named "claude".
  const config = [
    cfg({
      id: "my-claude",
      driver: "claude-code",
      command: "claude",
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false },
    }),
  ];
  const discovered = [
    cfg({
      id: "claude-code",
      driver: "claude-code",
      command: "/u/.nvm/versions/node/v25.2.1/bin/node",
      args: ["/u/.nvm/versions/node/v25.2.1/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
      bin: "claude",
      source: "discovered",
      version: "2.1.198",
      authStatus: "authenticated",
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1, "bin identity merged instead of duplicating");
  assert.equal(merged[0]!.id, "my-claude");
  assert.equal(merged[0]!.version, "2.1.198");
  assert.equal(merged[0]!.command, "/u/.nvm/versions/node/v25.2.1/bin/node", "resolved launch adopted for the bare name");
  assert.equal(merged[0]!.args?.length, 1);
});

test("mergeAgents: a config entry pinning the EXACT node-wrapped launch still merges (no bin needed)", () => {
  // The copied-config regression case: the user copied discovery's resolved launch into config. That entry
  // has no `bin` and a generic cli.js entry file — the bin key alone would miss it, so the
  // launch-SHAPE key must match as a fallback: one enriched row, not a duplicate pair.
  const node = "/home/u/.nvm/versions/node/v25.2.1/bin/node";
  const cli = "/home/u/.nvm/versions/node/v25.2.1/lib/node_modules/@anthropic-ai/claude-code/cli.js";
  const config = [cfg({ id: "my-claude", driver: "claude-code", command: node, args: [cli] })];
  const discovered = [
    cfg({
      id: "claude-code",
      driver: "claude-code",
      command: node,
      args: [cli],
      bin: "claude",
      source: "discovered",
      version: "2.1.198",
      authStatus: "authenticated",
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1, "exact-launch config matched via the shape key");
  assert.equal(merged[0]!.id, "my-claude", "config identity kept");
  assert.equal(merged[0]!.version, "2.1.198", "enriched from discovery");
  assert.equal(merged[0]!.command, node, "path-ful config launch kept (genuine override)");
});

test("mergeAgents keeps WSL and native of the same agent as distinct targets", () => {
  const config: AgentDefinition[] = [];
  const discovered = [
    cfg({ id: "claude-code", command: "/usr/bin/claude", context: { kind: "native" }, source: "discovered" }),
    cfg({ id: "claude-code-wsl-Ubuntu", command: "/usr/bin/claude", context: { kind: "wsl", distro: "Ubuntu" }, source: "discovered" }),
  ];
  assert.equal(mergeAgents(config, discovered).length, 2, "native and WSL are different launch targets");
});

test("mergeAgents carries the fresh discovered app-server contract onto a bare explicit Codex config", () => {
  const config = [cfg({
    id: "my-codex",
    driver: "codex",
    command: "codex",
    codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio", contractFingerprint: "stale" },
  })];
  const discovered = [
    cfg({
      id: "codex",
      driver: "codex",
      command: "/usr/bin/codex",
      bin: "codex",
      source: "discovered",
      codexAppServer: {
        status: "unsupported",
        installedVersion: "0.142.3",
        appServerAvailable: true,
        transport: "stdio",
        failure: { code: "version_unverified", message: "Use codex exec fallback." },
      },
    }),
  ];
  const merged = mergeAgents(config, discovered);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.codexAppServer?.failure?.code, "version_unverified");
});

test("unmatched custom app-server config cannot self-advertise steering", () => {
  const custom = cfg({
    id: "custom-app-server",
    driver: "codex-app-server",
    command: "/opt/custom/codex",
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      supportsSteering: true,
    },
  });
  const [merged] = mergeAgents([custom], []);
  assert.equal(merged!.capabilities?.supportsSteering, undefined);
});

test("old app-server discovery clears stale steering from a matching config", () => {
  const configured = cfg({
    id: "configured-app-server",
    driver: "codex-app-server",
    command: "codex",
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      supportsSteering: true,
    },
  });
  const discovered = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", command: "/usr/bin/codex", bin: "codex", source: "discovered" }),
    {
      status: "unsupported", installedVersion: "0.143.0", appServerAvailable: true,
      failure: { code: "version_unverified", message: "Old Codex." },
    },
    [],
  );
  const [merged] = mergeAgents([configured], discovered);
  assert.equal(merged!.codexAppServer?.status, "unsupported");
  assert.equal(merged!.capabilities?.supportsSteering, undefined);
});

test("verified app-server discovery enables steering on a matching config", () => {
  const configured = cfg({ id: "configured-app-server", driver: "codex-app-server", command: "codex" });
  const discovered = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", command: "/usr/bin/codex", bin: "codex", source: "discovered" }),
    SUPPORTED_APP_SERVER,
    [],
  );
  const [merged] = mergeAgents([configured], discovered);
  assert.equal(merged!.codexAppServer?.status, "supported");
  assert.equal(merged!.capabilities?.supportsSteering, true);
});

test("explicit app-server config enriches from the primary without duplicating its launch", () => {
  const config = [cfg({ id: "my-interactive-codex", driver: "codex-app-server", command: "codex" })];
  const discovered = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", command: "/usr/bin/codex", bin: "codex", source: "discovered", version: "0.144.1" }),
    SUPPORTED_APP_SERVER,
    [],
  );
  const merged = mergeAgents(config, discovered);
  assert.deepEqual(merged.map((agent) => [agent.id, agent.driver]), [
    ["my-interactive-codex", "codex-app-server"],
    ["codex-exec", "codex"],
  ]);
  assert.equal(merged[0]!.version, "0.144.1");
  assert.equal(merged[0]!.codexAppServer?.status, "supported");
});

test("explicit legacy exec config survives while the colliding primary gets an app-server id", () => {
  const config = [cfg({ id: "codex", name: "My Codex Exec", driver: "codex", command: "codex" })];
  const discovered = codexAgentDefinitions(
    cfg({ id: "codex", name: "Codex", driver: "codex", command: "/usr/bin/codex", bin: "codex", source: "discovered", version: "0.144.1" }),
    SUPPORTED_APP_SERVER,
    [],
  );
  const merged = mergeAgents(config, discovered);
  assert.deepEqual(merged.map((agent) => [agent.id, agent.driver]), [
    ["codex", "codex"],
    ["codex-app-server", "codex-app-server"],
  ]);
  assert.equal(merged[0]!.name, "My Codex Exec", "explicit config identity and label are preserved");
});

test("mergeAgents preserves an explicit diagnostic when an old discovered row omits it", () => {
  const configured = cfg({
    id: "my-codex",
    driver: "codex",
    command: "codex",
    codexAppServer: {
      status: "unsupported",
      appServerAvailable: false,
      failure: { code: "app_server_unavailable", message: "Configured fallback." },
    },
  });
  const oldDiscovered = cfg({
    id: "codex",
    driver: "codex",
    command: "/usr/bin/codex",
    bin: "codex",
    source: "discovered",
    codexAppServer: undefined,
  });
  assert.equal(mergeAgents([configured], [oldDiscovered])[0]!.codexAppServer?.failure?.message, "Configured fallback.");
});
