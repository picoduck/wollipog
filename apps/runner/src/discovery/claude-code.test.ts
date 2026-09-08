import assert from "node:assert/strict";
import test from "node:test";
import {
  applyClaudeConfiguredAuth,
  applyClaudeAgentEnvironment,
  applyNativeClaudeGitBashReadiness,
  CLAUDE_STEERING_MIN_VERSION,
  claudeCapabilitiesFromProbe,
  nativeClaudeGitBashCandidates,
  parseClaudeAuthStatus,
  parseClaudeHelp,
  probeClaudeCode,
  resolveNativeClaudeGitBash,
  verifiedNativeClaudeGitBashPath,
} from "./claude-code.js";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

test("parseClaudeHelp gates flags and enumerated values from the resolved CLI", () => {
  const parsed = parseClaudeHelp(`
  --effort <level>  Effort (low, medium, high)
  --input-format <format>  text or stream-json
  --output-format <format> text, json, stream-json
  --permission-mode <mode> (choices: "acceptEdits", "auto", "plan")
  --tools <tools>
  --safe-mode
  --strict-mcp-config
  --mcp-config <config>
  --setting-sources <sources>
  --no-session-persistence
  --disable-slash-commands
  --no-chrome
  --system-prompt <prompt>
  --fork-session fork it
  --replay-user-messages replay
`);
  assert.deepEqual(parsed.effortLevels, ["low", "medium", "high"]);
  assert.deepEqual(parsed.permissionModes, ["acceptEdits", "auto", "plan"]);
  assert.equal(parsed.streamJsonInput, true);
  assert.equal(parsed.forkSession, true);
  assert.equal(parsed.replayUserMessages, true);
  assert.equal(parsed.sessionNaming, true);
  assert.equal(parseClaudeHelp("--permission-mode (choices: plan)\n--output-format text").sessionNaming, false);
});

test("normalized Claude capabilities expose fork and per-mode elicitation only when verified", () => {
  const base = { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false };
  const probe = {
    status: "ready" as const,
    installedVersion: CLAUDE_STEERING_MIN_VERSION,
    effortLevels: [],
    permissionModes: ["acceptEdits", "auto", "plan", "bypassPermissions"],
    streamJsonInput: true,
    streamJsonImages: true, controlProtocol: true, forkSession: true, replayUserMessages: true,
    auth: { status: "authenticated" as const, billingSource: "subscription" as const },
  };
  const capabilities = claudeCapabilitiesFromProbe(base, probe);
  assert.equal(capabilities.supportsSteering, true);
  assert.equal(capabilities.supportsConversationFork, true);
  assert.deepEqual(capabilities.permissionModes, ["default", "auto", "acceptEdits", "plan", "bypassPermissions"]);
  assert.deepEqual(capabilities.elicitation, {
    default: ["stdio-control"],
    auto: ["stdio-control"],
    acceptEdits: ["none"],
    plan: ["none"],
    bypassPermissions: ["none"],
  });
  assert.equal(claudeCapabilitiesFromProbe(base, { ...probe, status: "unsupported", forkSession: true }).supportsConversationFork, false);
  assert.equal(claudeCapabilitiesFromProbe(base, { ...probe, status: "unsupported" }).supportsSteering, undefined);
  assert.equal(claudeCapabilitiesFromProbe(base, { ...probe, replayUserMessages: false }).supportsSteering, undefined);
  assert.equal(claudeCapabilitiesFromProbe(base, { ...probe, installedVersion: "2.1.240" }).supportsSteering, undefined);
});

test("Claude fixed modes remain explicitly unavailable without the control protocol", () => {
  const base = { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: false };
  const capabilities = claudeCapabilitiesFromProbe(base, {
    status: "ready" as const,
    effortLevels: [],
    permissionModes: ["acceptEdits"],
    streamJsonInput: false,
    streamJsonImages: false,
    controlProtocol: false,
    forkSession: false,
    replayUserMessages: false,
    auth: { status: "authenticated" as const, billingSource: "subscription" as const },
  });
  assert.deepEqual(capabilities.elicitation, {
    acceptEdits: ["none"],
  });
});

test("auth status parser persists no identity or organization fields", () => {
  const auth = parseClaudeAuthStatus(ok(JSON.stringify({
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max",
    email: "secret@example.com", orgId: "secret-org", orgName: "Secret Org",
  })));
  assert.deepEqual(auth, {
    status: "authenticated", method: "claude.ai", provider: "firstParty",
    billingSource: "subscription", subscriptionType: "max",
  });
  assert.equal(JSON.stringify(auth).includes("secret"), false);
});

test("configured API billing overrides unauthenticated account readiness without retaining the key", () => {
  const base = {
    status: "unauthenticated" as const, installedVersion: "2.1.205", effortLevels: [], permissionModes: [],
    streamJsonInput: true, streamJsonImages: true, controlProtocol: true, forkSession: true,
    replayUserMessages: true, auth: { status: "unauthenticated" as const, billingSource: "unknown" as const },
    failure: { code: "unauthenticated" as const, message: "not signed in" },
  };
  const configured = applyClaudeConfiguredAuth(base, { ANTHROPIC_API_KEY: "never-persist-me" });
  assert.equal(configured.status, "ready");
  assert.equal(configured.auth.billingSource, "api");
  assert.equal(JSON.stringify(configured).includes("never-persist-me"), false);
});

test("configured cloud providers take precedence over a coincident direct API key", () => {
  const base = {
    status: "ready" as const, effortLevels: [], permissionModes: ["acceptEdits"], streamJsonInput: true,
    streamJsonImages: false, controlProtocol: false, forkSession: false, replayUserMessages: false,
    auth: { status: "authenticated" as const, billingSource: "subscription" as const },
  };
  const bedrock = applyClaudeConfiguredAuth(base, { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "key" });
  assert.equal(bedrock.auth.billingSource, "bedrock");
  const vertex = applyClaudeConfiguredAuth(base, { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_API_KEY: "key" });
  assert.equal(vertex.auth.billingSource, "vertex");
  const disabled = applyClaudeConfiguredAuth(base, { CLAUDE_CODE_USE_BEDROCK: "0", ANTHROPIC_API_KEY: "key" });
  assert.equal(disabled.auth.billingSource, "api");
});

test("probe verifies current control/image contract and reports unauthenticated readiness", async () => {
  const exec = async (args: string[]) => args[0] === "--version"
    ? ok("2.1.205 (Claude Code)")
    : args[0] === "--help"
      ? ok("--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"acceptEdits\", \"auto\")")
      : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
  const result = await probeClaudeCode(exec, "path");
  assert.equal(result.status, "unauthenticated");
  assert.equal(result.controlProtocol, true);
  assert.equal(result.streamJsonImages, true);
  assert.equal(result.auth.status, "unauthenticated");
});

test("probe does not advertise ready when help omits the driver's acceptEdits fallback", async () => {
  const exec = async (args: string[]) => args[0] === "--version"
    ? ok("2.1.205 (Claude Code)")
    : args[0] === "--help"
      ? ok("--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"auto\")")
      : ok(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  const result = await probeClaudeCode(exec, "path");
  assert.equal(result.status, "unsupported");
  assert.equal(result.failure?.code, "unsupported_mode");
});

test("unsupported or timed-out auth status remains bounded and unknown", async () => {
  const exec = async (args: string[]) => args[0] === "--version"
    ? ok("2.1.205 (Claude Code)")
    : args[0] === "--help"
      ? ok("--input-format stream-json\n--output-format stream-json\n--permission-mode (choices: \"acceptEdits\")")
      : { code: 1, stdout: "not json", stderr: "unknown command", timedOut: true };
  const result = await probeClaudeCode(exec, "path");
  assert.equal(result.status, "ready");
  assert.deepEqual(result.auth, { status: "unknown", billingSource: "unknown" });
  assert.equal(JSON.stringify(result).includes("unknown command"), false);
});

test("native Claude Git Bash discovery accepts only existing absolute Git-for-Windows candidates", async () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
  };
  assert.deepEqual(nativeClaudeGitBashCandidates(env, ["D:\\Portable Git\\cmd\\git.exe"]).slice(0, 4), [
    "D:\\Portable Git\\bin\\bash.exe",
    "D:\\Portable Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Users\\runner\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
  ]);
  const path = await resolveNativeClaudeGitBash({
    platform: "win32",
    env,
    exists: (candidate) => candidate === "D:\\Portable Git\\bin\\bash.exe",
    exec: async () => ({ code: 0, stdout: "D:\\Portable Git\\cmd\\git.exe\r\n", stderr: "" }),
  });
  assert.equal(path, "D:\\Portable Git\\bin\\bash.exe");
  assert.equal(verifiedNativeClaudeGitBashPath(
    { CLAUDE_CODE_GIT_BASH_PATH: "relative\\bash.exe" },
    { env, exists: () => true },
  ), undefined, "an invalid explicit override cannot fall back to another installation");
  assert.equal(await resolveNativeClaudeGitBash({ platform: "linux" }), undefined);
});

test("native Windows Claude readiness fails closed without Git-for-Windows Bash", () => {
  const capability = {
    status: "ready" as const,
    effortLevels: [], permissionModes: ["acceptEdits"], streamJsonInput: true, streamJsonImages: true,
    controlProtocol: true, forkSession: true, replayUserMessages: true,
    auth: { status: "unknown" as const, billingSource: "unknown" as const },
  };
  assert.equal(applyNativeClaudeGitBashReadiness(capability, undefined, "linux").status, "ready");
  const gated = applyNativeClaudeGitBashReadiness(capability, undefined, "win32");
  assert.equal(gated.status, "unsupported");
  assert.equal(gated.failure?.code, "unsupported_mode");
  assert.equal(applyNativeClaudeGitBashReadiness(capability, "C:\\Git\\bin\\bash.exe", "win32").status, "ready");
  const agent = {
    id: "claude", name: "Claude", command: "claude.cmd", args: [], env: {}, driver: "claude-code" as const,
    context: { kind: "native" as const }, available: true, claudeCode: capability,
  };
  const gatedAgent = applyClaudeAgentEnvironment(agent, true, { platform: "win32", exists: () => false });
  assert.equal(gatedAgent.available, false, "an explicit config availability override cannot bypass the prerequisite");
  assert.equal(gatedAgent.claudeCode?.status, "unsupported");
});
