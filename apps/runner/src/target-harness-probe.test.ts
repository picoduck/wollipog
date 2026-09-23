import assert from "node:assert/strict";
import test from "node:test";
import { probeTargetHarness } from "./target-harness-probe.js";

const codexHelp = "Usage: codex app-server [OPTIONS] [COMMAND]\nCommands:\n  generate-json-schema\nOptions:\n  --listen <URL> (default: stdio://)\n";
const claudeHelp = "--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"acceptEdits\", \"auto\")";

test("Claude probe uses provider-native help and structured status without exposing account data", async () => {
  const calls: string[][] = [];
  const result = await probeTargetHarness("claude-code", "2.1.205", [], async (args) => {
    calls.push(args);
    return args[0] === "--help"
      ? { code: 0, stdout: claudeHelp, stderr: "" }
      : { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "private@example.test", token: "secret" }), stderr: "" };
  });
  assert.deepEqual(calls, [["--help"], ["auth", "status"]]);
  assert.deepEqual(result, {
    authentication: "authenticated", authenticationEvidence: "claude-auth-status",
    capability: "verified", capabilityEvidence: "claude-help",
  });
  assert.doesNotMatch(JSON.stringify(result), /private@example|secret/u);
});

test("Codex probe requires a verified app-server contract and explicit local login result", async () => {
  const run = async (args: string[]) => args[0] === "app-server"
    ? { code: 0, stdout: codexHelp, stderr: "" }
    : { code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" };
  assert.deepEqual(await probeTargetHarness("codex", "0.154.0", ["app-server"], run), {
    authentication: "authenticated", authenticationEvidence: "codex-login-status",
    capability: "verified", capabilityEvidence: "codex-app-server-help",
  });
  const signedOut = await probeTargetHarness("codex", "0.154.0", [], async (args) => args[0] === "app-server"
    ? { code: 0, stdout: codexHelp, stderr: "" }
    : { code: 1, stdout: "", stderr: "Not logged in" });
  assert.equal(signedOut.authentication, "unauthenticated");
  assert.equal(signedOut.authenticationEvidence, "codex-login-status");
});

test("ambiguous output, timeout, old contract, and unknown harness fail closed", async () => {
  const ambiguous = await probeTargetHarness("codex", "0.146.0", [], async (args) => args[0] === "app-server"
    ? { code: 0, stdout: codexHelp, stderr: "" }
    : { code: 1, stdout: "token expired at private path", stderr: "" });
  assert.deepEqual(ambiguous, { authentication: "unknown", capability: "unknown" });
  const timedOut = await probeTargetHarness("claude-code", "2.1.205", [], async () =>
    ({ code: null, stdout: JSON.stringify({ loggedIn: true }), stderr: claudeHelp, timedOut: true }));
  assert.deepEqual(timedOut, { authentication: "unknown", capability: "unknown" });
  let called = false;
  const generic = await probeTargetHarness("acp-agent", "1.0.0", [], async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.equal(called, false);
  assert.deepEqual(generic, { authentication: "unknown", capability: "unknown" });
});

test("launch arguments that can redirect credentials suppress both status claims", async () => {
  let called = false;
  for (const [agentId, args] of [
    ["claude-code", ["--settings", "/etc/claude/profile.json"]],
    ["codex", ["--profile", "alternate"]],
    ["codex", ["app-server", "--listen", "tcp://127.0.0.1:1"]],
  ] as const) {
    assert.deepEqual(await probeTargetHarness(agentId, "2.1.205", [...args], async () => {
      called = true;
      return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    }), { authentication: "unknown", capability: "unknown" });
  }
  assert.equal(called, false, "no bare executable probe can describe a different configured launch");
});
