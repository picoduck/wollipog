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
    "  init                Generate .wollipog.json for the current repository without running tools",
    "  doctor              Check service and host health (alias for admin doctor)",
    "  update              Safely update services with verification and rollback (alias for service upgrade)",
    "  pair <command>      Create, list, revoke, or recover pairing credentials (aliases for admin commands)",
    "  service <command>   Install, inspect, restart, update, view logs for, or uninstall Linux services",
    "",
    "Command Groups:",
    "  session             Manage agent sessions",
    "  worktree            Create, attach, select, and discard session worktrees",
    "  artifact            Attach an image file to a session without passing its bytes through the model",
    "  decision            Request, read, consume, and reconcile typed workflow decisions for this session",
    "  admin               Administer a control plane from its host",
    "  service             Manage a headless Linux systemd deployment",
    "  help [topic]        Show root or topic-specific help",
    "",
    "Global Option: --version",
    "Root Help Options: --help, -h",
    "",
    "Examples:",
    "  wollipog service install",
    "  wollipog service status",
    "  wollipog doctor",
    "  wollipog init",
    "  wollipog update",
    "  wollipog pair create --name laptop --output ./laptop.pairing-url",
    "  wollipog pair list",
    "  wollipog pair revoke DEVICE_ID",
    "  wollipog service logs control-plane --follow",
    "  wollipog service restart runner",
    "  wollipog admin runner-credential rotate --runner RUNNER_ID --output ./runner.token",
    "  wollipog service uninstall  # preserves data by default",
    "",
    "Topics: init, doctor, update, pair, service, admin, session, worktree, artifact, decision",
    "Run `wollipog help <topic>` for complete commands and options. Help is always text; operational commands use --json for stable machine-readable output.",
  ].join("\n");
}

export function initHelp(): string {
  return [
    "Usage: wollipog init [--json]",
    "Generate .wollipog.json at the root of the current Git checkout.",
    "Detection reads bounded repository metadata only. It does not run detected tools, execute setup, stage files, or commit.",
    "An existing file, directory, or symbolic link is never overwritten.",
  ].join("\n");
}

export function sessionHelp(): string {
  return [
    "Usage: wollipog session <command> [options]",
    "  session list [--archived] [--json]",
    "  session get <session-id> [--json]",
    "  session events <session-id> [--after <seq>] [--limit <count>] [--json]",
    "  session capabilities --runner <runner-id> --agent <agent-id> [--offset <count>] [--limit <count>] [--include-hidden] [--json]",
    "  session capabilities --runner <runner-id> --agent <agent-id> --model <exact-model-id> [--json]",
    "  session create --runner <runner-id> --agent <agent-id> [--workspace <workspace-id> | --path <path>]",
    "                 [--prompt <text>] [--title <title>] [--model <model>] [--effort <effort>] [--permission-mode <mode>] [--worktree]",
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
    "An injected agent session defaults --session to itself. Use discard, not raw Git removal, for runner-owned worktrees; active retirement is durably deferred until provider exit and then replays on its own.",
  ].join("\n");
}

export function artifactHelp(): string {
  return [
    "Usage: wollipog artifact <command> [options]",
    "  artifact attach --file <path> [--name <display-name>] [--session <session-id>] [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
    "Reads an image file (PNG, JPEG, GIF, or WebP, up to 8 MiB) on this host and attaches it to the session as a screenshot artifact. The media type is taken from the file's content, not its name.",
    "Prints only the artifactId, mediaType, sizeBytes, and sha256 — never the file's bytes. Cite exactly those values in a ui_evidence_approval evidence item to make it reviewable by an Orchestrator.",
    "An injected agent session attaches to itself and cannot name another session. A relative --file is resolved against the current directory.",
  ].join("\n");
}

export function decisionHelp(): string {
  return [
    "Usage: wollipog decision <command> [options]",
    "  decision request --request-id <id> --resource-key <key> --snapshot <json> [--json]",
    "  decision get <occurrence-id> [--json]",
    "  decision consume <occurrence-id> --snapshot <json> [--action <json>] [--json]",
    "  decision reconcile <occurrence-id> --snapshot <json> [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
    "The injected child session can request_workflow_decision, get_workflow_decision, consume_workflow_decision, and reconcile_workflow_decision only for itself; --session is refused.",
    "Pass the exact typed resourceSnapshot as a JSON object in --snapshot. For a pr_merge consume, pass the exact WorkflowDecisionAction JSON object in --action; other categories omit it.",
    "Reconcile only an already-successful, exactly armed pr_merge action after the approved head has merged. Use its original snapshot; reconciliation never runs the merge command and requires control plane protocol v153.",
    "The control plane remains authoritative: it validates the category, policy owner, current resource snapshot, and one-shot consumption. This command cannot resolve its own decision.",
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
    case "help":
    case "root":
      return rootHelp();
    case "update":
      return updateHelp();
    case "init":
      return initHelp();
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
    case "artifact":
    case "artifacts":
      return artifactHelp();
    case "decision":
    case "decisions":
    case "workflow-decision":
    case "workflow-decisions":
      return decisionHelp();
    default:
      return null;
  }
}

/** Resolve explicit help without entering credential, control-plane, or service code. */
export function resolveHelp(args: string[]): HelpResponse | null {
  const helpCommand = args[0] === "help";
  const rootHelpFlag = args[0] === "--help" || args[0] === "-h";
  const helpAt = (index: number) => args[index] === "--help" || args[index] === "-h";
  const aliasHelpFlag = (["init", "update", "doctor"].includes(args[0] ?? "") && helpAt(1))
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
