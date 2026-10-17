import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { PACED_VIDEO_REVIEW_WINDOW_LIMITS, type ClaudeMediaReviewerAttestation } from "@wollipog/protocol";
import { MEDIA_REVIEWER_TOOLS } from "./evidence-review-namespace.js";
import { MEDIA_MCP_SERVER_NAME } from "./media-review-relay.js";

const run = promisify(execFile);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Pinned like the controlled native code reviewer: flags, startup init shape and usage fields
 * were verified on exactly this release. Any other version refuses until it is re-audited. */
export const CLAUDE_MEDIA_REVIEWER_CLI_VERSION = "2.1.296";
export const CLAUDE_MEDIA_REVIEWER_PROFILE = "claude-code-media-only-v1" as const;
/** Provider-visible names of the two scoped media handlers, and nothing else. */
export const CLAUDE_MEDIA_REVIEWER_TOOLS: readonly string[] = MEDIA_REVIEWER_TOOLS.map((tool) => `mcp__${MEDIA_MCP_SERVER_NAME}__${tool}`);
const REQUIRED_FLAGS = ["--bare", "--tools", "--strict-mcp-config", "--mcp-config", "--disable-slash-commands",
  "--no-session-persistence", "--permission-mode", "--allowedTools", "--output-format", "--input-format",
  "--model", "--effort", "--max-budget-usd"];

/** Reviewer-only settings, mounted through the namespace and bound into its policy digest.
 * Claude Code estimates 1600 tokens per tool-result image and, past half of this cap, counts
 * tokens and DOWNSCALES images that exceed it. A 20-frame batch estimates about 36k tokens, so
 * 100k keeps every batch on the no-inspection path and every delivered frame at native pixels. */
export const CLAUDE_MEDIA_REVIEWER_ENV: Readonly<Record<string, string>> = Object.freeze({
  MAX_MCP_OUTPUT_TOKENS: "100000",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});

/** Runner-local key provisioned by the operator for this reviewer only. It is never the operator's
 * own Claude login: copying an OAuth credential into a reviewer HOME would hand it a refresh token
 * whose rotation can invalidate the operator's own sessions. */
export function mediaReviewerCredentialPath(dataDir: string, agentId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(agentId)) throw new Error("Agent identity is not a safe path segment.");
  return join(dataDir, "media-reviewer", agentId, "anthropic-api-key");
}
/** Reads and validates the dedicated key. The value stays in runner memory; it is passed to bwrap
 * only through a private argument pipe, never argv, a file inside the namespace or a digest. */
export function readMediaReviewerCredential(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 512) {
    throw new Error("Dedicated media reviewer key must be a private runner-owned file.");
  }
  const key = readFileSync(path, "utf8").trim();
  if (!/^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{16,256}$/u.test(key)) throw new Error("Dedicated media reviewer key is malformed.");
  return key;
}

export interface ClaudeMediaReviewerInstallation { claude: string; executableSha256: string; cliVersion: string }
/** Resolves the agent's own executable and proves the pinned version and flag surface offline.
 * No account is read and no model request is made. */
export async function inspectClaudeMediaReviewer(command: string, pathEnv = process.env.PATH ?? ""): Promise<ClaudeMediaReviewerInstallation> {
  let claude: string | undefined;
  if (isAbsolute(command)) claude = realpathSync(command);
  else if (/^[A-Za-z0-9._-]+$/u.test(command)) {
    for (const dir of pathEnv.split(":")) {
      if (!dir.startsWith("/")) continue;
      const candidate = join(dir, command);
      if (existsSync(candidate) && statSync(candidate).isFile() && (statSync(candidate).mode & 0o111)) { claude = realpathSync(candidate); break; }
    }
  }
  if (!claude) throw new Error("claude executable is unavailable");
  const version = (await run(claude, ["--version"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" } })).stdout.trim().split(" ")[0];
  if (version !== CLAUDE_MEDIA_REVIEWER_CLI_VERSION) throw new Error("media reviewer is unsupported for this Claude Code version");
  const help = (await run(claude, ["--help"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 4_000_000 })).stdout;
  for (const flag of REQUIRED_FLAGS) if (!help.includes(flag)) throw new Error(`media reviewer CLI lacks ${flag}`);
  return { claude, executableSha256: sha(readFileSync(claude)), cliVersion: version };
}

export function claudeMediaReviewerAttestation(agentId: string, install: ClaudeMediaReviewerInstallation,
  namespacePolicySha256: string): ClaudeMediaReviewerAttestation {
  return { profile: CLAUDE_MEDIA_REVIEWER_PROFILE, harness: "claude-code", agentId, cliVersion: install.cliVersion,
    executableSha256: install.executableSha256, namespacePolicySha256,
    tools: [...MEDIA_REVIEWER_TOOLS] as ClaudeMediaReviewerAttestation["tools"],
    credential: "dedicated_api_key", windowLimitsRevision: PACED_VIDEO_REVIEW_WINDOW_LIMITS.revision };
}
export const mediaReviewerAttestationSha256 = (attestation: ClaudeMediaReviewerAttestation) => sha(JSON.stringify({
  profile: attestation.profile, harness: attestation.harness, agentId: attestation.agentId, cliVersion: attestation.cliVersion,
  executableSha256: attestation.executableSha256, namespacePolicySha256: attestation.namespacePolicySha256,
  tools: attestation.tools, credential: attestation.credential, windowLimitsRevision: attestation.windowLimitsRevision,
}));

/** One fresh conversation per window. `--tools ""` removes every built-in tool, `--bare` skips
 * hooks, plugin sync, CLAUDE.md, auto-memory and keychain/OAuth reads (auth is strictly the
 * dedicated key), and `--strict-mcp-config` loads only the relay. User turns arrive as stream-json
 * on stdin, so a malformed-notes correction stays in the conversation that saw the frames. */
export function claudeMediaReviewerArgs(input: { providerCommand: string; mcpConfig: string; model: string;
  effort?: string; maxBudgetUsd?: number }): string[] {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(input.model) || input.effort !== undefined && !/^[a-z]{1,16}$/u.test(input.effort) ||
    input.maxBudgetUsd !== undefined && !(finite(input.maxBudgetUsd) && input.maxBudgetUsd > 0)) {
    throw new Error("Media reviewer model, effort and budget must be exact bounded values.");
  }
  return [input.providerCommand, "--bare", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--tools", "", "--strict-mcp-config", "--mcp-config", input.mcpConfig, "--disable-slash-commands",
    "--no-session-persistence", "--permission-mode", "dontAsk", "--allowedTools", ...CLAUDE_MEDIA_REVIEWER_TOOLS,
    "--model", input.model, ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.maxBudgetUsd !== undefined ? ["--max-budget-usd", input.maxBudgetUsd.toFixed(6)] : [])];
}

/** Startup proof from the provider's own init event. A policy prompt or flag list alone is not
 * proof: the provider must report exactly the two media tools, only the connected relay server,
 * no skills or slash commands, the pinned version, and the dedicated key as its auth source. */
export function claudeMediaReviewerInitRefusal(event: unknown, expected: { model: string }): string | null {
  const e = event as Record<string, unknown> | null;
  if (!e || e.type !== "system" || e.subtype !== "init") return "first provider event is not its startup init";
  const tools = e.tools;
  if (!Array.isArray(tools) || tools.length !== CLAUDE_MEDIA_REVIEWER_TOOLS.length ||
    new Set(tools).size !== tools.length || !CLAUDE_MEDIA_REVIEWER_TOOLS.every((tool) => tools.includes(tool))) {
    return "startup tool list is not exactly the scoped media tools";
  }
  const servers = e.mcp_servers as Array<{ name?: unknown; status?: unknown }> | undefined;
  if (!Array.isArray(servers) || servers.length !== 1 || servers[0]?.name !== MEDIA_MCP_SERVER_NAME || servers[0]?.status !== "connected") {
    return "startup MCP servers are not exactly the connected media relay";
  }
  if (e.claude_code_version !== CLAUDE_MEDIA_REVIEWER_CLI_VERSION) return "startup reports an unpinned Claude Code version";
  if (e.model !== expected.model) return "startup model differs from the admitted reviewer model";
  if (e.permissionMode !== "dontAsk") return "startup permission mode is not dontAsk";
  if (e.apiKeySource !== "ANTHROPIC_API_KEY") return "startup did not authenticate with the dedicated reviewer key";
  if (!Array.isArray(e.slash_commands) || e.slash_commands.length) return "startup exposes slash commands";
  if (e.skills !== undefined && (!Array.isArray(e.skills) || e.skills.length)) return "startup exposes skills";
  const plugins = e.plugins;
  if (plugins !== undefined && (!Array.isArray(plugins) ||
    plugins.some((plugin) => (plugin as { path?: unknown })?.path !== "builtin"))) return "startup loaded a non-builtin plugin";
  if (typeof e.session_id !== "string" || !e.session_id) return "startup has no provider session identity";
  return null;
}

export interface ClaudeMediaReviewerWindowResult {
  initialized: boolean;
  refusal?: string;
  toolCalls: number;
  /** Provider-reported final cumulative cost for this process; absent until a priced result. */
  costUsd?: number;
  priced: boolean;
  /** Final assistant text of the latest completed turn, where structured notes are expected. */
  finalText?: string;
  /** Completed turns (one `result` event each). */
  turns: number;
}
/** Incremental parser over bytes read directly from the owned provider pipe. */
export class ClaudeMediaReviewerStream {
  private buffer = "";
  private sessionId: string | undefined;
  private readonly toolIds = new Set<string>();
  readonly result: ClaudeMediaReviewerWindowResult = { initialized: false, toolCalls: 0, priced: false, turns: 0 };
  constructor(private readonly expected: { model: string }) {}
  /** Returns a refusal reason as soon as the stream proves a policy violation. */
  push(chunk: string): string | null {
    if (this.result.refusal) return this.result.refusal;
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024 * 1024) return this.refuse("provider output exceeds bounded accounting capacity");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return this.refuse("provider emitted an unparseable stream event"); }
      const refusal = this.event(event);
      if (refusal) return this.refuse(refusal);
    }
    return null;
  }
  private refuse(reason: string): string { this.result.refusal = reason; return reason; }
  private event(event: Record<string, unknown>): string | null {
    if (!this.result.initialized) {
      const refusal = claudeMediaReviewerInitRefusal(event, this.expected);
      if (refusal) return refusal;
      this.result.initialized = true; this.sessionId = event.session_id as string;
      return null;
    }
    // Every user turn re-announces the session. Each announcement must be the same proven surface.
    if (event.type === "system" && event.subtype === "init") {
      return claudeMediaReviewerInitRefusal(event, this.expected) ??
        (event.session_id === this.sessionId ? null : "provider restarted its session mid-window");
    }
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) for (const item of content as Array<Record<string, unknown>>) {
      if (item?.type !== "tool_use" && item?.type !== "server_tool_use") continue;
      if (item.type !== "tool_use" || !CLAUDE_MEDIA_REVIEWER_TOOLS.includes(item.name as string) || typeof item.id !== "string") {
        return "provider invoked a tool outside the scoped media set";
      }
      this.toolIds.add(item.id); this.result.toolCalls = this.toolIds.size;
    }
    if (event.type === "result") {
      if (event.session_id !== this.sessionId || !finite(event.total_cost_usd)) return "provider final usage identity is missing";
      const entries = Object.entries((event.modelUsage ?? {}) as Record<string, Record<string, unknown>>);
      const priced = entries.length === 1 && entries[0]![0] === this.expected.model && finite(entries[0]![1].costUSD) &&
        [entries[0]![1].inputTokens, entries[0]![1].outputTokens, entries[0]![1].cacheReadInputTokens,
          entries[0]![1].cacheCreationInputTokens].every((v) => Number.isSafeInteger(v) && (v as number) >= 0) &&
        Math.abs((entries[0]![1].costUSD as number) - (event.total_cost_usd as number)) <= 1e-8;
      // Cumulative totals never refund; an unpriced final result keeps the window unpriced.
      if (this.result.costUsd !== undefined && (event.total_cost_usd as number) < this.result.costUsd) return "provider cost regressed";
      this.result.costUsd = event.total_cost_usd as number;
      this.result.priced = priced && event.is_error !== true;
      this.result.finalText = typeof event.result === "string" ? event.result.slice(0, 64 * 1024) : undefined;
      this.result.turns++;
    }
    return null;
  }
}
