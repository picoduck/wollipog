import { accessSync, constants } from "node:fs";
import os from "node:os";
import { basename, delimiter, join } from "node:path";
import type { SessionMeta } from "./session-store.js";

/** What the runner host reveals about the shell a native provider will choose. */
export interface CommandShellHost {
  platform: NodeJS.Platform;
  /** The runner's own environment; a provider inherits it under the session's explicit env. */
  env: NodeJS.ProcessEnv;
  /** The account's passwd login shell. */
  loginShell(): string | undefined;
  executable(path: string): boolean;
}

const defaultHost: CommandShellHost = {
  platform: process.platform,
  env: process.env,
  loginShell: () => { try { return os.userInfo().shell ?? undefined; } catch { return undefined; } },
  executable: (path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } },
};

const SHELL_DIRECTORIES = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/**
 * Measured against Claude Code 2.1.296: CLAUDE_CODE_SHELL, then SHELL, each only when it names
 * bash or zsh and is executable; otherwise PATH and the usual directories, zsh before bash unless
 * SHELL names bash. With zsh installed, a fish or nushell SHELL therefore still runs Bash tool commands in zsh.
 */
function claudeCodeShell(env: Record<string, string | undefined>, host: CommandShellHost): string | undefined {
  const { CLAUDE_CODE_SHELL: override, SHELL: envShell } = env;
  const usable = (path: string) => (path.includes("bash") || path.includes("zsh")) && host.executable(path);
  if (override && usable(override)) return override;
  if (envShell && usable(envShell)) return envShell;
  const order = envShell?.includes("bash") ? ["bash", "zsh"] : ["zsh", "bash"];
  const path = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of order) {
    const found = [...path, ...SHELL_DIRECTORIES].map((dir) => join(dir, name)).find((candidate) => host.executable(candidate));
    if (found) return found;
  }
  return undefined;
}

/**
 * Codex runs `<shell> -lc` with the passwd login shell, not SHELL. It recognizes zsh, bash and sh by
 * file name; any other login shell falls back to zsh on macOS and bash elsewhere.
 */
function codexShell(host: CommandShellHost): string {
  const login = host.loginShell();
  if (login && ["zsh", "bash", "sh"].includes(basename(login))) return login;
  return host.platform === "darwin" ? "zsh" : "bash";
}

/** The shell running a native host provider's commands, or undefined when the runner cannot know it. */
export function providerCommandShell(meta: Pick<SessionMeta, "driver" | "env" | "context" | "executionTarget">,
  host: CommandShellHost = defaultHost): string | undefined {
  // A container, cloud target or WSL distro has its own shells and accounts; Windows has no zsh.
  if (host.platform === "win32" || meta.context.kind !== "native") return undefined;
  if (meta.executionTarget && meta.executionTarget.adapter !== "host") return undefined;
  if (meta.driver === "claude-code") return claudeCodeShell({ ...host.env, ...meta.env }, host);
  if (meta.driver === "codex" || meta.driver === "codex-app-server") return codexShell(host);
  return undefined;
}

/** Per-turn note for sessions whose commands run in zsh; undefined for every other shell. */
export function shellGuidance(meta: Pick<SessionMeta, "driver" | "env" | "context" | "executionTarget">,
  host: CommandShellHost = defaultHost): string | undefined {
  const shell = providerCommandShell(meta, host);
  if (!shell || !basename(shell).includes("zsh")) return undefined;
  return "[Wollipog Shell Guidance] Your shell commands run in zsh, not bash. " +
    "Quote glob-like arguments such as --include='*.ts' and patterns that may match nothing: zsh aborts the whole command with \"no matches found\" instead of passing the pattern through. " +
    "status is a read-only zsh variable; never assign to it, and use another name such as rc. " +
    "Unquoted $var does not word-split in zsh, so bash-style set -- $r or for x in $list sees one word; use an array or ${=var}. " +
    "[/Wollipog Shell Guidance]";
}
