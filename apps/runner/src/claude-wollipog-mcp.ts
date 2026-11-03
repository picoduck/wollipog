/**
 * Per-server `timeout`, in milliseconds, for every runner-written Claude Code `wollipog` MCP entry
 * (#4072): three hours and one minute, the same as Codex's `CODEX_WOLLIPOG_MCP_TOOL_TIMEOUT_SEC`
 * and for the same reason. It covers `wait_pull_request`'s own maximum
 * (`PULL_REQUEST_WAIT_MAX_TIMEOUT_MS`, three hours) plus its at most 20-second read overrun.
 *
 * Claude Code aborts a stdio MCP call that sends no response or progress for 30 minutes, whatever
 * `timeoutMs` the call asked for, and the `wollipog` server sends no progress while a wait blocks.
 * Read from claude 2.1.312 and measured with `pnpm probe:claude-mcp-wait`: an entry's `timeout`
 * raises that idle limit for that server only (the larger of it and the global idle limit, so a
 * user's `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` still disables it), and it also becomes that
 * server's total per-call limit in place of `MCP_TOOL_TIMEOUT` and the 27.8-hour default. No
 * `wollipog` tool runs that long: `wait_pull_request` ends by three hours and 20 seconds,
 * `wait_session` by one hour, and every other tool much sooner.
 *
 * The setting lives inside the `wollipog` entry of a runner-written `--mcp-config` file, so no other
 * MCP server and none of the user's own Claude settings change.
 */
export const CLAUDE_WOLLIPOG_MCP_TIMEOUT_MS = 10_860_000;

/** The `wollipog` entry of a runner-written Claude Code `--mcp-config` file. The native and WSL
 * launches both build theirs here, so they carry the same per-server limit. */
export function claudeWollipogMcpServer(
  launch: { command: string; args: readonly string[] },
  env: Record<string, string>,
): { type: "stdio"; command: string; args: string[]; env: Record<string, string>; timeout: number } {
  return { type: "stdio", command: launch.command, args: [...launch.args], env, timeout: CLAUDE_WOLLIPOG_MCP_TIMEOUT_MS };
}
