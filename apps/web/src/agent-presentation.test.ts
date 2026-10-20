import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { agentDisplayName } from "./agent-presentation.js";

function agent(id: string, name: string): AgentDefinition {
  return { id, name, command: "agent", args: [], env: {}, driver: "claude-code" };
}

test("discovered Codex transports keep their canonical user-facing names", () => {
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex"), driver: "codex-app-server", source: "discovered" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-exec", "Codex"), driver: "codex", source: "discovered" }), "Codex (Non-Interactive)");
});

test("generated legacy App Server names normalize without rewriting custom configured names", () => {
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex — Interactive"), driver: "codex-app-server" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-app", "Codex Interactive"), driver: "codex-app-server" }), "Codex App Server");
  assert.equal(agentDisplayName({ ...agent("codex-app", "My Codex"), driver: "codex-app-server" }), "My Codex");
});

test("without identifiers a namesake is qualified by its version or where it runs, else left plain", () => {
  const native = (id: string, path: string, version?: string): AgentDefinition => ({
    ...agent(id, "Claude Code"), context: { kind: "native" }, ...(version ? { version } : {}),
    installation: { id, path, via: "path", selection: "selected" },
  });
  const twins = [native("agent-one", "/opt/one/claude"), native("agent-two", "/opt/two/claude")];
  assert.equal(agentDisplayName(twins[0]!, twins), "Claude Code (/opt/one/claude)", "by default the path tells them apart");
  assert.equal(agentDisplayName(twins[0]!, twins, { identifiers: false }), "Claude Code");
  const pathless = [agent("agent-one", "Claude Code"), agent("agent-two", "Claude Code")];
  assert.equal(agentDisplayName(pathless[0]!, pathless), "Claude Code (agent-one)");
  assert.equal(agentDisplayName(pathless[0]!, pathless, { identifiers: false }), "Claude Code");
  const versions = [native("agent-one", "/opt/one/claude", "2.1"), native("agent-two", "/opt/two/claude", "2.0")];
  assert.equal(agentDisplayName(versions[0]!, versions, { identifiers: false }), "Claude Code (v2.1)");
  const wsl = [{ ...pathless[0]!, context: { kind: "wsl" as const, distro: "Ubuntu" } }, pathless[1]!];
  assert.equal(agentDisplayName(wsl[0]!, wsl, { identifiers: false }), "Claude Code (WSL: Ubuntu)");
});
