/** Provider-neutral Wollipog CLI plus the general stdio MCP entrypoint. */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { PROTOCOL_VERSION, WOLLIPOG_AGENT_ACTOR_SESSION_HEADER } from "@wollipog/protocol";
import {
  executeManagerTool,
  serveConductorMcp,
  type McpDeps,
  type McpFetch,
  type ToolResult,
} from "./conductor-mcp.js";
import { VERSION } from "./version.js";

type Write = (text: string) => void;

function readToken(env: NodeJS.ProcessEnv, tokenFile?: string): string {
  const file = tokenFile ?? env.WOLLIPOG_SESSION_TOKEN_FILE ?? env.WOLLIPOG_TOKEN_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return env.WOLLIPOG_TOKEN ?? "";
}

async function waitForCredentialReady(env: NodeJS.ProcessEnv, token: string): Promise<string | null> {
  const file = env.WOLLIPOG_SESSION_CREDENTIAL_READY_FILE;
  if (!env.WOLLIPOG_SESSION_ID || !file) return null;
  const expected = createHash("sha256").update(token).digest("hex");
  const deadline = Date.now() + 10_000;
  do {
    try {
      if (readFileSync(file, "utf8").trim() === expected) return null;
    } catch {
      /* The runner writes the acknowledgement marker atomically. */
    }
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

function positional(args: string[]): string[] {
  const values: string[] = [];
  const valueOptions = new Set([
    "--url", "--token-file", "--runner", "--agent", "--workspace", "--path", "--prompt",
    "--title", "--model", "--permission-mode", "--after", "--limit", "--for", "--timeout",
    "--interval", "--cost-budget", "--max-tool-calls",
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
  return [
    "Usage: wollipog session <command> [options]",
    "Commands: list, get, events, create, prompt, wait, stop",
    "Use --json for stable machine-readable output.",
  ].join("\n");
}

function invocationArgs(argv: string[]): string[] {
  const marker = argv.findIndex((arg) => arg === "--wollipog-cli");
  if (marker >= 0) return argv.slice(marker + 1);
  return argv.slice(basename(argv[0] ?? "") === "wollipog" ? 1 : 2);
}

function command(args: string[]): { tool: string; input: Record<string, unknown> } | { error: string } {
  const words = positional(args);
  if (words[0] !== "session" && words[0] !== "sessions") return { error: usage() };
  const verb = words[1];
  switch (verb) {
    case "list":
      return { tool: "list_sessions", input: { archived: flag(args, "--archived") } };
    case "get":
      return words[2] ? { tool: "get_session", input: { sessionId: words[2] } } : { error: "session get requires an id" };
    case "events":
      return words[2]
        ? { tool: "get_session_events", input: { sessionId: words[2], after: numeric(option(args, "--after")), limit: numeric(option(args, "--limit")) } }
        : { error: "session events requires an id" };
    case "create": {
      const runnerId = option(args, "--runner");
      const agentId = option(args, "--agent");
      if (!runnerId || !agentId) return { error: "session create requires --runner and --agent" };
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
          permissionMode: option(args, "--permission-mode"),
          useWorktree: flag(args, "--worktree"),
          costBudgetUsd: numeric(option(args, "--cost-budget")),
          maxToolCalls: numeric(option(args, "--max-tool-calls")),
        },
      };
    }
    case "prompt":
      return words[2] && words.slice(3).join(" ").trim()
        ? { tool: "prompt_session", input: { sessionId: words[2], text: words.slice(3).join(" ") } }
        : { error: "session prompt requires an id and text" };
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
    default:
      return { error: usage() };
  }
}

function payload(result: ToolResult): unknown {
  const raw = result.content[0]?.text ?? "";
  try { return JSON.parse(raw); } catch { return { error: raw }; }
}

async function compatible(fetchImpl: McpFetch, cpUrl: string): Promise<string | null> {
  try {
    const response = await fetchImpl(`${cpUrl}/healthz`, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return `control plane compatibility check failed: HTTP ${response.status}`;
    const body = JSON.parse(await response.text()) as { protocolVersion?: unknown };
    if (typeof body.protocolVersion !== "number" || body.protocolVersion < PROTOCOL_VERSION) {
      return `control plane protocol v${String(body.protocolVersion ?? "unknown")} is incompatible; Wollipog CLI requires v${PROTOCOL_VERSION}`;
    }
    return null;
  } catch (error) {
    return `control plane compatibility check failed: ${(error as Error).message}`;
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
): Promise<number> {
  const args = invocationArgs(argv);
  if (flag(args, "--version")) {
    io.stdout(`${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return 0;
  }
  const parsed = command(args);
  const json = flag(args, "--json");
  if ("error" in parsed) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: parsed.error })}\n` : `${parsed.error}\n`);
    return 2;
  }
  const cpUrl = (option(args, "--url") ?? env.WOLLIPOG_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
  const sessionId = env.WOLLIPOG_SESSION_ID ?? "";
  let token = "";
  try { token = readToken(env, option(args, "--token-file")); } catch (error) {
    const message = `could not read Wollipog token: ${(error as Error).message}`;
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    return 1;
  }
  if (!cpUrl || !token) {
    const message = "WOLLIPOG_CONTROL_PLANE_URL and a token (WOLLIPOG_SESSION_TOKEN_FILE, WOLLIPOG_TOKEN_FILE, or WOLLIPOG_TOKEN) are required";
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`);
    return 2;
  }
  const readinessError = await waitForCredentialReady(env, token);
  if (readinessError) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: readinessError })}\n` : `${readinessError}\n`);
    return 1;
  }
  const incompatibility = await compatible(fetchImpl, cpUrl);
  if (incompatibility) {
    (json ? io.stdout : io.stderr)(json ? `${JSON.stringify({ error: incompatibility })}\n` : `${incompatibility}\n`);
    return 1;
  }
  const result = await executeManagerTool(parsed.tool, parsed.input, {
    fetch: fetchImpl,
    cpUrl,
    selfSessionId: sessionId,
    token,
    actorHeader: sessionId ? WOLLIPOG_AGENT_ACTOR_SESSION_HEADER : null,
  });
  const data = payload(result);
  if (json) io.stdout(`${JSON.stringify(data)}\n`);
  else io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  return result.isError ? 1 : 0;
}

export async function runAgentControlMcp(env: NodeJS.ProcessEnv): Promise<void> {
  const cpUrl = (env.WOLLIPOG_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
  const selfSessionId = env.WOLLIPOG_SESSION_ID ?? "";
  let token = "";
  try { token = readToken(env); } catch (error) {
    console.error(`[wollipog-mcp] could not read session token: ${(error as Error).message}`);
    process.exit(1);
  }
  if (!cpUrl || !selfSessionId || !token) {
    console.error("[wollipog-mcp] session URL, id, and token file are required");
    process.exit(1);
  }
  const readinessError = await waitForCredentialReady(env, token);
  if (readinessError) {
    console.error(`[wollipog-mcp] ${readinessError}`);
    process.exit(1);
  }
  const deps: McpDeps = {
    fetch: globalThis.fetch,
    cpUrl,
    selfSessionId,
    token,
    actorHeader: WOLLIPOG_AGENT_ACTOR_SESSION_HEADER,
  };
  serveConductorMcp(process.stdin, process.stdout, deps);
  process.stdin.on("end", () => process.exit(0));
  console.error(`[wollipog-mcp] serving session-scoped tools for ${selfSessionId}`);
}
