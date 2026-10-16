import { accessSync, constants } from "node:fs";
import os from "node:os";
import { basename, delimiter, extname, join } from "node:path";
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

type Env = Record<string, string | undefined>;

/** `which`: the first executable `name` on the provider's PATH. */
function onPath(name: string, env: Env, host: CommandShellHost): string | undefined {
  return (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)).find((path) => host.executable(path));
}

const CLAUDE_SHELL_DIRECTORIES = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/**
 * Measured against Claude Code 2.1.296: CLAUDE_CODE_SHELL, then SHELL, each only when it names
 * bash or zsh and is executable (a bare name runs through PATH); otherwise PATH and the usual
 * directories, zsh before bash unless SHELL names bash. With zsh installed, a fish or nushell SHELL
 * therefore still runs Bash tool commands in zsh.
 */
function claudeCodeShell(env: Env, host: CommandShellHost): string | undefined {
  const { CLAUDE_CODE_SHELL: override, SHELL: envShell } = env;
  const usable = (shell: string) => (shell.includes("bash") || shell.includes("zsh")) &&
    (host.executable(shell) || !shell.includes("/") && Boolean(onPath(shell, env, host)));
  if (override && usable(override)) return override;
  if (envShell && usable(envShell)) return envShell;
  const order = envShell?.includes("bash") ? ["bash", "zsh"] : ["zsh", "bash"];
  for (const name of order) {
    const found = onPath(name, env, host) ??
      CLAUDE_SHELL_DIRECTORIES.map((dir) => join(dir, name)).find((path) => host.executable(path));
    if (found) return found;
  }
  return undefined;
}

type CodexShellType = "zsh" | "bash" | "sh" | "cmd" | "powershell";
const CODEX_SHELL_TYPES = new Map<string, CodexShellType>([
  ["zsh", "zsh"], ["sh", "sh"], ["cmd", "cmd"], ["bash", "bash"], ["pwsh", "powershell"], ["powershell", "powershell"],
]);
/** Each type's binaries and their fixed fallback paths, in Codex's search order. */
const CODEX_SHELL_BINARIES: Record<CodexShellType, Array<[string, string[]]>> = {
  zsh: [["zsh", ["/bin/zsh"]]],
  bash: [["bash", ["/bin/bash", "/usr/bin/bash"]]],
  sh: [["sh", ["/bin/sh"]]],
  cmd: [["cmd", []]],
  powershell: [["pwsh", ["/usr/local/bin/pwsh"]], ["powershell", []]],
};

/** Codex classifies a shell by its exact name, then by its file stem with each extension removed. */
function codexShellType(path: string): CodexShellType | undefined {
  const type = CODEX_SHELL_TYPES.get(path);
  if (type) return type;
  const stem = basename(path, extname(path));
  return stem && stem !== path ? codexShellType(stem) : undefined;
}

/**
 * Mirrors Codex 0.162.1 `shell_detect.rs`: Codex runs `<shell> -lc` with the type of the passwd
 * login shell (not SHELL) when that type is installed, as the login shell itself, on PATH, or at a
 * fixed path. Otherwise it tries zsh then bash on macOS, bash then zsh elsewhere, then /bin/sh.
 */
function codexShell(env: Env, host: CommandShellHost): string {
  const login = host.loginShell();
  const loginType = login ? codexShellType(login) : undefined;
  const fallback: CodexShellType[] = host.platform === "darwin" ? ["zsh", "bash"] : ["bash", "zsh"];
  for (const type of loginType ? [loginType, ...fallback] : fallback) {
    if (login && loginType === type && host.executable(login)) return login;
    for (const [name, paths] of CODEX_SHELL_BINARIES[type]) {
      const found = onPath(name, env, host) ?? paths.find((path) => host.executable(path));
      if (found) return found;
    }
  }
  return "/bin/sh";
}

/** The shell running a native host provider's commands, or undefined when the runner cannot know it. */
export function providerCommandShell(meta: Pick<SessionMeta, "driver" | "env" | "context" | "executionTarget">,
  host: CommandShellHost = defaultHost): string | undefined {
  // A container, cloud target or WSL distro has its own shells and accounts; Windows has no zsh.
  if (host.platform === "win32" || meta.context.kind !== "native") return undefined;
  if (meta.executionTarget && meta.executionTarget.adapter !== "host") return undefined;
  // The provider process inherits the runner environment under the session's explicit env.
  const env = { ...host.env, ...meta.env };
  if (meta.driver === "claude-code") return claudeCodeShell(env, host);
  if (meta.driver === "codex" || meta.driver === "codex-app-server") return codexShell(env, host);
  return undefined;
}

/** Per-turn note for sessions whose commands run in zsh; undefined for any other or unknown shell. */
export function shellGuidance(meta: Pick<SessionMeta, "driver" | "env" | "context" | "executionTarget">,
  host: CommandShellHost = defaultHost): string | undefined {
  const shell = providerCommandShell(meta, host);
  if (!shell) return undefined;
  if (meta.driver === "claude-code" ? !basename(shell).includes("zsh") : codexShellType(shell) !== "zsh") return undefined;
  return "[Wollipog Shell Guidance] Your shell commands run in zsh, not bash. " +
    "Quote glob-like arguments such as --include='*.ts' and patterns that may match nothing: zsh aborts the whole command with \"no matches found\" instead of passing the pattern through. " +
    "status is a read-only zsh variable; never assign to it, and use another name such as rc. " +
    "Unquoted $var does not word-split in zsh, so bash-style set -- $r or for x in $list sees one word; use an array or ${=var}. " +
    "[/Wollipog Shell Guidance]";
}
