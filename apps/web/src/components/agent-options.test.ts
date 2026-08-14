import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import {
  advancedAgentOptions,
  agentDriverLabel,
  agentMeta,
  agentOptions,
  currentAgentSelectionIssue,
  defaultRunAgentIds,
  firstEnabledAgentId,
  isAdvancedAgentId,
  primaryAgentOptions,
  runnableAgentIds,
  savedAgentSelection,
  sessionAgentLabel,
} from "./agent-options.js";

/** Minimal agent factory — only the fields the labeling logic reads. */
function agent(p: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return { command: "x", args: [], env: {}, available: true, ...p };
}

const labels = (agents: AgentDefinition[]) => agentOptions(agents).map((o) => o.label);

test("driver presentation never exposes protocol ids", () => {
  assert.equal(agentDriverLabel(agent({ id: "codex", name: "Codex", driver: "codex-app-server" })), "Codex App Server");
  assert.equal(agentDriverLabel(agent({ id: "exec", name: "Codex", driver: "codex" })), "Codex Non-Interactive");
  assert.equal(agentDriverLabel(agent({ id: "claude", name: "Claude", driver: "claude-code" })), "Claude Code Native");
  assert.equal(agentDriverLabel(agent({ id: "gemini", name: "Gemini", driver: "acp" })), "ACP Adapter");
});

test("families group and order: Claude Code, then Codex, then Conductor last", () => {
  const out = labels([
    agent({ id: "conductor", name: "Conductor (agent manager)", driver: "claude-code" }),
    agent({ id: "codex", name: "Codex (native)", driver: "codex" }),
    agent({ id: "claude", name: "Claude Code", driver: "claude-code" }),
  ]);
  assert.deepEqual(out, ["Claude Code", "Codex — Non-Interactive (codex exec)", "Conductor (Wollipog)"]);
});

test("both persisted Conductor generations normalize to the current Wollipog label", () => {
  const out = labels([agent({ id: "persisted-conductor", name: "Conductor (Wollipog)", driver: "claude-code" })]);
  assert.deepEqual(out, ["Conductor (Wollipog)"]);
});

test("custom names containing Conductor are not rewritten as the generated identity", () => {
  assert.deepEqual(labels([agent({ id: "custom", name: "My Conductor", driver: "acp" })]), ["My Conductor"]);
});

test("single-variant family drops the redundant 'Native' suffix", () => {
  // Only one Claude entry ⇒ just "Claude Code", not "Claude Code — Native".
  const out = labels([agent({ id: "claude", name: "Claude Code", driver: "claude-code" })]);
  assert.deepEqual(out, ["Claude Code"]);
});

test("Codex variants keep app-server and exec distinct per context, with app-server first", () => {
  const out = labels([
    agent({ id: "codex-wsl", name: "Codex (WSL: Ubuntu-24.04)", driver: "codex", context: { kind: "wsl", distro: "Ubuntu-24.04" } }),
    agent({ id: "codex-app", name: "Codex (app-server)", driver: "codex-app-server" }),
    agent({ id: "codex-native", name: "Codex (native)", driver: "codex" }),
  ]);
  assert.deepEqual(out, [
    "Codex — Interactive (Recommended)",
    "Codex — Non-Interactive (codex exec)",
    "Codex — Non-Interactive (codex exec) · WSL: Ubuntu-24.04",
  ]);
});

test("ordinary and advanced disclosures separate interactive Codex from exec", () => {
  const opts = agentOptions([
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({ id: "claude", name: "Claude", driver: "claude-code" }),
  ]);
  assert.deepEqual(primaryAgentOptions(opts).map((option) => option.agent.id), ["claude", "codex"]);
  assert.deepEqual(advancedAgentOptions(opts).map((option) => option.agent.id), ["codex-exec"]);
  assert.equal(isAdvancedAgentId(opts, "codex-exec"), true);
  assert.equal(isAdvancedAgentId(opts, "codex"), false);
});

test("fresh selection preserves family order while preferring app-server within Codex", () => {
  const opts = agentOptions([
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "claude", name: "Claude", driver: "claude-code" }),
  ]);
  assert.equal(firstEnabledAgentId(opts), "claude");
  assert.deepEqual(
    opts.filter((option) => option.agent.driver?.startsWith("codex")).map((option) => option.agent.id),
    ["codex", "codex-exec"],
  );
});

test("a disabled primary does not belong to the Advanced disclosure", () => {
  const opts = agentOptions([
    agent({ id: "claude", name: "Claude", driver: "claude-code", available: false }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
  ]);
  assert.equal(savedAgentSelection(opts, "claude").issue, "unavailable");
  assert.equal(isAdvancedAgentId(opts, "claude"), false);
  assert.equal(isAdvancedAgentId(opts, "codex-exec"), true);
  assert.equal(currentAgentSelectionIssue(opts, "claude", undefined), "unavailable");
});

test("saved legacy, unavailable, and missing defaults require an explicit migration", () => {
  const opts = agentOptions([
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({ id: "missing", name: "Missing", driver: "claude-code", available: false }),
  ]);
  assert.deepEqual(savedAgentSelection(opts, undefined), { agentId: "codex", recommendedId: "codex" });
  assert.deepEqual(savedAgentSelection(opts, "codex-exec"), {
    agentId: "codex-exec",
    issue: "legacy",
    recommendedId: "codex",
  });
  assert.deepEqual(savedAgentSelection(opts, "missing"), {
    agentId: "missing",
    issue: "unavailable",
    recommendedId: "codex",
  });
  assert.deepEqual(savedAgentSelection(opts, "gone"), {
    agentId: "codex",
    issue: "missing",
    recommendedId: "codex",
  });
});

test("legacy exec migration targets interactive Codex in the same context, never Claude", () => {
  const opts = agentOptions([
    agent({ id: "claude", name: "Claude", driver: "claude-code" }),
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({
      id: "codex-wsl-Ubuntu",
      name: "Codex WSL",
      driver: "codex-app-server",
      context: { kind: "wsl", distro: "Ubuntu" },
    }),
    agent({
      id: "codex-exec-wsl-Ubuntu",
      name: "Codex exec WSL",
      driver: "codex",
      context: { kind: "wsl", distro: "Ubuntu" },
    }),
  ]);
  assert.equal(savedAgentSelection(opts, "codex-exec").recommendedId, "codex");
  assert.equal(
    savedAgentSelection(opts, "codex-exec-wsl-Ubuntu").recommendedId,
    "codex-wsl-Ubuntu",
  );
});

test("exec-only runners do not nag about an unavailable interactive migration", () => {
  const opts = agentOptions([
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
  ]);
  assert.deepEqual(savedAgentSelection(opts, "codex-exec"), {
    agentId: "codex-exec",
    recommendedId: "codex-exec",
  });
});

test("config-authored and discovered names both normalize to the same variant label", () => {
  // "Claude Code (WSL)" (config prose) and a native discovered entry ⇒ consistent labels.
  const out = labels([
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code" }),
    agent({ id: "claude-wsl", name: "Claude Code (WSL)", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" } }),
  ]);
  assert.deepEqual(out, ["Claude Code — Native", "Claude Code — WSL: Ubuntu-24.04"]);
});

test("same variant from two sources collapses to one, preferring the available agent", () => {
  const opts = agentOptions([
    agent({ id: "codex-cfg", name: "Codex (native)", driver: "codex", available: false }),
    agent({ id: "codex-disc", name: "Codex", driver: "codex", available: true }),
  ]);
  assert.deepEqual(opts.map((o) => o.label), ["Codex — Non-Interactive (codex exec)"]);
  assert.equal(opts[0]!.agent.id, "codex-disc"); // the available one wins
});

test("ACP duplicate is hidden when a native harness exists for the same provider", () => {
  const out = labels([
    agent({ id: "claude-code", name: "Claude Code (ACP)" }), // acp, no driver
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code" }),
  ]);
  assert.deepEqual(out, ["Claude Code"]); // ACP entry suppressed
});

test("session discovery can retain an ACP adapter beside its native provider", () => {
  const opts = agentOptions([
    agent({ id: "claude-acp", name: "Claude Code (ACP)" }),
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code" }),
  ], { includeProviderAdapters: true });
  assert.deepEqual(opts.map((option) => option.agent.id), ["claude-native", "claude-acp"]);
});

test("ACP agent with no native counterpart (e.g. Gemini) stays visible", () => {
  const out = labels([
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code" }),
    agent({ id: "gemini", name: "Gemini CLI" }), // acp, google — no native driver
  ]);
  assert.ok(out.includes("Gemini CLI"));
});

test("agentMeta describes where it runs, version, and auth", () => {
  assert.equal(
    agentMeta(agent({ id: "a", name: "A", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, version: "1.2.3" })),
    "Runs on WSL · Ubuntu-24.04 · v1.2.3",
  );
  assert.equal(
    agentMeta(agent({ id: "b", name: "B", driver: "codex", authStatus: "unauthenticated" })),
    "Not signed in · run `codex login` on the runner host, then rediscover · runs on native host",
  );
});

test("agentMeta names the login fix for signed-out Codex instead of a generic unavailable label", () => {
  const meta = agentMeta(agent({
    id: "codex",
    name: "Codex",
    driver: "codex-app-server",
    available: false,
    authStatus: "unauthenticated",
    codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio" },
  }));
  assert.match(meta, /codex login/);
  assert.doesNotMatch(meta, /Interactive target unavailable/);
  assert.doesNotMatch(meta, /interactive target ready/);
  // A signed-out non-codex ACP agent keeps the generic note.
  assert.match(agentMeta(agent({ id: "g", name: "Gemini", driver: "acp", authStatus: "unauthenticated" })), /not signed in/);
  // A WSL row's auth lives inside the distro, so the fix must point there, not at the host.
  const wsl = agentMeta(agent({
    id: "codex-wsl-Ubuntu",
    name: "Codex",
    driver: "codex-app-server",
    available: false,
    authStatus: "unauthenticated",
    context: { kind: "wsl", distro: "Ubuntu" },
  }));
  assert.match(wsl, /codex login` inside Ubuntu/);
  assert.doesNotMatch(wsl, /on the runner host/);
});

test("agentMeta exposes Registry transport, adapter version, and approval state", () => {
  const meta = agentMeta(agent({
    id: "gemini",
    name: "Gemini CLI",
    driver: "acp",
    available: false,
    registry: {
      id: "gemini",
      schemaVersion: "1.0.0",
      adapterVersion: "0.50.0",
      description: "Google's official CLI for Gemini",
      transport: "stdio",
      distribution: "npx",
      installPreview: "npx --yes @google/gemini-cli@0.50.0 --acp",
      installStatus: "approval-required",
      authentication: "required-live-verification",
    },
  }));
  assert.match(meta, /ACP stdio/);
  assert.match(meta, /adapter v0\.50\.0/);
  assert.match(meta, /install approval required/);
});

test("agentMeta exposes configured ACP as runner-local stdio", () => {
  assert.match(agentMeta(agent({ id: "acp", name: "ACP", driver: "acp", acpTransport: "stdio" })), /ACP stdio/);
});

test("agentMeta surfaces interactive readiness and a safe batch fallback reason", () => {
  assert.match(
    agentMeta(agent({
      id: "ready",
      name: "Codex",
      driver: "codex-app-server",
      codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio" },
    })),
    /interactive target ready/,
  );
  assert.match(
    agentMeta(agent({
      id: "fallback",
      name: "Codex",
      driver: "codex",
      codexAppServer: {
        status: "unsupported",
        appServerAvailable: false,
        failure: { code: "app_server_unavailable", message: "This Codex installation does not expose app-server." },
      },
    })),
    /batch fallback: This Codex installation does not expose app-server/,
  );
});

test("agentMeta does not promise image support when capabilities are unknown", () => {
  const meta = agentMeta(agent({ id: "unknown", name: "Codex", driver: "codex-app-server" }));
  assert.doesNotMatch(meta, /images/);
  assert.match(meta, /Interactive approvals.*resumable conversations/);
});

test("agentMeta identifies a supported exec row as non-interactive rather than the App Server target", () => {
  assert.match(
    agentMeta(agent({
      id: "codex-exec",
      name: "Codex exec",
      driver: "codex",
      codexAppServer: { status: "supported", appServerAvailable: true, transport: "stdio" },
    })),
    /Non-interactive via codex exec.*approval settings are fixed before each turn.*non-interactive fallback ready/,
  );
});

test("agentMeta surfaces an explicit not-installed reason", () => {
  const meta = agentMeta(agent({
      id: "missing-codex",
      name: "Codex",
      driver: "codex-app-server",
      available: false,
      codexAppServer: {
        status: "unavailable",
        appServerAvailable: false,
        failure: { code: "codex_unavailable", message: "Codex is not installed in this runner context." },
      },
    }));
  assert.match(meta, /Interactive target unavailable/);
  assert.match(meta, /unavailable: Codex is not installed in this runner context/);
  assert.doesNotMatch(meta, /Interactive approvals/);
});

test("an unavailable native harness does NOT hide a working ACP fallback", () => {
  const out = labels([
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code", available: false }),
    agent({ id: "claude-acp", name: "Claude Code (ACP)", available: true }), // acp fallback
  ]);
  assert.ok(out.some((l) => /ACP/.test(l)), `ACP fallback should stay visible, got ${JSON.stringify(out)}`);
});

test("a newly available native harness removes its now-hidden ACP duplicate from runnable ids", () => {
  assert.deepEqual(runnableAgentIds([
    agent({ id: "claude-acp", name: "Claude Code (ACP)", available: true }),
    agent({ id: "claude-native", name: "Claude Code", driver: "claude-code", available: true }),
  ]), ["claude-native"]);
});

test("multi-agent runs exclude known-unavailable discovery rows", () => {
  assert.deepEqual(runnableAgentIds([
    agent({ id: "codex", name: "Codex", driver: "codex-app-server", available: false }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex", available: true }),
    agent({ id: "config", name: "Config agent", driver: "acp", available: undefined }),
  ]), ["codex-exec", "config"]);
});

test("multi-agent run defaults exclude advanced exec while keeping it explicitly runnable", () => {
  const agents = [
    agent({ id: "codex", name: "Codex", driver: "codex-app-server" }),
    agent({ id: "codex-exec", name: "Codex exec", driver: "codex" }),
    agent({ id: "claude", name: "Claude", driver: "claude-code" }),
  ];
  assert.deepEqual(defaultRunAgentIds(agents), ["claude", "codex"]);
  assert.deepEqual(runnableAgentIds(agents), ["claude", "codex", "codex-exec"]);
});

test("persisted session labels audit the actual Codex driver", () => {
  assert.equal(sessionAgentLabel("Codex", "codex-app-server"), "Codex — Interactive");
  assert.equal(sessionAgentLabel("Codex", "codex"), "Codex — Non-Interactive (codex exec)");
  assert.equal(sessionAgentLabel("Claude Code", "claude-code"), "Claude Code");
  assert.equal(sessionAgentLabel("Conductor (Agent Manager)", "claude-code"), "Conductor (Wollipog)");
  assert.equal(sessionAgentLabel("Conductor (Wollipog)", "claude-code"), "Conductor (Wollipog)");
  assert.equal(sessionAgentLabel("Configured", "claude-code", "conductor"), "Conductor (Wollipog)");
  assert.equal(sessionAgentLabel(null, "acp", "gemini"), "gemini");
});
