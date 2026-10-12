/** Provider-neutral Wollipog CLI plus the general stdio MCP entrypoint. */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
} from "@wollipog/protocol";
import {
  executeManagerTool,
  serveSessionManagementMcp,
  type McpDeps,
  type McpFetch,
  type ToolResult,
} from "./session-management-mcp.js";
import { VERSION } from "./version.js";
import { contextGhRunner, type GhRunner } from "./campaign-forge-status.js";
import { PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS, PULL_REQUEST_WAIT_MAX_TIMEOUT_MS } from "./pull-request-wait.js";
import { defaultHostAdminIo, hostAdminUsage, runHostAdminCli, type HostAdminIo } from "./host-admin-cli.js";
import { defaultServiceHost, defaultServiceIo, runServiceCli, serviceUsage } from "./service-cli.js";
import {
  artifactHelp, decisionHelp, expandCommandAlias, initHelp, pairHelp, pullRequestHelp, resolveHelp, rootHelp, sessionHelp, worktreeHelp,
} from "./wollipog-help.js";
import { resolveWorktreeSetupRepositoryRoot, writeStarterWorktreeSetupConfig } from "./worktree-setup-generator.js";
import { RUNNER_APP_ARGUMENT_INDEX } from "./runner-entry.js";
import {
  AGENT_CONTROL_RELAY_ENDPOINT_ENV,
  AGENT_CONTROL_RELAY_KEY_ENV,
  agentControlRelayFetch,
} from "./agent-control-relay.js";

type Write = (text: string) => void;

function readToken(env: NodeJS.ProcessEnv, tokenFile?: string): string {
  const file = tokenFile ?? env.WOLLIPOG_SESSION_TOKEN_FILE ?? env.WOLLIPOG_TOKEN_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return env.WOLLIPOG_TOKEN ?? "";
}

function credentialReady(env: NodeJS.ProcessEnv, token: string): boolean {
  const file = env.WOLLIPOG_SESSION_CREDENTIAL_READY_FILE;
  if (!env.WOLLIPOG_SESSION_ID || !file) return true;
  const expected = createHash("sha256").update(token).digest("hex");
  try {
    return readFileSync(file, "utf8").trim() === expected;
  } catch {
    // Missing, unreadable, or superseded fences must never authorize a request.
    return false;
  }
}

async function waitForCredentialReady(env: NodeJS.ProcessEnv, token: string): Promise<string | null> {
  const deadline = Date.now() + 10_000;
  do {
    if (credentialReady(env, token)) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return "session credential was not acknowledged by the control plane within 10 seconds";
}

function option(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i]?.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function optionPresent(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function positional(args: string[], extraValueOptions: readonly string[] = []): string[] {
  const values: string[] = [];
  const valueOptions = new Set([
    "--url", "--token-file", "--runner", "--agent", "--workspace", "--path", "--prompt",
    "--title", "--model", "--effort", "--permission-mode", "--after", "--limit", "--for", "--timeout",
    "--interval", "--cost-budget", "--max-tool-calls", "--session", "--branch", "--base", "--base-ref",
    "--max-child-sessions", "--offset", "--event-epoch",
    "--revision",
    ...extraValueOptions,
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (valueOptions.has(arg)) { i++; continue; }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usage(): string {
  return rootHelp();
}

function jsonObjectOption(
  args: string[],
  name: string,
): { value: Record<string, unknown> } | { error: string } {
  const raw = option(args, name);
  if (!optionPresent(args, name) || raw === undefined || !raw.trim() || raw.startsWith("--")) {
    return { error: `${name} requires a JSON object` };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { value: value as Record<string, unknown> }
      : { error: `${name} must be a JSON object` };
  } catch {
    return { error: `${name} must be valid JSON` };
  }
}

export async function runWollipogInit(
  directory: string,
  json: boolean,
  io: { stdout: Write; stderr: Write },
): Promise<number> {
  try {
    const repository = await resolveWorktreeSetupRepositoryRoot({ kind: "native" }, directory);
    const generated = await writeStarterWorktreeSetupConfig({ kind: "native" }, repository);
    const result = {
      status: "created",
      path: generated.path,
      detected: generated.detected,
      executed: false,
      staged: false,
      committed: false,
    };
    io.stdout(json
      ? `${JSON.stringify(result)}\n`
      : `Created ${generated.path} for review. No tools were run, and nothing was staged or committed.\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    if (message.startsWith("not a Git repository:")) return 3;
    if (message.includes("already exists") || message.includes("regular file")) return 4;
    return 1;
  }
}

const PULL_REQUEST_WAIT_SUCCESS = new Set(["checks_passed", "merged", "no_required_checks"]);

/**
 * `wollipog pr wait`: local and read-only. It uses this machine's `gh` login, needs neither a
 * session credential nor the control plane, and runs the same `wait_pull_request` handler the MCP
 * server exposes. A bare number resolves against the current directory's GitHub repository.
 */
export async function runPullRequestCli(
  args: string[],
  json: boolean,
  io: { stdout: Write; stderr: Write },
  gh: GhRunner = contextGhRunner({ kind: "native" }, process.cwd()),
  signal?: AbortSignal,
): Promise<number> {
  const fail = (message: string, code: number): number => {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    return code;
  };
  const words = positional(args, ["--repo", "--head"]);
  if (words[1] !== "wait" || words.length !== 3) return fail(pullRequestHelp(), 2);
  const timeoutMs = numeric(option(args, "--timeout"));
  const intervalMs = numeric(option(args, "--interval"));
  if ((optionPresent(args, "--timeout") && timeoutMs === undefined) || (optionPresent(args, "--interval") && intervalMs === undefined)) {
    return fail("--timeout and --interval take milliseconds", 2);
  }
  let repository = option(args, "--repo");
  let remainingMs = timeoutMs;
  if (!repository && /^#?\d+$/u.test(words[2]!)) {
    // Discovery comes out of the same budget as the wait, so the command still ends in time.
    const budgetMs = Math.min(PULL_REQUEST_WAIT_MAX_TIMEOUT_MS, Math.max(1, timeoutMs ?? PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS));
    const startedAt = Date.now();
    const discovery = AbortSignal.timeout(budgetMs);
    const resolved = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      signal ? AbortSignal.any([discovery, signal]) : discovery);
    repository = resolved.code === null ? resolved.stdout.trim() : "";
    if (!repository) return fail("could not resolve this directory's GitHub repository; pass --repo <owner/name>", 1);
    remainingMs = budgetMs - (Date.now() - startedAt);
    if (remainingMs < 1) return fail("resolving the repository used the whole timeout; pass --repo <owner/name>", 1);
  }
  const result = await executeManagerTool("wait_pull_request", {
    pullRequest: words[2],
    ...(repository ? { repository } : {}),
    ...(option(args, "--head") !== undefined ? { headSha: option(args, "--head") } : {}),
    ...(remainingMs !== undefined ? { timeoutMs: remainingMs } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(flag(args, "--any-failure") ? { returnOnAnyFailure: true } : {}),
  }, { fetch: () => Promise.reject(new Error("no control plane")), cpUrl: "", selfSessionId: "", token: "", gh, ...(signal ? { signal } : {}) });
  const data = payload(result);
  io.stdout(json ? `${JSON.stringify(data)}\n` : `${JSON.stringify(data, null, 2)}\n`);
  if (result.isError) return 1;
  const outcome = (data as { outcome?: unknown }).outcome;
  if (outcome === "timeout") return 124;
  return PULL_REQUEST_WAIT_SUCCESS.has(String(outcome)) ? 0 : 3;
}

function invocationArgs(argv: string[]): string[] {
  // The dispatcher recognizes an internal marker only in the first application-argument
  // position. Mirror that boundary here: a marker later in user data must never cause this
  // parser to discard the real command that preceded it. Node and SEA both start at index 2.
  const appIndex = RUNNER_APP_ARGUMENT_INDEX;
  return argv.slice(argv[appIndex] === "--wollipog-cli" ? appIndex + 1 : appIndex);
}

function command(args: string[]): { tool: string; input: Record<string, unknown> } | { error: string } {
  const words = positional(args);
  if (words[0] === "issue-scope") {
    if (optionPresent(args, "--session")) return { error: "issue-scope commands act only on the injected session" };
    if (words[1] === "get") {
      const epic = option(args, "--epic");
      if (epic && (!/^[1-9][0-9]*$/u.test(epic) || !Number.isSafeInteger(Number(epic)))) return { error: "epic must be a positive issue number" };
      return { tool: "get_campaign_issue_scope", input: epic ? { epic: Number(epic) } : {} };
    }
    if (words[1] === "request") {
      const proposal = jsonObjectOption(args, "--proposal");
      return "error" in proposal ? proposal : { tool: "request_campaign_issue_scope_change", input: proposal.value };
    }
    return { error: "use issue-scope get [--epic <number>] or issue-scope request --proposal <json>" };
  }
  if (words[0] === "issue-closure") {
    if (optionPresent(args, "--session")) return { error: "issue-closure commands act only on the injected session" };
    const groupIndex = args.indexOf("issue-closure");
    const verb = args[groupIndex + 1];
    if (verb === "request") {
      const proposal = jsonObjectOption(args, "--proposal");
      return "error" in proposal ? proposal : { tool: "request_github_issue_closure", input: proposal.value };
    }
    const occurrenceId = args[groupIndex + 2];
    const resourceDigest = option(args, "--digest");
    if (verb === "execute" && occurrenceId && !occurrenceId.startsWith("--") && resourceDigest) {
      return { tool: "close_github_issue", input: { occurrenceId, resourceDigest } };
    }
    return { error: "use issue-closure request --proposal <json> or issue-closure execute <occurrence-id> --digest <digest>" };
  }
  if (words[0] === "campaign") {
    if (optionPresent(args, "--session")) {
      return { error: "campaign commands act only on the injected Orchestrator session and do not accept --session" };
    }
    const groupIndex = args.indexOf("campaign");
    const verb = args[groupIndex + 1];
    const operand = (offset: number) => {
      const value = args[groupIndex + offset];
      return value && !value.startsWith("--") ? value : undefined;
    };
    const input = () => jsonObjectOption(args, "--input");
    if (verb === "plan") {
      const body = input();
      return "error" in body ? body : { tool: "record_campaign_plan", input: body.value };
    }
    if (verb === "update-item" && operand(2)) {
      const body = input();
      return "error" in body ? body : { tool: "update_campaign_work_item", input: { ...body.value, workItemId: operand(2) } };
    }
    if (verb === "assign" && operand(2) && operand(3)) {
      return { tool: "assign_campaign_work_item", input: { workItemId: operand(2), childSessionId: operand(3) } };
    }
    if (verb === "adjudicate" && operand(2)) {
      const body = input();
      return "error" in body ? body : {
        tool: "adjudicate_campaign_recommendation",
        input: { ...body.value, recommendationId: operand(2) },
      };
    }
    if (verb === "work-items") {
      const query: Record<string, unknown> = {};
      for (const [name, key] of [["--item", "workItemId"], ["--cursor", "cursor"], ["--origin", "origin"],
        ["--state", "state"], ["--sort", "sort"]] as const) {
        const value = option(args, name);
        if (optionPresent(args, name) && (value === undefined || value.startsWith("--"))) return { error: `${name} requires a value` };
        if (value !== undefined) query[key] = value;
      }
      if (optionPresent(args, "--limit")) {
        const limit = numeric(option(args, "--limit"));
        if (limit === undefined) return { error: "--limit requires a number" };
        query.limit = limit;
      }
      if (flag(args, "--recommendations")) query.includeRecommendations = true;
      return { tool: "get_campaign_work_items", input: query };
    }
    return { error: "use campaign plan, update-item, assign, adjudicate, or work-items; see wollipog help campaign" };
  }
  // Like artifact, this group reads only its fixed leading words. Keeping its JSON value options
  // out of the shared positional-option set ensures an unrelated command cannot become valid just
  // because it happens to include --snapshot or --action.
  if (["decision", "decisions", "workflow-decision", "workflow-decisions"].includes(words[0] ?? "")) {
    const groupIndex = args.findIndex((arg) =>
      ["decision", "decisions", "workflow-decision", "workflow-decisions"].includes(arg));
    const verb = args[groupIndex + 1];
    const occurrenceId = args[groupIndex + 2];
    if (optionPresent(args, "--session") && verb !== "get" && verb !== "list") {
      return { error: "decision commands act only on the injected session and do not accept --session" };
    }
    if (verb === "request") {
      const requestId = option(args, "--request-id");
      const resourceKey = option(args, "--resource-key");
      if (!requestId || requestId.startsWith("--")) return { error: "decision request requires --request-id" };
      if (!resourceKey || resourceKey.startsWith("--")) return { error: "decision request requires --resource-key" };
      const snapshot = jsonObjectOption(args, "--snapshot");
      if ("error" in snapshot) return snapshot;
      return {
        tool: "request_workflow_decision",
        input: { requestId, resourceKey, resourceSnapshot: snapshot.value },
      };
    }
    if (verb === "get") {
      const sessionId = option(args, "--session");
      if (optionPresent(args, "--session") && (!sessionId || sessionId.startsWith("--"))) {
        return { error: "--session requires a session id" };
      }
      return occurrenceId && !occurrenceId.startsWith("--")
        ? { tool: "get_workflow_decision", input: { occurrenceId, ...(sessionId ? { sessionId } : {}) } }
        : { error: "decision get requires an occurrence id" };
    }
    if (verb === "list") {
      if (positional(args.slice(groupIndex), ["--cursor"]).length !== 2) {
        return { error: "decision list does not accept an occurrence id; use decision get <occurrence-id>" };
      }
      const input: Record<string, unknown> = {};
      for (const [optionName, key] of [["--session", "sessionId"], ["--cursor", "cursor"]] as const) {
        if (!optionPresent(args, optionName)) continue;
        const value = option(args, optionName);
        if (!value || value.startsWith("--")) return { error: `${optionName} requires a value` };
        input[key] = value;
      }
      if (optionPresent(args, "--limit")) {
        const limit = numeric(option(args, "--limit"));
        if (!Number.isInteger(limit) || limit! < 1 || limit! > 100) return { error: "--limit requires an integer from 1 to 100" };
        input.limit = limit;
      }
      return { tool: "list_workflow_decisions", input };
    }
    if (verb === "consume") {
      if (!occurrenceId || occurrenceId.startsWith("--")) {
        return { error: "decision consume requires an occurrence id" };
      }
      const snapshot = jsonObjectOption(args, "--snapshot");
      if ("error" in snapshot) return snapshot;
      let action: Record<string, unknown> | undefined;
      if (optionPresent(args, "--action")) {
        const parsedAction = jsonObjectOption(args, "--action");
        if ("error" in parsedAction) return parsedAction;
        action = parsedAction.value;
      }
      return {
        tool: "consume_workflow_decision",
        input: { occurrenceId, resourceSnapshot: snapshot.value, ...(action ? { action } : {}) },
      };
    }
    if (verb === "reconcile") {
      if (!occurrenceId || occurrenceId.startsWith("--")) {
        return { error: "decision reconcile requires an occurrence id" };
      }
      if (optionPresent(args, "--action")) {
        return { error: "decision reconcile does not accept --action" };
      }
      const snapshot = jsonObjectOption(args, "--snapshot");
      if ("error" in snapshot) return snapshot;
      return {
        tool: "reconcile_workflow_decision",
        input: { occurrenceId, resourceSnapshot: snapshot.value },
      };
    }
    return { error: decisionHelp() };
  }
  // Only the group and verb are read positionally, so --file and --name are deliberately not added
  // to the shared value-option set: doing so would change how every other command counts its words.
  if (words[0] === "artifact" || words[0] === "artifacts") {
    if (words[1] !== "attach") return { error: artifactHelp() };
    const file = option(args, "--file");
    if (!file) return { error: "artifact attach requires --file" };
    const sessionId = option(args, "--session");
    const name = option(args, "--name");
    return {
      tool: "attach_session_artifact",
      input: {
        // The tool requires an absolute path because the MCP server's working directory is not the
        // agent's. Here the working directory IS the caller's, so a relative path means what it says.
        path: resolvePath(file),
        ...(name ? { name } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    };
  }
  if (words[0] === "worktree" || words[0] === "worktrees") {
    const verb = words[1];
    const sessionId = option(args, "--session");
    if (verb === "create") {
      const branch = option(args, "--branch");
      if (!branch) return { error: "worktree create requires --branch" };
      return {
        tool: "create_worktree",
        input: {
          ...(sessionId ? { sessionId } : {}),
          branch,
          ...((option(args, "--base") ?? option(args, "--base-ref"))
            ? { baseRef: option(args, "--base") ?? option(args, "--base-ref") }
            : {}),
        },
      };
    }
    if (verb === "attach" || verb === "select" || verb === "discard") {
      const path = option(args, "--path");
      if (!path) return { error: `worktree ${verb} requires --path` };
      return {
        tool: verb === "attach"
          ? "attach_worktree"
          : verb === "select" ? "select_worktree" : "discard_worktree",
        input: { ...(sessionId ? { sessionId } : {}), path },
      };
    }
    return { error: worktreeHelp() };
  }
  if (words[0] !== "session" && words[0] !== "sessions") return { error: usage() };
  const verb = words[1];
  switch (verb) {
    case "list":
      return { tool: "list_sessions", input: { archived: flag(args, "--archived") } };
    case "get":
      return words[2] ? { tool: "get_session", input: { sessionId: words[2] } } : { error: "session get requires an id" };
    case "events": {
      if (!words[2]) return { error: "session events requires an id" };
      // The epoch fences a cursor against a replaced history; dropping a malformed one would silently
      // turn a pinned read into an unpinned one.
      const eventEpoch = option(args, "--event-epoch");
      if (optionPresent(args, "--event-epoch") &&
          (eventEpoch === undefined || !/^\d+$/.test(eventEpoch) || !Number.isSafeInteger(Number(eventEpoch)))) {
        return { error: "session events --event-epoch requires a non-negative integer" };
      }
      return {
        tool: "get_session_events",
        input: {
          sessionId: words[2],
          after: numeric(option(args, "--after")),
          limit: numeric(option(args, "--limit")),
          eventEpoch: numeric(eventEpoch),
        },
      };
    }
    case "capabilities": {
      const runnerId = option(args, "--runner");
      const agentId = option(args, "--agent");
      if (!runnerId || !agentId) return { error: "session capabilities requires --runner and --agent" };
      const offset = option(args, "--offset");
      const limit = option(args, "--limit");
      for (const [name, value] of [["--offset", offset], ["--limit", limit]] as const) {
        if (optionPresent(args, name) &&
            (value === undefined || !value.trim() || value.startsWith("--") || !Number.isFinite(Number(value)))) {
          return { error: `session capabilities ${name} requires a number` };
        }
      }
      const modelId = option(args, "--model");
      if (optionPresent(args, "--model") &&
          (modelId === undefined || !modelId.trim() || modelId.startsWith("--"))) {
        return { error: "session capabilities --model requires a non-empty value" };
      }
      if (modelId !== undefined &&
          (optionPresent(args, "--offset") || optionPresent(args, "--limit") || flag(args, "--include-hidden"))) {
        return { error: "session capabilities --model cannot be combined with --offset, --limit, or --include-hidden" };
      }
      return {
        tool: "get_agent_capabilities",
        input: {
          runnerId,
          agentId,
          offset: numeric(offset),
          limit: numeric(limit),
          includeHidden: flag(args, "--include-hidden"),
          modelId,
        },
      };
    }
    case "create": {
      const runnerId = option(args, "--runner");
      const agentId = option(args, "--agent");
      if (!runnerId || !agentId) return { error: "session create requires --runner and --agent" };
      const effort = option(args, "--effort");
      const effortRequested = args.some((arg) => arg === "--effort" || arg.startsWith("--effort="));
      if (effortRequested && (!effort?.trim() || effort.startsWith("--"))) {
        return { error: "session create --effort requires a non-empty value" };
      }
      return {
        tool: "create_session",
        input: {
          runnerId,
          agentId,
          workspaceId: option(args, "--workspace"),
          workspacePath: option(args, "--path"),
          prompt: option(args, "--prompt"),
          title: option(args, "--title"),
          model: option(args, "--model"),
          effort,
          permissionMode: option(args, "--permission-mode"),
          useWorktree: flag(args, "--worktree"),
          costBudgetUsd: numeric(option(args, "--cost-budget")),
          maxToolCalls: numeric(option(args, "--max-tool-calls")),
          maxChildSessions: numeric(option(args, "--max-child-sessions")),
        },
      };
    }
    case "prompt":
      return words[2] && words.slice(3).join(" ").trim()
        ? { tool: "prompt_session", input: { sessionId: words[2], text: words.slice(3).join(" ") } }
        : { error: "session prompt requires an id and text" };
    case "handoff-result": {
      const revision = option(args, "--revision");
      return words[2] && revision
        ? { tool: "handoff_session_result", input: { sessionId: words[2], revision } }
        : { error: "session handoff-result requires an id and --revision" };
    }
    case "steering":
      return words[2]
        ? { tool: "list_steering_attempts", input: { sessionId: words[2] } }
        : { error: "session steering requires a session id" };
    case "steering-get":
      return words[2] && words[3]
        ? { tool: "get_steering_attempt", input: { sessionId: words[2], submissionId: words[3] } }
        : { error: "session steering-get requires a session id and submission id" };
    case "resolve-steering":
      return words[2] && words[3] && (words[4] === "queue_again" || words[4] === "dismiss")
        ? { tool: "resolve_steering_attempt", input: { sessionId: words[2], submissionId: words[3], action: words[4] } }
        : { error: "session resolve-steering requires a session id, submission id, and queue_again or dismiss" };
    case "wait":
      return words[2]
        ? {
            tool: "wait_session",
            input: {
              sessionId: words[2],
              states: (option(args, "--for") ?? "input_required,completed,failed,stopped").split(",").filter(Boolean),
              timeoutMs: numeric(option(args, "--timeout")),
              intervalMs: numeric(option(args, "--interval")),
            },
          }
        : { error: "session wait requires an id" };
    case "stop":
      return words[2] ? { tool: "stop_session", input: { sessionId: words[2] } } : { error: "session stop requires an id" };
    case "stop-job":
      return words[2] && words[3]
        ? { tool: "stop_background_job", input: { sessionId: words[2], jobId: words[3] } }
        : { error: "session stop-job requires a session id and a job id" };
    case "restart":
      return words[2] ? { tool: "restart_session", input: { sessionId: words[2] } } : { error: "session restart requires an id" };
    case "archive":
      return words[2] ? { tool: "archive_session", input: { sessionId: words[2] } } : { error: "session archive requires an id" };
    case "guardrails":
      return words[2]
        ? {
            tool: "set_guardrails",
            input: {
              sessionId: words[2],
              costBudgetUsd: numeric(option(args, "--cost-budget")),
              maxToolCalls: numeric(option(args, "--max-tool-calls")),
              maxChildSessions: numeric(option(args, "--max-child-sessions")),
            },
          }
        : { error: "session guardrails requires an id" };
    default:
      return { error: sessionHelp() };
  }
}

function payload(result: ToolResult): unknown {
  const raw = result.content[0]?.text ?? "";
  try { return JSON.parse(raw); } catch { return { error: raw }; }
}

async function compatible(
  fetchImpl: McpFetch,
  cpUrl: string,
  requiredProtocol: number,
  token: string,
  sessionId: string,
): Promise<{ error: string | null; protocolVersion?: number }> {
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (sessionId) headers[WOLLIPOG_AGENT_ACTOR_SESSION_HEADER] = sessionId;
    let response = await fetchImpl(`${cpUrl}/api/compatibility`, {
      method: "GET",
      headers,
      // Longer than the runner relay's 10-second credential-acknowledgement wait, so its named
      // failure reaches the caller instead of this timeout's bare abort (#1841).
      signal: AbortSignal.timeout(15_000),
    });
    // Protocol v100-v102 dogfood control planes predate the authenticated route but still expose
    // the version on their public health response. Released pre-v100 peers never receive this CLI.
    if (response.status === 404) {
      response = await fetchImpl(`${cpUrl}/healthz`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = JSON.parse(await response.text()) as { error?: unknown };
        if (typeof body.error === "string") detail = `: ${body.error}`;
      } catch { /* Keep the status alone when the body is not a JSON error. */ }
      return { error: `control plane compatibility check failed: HTTP ${response.status}${detail}` };
    }
    const body = JSON.parse(await response.text()) as { protocolVersion?: unknown };
    if (typeof body.protocolVersion !== "number" || body.protocolVersion < requiredProtocol) {
      return {
        error: `control plane protocol v${String(body.protocolVersion ?? "unknown")} is incompatible; this Wollipog CLI command requires v${requiredProtocol}`,
      };
    }
    return { error: null, protocolVersion: body.protocolVersion };
  } catch (error) {
    return { error: `control plane compatibility check failed: ${(error as Error).message}` };
  }
}

export async function runWollipogCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: Write; stderr: Write } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  fetchImpl: McpFetch = globalThis.fetch,
  hostAdminIo: HostAdminIo = { ...defaultHostAdminIo(), stdout: io.stdout, stderr: io.stderr },
): Promise<number> {
  const invocation = invocationArgs(argv);
  if (flag(invocation, "--version")) {
    io.stdout(`${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return 0;
  }
  const help = resolveHelp(invocation);
  if (help) {
    const json = flag(invocation, "--json");
    (help.ok || json ? io.stdout : io.stderr)(help.ok || !json
      ? `${help.text}\n`
      : `${JSON.stringify({ error: help.text })}\n`);
    return help.ok ? 0 : 2;
  }
  const args = expandCommandAlias(invocation);
  const json = flag(args, "--json");
  // A known pair verb expands above. Refuse an incomplete or unknown alias before credential
  // discovery so even usage mistakes retain the host-administration fail-closed boundary.
  if (args[0] === "pair") {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: pairHelp() })}\n` : `${pairHelp()}\n`);
    return 2;
  }
  // Host administration authenticates with the control plane's own protected local credential,
  // not a session or device token, so it branches before any session plumbing runs.
  if (positional(args)[0] === "admin") {
    if (positional(args).length === 1 || flag(args, "--help")) {
      (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: hostAdminUsage() })}\n` : `${hostAdminUsage()}\n`);
      return 2;
    }
    return runHostAdminCli(args, env, hostAdminIo, fetchImpl);
  }
  if (positional(args)[0] === "service") {
    if (positional(args).length === 1 || flag(args, "--help")) {
      (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: serviceUsage() })}\n` : `${serviceUsage()}\n`);
      return 2;
    }
    return runServiceCli(args, defaultServiceHost(fetchImpl), { ...defaultServiceIo(), stdout: io.stdout, stderr: io.stderr });
  }
  // Repository initialization is deliberately local and credential-free. It branches before
  // control-plane discovery and can only create the canonical file in the current Git checkout.
  if (positional(args)[0] === "init") {
    if (positional(args).length !== 1) {
      (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: initHelp() })}\n` : `${initHelp()}\n`);
      return 2;
    }
    return runWollipogInit(process.cwd(), json, io);
  }
  // Waiting on a pull request is local and read-only too: it reads GitHub through this machine's
  // `gh` login and never needs a session credential or the control plane.
  if (positional(args)[0] === "pr") return runPullRequestCli(args, json, io);
  const parsed = command(args);
  if ("error" in parsed) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: parsed.error })}\n` : `${parsed.error}\n`);
    return 2;
  }
  const cpUrl = (option(args, "--url") ?? env.WOLLIPOG_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
  const sessionId = env.WOLLIPOG_SESSION_ID ?? "";
  const relayEndpoint = env[AGENT_CONTROL_RELAY_ENDPOINT_ENV];
  const relayKey = env[AGENT_CONTROL_RELAY_KEY_ENV];
  const explicitTokenFile = option(args, "--token-file");
  let activeFetch = fetchImpl;
  let token = "";
  try {
    if (explicitTokenFile) {
      token = readToken(env, explicitTokenFile);
    } else if (relayEndpoint || relayKey) {
      if (!relayEndpoint || !relayKey) throw new Error("incomplete runner relay configuration");
      activeFetch = agentControlRelayFetch(relayEndpoint, relayKey);
    } else {
      token = readToken(env, option(args, "--token-file"));
    }
  } catch (error) {
    const message = `could not read Wollipog token: ${(error as Error).message}`;
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    return 1;
  }
  if (!cpUrl || (!token && !relayEndpoint)) {
    const message = "WOLLIPOG_CONTROL_PLANE_URL and an injected runner relay or token are required";
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    return 2;
  }
  const readinessError = token ? await waitForCredentialReady(env, token) : null;
  if (readinessError) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: readinessError })}\n` : `${readinessError}\n`);
    return 1;
  }
  const worktreeTools = new Set(["create_worktree", "attach_worktree", "select_worktree"]);
  const workflowDecisionTools = new Set([
    "request_workflow_decision", "get_workflow_decision", "consume_workflow_decision",
  ]);
  const requiredProtocol = parsed.tool === "create_session" && typeof parsed.input.effort === "string"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControlReasoningEffort
    : parsed.tool === "list_workflow_decisions" || (parsed.tool === "get_workflow_decision" &&
      typeof parsed.input.sessionId === "string" && parsed.input.sessionId !== sessionId)
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.descendantWorkflowDecisionInspection
    : parsed.tool === "discard_worktree"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktreeRetirement
    : parsed.tool === "attach_session_artifact"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.sessionArtifactFileAttach
    : parsed.tool === "reconcile_workflow_decision"
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.workflowDecisionActionReconciliation
    : ["get_campaign_issue_scope", "request_campaign_issue_scope_change"].includes(parsed.tool)
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.campaignIssueScopeChanges
    : ["request_github_issue_closure", "close_github_issue"].includes(parsed.tool)
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorIssueClosure
    : ["record_campaign_plan", "update_campaign_work_item", "assign_campaign_work_item",
      "adjudicate_campaign_recommendation", "get_campaign_work_items"].includes(parsed.tool)
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.campaignWorkLedger
    : workflowDecisionTools.has(parsed.tool)
    ? RUNNER_CAPABILITY_MIN_PROTOCOL.typedWorkflowDecisionDelegation
    : worktreeTools.has(parsed.tool)
      ? RUNNER_CAPABILITY_MIN_PROTOCOL.sessionWorktrees
      : RUNNER_CAPABILITY_MIN_PROTOCOL.sessionAgentControl;
  const compatibility = await compatible(activeFetch, cpUrl, requiredProtocol, token, sessionId);
  if (compatibility.error) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: compatibility.error })}\n` : `${compatibility.error}\n`);
    return 1;
  }
  const result = await executeManagerTool(parsed.tool, parsed.input, {
    fetch: activeFetch,
    cpUrl,
    selfSessionId: sessionId,
    token,
    actorHeader: sessionId ? WOLLIPOG_AGENT_ACTOR_SESSION_HEADER : null,
    orchestrator: env.WOLLIPOG_PERMISSION_PRESET === "orchestrator",
    controlPlaneProtocolVersion: compatibility.protocolVersion,
  });
  const data = payload(result);
  if (json) io.stdout(`${JSON.stringify(data)}\n`);
  else io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  return result.isError ? 1 : 0;
}

export async function runAgentControlMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const cpUrl = (env.WOLLIPOG_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
  const selfSessionId = env.WOLLIPOG_SESSION_ID ?? "";
  const relayEndpoint = env[AGENT_CONTROL_RELAY_ENDPOINT_ENV];
  const relayKey = env[AGENT_CONTROL_RELAY_KEY_ENV];
  let fetchImpl: McpFetch = globalThis.fetch;
  let token = "";
  try {
    if (relayEndpoint || relayKey) {
      if (!relayEndpoint || !relayKey) throw new Error("incomplete runner relay configuration");
      fetchImpl = agentControlRelayFetch(relayEndpoint, relayKey);
    } else {
      token = readToken(env);
    }
  } catch (error) {
    console.error(`[wollipog-mcp] could not read session token: ${(error as Error).message}`);
    process.exit(1);
  }
  if (!cpUrl || !selfSessionId || (!token && !relayEndpoint)) {
    console.error("[wollipog-mcp] session URL, id, and runner relay or token file are required");
    process.exit(1);
  }
  if (!relayEndpoint) {
    const transportFetch = fetchImpl;
    let unavailable = false;
    // MCP initialization, discovery, and ping are local. Keep the stdio connection alive
    // while re-registration is pending, and check the current credential on every HTTP
    // request so the same MCP process can recover after a runner reconnect or rotation.
    fetchImpl = async (url, init) => {
      let currentToken = "";
      try {
        currentToken = readToken(env);
      } catch {
        // Provisioning may temporarily replace the token file; retry without leaking paths.
      }
      if (!currentToken || !credentialReady(env, currentToken)) {
        if (!unavailable) console.error(JSON.stringify({
          event: "mcp_credential_pending", sessionId: selfSessionId, entryPoint: "mcp",
        }));
        unavailable = true;
        throw new Error("session credential is awaiting control-plane acknowledgment; retry this tool call after the runner reconnects");
      }
      if (unavailable) console.error(JSON.stringify({
        event: "mcp_credential_ready", sessionId: selfSessionId, entryPoint: "mcp",
      }));
      unavailable = false;
      return transportFetch(url, { ...init, headers: { ...init?.headers, authorization: `Bearer ${currentToken}` } });
    };
  }
  const deps: McpDeps = {
    fetch: fetchImpl,
    cpUrl,
    selfSessionId,
    token,
    actorHeader: WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
    orchestrator: env.WOLLIPOG_PERMISSION_PRESET === "orchestrator",
  };
  serveSessionManagementMcp(process.stdin, process.stdout, deps);
  process.stdin.on("end", () => process.exit(0));
  console.error(`[wollipog-mcp] serving session-scoped tools for ${selfSessionId}`);
}
