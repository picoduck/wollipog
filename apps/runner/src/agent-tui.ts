/** Provider TUI launch policy. A TUI shares cwd and runner-local provider credentials with the
 * manager session, but never the structured driver's process, stdio, or provider session id. */

import type { SessionMeta } from "./session-store.js";
import type { ShellProcessLaunch } from "./shell-manager.js";
import { windowsCommandLine } from "./windows-conpty.js";

const TUI_DRIVERS = new Set(["claude-code", "codex", "codex-app-server"]);

function scrubInheritedEnv(driver: SessionMeta["driver"]): string[] {
  return driver === "claude-code"
    ? [
        "ANTHROPIC_API_KEY",
        "WOLLIPOG_CLAUDE_PERSISTENT",
        "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
        "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
        "MAM_CLAUDE_PERSISTENT",
        "MAM_CLAUDE_PERSISTENT_IDLE_MS",
        "MAM_CLAUDE_PENDING_MAX_MS",
        "WOLLIPOG_CONDUCTOR",
        "MAM_CONDUCTOR",
      ]
    : ["OPENAI_API_KEY", "WOLLIPOG_CONDUCTOR", "MAM_CONDUCTOR"];
}

function cmdTailQuoteArg(arg: string, command = false): string {
  // The complete /s /c tail is itself quoted. The executable token stays protected by its own
  // balanced quotes, where careting path metacharacters corrupts lookup. Data arguments are parsed
  // again by cmd after the outer pair is stripped and need metacharacter carets at that stage.
  if (/[\r\n]/.test(arg)) throw new Error("agent TUI cmd argument contains CR/LF");
  if (arg.includes("%")) throw new Error("agent TUI cmd argument contains %, which cmd.exe would expand");
  if (arg === "") return '""';
  if (!/[ \t"&|<>^()!]/.test(arg)) return arg;
  return `"${arg.replace(command ? /["^]/g : /["&|<>^()]/g, "^$&")}"`;
}

export function agentTuiLaunch(
  meta: SessionMeta,
  host: { platform: NodeJS.Platform; comspec?: string } = {
    platform: process.platform,
    comspec: process.env.ComSpec,
  },
): ShellProcessLaunch | null {
  if (!meta.command || !TUI_DRIVERS.has(meta.driver)) return null;
  const scrub = scrubInheritedEnv(meta.driver);
  if (host.platform === "win32" && meta.context.kind === "native") {
    // Configured CLIs may be .cmd shims. ConPTY calls CreateProcess directly, so route the exact
    // non-prompt argv through cmd.exe with a single, cmd-specific quoting pass.
    const commandLine = [cmdTailQuoteArg(meta.command, true), ...meta.args.map((arg) => cmdTailQuoteArg(arg))].join(" ");
    const comspec = host.comspec || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      env: meta.env,
      scrubInheritedEnv: scrub,
      // cmd.exe parses its /c tail itself. Wrapping the complete tail in one quote pair is the
      // canonical /s form; applying CommandLineToArgvW escaping to it again corrupts inner quotes.
      verbatimCommandLine: `${windowsCommandLine(comspec, ["/d", "/s", "/c"])} "${commandLine}"`,
    };
  }
  return { command: meta.command, args: [...meta.args], env: meta.env, scrubInheritedEnv: scrub };
}
