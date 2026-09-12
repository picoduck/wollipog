import { hostAdminUsage } from "./host-admin-cli.js";
import { serviceUsage } from "./service-cli.js";

export interface HelpResponse {
  ok: boolean;
  text: string;
}

export function rootHelp(): string {
  return [
    "Wollipog CLI",
    "",
    "Usage: wollipog <command> [options]",
    "       wollipog help [topic]",
    "",
    "Common Workflows:",
    "  doctor              Check service and host health (alias for admin doctor)",
    "  update              Safely update services with verification and rollback (alias for service upgrade)",
    "  pair <command>      Create, list, revoke, or recover pairing credentials (aliases for admin commands)",
    "  service <command>   Install, inspect, restart, update, view logs for, or uninstall Linux services",
    "",
    "Command Groups:",
    "  session             Manage agent sessions",
    "  worktree            Create, attach, select, and discard session worktrees",
    "  admin               Administer a control plane from its host",
    "  service             Manage a headless Linux systemd deployment",
    "  help [topic]        Show root or topic-specific help",
    "",
    "Global Options: --version, --help, -h",
    "",
    "Examples:",
    "  wollipog service install",
    "  wollipog service status",
    "  wollipog doctor",
    "  wollipog update",
    "  wollipog pair create --name laptop --output ./laptop.pairing-url",
    "  wollipog pair list",
    "  wollipog pair revoke DEVICE_ID",
    "  wollipog service logs control-plane --follow",
    "  wollipog service restart runner",
    "  wollipog admin runner-credential rotate --runner RUNNER_ID --output ./runner.token",
    "  wollipog service uninstall  # preserves data by default",
    "",
    "Topics: doctor, update, pair, service, admin, session, worktree",
    "Run `wollipog help <topic>` for complete commands and options. Use --json for stable machine-readable command output.",
  ].join("\n");
}

export function sessionHelp(): string {
  return [
    "Usage: wollipog session <command> [options]",
    "  session list [--archived] [--json]",
    "  session get <session-id> [--json]",
    "  session events <session-id> [--after <seq>] [--limit <count>] [--json]",
    "  session create --runner <runner-id> --agent <agent-id> [--workspace <workspace-id> | --path <path>]",
    "                 [--prompt <text>] [--title <title>] [--model <model>] [--permission-mode <mode>] [--worktree]",
    "                 [--cost-budget <usd>] [--max-tool-calls <count>] [--max-child-sessions <count>] [--json]",
    "  session prompt <session-id> <text> [--json]",
    "  session wait <session-id> [--for <state,...>] [--timeout <ms>] [--interval <ms>] [--json]",
    "  session stop <session-id> [--json]",
    "  session restart <session-id> [--json]",
    "  session archive <session-id> [--json]",
    "  session guardrails <session-id> [--cost-budget <usd>] [--max-tool-calls <count>]",
    "                     [--max-child-sessions <count>] [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
  ].join("\n");
}

export function worktreeHelp(): string {
  return [
    "Usage: wollipog worktree <command> [options]",
    "  worktree create [--session <session-id>] --branch <name> [--base <ref> | --base-ref <ref>] [--json]",
    "  worktree attach [--session <session-id>] --path <absolute-path> [--json]",
    "  worktree select [--session <session-id>] --path <absolute-path> [--json]",
    "  worktree discard [--session <session-id>] --path <absolute-path> [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
    "An injected agent session defaults --session to itself. Use discard, not raw Git removal, for runner-owned worktrees.",
  ].join("\n");
}

export function pairHelp(): string {
  return [
    "Usage: wollipog pair <command> [options]",
    "  pair create --name <name> [--user <user-id>] [--origin <public-origin>] [--output <file>] [--json]",
    "  pair list [--json]",
    "  pair revoke <device-id> [--yes] [--json]",
    "  pair url [--json]",
    "Options: --url <loopback-origin>, --token-file <protected-local-credential>.",
    "Aliases: create/list/revoke delegate to admin device create/list/revoke; url delegates to admin pairing-url.",
    "`pair create` mints a new one-time device credential. `pair url` recovers the existing bootstrap pairing URL.",
    "One-time secrets print only to an interactive terminal or a new protected --output file.",
  ].join("\n");
}

export function updateHelp(): string {
  return [
    "Usage: wollipog update [--user | --system] [--release <vX.Y.Z>] [--force] [--yes] [--json]",
    "Alias for `wollipog service upgrade` with identical verification, confirmation, health checks, rollback, output, and exit codes.",
  ].join("\n");
}

export function doctorHelp(): string {
  return [
    "Usage: wollipog doctor [--url <loopback-origin>] [--token-file <protected-local-credential>] [--json]",
    "Alias for `wollipog admin doctor`; it performs the same local safety checks and loopback-only diagnostics.",
  ].join("\n");
}

function helpForTopic(topic: string): string | null {
  switch (topic) {
    case "":
    case "root":
      return rootHelp();
    case "update":
      return updateHelp();
    case "pair":
      return pairHelp();
    case "doctor":
      return doctorHelp();
    case "service":
      return serviceUsage();
    case "admin":
      return hostAdminUsage();
    case "session":
    case "sessions":
      return sessionHelp();
    case "worktree":
    case "worktrees":
      return worktreeHelp();
    default:
      return null;
  }
}

/** Resolve explicit help without entering credential, control-plane, or service code. */
export function resolveHelp(args: string[]): HelpResponse | null {
  const helpCommand = args[0] === "help";
  const rootHelpFlag = args[0] === "--help" || args[0] === "-h";
  const helpAt = (index: number) => args[index] === "--help" || args[index] === "-h";
  const aliasHelpFlag = (["update", "doctor"].includes(args[0] ?? "") && helpAt(1))
    || (args[0] === "pair" && (helpAt(1) || (["create", "list", "revoke", "url"].includes(args[1] ?? "") && helpAt(2))));
  if (!helpCommand && !rootHelpFlag && !aliasHelpFlag) return null;

  const topic = helpCommand
    ? (args[1] && !args[1]!.startsWith("-") ? args[1]! : "")
    : (rootHelpFlag ? "" : args[0] ?? "");
  const text = helpForTopic(topic);
  return text
    ? { ok: true, text }
    : { ok: false, text: `Unknown help topic \`${topic}\`.\n\n${rootHelp()}` };
}

/**
 * Rewrite only the human-facing alias prefix. Every option and positional value after it remains
 * byte-for-byte identical and is parsed by the canonical implementation.
 */
export function expandCommandAlias(args: string[]): string[] {
  switch (args[0]) {
    case "update":
      return ["service", "upgrade", ...args.slice(1)];
    case "doctor":
      return ["admin", "doctor", ...args.slice(1)];
    case "pair":
      switch (args[1]) {
        case "create": return ["admin", "device", "create", ...args.slice(2)];
        case "list": return ["admin", "device", "list", ...args.slice(2)];
        case "revoke": return ["admin", "device", "revoke", ...args.slice(2)];
        case "url": return ["admin", "pairing-url", ...args.slice(2)];
        default: return args;
      }
    default:
      return args;
  }
}
