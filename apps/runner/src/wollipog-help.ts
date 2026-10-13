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
    "  issue-closure       Request human approval and execute one campaign issue closure",
    "  campaign            Record and read an Orchestrator campaign's work ledger",
    "  pr                  Wait for a pull request's required checks or merge-queue outcome",
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
    "  wollipog issue-closure request --proposal '<json>' --json",
    "  wollipog issue-closure execute <occurrence-id> --digest <resource-digest> --json",
    "  wollipog update",
    "  wollipog pair create --name laptop --output ./laptop.pairing-url",
    "  wollipog pair list",
    "  wollipog pair revoke DEVICE_ID",
    "  wollipog service logs control-plane --follow",
    "  wollipog service restart runner",
    "  wollipog admin runner-credential rotate --runner RUNNER_ID --output ./runner.token",
    "  wollipog service uninstall  # preserves data by default",
    "",
    "Topics: init, doctor, update, pair, service, admin, session, worktree, artifact, decision, campaign, pr",
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
    "  session events <session-id> [--after <seq> [--event-epoch <epoch>]] [--limit <count>] [--json]",
    "  session capabilities --runner <runner-id> --agent <agent-id> [--offset <count>] [--limit <count>] [--include-hidden] [--json]",
    "  session capabilities --runner <runner-id> --agent <agent-id> --model <exact-model-id> [--json]",
    "  session create --runner <runner-id> --agent <agent-id> [--workspace <workspace-id> | --path <path>]",
    "                 [--prompt <text>] [--title <title>] [--model <model>] [--effort <effort>] [--permission-mode <mode>] [--worktree]",
    "                 [--cost-budget <usd>] [--max-tool-calls <count>] [--max-child-sessions <count>] [--json]",
    "  session prompt <session-id> <text> [--json]",
    "  session steering <session-id> [--json]",
    "  session steering-get <session-id> <submission-id> [--json]",
    "  session resolve-steering <session-id> <submission-id> <queue_again|dismiss> [--json]",
    "  session handoff-result <session-id> --revision <result-revision> [--json]",
    "  session wait <session-id> [--for <state,...>] [--timeout <ms>] [--interval <ms>] [--json]",
    "  session stop <session-id> [--json]",
    "  session stop-job <session-id> <job-id> [--json]",
    "  session restart <session-id> [--json]",
    "  session archive <session-id> [--json]",
    "  session guardrails <session-id> [--cost-budget <usd>] [--max-tool-calls <count>]",
    "                     [--max-child-sessions <count>] [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
    "session events without --after returns the newest events. With --after it pages forward from that seq; pass the returned lastSeq as the next --after, and eventEpoch as --event-epoch, while hasMore is true.",
    "For uncertain steering delivery, inspect the exact submission before resolving it. A pending resolution is not confirmed; read it before retrying the identical action. These commands use the same descendant scope as session prompt.",
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
    "Reads an image (PNG, JPEG, GIF, or WebP, up to 8 MiB) or video (MP4 or WebM, up to 32 MiB) and attaches it to the session. The media type is taken from the file's content, not its name.",
    "Prints only the artifactId, mediaType, sizeBytes, and sha256 — never the file's bytes. Images may be cited in ui_evidence_approval for Orchestrator review; video evidence is reviewed by a human.",
    "An injected agent session attaches to itself and cannot name another session. A relative --file is resolved against the current directory.",
  ].join("\n");
}

export function issueClosureHelp(): string {
  return `Usage: wollipog issue-closure <command>

Commands:
  request --proposal '<json>'                  Request exact human approval
  execute <occurrence-id> --digest <sha256>     Execute the approved action once

The proposal requires requestId, issue, reason (completed or not_planned), explanation,
evidence, and an optional exact comment. Repository and current work conflicts are derived
by the runner and control plane. Only an injected root Orchestrator with protocol v194+
may close a campaign-scoped issue. Approval expires after 30 minutes; changed evidence
requires renewed human review. Read issueClosureResult to verify completion. If the
result is uncertain, inspect GitHub and never replay the action or substitute a shell command.

Issue scope: issue-scope get [--epic <number>]; issue-scope request --proposal <json>.
Tools: get_campaign_issue_scope, request_campaign_issue_scope_change, request_github_issue_closure, close_github_issue; recover with decision get.
`;
}

export function campaignHelp(): string {
  return `Usage: wollipog campaign <command> [--json]

Commands:
  plan --input '<json>'                          Upsert work items by key: {items[], planComplete}
  update-item <work-item-id> --input '<json>'    Update fields, commitment, stage, blocker, or endAttempt
  assign <work-item-id> <child-session-id>       Record that a descendant now works on the item
  adjudicate <recommendation-id> --input '<json>'
                                                 Record {disposition, reason, resultingWorkItemKey?,
                                                 resultingIssue?, publicationRequired?}
  allocate --input '<json>'                      Reserve a managed worker's allowance (protocol v218+)
  review --input '<json>'                        Dispatch/read a bounded controlled native review job
  review-job <job-id>                            Read a review receipt without new spending
  review-jobs [--limit <n>] [--cursor <job-id>] [--item <work-item-id>]
                                                 Read active and terminal recovery metadata
  review-report <job-id>                         Read a validated report separately for adjudication
  work-items [--item <id>] [--state <state>] [--origin original|follow_up]
             [--sort queue|activity|elapsed|cost] [--limit <n>] [--cursor <cursor>]
             [--recommendations]                 Read the summary and one page or one item

Only an injected Orchestrator session with control plane protocol v196+ may use these. Every
record lands in the root campaign's ledger. Records grant no authority: they never dispatch,
publish, merge, or resolve a decision. Record delivery with verify_campaign_child and its
workItem; a reported merged stage does not mark an item delivered.

Tools: record_campaign_plan, update_campaign_work_item, assign_campaign_work_item,
adjudicate_campaign_recommendation, get_campaign_work_items.
`;
}

export function decisionHelp(): string {
  return [
    "Usage: wollipog decision <command> [options]",
    "  decision request --request-id <id> --resource-key <key> --snapshot <json> [--json]",
    "  decision get <occurrence-id> [--session <id>] [--json]",
    "  decision list [--session <id>] [--limit <1-100>] [--cursor <occurrence-id>] [--json]",
    "  decision consume <occurrence-id> --snapshot <json> [--action <json>] [--json]",
    "  decision reconcile <occurrence-id> --snapshot <json> [--json]",
    "Options: --url <control-plane-origin>, --token-file <credential-file>.",
    "Reads may target an accessible descendant with --session for an Orchestrator; request, consume, and reconcile remain self-scoped and refuse --session. Tools: request_workflow_decision, get_workflow_decision, list_workflow_decisions, consume_workflow_decision, reconcile_workflow_decision.",
    "Descendant reads and lists require control plane v214. Follow nextCursor until absent. Older runners can use an updated CLI or GET /api/sessions/:id/workflow-decisions[/<occurrence-id>] against v214 where a session token is provisioned. Provider-isolated sessions have only a relay key: upgrade the runner/CLI instead of seeking a bearer token. Older control planes expose pending requests only through list_descendant_requests. A 404 or missing list entry never proves consumption.",
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

export function pullRequestHelp(): string {
  return [
    "Usage: wollipog pr wait <number|owner/name#number|url> [--repo <owner/name>] [--head <sha>]",
    "                        [--timeout <ms>] [--interval <ms>] [--any-failure] [--json]",
    "Block until the pull request's required checks pass or fail, its merge-queue entry fails or",
    "leaves the queue, it merges or closes, its head moves, or the timeout expires. It then prints one",
    "bounded summary: head SHA, each required check, merge-queue position and state, failed jobs with",
    "run links, and whether it merged. Nothing calls a model while it waits.",
    "Required checks come from the base branch's rulesets and branch protection. One GitHub has not",
    "reported yet is pending, never passing; a base with no required checks returns at once.",
    "It runs locally with this machine's `gh` login, reads only, and needs no control plane.",
    "A bare number uses the current directory's GitHub repository unless --repo is given.",
    "--head <sha> returns head_changed when the pull request no longer points at that commit.",
    "--timeout defaults to 240000 (4 minutes), up to 10800000; a slow GitHub read can add at most 20 seconds.",
    "--interval defaults to 30000, 10000-600000.",
    "--any-failure also returns when a check outside the required set fails.",
    "Exit status: 0 checks_passed, merged, or no_required_checks; 3 checks_failed, queue_failed,",
    "queue_ejected, closed, or head_changed; 124 timeout; 1 GitHub could not be read; 2 usage.",
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
    case "issue-closure":
      return issueClosureHelp();
    case "campaign":
      return campaignHelp();
    case "pr":
    case "pull-request":
      return pullRequestHelp();
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
    || (args[0] === "pair" && (helpAt(1) || (["create", "list", "revoke", "url"].includes(args[1] ?? "") && helpAt(2))))
    || (args[0] === "pr" && (helpAt(1) || (args[1] === "wait" && args.slice(2).some((arg) => arg === "--help" || arg === "-h"))));
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
