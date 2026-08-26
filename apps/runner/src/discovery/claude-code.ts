import type {
  AgentCapabilities,
  AgentDefinition,
  ClaudeCodeAuth,
  ClaudeCodeCapabilities,
  ElicitationTransport,
} from "@wollipog/protocol";
import type { ExecResult, ResolvedBinary, ResolvedLaunch } from "./resolve.js";
import { run } from "./resolve.js";

type ProbeExec = (args: string[], timeoutMs?: number) => Promise<ExecResult>;

const SAFE_LABEL = /^[a-zA-Z0-9._ -]{1,40}$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];

function enabledFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function parseVersion(s: string): string | undefined {
  return s.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0];
}

function versionAtLeast(version: string, floor: string): boolean {
  const parts = (value: string) => value.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const a = parts(version);
  const b = parts(floor);
  return (a[0] ?? 0) > (b[0] ?? 0)
    || ((a[0] ?? 0) === (b[0] ?? 0) && (a[1] ?? 0) > (b[1] ?? 0))
    || ((a[0] ?? 0) === (b[0] ?? 0) && (a[1] ?? 0) === (b[1] ?? 0) && (a[2] ?? 0) >= (b[2] ?? 0));
}

function optionBlock(help: string, option: string): string {
  const lines = help.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(option));
  if (index < 0) return "";
  const out = [lines[index]!];
  for (let i = index + 1; i < Math.min(lines.length, index + 6); i += 1) {
    const line = lines[i]!;
    if (/^\s{2}--?\S/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Project only flags and enumerated values present in this installation's own help output. */
export function parseClaudeHelp(help: string): Pick<ClaudeCodeCapabilities,
  "effortLevels" | "permissionModes" | "streamJsonInput" | "forkSession" | "replayUserMessages" | "sessionNaming"
> {
  const effortBlock = optionBlock(help, "--effort");
  const permissionBlock = optionBlock(help, "--permission-mode");
  const inputBlock = optionBlock(help, "--input-format");
  const permissionModes = permissionBlock
    ? PERMISSION_MODES.filter((value) => new RegExp(`(?:[\"']${value}[\"']|\\b${value}\\b)`).test(permissionBlock))
    : [];
  const namingFlags = [
    "--output-format", "--tools", "--safe-mode", "--strict-mcp-config", "--mcp-config",
    "--setting-sources", "--no-session-persistence", "--disable-slash-commands", "--no-chrome",
    "--system-prompt",
  ];
  return {
    effortLevels: effortBlock ? EFFORTS.filter((value) => new RegExp(`\\b${value}\\b`).test(effortBlock)) : [],
    permissionModes,
    streamJsonInput: /--input-format/.test(inputBlock) && /stream-json/.test(inputBlock) && /--output-format/.test(help),
    forkSession: /--fork-session\b/.test(help),
    replayUserMessages: /--replay-user-messages\b/.test(help),
    sessionNaming: permissionModes.includes("plan") && namingFlags.every((flag) => help.includes(flag)),
  };
}

function safeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

/** Parse only the non-secret auth fields we persist; email and organization fields are discarded. */
export function parseClaudeAuthStatus(result: ExecResult): ClaudeCodeAuth {
  let raw: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // Older CLIs do not support `auth status`; keep readiness unknown instead of guessing from files.
  }
  if (!raw || typeof raw.loggedIn !== "boolean") {
    return { status: "unknown", billingSource: "unknown" };
  }
  if (!raw.loggedIn) return { status: "unauthenticated", billingSource: "unknown" };

  const rawMethod = safeEnum(raw.authMethod, ["claude.ai", "console"] as const);
  const rawProvider = safeEnum(raw.apiProvider, ["firstParty", "bedrock", "vertex"] as const);
  const subscriptionType = typeof raw.subscriptionType === "string" && SAFE_LABEL.test(raw.subscriptionType)
    ? raw.subscriptionType
    : undefined;
  const billingSource: ClaudeCodeAuth["billingSource"] = rawProvider === "bedrock"
    ? "bedrock"
    : rawProvider === "vertex"
      ? "vertex"
      : rawMethod === "console"
        ? "api"
        : rawMethod === "claude.ai" || subscriptionType
          ? "subscription"
          : "unknown";
  return {
    status: "authenticated",
    method: rawMethod ?? "unknown",
    provider: rawProvider ?? "unknown",
    billingSource,
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

/** Explicit per-agent auth environment wins over the CLI account's default billing path. */
export function applyClaudeConfiguredAuth(
  capability: ClaudeCodeCapabilities,
  env: Record<string, string>,
): ClaudeCodeCapabilities {
  let auth: ClaudeCodeAuth | undefined;
  // Claude's documented credential precedence puts cloud providers ahead of direct API/OAuth.
  if (enabledFlag(env.CLAUDE_CODE_USE_BEDROCK)) {
    auth = { status: "authenticated", provider: "bedrock", billingSource: "bedrock" };
  } else if (enabledFlag(env.CLAUDE_CODE_USE_VERTEX)) {
    auth = { status: "authenticated", provider: "vertex", billingSource: "vertex" };
  } else if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    auth = { status: "authenticated", method: "oauth_token", provider: "firstParty", billingSource: "subscription" };
  } else if (env.ANTHROPIC_API_KEY) {
    auth = { status: "authenticated", method: "api_key", provider: "firstParty", billingSource: "api" };
  } else if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) {
    auth = { status: "authenticated", method: "gateway", provider: "gateway", billingSource: "gateway" };
  }
  if (!auth) return capability;
  return {
    ...capability,
    auth,
    status: capability.status === "unauthenticated" ? "ready" : capability.status,
    failure: capability.failure?.code === "unauthenticated" ? undefined : capability.failure,
  };
}

export function claudeCapabilitiesFromProbe(
  base: AgentCapabilities,
  probe: ClaudeCodeCapabilities,
): AgentCapabilities {
  const fixedModes = probe.permissionModes.filter((mode) => mode !== "auto");
  const permissionModes = probe.controlProtocol
    ? ["default", ...(probe.permissionModes.includes("auto") ? ["auto"] : []), ...fixedModes]
    : fixedModes;
  const elicitation = Object.fromEntries(permissionModes.map((mode) => [
    mode,
    [probe.controlProtocol && (mode === "default" || mode === "auto")
      ? "stdio-control"
      : "none"] satisfies ElicitationTransport[],
  ]));
  return {
    ...base,
    effortLevels: probe.effortLevels,
    permissionModes,
    supportsImages: probe.streamJsonImages,
    supportsApprovals: probe.controlProtocol,
    supportsConversationFork: probe.status === "ready" && probe.forkSession,
    ...(permissionModes.length ? { elicitation } : { elicitation: undefined }),
  };
}

export async function probeClaudeCode(
  exec: ProbeExec,
  launchSource: ResolvedBinary["via"],
): Promise<ClaudeCodeCapabilities> {
  const [versionResult, helpResult, authResult] = await Promise.all([
    exec(["--version"], 5_000),
    exec(["--help"], 5_000),
    exec(["auth", "status"], 5_000),
  ]);
  const emptyAuth: ClaudeCodeAuth = { status: "unknown", billingSource: "unknown" };
  if (versionResult.timedOut || helpResult.timedOut) {
    return {
      status: "unsupported", launchSource, effortLevels: [], permissionModes: [], streamJsonInput: false,
      streamJsonImages: false, controlProtocol: false, forkSession: false, replayUserMessages: false,
      auth: emptyAuth, failure: { code: "probe_timeout", message: "Claude Code capability discovery timed out.", retryable: true },
    };
  }
  const installedVersion = versionResult.code === 0 ? parseVersion(versionResult.stdout || versionResult.stderr) : undefined;
  if (!installedVersion) {
    return {
      status: "unsupported", launchSource, effortLevels: [], permissionModes: [], streamJsonInput: false,
      streamJsonImages: false, controlProtocol: false, forkSession: false, replayUserMessages: false,
      auth: emptyAuth, failure: { code: "version_unverified", message: "Claude Code did not report a verifiable version.", retryable: true },
    };
  }
  if (helpResult.code !== 0) {
    return {
      status: "unsupported", installedVersion, launchSource, effortLevels: [], permissionModes: [], streamJsonInput: false,
      streamJsonImages: false, controlProtocol: false, forkSession: false, replayUserMessages: false,
      auth: emptyAuth, failure: { code: "probe_failed", message: "Claude Code did not return capability help.", retryable: true },
    };
  }
  const parsed = parseClaudeHelp(helpResult.stdout || helpResult.stderr);
  const auth = parseClaudeAuthStatus(authResult);
  // The stream-json stdio control and image-block contract is regression-verified against 2.1.205.
  // Help does not advertise --permission-prompt-tool, so fail closed on other versions until a
  // release is explicitly verified instead of treating undocumented behavior as universal.
  const verifiedControlContract = versionAtLeast(installedVersion, "2.1.205") && parsed.streamJsonInput;
  // A normal session with no explicit permission setting defaults to acceptEdits in the driver.
  // Do not advertise launch readiness unless that implicit first turn is known to be valid.
  const coreSupported = parsed.streamJsonInput && parsed.permissionModes.includes("acceptEdits");
  const status = !coreSupported ? "unsupported" : auth.status === "unauthenticated" ? "unauthenticated" : "ready";
  return {
    status,
    installedVersion,
    verification: "version-help-auth-status",
    launchSource,
    ...parsed,
    streamJsonImages: verifiedControlContract,
    controlProtocol: verifiedControlContract,
    auth,
    ...(status === "unsupported"
      ? { failure: { code: "unsupported_mode" as const, message: "Claude Code lacks the required stream-json or acceptEdits mode." } }
      : status === "unauthenticated"
        ? { failure: { code: "unauthenticated" as const, message: "Claude Code is not signed in. Run `claude auth login`." } }
        : {}),
  };
}

export async function probeNativeClaudeCode(
  launch: ResolvedLaunch,
  via: ResolvedBinary["via"],
): Promise<ClaudeCodeCapabilities> {
  return probeClaudeCode(
    (args, timeoutMs) => run(launch.command, [...launch.args, ...args], { timeoutMs }),
    via,
  );
}

export async function probeWslClaudeCode(
  distro: string,
  launch: ResolvedLaunch,
  via: ResolvedBinary["via"],
): Promise<ClaudeCodeCapabilities> {
  return probeClaudeCode(
    (args, timeoutMs) => run("wsl.exe", ["-d", distro, "--exec", launch.command, ...launch.args, ...args], { timeoutMs }),
    via,
  );
}

export function unavailableClaudeCode(): ClaudeCodeCapabilities {
  return {
    status: "unavailable",
    effortLevels: [], permissionModes: [], streamJsonInput: false, streamJsonImages: false,
    controlProtocol: false, forkSession: false, replayUserMessages: false,
    auth: { status: "unknown", billingSource: "unknown" },
    failure: { code: "claude_unavailable", message: "Claude Code was not found in this runner context." },
  };
}

export function applyClaudeAgentEnvironment(agent: AgentDefinition, preserveAvailability = false): AgentDefinition {
  if (agent.driver !== "claude-code" || !agent.claudeCode) return agent;
  const claudeCode = applyClaudeConfiguredAuth(agent.claudeCode, agent.env ?? {});
  return {
    ...agent,
    claudeCode,
    authStatus: claudeCode.auth.status,
    available: preserveAvailability ? agent.available : claudeCode.status === "ready",
  };
}
