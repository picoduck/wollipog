import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { agentDisplayName, agentStatus } from "./agent-presentation.js";
import { agentNotice, agentSignInFact, machineAgentGroups, notInstalledLabel } from "./machine-agents.js";
import { statusMeta } from "./status-meta.js";

/** The machine's agent rows and Agent Details (#2990): one status per agent, and one fix. */

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: "agent", name: "Agent", command: "agent", args: [], env: {}, available: true, ...overrides };
}

const claude = (overrides: Partial<NonNullable<AgentDefinition["claudeCode"]>> = {}): AgentDefinition["claudeCode"] => ({
  status: "ready", effortLevels: [], permissionModes: [], streamJsonInput: true, streamJsonImages: true,
  controlProtocol: true, forkSession: true, replayUserMessages: true,
  auth: { status: "authenticated", billingSource: "subscription" }, ...overrides,
});

const missingClaude = agent({
  id: "claude", name: "Claude Code", driver: "claude-code", source: "discovered", available: false,
  claudeCode: claude({
    status: "unavailable", auth: { status: "unknown", billingSource: "unknown" },
    failure: { code: "claude_unavailable", message: "Claude Code was not found in this runner context." },
  }),
});
const signedOutCodex = agent({
  id: "codex", name: "Codex", driver: "codex-app-server", source: "discovered", authStatus: "unauthenticated",
  codexAppServer: { status: "supported", appServerAvailable: true },
});
const registry = (installStatus: NonNullable<AgentDefinition["registry"]>["installStatus"]): AgentDefinition["registry"] => ({
  id: "gemini", schemaVersion: "1", adapterVersion: "1.2.0", description: "Google's coding agent", transport: "stdio",
  distribution: "npx", installPreview: "npx @google/gemini-cli@1.2.0 --acp", installStatus,
  authentication: "required-live-verification",
} as NonNullable<AgentDefinition["registry"]>);
const waitingGemini = agent({ id: "gemini", name: "Gemini CLI", driver: "acp", source: "registry", available: false, registry: registry("approval-required") });
const readyClaude = agent({ id: "claude-ready", name: "Claude Code", driver: "claude-code", version: "2.1.4", authStatus: "authenticated", claudeCode: claude() });

test("agentStatus names one status per agent, the most limiting first", () => {
  assert.equal(agentStatus(missingClaude), "not_installed");
  assert.equal(agentStatus(signedOutCodex), "sign_in_required");
  assert.equal(agentStatus(waitingGemini), "approval_required");
  assert.equal(agentStatus(readyClaude), "ready");
  // A missing CLI is Not Installed whatever else it reports, never Unavailable.
  assert.equal(agentStatus({ ...missingClaude, authStatus: "unauthenticated" }), "not_installed");
  assert.equal(agentStatus(agent({ driver: "codex-app-server", codexAppServer: { status: "unavailable", appServerAvailable: false } })),
    "not_installed");
  assert.equal(agentStatus(agent({ available: false, unavailableReason: "The configured command was not found or could not be started." })),
    "not_installed");
  // Too old for Wollipog outranks the sign-in it would also need.
  assert.equal(agentStatus(agent({
    driver: "codex-app-server", authStatus: "unauthenticated",
    codexAppServer: { status: "unsupported", appServerAvailable: false, failure: { code: "contract_mismatch", message: "Too old." } },
  })), "update_required");
  assert.equal(agentStatus(agent({ driver: "claude-code", claudeCode: claude({ status: "unsupported" }) })), "update_required");
});

test("agentStatus keeps a failed check and a missing Git Bash out of Update Required", () => {
  assert.equal(agentStatus(agent({
    driver: "codex-app-server",
    codexAppServer: { status: "unsupported", appServerAvailable: false, failure: { code: "probe_timeout", message: "Timed out.", retryable: true } },
  })), "unavailable");
  assert.equal(agentStatus(agent({
    driver: "claude-code",
    claudeCode: claude({ status: "unsupported", failure: { code: "unsupported_mode", message: "Claude Code requires Git for Windows Bash." } }),
  })), "unavailable");
  assert.equal(agentStatus(agent({ driver: "codex" })), "unavailable");
  assert.equal(agentStatus(agent({ available: undefined })), "unavailable");
  assert.equal(agentStatus(agent({ registry: registry("unsupported-platform") })), "unavailable");
  assert.equal(agentStatus(agent({ available: false, registry: registry("manual-only") })), "not_installed");
});

test("a ready agent on a machine that is not online reads Ready When Last Seen, neutral and hollow", () => {
  assert.equal(agentStatus(readyClaude, false), "ready_when_last_seen");
  // Only Ready is qualified: the last report of a problem is still the problem.
  assert.equal(agentStatus(signedOutCodex, false), "sign_in_required");
  const meta = statusMeta("agent", "ready_when_last_seen");
  assert.equal(meta.label, "Ready When Last Seen");
  assert.equal(meta.tone, "neutral");
  assert.equal(meta.hollow, true);
});

test("two installations of one harness get distinct names, by version or else where they run", () => {
  const appServer = (id: string, version: string, context?: AgentDefinition["context"]) => agent({
    id, name: "Codex Interactive", driver: "codex-app-server", source: "discovered", version, ...(context ? { context } : {}),
  });
  const current = appServer("codex-a", "0.155.1");
  const older = appServer("codex-b", "0.140.0");
  assert.equal(agentDisplayName(current, [current, older]), "Codex App Server (v0.155.1)");
  assert.equal(agentDisplayName(older, [current, older]), "Codex App Server (v0.140.0)");
  // Alone, or without the machine's other agents, the name stays plain.
  assert.equal(agentDisplayName(current, [current]), "Codex App Server");
  assert.equal(agentDisplayName(current), "Codex App Server");
  const wsl = appServer("codex-wsl", "0.155.1", { kind: "wsl", distro: "Ubuntu" });
  assert.equal(agentDisplayName(wsl, [current, wsl]), "Codex App Server (WSL: Ubuntu)");
  assert.equal(agentDisplayName(current, [current, wsl]), "Codex App Server (Native)");
  // Same version and context: the executable tells them apart.
  const a = { ...current, installation: { id: "a", path: "/usr/bin/codex", via: "path" as const } };
  const b = { ...current, id: "codex-c", installation: { id: "b", path: "/opt/codex/bin/codex", via: "common-dir" as const } };
  assert.equal(agentDisplayName(b, [a, b]), "Codex App Server (/opt/codex/bin/codex)");
});

test("not-installed agents fold into their own group, and No Agents Ready reads every report", () => {
  const groups = machineAgentGroups([readyClaude, missingClaude, signedOutCodex], true);
  assert.deepEqual(groups.listed.map((row) => [row.agent.id, row.status]), [["claude-ready", "ready"], ["codex", "sign_in_required"]]);
  assert.deepEqual(groups.notInstalled.map((row) => row.agent.id), ["claude"]);
  assert.equal(groups.anyReady, true);
  assert.equal(machineAgentGroups([missingClaude, signedOutCodex], true).anyReady, false);
  // Offline, a ready agent was ready when last seen: no install prompt for every offline machine.
  assert.equal(machineAgentGroups([readyClaude], false).anyReady, true);
  assert.equal(notInstalledLabel(3), "3 Agents Not Installed");
  assert.equal(notInstalledLabel(1), "1 Agent Not Installed");
});

test("Agent Details leads with what is wrong and its fix", () => {
  const context = { os: "macos" as const, online: true, name: "Claude Code", verified: true };
  assert.equal(agentNotice(readyClaude, context), null);
  const missing = agentNotice(missingClaude, context)!;
  assert.equal(missing.title, "Not Installed");
  assert.equal(missing.tone, "neutral");
  assert.equal(missing.text, "Claude Code was not found in this runner context. Install it, then rediscover.");
  assert.equal(missing.command, "curl -fsSL https://claude.ai/install.sh | bash");
  const signIn = agentNotice(signedOutCodex, { ...context, name: "Codex App Server" })!;
  assert.equal(signIn.tone, "warning");
  assert.equal(signIn.command, "codex login");
  assert.equal(agentNotice(waitingGemini, { ...context, name: "Gemini CLI" })!.action, "approve_launch");
  const broken = agent({ available: false, unavailableReason: "It exited at once.", installation: { id: "i", path: "/bin/x", via: "path", selection: "selected" } });
  const unavailable = agentNotice(broken, context)!;
  assert.equal(unavailable.tone, "danger");
  assert.equal(unavailable.text, "It exited at once.");
  assert.equal(unavailable.action, "choose_installation");
  // A runner that cannot verify availability says so, rather than guessing at a cause.
  assert.match(agentNotice(agent({ available: undefined }), { ...context, verified: false })!.text, /Update the runner/u);
  assert.match(agentNotice(readyClaude, { ...context, online: false })!.text, /was ready when this machine was last seen/u);
});

test("the Sign-In fact says how a signed-in agent bills", () => {
  assert.equal(agentSignInFact(readyClaude), "Signed In (Subscription)");
  assert.equal(agentSignInFact(signedOutCodex), "Not Signed In");
  assert.equal(agentSignInFact(agent({ authStatus: "authenticated", codexBillingSource: "api" })), "Signed In (API Billing)");
  assert.equal(agentSignInFact(agent()), "Unknown");
});
