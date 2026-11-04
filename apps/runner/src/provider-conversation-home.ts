import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { runContextCommand } from "./context-command.js";
import type { SessionMeta } from "./session-store.js";

/** Locate the original transcript store before default sign-in is replaced by an added account.
 * This resolves a directory only; the existing transfer copies just the selected conversation. */
export async function providerConversationHome(
  meta: Pick<SessionMeta, "driver" | "context" | "env">,
  deps: { nativeHome?: () => string; nativeEnv?: NodeJS.ProcessEnv; run?: typeof runContextCommand } = {},
): Promise<string> {
  const claude = meta.driver === "claude-code";
  if (!claude && meta.driver !== "codex" && meta.driver !== "codex-app-server") {
    throw new Error("this provider has no account transcript store");
  }
  let home: string;
  if (meta.context.kind === "wsl") {
    // Resolve inside the session's distribution, never against the Windows runner's HOME.
    const result = await (deps.run ?? runContextCommand)(meta.context, "sh", ["-c", claude
      ? 'printf "%s" "${CLAUDE_CONFIG_DIR:-${HOME:?}/.claude}"'
      : 'printf "%s" "${CODEX_HOME:-${HOME:?}/.codex}"'], {
      cwd: "/", env: meta.env, timeoutMs: 5_000, maxBuffer: 16 * 1024,
    });
    home = result.stdout;
  } else {
    const inherited = deps.nativeEnv ?? process.env;
    const variable = claude ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    home = meta.env[variable] ?? inherited[variable] ??
      join(meta.env.HOME ?? inherited.HOME ?? (deps.nativeHome ?? homedir)(), claude ? ".claude" : ".codex");
  }
  if (!(meta.context.kind === "wsl" ? posix.isAbsolute(home) : isAbsolute(home)) || /[\0\r\n]/u.test(home)) {
    throw new Error("the original provider transcript home could not be resolved");
  }
  return home;
}
