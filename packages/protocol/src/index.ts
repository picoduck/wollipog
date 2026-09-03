/**
 * Shared protocol types for Wollipog.
 *
 * Boundaries (see project brief):
 *   UI  <-> Control Plane : HTTP (commands) + WebSocket (live stream)
 *   Control Plane <-> Runner : WebSocket (commands down, events up)
 *   Runner <-> Agent : provider transport (ACP v1 stdio, Claude CLI stream JSON,
 *                      or Codex app-server/exec), translated inside the runner
 *
 * The runner owns every provider client and converts ACP `session/update`, Claude stream JSON,
 * and Codex app-server/exec events into the normalized `SessionEventPayload` union below, so the
 * control plane and UI never need to know provider wire shapes.
 */

// 4: snapshot carries `boxes`; box_upsert/box_removed + run_removed messages; AddBoxRequest/BoxView.
// 5: Phase 2 box-owned sessions — RegisterMessage.sessionSnapshots, session_history req/result,
//    session_event seq/ts; delete_session.
// 6: Phase 3 adopt external CLI sessions — ExternalSessionDescriptor, list_external_sessions
//    req/result, adopt_session.
// 7: chat-log fidelity — `final?` on user/agent/thought payloads (whole-message vs stream-chunk).
//    Additive + optional; not enforced at the handshake, so older runners interop unchanged.
// 8: reprocess_session req/result — re-import an adopted session's transcript with the current parser.
// 9: session_events_reset broadcast + `adopted` on SessionSnapshot/SessionView (gates reprocess).
// 10: per-model reasoning effort on AgentModel; list_directory req/result + CreateSessionRequest.workspacePath.
// 11: Context and governance additions (additive, optional) — AgentModel.contextWindow (context meter);
//     SessionConfig.costBudgetUsd + CreateRunRequest.costBudgetUsd (cost-budget gating, applied per
//     session / to run members); ThreadType + SessionView.threadType (projects sidebar). Event/message
//     *variants* land with the phase that emits+handles them, not here, so no consumer breaks.
// 12: Phase 2 rich-diff / review pane (PR-A, read-only) — GitDiffScope/GitDiffLine/GitHunk/GitDiffFile/
//     GitDiffInfo; GitAction gains {kind:'diff';scope}; GitActionData.diff?; GitActionRequest.scope?.
//     Additive + optional; older runners simply don't advertise the diff action.
// 13: Phase 2 rich-diff PR-B + last_turn — GitAction stage_hunk {direction,filePath,hunkIndex,diffHash};
//     commit.all?/expectStaged?; GitActionRequest direction?/filePath?/hunkIndex?/diffHash?/all?/
//     expectStaged?; GitHunk.staged?; GitStatusInfo.stagedCount?; GitCommitInfo.stagedOnly?;
//     git_result.code? (GitErrorCode); git_action.timeoutMs? (queued-mutation expiry). last_turn
//     scope goes live (runner-side turn-start tree snapshot in box meta.json — behavioral, no new wire
//     shapes; SessionSnapshot unchanged). Additive + optional.
// 14: Phase 8a/8b guardrails — PendingApproval.kind gains 'max_tool_calls'; PolicyRule/PolicyDecision
//     vocabulary + POLICY_APPROVAL_KINDS/isPolicyApproval(); SessionConfig.maxToolCalls;
//     SessionView.maxToolCalls/toolCallCount; CreateRunRequest.maxToolCalls. Additive + optional;
//     CP-side only (SessionSnapshot and runner wire unchanged — guardrails are invisible to runners).
// 15: adopt/version-skew UX — ExternalSessionDescriptor.resumable (a matching agent exists on the
//     box for that driver+context, so the UI can offer "Adopt & continue" vs "Adopt as read-only");
//     RegisterMessage.protocolVersion + RunnerView.protocolVersion (outdated-runner badge);
//     RunnerView.agentsRefreshed (a discovery pass has reported since register — an empty agent list
//     means "none installed", gating the install hints, not "still probing"). Additive + optional;
//     older runners omit them all — descriptors default to resumable and the badge stays off.
//     Also the pre-durable-Project SetWorkspaceRequest compatibility adapter
//     (POST /api/sessions/:id/workspace; CP-owned like board_column, invisible to runners).
// 16: session Files panel — list_session_files / read_session_file req/result (+ SessionFileEntry).
//     Paths on the wire are RELATIVE to the session root (worktreePath ?? repoPath, resolved by the
//     runner from box meta — the dashboard never names absolute paths). Additive + optional; older
//     runners just never answer, which the CP surfaces as a timeout.
// 17: per-session Shells panel — shell_open req/result, shell_input, shell_close (CP→runner);
//     shell_output / shell_exit (runner→CP, ephemeral — never persisted to the event log);
//     UiShellOutputMessage / UiShellExitMessage + ShellView. Pipe-based streaming console (no
//     PTY — node-pty is a native module this repo can't carry): raw stdin passthrough into a
//     persistent `sh` / `cmd /q` spawned in the session root. Additive + optional.
// 18: AgentDefinition.bin — discovery's logical binary name ("claude"/"codex"), the stable
//     launch-target identity for config↔discovery merging now that version-manager installs
//     launch as `node <entry.js>` with generically-named entry files. Additive + optional.
// 19: PTY shells — shell_open gains cols/rows, shell_open_result + ShellView gain `pty`
//     (a real PTY was allocated: POSIX/WSL via util-linux `script`, still no native modules;
//     Windows native stays pipe-based); new shell_resize (CP→runner, fire-and-forget).
//     shell_output data is RAW terminal bytes when pty — dashboards render with xterm.js.
//     Additive + optional: pre-v19 runners ignore cols/rows and omit pty ⇒ pipe behavior.
// 20: pinned summary — GitStatusInfo gains addedLines/deletedLines (working-tree numstat totals
//     vs HEAD, tracked files only). Additive + optional; older runners omit them and the
//     dashboard's Changes row falls back to the changed-file count.
// 21: git summary — GitAction gains {kind:'summary'}; GitSummaryInfo/GitPrSummary/
//     GitChecksSummary; GitActionData.summary?. One read powering the pinned summary's PR
//     title + failing-checks rows: status bits + `gh pr view` (PR + check rollup, TTL-cached
//     runner-side; gh missing/unauth ⇒ pr/checks null and the rows hide). Additive + optional;
//     older runners reject the unknown kind, which the dashboard treats as "no PR info".
// 22: host actions + editor discovery — EditorInfo; RunnerMetadata.editors?/
//     AgentsUpdatedMessage.editors?/RunnerView.editors? (discovery probes local editor CLIs);
//     host_action (CP→runner: open_editor / reveal on a session root or explicit path) +
//     host_action_result. Additive + optional; older runners ignore the unknown message and
//     the CP request times out with a clear error, and no editors ⇒ the button hides.
// 23: visible + cancelable prompt queue — QueuedPromptView; SessionView.queued?; session_queue
//     (runner→CP, ephemeral — the prompts waiting behind the running turn, relayed to dashboards
//     never persisted); cancel_queued_prompt (CP→runner: drop one not-yet-started prompt).
//     Additive + optional: pre-v23 runners never emit a queue ⇒ the UI shows none.
// 24: trust surface — structured agent questions (AgentQuestion/QuestionOption;
//     question_request / question_resolved events; answer_question CP→runner;
//     PendingApproval kind "question" + questions) and approval context (ApprovalContext on
//     permission_request + PendingApproval: tool name + a bounded rendering of its input, so
//     approval cards state WHAT is being approved). Additive + optional: pre-v24 runners never
//     emit questions/context ⇒ the UI shows none.
// 25: per-turn checkpoints + rewind — checkpoint / checkpoint_restored events (worktree
//     sessions anchor each turn's pre-turn tree under compatibility refs in both
//     refs/wollipog/<sessionId>/turn-<n> and refs/mam/<sessionId>/turn-<n>);
//     rewind_session req / rewind_result (CP→runner request/response: restore the worktree
//     to a checkpoint tree; files only — the agent conversation continues). Additive +
//     optional: pre-v25 runners never emit checkpoints ⇒ the UI shows no rewind affordance.
// 26: subagent tree attribution — optional `parentToolUseId` on the payload variants a subagent
//     can emit (agent_message/agent_thought/tool_call/tool_call_update/plan/file_edit). The
//     claude driver reads stream-json `parent_tool_use_id` (the id of the spawning Task tool
//     call); the UI nests those events under their parent Task block. Additive + optional:
//     pre-v26 runners never set it ⇒ the UI renders the timeline flat, as before.
// 27: Codex app-server compatibility discovery — optional AgentDefinition.codexAppServer reports
//     the resolved CLI version, verification mode, pinned contract fingerprint, and a structured
//     fallback reason. Additive + optional: pre-v27 runners omit it and clients retain the legacy
//     Codex presentation; old control planes persist no value and continue to launch codex exec.
// 28: provider-native conversation forks — conversation_checkpoint events mark completed
//     provider turns; fork_session / fork_result mint a new provider session plus an isolated
//     worktree at that exact post-turn state. Additive + optional: older runners emit no fork
//     points and the dashboard shows no fork affordance.
// 29: privacy-safe driver operational telemetry. Runners emit bounded, content-free launch,
//     resume, approval, crash, and fallback observations; the control plane stores hourly
//     aggregates only. SessionLaunchSpec.agentVersion supplies the discovered version dimension.
// 30: Claude Code launch-readiness discovery — optional AgentDefinition.claudeCode reports the
//     resolved CLI's verified flags/modes, safe auth/billing classification, and PATH diagnostics.
// 31: recursive subagent fidelity — `agent` is the normalized Task/agent tool kind and optional
//     parent/duration fields on token_usage let capable runners attach subagent rollups. Additive +
//     optional: pre-v31 runners keep flat usage totals and the UI derives status/duration when able.
// 32: context-native isolation and admission — RunnerMetadata/RunnerView.runtime advertises the
//     external data root and box process ceiling. WSL worktrees execute inside their distro and
//     session status `queued` exposes FIFO admission waits. Additive + optional.
// 33: ACP authentication choices reuse the approval transport with an optional authentication
//     purpose/kind and bounded option descriptions. Pre-v33 peers render a normal approval card.
// 34: capability-gated provider logout request/result; runners refresh the content-free agent
//     authStatus after a confirmed ACP login/logout. Older runners expose no sign-out action.
// 35: ACP-native external-session discovery binds every descriptor to its exact configured agent
//     id; correlated adopt results return only runner-revalidated descriptors/snapshots.
// 36: session snapshots carry live session-scoped agent capabilities; runtime snapshot updates keep
//     ACP modes/config options/commands isolated between concurrent sessions.
// 37: stable ACP usage/title updates carry provider context fill, cumulative USD cost, and explicit
//     generated/user/provider title ownership through runner snapshots.
// 38: ACP session context carries secret-free MCP definitions plus explicitly selected additional
//     directories. Workspace metadata exposes only operator-granted directory choices.
// 39: stabilized ACP Registry v1 metadata. Registry entries remain unavailable until a local
//     launch is discovered or an explicit install approval is completed; capabilities and auth
//     status are still derived exclusively from the live ACP initialize handshake.
// 40: explicit, version-bound approval/revocation for Registry package launches. Binary archive
//     distributions remain manual-only because Registry v1 supplies no integrity digest.
// 41: AgentDefinition explicitly reports runner-local ACP stdio transport. Direct Streamable
//     HTTP/WebSocket remains an Active upstream RFD and is rejected by runner config.
// 42: provider-aware weighted admission diagnostics. RunnerRuntimeInfo optionally advertises exact
//     agent-id process limits and capacity weights; unlisted agents retain limit=unbounded/weight=1.
// 43: runner-owned Linux/WSL bubblewrap isolation policy diagnostics. Provider mode preserves the
//     existing driver sandbox; bwrap mode is fail-closed and may additionally deny network access.
// 44: optional provider-state orphan age/byte controls. Runners journal exact cleanup, claim WSL
//     partitions before GC, and report the effective bounded-retention policy in runtime metadata.
// 45: audited native platform isolation adapters. macOS Seatbelt gates filesystem writes/network;
//     Windows Job Objects provide an explicitly process-only kill-on-close tree boundary.
// 46: append-only governance audit records capture approval requests, policy asks, and resolutions
//     with reviewer identity, bounded scope, and content digests instead of raw tool input.
// 47: runner-side mid-turn cost/tool guardrails cancel at the first normalized threshold event;
//     Continue re-arms the next bounded allowance window through rearm_governance.
// 48: reviewer-neutral governance decisions. review_decision carries a typed model-review verdict;
//     ApprovalContext.escalatedBy attributes a subsequent human approval to the reviewer that
//     escalated it. Additive + optional; older runners retain their existing approval flow.
// 49: declarative approval policies match contextual/stateful input across organization, runner,
//     workspace, agent, branch, tool, path, and network scopes. ApprovalContext gains the bounded
//     scope fields capable drivers can prove. Additive + optional.
// 50: high-fidelity local review exposes canonical staged/unstaged diff panes plus stale-guarded
//     line staging and tracked-file discard. Older runners retain combined diff + hunk staging.
// 51: read-only GitHub review reconciliation imports durable PR review threads with explicit
//     remote provenance and resolution/outdated state. No GitHub mutation is implied.
// 52: pod worktree reconciliation merges one clean same-runner member head into another through
//     runner-owned session metadata and returns immutable merge/conflict provenance.
// 53: durable automation commands use a distinct runner message, stable command identity, and
//     monotonic runner receipts. This makes control-plane/socket retries deduplicated at the
//     runner-acceptance boundary without claiming provider-side exactly-once execution.
// 54: agent launch environment is runner-local. Runner metadata, control-plane persistence,
//     session snapshots, and durable commands carry no values or reference names; the runner
//     resolves literal/fromEnv config immediately before every provider process launch.
// 55: indexed, bounded runner history pages. A distinct session_history_page request/result freezes
//     the runner log epoch and durable tail for each page chain; legacy session_history remains
//     unchanged for rolling compatibility. Fork/reprocess may defer their event arrays so the
//     control plane rehydrates through the bounded page channel.
// 56: prompt image bodies are immutable artifact references on control-plane/runner durable and
//     WebSocket boundaries. The runner verifies and materializes bytes only at the provider edge.
// 57: durable detachable terminal sessions. Shell output carries runner-monotonic sequence ids;
//     reconnecting runners replay bounded per-shell snapshots and finish with an authoritative
//     inventory fence. Shell metadata/history survives dashboard and control-plane restarts,
//     while agent TUI mirrors remain explicitly separate processes from structured agent control.
// 58: native Windows shells use ConPTY, and dashboards may request a provider TUI as a separately
//     spawned process. The TUI never reuses the structured agent process or its control stream.
// 59: canonical file/line/column/symbol deep links and precise editor launches. Location-aware
//     host actions use a distinct message kind so an older control plane rejects them instead of
//     silently dropping the location and opening only the session root.
// 60: provider-neutral execution-target descriptors separate placement/workspace policy from the
//     agent driver. Existing local, worktree, and SSH-box launches project into the new contract;
//     additive fields let pre-v60 peers continue using runnerId + useWorktree unchanged.
// 61: runner-owned container targets advertise digest-pinned environment templates, compatible
//     agent ids, deterministic setup-check provenance, and explicit no-secret/no-billing bounds.
// 62: runner-owned cloud proxy targets add immutable git/artifact handoff receipts plus explicit
//     target-metered cost budgets and per-target admission. Adapter credentials stay runner-local.
// 63: Codex App Server session discovery reuses the existing Codex rollout store while preserving
//     the selected interactive driver for adoption. Older runners only understand Codex exec
//     discovery and must not report a misleading empty App Server result.
// 64: Agent capabilities report per-permission-mode elicitation transports. The optional field
//     keeps older runners compatible; absence means unknown rather than unsupported.
// 65: Claude policy hooks bind a per-session credential hash and acknowledge it before HTTP.
// 66: hook-backed governance adds durable same-invocation ask polling and per-policy timeouts.
// 67: initial Native TUI launch can fence shell_open behind the matching session-start generation.
// 68: native session snapshots may report the provider-resolved model separately from the selected
//     alias, preserving config semantics while making the actual executing model visible.
// 69: Claude background-work lifetime is runner-owned and visible. Optional BackgroundWorkState
//     on SessionSnapshot/SessionView keeps older runners and control planes wire-compatible.
// 70: optional provider message identity preserves streamed agent-text boundaries. Consumers
//     retain legacy adjacency coalescing when the field is absent, so rolling peers stay compatible.
// 71: interrupt_turn is an explicit non-terminal active-turn interruption. It preserves queued
//     prompts and records a transcript-visible turn_interrupted result without changing the
//     legacy cancel_session lifecycle contract used by older control planes and workflows.
// 72: active-turn coordinates move to the authoritative ephemeral queue projection and correlated
//     interrupt_turn_result acknowledgements distinguish delivery from an applied interruption.
// 73: conversation steering uses a distinct correlated request/result, explicit provider
//     capability, durable control-plane attempt receipts, and runner-owned accepted user events.
// 74: slash-command metadata gains an optional argument hint. Native session snapshots may overlay
//     their exact command set without freezing catalog-owned model, effort, or approval controls.
// 75: runner-authorized session commands use opaque catalog identities and a distinct durable
//     invocation/receipt lane. Structured execution remains fail-closed until a provider proves it.
// 76: additive Git visibility facts distinguish HEAD/upstream/default-base divergence, primary vs.
//     linked worktrees, dirty categories, in-progress operations, shallow repositories, and the
//     shared remote-ref timestamp. Git status/summary may target a primary checkout by session id;
//     the runner resolves its authoritative repoPath and all other actions remain linked-only.
// 77: runners authenticate a read-only control-plane identity attestation before opening mutable
//     local stores, so persistent state can be bound to the installation rather than an endpoint.
// 78: durable queued prompts share one command/queue/event identity and pre-admission queues are
//     projected live, allowing exact cancellation without inferring authority from persisted rows.
// 79: provider-authentication terminal receipts use a distinct error code. A v79 runner sending
//     to an older control plane downgrades only the wire projection to COMMAND_CANCELLED so the
//     older validator still accepts a terminal receipt; the runner-local journal keeps exact truth.
// 80: runner-owned subscription-usage sources publish normalized, secret-free provider windows;
//     correlated refresh requests remain no-turn and preserve last-known control-plane snapshots.
// 81: Claude managed background work distinguishes an external-job wait from the durable
//     continuation-delivery barrier. Older peers continue to treat the optional state as absent.
// 82: projection-safe managed background-job snapshots and structured continuation evidence let
//     the control plane durably track transcript projection and dashboard observation.
// 83: runners explicitly classify provider background-work tracking. Providers without a
//     lifecycle signal report `untracked` instead of letting an absent field imply safety.
//     Structured continuation evidence carries bounded provider-neutral terminal summaries.
// 84: replacement starts carry a control-plane launch identity that runners persist and echo in
//     live status and reconnect snapshots, proving which runtime crossed a durable Stop fence.
// 85: stop_session carries a durable operation identity and correlated acceptance or rejection.
//     Older runners retain the conservative Stop Pending behavior.
// 86: structured questions may include provider-declared free-text input, optional fields,
//     secret entry, primitive format/length/range constraints, and multi-select cardinality.
//     All fields are additive; pre-v86 peers retain the original required-choice behavior.
// 87: streamed agent responses gain a content-free completion event. New runners emit it only at
//     an authoritative successful turn boundary; older runners omit it and reminders retain their
//     scheduled fallback. The separate event avoids replaying message text for legacy consumers.
// 88: structured request resolution events gain an optional bounded reason so replacement,
//     provider-side settlement, explicit submission, and dismissal remain distinguishable in
//     durable history. Pre-v88 peers retain the existing optionId/answered presentation.
// 89: Stop delivery attempts carry a distinct durable identity in addition to their stable
//     operation identity, so delayed results cannot cross an authorized retry boundary. Older
//     peers retain conservative Stop Pending behavior because they cannot prove the attempt.
// 90: Managed agent skills: the control plane pushes the authoritative desired skill set for a
//     machine (skills_sync) and the runner reports authoritative deployment state (skills_state).
//     Pre-v90 runners never receive the new messages because the capability gate fails closed.
// 91: the Conductor's runner env gate (WOLLIPOG_CONDUCTOR) is removed; the device-local
//     Conductor-Led Work experiment (default off, versioned client storage) becomes the only
//     gate. A runner synthesizes and advertises the conductor only to a v91+ control plane:
//     older deployments serve web bundles that both default the experiment ON and cannot
//     distinguish a legacy stored opt-in, so unconditional advertisement to them would surface
//     the feature to users who never chose it.
// 92: authoritative cross-harness subagent lifecycle. Tool events may carry a provider-observed
//     subagentLifecycle independent of the foreground session lifecycle, and command output can be
//     attributed to its spawning agent. Pre-v92 runners omit both fields; dashboards retain the
//     existing conservative session/tool inference and flat command-output presentation.
// 93: runner-hosted semantic session naming. A correlated metadata request executes through the
//     session's exact native Codex or Claude account on its owning runner, with ephemeral/no-tool
//     provider state and a bounded secret-free result. Older runners are never sent the request.
// 94: runner-local custom session-naming endpoints. Owners/admins provision a write-only API key
//     to one selected runner, while the control plane persists only secret-free configuration and
//     readiness. Configuration, deletion, testing, and title generation are capability-gated.
// 95: session naming may target an explicit authenticated runner harness, advertised model, and
//     reasoning effort instead of inheriting them from the session. Older runner-account settings
//     keep their v93 follow-session behavior until an owner/admin saves an explicit target.
// 96: managed skill desired-state delivery splits metadata from digest-addressed content. A
//     runner requests only missing versions and applies the authoritative manifest only after an
//     explicit completion frame; pre-v96 peers retain the bounded single-frame v90 protocol. The
//     runner also reports bounded managed-link removal events; older runners omit that projection.
// 97: session-naming target drift uses precise runner failure codes for missing harnesses and
//     models. Because protocol v96 shipped on both sides of the unversioned vocabulary addition,
//     new runners downgrade those codes for every pre-v97 control plane.
// 98: native session capability overlays can revoke or restore steering when a verified
//     persistent provider transport falls back at runtime. Older peers retain catalog truth.
// 99: queued-prompt editing uses capability-gated correlated reads and idempotent revision-fenced
//     replacements. The runner remains authoritative for mutability, identity, and FIFO position.
// 100: every native session receives a runner-minted, exact-session control credential and the
//      runner's Wollipog CLI entrypoint. The same credential authenticates the provider-neutral
//      stdio MCP surface; only its hash crosses the runner socket or reaches durable storage.
// 101: session_worktree/session_worktree_result correlated operations plus durable active and
//      linked worktree metadata. Additive + optional; pre-v101 runners reject worktree routes.
// 102: explicit session-worktree discard plus conservative runner-side PR-state reconciliation.
//      Older peers retain create/attach/select and never receive the destructive operation.
export const PROTOCOL_VERSION = 102;
/** A durable hook approval is abandoned only after its sidecar has stopped heartbeating longer
 * than the runner's complete bounded transport-retry window. Human askTimeout remains separate. */
export const POLICY_HOOK_ABANDONMENT_MS = 30_000;

/** Version of the UI-facing control-plane HTTP/WebSocket contract. This is intentionally
 * independent of PROTOCOL_VERSION, which negotiates runner capabilities. Remote-instance
 * clients use this value to reject an incompatible control plane before switching context. */
export const CONTROL_PLANE_API_VERSION = 1;

/** Stable service markers accepted during the Wollipog wire-name migration. Current control
 * planes emit Wollipog after the compatibility release; clients still accept the legacy marker. */
export const LEGACY_CONTROL_PLANE_SERVICE = "misko-agent-manager-control-plane" as const;
export const WOLLIPOG_CONTROL_PLANE_SERVICE = "wollipog-control-plane" as const;
export const CONTROL_PLANE_SERVICE = WOLLIPOG_CONTROL_PLANE_SERVICE;
export type ControlPlaneService =
  | typeof LEGACY_CONTROL_PLANE_SERVICE
  | typeof WOLLIPOG_CONTROL_PLANE_SERVICE;

export function isControlPlaneService(value: unknown): value is ControlPlaneService {
  return value === LEGACY_CONTROL_PLANE_SERVICE || value === WOLLIPOG_CONTROL_PLANE_SERVICE;
}

/** HTTP wire identities retained during the Wollipog compatibility window. Current producers use
 * the Wollipog generation while consumers continue accepting both generations. */
export const LEGACY_TRANSCRIPT_SHARE_AUTH_SCHEME = "MAM-Share" as const;
export const WOLLIPOG_TRANSCRIPT_SHARE_AUTH_SCHEME = "Wollipog-Share" as const;
export const LEGACY_CONDUCTOR_ACTOR_SESSION_HEADER = "x-mam-actor-session" as const;
export const WOLLIPOG_CONDUCTOR_ACTOR_SESSION_HEADER = "x-wollipog-actor-session" as const;
/** Exact session claim paired with a per-session agent-control credential. */
export const WOLLIPOG_AGENT_ACTOR_SESSION_HEADER = "x-wollipog-agent-session" as const;
export const LEGACY_POLICY_HOOK_SESSION_HEADER = "x-mam-hook-session" as const;
export const WOLLIPOG_POLICY_HOOK_SESSION_HEADER = "x-wollipog-hook-session" as const;
export const LEGACY_AUTOMATION_TRIGGER_MEDIA_TYPE = "application/vnd.mam.automation-trigger+json" as const;
export const WOLLIPOG_AUTOMATION_TRIGGER_MEDIA_TYPE = "application/vnd.wollipog.automation-trigger+json" as const;
export const LEGACY_AUTOMATION_TRIGGER_HEADERS = {
  timestamp: "x-mam-timestamp",
  nonce: "x-mam-nonce",
  signature: "x-mam-signature",
} as const;
export const WOLLIPOG_AUTOMATION_TRIGGER_HEADERS = {
  timestamp: "x-wollipog-timestamp",
  nonce: "x-wollipog-nonce",
  signature: "x-wollipog-signature",
} as const;

/** Capability identifiers returned by control planes that support saved remote-instance clients. */
export const CONTROL_PLANE_CAPABILITIES = ["remote-instance-v1"] as const;

/** Authenticated identity and compatibility contract for one control-plane installation. */
export interface ControlPlaneInstanceInfo {
  service: ControlPlaneService;
  instanceId: string;
  displayName: string;
  apiVersion: typeof CONTROL_PLANE_API_VERSION;
  appVersion: string;
  capabilities: Array<(typeof CONTROL_PLANE_CAPABILITIES)[number] | string>;
}

/** Minimal runner-authenticated identity returned before the runner opens any mutable local store. */
export interface RunnerControlPlaneAttestation {
  service: ControlPlaneService;
  instanceId: string;
  protocolVersion: number;
  /** Present only when the runner supplied a prior credential hash for safe v1 migration. */
  priorCredentialValid?: boolean;
}

/** Minimum runner protocol for UI/control-plane commands that old runners otherwise ignore.
 * Keep this table aligned with the version history above. Missing protocol metadata means the
 * runner predates v15, so support cannot be proven and callers must fail closed. */
export const RUNNER_CAPABILITY_MIN_PROTOCOL = {
  externalSessions: 6,
  /** Correlated adoption results were introduced in v35. The result shape is provider-neutral;
   * current runners revalidate native Codex/Claude descriptors as well as ACP descriptors. */
  authoritativeExternalAdoption: 35,
  sessionReprocess: 8,
  directoryListing: 10,
  richDiff: 12,
  hunkStaging: 13,
  fineGrainedDiff: 50,
  githubReviewReconciliation: 51,
  podReconciliation: 52,
  automationCommandReceipts: 53,
  runnerLocalAgentEnv: 54,
  indexedHistory: 55,
  promptImageReferences: 56,
  durableSessionShells: 57,
  agentTuiMirror: 58,
  editorLocations: 59,
  executionTargets: 60,
  containerExecutionTargets: 61,
  cloudExecutionHandoffs: 62,
  codexAppServerExternalSessions: 63,
  policyHookAsk: 66,
  sessionStartFencedShells: 67,
  sessionFiles: 16,
  sessionShells: 17,
  hostActions: 22,
  queuedPromptCancellation: 23,
  checkpointRewind: 25,
  conversationFork: 28,
  runtimeDiagnostics: 32,
  acpLogout: 34,
  acpSessionContext: 38,
  acpRegistryApproval: 40,
  governanceRearm: 47,
  turnInterruption: 71,
  turnInterruptionAck: 72,
  conversationSteering: 73,
  nativeSteeringOverlay: 98,
  queuedPromptEditing: 99,
  sessionCommandInvocations: 75,
  gitVisibility: 76,
  durablePromptQueueIdentity: 78,
  providerAuthenticationReceipts: 79,
  subscriptionUsage: 80,
  /** The control plane serves an experiment-gated web bundle (versioned conductor storage,
   * default off). Runners fence unconditional conductor advertisement on this floor. */
  ungatedConductorAdvertisement: 91,
  managedBackgroundDelivery: 82,
  backgroundWorkTracking: 83,
  correlatedRestartEcho: 84,
  stopFailureRecovery: 85,
  stopAttemptCorrelation: 89,
  agentSkills: 90,
  chunkedAgentSkills: 96,
  /** v96 runners emit the additive `skills_state.removals` event projection. */
  skillLinkRemovalReporting: 96,
  sessionAgentNaming: 93,
  sessionCustomModelNaming: 94,
  sessionNamingTargets: 95,
  sessionNamingDriftCodes: 97,
  sessionAgentControl: 100,
  sessionWorktrees: 101,
  sessionWorktreeDiscard: 102,
} as const;

/* ========================================================================== */
/* Execution targets                                                          */
/* ========================================================================== */

/** Where a runner is reached. This is deliberately independent of AgentDriverKind. */
export type ExecutionTargetKind = "local" | "ssh" | "container" | "cloud";
export type ExecutionWorkspaceStrategy = "in_place" | "worktree" | "snapshot";

/** Honest, operator-owned boundaries for one execution placement. `unknown` is preferable to an
 * inferred security or billing claim. Secret values are never part of this descriptor. */
export interface ExecutionTargetBoundaries {
  filesystem: "host" | "worktree" | "container" | "snapshot";
  network: "inherit" | "deny" | "policy";
  secrets: "runner_local" | "references" | "none";
  billing: "agent_account" | "target_metered" | "none" | "unknown";
}

/** Reproducible environment pinned into an execution-target reference. The image reference must
 * include its digest; setupCheckDigest binds the ordered, argv-native readiness checks. */
export interface ExecutionEnvironmentTemplateRef {
  id: string;
  revision: number;
  image: string;
  setupCheckDigest: string;
}

/** Operator-declared cloud billing ceiling. Values are policy inputs, not provider invoices. */
export interface ExecutionTargetCostPolicy {
  currency: "USD";
  estimatedHourlyRateUsd: number;
  minimumBudgetUsd: number;
  maximumBudgetUsd: number;
}

/** Cross-process concurrency policy for one runner-owned cloud target. */
export interface ExecutionTargetAdmissionPolicy {
  maxConcurrentSessions: number;
  queue: "fifo";
}

export interface ExecutionTargetPolicy {
  cost: ExecutionTargetCostPolicy;
  admission: ExecutionTargetAdmissionPolicy;
}

/** Stable selection advertised by the control plane for a runner placement. */
export interface ExecutionTargetDefinition {
  id: string;
  runnerId: string;
  name: string;
  kind: ExecutionTargetKind;
  workspaceStrategy: ExecutionWorkspaceStrategy;
  adapter: "host" | "container" | "cloud";
  boundaries: ExecutionTargetBoundaries;
  environment?: ExecutionEnvironmentTemplateRef;
  /** Required for cloud targets; absent for host/container placements. */
  policy?: ExecutionTargetPolicy;
  /** Exact runner agent ids whose in-image commands were checked/configured for this target. */
  compatibleAgentIds?: string[];
  available: boolean;
  unavailableReason?: string;
}

/** Immutable placement captured on a session launch/snapshot. */
export type ExecutionTargetRef = Pick<
  ExecutionTargetDefinition,
  "id" | "runnerId" | "kind" | "workspaceStrategy" | "adapter" | "boundaries" | "environment" | "policy"
>;

/** Immutable workflow-artifact metadata carried into a cloud handoff. Artifact bytes remain in
 * the existing authorized artifact store; adapter access is an operator-owned integration. */
export interface ExecutionHandoffArtifactRef {
  artifactId: string;
  kind: WorkflowArtifactKind;
  sizeBytes: number;
  sha256: string;
}

/** Content-safe git provenance. Repository URLs, branch names, paths, and patch bytes are never
 * persisted or sent to the control plane; only exact object ids, counts, and digests cross. */
export interface ExecutionHandoffGitProvenance {
  headCommit: string;
  headTree: string;
  remoteUrlHash?: string;
  workingTreeDigest: string;
  dirty: boolean;
  untrackedFiles: number;
}

/** Runner-authored proof that a cloud adapter accepted one exact handoff manifest. The adapter's
 * private reconnect key is hashed here and remains plaintext only in runner-local session state. */
export interface ExecutionHandoffReceipt {
  targetId: string;
  sourceSessionId?: string;
  manifestDigest: string;
  adapterHandoffIdHash: string;
  git: ExecutionHandoffGitProvenance;
  artifacts: ExecutionHandoffArtifactRef[];
  budgetUsd: number;
  quotedCostUsd: number;
  acceptedAt: number;
}

/** Resolved handoff input sent CP -> runner. Artifact metadata is loaded from the authoritative
 * store before dispatch; the browser supplies ids only through CreateSessionRequest. */
export interface ExecutionHandoffRequest {
  sourceSessionId?: string;
  artifacts: ExecutionHandoffArtifactRef[];
}

export type RunnerProtocolCapability = keyof typeof RUNNER_CAPABILITY_MIN_PROTOCOL;

export function runnerSupportsProtocol(
  protocolVersion: number | null | undefined,
  capability: RunnerProtocolCapability,
): boolean {
  return Number.isInteger(protocolVersion) && protocolVersion! >= RUNNER_CAPABILITY_MIN_PROTOCOL[capability];
}

/** Preserve exact provider-authentication truth only when the receiving peer can validate the
 * additive error code. Older/unknown control planes still receive a terminal, understood code. */
export function providerAuthenticationReceiptCode(
  protocolVersion: number | null | undefined,
): "PROVIDER_AUTHENTICATION_REQUIRED" | "COMMAND_CANCELLED" {
  return runnerSupportsProtocol(protocolVersion, "providerAuthenticationReceipts")
    ? "PROVIDER_AUTHENTICATION_REQUIRED"
    : "COMMAND_CANCELLED";
}

/** Additive event kinds that have an explicit older-peer wire policy. Kinds absent from this
 * table are sent unchanged: an unreviewed event must fail closed at an older consumer rather than
 * being silently discarded. */
const SESSION_EVENT_WIRE_POLICIES = {
  agent_response_completed: { minProtocol: 87, legacy: "omit" },
} as const satisfies Partial<Record<SessionEventKind, {
  minProtocol: number;
  legacy: "omit";
}>>;

/** Whether this peer needs any explicit additive session-event compatibility projection.
 * Keeping policy inspection beside the policy table avoids callers probing it with a fabricated
 * payload and automatically covers future reviewed event policies. */
export function sessionEventWireProjectionRequiredForProtocol(
  protocolVersion: number | null | undefined,
): boolean {
  return Object.values(SESSION_EVENT_WIRE_POLICIES).some(
    (policy) => !Number.isInteger(protocolVersion) || protocolVersion! < policy.minProtocol,
  );
}

/** Project one exact runner-local event payload for the currently connected control plane.
 * `null` means that this explicitly reviewed event kind is safe to omit from the older peer's
 * dense wire history. Callers remain responsible for projecting its runner sequence. */
export function projectSessionEventPayloadForProtocol(
  payload: SessionEventPayload,
  protocolVersion: number | null | undefined,
): SessionEventPayload | null {
  const policy = SESSION_EVENT_WIRE_POLICIES[payload.kind as keyof typeof SESSION_EVENT_WIRE_POLICIES];
  if (policy && (!Number.isInteger(protocolVersion) || protocolVersion! < policy.minProtocol)) {
    if (policy.legacy === "omit") return null;
  }
  return payload;
}

/** Project additive receipt codes at the actual socket-send boundary. Keeping buffered messages
 * exact until then makes reconnecting to an older control plane safe. */
export function projectRunnerMessageForProtocol(
  message: RunnerToControlPlane,
  protocolVersion: number | null | undefined,
): RunnerToControlPlane {
  if (
    (message.type === "durable_session_command_result" ||
      message.type === "durable_session_command_update" ||
      message.type === "session_command_invocation_result" ||
      message.type === "session_command_invocation_update") &&
    message.code === "PROVIDER_AUTHENTICATION_REQUIRED"
  ) {
    return { ...message, code: providerAuthenticationReceiptCode(protocolVersion) };
  }
  return message;
}

/** Shared actionable copy for HTTP errors and disabled UI affordances. */
export function runnerCapabilityRequirement(
  protocolVersion: number | null | undefined,
  capability: RunnerProtocolCapability,
  label: string,
): string {
  const actual = Number.isInteger(protocolVersion)
    ? `is v${protocolVersion}`
    : "is unknown (pre-v15, malformed, or not reported)";
  return (
    `Runner protocol ${actual}; ${label} requires protocol v${RUNNER_CAPABILITY_MIN_PROTOCOL[capability]}. ` +
    "Update and restart the runner."
  );
}

export type OS = "windows" | "linux" | "macos";

/* ========================================================================== */
/* Runners, workspaces, agents                                                */
/* ========================================================================== */

/** How the runner drives an agent: ACP over stdio, or a native CLI harness. */
export type AgentDriverKind = "acp" | "claude-code" | "codex" | "codex-app-server";

/** Where the agent binary runs relative to the runner host. */
export type AgentContext = { kind: "native" } | { kind: "wsl"; distro: string };

export interface AgentModel {
  id: string;
  displayName?: string;
  default?: boolean;
  /** Hidden models remain addressable for persisted sessions but are omitted from pickers. */
  hidden?: boolean;
  description?: string;
  /** Input types advertised by the provider for this exact model. */
  inputModalities?: ("text" | "image")[];
  /** Reasoning-effort levels this specific model supports (codex is per-model). Absent/empty ⇒ use
   * the agent's `effortLevels`, or no effort knob at all. */
  efforts?: string[];
  /** The model's own default reasoning effort, if any. */
  defaultEffort?: string;
  /** Total context window (tokens) for this model, if known — powers the context-fill meter.
   * Curated per (driver, model); absent ⇒ the UI shows no fill %. */
  contextWindow?: number;
}

export interface AgentSlashCommand {
  name: string;
  source: "builtin" | "user" | "project" | "plugin";
  description?: string;
  /** Provider-authored argument usage, such as "<goal>" or "[on|off]". */
  argumentHint?: string;
  /** Runner-minted, session-scoped authority. Omission means display-only. Never synthesize this
   * from a command name, path, persisted catalog, or pre-v75 capability row. */
  invocation?: {
    id: string;
    catalogRevision: string;
    executionMode: SessionCommandExecutionMode;
  };
}

export type SessionCommandExecutionMode = "passthrough" | "structured";

/* --- Managed agent skills (control-plane-owned skill deployment, protocol v90) --- */

/** One file inside a managed skill, addressed by a validated POSIX-relative path. */
export interface SkillFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

/** Whether the deployed variant lets the model invoke the skill or reserves it for manual use. */
export type SkillInvocationPolicy = "agent" | "manual";

/** One exact runner agent that should receive a harness link for a skill. */
export interface SkillSyncTarget {
  agentId: string;
  invocation: SkillInvocationPolicy;
}

/** Complete desired deployment of one skill version on one machine. */
export interface SkillSyncEntry {
  /** Kebab-case directory name; must equal the SKILL.md frontmatter name. */
  name: string;
  /** sha256 hex of the canonical file manifest (see skillVersionDigest in skills-digest.ts). */
  versionDigest: string;
  files: SkillFile[];
  targets: SkillSyncTarget[];
}

export type SkillLinkStatus = "linked" | "conflict" | "unsupported" | "error";

/** Deployment outcome for one (skill, agent) harness link on the runner host. */
export interface SkillLinkState {
  agentId: string;
  status: SkillLinkStatus;
  /** Sanitized human-readable reason for a non-linked status. */
  detail?: string;
}

export interface DeployedSkillState {
  name: string;
  digest: string;
  links: SkillLinkState[];
  error?: string;
}

/** A skill found in a harness skill directory that the control plane does not manage. */
export interface UnmanagedSkillInfo {
  agentId: string;
  name: string;
  description?: string;
}

/** One managed skill link removed during a runner reconciliation pass. */
export interface SkillLinkRemoval {
  /** Home-relative display path; never an absolute host path. */
  path: string;
  /** Sanitized human-readable explanation of why the runner removed the link. */
  reason: string;
}

export const SKILL_MAX_FILES = 64;
export const SKILL_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const SKILL_MAX_FILE_BYTES = 512 * 1024;

/** A skill name is also its on-disk directory name: the leading character class rejects ".",
 * "..", and every hidden-file spelling, and the class as a whole rejects path separators. */
export function validSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

/** Validate a relative POSIX path inside a skill directory without ever allowing an absolute,
 * parent-relative, backslashed, or drive-lettered target. Unlike normalizeSourcePath this never
 * rewrites: the exact wire path participates in the version digest and must already be canonical. */
export function validSkillFilePath(p: string): boolean {
  if (!p || p.length > 256 || /[\0-\x1f\x7f]/.test(p) || p.includes("\\")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  const parts = p.split("/");
  if (parts.length > 8) return false;
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/** How an agent can deliver a permission decision for one permission mode. */
export type ElicitationTransport =
  | "stdio-control"
  | "hook"
  | "acp-permission"
  | "app-server"
  | "none";

/** What an agent can do — drives the model/effort/slash-command UI surfaces. */
export interface AgentCapabilities {
  models: AgentModel[];
  /** Where the current model metadata came from. Cached app-server fallback is labeled in the UI. */
  modelSource?: "live" | "cached";
  /** e.g. ["low","medium","high"]; empty when the agent has no effort knob. */
  effortLevels: string[];
  slashCommands: AgentSlashCommand[];
  supportsImages: boolean;
  supportsApprovals: boolean;
  /** Provider exposes a receipted primitive that incorporates input into the active turn. */
  supportsSteering?: boolean;
  /** Provider can mint an independent conversation from its current/history checkpoint. */
  supportsConversationFork?: boolean;
  /** Approval presets (claude: default|acceptEdits|plan|…; codex: untrusted|on-request|never). */
  permissionModes?: string[];
  /** How approvals reach the UI per permission mode. Absent = not probed (unknown, not false). */
  elicitation?: Partial<Record<string, ElicitationTransport[]>>;
}

/** Native drivers publish only session-scoped truth. Their catalog capabilities remain live runner
 * truth and must not be frozen into a long-lived session snapshot. An explicitly empty command
 * list is authoritative for that session; an absent field continues to inherit the catalog. */
export interface SessionCapabilityOverlay {
  elicitation?: NonNullable<AgentCapabilities["elicitation"]>;
  slashCommands?: AgentSlashCommand[];
  /** Runtime transport truth can be narrower than the discovered native agent catalog. */
  supportsSteering?: boolean;
}

export type SessionCapabilities = AgentCapabilities | SessionCapabilityOverlay;

/** Overlay session-scoped transport truth onto the current catalog. ACP snapshots carry a full
 * capability object and remain authoritative for their provider-native session controls. */
export function mergeSessionCapabilities(
  catalog: AgentCapabilities | undefined,
  session: SessionCapabilities | undefined,
): AgentCapabilities | undefined {
  if (!session) return catalog;
  if ("models" in session) return session;
  if (!catalog) return undefined;
  return {
    ...catalog,
    ...(Object.hasOwn(session, "elicitation") ? { elicitation: session.elicitation } : {}),
    ...(Object.hasOwn(session, "slashCommands") ? { slashCommands: session.slashCommands } : {}),
    ...(Object.hasOwn(session, "supportsSteering") ? { supportsSteering: session.supportsSteering } : {}),
  };
}

/** Rolling-upgrade-safe provider fork gate. Codex app-server shipped before the generic bit;
 * Claude must explicitly prove --fork-session through discovery. */
export function providerSupportsConversationFork(
  driver: AgentDriverKind,
  capabilities?: AgentCapabilities,
): boolean {
  return driver === "codex-app-server" ||
    (driver === "claude-code" && capabilities?.supportsConversationFork === true);
}

export type CodexAppServerFailureCode =
  | "codex_unavailable"
  | "version_unverified"
  | "probe_timeout"
  | "probe_failed"
  | "app_server_unavailable"
  | "contract_mismatch";

export interface CodexAppServerFailure {
  code: CodexAppServerFailureCode;
  /** Safe, bounded operator-facing detail. Never includes environment values or credentials. */
  message: string;
  retryable?: boolean;
}

/** Discovery result for the resolved Codex CLI launch in one runner context. */
export interface CodexAppServerCapabilities {
  status: "supported" | "unsupported" | "unavailable";
  installedVersion?: string;
  appServerAvailable: boolean;
  transport?: "stdio";
  /** How discovery established support. `help-and-version` is not a generated-schema check. */
  verification?: "help-and-version" | "generated-schema";
  /** Stable identifier for the pinned required-method contract used to interpret this result. */
  contractFingerprint?: string;
  /** Hash/fingerprint of a schema actually generated from this installation, when performed. */
  schemaFingerprint?: string;
  /** This installation satisfies the separately verified ephemeral, no-tool session-naming contract. */
  sessionNaming?: boolean;
  failure?: CodexAppServerFailure;
}

export type ClaudeCodeFailureCode =
  | "claude_unavailable"
  | "version_unverified"
  | "probe_timeout"
  | "probe_failed"
  | "unauthenticated"
  | "unsupported_mode";

export interface ClaudeCodeFailure {
  code: ClaudeCodeFailureCode;
  /** Safe, bounded operator-facing detail. Never includes command output, paths, or credentials. */
  message: string;
  retryable?: boolean;
}

export interface ClaudeCodeAuth {
  status: "authenticated" | "unauthenticated" | "unknown";
  /** Safe auth mechanism classification. Raw auth-status JSON is never persisted. */
  method?: "claude.ai" | "console" | "api_key" | "oauth_token" | "gateway" | "unknown";
  provider?: "firstParty" | "bedrock" | "vertex" | "gateway" | "unknown";
  billingSource: "subscription" | "api" | "bedrock" | "vertex" | "gateway" | "unknown";
  /** Bounded, non-secret plan label reported by `claude auth status` (for example, "max"). */
  subscriptionType?: string;
}

/** Discovery result for one resolved Claude Code CLI launch. */
export interface ClaudeCodeCapabilities {
  status: "ready" | "unauthenticated" | "unsupported" | "unavailable";
  installedVersion?: string;
  verification?: "version-help-auth-status";
  launchSource?: "path" | "common-dir" | "version-manager" | "login-shell";
  effortLevels: string[];
  permissionModes: string[];
  streamJsonInput: boolean;
  streamJsonImages: boolean;
  controlProtocol: boolean;
  forkSession: boolean;
  replayUserMessages: boolean;
  /** The installed CLI advertises every fail-closed flag required by runner-hosted title generation. */
  sessionNaming?: boolean;
  auth: ClaudeCodeAuth;
  failure?: ClaudeCodeFailure;
}

/** Resolved per-session knobs (model / reasoning effort / approval preset). */
export interface SessionConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Absolute accumulated-cost threshold (USD). A v47 runner cancels at the first observable
   * crossing; the control plane parks and asks. Older runners retain between-turn enforcement. */
  costBudgetUsd?: number;
  /** Absolute distinct-tool-call threshold. A v47 runner cancels at the first observable crossing;
   * the control plane parks and asks. Absent ⇒ unlimited; ≤0 in setConfig clears the limit. */
  maxToolCalls?: number;
}

/** A runner-local environment lookup. The referenced value is resolved only on the runner and is
 * never persisted by the control plane or included in diagnostics. */
export interface AcpEnvironmentReference {
  fromEnv: string;
}

export interface AcpMcpStdioServer {
  type: "stdio";
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, AcpEnvironmentReference>;
  disabled?: boolean;
}

export interface AcpMcpRemoteServer {
  type: "http" | "sse";
  name: string;
  url: string;
  headers?: Record<string, AcpEnvironmentReference>;
  disabled?: boolean;
}

/** Stable ACP MCP transports only. MCP-over-ACP is intentionally excluded because it is draft and
 * would multiplex MCP traffic onto the agent control socket. */
export type AcpMcpServerConfig = AcpMcpStdioServer | AcpMcpRemoteServer;

export type AcpRegistryDistributionKind = "binary" | "npx" | "uvx";

/** Content-free metadata copied from the stabilized ACP Registry v1. Registry manifests do not
 * advertise runtime capabilities or auth state; those fields intentionally remain live-probed. */
export interface AcpRegistryMetadata {
  id: string;
  schemaVersion: string;
  adapterVersion: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  transport: "stdio";
  distribution: AcpRegistryDistributionKind;
  /** Human-readable, shell-escaped preview only. Never executed without a separate approval. */
  installPreview: string;
  installStatus: "installed" | "approved" | "approval-required" | "manual-only" | "unsupported-platform";
  authentication: "required-live-verification";
}

/** Secret-free session context safe to persist. Later MCP entries replace earlier entries by name. */
export interface AcpSessionContextConfig {
  mcpServers?: AcpMcpServerConfig[];
  additionalDirectories?: string[];
}

/** A coding agent a runner can launch (advertised in runner metadata). */
export interface AgentDefinition {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Driver used to talk to this agent. Absent ⇒ "acp" (back-compat). */
  driver?: AgentDriverKind;
  /** Native vs WSL execution context. Absent ⇒ native. */
  context?: AgentContext;
  version?: string;
  available?: boolean;
  authStatus?: "authenticated" | "unauthenticated" | "unknown";
  /** Secret-free Codex billing boundary derived locally from configured auth or CLI account state. */
  codexBillingSource?: "api" | "provider_account";
  /** Runtime-negotiated ACP capabilities safe for presentation; absent for native/legacy agents. */
  acp?: AcpRuntimeCapabilities;
  capabilities?: AgentCapabilities;
  source?: "config" | "discovered" | "registry";
  /** Stabilized Registry launch/install metadata. Does not imply trust to execute or capability. */
  registry?: AcpRegistryMetadata;
  /** ACP transport owned by this runner. Direct remote transports are intentionally unsupported. */
  acpTransport?: "stdio";
  /** Codex-only rich-client compatibility result. Absent on pre-v27 runners and non-Codex agents. */
  codexAppServer?: CodexAppServerCapabilities;
  /** Claude-only launch-readiness result. Absent on pre-v30 runners and non-Claude agents. */
  claudeCode?: ClaudeCodeCapabilities;
  /** The logical binary name discovery resolved ("claude", "codex"). Launch-target identity for
   * config↔discovery merging: a version-manager install launches as `node <entry.js>` whose
   * entry file may be generically named (cli.js/index.js), so neither command nor args identify
   * the agent — this does. Absent on config entries and pre-v18 runners. */
  bin?: string;
}

/** Stable ACP capabilities observed from a live initialize handshake. Content-free and safe to
 * retain in runner/session metadata; never inferred from adapter identity. */
export interface AcpRuntimeCapabilities {
  logout: boolean;
  loadSession: boolean;
  sessionList: boolean;
  sessionDelete: boolean;
  sessionResume: boolean;
  sessionClose: boolean;
}

/** A repository/workspace a runner exposes. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  /** Operator-approved choices. A session must still explicitly select each directory. */
  additionalDirectoryGrants?: string[];
  /** Principal-visible ownership for explicit Location access controls. Older control planes omit it. */
  scope?: ResourceScope;
  /** Principal-specific authority to manage this Location's access. Older control planes omit it. */
  canManage?: boolean;
}

/** How a durable Project Location entered the control-plane catalog. */
export type ProjectLocationSource = "reported" | "managed" | "legacy";

/** Current launch availability for one exact Project Location. Cached metadata remains visible
 * when the backing runner or workspace is unavailable. */
export type ProjectLocationAvailability =
  | "available"
  | "runner_offline"
  | "workspace_missing"
  | "runner_removed";

/** One exact runner/workspace folder linked to a durable Project. Names and paths are display and
 * launch metadata only; the stable id, never a display name, is Location identity. */
export interface ProjectLocationView {
  id: string;
  projectId: string;
  runnerId: string;
  workspaceId: string;
  name: string;
  path: string;
  source: ProjectLocationSource;
  availability: ProjectLocationAvailability;
  isDefault: boolean;
  /** Principal-visible ownership for the backing Location. Older control planes omit it. */
  scope?: ResourceScope;
  /** Principal-specific authority to manage the backing Location. Older control planes omit it. */
  canManage?: boolean;
  /** Principal-scoped session totals for this exact Location. Older control planes may omit them. */
  activeSessionCount?: number;
  unarchivedSessionCount?: number;
  totalSessionCount?: number;
  createdAt: number;
  updatedAt: number;
}

/** Durable user-visible container for related sessions. A Project remains in this inventory when
 * it has no sessions or every Location is unavailable. */
export interface ProjectView {
  id: string;
  name: string;
  hidden: boolean;
  /** Ownership audience for user-facing sharing copy. Older control planes may omit it. */
  audience?: ResourceOwner["kind"];
  /** Exact ownership for explicit access controls. Older control planes may omit it. */
  scope?: ResourceScope;
  /** Principal-specific management authority. Older control planes may omit it. */
  canManage?: boolean;
  locations: ProjectLocationView[];
  activeSessionCount: number;
  unarchivedSessionCount: number;
  totalSessionCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Everything a runner advertises about itself on registration. */
/** A local editor/IDE CLI discovered on the runner host (for "Open in …"). */
export interface EditorInfo {
  /** Stable id = the CLI binary name ("code", "cursor", "zed", …). */
  id: string;
  /** Display name ("VS Code", "Cursor", …). */
  name: string;
  /** Precise locations this CLI can open in each runner execution context. Absent on pre-v59
   * runners and for editors whose location syntax has not been verified. */
  locations?: EditorLocationCapabilities;
}

export type EditorLocationPrecision = "file" | "line" | "column";

export interface EditorLocationCapabilities {
  native?: EditorLocationPrecision;
  wsl?: EditorLocationPrecision;
}

export interface SourceLocation {
  /** Canonical root-relative path using `/` separators. */
  path: string;
  /** One-based source coordinates. A column is valid only when a line is present. */
  line?: number;
  column?: number;
  /** Optional exact symbol/text locator for dashboard deep links. Editor CLIs receive resolved
   * line/column coordinates instead; no supported CLI is assumed to understand symbols. */
  symbol?: string;
}

export type EditorSourceLocation = Omit<SourceLocation, "symbol">;

export const SOURCE_LOCATION_MAX_PATH_LENGTH = 4096;
export const SOURCE_LOCATION_MAX_SYMBOL_LENGTH = 256;
export const SOURCE_LOCATION_MAX_COORDINATE = 10_000_000;

/** Normalize a source path without ever allowing an absolute or parent-relative target. */
export function normalizeSourcePath(path: string): string | null {
  if (!path || path.length > SOURCE_LOCATION_MAX_PATH_LENGTH || /[\0-\x1f\x7f]/.test(path)) return null;
  const slashed = path.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts = slashed.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return null;
  const normalized = parts.join("/");
  return normalized.length <= SOURCE_LOCATION_MAX_PATH_LENGTH ? normalized : null;
}

/** Strict untrusted-boundary parser shared by the control plane, runner, and URL router. */
export function parseSourceLocation(value: unknown, allowSymbol = true): SourceLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = allowSymbol ? new Set(["path", "line", "column", "symbol"]) : new Set(["path", "line", "column"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (!Object.hasOwn(record, "path") || typeof record.path !== "string") return null;
  const path = normalizeSourcePath(record.path);
  if (!path) return null;
  const coordinate = (entry: unknown): number | undefined | null => {
    if (entry === undefined) return undefined;
    return Number.isSafeInteger(entry) && (entry as number) >= 1 && (entry as number) <= SOURCE_LOCATION_MAX_COORDINATE
      ? entry as number
      : null;
  };
  const line = coordinate(Object.hasOwn(record, "line") ? record.line : undefined);
  const column = coordinate(Object.hasOwn(record, "column") ? record.column : undefined);
  if (line === null || column === null || (column !== undefined && line === undefined)) return null;
  let symbol: string | undefined;
  if (allowSymbol && Object.hasOwn(record, "symbol")) {
    if (typeof record.symbol !== "string" || !record.symbol.trim() ||
        record.symbol.length > SOURCE_LOCATION_MAX_SYMBOL_LENGTH || /[\0-\x1f\x7f]/.test(record.symbol)) return null;
    symbol = record.symbol;
  }
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(symbol === undefined ? {} : { symbol }),
  };
}

export interface RunnerMetadata {
  runnerId: string;
  hostname: string;
  os: OS;
  version: string;
  agents: AgentDefinition[];
  workspaces: WorkspaceInfo[];
  /** Editors found on the host (discovery fills this; absent on pre-v22 runners). */
  editors?: EditorInfo[];
  runtime?: RunnerRuntimeInfo;
  /** Protocol v61+ runner-checked non-host targets. The control plane validates and persists only
   * exact runner-owned container/cloud definitions here; host targets remain topology-derived. */
  executionTargets?: ExecutionTargetDefinition[];
  /** Protocol v94+ secret-free restart reconciliation for the runner-local naming endpoint. */
  sessionNamingCustomModel?: {
    configured: boolean;
    apiKeyConfigured: boolean;
    /** SHA-256 of canonical endpoint/model/timeout configuration. Never includes the API key. */
    configDigest?: string;
  };
}

export interface RunnerRuntimeInfo {
  /** Native-host runner data root. WSL contexts use the same `.agent-manager` layout in-distro. */
  dataDir: string;
  worktreeRoot: string;
  maxConcurrentSessions: number;
  /** Exact agent-id policy. Missing maps preserve the v32 behavior: no provider quota, weight 1. */
  admission?: {
    agentLimits: Record<string, number>;
    agentWeights: Record<string, number>;
  };
  executionIsolation?: {
    mode: "provider" | "bwrap" | "seatbelt" | "windows-job";
    network: "inherit" | "deny";
    providerStateRetentionDays?: number;
    providerStateMaxBytes?: number;
  };
}

export type RunnerStatus = "online" | "offline";

/** Denormalised runner record as the UI consumes it (REST + WS). */
export interface RunnerView {
  runnerId: string;
  /** Principal-visible Machine ownership used to constrain new Location access. */
  scope?: ResourceScope;
  /** User-owned Machine name. Falls back to hostname/runner id when absent. */
  displayName?: string;
  hostname: string;
  os: OS;
  version: string;
  status: RunnerStatus;
  agents: AgentDefinition[];
  workspaces: WorkspaceInfo[];
  /** Editors found on the host (for "Open in …"); absent/empty hides the control. */
  editors?: EditorInfo[];
  runtime?: RunnerRuntimeInfo;
  /** Protocol v60 projection. Placement is separate from the agent definitions above. */
  executionTargets?: ExecutionTargetDefinition[];
  connectedAt: number | null;
  lastSeen: number | null;
  /** PROTOCOL_VERSION the runner registered with. null/absent ⇒ unknown (a pre-v15 runner, or a
   * dashboard row last written by an older control plane) — the UI shows nothing rather than guess. */
  protocolVersion?: number | null;
  /** True once the runner has pushed a discovery result (agents_updated) since its last register.
   * Distinguishes "no agent CLIs installed" from "discovery still probing" when `agents` is empty. */
  agentsRefreshed?: boolean;
}

/** Hash-only control-plane record for one runner registration credential. Plaintext is returned
 * exactly once by create/rotate responses and is never part of this reusable view. */
export interface RunnerCredentialView {
  credentialId: string;
  runnerId: string;
  organizationId: string;
  scope: ResourceScope;
  label: string;
  status: "pending" | "active" | "revoked";
  createdAt: number;
  expiresAt: number | null;
  activatedAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  legacy: boolean;
}

export interface RunnerCredentialSecret {
  credential: RunnerCredentialView;
  token: string;
}

/**
 * Everything the UI needs to walk a user through connecting a new runner — the
 * control plane's runner WebSocket URL and LAN IP candidates so a remote machine can
 * reach a control plane bound to a non-loopback address. Credentials are issued only
 * after the user chooses an exact runner id and are never carried by this DTO.
 */
export interface OnboardingInfo {
  /** ws URL a runner registers against, using the control plane's bound host. */
  runnerWsUrl: string;
  /** The control plane's bound host and port. */
  host: string;
  port: number;
  /** Non-internal IPv4 addresses of this machine, for remote/LAN onboarding. */
  lanIps: string[];
  /** Existing runner ids, so the UI can suggest a non-colliding one. */
  existingRunnerIds: string[];
}

/* ========================================================================== */
/* Boxes (remote machines reached over SSH)                                    */
/* ========================================================================== */

export type BoxStatus = "bootstrapping" | "deploying" | "online" | "offline" | "failed";

/**
 * A remote machine the dashboard reaches over SSH and bootstraps a runner on. A box is just
 * a normal runner plus a persisted SSH config: once its runner registers (through the reverse
 * tunnel) it appears in the runner list under `runnerId`, so the UI correlates the two by id.
 */
export interface BoxView {
  boxId: string;
  /** User-owned Machine name shared with the correlated runner. */
  displayName?: string;
  /** SSH target, e.g. `user@host`. */
  sshTarget: string;
  /** Runner id the orchestrator launches the box's runner with. */
  runnerId: string;
  status: BoxStatus;
  /** Last bootstrap/connection error, if any. */
  lastError: string | null;
  createdAt: number;
  /** Content hash (sha256[:16]) of the runner binary last deployed to this box; null before the
   * first deploy. Compared by CONTENT (not --version) — see box-orchestrator.binaryIsCurrent. */
  deployedVersion?: string | null;
  /** Target triple detected on first bootstrap (e.g. `aarch64-unknown-linux-gnu`); tells the user
   * WHICH runner binary to rebuild when the dashboard can't resolve a fresh one. */
  triple?: string | null;
  /** Server-managed runner state layout. Legacy roots require explicit adoption before upgrade. */
  runnerDataLayout?: "legacy" | "isolated-v1";
  /** Content-free projection of the latest explicit legacy-data adoption authorization. */
  legacyDataAdoption?: {
    status: "pending" | "completed";
    authorizedAt: number;
    completedAt?: number;
  } | null;
  /** Bounded account-level state shared by every legacy box with the same SSH target and port. */
  legacyDataAccountStatus?: "unclaimed" | "pending" | "adopted";
}

/* ========================================================================== */
/* Devices (revocable client credentials for the REST + /ui surface)         */
/* ========================================================================== */

/** A paired device: holds a bearer token for REST + /ui access. The token itself
 * is returned exactly once by the pairing endpoint and stored hashed server-side. */
export interface DeviceView {
  deviceId: string;
  /** User-chosen label, e.g. "Pixel 9" — pairing is per-device, revocation is per-device. */
  name: string;
  createdAt: number;
  /** Last authenticated request (minute-granular), or null if never used. */
  lastSeenAt: number | null;
  /** Human identity and organization this credential is scoped to. */
  userId: string;
  userName: string;
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
}

export type OrganizationRole = "owner" | "admin" | "operator" | "viewer";
export type UserStatus = "active" | "suspended";

export interface OrganizationView {
  organizationId: string;
  name: string;
  createdAt: number;
}

export interface OrganizationMembershipView {
  organizationId: string;
  organizationName: string;
  userId: string;
  userName: string;
  userStatus: UserStatus;
  role: OrganizationRole;
  createdAt: number;
}

export interface TeamView {
  teamId: string;
  organizationId: string;
  name: string;
  memberUserIds: string[];
  createdAt: number;
}

export interface IdentityContextView {
  userId: string;
  userName: string;
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  deviceId: string | null;
  localBootstrap: boolean;
}

export interface IdentityAdministrationView {
  context: IdentityContextView;
  organizations: OrganizationView[];
  memberships: OrganizationMembershipView[];
  teams: TeamView[];
}

export interface MutationAuditView {
  auditId: string;
  actorKind: "human" | "agent" | "anonymous";
  actorId?: string;
  userId?: string;
  deviceId?: string;
  organizationId?: string;
  method: string;
  route: string;
  targetId?: string;
  statusCode: number;
  createdAt: number;
}

export type ResourceOwner =
  | { kind: "organization"; organizationId: string }
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string };

export interface ResourceScope {
  organizationId: string;
  owner: ResourceOwner;
}

/** Every principal who can see the narrower scope must also be able to see the wider scope.
 * Considers only the scope values, never team membership: the control plane widens this with a
 * membership lookup server-side, and the web client mirrors it for preflight presentation only. */
export function scopeAudienceContained(narrower: ResourceScope, wider: ResourceScope): boolean {
  if (narrower.organizationId !== wider.organizationId) return false;
  if (wider.owner.kind === "organization") return true;
  if (narrower.owner.kind !== wider.owner.kind) return false;
  if (narrower.owner.kind === "user" && wider.owner.kind === "user") {
    return narrower.owner.userId === wider.owner.userId;
  }
  return narrower.owner.kind === "team" && wider.owner.kind === "team" &&
    narrower.owner.teamId === wider.owner.teamId;
}

/* ========================================================================== */
/* Sessions                                                                   */
/* ========================================================================== */

/**
 * Session lifecycle. Drives the Kanban board columns and card chrome.
 *   queued        - created, runner has not started it yet
 *   starting      - process spawning + ACP initializing
 *   running       - a prompt turn is in progress (agent is working)
 *   input_required - blocked on the user (permission approval or follow-up)
 *   idle          - agent finished a turn, ready for the next prompt
 *   completed     - session ended normally
 *   failed        - process/ACP error or crash
 *   stopped       - user stopped it
 */
export type SessionStatus =
  | "queued"
  | "starting"
  | "running"
  | "input_required"
  | "idle"
  | "completed"
  | "failed"
  | "stopped";

/** Server-owned archive lifecycle. An active archive request stays visible until the runner
 * proves that its provider process is terminal or absent. Omitted means no archive operation is
 * pending (including older control planes). */
export type ArchiveStatus = "stop_pending" | "stop_failed";

export type ArchiveStopFailureCode = "timeout" | "retry_exhausted" | "runner_rejected";

/** Structured, server-owned Stop operation. Failure never proves that runtime capacity was
 * released, and the operation identity remains stable across idempotent retries. */
export interface StopOperationView {
  operationId: string;
  status: ArchiveStatus;
  requestedAt: number;
  /** Time of the latest distinct delivery-correlation boundary. Rewriting the same pending attempt
   * during reconnect does not advance it. A v89+ recovery boundary is logically ordered after its
   * timeout or retry-exhaustion failure, so after wall-clock rollback this value may be normalized
   * just beyond the failure timestamp rather than record the current wall time. */
  lastAttemptAt: number;
  /** Number of distinct delivery-correlation boundaries in the current explicit recovery window.
   * This includes v89+ automatic recovery replays made while a recoverable failure stays visible. */
  attemptCount: number;
  /** When the runner accepted the current delivery attempt. Acceptance starts a bounded
   * completion window but is not evidence that runtime capacity was released. */
  acceptedAt?: number;
  capacityReleased: false;
  failure?: {
    code: ArchiveStopFailureCode;
    message: string;
    failedAt: number;
  };
}

/** Compatibility name retained for clients that consume archive-specific Stop state. */
export type ArchiveOperationView = StopOperationView;

/** Archive must release runtime capacity for every non-terminal provider lifecycle. Idle is
 * intentionally included: it can retain a resident provider process and runner/target leases. */
export function archiveRequiresStop(status: SessionStatus): boolean {
  return !isTerminal(status);
}

/** Kanban board columns. A session's column is derived from status unless the
 * user has manually filed it (e.g. moved to "review" or archived). */
export type BoardColumn = "queued" | "running" | "input_required" | "review" | "done";

export const BOARD_COLUMNS: { id: BoardColumn; title: string }[] = [
  { id: "queued", title: "Queued" },
  { id: "running", title: "Running" },
  { id: "input_required", title: "Needs Input" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

/** Default column for a status (used when a session is not manually filed). */
export function columnForStatus(status: SessionStatus): BoardColumn {
  switch (status) {
    case "queued":
      return "queued";
    case "starting":
    case "running":
      return "running";
    case "input_required":
      return "input_required";
    case "idle":
      return "review";
    case "completed":
    case "failed":
    case "stopped":
      return "done";
  }
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** Optional bounded explanation, used by authentication-method choices. */
  description?: string;
  /** ACP option kind, e.g. allow_once / allow_always / reject_once / reject_always */
  kind?: string;
}

/** Bounded lifecycle reason shared by question and permission history. The selected option and
 * answered flag retain provider-neutral decision detail; this field explains how the ask ended. */
export type StructuredRequestResolutionReason =
  | "submitted"
  | "dismissed"
  | "replaced"
  | "provider_resolved";

/** Bounded rendering of WHAT is being approved (tool name + its input) — the trust surface:
 * an Allow button without the command/diff it authorizes defeats confirm-before-apply. */
export interface ApprovalContext {
  toolName?: string;
  /** Human-readable input rendering (command text, file path + content excerpt, JSON), bounded
   * by the emitter — never the raw multi-MB payload. */
  input?: string;
  /** Normalized, bounded resource selectors asserted by the authenticated runner. The control
   * plane parses path/network structure before matching; it does not independently inspect the
   * runner's filesystem or DNS. Auto-allow policies cannot depend on asserted escalation state. */
  path?: string;
  network?: string;
  branch?: string;
  /** Reviewer that escalated this action to a human. Absent for direct/manual approval modes. */
  escalatedBy?: GovernanceReviewer;
}

/** Content-minimized request emitted by the runner's per-session Claude hook sidecar. Raw tool
 * input and transcript paths never cross this boundary. */
export type ClaudeHookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";
export interface PolicyHookEvaluationRequest {
  hookEventName: ClaudeHookEventName;
  providerSessionId: string;
  permissionMode?: string;
  toolUseId?: string;
  context?: Pick<ApprovalContext, "toolName" | "path" | "network" | "branch">;
  /** Present only on the first half-open request after a local circuit cooldown. */
  transportRecoveredFrom?: number;
  /** Returned by an earlier `ask`. The same hook invocation polls with this id until terminal. */
  approvalRequestId?: string;
}

/** Rolling-compatible HTTP proof that the exact launched hook can poll a durable ask. Kept out of
 * the JSON envelope because a v65 control plane rejects unknown body fields during rollback. */
export const LEGACY_POLICY_HOOK_POLL_CAPABILITY_HEADER = "x-mam-hook-poll-capability" as const;
export const WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER = "x-wollipog-hook-poll-capability" as const;
export const POLICY_HOOK_POLL_CAPABILITY_HEADER = WOLLIPOG_POLICY_HOOK_POLL_CAPABILITY_HEADER;
export const POLICY_HOOK_POLL_CAPABILITY = "same-invocation-v1";

/** A missing policy defers to Claude's native permission behavior; it is not an implicit allow. */
export type PolicyHookDecision = GovernancePolicyEffect | "defer" | "provider_ask";

/** Phase 4 `ask` responses park the same hook invocation on a durable CP-owned decision. */
export interface PolicyHookEvaluationResponse {
  decision: PolicyHookDecision;
  reason?: string;
  approvalRequestId?: string;
  retryAfterMs?: number;
  expiresAt?: number;
}

/** User attention is orthogonal to lifecycle: a paused turn may need an answer, authentication,
 * or approval, while an older runner may expose only the undifferentiated input_required state. */
export type SessionAttentionKind =
  | "approval_required"
  | "answer_required"
  | "authentication_required"
  | "review_requested"
  | "input_required";

export interface SessionAttentionStatus {
  kind: SessionAttentionKind;
  label: string;
  description: string;
}

/** Canonical, compatibility-safe projection of the concrete action a person must take. */
export function sessionAttentionStatus(
  session: Pick<SessionView, "status" | "pendingApproval">,
): SessionAttentionStatus | null {
  const pending = session.pendingApproval;
  if (pending?.kind === "question") {
    return {
      kind: "answer_required",
      label: "Answer Required",
      description: "The agent asked a question and is waiting for an answer.",
    };
  }
  if (pending?.kind === "authentication") {
    return {
      kind: "authentication_required",
      label: "Authentication Required",
      description: "The agent is waiting for authentication.",
    };
  }
  if (pending) {
    return {
      kind: "approval_required",
      label: "Approval Required",
      description: "The agent is waiting for an approval decision.",
    };
  }
  if (session.status === "input_required") {
    return {
      kind: "input_required",
      label: "Input Required",
      description: "This session needs user input, but an older or incomplete update did not identify the action.",
    };
  }
  return null;
}

/** One option in a structured agent question. The normalized contract preserves provider-native
 * labels and descriptions without exposing provider-specific wire shapes to the UI. */
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  /** Provider-supplied context for this question. */
  context?: string;
  /** Opaque answer key. For native Claude this is the question TEXT (the SDK looks answers up
   * by text) — the UI must treat it as opaque and key answers by it verbatim. */
  id: string;
  /** Short chip label, e.g. "Language". */
  header?: string;
  question: string;
  /** Multi-select answers contain offered labels only. This is mutually exclusive with
   * `allowOther`; custom values have no unambiguous array representation on the normalized wire. */
  multiSelect?: boolean;
  options: QuestionOption[];
  /** Whether the provider accepts a free-form string instead of one of options[]. Mutually
   * exclusive with `multiSelect`; producers must reject that unsupported combination. */
  allowOther?: boolean;
  /** Optional provider form fields may be omitted. Absence keeps the legacy required behavior. */
  required?: boolean;
  /** Render free-form input without echoing its value on screen. Answers remain transient. */
  secret?: boolean;
  /** Provider primitive expected for free-form input. Values cross the normalized boundary as
   * strings and the owning driver converts them back to its native wire type. */
  inputFormat?: "text" | "email" | "url" | "date" | "date-time" | "number" | "integer";
  minLength?: number;
  /** Absent means the provider declared no bound; validators fall back to
   * DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH rather than accepting an unbounded answer. */
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minSelections?: number;
  maxSelections?: number;
}

export function isSupportedAgentQuestion(question: AgentQuestion): boolean {
  return !(question.multiSelect === true && question.allowOther === true);
}

/** Upper bound applied to any provider free-text answer that declares no `maxLength`. Providers
 * are not obliged to bound their own fields, and an unbounded answer rides verbatim into the
 * provider response and the durable event log, so the shared validators impose this default. */
export const DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH = 4000;

/** Validate one provider-declared free-text value. Shared by the UI's submit gate and the
 * control plane's authoritative answer validation so both layers enforce the same constraints. */
export function validateQuestionFreeText(question: AgentQuestion, value: string): string | null {
  if (!value.length) return "expects a non-empty response";
  if (question.minLength != null && value.length < question.minLength) {
    return `expects at least ${question.minLength} character(s)`;
  }
  const maxLength = question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH;
  if (value.length > maxLength) {
    return `expects at most ${maxLength} character(s)`;
  }
  if (question.inputFormat === "number" || question.inputFormat === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (question.inputFormat === "integer" && !Number.isInteger(parsed))) {
      return `expects a valid ${question.inputFormat}`;
    }
    if (question.minimum != null && parsed < question.minimum) return "is below its minimum";
    if (question.maximum != null && parsed > question.maximum) return "is above its maximum";
  }
  if (question.inputFormat === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "expects a valid email address";
  }
  if (question.inputFormat === "url" && !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value)) {
    return "expects a valid URI";
  }
  if (question.inputFormat === "date" && !isValidDate(value)) return "expects a valid date";
  if (
    question.inputFormat === "date-time" &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !isValidDate(value.slice(0, 10)) || Number.isNaN(Date.parse(value)))
  ) {
    return "expects a valid date and time";
  }
  return null;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/**
 * Validate a submitted answer map against the questions it answers. Returns null when valid,
 * else a human-readable reason. An EMPTY map is valid: legacy callers use it for dismissal,
 * while an explicit submit action may accept an all-optional form. Guards the /answer route:
 * answers ride verbatim into the agent's updatedInput, so unknown keys, wrong shapes
 * (array for single-select), or labels that were never offered must be rejected server-side.
 */
export function validateQuestionAnswers(
  questions: AgentQuestion[],
  answers: Record<string, string | string[]>,
  action?: "submit" | "dismiss",
): string | null {
  const keys = Object.keys(answers);
  if (action === "dismiss" && keys.length > 0) return "a dismissal cannot include answers";
  if (keys.length === 0 && action !== "submit") return null; // legacy or explicit dismiss
  const unsupported = questions.find((question) => !isSupportedAgentQuestion(question));
  if (unsupported) return `"${unsupported.id.slice(0, 80)}" cannot combine multi-select and Other responses`;
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const key of keys) {
    const q = byId.get(key);
    if (!q) return `unknown question: ${key.slice(0, 80)}`;
    const value = answers[key];
    const offered = new Set(q.options.map((o) => o.label));
    if (q.multiSelect) {
      if (!Array.isArray(value)) {
        return `"${q.id.slice(0, 80)}" expects an array of labels`;
      }
      if (value.some((v) => typeof v !== "string" || !offered.has(v))) {
        return `"${q.id.slice(0, 80)}" got a label that was not offered`;
      }
      if (new Set(value).size !== value.length) {
        return `"${q.id.slice(0, 80)}" got duplicate labels`;
      }
      const minimum = q.minSelections ?? (q.required === false ? 0 : 1);
      if (value.length < minimum) return `"${q.id.slice(0, 80)}" expects at least ${minimum} selection(s)`;
      if (q.maxSelections != null && value.length > q.maxSelections) {
        return `"${q.id.slice(0, 80)}" expects at most ${q.maxSelections} selection(s)`;
      }
    } else {
      if (typeof value !== "string") return `"${q.id.slice(0, 80)}" expects one offered label`;
      if (!offered.has(value) && !q.allowOther) {
        return `"${q.id.slice(0, 80)}" expects one offered label`;
      }
      if (!offered.has(value)) {
        const freeTextError = validateQuestionFreeText(q, value);
        if (freeTextError) return `"${q.id.slice(0, 80)}" ${freeTextError}`;
      }
    }
  }
  for (const q of questions) {
    // Object.hasOwn, not `in`: question ids come from agent-controlled text, and an id like
    // "constructor" would satisfy an `in` check via the prototype chain — passing validation
    // with no actual answer for that question.
    if (q.required !== false && !Object.hasOwn(answers, q.id)) return `missing answer for: ${q.id.slice(0, 80)}`;
  }
  return null;
}

export type ApprovalKind =
  | "permission"
  | "authentication"
  | "cost_budget"
  | "max_tool_calls"
  | "policy_hook"
  | "question";

export interface PendingApproval {
  requestId: string;
  title: string;
  options: PermissionOption[];
  /** What raised this approval. "permission" = a runner-side tool/permission request (default);
   * "authentication" = a runner-side agent sign-in method choice;
   * "cost_budget" / "max_tool_calls" = control-plane guardrail pauses (resolved CP-side, no
   * runner round-trip); "question" = a structured agent question (answered via answer_question;
   * options[] unused — see questions). */
  kind?: ApprovalKind;
  /** The structured questions when kind === "question". */
  questions?: AgentQuestion[];
  /** What is being approved, when the driver can say (kind "permission"). */
  context?: ApprovalContext;
  /** Content-safe provenance for a CP-owned Claude hook ask. */
  governancePolicyId?: string;
  /** Absolute deadline for a policy hook ask. Absence means wait indefinitely. */
  expiresAt?: number;
}

export type GovernanceActorKind = "human" | "agent" | "policy" | "system";
export interface GovernanceActor {
  kind: GovernanceActorKind;
  /** Opaque paired-device, agent, rule, or system identifier. Never a bearer token or user secret. */
  id?: string;
}

/** Automated reviewer identity. Human decisions are recorded separately as approval resolutions. */
export interface GovernanceReviewer extends GovernanceActor {
  kind: "agent" | "policy";
}

export interface GovernanceScope {
  sessionId: string;
  runnerId: string;
  organizationId?: string;
  workspaceId?: string;
  agentId?: string;
  toolName?: string;
  path?: string;
  network?: string;
  branch?: string;
}

/** Optional selectors on a stored approval policy. Every populated selector must match. `*` is
 * the only wildcard and matches within the bounded field; otherwise matching is exact. */
export interface GovernancePolicyScope {
  organizationId?: string;
  runnerId?: string;
  workspaceId?: string;
  agentId?: string;
  toolName?: string;
  path?: string;
  network?: string;
  branch?: string;
}

/** Stateful predicates evaluated from the authoritative session view at request time. */
export interface GovernancePolicyConditions {
  statuses?: SessionStatus[];
  minCostUsd?: number;
  maxCostUsd?: number;
  minToolCalls?: number;
  maxToolCalls?: number;
  escalated?: boolean;
}

export type GovernancePolicyEffect = "allow" | "deny" | "ask";
export interface GovernancePolicy {
  policyId: string;
  name: string;
  effect: GovernancePolicyEffect;
  priority: number;
  enabled: boolean;
  scope: GovernancePolicyScope;
  conditions?: GovernancePolicyConditions;
  /** Seconds a hook-backed `ask` may wait. Absence means wait indefinitely. */
  askTimeout?: number;
  /** Built-ins are code-owned safety invariants and cannot be mutated through the API. */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type GovernanceAuditStage = "request" | "review" | "policy_decision" | "resolution";
export type GovernanceAuditOutcome =
  | "pending"
  | "asked"
  | "allowed"
  | "denied"
  | "dismissed"
  | "answered"
  | "delivery_failed"
  | "escalated"
  | "timed_out"
  | "aborted";

export type ReviewDecisionOutcome = "allowed" | "denied" | "escalated" | "timed_out" | "aborted";
export type ReviewRiskLevel = "low" | "medium" | "high";

/** Provider-neutral terminal decision from an automated reviewer. Rationale is bounded by the
 * emitter for the visible transcript; the governance audit stores only its SHA-256 digest. */
export interface ReviewDecision {
  reviewId: string;
  reviewer: GovernanceReviewer;
  outcome: ReviewDecisionOutcome;
  riskLevel?: ReviewRiskLevel;
  rationale?: string;
  /** Provider approval/request id when the review can be correlated to one. */
  requestId?: string;
}

/** Durable content-safe approval provenance. Raw tool input and question answers are never stored. */
export interface GovernanceAuditEntry {
  auditId: string;
  requestId: string;
  approvalKind: ApprovalKind;
  stage: GovernanceAuditStage;
  outcome: GovernanceAuditOutcome;
  actor: GovernanceActor;
  scope: GovernanceScope;
  /** SHA-256 of bounded request context/answers when present; supports correlation without content. */
  contentDigest?: string;
  /** The triggering CP policy rule, present only for policy_decision records. */
  policyRule?: PolicyRule;
  /** Stored or built-in declarative policy responsible for this decision. */
  governancePolicyId?: string;
  /** Selected opaque option id. Names/descriptions are not duplicated into the audit log. */
  optionId?: string;
  timestamp: number;
}

export interface ApprovalQueueProvenance {
  source: "audit" | "session";
  requestedAt: number;
  actor: GovernanceActor;
  scope: GovernanceScope;
  auditId?: string;
  contentDigest?: string;
  governancePolicyId?: string;
}

/** Cross-session pending-approval inbox. Identity is the stale-safe (sessionId, requestId) pair. */
export interface ApprovalQueueItem {
  sessionId: string;
  requestId: string;
  sessionTitle: string;
  runnerId: string;
  runnerOnline: boolean;
  workspaceId?: string;
  agentId?: string;
  agentName?: string;
  approval: PendingApproval;
  provenance: ApprovalQueueProvenance;
  /** Bulk allow is intentionally absent; rejection/dismissal is the only bulk-safe mutation. */
  bulkActions: ["reject"];
}

export interface ApprovalQueueRejectRequest {
  items: Array<{ sessionId: string; requestId: string }>;
}

export interface ApprovalQueueRejectResult {
  sessionId: string;
  requestId: string;
  ok: boolean;
  status: number;
  error?: string;
}

/* -------------------------- Inline code review -------------------------- */

export type ReviewFindingSeverity = "blocker" | "major" | "minor" | "nit";
export type ReviewFindingStatus = "open" | "sent" | "resolved" | "dismissed";
export type ReviewFindingSide = "left" | "right";
export type ReviewFindingSource = "local" | "github";

/** Durable line-anchored review feedback. `diffHash` makes a comment's source snapshot explicit;
 * comments whose hash no longer matches the visible diff remain in the findings list as stale
 * instead of being silently attached to a different line. */
export interface ReviewFinding {
  findingId: string;
  sessionId: string;
  scope: GitDiffScope;
  diffHash: string;
  filePath: string;
  side: ReviewFindingSide;
  line: number;
  body: string;
  severity: ReviewFindingSeverity;
  /** Required unresolved findings block review completion and publish readiness. */
  required: boolean;
  status: ReviewFindingStatus;
  source: ReviewFindingSource;
  author: GovernanceActor;
  createdAt: number;
  updatedAt: number;
  sentAt?: number;
  resolvedAt?: number;
  resolvedBy?: GovernanceActor;
  /** Present only for findings reconciled from an external review system. Remote-owned findings
   * are read-only locally; another sync is the authority for status/body changes. */
  remote?: ReviewFindingRemote;
}

export interface ReviewFindingRemote {
  provider: "github";
  repository: string;
  pullRequestNumber: number;
  threadId: string;
  commentId: number;
  url: string;
  commitId: string;
  outdated: boolean;
  subjectType: "line" | "file";
  synchronizedAt: number;
}

export interface ReviewFindingSummary {
  total: number;
  unresolved: number;
  requiredUnresolved: number;
  sent: number;
  resolved: number;
  dismissed: number;
  completion: "blocked" | "in_review" | "complete";
}

export interface CreateReviewFindingRequest {
  scope: GitDiffScope;
  diffHash: string;
  filePath: string;
  side: ReviewFindingSide;
  line: number;
  body: string;
  severity: ReviewFindingSeverity;
  required: boolean;
}

/** `expectedUpdatedAt` is the finding revision: mutations fail with 409 after another reviewer
 * changes the same finding, preventing a stale tab from overwriting newer triage. */
export interface UpdateReviewFindingRequest {
  status: "open" | "resolved" | "dismissed";
  expectedUpdatedAt: number;
}

export interface BundleReviewFindingsRequest {
  findings: Array<{ findingId: string; expectedUpdatedAt: number }>;
}

export interface ReviewFindingsResponse {
  findings: ReviewFinding[];
  summary: ReviewFindingSummary;
}


/* --- Guardrails (CP policy cards plus protocol-v47 runner-side mid-turn enforcement) --- */

/** A per-session rule evaluated by the control plane for the durable approval card. Protocol-v47
 * runners additionally cancel at the first normalized threshold event, then settle idle so this
 * policy engine can park the session. */
export type PolicyRule =
  | { kind: "cost_budget"; budgetUsd: number }
  | { kind: "max_tool_calls"; maxCalls: number };

export type PolicyRuleKind = PolicyRule["kind"];

/** The CP card decision remains "ok" or "ask"; active cancellation is runner-owned. */
export interface PolicyDecision {
  rule: PolicyRule;
  decision: "ok" | "ask";
  /** Approval-card copy when decision === "ask". */
  title?: string;
}

export const GUARDRAIL_APPROVAL_KINDS = ["cost_budget", "max_tool_calls"] as const;
export const POLICY_APPROVAL_KINDS = [...GUARDRAIL_APPROVAL_KINDS, "policy_hook"] as const;

/** True for approvals the CONTROL PLANE owns. The card survives runner snapshots; v47 Continue
 * sends only the next threshold, never a provider permission response. */
export function isPolicyApproval(a: PendingApproval | null | undefined): boolean {
  return a?.kind != null && (POLICY_APPROVAL_KINDS as readonly string[]).includes(a.kind);
}

export function isGuardrailApproval(a: PendingApproval | null | undefined): boolean {
  return a?.kind != null && (GUARDRAIL_APPROVAL_KINDS as readonly string[]).includes(a.kind);
}

/** An image attached to a prompt (pasted screenshot, etc.). Maps to an ACP
 * `image` ContentBlock. `data` is base64 (no `data:` URL prefix). */
export interface PromptImage {
  mimeType: string;
  data: string;
}

/** Immutable prompt-image location used on durable/network boundaries. The referenced artifact
 * remains authorization-scoped; this metadata is an integrity contract, not a download grant. */
export interface PromptImageReference {
  artifactId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** Ordered UTF-8 artifact chunk for a large event field. Current control planes create these
 * references; runners retain their original inline source log for rolling compatibility. */
export interface EventPayloadReference {
  artifactId: string;
  mimeType: "text/plain" | "text/x-diff";
  encoding: "utf8";
  sizeBytes: number;
  sha256: string;
}

export const EVENT_PAYLOAD_PREVIEW_BYTES = 16 * 1024;
export const EVENT_PAYLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const EVENT_PAYLOAD_MAX_CHUNKS = 4;
export const EVENT_PAYLOAD_MAX_BYTES = EVENT_PAYLOAD_CHUNK_BYTES * EVENT_PAYLOAD_MAX_CHUNKS;

/** REST and rolling-protocol input. Current control planes externalize legacy inline bodies before
 * persistence or runner delivery; providers continue to receive `PromptImage` only. */
export type PromptImageInput = PromptImage | PromptImageReference;

/** Existing broad attachment set used by Claude, ACP, and exec Codex. */
export const PROMPT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"] as const;
/** Stable app-server localImage formats verified by the driver-modernization contract. */
export const CODEX_APP_SERVER_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_PROMPT_IMAGES = 6;
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
/** Base64 payload budget kept below the control plane's 32 MiB request limit. */
export const MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES = 28 * 1024 * 1024;

export interface PromptImageValidation {
  ok: boolean;
  error?: string;
}

/** Shared browser/control-plane/runner boundary for prompt attachments. */
export function validatePromptImages(
  images: PromptImage[],
  allowedMimeTypes: readonly string[] = PROMPT_IMAGE_MIME_TYPES,
): PromptImageValidation {
  const allowedMimeSet = new Set<string>(allowedMimeTypes);
  if (images.length > MAX_PROMPT_IMAGES) {
    return { ok: false, error: `at most ${MAX_PROMPT_IMAGES} images may be attached` };
  }
  let totalBase64Bytes = 0;
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    if (!allowedMimeSet.has(image.mimeType)) {
      return { ok: false, error: `image ${i + 1} has unsupported MIME type ${JSON.stringify(image.mimeType)}; allowed: ${allowedMimeTypes.join(", ")}` };
    }
    const firstPadding = image.data.indexOf("=");
    const paddingText = firstPadding === -1 ? "" : image.data.slice(firstPadding);
    const paddingIsValid = firstPadding === -1 || paddingText === "=" || paddingText === "==";
    if (
      !image.data ||
      image.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(image.data) ||
      !paddingIsValid
    ) {
      return { ok: false, error: `image ${i + 1} is not valid base64 data` };
    }
    const paddingBytes = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    const decodedBytes = image.data.length / 4 * 3 - paddingBytes;
    if (decodedBytes > MAX_PROMPT_IMAGE_BYTES) {
      return { ok: false, error: `image ${i + 1} exceeds the ${MAX_PROMPT_IMAGE_BYTES / 1024 / 1024} MiB limit` };
    }
    totalBase64Bytes += image.data.length;
  }
  if (totalBase64Bytes > MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES) {
    return { ok: false, error: `combined image payload exceeds the ${MAX_PROMPT_IMAGE_TOTAL_BASE64_BYTES / 1024 / 1024} MiB base64 limit` };
  }
  return { ok: true };
}

export function isPromptImageReference(image: unknown): image is PromptImageReference {
  return Boolean(image && typeof image === "object" && !Array.isArray(image) && "artifactId" in image);
}

export function validateEventPayloadReferences(
  value: unknown,
  expectedMimeType?: EventPayloadReference["mimeType"],
): { ok: true; value: EventPayloadReference[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > EVENT_PAYLOAD_MAX_CHUNKS) {
    return { ok: false, error: `event payload references must contain 1-${EVENT_PAYLOAD_MAX_CHUNKS} chunks` };
  }
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `event payload chunk ${index + 1} is malformed` };
    }
    const reference = raw as Record<string, unknown>;
    if (Object.keys(reference).some((key) => !["artifactId", "mimeType", "encoding", "sizeBytes", "sha256"].includes(key)) ||
        typeof reference.artifactId !== "string" || !reference.artifactId || reference.artifactId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(reference.artifactId) ||
        (reference.mimeType !== "text/plain" && reference.mimeType !== "text/x-diff") ||
        (expectedMimeType !== undefined && reference.mimeType !== expectedMimeType) ||
        reference.encoding !== "utf8" || !Number.isSafeInteger(reference.sizeBytes) ||
        (reference.sizeBytes as number) < 1 || (reference.sizeBytes as number) > EVENT_PAYLOAD_CHUNK_BYTES ||
        typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)) {
      return { ok: false, error: `event payload chunk ${index + 1} has invalid integrity metadata` };
    }
    total += reference.sizeBytes as number;
  }
  if (total > EVENT_PAYLOAD_MAX_BYTES) return { ok: false, error: "event payload references exceed the aggregate limit" };
  return { ok: true, value: value as EventPayloadReference[] };
}

/** Validate metadata-only references and legacy inline images without resolving artifact bytes. */
export function validatePromptImageInputs(
  images: PromptImageInput[],
  allowedMimeTypes: readonly string[] = PROMPT_IMAGE_MIME_TYPES,
): PromptImageValidation {
  if (!Array.isArray(images)) return { ok: false, error: "images must be an array" };
  if (images.length > MAX_PROMPT_IMAGES) {
    return { ok: false, error: `at most ${MAX_PROMPT_IMAGES} images may be attached` };
  }
  const inline: PromptImage[] = [];
  const allowedMimeSet = new Set<string>(allowedMimeTypes);
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      return { ok: false, error: `image ${i + 1} is malformed` };
    }
    if (!isPromptImageReference(image)) {
      if (Object.keys(image).some((key) => key !== "mimeType" && key !== "data") ||
          typeof image.mimeType !== "string" || typeof image.data !== "string") {
        return { ok: false, error: `image ${i + 1} is malformed` };
      }
      inline.push(image);
      continue;
    }
    if (Object.keys(image).some((key) => !["artifactId", "mimeType", "sizeBytes", "sha256"].includes(key))) {
      return { ok: false, error: `image ${i + 1} reference contains unsupported fields` };
    }
    if (!allowedMimeSet.has(image.mimeType)) {
      return { ok: false, error: `image ${i + 1} has unsupported MIME type ${JSON.stringify(image.mimeType)}; allowed: ${allowedMimeTypes.join(", ")}` };
    }
    if (!image.artifactId || image.artifactId.length > 256 || /[\x00-\x1f\x7f]/.test(image.artifactId)) {
      return { ok: false, error: `image ${i + 1} has an invalid artifact id` };
    }
    if (!Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > MAX_PROMPT_IMAGE_BYTES) {
      return { ok: false, error: `image ${i + 1} has an invalid byte length` };
    }
    if (!/^[a-f0-9]{64}$/.test(image.sha256)) {
      return { ok: false, error: `image ${i + 1} has an invalid SHA-256 digest` };
    }
  }
  return validatePromptImages(inline, allowedMimeTypes);
}

/* ---------------------------- Session events ------------------------------ */

/** Provider-observed subagent lifecycle. Unlike a generic tool status, this may remain active
 * after the foreground parent turn becomes idle. Consumers must not synthesize it when the
 * provider exposes only an unstructured task summary. */
export type AuthoritativeSubagentLifecycle =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted"
  | "unreachable";

/**
 * Normalized streaming event taxonomy (brief-aligned). The runner maps ACP
 * `session/update` notifications onto these; the control plane assigns id/seq/ts.
 */
export type SessionEventPayload =
  // `final` marks a COMPLETE message (one whole turn), not a streaming chunk. Live drivers emit
  // many chunk events that the UI coalesces into one bubble; backfill/adopt emits whole messages
  // tagged `final` so the UI keeps them as distinct bubbles instead of concatenating them.
  // `messageId` groups provider chunks without changing the event sequence seen by older peers.
  // A matching final event may authoritatively replace the currently open message in new clients.
  | {
      kind: "user_message";
      text: string;
      images?: PromptImageInput[];
      final?: boolean;
      commandId?: string;
      /** Runner-assigned active-turn coordinate. Optional so older peers retain legacy behavior. */
      turnId?: string;
      /** Stable steering submission identity used to reconcile the canonical accepted message. */
      submissionId?: string;
      /** Present only when this message was incorporated into an already-active turn. */
      deliveryIntent?: "steer";
      /** Durable provenance for an explicit provider command. Kept separate from automation
       * `commandId` and steering metadata so none of the three receipt lanes can alias another. */
      commandInvocation?: {
        invocationId: string;
        submissionId: string;
        providerCommandId: string;
        catalogRevision: string;
        commandName: string;
        executionMode: SessionCommandExecutionMode;
      };
    }
  | { kind: "agent_message"; text: string; final?: boolean; messageId?: string; parentToolUseId?: string }
  /** Content-free evidence that a response delivered as message chunks reached a successful turn
   * boundary. Completion-only responses continue to use `agent_message.final` instead. */
  | { kind: "agent_response_completed" }
  | { kind: "agent_thought"; text: string; final?: boolean; messageId?: string; parentToolUseId?: string }
  | {
      kind: "tool_call";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: string;
      text?: string;
      textRefs?: EventPayloadReference[];
      // Set (v26+) when this call was made by a subagent — the id of the spawning Task tool
      // call. The UI nests it under that Task block; absent ⇒ a top-level call.
      parentToolUseId?: string;
      /** Provider-observed lifecycle for an agent-spawning tool (v92+). */
      subagentLifecycle?: AuthoritativeSubagentLifecycle;
    }
  | {
      kind: "tool_call_update";
      toolCallId: string;
      status: string;
      title?: string;
      text?: string;
      textRefs?: EventPayloadReference[];
      parentToolUseId?: string;
      /** Provider-observed lifecycle for an agent-spawning tool (v92+). */
      subagentLifecycle?: AuthoritativeSubagentLifecycle;
    }
  | { kind: "plan"; entries: PlanEntry[]; parentToolUseId?: string }
  | { kind: "command_output"; text: string; textRefs?: EventPayloadReference[]; parentToolUseId?: string }
  | { kind: "file_edit"; path: string; diff?: string; diffRefs?: EventPayloadReference[]; parentToolUseId?: string }
  | {
      kind: "stderr";
      text: string;
      textRefs?: EventPayloadReference[];
      /** Authenticated runner-only durable marker. Provider stderr can never set this field. */
      runnerMarker?: "background_continuation_delivery";
    }
  | {
      kind: "background_continuation_delivered";
      continuationId: string;
      parentTurnId: string;
      /** Bounded terminal evidence only; provider output references remain runner-local. */
      results?: ManagedBackgroundResult[];
    }
  | { kind: "status"; status: SessionStatus }
  | { kind: "turn_interrupted" }
  | { kind: "error"; message: string }
  | {
      kind: "policy_transport";
      state: "open" | "recovered";
      openedAt: number;
      /** Recovery can restore session-scoped hook elicitation only when v66 provisioning proved it. */
      restoresElicitation?: boolean;
    }
  | ({ kind: "review_decision" } & ReviewDecision)
  | { kind: "permission_request"; requestId: string; title: string; options: PermissionOption[]; context?: ApprovalContext; purpose?: "authentication" }
  | {
      kind: "permission_resolved";
      requestId: string;
      optionId: string | null;
      resolutionReason?: StructuredRequestResolutionReason;
    }
  | { kind: "question_request"; requestId: string; questions: AgentQuestion[] }
  | {
      kind: "question_resolved";
      requestId: string;
      answered: boolean;
      resolutionReason?: StructuredRequestResolutionReason;
    }
  | { kind: "checkpoint"; turn: number; tree: string }
  | { kind: "checkpoint_restored"; turn: number }
  | { kind: "conversation_checkpoint"; turn: number }
  | { kind: "conversation_forked"; sourceSessionId: string; turn: number }
  | {
      kind: "token_usage";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
      /** The spawning agent/task tool when this usage belongs to a subagent (v31+). */
      parentToolUseId?: string;
      /** Provider-reported subagent duration when available; otherwise the UI uses tool timestamps. */
      durationMs?: number;
    };

export type SessionEventKind = SessionEventPayload["kind"];

export interface SessionEvent {
  id: number;
  sessionId: string;
  seq: number;
  ts: number;
  payload: SessionEventPayload;
}

/* ---------------------- Usage and cost aggregation ---------------------- */

export type UsageAggregationGranularity = "hour" | "day";

export interface UsageAmount {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageRetentionPolicy {
  hourlyDays: number;
  dailyDays: number;
  /** Existing lifetime session totals are a migration baseline, not backdated history. */
  coverageStartedAt: number;
}

export interface UsageTimeBucket extends UsageAmount {
  bucketTs: number;
}

export interface UsageBreakdown extends UsageAmount {
  key: string;
}

/** Scoped, content-free accounting response. Resource ids are bounded dimensions; prompts,
 * paths, event bodies, tool inputs, and session ids never leave the aggregation boundary. */
export interface UsageAggregationResponse {
  granularity: UsageAggregationGranularity;
  since: number;
  through: number;
  retention: UsageRetentionPolicy;
  canManageRetention: boolean;
  privacy: string;
  totals: UsageAmount;
  /** Buckets in descending timestamp order, newest first. */
  series: UsageTimeBucket[];
  byDriver: UsageBreakdown[];
  byAgent: UsageBreakdown[];
  byRunner: UsageBreakdown[];
}

/* -------------------------- Session naming ----------------------------- */

export type SessionNamingMode =
  | "prompt_text_only"
  | "session_agent_account"
  | "custom_model_endpoint";

export interface SessionNamingModeAvailability {
  available: boolean;
  reason?: string;
}

export interface SessionNamingAccountBoundary {
  provider: "codex" | "claude";
  /** Safe billing boundary only. Account identifiers and credential material are never included. */
  billingSource: "subscription" | "api" | "bedrock" | "vertex" | "gateway" | "provider_account" | "unknown";
  machineCount: number;
}

export interface SessionNamingCustomModelTarget {
  runnerId: string;
  machineName: string;
  online: boolean;
  available: boolean;
  configured: boolean;
  reason?: string;
}

export interface SessionNamingHarnessModel {
  id: string;
  displayName: string;
  efforts: string[];
}

export interface SessionNamingHarnessOption {
  agentId: string;
  name: string;
  driver: Extract<AgentDriverKind, "codex" | "codex-app-server" | "claude-code">;
  /** Safe execution context used to distinguish otherwise identical native and WSL choices. */
  context?: AgentContext;
  provider: SessionNamingAccountBoundary["provider"];
  billingSource: SessionNamingAccountBoundary["billingSource"];
  models: SessionNamingHarnessModel[];
}

export interface SessionNamingHarnessMachine {
  runnerId: string;
  machineName: string;
  harnesses: SessionNamingHarnessOption[];
}

/** Persisted explicit target. Every identifier is secret-free; availability is recomputed from
 * the selected runner's current authenticated capability advertisement on every read. */
export interface SessionNamingHarnessTarget {
  runnerId: string;
  machineName: string;
  agentId: string;
  harnessName: string;
  driver: SessionNamingHarnessOption["driver"];
  context?: AgentContext;
  /** Absent only for an existing target that has not yet confirmed its account boundary. */
  provider?: SessionNamingAccountBoundary["provider"];
  billingSource?: SessionNamingAccountBoundary["billingSource"];
  model: string;
  modelName: string;
  effort: string;
  available: boolean;
  reason?: string;
}

/** Secret-free organization setting. Legacy environment configuration is reported only as
 * endpoint/model metadata; bearer credentials never cross the control-plane API boundary. */
export interface SessionNamingSettingsView {
  mode: SessionNamingMode;
  effectiveMode: SessionNamingMode;
  source: "default" | "environment" | "organization";
  canManage: boolean;
  modes: Record<SessionNamingMode, SessionNamingModeAvailability>;
  customModel?: {
    endpointOrigin: string;
    model: string;
    timeoutMs: number;
    apiKeyConfigured: boolean;
    configurationSource: "environment" | "runner";
    runnerId?: string;
    machineName?: string;
    online?: boolean;
  };
  /** Secret-free candidate Machines for runner-local custom endpoint provisioning. */
  customModelTargets?: SessionNamingCustomModelTarget[];
  /** Organization-wide availability summary. The session still uses only its own Machine/account. */
  sessionAgentAccounts?: SessionNamingAccountBoundary[];
  /** Absent for a migrated v93 preference, which deliberately continues to follow each session. */
  harnessTarget?: SessionNamingHarnessTarget;
  /** Current authenticated, naming-compatible choices. Credentials remain runner-local. */
  harnessMachines?: SessionNamingHarnessMachine[];
}

export interface UpdateSessionNamingSettingsRequest {
  mode: SessionNamingMode;
}

export interface ConfigureSessionNamingHarnessRequest {
  runnerId: string;
  agentId: string;
  driver: SessionNamingHarnessOption["driver"];
  model: string;
  effort: string;
}

/** The API key is write-only. It is accepted by the control plane only long enough to relay the
 * correlated request to the selected runner and is never included in a settings response. */
export interface ConfigureSessionNamingCustomModelRequest {
  runnerId: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}

export interface ReplaceSessionNamingCustomModelApiKeyRequest {
  apiKey: string;
}

export interface SessionNamingConnectionTestResult {
  ok: boolean;
  status: "available" | "authentication_failed" | "endpoint_failed" | "timed_out" | "unavailable";
}

/* -------------------- Per-user Agent Harness defaults ------------------- */

/** Stable identity for one discovered Agent Harness across Machines. Display names are excluded
 * deliberately: users may rename configured agents without changing which preference applies. */
export interface AgentHarnessIdentity {
  agentId: string;
  driver: AgentDriverKind;
  context: AgentContext;
}

export interface AgentHarnessDefaultConfig {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/** One current installation used to explain capability skew without exposing launch commands,
 * environment values, credentials, or other runner-local configuration. */
export interface AgentHarnessDefaultInstallation {
  runnerId: string;
  machineName: string;
  online: boolean;
  models: AgentModel[];
  effortLevels: string[];
  permissionModes: string[];
}

export interface AgentHarnessDefaultOption extends AgentHarnessIdentity {
  name: string;
  installations: AgentHarnessDefaultInstallation[];
  preference?: AgentHarnessDefaultConfig;
  /** Number of current installations that support the complete saved preference. */
  compatibleInstallations: number;
}

export interface AgentHarnessDefaultsView {
  defaults: AgentHarnessDefaultOption[];
}

export interface UpdateAgentHarnessDefaultRequest extends AgentHarnessIdentity {
  config: AgentHarnessDefaultConfig;
}

export interface DeleteAgentHarnessDefaultRequest extends AgentHarnessIdentity {}

/* ---------------- Provider subscription usage (account-level) ---------- */

export type SubscriptionUsageProvider = "codex" | "claude";
export type SubscriptionUsageState =
  | "available"
  | "unavailable"
  | "unsupported"
  | "unauthenticated"
  | "not_applicable";
export type SubscriptionUsageFreshness = "fresh" | "stale";

/** One provider-defined allowance window. IDs and labels come from the provider where available;
 * unknown buckets remain renderable without a Wollipog release. Percentages are 0..100. */
export interface SubscriptionUsageBucket {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  windowDurationMinutes?: number;
  /** Unix epoch milliseconds. */
  resetsAt?: number;
  /** Provider-reported availability of this exact window, independent of the source state. */
  status?: "available" | "warning" | "exhausted";
}

export interface SubscriptionUsageCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  /** Provider-authored decimal display value; never parsed as currency by the control plane. */
  balance?: string;
}

export interface SubscriptionUsageSpendControl {
  id: string;
  label: string;
  limit?: string;
  used?: string;
  remainingPercent?: number;
  /** Unix epoch milliseconds. */
  resetsAt?: number;
  reached?: boolean;
}

/** Secret-free runner snapshot for one configured provider source. `sourceId` is an opaque hash of
 * runner-local agent/context metadata, never an account id, email, credential, or filesystem path. */
export interface SubscriptionUsageSnapshot {
  sourceId: string;
  runnerId: string;
  agentId: string;
  provider: SubscriptionUsageProvider;
  state: SubscriptionUsageState;
  detail?: string;
  fetchedAt: number;
  buckets: SubscriptionUsageBucket[];
  plan?: string;
  credits?: SubscriptionUsageCredits;
  spendControls?: SubscriptionUsageSpendControl[];
}

/** Principal-scoped control-plane projection. Last-known data remains present while stale/offline. */
export interface SubscriptionUsageSourceView extends SubscriptionUsageSnapshot {
  runnerName: string;
  agentName: string;
  runnerStatus: RunnerStatus;
  freshness: SubscriptionUsageFreshness;
}

export interface SubscriptionUsageResponse {
  sources: SubscriptionUsageSourceView[];
  staleAfterMs: number;
  generatedAt: number;
  /** Present only after a manual refresh; failures retain last-known source data. */
  refresh?: { attempted: number; failed: number };
}

/* ------------------- Operational transcript projection ------------------- */

/**
 * Versioned, deliberately narrow transcript shape for authenticated exports and future immutable
 * share links. This is NOT a filtered SessionEvent: source ids, sequence numbers, timestamps,
 * attachments, provider metadata, and operational events never cross this boundary.
 */
export const OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION = 1 as const;

export type OperationalTranscriptRole = "user" | "assistant";

export interface OperationalTranscriptMessage {
  role: OperationalTranscriptRole;
  /** Operationally redacted plain text. It may still contain secrets or source code. */
  text: string;
}

/** A deliberately narrow point-in-time snapshot of the control-plane event cache. */
export interface OperationalTranscriptProjection {
  schemaVersion: typeof OPERATIONAL_TRANSCRIPT_PROJECTION_VERSION;
  source: "control-plane-cache";
  completeness: "possibly-partial";
  messages: OperationalTranscriptMessage[];
}

export type TranscriptShareStatus = "active" | "expired" | "revoked";

/** Authenticated management metadata. The capability token is returned only on creation. */
export interface TranscriptShareView {
  shareId: string;
  sessionId: string;
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  status: TranscriptShareStatus;
  revokedAt?: number;
}

export interface CreateTranscriptShareRequest {
  expiresInSeconds: number;
}

export interface CreateTranscriptShareResult {
  share: TranscriptShareView;
  /** One-time plaintext capability. Persisted only as a SHA-256 hash by the control plane. */
  token: string;
}

/** Least-data response available to the bearer of an active share capability. */
export interface PublicTranscriptShare {
  expiresAt: number;
  transcript: OperationalTranscriptProjection;
}

/** Legacy execution-context classification retained on the wire: `project` means workspace-backed,
 * not membership in a durable Project. Derived from `workspaceId` when absent. */
export type ThreadType = "chat" | "project";

/** Who currently owns the display title. Provider updates may replace generated titles but never
 * an explicit user title; optional on pre-v37 snapshots/rows. */
export type SessionTitleSource = "generated" | "user" | "provider";

/** Runner-observed durable Claude background-work lifecycle. Absent means the runner does not
 * expose background work for this session (including older runners and non-Claude drivers). */
export type BackgroundWorkState = "running" | "continuation_pending" | "orphaned" | "resumed";

/** Whether the runner can durably observe detached work for this provider. `untracked` is a
 * capability boundary, not proof that detached work currently exists. */
export type BackgroundWorkTracking = "managed" | "untracked";

/** Projection-safe runner facts for one managed background job. Provider context, local paths,
 * output references, and credentials deliberately never cross this boundary. */
export interface ManagedBackgroundJobSnapshot {
  id: string;
  parentTurnId: string;
  runnerId: string;
  workspaceId: string | null;
  launchType: "agent" | "shell" | "monitor" | "workflow" | "unknown";
  registeredAt: number;
  terminalStatus?: "completed" | "failed" | "killed";
  terminalObservedAt?: number;
  continuationRequired?: boolean;
  continuationId?: string;
  continuationQueuedAt?: number;
  continuationSubmittedAt?: number;
  continuationAcceptedAt?: number;
  assistantResultPersistedAt?: number;
}

/** Provider-neutral terminal evidence safe to project across runner/control-plane boundaries. */
export interface ManagedBackgroundResult {
  id: string;
  launchType: ManagedBackgroundJobSnapshot["launchType"];
  status: NonNullable<ManagedBackgroundJobSnapshot["terminalStatus"]>;
  terminalAt: number;
}

export type BackgroundDeliveryWatchdogState =
  | "terminal_without_continuation"
  | "accepted_without_result"
  | "result_not_projected"
  | "dashboard_observation_pending";

export type BackgroundNotificationReceiptState =
  | "pending"
  | "retry"
  | "service_accepted"
  | "shown"
  | "clicked"
  | "permanent_failure"
  | "expired";

/** Per-subscription receipt without exposing the capability-bearing push endpoint. */
export interface BackgroundNotificationReceiptView {
  deliveryId: string;
  endpointKey: string;
  state: BackgroundNotificationReceiptState;
  attemptCount: number;
  serviceAcceptedAt?: number;
  shownAt?: number;
  clickedAt?: number;
  lastStatus?: number;
  lastError?: string;
}

/** Control-plane-owned durable projection of one parent continuation. `dashboardObservedAt`
 * acknowledges receipt by an authenticated dashboard, not OS notification display or user click. */
export interface BackgroundDeliveryView {
  /** Absent while terminal required work has not acquired a continuation identity. */
  continuationId?: string;
  parentTurnId: string;
  jobCount: number;
  terminalCount: number;
  queuedAt?: number;
  submittedAt?: number;
  acceptedAt?: number;
  runnerResultPersistedAt?: number;
  transcriptProjectedAt?: number;
  notificationQueuedAt?: number;
  dashboardObservedAt?: number;
  /** Durable proof that this delivery consumed its correlated trailing busy-to-idle status. */
  statusSettledAt?: number;
  /** Separate service, display, and click acknowledgements for each push subscription. */
  notifications?: BackgroundNotificationReceiptView[];
  watchdogState?: BackgroundDeliveryWatchdogState;
}

/** A prompt waiting behind the running turn (the runner serializes turns one at a time). Ephemeral
 * runner state surfaced to the UI so queued messages are visible + individually cancelable. */
export interface QueuedPromptView {
  /** Runner-assigned id, stable for the life of the queue entry — the cancel target. */
  id: string;
  text: string;
  /** The queued prompt also carries image attachments. */
  hasImages?: boolean;
  /** A reserved promotion is not runnable; uncertain delivery remains held for user resolution. */
  steeringState?: "promoting" | "uncertain";
  /** Explicit false lets the runner explain why this particular entry cannot be promoted. */
  steerable?: boolean;
  steerDisabledReason?: string;
  /** Control-plane durable delivery state before the runner exposes its live queue identity. */
  durableDeliveryState?: "pending" | "queued" | "failed" | "uncertain";
  durableDeliveryError?: string;
  /** True only when this entry came from the current runner's live in-memory queue. */
  liveQueueObserved?: boolean;
  /** Explicit runner authority for replacing this not-yet-started entry in place. */
  editable?: boolean;
  editDisabledReason?: string;
  /** Opaque optimistic-concurrency coordinate. It changes after every accepted edit. */
  editRevision?: string;
}

export interface QueuedPromptDraft {
  promptId: string;
  text: string;
  images: PromptImageInput[];
  editRevision: string;
}

export type QueuedPromptEditFailureReason =
  | "session_not_found"
  | "queue_item_absent"
  | "queue_item_started"
  | "queue_item_changed"
  | "queue_item_immutable"
  | "invalid_content"
  | "queue_capacity_exceeded";

export type PendingPromptState =
  | "pending" | "sent" | "accepted" | "queued" | "started" | "failed" | "uncertain";

/** Control-plane durable prompt projection. Unlike `queued`, this identity and state survive
 * reconnects/reloads and remain visible until a canonical command-tagged user event or dismissal. */
export interface PendingPromptView {
  commandId: string;
  text: string;
  hasImages?: boolean;
  state: PendingPromptState;
  revision: number;
  attemptCount: number;
  error?: string;
  errorCode?: DurableSessionCommandErrorCode;
  userEventSeq?: number;
  createdAt: number;
  updatedAt: number;
  /** Safe only before any runner send attempt has been recorded. */
  canCancel?: boolean;
  /** Terminal evidence may be hidden without changing its recorded outcome. */
  canDismiss?: boolean;
}

export type SteerDisposition = "accepted" | "converted_to_queue" | "rejected" | "uncertain";

export type SteerResultReason =
  | "accepted"
  | "stale_turn"
  | "unsupported_protocol"
  | "unsupported_driver"
  | "no_active_provider_turn"
  | "policy_blocked"
  | "governance_blocked"
  | "queue_item_absent"
  | "queue_item_started"
  | "configuration_mismatch"
  | "queue_capacity_exceeded"
  | "provider_rejected"
  | "transport_uncertain"
  | "history_integrity_failure";

export type SteeringAttemptState = "pending" | SteerDisposition;
export type SteeringAttemptSource = "direct" | "queued";

/** Control-plane-owned durable steering receipt projected to every dashboard. Text is a bounded
 * preview; the immutable full request remains in the control-plane attempt record. */
export interface SteeringAttemptView {
  submissionId: string;
  /** Runner-owned active-turn coordinate supplied by the caller. */
  turnId: string;
  source: SteeringAttemptSource;
  sourceQueueId?: string;
  text: string;
  hasImages?: boolean;
  state: SteeringAttemptState;
  reason?: SteerResultReason;
  queuedPromptId?: string;
  /** Durable explicit recovery state. Pending means delivery may have crossed the runner boundary;
   * applied is runner-authoritative and removes the attempt from unresolved admission. */
  resolution?: {
    action: "queue_again" | "dismiss";
    state: "pending" | "applied";
    queuedPromptId?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export type SessionCommandInvocationState =
  | "pending"
  | "sent"
  | "accepted"
  | "queued"
  | "started"
  | "completed"
  | "rejected"
  | "uncertain";

export type SessionCommandInvocationErrorCode =
  | "COMMAND_ID_CONFLICT"
  | "COMMAND_EXPIRED"
  | "INVALID_COMMAND"
  | "SESSION_NOT_FOUND"
  | "QUEUE_FULL"
  | "COMMAND_CANCELLED"
  | "PROVIDER_AUTHENTICATION_REQUIRED"
  | "RECEIPT_STORE_FULL"
  | "COMMAND_CATALOG_STALE"
  | "COMMAND_UNAVAILABLE"
  | "COMMAND_MODE_UNSUPPORTED";

/** Control-plane-owned projection of one manual provider-command receipt. Opaque runner catalog
 * coordinates remain intact; consumers compare equality and monotonic revision only. */
export interface SessionCommandInvocationView {
  invocationId: string;
  submissionId: string;
  sessionId: string;
  providerCommandId: string;
  catalogRevision: string;
  commandName: string;
  argumentText: string;
  executionMode: SessionCommandExecutionMode;
  state: SessionCommandInvocationState;
  revision: number;
  error?: string;
  code?: SessionCommandInvocationErrorCode;
  userEventSeq?: number;
  createdAt: number;
  updatedAt: number;
}

/** Denormalised session record for the UI (board cards + lists). */
export interface SessionView {
  id: string;
  runnerId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  /** CP-owned durable Project assignment. `undefined` is a legacy control plane; `null` is an
   * explicit No Project session. Runner snapshots never own these fields. */
  projectId?: string | null;
  projectName?: string | null;
  projectLocationId?: string | null;
  /** Current transcript audience for explicit Project-sharing consent. Older control planes omit it. */
  audience?: ResourceOwner["kind"];
  /** True only after the control plane has a runner-authoritative cwd for an imported session.
   * Older control planes omit it, so clients must fail closed before offering Location creation. */
  importLocationReady?: boolean;
  agentId: string | null;
  agentName: string | null;
  title: string;
  titleSource?: SessionTitleSource;
  /** Canonical provider activity timestamp from stable ACP session_info_update; presentation-only. */
  providerUpdatedAt?: string;
  /** Durable runner-observed Claude background-work lifecycle; absent when not applicable. */
  backgroundWorkState?: BackgroundWorkState;
  /** Explicit provider capability boundary. Omitted by pre-v83 control planes. */
  backgroundWorkTracking?: BackgroundWorkTracking;
  /** Durable control-plane delivery stages. Omitted by pre-v82 control planes. */
  backgroundDeliveries?: BackgroundDeliveryView[];
  status: SessionStatus;
  column: BoardColumn;
  runId: string | null;
  useWorktree: boolean;
  worktreePath: string | null;
  /** All runner-linked worktrees attributed to this session. `worktreePath` identifies the one
   * currently targeted by Git, Files, shells, checkpoints, and PR summary actions. */
  worktrees?: SessionWorktreeView[];
  /** Resolved launch placement; absent for sessions created by a pre-v60 control plane. */
  executionTarget?: ExecutionTargetRef;
  /** Protocol-v62 cloud acceptance proof. Absent until the runner's adapter accepts the handoff. */
  executionHandoff?: ExecutionHandoffReceipt;
  archived: boolean;
  /** Durable server-owned stop-and-archive state. While pending, `archived` remains false so the
   * session cannot disappear from ordinary clients before capacity release is confirmed. */
  archiveStatus?: ArchiveStatus;
  /** Structured operation state for clients that support Stop failure recovery. Omitted by older
   * control planes and when no archive follow-up remains attached to the durable Stop intent. */
  archiveOperation?: ArchiveOperationView;
  /** Structured state for every durable Stop intent, including a plain Stop without an archive
   * follow-up. Terminal or absence evidence removes the operation. */
  stopOperation?: StopOperationView;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number | null;
  messageCount: number;
  /** Control-plane-owned generation of the cached event log. Increments whenever the complete
   * timeline is replaced, allowing dashboards to discard cursors from an older generation. */
  eventEpoch?: number;
  /** Short snippet of the latest agent message, for the card preview. */
  preview: string | null;
  pendingApproval: PendingApproval | null;
  driver: AgentDriverKind;
  model: string | null;
  /** Provider-resolved model used by the live session; the selected alias remains in `model`. */
  resolvedModel?: string | null;
  effort: string | null;
  permissionMode: string | null;
  /** Live session-scoped controls (ACP modes/config/commands). Falls back to runner-agent
   * capabilities when absent on pre-v36 sessions. */
  agentCapabilities?: SessionCapabilities;
  /** Accumulated usage across the session's turns. */
  tokensIn: number;
  tokensOut: number;
  /** Stable ACP context occupancy is a current gauge, not an additive per-turn total. */
  contextTokensUsed?: number;
  contextWindow?: number;
  costUsd: number;
  /** True for sessions adopted from an external CLI transcript — only these can be reprocessed. */
  adopted: boolean;
  /** Sidebar grouping. Absent ⇒ derive from `workspaceId` (null ⇒ "chat"). */
  threadType?: ThreadType;
  /** Absolute accumulated-cost threshold (USD); null ⇒ unlimited. */
  costBudgetUsd?: number | null;
  /** Fixed allowance window retained while the absolute cost threshold is re-armed. CP-only. */
  costBudgetStepUsd?: number | null;
  /** Absolute distinct-tool-call threshold; null ⇒ unlimited. */
  maxToolCalls?: number | null;
  /** Fixed allowance window retained while the absolute tool threshold is re-armed. CP-only. */
  maxToolCallsStep?: number | null;
  /** Distinct tool calls recorded so far — populated only when `maxToolCalls` is set. */
  toolCallCount?: number;
  /** Prompts queued behind the running turn (ephemeral; absent/empty ⇒ nothing queued). */
  queued?: QueuedPromptView[];
  /** Durable user prompts rendered in the transcript while delivery remains incomplete/terminal. */
  pendingPrompts?: PendingPromptView[];
  /** The runner interrupted the active turn and is holding the preserved FIFO for explicit resume. */
  queueHeld?: boolean;
  /** Ephemeral runner-owned coordinate for the currently dequeued turn. */
  activeTurnId?: string;
  /** Durable control-plane steering attempts, including unresolved and uncertain delivery. */
  steeringAttempts?: SteeringAttemptView[];
  /** Durable manual provider-command receipts. Omitted by pre-v75 control planes. */
  commandInvocations?: SessionCommandInvocationView[];
}

/** Control-plane-owned, per-user inbox visibility and reminder state. This is deliberately
 * orthogonal to session lifecycle and archive state: snoozing never stops or detaches work. */
export type SessionReminderWakePolicy = "until_activity" | "regardless";
export type SessionReminderState = "pending" | "fired";
export type SessionReminderWakeReason =
  | "scheduled"
  | "agent_response"
  | "approval"
  | "question"
  | "failure"
  | "background_job";

export interface SessionReminderView {
  reminderId: string;
  sessionId: string;
  scheduledFor: number;
  timeZone: string;
  originalExpression: string;
  wakePolicy: SessionReminderWakePolicy;
  state: SessionReminderState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  firedAt?: number;
  wakeReason?: SessionReminderWakeReason;
}

/** A provider-neutral auxiliary conversation attached to one primary session. The child is a
 * separate session (and therefore has separate transcript, accounting, and worktree state); this
 * relationship deliberately does not confer provider-fork or artifact ancestry. */
export interface SideChatView {
  parentSessionId: string;
  session: SessionView;
  createdAt: number;
}

/**
 * Phase 2: a session as the runner (the box, the source of truth) describes it on register. The
 * control plane hydrates these into its cache. Carries `seq` (the runner's per-session event
 * high-water) so the CP can lazily fetch only the events it's missing via SessionHistoryRequest.
 */
export interface SessionSnapshot {
  id: string;
  /** Opaque CP launch identity echoed by runners that accepted a replacement start. */
  controlPlaneLaunchId?: string;
  workspaceId: string | null;
  agentId: string | null;
  title: string;
  titleSource?: SessionTitleSource;
  providerUpdatedAt?: string;
  /** Durable runner-observed Claude background-work lifecycle; absent when not applicable. */
  backgroundWorkState?: BackgroundWorkState;
  /** Explicit provider capability boundary. Omitted for pre-v83 control planes. */
  backgroundWorkTracking?: BackgroundWorkTracking;
  /** Bounded projection-safe managed-job inventory. Omitted for pre-v82 control planes. */
  backgroundJobs?: ManagedBackgroundJobSnapshot[];
  status: SessionStatus;
  driver: AgentDriverKind;
  useWorktree: boolean;
  worktreePath: string | null;
  /** Additive requested-worktree inventory. Older runners expose only worktreePath. */
  worktrees?: SessionWorktreeView[];
  executionTarget?: ExecutionTargetRef;
  executionHandoff?: ExecutionHandoffReceipt;
  /** The runner's launch directory (the box is the source of truth). Carries the ad-hoc browsed path
   * for workspace-less sessions so a cold-hydrating control plane can still restart them. */
  workspacePath?: string | null;
  config: SessionConfig;
  /** Provider-resolved model used by the live session; absent on older runners/providers. */
  resolvedModel?: string | null;
  /** Protocol v38: original session-scope overrides (unresolved environment references only).
   * Runner/workspace/agent definitions are re-merged from current operator config on restart. */
  acpSessionContext?: AcpSessionContextConfig;
  /** Live provider controls for this session; absent for native/pre-v36 sessions. */
  agentCapabilities?: SessionCapabilities;
  preview: string | null;
  pendingApproval: PendingApproval | null;
  tokensIn: number;
  tokensOut: number;
  contextTokensUsed?: number;
  contextWindow?: number;
  costUsd: number;
  /** True for sessions adopted from an external CLI transcript (gates the reprocess action). */
  adopted?: boolean;
  /** Highest event seq the runner holds for this session (its own monotonic counter). */
  seq: number;
  /** Protocol v54: runner-owned log generation. A reset invalidates every in-flight page chain. */
  historyEpoch?: number;
  createdAt: number;
  updatedAt: number;
}

/** Runner-authoritative Git identity for one session-linked worktree. */
export interface SessionWorktreeView {
  /** Stable runner-local identity used for lifecycle journals and selection. */
  id: string;
  path: string;
  branch: string;
  /** Caller-selected creation ref. Attached and legacy worktrees may omit it. */
  baseRef?: string;
  /** Commit resolved from baseRef when this worktree was created. */
  baseCommit?: string;
  source: "legacy" | "created" | "attached";
  /** Pull request linkage is additive and may be absent until GitHub state is available. */
  pullRequest?: { url: string; state: "open" | "merged" | "closed" };
}

/* ========================================================================== */
/* Multi-agent runs                                                           */
/* ========================================================================== */

export interface RunView {
  id: string;
  title: string;
  prompt: string;
  workspaceId: string | null;
  workspaceName: string | null;
  createdAt: number;
  updatedAt: number;
  sessionIds: string[];
}

/* ========================================================================== */
/* Collaboration pods                                                         */
/* ========================================================================== */

export type PodStatus = "active" | "closed";

export type PodMemberRole = "lead" | "worker" | "reviewer";

export type PodArbitrationMode = "manual" | "round_robin" | "lead_driven" | "event_triggered";

export interface PodOrchestrationPolicy {
  mode: PodArbitrationMode;
  /** Conservative cross-provider prompt ceiling: one UTF-8 byte counts as one estimated token. */
  contextTokenBudget: number;
  /** Portion of the prompt budget reserved for deterministic summaries of omitted context. */
  summaryTokenBudget: number;
  /** Hard per-cycle dispatch ceiling. A human must explicitly start a new cycle after it trips. */
  maxTurns: number;
  /** Exact normalized member outputs allowed in one cycle before loop detection stops it. */
  maxRepeatedOutputs: number;
}

export type PodOrchestrationStatus = "idle" | "running" | "paused" | "stopped";

export interface PodOrchestrationState {
  status: PodOrchestrationStatus;
  runId?: string;
  turnsUsed: number;
  currentSessionId?: string;
  lastSessionId?: string;
  stopReason?: string;
  startedAt?: number;
  updatedAt: number;
}

export type PodOrchestrationStepStatus = "dispatching" | "running" | "settled" | "failed";

export interface PodOrchestrationStep {
  stepId: string;
  podId: string;
  runId: string;
  turn: number;
  targetSessionId: string;
  triggerSessionId?: string;
  selectedEntryIds: string[];
  summarizedFromSeq?: number;
  summarizedToSeq?: number;
  estimatedTokens: number;
  outputEntryId?: string;
  status: PodOrchestrationStepStatus;
  error?: string;
  createdAt: number;
  settledAt?: number;
}

export interface PodOrchestrationView {
  policy: PodOrchestrationPolicy;
  state: PodOrchestrationState;
  lastStep?: PodOrchestrationStep;
}

export type PodReconciliationStatus = "running" | "applied" | "already_applied" | "conflicted" | "failed";

/** Durable merge/reconcile receipt. Session titles and filesystem paths are deliberately absent;
 * the immutable git coordinates remain trustworthy after a member is renamed or deleted. */
export interface PodReconciliation {
  reconciliationId: string;
  podId: string;
  sourceSessionId: string;
  targetSessionId: string;
  actorId: string;
  status: PodReconciliationStatus;
  sourceHead?: string;
  targetHead?: string;
  mergeBase?: string;
  resultHead?: string;
  conflictPaths?: string[];
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface PodMemberView {
  sessionId: string;
  joinedAt: number;
  role: PodMemberRole;
  /** Null inherits the pod policy's contextTokenBudget. */
  contextTokenBudget: number | null;
  /** Highest shared-log sequence represented in a successfully delivered automatic prompt. */
  lastContextSeq: number;
}

/** A durable collaboration group. Pods deliberately own membership independently of runs:
 * a run records one execution/workflow, while a pod may span runners and evolve over time. */
export interface PodView {
  id: string;
  title: string;
  objective: string;
  status: PodStatus;
  members: PodMemberView[];
  /** Optional only for rolling control-plane/UI compatibility. New control planes always supply it. */
  orchestration?: PodOrchestrationView;
  /** Newest-first bounded receipts. Optional only for rolling control-plane/UI compatibility. */
  reconciliations?: PodReconciliation[];
  createdAt: number;
  updatedAt: number;
}

export interface CreatePodRequest {
  title: string;
  objective?: string;
  /** Existing isolated sessions to group. A session may belong to only one active pod. */
  sessionIds: string[];
}

export interface AddPodMemberRequest {
  sessionId: string;
  role?: PodMemberRole;
  contextTokenBudget?: number;
}

export interface UpdatePodMemberRequest {
  role?: PodMemberRole;
  /** Null clears the member override and inherits the pod policy. */
  contextTokenBudget?: number | null;
}

export interface UpdatePodOrchestrationRequest {
  mode?: PodArbitrationMode;
  contextTokenBudget?: number;
  summaryTokenBudget?: number;
  maxTurns?: number;
  maxRepeatedOutputs?: number;
}

export interface StartPodOrchestrationRequest {
  /** Optional attributed seed note appended before the first automatic dispatch. */
  instruction?: string;
  /** Required for event-triggered mode; optional as a round-robin starting point. */
  firstSessionId?: string;
}

export interface PodOrchestrationActionResult {
  pod: PodView;
  session?: SessionView;
  step?: PodOrchestrationStep;
  appendedEntry?: PodContextEntry;
}

export interface ReconcilePodRequest {
  sourceSessionId: string;
  targetSessionId: string;
}

export interface PodReconciliationActionResult {
  pod: PodView;
  reconciliation: PodReconciliation;
}

export type PodContextSource =
  | { kind: "human"; actorId: string }
  | {
      kind: "session";
      sessionId: string;
      sessionTitle: string;
      agentLabel: string;
      fromSeq: number;
      toSeq: number;
    };

/** Immutable, attributed shared context. Attribution is frozen so the entry remains trustworthy
 * after its source session is renamed or deleted. */
export interface PodContextEntry {
  id: string;
  podId: string;
  seq: number;
  ts: number;
  source: PodContextSource;
  content: string;
}

export type AppendPodContextRequest =
  | { kind: "note"; text: string }
  | { kind: "member_output"; sessionId: string };

export interface RelayPodRequest {
  /** Optional coordination note. When present, it is appended to the pod log before delivery. */
  text?: string;
  /** Omit to relay to every member; otherwise must be a non-empty exact subset. */
  sessionIds?: string[];
  /** Explicit, ordered shared-log entries to compose into the prompt. */
  contextEntryIds?: string[];
}

export interface PodRelayReceipt {
  sessionId: string;
  status: "delivered" | "failed";
  error?: string;
}

export interface RelayPodResult {
  pod: PodView;
  /** Successfully delivered target snapshots, retained for backward compatibility. */
  sessions: SessionView[];
  receipts: PodRelayReceipt[];
  appendedEntry?: PodContextEntry;
}

export type WorkflowArtifactKind = "html_preview" | "patch" | "review_report" | "screenshot" | "test_log" | "verdict";
export type WorkflowArtifactEncoding = "utf8" | "base64" | "json";
export type WorkflowArtifactMetadataValue = string | number | boolean | null;

export interface WorkflowArtifactView {
  artifactId: string;
  runId?: string;
  sessionId?: string;
  kind: WorkflowArtifactKind;
  name: string;
  mimeType: string;
  encoding: WorkflowArtifactEncoding;
  sizeBytes: number;
  sha256: string;
  createdBy: GovernanceActor;
  metadata?: Record<string, WorkflowArtifactMetadataValue>;
  createdAt: number;
}

export interface WorkflowArtifact extends WorkflowArtifactView {
  data: string;
}

export interface WorkflowArtifactPage {
  artifacts: WorkflowArtifactView[];
  nextCursor?: string;
}

export interface CreateWorkflowArtifactRequest {
  runId?: string;
  sessionId?: string;
  kind: WorkflowArtifactKind;
  name: string;
  mimeType: string;
  encoding: WorkflowArtifactEncoding;
  data: string;
  metadata?: Record<string, WorkflowArtifactMetadataValue>;
}

/* -------------------------- Durable workflows --------------------------- */

export type WorkflowNodeKind = "agent" | "human_gate" | "policy_gate";
export type WorkflowEdgeCondition = "success" | "failure" | "accepted" | "changes_requested" | "always";
export type WorkflowDefinitionSource = "custom" | "builtin";

export interface WorkflowArtifactContract {
  /** Stable graph-local handle used to wire a producer to one or more consumers. */
  name: string;
  kind: WorkflowArtifactKind;
  required?: boolean;
}

export interface WorkflowRetryPolicy {
  /** Includes the first attempt. A value of one disables retries. */
  maxAttempts: number;
  backoffMs: number;
}

export type WorkflowStopCondition =
  | { kind: "verdict"; artifact: string; outcomes: Array<"accepted" | "changes_requested" | "rejected"> }
  | { kind: "attempt_limit"; maxAttempts: number };

export interface WorkflowNodeDefinition {
  nodeId: string;
  kind: WorkflowNodeKind;
  role: string;
  /** Required only for agent nodes. This is resolved against the run's runner at dispatch time. */
  agentId?: string;
  /** Required only for policy gates. Built-in policy ids remain valid inputs. */
  policyId?: string;
  prompt?: string;
  inputs: WorkflowArtifactContract[];
  outputs: WorkflowArtifactContract[];
  retry: WorkflowRetryPolicy;
  timeoutMs: number;
  stopCondition?: WorkflowStopCondition;
}

export interface WorkflowEdgeDefinition {
  edgeId: string;
  from: string;
  to: string;
  on: WorkflowEdgeCondition;
}

export interface WorkflowDefinitionSpec {
  name: string;
  description?: string;
  /** Bounds cyclic review loops even when every individual node keeps succeeding. */
  maxTransitions: number;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export interface WorkflowDefinition extends WorkflowDefinitionSpec {
  workflowId: string;
  version: number;
  source: WorkflowDefinitionSource;
  createdBy: GovernanceActor;
  createdAt: number;
}

export type WorkflowInstanceStatus = "queued" | "running" | "waiting_gate" | "succeeded" | "failed" | "stopped";
export type WorkflowNodeStatus = "pending" | "ready" | "running" | "waiting_gate" | "succeeded" | "failed" | "skipped" | "stopped";
export type WorkflowAttemptStatus = "dispatching" | "running" | "awaiting_output" | "succeeded" | "failed" | "timed_out" | "cancelled";
export type WorkflowNodeOutcome = "success" | "failure" | "accepted" | "changes_requested" | "rejected";

export interface WorkflowNodeState {
  nodeId: string;
  status: WorkflowNodeStatus;
  attemptCount: number;
  sessionId?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  readyAt?: number;
  outcome?: WorkflowNodeOutcome;
}

export interface WorkflowInstanceView {
  instanceId: string;
  workflowId: string;
  workflowVersion: number;
  runId: string;
  status: WorkflowInstanceStatus;
  transitionCount: number;
  nodeStates: WorkflowNodeState[];
  createdBy: GovernanceActor;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WorkflowAttemptView {
  attemptId: string;
  instanceId: string;
  nodeId: string;
  attempt: number;
  status: WorkflowAttemptStatus;
  dispatchKey: string;
  sessionId?: string;
  startedAt: number;
  deadlineAt: number;
  completedAt?: number;
  error?: string;
}

export type WorkflowEventKind =
  | "instance_created"
  | "instance_status_changed"
  | "node_status_changed"
  | "attempt_started"
  | "attempt_status_changed"
  | "attempt_finished"
  | "gate_resolved";

export interface WorkflowEventView {
  eventId: number;
  instanceId: string;
  seq: number;
  kind: WorkflowEventKind;
  nodeId?: string;
  attemptId?: string;
  actor: GovernanceActor;
  detail?: Record<string, WorkflowArtifactMetadataValue>;
  createdAt: number;
}

export interface WorkflowInstanceDetail extends WorkflowInstanceView {
  definition: WorkflowDefinition;
  attempts: WorkflowAttemptView[];
  events: WorkflowEventView[];
  attemptsTruncated?: boolean;
  eventsTruncated?: boolean;
}

export interface CreateWorkflowDefinitionRequest extends WorkflowDefinitionSpec {}

/** Creates the next immutable version of an existing custom workflow id. */
export interface CreateWorkflowDefinitionVersionRequest extends WorkflowDefinitionSpec {}

export interface CreateWorkflowInstanceRequest {
  workflowId: string;
  /** Omit to instantiate the latest immutable version. */
  workflowVersion?: number;
  runId: string;
}

/** Launch a run whose worker sessions remain idle until their graph nodes are dispatched. */
export interface CreateWorkflowRunRequest {
  runnerId: string;
  workspaceId: string;
  /** Exact durable Project assignment. Omit both fields for legacy exact-Location inference. */
  projectId?: string | null;
  projectLocationId?: string | null;
  workflowId: string;
  /** Omit to bind the latest immutable workflow version. */
  workflowVersion?: number;
  task: string;
  title?: string;
  useWorktree?: boolean;
  config?: SessionConfig;
  costBudgetUsd?: number;
  maxToolCalls?: number;
  /** Graph agent id to concrete runner agent id. Omitted entries use the graph id verbatim. */
  agentBindings?: Record<string, string>;
  /** Optional manager agent started with the workflow instance id; workers receive no initial prompt. */
  orchestratorAgentId?: string;
}

export interface CreateWorkflowRunResult {
  run: RunView;
  sessions: SessionView[];
  instance: WorkflowInstanceDetail;
}

export interface DispatchWorkflowNodeRequest {
  /** Caller-generated retry key. Repeating it returns the original attempt and never re-sends. */
  dispatchKey: string;
}

export interface DispatchWorkflowNodeResult {
  attempt: WorkflowAttemptView;
  idempotent: boolean;
}

/* ========================================================================== */
/* Durable automations                                                        */
/* ========================================================================== */

export type AutomationMisfirePolicy =
  | { kind: "skip" }
  | { kind: "fire_once" }
  | { kind: "catch_up"; maxRuns: number };

export type AutomationRunnerPolicy =
  | { kind: "wait" }
  | { kind: "expire"; afterMinutes: number }
  | { kind: "alternate"; targets: AutomationRunnerTarget[]; expireAfterMinutes?: number };

/** Explicit runner-local mappings only. Display-name/path matching is never used to infer that two
 * targets are equivalent. `agentId` applies to create-session; bindings apply to workflow-run. */
export interface AutomationRunnerTarget {
  runnerId: string;
  workspaceId: string;
  /** Exact Project Location for this alternate placement. Omit both for legacy inference. */
  projectId?: string | null;
  projectLocationId?: string | null;
  agentId?: string;
  agentBindings?: Record<string, string>;
  orchestratorAgentId?: string;
}

/** `wait` retains one due occurrence until the previous execution settles; `skip` records and
 * advances it; `parallel` is available only for actions that create an independent target. */
export type AutomationConcurrencyPolicy = "wait" | "skip" | "parallel";

/** Every unattended execution has finite incremental ceilings. Independent create/workflow actions
 * use these values; a prompt action keeps the strictest existing, request, or incremental ceiling. */
export interface AutomationLimits {
  maxCostUsd: number;
  maxToolCalls: number;
}

export type AutomationNotificationEvent = "started" | "succeeded" | "failed" | "expired";

export interface AutomationNotificationRouting {
  /** Empty means no out-of-band notification. The scheduler currently routes through Web Push. */
  pushEvents: AutomationNotificationEvent[];
}

export type AutomationAction =
  | { kind: "create_session"; request: CreateSessionRequest }
  | { kind: "prompt_session"; sessionId: string; request: Omit<PromptRequest, "images"> }
  | { kind: "workflow_run"; request: CreateWorkflowRunRequest };

export interface AutomationSpec {
  name: string;
  /** Strict five-field minute/hour/day-of-month/month/day-of-week cron expression. */
  cron: string;
  /** IANA timezone interpreted by the control plane, for example `America/Chicago`. */
  timezone: string;
  enabled: boolean;
  misfirePolicy: AutomationMisfirePolicy;
  runnerPolicy: AutomationRunnerPolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  limits: AutomationLimits;
  notifications: AutomationNotificationRouting;
  action: AutomationAction;
}

export interface CreateAutomationRequest extends AutomationSpec {}
export interface UpdateAutomationRequest extends AutomationSpec {}

export interface AutomationSchedule extends AutomationSpec {
  automationId: string;
  /** Monotonic version incremented for every edit. */
  revision: number;
  nextFireAt?: number;
  lastFiredAt?: number;
  createdBy: GovernanceActor;
  createdAt: number;
  updatedAt: number;
}

export type AutomationTriggerKind = "webhook" | "chatops";

export interface AutomationTriggerView {
  triggerId: string;
  automationId: string;
  kind: AutomationTriggerKind;
  name: string;
  generation: number;
  createdBy: GovernanceActor;
  createdAt: number;
  updatedAt: number;
  lastInvokedAt?: number;
  invocationCount: number;
}

export interface CreateAutomationTriggerRequest {
  kind: AutomationTriggerKind;
  name: string;
}

/** The signing secret is returned only on create/rotate and is never included in trigger views. */
export interface AutomationTriggerCredential {
  trigger: AutomationTriggerView;
  secret: string;
}

export type AutomationTriggerInvocationState =
  | "pending"
  | "dispatched"
  | "skipped"
  | "expired"
  | "rejected";

export interface AutomationTriggerInvocationView {
  invocationId: string;
  triggerId: string;
  eventId: string;
  state: AutomationTriggerInvocationState;
  receivedAt: number;
  updatedAt: number;
  executionId?: string;
}

export interface AutomationTriggerInvocationResult {
  invocation: AutomationTriggerInvocationView;
  duplicate: boolean;
}

export type AutomationExecutionStatus =
  | "dispatching"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "expired";

export type AutomationCommandState =
  | "staged"
  | "pending"
  | "sent"
  | "accepted"
  | "started"
  | "completed"
  | "rejected"
  | "uncertain";

export interface AutomationCommandView {
  commandId: string;
  executionId: string;
  ordinal: number;
  runnerId: string;
  sessionId: string;
  kind: "start_session" | "prompt_session";
  state: AutomationCommandState;
  revision: number;
  attemptCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  lastSentAt?: number;
  acceptedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface AutomationExecution {
  executionId: string;
  automationId: string;
  /** Unique stable key `<automationId>:<scheduledFor>` used to reject duplicate ticks. */
  idempotencyKey: string;
  scheduledFor: number;
  /** Schedule revision and complete secret-free spec captured transactionally at claim time. */
  automationRevision: number;
  specSnapshot?: AutomationSpec;
  actionKind: AutomationAction["kind"];
  status: AutomationExecutionStatus;
  /** Legacy rows retain the original at-most-once boundary; v53 rows use the durable command
   * outbox and runner receipt journal. */
  deliveryMode?: "legacy_at_most_once" | "receipted_v53";
  actor: GovernanceActor;
  runnerId?: string;
  sessionId?: string;
  runId?: string;
  workflowInstanceId?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  commands?: AutomationCommandView[];
}

export type AutomationAuditEventKind =
  | "created"
  | "updated"
  | "enabled"
  | "disabled"
  | "deleted"
  | "execution_claimed"
  | "execution_status_changed"
  | "command_status_changed"
  | "trigger_created"
  | "trigger_rotated"
  | "trigger_deleted"
  | "trigger_invoked"
  | "misfire_skipped"
  | "concurrency_skipped";

export interface AutomationAuditEvent {
  eventId: number;
  automationId: string;
  executionId?: string;
  kind: AutomationAuditEventKind;
  actor: GovernanceActor;
  detail?: Record<string, WorkflowArtifactMetadataValue>;
  createdAt: number;
}

export interface CompleteWorkflowAttemptRequest {
  outcome: WorkflowNodeOutcome;
  /** Exact output-contract name to immutable workflow-artifact id. */
  outputs?: Record<string, string>;
  error?: string;
}

export interface ResolveWorkflowGateRequest {
  outcome: "success" | "failure";
}

/* ========================================================================== */
/* Runner <-> Control Plane (WebSocket)                                        */
/* ========================================================================== */

/* --- Runner -> Control Plane --- */

export interface RegisterMessage {
  type: "register";
  token: string;
  runner: RunnerMetadata;
  /** The PROTOCOL_VERSION this runner was built against, so the dashboard can flag a runner too
   * old for its features (version-skew badge). Absent ⇒ a pre-v15 runner. */
  protocolVersion?: number;
  /** Session ids the runner still has a live agent process for (reconnect resync). */
  liveSessions?: string[];
  /** Phase 2: full metadata for every session in the box's on-disk store, so any dashboard that
   * connects can hydrate sessions it didn't create. The control plane upserts these. */
  sessionSnapshots?: SessionSnapshot[];
}

export interface HeartbeatMessage {
  type: "heartbeat";
  runnerId: string;
  ts: number;
}

/** Runner reports a session lifecycle transition. */
export interface SessionStatusMessage {
  type: "session_status";
  sessionId: string;
  status: SessionStatus;
  detail?: string;
  /** Set once when the runner creates an isolated worktree for the session. */
  worktreePath?: string | null;
  /** Opaque identity of the accepted start_session command that owns this lifecycle. */
  controlPlaneLaunchId?: string;
}

export interface StopSessionResultMessage {
  type: "stop_session_result";
  sessionId: string;
  operationId: string;
  /** Added in v89. Identifies the exact durable delivery attempt within the stable operation. */
  deliveryAttemptId?: string;
  accepted: boolean;
  /** Bounded, provider-neutral rejection detail. Present only when accepted is false. */
  error?: string;
}

/** Hash-only binding for one per-session Claude policy-hook credential. The plaintext remains in a
 * protected runner-local file and is never sent over the runner socket or persisted in commands. */
export interface PolicyHookCredentialMessage {
  type: "policy_hook_credential";
  sessionId: string;
  tokenHash: string;
}

/** Cross-transport readiness fence: hooks wait for this binding acknowledgement before HTTP. */
export interface PolicyHookCredentialRegisteredMessage {
  type: "policy_hook_credential_registered";
  sessionId: string;
  tokenHash: string;
  accepted: boolean;
  error?: string;
}

/** Hash-only binding for one runner-minted, exact-session CLI/MCP credential. The plaintext stays
 * in a protected runner-local file and is never placed in argv or a durable command snapshot. */
export interface AgentControlCredentialMessage {
  type: "agent_control_credential";
  sessionId: string;
  tokenHash: string;
}

/** Secret-free registration acknowledgement used for operational diagnosis and future fencing. */
export interface AgentControlCredentialRegisteredMessage {
  type: "agent_control_credential_registered";
  sessionId: string;
  tokenHash: string;
  accepted: boolean;
  error?: string;
}

/** A live provider changed session-scoped controls/config. The full runner snapshot is
 * authoritative and lets reconnect hydration reuse the exact same persistence path. */
export interface SessionRuntimeUpdatedMessage {
  type: "session_runtime_updated";
  snapshot: SessionSnapshot;
}

/** Runner streams a normalized session event. In Phase 2 the runner owns the per-session `seq`
 * (and `ts`) so its on-disk log and every dashboard's cache agree; older runners omit them and the
 * control plane allocates a seq itself. */
export interface SessionEventMessage {
  type: "session_event";
  sessionId: string;
  payload: SessionEventPayload;
  seq?: number;
  ts?: number;
}

/** Runner replies to a SessionHistoryRequest with that session's event log (from its on-disk store). */
export interface SessionHistoryResultMessage {
  type: "session_history_result";
  requestId: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  /** Seq-ordered events the control plane hydrates into its cache. */
  events?: { seq: number; ts: number; payload: SessionEventPayload }[];
}

export type SessionHistoryPageErrorCode =
  | "history_epoch_changed"
  | "history_cursor_invalid"
  | "history_corrupt"
  | "history_event_too_large";

/** Protocol-v54 bounded history result. `throughSeq` and `logEpoch` freeze one continuation chain,
 * so concurrent appends wait for the next chain and a reset can never mix two log generations. */
export interface SessionHistoryPageResultMessage {
  type: "session_history_page_result";
  requestId: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  code?: SessionHistoryPageErrorCode;
  events?: { seq: number; ts: number; payload: SessionEventPayload }[];
  page?: {
    logEpoch: number;
    throughSeq: number;
    nextAfterSeq: number;
    hasMore: boolean;
  };
}

/** Runner's reply to a ReprocessSessionMessage: it re-read the original transcript with the current
 * parser and REPLACED the session's event log. The CP invalidates its cache and re-hydrates. */
export interface ReprocessSessionResultMessage {
  type: "reprocess_session_result";
  requestId: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  /** Refreshed snapshot (new seq high-water + preview) for the CP to update its cached row. */
  snapshot?: SessionSnapshot;
  /** The freshly re-parsed event log (seq-ordered) — the CP replaces its cache with this. */
  events?: { seq: number; ts: number; payload: SessionEventPayload }[];
  eventCount?: number;
}

/** Runner reports OS process status for a session's agent. */
export interface ProcessStatusMessage {
  type: "process_status";
  sessionId: string;
  processStatus: "starting" | "running" | "exited" | "error";
  pid?: number;
  exitCode?: number | null;
  message?: string;
}

/** Runner pushes a fresh discovery result (e.g. after a rediscover) without re-registering. */
export interface AgentsUpdatedMessage {
  type: "agents_updated";
  runnerId: string;
  agents: AgentDefinition[];
  /** Editors found by the same discovery pass (absent on pre-v22 runners). */
  editors?: EditorInfo[];
}

/** Event-driven or initial account-level provider usage update. The control plane validates the
 * runner binding and persists only this normalized, secret-free shape. */
export interface SubscriptionUsageUpdatedMessage {
  type: "subscription_usage_updated";
  snapshot: SubscriptionUsageSnapshot;
}

/** Authoritative replacement of one runner's complete provider-source inventory. */
export interface SubscriptionUsageInventoryMessage {
  type: "subscription_usage_inventory";
  runnerId: string;
  snapshots: SubscriptionUsageSnapshot[];
}

/** Correlated completion of one bounded, no-turn refresh request. */
export interface SubscriptionUsageRefreshResultMessage {
  type: "subscription_usage_refresh_result";
  requestId: string;
  ok: boolean;
  snapshots?: SubscriptionUsageSnapshot[];
  error?: string;
}

/** Runner reports the current queue of prompts waiting behind a session's running turn (ephemeral,
 * relayed to dashboards — never persisted). Sent whenever the queue changes (enqueue/dequeue/cancel);
 * an empty list means the queue drained. */
export interface SessionQueueMessage {
  type: "session_queue";
  sessionId: string;
  queue: QueuedPromptView[];
  /** Additive v71 marker; absence means the queue is not held (or the runner predates the marker). */
  held?: boolean;
  /** Additive v72 runner-assigned coordinate for the dequeued turn, when one is active. */
  activeTurnId?: string;
}

export type InterruptTurnResultReason =
  | "applied"
  | "session_not_found"
  | "turn_not_running"
  | "already_requested"
  | "stale_turn"
  | "cancel_failed";

/** Correlated v72 acknowledgement that the runner applied (or rejected) an interrupt request. */
export interface InterruptTurnResultMessage {
  type: "interrupt_turn_result";
  requestId: string;
  sessionId: string;
  applied: boolean;
  reason: InterruptTurnResultReason;
}

/** Correlated runner disposition for a v73 steering request. */
export interface SteerSessionResultMessage {
  type: "steer_session_result";
  requestId: string;
  submissionId: string;
  sessionId: string;
  /** Echo of the runner-owned active-turn coordinate supplied by the control plane. */
  turnId: string;
  disposition: SteerDisposition;
  reason: SteerResultReason;
  queuedPromptId?: string;
  providerTurnId?: string;
  message?: string;
}

/** Correlated acknowledgement for an explicit user resolution of uncertain steering delivery. */
export interface ResolveSteeringAttemptResultMessage {
  type: "resolve_steering_attempt_result";
  requestId: string;
  sessionId: string;
  submissionId: string;
  action: "queue_again" | "dismiss";
  applied: boolean;
  reason?: string;
  queuedPromptId?: string;
}

export interface ReadQueuedPromptResultMessage {
  type: "read_queued_prompt_result";
  requestId: string;
  sessionId: string;
  promptId: string;
  ok: boolean;
  prompt?: QueuedPromptDraft;
  reason?: QueuedPromptEditFailureReason;
  error?: string;
}

export interface EditQueuedPromptResultMessage {
  type: "edit_queued_prompt_result";
  requestId: string;
  submissionId: string;
  sessionId: string;
  promptId: string;
  applied: boolean;
  prompt?: QueuedPromptDraft;
  reason?: QueuedPromptEditFailureReason;
  error?: string;
}

export type DriverTelemetryMetric = "launch" | "resume" | "approval" | "crash" | "fallback";
export type DriverTelemetryOutcome = "success" | "failure" | "allowed" | "denied" | "cancelled" | "observed";
export type DriverTelemetryReason =
  | "fresh"
  | "process_restart"
  | "app_server_exit"
  | "agent_exit"
  | "explicit_exec"
  | "compatibility_exec";

/** Content-free operational observation. No session id, prompt, tool input, path, env, or auth. */
export interface DriverTelemetryMessage {
  type: "driver_telemetry";
  metric: DriverTelemetryMetric;
  driver: AgentDriverKind;
  version?: string;
  context: "native" | "wsl";
  outcome: DriverTelemetryOutcome;
  durationMs?: number;
  reason?: DriverTelemetryReason;
}

export type SessionNamingRunnerErrorCode =
  | "session_unavailable"
  | "account_unavailable"
  | "runner_outdated"
  | "harness_unavailable"
  | "model_unavailable"
  | "provider_unsupported"
  | "rate_limited"
  | "timed_out"
  | "provider_failed"
  | "invalid_result";

/** Classify why an advertised agent cannot execute Session Naming without conflating a missing
 * harness capability with authentication or billing-account drift. */
export function sessionNamingAgentFailureCode(
  agent: AgentDefinition | undefined,
): "harness_unavailable" | "account_unavailable" | null {
  if (!agent || agent.available === false) return "harness_unavailable";
  if (agent.authStatus !== "authenticated") return "account_unavailable";
  const driver = agent.driver ?? "acp";
  if (driver === "codex" || driver === "codex-app-server") {
    return agent.codexAppServer?.status === "supported" && agent.codexAppServer.sessionNaming === true
      ? null
      : "harness_unavailable";
  }
  if (driver === "claude-code") {
    if (agent.claudeCode?.status !== "ready" || agent.claudeCode.sessionNaming !== true) {
      return "harness_unavailable";
    }
    return agent.claudeCode.auth.status === "authenticated" ? null : "account_unavailable";
  }
  return "harness_unavailable";
}

export type SessionNamingRunnerFailurePhase =
  | "preflight"
  | "isolation"
  | "initialization"
  | "thread_start"
  | "turn_start"
  | "generation"
  | "output_validation";

/** Bounded runner-hosted title result. Provider output, diagnostics, paths, and identities stay local. */
export interface GenerateSessionTitleResultMessage {
  type: "generate_session_title_result";
  requestId: string;
  ok: boolean;
  title?: string;
  provider?: "codex" | "claude" | "custom";
  billingSource?: SessionNamingAccountBoundary["billingSource"];
  code?: SessionNamingRunnerErrorCode;
  /** Content-free stage at which a failed request stopped. */
  phase?: SessionNamingRunnerFailurePhase;
}

export type SessionNamingCustomModelOperation = "configure" | "delete_api_key" | "test";
export type SessionNamingCustomModelErrorCode =
  | "invalid_configuration"
  | "authentication_failed"
  | "endpoint_failed"
  | "timed_out"
  | "rate_limited"
  | "unavailable";

/** Correlated, secret-free acknowledgement for provisioning, deletion, and connection testing. */
export interface SessionNamingCustomModelResultMessage {
  type: "session_naming_custom_model_result";
  requestId: string;
  operation: SessionNamingCustomModelOperation;
  ok: boolean;
  status?: {
    configured: boolean;
    apiKeyConfigured: boolean;
    configDigest?: string;
  };
  code?: SessionNamingCustomModelErrorCode;
}

export type RunnerToControlPlane =
  | RegisterMessage
  | HeartbeatMessage
  | SessionStatusMessage
  | StopSessionResultMessage
  | PolicyHookCredentialMessage
  | AgentControlCredentialMessage
  | SessionRuntimeUpdatedMessage
  | SessionEventMessage
  | SessionHistoryResultMessage
  | SessionHistoryPageResultMessage
  | ReprocessSessionResultMessage
  | ListExternalSessionsResultMessage
  | AdoptSessionResultMessage
  | ListDirectoryResultMessage
  | ListSessionFilesResultMessage
  | ReadSessionFileResultMessage
  | ShellOpenResultMessage
  | ShellOutputMessage
  | ShellExitMessage
  | ShellSnapshotMessage
  | ShellInventoryCompleteMessage
  | ProcessStatusMessage
  | AgentsUpdatedMessage
  | SubscriptionUsageUpdatedMessage
  | SubscriptionUsageInventoryMessage
  | SubscriptionUsageRefreshResultMessage
  | SessionQueueMessage
  | InterruptTurnResultMessage
  | SteerSessionResultMessage
  | ResolveSteeringAttemptResultMessage
  | ReadQueuedPromptResultMessage
  | EditQueuedPromptResultMessage
  | SessionCommandInvocationResultMessage
  | SessionCommandInvocationUpdateMessage
  | DriverTelemetryMessage
  | GenerateSessionTitleResultMessage
  | SessionNamingCustomModelResultMessage
  | GitActionResultMessage
  | RewindResultMessage
  | ForkResultMessage
  | SessionWorktreeResultMessage
  | LogoutAgentResultMessage
  | AcpRegistryApprovalResultMessage
  | SkillsStateMessage
  | SkillsSyncNeedMessage
  | DurableSessionCommandResultMessage
  | DurableSessionCommandUpdateMessage
  | HostActionResultMessage;

/* --- Control Plane -> Runner --- */

export interface RegisteredMessage {
  type: "registered";
  ok: true;
  serverTime: number;
  heartbeatIntervalMs: number;
  /** The control-plane protocol version. Absent means a pre-negotiation control plane. */
  protocolVersion?: number;
}

export interface RegisterRejectedMessage {
  type: "register_rejected";
  reason: string;
}

/** Everything the runner needs to launch an agent session locally. */
export interface SessionLaunchSpec {
  sessionId: string;
  /** Opaque identity used to prove that an ambiguous replacement start reached the runner. */
  controlPlaneLaunchId?: string;
  workspaceId: string | null;
  workspacePath: string;
  agentId: string;
  /** Discovered CLI/adapter version used only as an operational telemetry dimension. */
  agentVersion?: string;
  /** Discovery-verified launch capabilities; the runner re-checks these before emitting CLI flags. */
  capabilities?: AgentCapabilities;
  /** Why exec is being used instead of the interactive app-server path (telemetry only). */
  codexExecFallbackReason?: "explicit_exec" | "compatibility_exec";
  /** Display title (so the box store — and other dashboards — can show it). */
  title?: string;
  titleSource?: SessionTitleSource;
  command: string;
  args: string[];
  env: Record<string, string>;
  useWorktree: boolean;
  executionTarget?: ExecutionTargetRef;
  /** Cloud-only, control-plane-resolved artifact/source references. */
  executionHandoff?: ExecutionHandoffRequest;
  /** Which driver to use. Absent ⇒ "acp" (back-compat). */
  driver?: AgentDriverKind;
  context?: AgentContext;
  config?: SessionConfig;
  /** ACP-only, additive in protocol v38. Contains references, never resolved secret values. */
  acpSessionContext?: AcpSessionContextConfig;
}

export interface StartSessionMessage {
  type: "start_session";
  spec: SessionLaunchSpec;
  /** Optional initial prompt to send once the ACP session is ready. */
  initialPrompt?: string;
  initialImages?: PromptImageInput[];
}

export interface PromptSessionMessage {
  type: "prompt_session";
  sessionId: string;
  text: string;
  images?: PromptImageInput[];
  /** Update model/effort/permission for this turn onward. */
  config?: SessionConfig;
  /** Slash command name (without leading "/") if this turn invokes one. */
  slashCommand?: string;
}

/** Attempt to incorporate direct input or one existing queue item into the exact active turn.
 * Runtime validation enforces exactly one input form: direct content or promotePromptId. */
export interface SteerSessionMessage {
  type: "steer_session";
  requestId: string;
  submissionId: string;
  sessionId: string;
  /** Runner-owned active-turn coordinate; stale requests fail closed. */
  turnId: string;
  text?: string;
  images?: PromptImageInput[];
  /** Stable queue identity only. Every promotion action still receives a fresh submissionId. */
  promotePromptId?: string;
}

/** Explicit user resolution for an uncertain delivery, or durable acknowledgement of rejection. */
export interface ResolveSteeringAttemptMessage {
  type: "resolve_steering_attempt";
  requestId: string;
  sessionId: string;
  submissionId: string;
  action: "queue_again" | "dismiss";
}

/** HTTP body for one explicit provider-command invocation. Name and execution mode are resolved
 * by the control plane from the current runner-authorized session catalog, never trusted here. */
export interface InvokeSessionCommandRequest {
  submissionId: string;
  providerCommandId: string;
  catalogRevision: string;
  argumentText: string;
}

/** Distinct durable lane for a manual provider command. A pre-v75 runner cannot accidentally
 * interpret this as an ordinary prompt and silently discard the receipt contract. */
export interface InvokeSessionCommandMessage {
  type: "invoke_session_command";
  requestId: string;
  invocationId: string;
  submissionId: string;
  payloadDigest: string;
  expiresAt: number;
  sessionId: string;
  providerCommandId: string;
  catalogRevision: string;
  expectedExecutionMode: SessionCommandExecutionMode;
  argumentText: string;
}

/** Direct acknowledgement for one transport attempt. Duplicate status comes only from the
 * runner's dedicated manual-command journal. */
export interface SessionCommandInvocationResultMessage {
  type: "session_command_invocation_result";
  requestId: string;
  invocationId: string;
  submissionId: string;
  sessionId: string;
  state: Exclude<SessionCommandInvocationState, "pending" | "sent">;
  revision: number;
  duplicate: boolean;
  error?: string;
  code?: SessionCommandInvocationErrorCode;
}

/** Monotonic lifecycle update replayed after reconnect until the CP has observed terminal state. */
export interface SessionCommandInvocationUpdateMessage {
  type: "session_command_invocation_update";
  invocationId: string;
  submissionId: string;
  sessionId: string;
  state: Exclude<SessionCommandInvocationState, "pending" | "sent">;
  revision: number;
  error?: string;
  code?: SessionCommandInvocationErrorCode;
  userEventSeq?: number;
}

/* --- Durable automation command delivery (protocol v53) --- */

export type DurableSessionCommand = StartSessionMessage | PromptSessionMessage;

/** A distinct outer message is load-bearing: a pre-v53 runner cannot execute the inner command
 * while silently ignoring its receipt contract. `requestId` changes on every transport attempt;
 * `commandId` and `payloadDigest` remain stable across retries. */
export interface DurableSessionCommandMessage {
  type: "durable_session_command";
  requestId: string;
  commandId: string;
  executionId: string;
  payloadDigest: string;
  expiresAt: number;
  command: DurableSessionCommand;
}

export type DurableSessionCommandState =
  | "accepted"
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "uncertain";

export type DurableSessionCommandErrorCode =
  | "COMMAND_ID_CONFLICT"
  | "COMMAND_EXPIRED"
  | "INVALID_COMMAND"
  | "SESSION_NOT_FOUND"
  | "QUEUE_FULL"
  | "COMMAND_CANCELLED"
  | "PROVIDER_AUTHENTICATION_REQUIRED"
  | "RECEIPT_STORE_FULL";

const DURABLE_SESSION_COMMAND_ERROR_CODES = {
  COMMAND_ID_CONFLICT: true,
  COMMAND_EXPIRED: true,
  INVALID_COMMAND: true,
  SESSION_NOT_FOUND: true,
  QUEUE_FULL: true,
  COMMAND_CANCELLED: true,
  PROVIDER_AUTHENTICATION_REQUIRED: true,
  RECEIPT_STORE_FULL: true,
} as const satisfies Record<DurableSessionCommandErrorCode, true>;

/** Runtime validation for receipt codes arriving over the wire. The exhaustive record above makes
 * a protocol-union addition fail typechecking until the runtime classification is updated too. */
export function isDurableSessionCommandErrorCode(value: unknown): value is DurableSessionCommandErrorCode {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DURABLE_SESSION_COMMAND_ERROR_CODES, value);
}

/** Direct response to one delivery attempt. The runner derives duplicate status from its durable
 * journal and never re-applies a matching command merely because the control plane retried. */
export interface DurableSessionCommandResultMessage {
  type: "durable_session_command_result";
  requestId: string;
  commandId: string;
  sessionId: string;
  state: DurableSessionCommandState;
  revision: number;
  duplicate: boolean;
  error?: string;
  code?: DurableSessionCommandErrorCode;
}

/** Unsolicited monotonic lifecycle update. A terminal update is replayed after reconnect until the
 * control-plane outbox observes it; delayed lower revisions cannot regress durable state. */
export interface DurableSessionCommandUpdateMessage {
  type: "durable_session_command_update";
  commandId: string;
  sessionId: string;
  state: DurableSessionCommandState;
  revision: number;
  error?: string;
  code?: DurableSessionCommandErrorCode;
  userEventSeq?: number;
}

export interface CancelSessionMessage {
  type: "cancel_session";
  sessionId: string;
}

/** Interrupt only the active turn. Unlike cancel_session, the session remains non-terminal and
 * queued prompts are preserved until a later explicit prompt resumes their FIFO. */
export interface InterruptTurnMessage {
  type: "interrupt_turn";
  sessionId: string;
  /** Optional for compatibility with the first v71 control plane; new callers correlate a result. */
  requestId?: string;
  /** Runner-assigned coordinate from the live queue overlay. Mismatches are rejected as stale. */
  turnId?: string;
}

/** Control plane asks the runner to drop ONE not-yet-started prompt from a session's queue (the
 * running turn is unaffected — it's already been dequeued). No-op if the id already ran. */
export interface CancelQueuedPromptMessage {
  type: "cancel_queued_prompt";
  sessionId: string;
  promptId: string;
}

/** Fetch the exact content of one mutable live queue entry. Queue projections remain bounded. */
export interface ReadQueuedPromptMessage {
  type: "read_queued_prompt";
  requestId: string;
  sessionId: string;
  promptId: string;
}

/** Atomically replace one queue entry without changing its identity or FIFO coordinate. */
export interface EditQueuedPromptMessage {
  type: "edit_queued_prompt";
  requestId: string;
  submissionId: string;
  sessionId: string;
  promptId: string;
  expectedRevision: string;
  text: string;
  images: PromptImageInput[];
}

export interface StopSessionMessage {
  type: "stop_session";
  sessionId: string;
  /** Added in v85. Older runners ignore this optional field and emit no correlated result. */
  operationId?: string;
  /** Added in v89. Older runners omit this from their result and therefore fail conservatively. */
  deliveryAttemptId?: string;
}

/** Re-arm runner-side governance after the user continues past a threshold. Values are absolute
 * next thresholds; omitted fields remain unchanged. Added in protocol v47. */
export interface RearmGovernanceMessage {
  type: "rearm_governance";
  sessionId: string;
  config: { costBudgetUsd?: number | null; maxToolCalls?: number | null };
  /** Another serialized rule is already tripped. Update thresholds but keep queued work held. */
  holdFor?: PolicyRuleKind;
}

export interface ResolvePermissionMessage {
  type: "resolve_permission";
  sessionId: string;
  requestId: string;
  /** optionId to select, or null to cancel. */
  optionId: string | null;
}

/** Answer a structured agent question (question_request). Answers are keyed by AgentQuestion.id
 * verbatim (for Claude that's the question text); multiSelect questions carry a label array. */
export interface AnswerQuestionMessage {
  type: "answer_question";
  sessionId: string;
  requestId: string;
  answers: Record<string, string | string[]>;
  /** Explicit UI intent distinguishes accepting an all-optional form from dismissing it.
   * Optional for rolling compatibility; absent peers retain the legacy empty-map convention. */
  action?: "submit" | "dismiss";
}

/** Restore a worktree session's FILES to the checkpoint taken before `turn` (T3-style rewind).
 * The agent conversation is not rewound — the next prompt continues the same thread against the
 * restored tree. Refused while a turn is running/queued. */
export interface RewindSessionMessage {
  type: "rewind_session";
  requestId: string;
  sessionId: string;
  turn: number;
  /** The caller's wait budget. A rewind that waited past it behind another worktree mutation
   * must EXPIRE (report failure, restore nothing) — the caller was already told it failed,
   * and executing later would silently mutate files under whatever ran meanwhile. */
  timeoutMs?: number;
}

export interface RewindResultMessage {
  type: "rewind_result";
  requestId: string;
  ok: boolean;
  error?: string;
}

/** Fork a completed provider conversation into a separate provider session and worktree. */
export interface ForkSessionMessage {
  type: "fork_session";
  requestId: string;
  sourceSessionId: string;
  targetSessionId: string;
  turn: number;
  title: string;
  /** Protocol v54+: omit the potentially unbounded inherited event array; the control plane pulls
   * the new session through session_history_page after materializing its snapshot. */
  deferHistory?: boolean;
}

export interface ForkResultMessage {
  type: "fork_result";
  requestId: string;
  ok: boolean;
  error?: string;
  snapshot?: SessionSnapshot;
  events?: { seq: number; ts: number; payload: SessionEventPayload }[];
}

/** Create, attach, or select the worktree targeted by a session's Git/file actions. The runner
 * revalidates all repository and configured-location boundaries. */
export type SessionWorktreeRequestMessage =
  | { type: "session_worktree"; requestId: string; sessionId: string; operation: "create"; baseRef?: string; branch: string }
  | { type: "session_worktree"; requestId: string; sessionId: string; operation: "attach" | "select" | "discard"; path: string };

export interface SessionWorktreeResultMessage {
  type: "session_worktree_result";
  requestId: string;
  ok: boolean;
  error?: string;
  worktree?: SessionWorktreeView;
  snapshot?: SessionSnapshot;
}

/** Control plane asks the runner to re-probe installed agents and push the result. */
export interface RediscoverMessage {
  type: "rediscover";
  runnerId: string;
}

/** Ask the runner to refresh provider-owned account usage without starting or interrupting a turn. */
export interface RefreshSubscriptionUsageMessage {
  type: "refresh_subscription_usage";
  requestId: string;
}

export interface SessionNamingPromptMessage {
  role: "user" | "assistant";
  text: string;
}

/** Metadata-only task for the exact runner session; the runner derives provider and account locally. */
export interface GenerateSessionTitleMessage {
  type: "generate_session_title";
  requestId: string;
  sessionId: string;
  /** Absent is the v93 session-account behavior. Custom endpoint execution requires protocol v94. */
  mode?: "session_agent_account" | "custom_model_endpoint";
  /** Protocol v95+: an explicit, secret-free target. Its live auth and capabilities are validated
   * again by the runner before invocation; omission retains v93 follow-session behavior. */
  target?: {
    agentId: string;
    driver: SessionNamingHarnessOption["driver"];
    model: string;
    effort: string;
  };
  messages: SessionNamingPromptMessage[];
  /** Complete runner-side wall-clock budget, clamped again by the runner. */
  timeoutMs: number;
}

export interface ConfigureSessionNamingCustomModelMessage {
  type: "configure_session_naming_custom_model";
  requestId: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  /** Write-only replacement. Omission preserves an existing runner-local key. */
  apiKey?: string;
}

export interface DeleteSessionNamingCustomModelKeyMessage {
  type: "delete_session_naming_custom_model_key";
  requestId: string;
}

export interface TestSessionNamingCustomModelMessage {
  type: "test_session_naming_custom_model";
  requestId: string;
}

export interface LogoutAgentMessage {
  type: "logout_agent";
  requestId: string;
  sessionId: string;
}

export interface LogoutAgentResultMessage {
  type: "logout_agent_result";
  requestId: string;
  ok: boolean;
  error?: string;
}

export type AcpRegistryApprovalAction = "approve" | "revoke";

/** A user-confirmed state transition for an exact Registry adapter version. The runner repeats all
 * policy and fingerprint checks; routing this message is never sufficient authorization alone. */
export interface AcpRegistryApprovalMessage {
  type: "acp_registry_approval";
  requestId: string;
  runnerId: string;
  agentId: string;
  schemaVersion: string;
  adapterVersion: string;
  action: AcpRegistryApprovalAction;
  confirmation: "explicit";
}

export interface AcpRegistryApprovalResultMessage {
  type: "acp_registry_approval_result";
  requestId: string;
  agentId: string;
  action: AcpRegistryApprovalAction;
  ok: boolean;
  error?: string;
}

/* --- Managed agent skills (protocol v90) --- */

/** Authoritative desired skill state for the whole machine. The runner reconciles against this
 * complete list; anything managed but absent here is removed. */
export interface SkillsSyncMessage {
  type: "skills_sync";
  runnerId: string;
  /** Present when sent via requestFromRunner; fire-and-forget push syncs omit it. */
  requestId?: string;
  skills: SkillSyncEntry[];
}

/** Content-free authoritative desired state. Receiving this frame starts (and supersedes) an
 * ephemeral transaction; it never authorizes reconciliation by itself. */
export interface SkillsSyncManifestMessage {
  type: "skills_sync_manifest";
  runnerId: string;
  syncId: string;
  requestId?: string;
  skills: Array<Omit<SkillSyncEntry, "files">>;
}

/** Runner request for the exact desired digests absent from its verified local store. */
export interface SkillsSyncNeedMessage {
  type: "skills_sync_need";
  runnerId: string;
  syncId: string;
  missing: Array<Pick<SkillSyncEntry, "name" | "versionDigest">>;
}

/** One independently bounded and digest-validated skill version. */
export interface SkillsSyncContentMessage {
  type: "skills_sync_content";
  runnerId: string;
  syncId: string;
  name: string;
  versionDigest: string;
  files: SkillFile[];
}

/** Transaction fence. The runner reconciles only when every manifest digest is available. */
export interface SkillsSyncCompleteMessage {
  type: "skills_sync_complete";
  runnerId: string;
  syncId: string;
}

/** Authoritative full replacement of one machine's deployed and unmanaged skill inventory plus its
 * current reconcile error. `removals` is the event exception documented below. Sent as the
 * correlated reply to a solicited sync and unsolicited after push syncs or discovery-time rescans. */
export interface SkillsStateMessage {
  type: "skills_state";
  runnerId: string;
  /** Echoes SkillsSyncMessage.requestId when this state answers a solicited sync. */
  requestId?: string;
  deployed: DeployedSkillState[];
  unmanaged: UnmanagedSkillInfo[];
  /** Link removals from this exact reconcile pass. This is an event, not replacement inventory:
   * the control plane retains the latest non-empty array across later empty/omitted reports and
   * timestamps it independently. Older runners omit this additive field. */
  removals?: SkillLinkRemoval[];
  error?: string;
}

/* --- Git / PR workflow (operates on a session's worktree) --- */

/** A git/PR action the control plane asks a runner to run in a session worktree. */
export type GitAction =
  | { kind: "status" }
  | { kind: "summary" }
  | { kind: "diff"; scope: GitDiffScope }
  /** `all` forces the legacy commit-everything (`git add -A`) even when hunks are staged.
   * `expectStaged` is the client's belief about whether anything is staged — when it no longer
   * matches reality the runner refuses with GIT_STALE instead of committing a different set
   * than the button promised. */
  | { kind: "commit"; message: string; all?: boolean; expectStaged?: boolean }
  | { kind: "open_pr"; title: string; body: string; branch?: string; message?: string }
  /** Stage or unstage ONE hunk in the index. Identity = the parse-order hunk index within the
   * file, valid only against the exact uncommitted diff the client saw (`diffHash`) — the runner
   * re-reads and rejects with GIT_STALE when the worktree moved. */
  | { kind: "stage_hunk"; direction: "stage" | "unstage"; filePath: string; hunkIndex: number; diffHash: string }
  /** Stage selected +/- lines from the canonical unstaged pane, or unstage selected +/- lines
   * from the canonical staged pane. `lineIndices` address the source hunk returned by that pane. */
  | {
      kind: "stage_lines";
      direction: "stage" | "unstage";
      filePath: string;
      hunkIndex: number;
      lineIndices: number[];
      diffHash: string;
    }
  /** Destructively restore one tracked file to HEAD (including index state). Untracked files are
   * deliberately rejected because their content is not rendered or covered by the diff hash. */
  | { kind: "discard_file"; filePath: string; diffHash: string }
  /** Same-runner pod reconciliation. The runner resolves the source path from its own session
   * metadata; callers never supply an arbitrary filesystem path. */
  | { kind: "pod_reconcile"; sourceSessionId: string; message: string }
  /** Read-only import/reconciliation of review threads for the PR associated with HEAD. */
  | { kind: "github_review_sync" };

export interface GitActionRequestMessage {
  type: "git_action";
  /** Correlates the runner's git_result back to this request. */
  requestId: string;
  sessionId: string;
  /** Absolute linked-worktree path recorded by the control plane. Omitted only for status/summary
   * on a primary-checkout session; the runner then resolves its authoritative session repoPath. */
  worktreePath?: string;
  action: GitAction;
  /** How long the control plane waits for this request. The runner uses it to EXPIRE a queued
   * MUTATION whose caller has already been told it failed — a late commit executing after a
   * 504 would silently diverge history from what the UI reported. */
  timeoutMs?: number;
}

/* --- Host actions (open in editor / reveal in file manager, on the runner host) --- */

export type HostAction =
  | { kind: "open_editor"; editorId: string }
  | { kind: "open_editor_location"; editorId: string; location: EditorSourceLocation }
  | { kind: "reveal" };

export interface HostActionMessage {
  type: "host_action";
  requestId: string;
  /** Resolve the target from this session's root (worktree ?? repo) — like files/shells. */
  sessionId?: string;
  /** Explicit absolute path (project-level reveal). Wins over sessionId when both are set. */
  path?: string;
  action: HostAction;
}

export interface HostActionResultMessage {
  type: "host_action_result";
  requestId: string;
  ok: boolean;
  error?: string;
}

/** Phase 2: control plane asks the runner for a session's event history (events with seq > afterSeq),
 * to lazily hydrate the timeline of a session it didn't create. Runner replies with a
 * SessionHistoryResultMessage echoing requestId. Reuses the git_action request/response pattern. */
export interface SessionHistoryRequestMessage {
  type: "session_history";
  requestId: string;
  sessionId: string;
  afterSeq: number;
}

/** Protocol-v54 seekable, count/byte-bounded runner history page. The first request omits the
 * frozen fields; every continuation echoes the result's logEpoch and throughSeq exactly. */
export interface SessionHistoryPageRequestMessage {
  type: "session_history_page";
  requestId: string;
  sessionId: string;
  afterSeq: number;
  limit: number;
  logEpoch?: number;
  throughSeq?: number;
}

/** Phase 2: permanently delete a session from the box store (the source of truth). Without this the
 * runner would resurrect a UI-deleted session on its next register via sessionSnapshots. */
export interface DeleteSessionMessage {
  type: "delete_session";
  sessionId: string;
}

/* ========================================================================== */
/* Phase 3: external (CLI-started) sessions                                    */
/* ========================================================================== */

/** A session the runner host found on disk that Wollipog did not create — started in the bare
 * `claude` / `codex` CLI or another compatible client. Resumable by `agentSessionId`. */
export interface ExternalSessionDescriptor {
  /** The agent-native resumable id (`claude --resume <id>` / `codex exec resume <id>`). */
  agentSessionId: string;
  /** Exact configured ACP adapter that listed this session. Absent for native transcript stores and
   * pre-v35 runners. Adoption must re-query this adapter instead of trusting descriptor fields. */
  agentId?: string;
  driver: AgentDriverKind;
  /** Working directory the session ran in (its repo). */
  cwd: string;
  /** Execution context the session lives in (native host or a WSL distro). */
  context: AgentContext;
  /** Best-effort display title (first user message), may be empty if unparseable. */
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Approx. message count (for the list view); 0 if the transcript couldn't be parsed. */
  messageCount: number;
  /** Whether the box has a matching native agent, or the exact ACP adapter negotiated resume/load.
   * false ⇒ adopting still works but lands as read-only history. Absent (pre-v15 runner) ⇒ assume resumable. */
  resumable?: boolean;
}

/** Phase 3: control plane asks the runner to enumerate external CLI sessions on the box (lazy,
 * on-demand — the list can be large). Runner replies with ListExternalSessionsResultMessage. */
export interface ListExternalSessionsRequestMessage {
  type: "list_external_sessions";
  requestId: string;
  /** Optional exact runner-advertised agent to scan. Older runners ignore this and return all
   * sessions, so callers must still filter the result before presenting it. */
  agentId?: string;
}

export interface ListExternalSessionsResultMessage {
  type: "list_external_sessions_result";
  requestId: string;
  ok: boolean;
  error?: string;
  sessions?: ExternalSessionDescriptor[];
}

/** Phase 3: adopt an external session into the box store under `sessionId`, so it becomes a normal
 * box-owned (hydratable, resumable) session. `backfill` requests the prior transcript be parsed into
 * the event log (best-effort). */
export interface AdoptSessionMessage {
  type: "adopt_session";
  /** Present for protocol-v35 authoritative ACP adoption; omitted by legacy fire-and-forget peers. */
  requestId?: string;
  sessionId: string;
  descriptor: ExternalSessionDescriptor;
  backfill: boolean;
}

export interface AdoptSessionResultMessage {
  type: "adopt_session_result";
  requestId: string;
  ok: boolean;
  error?: string;
  /** Runner-revalidated descriptor and persisted row; never copied from the client request. */
  descriptor?: ExternalSessionDescriptor;
  snapshot?: SessionSnapshot;
}

/** Re-import an adopted session: re-read its original CLI transcript with the current parser and
 * REPLACE the stored event log, so parser/formatting improvements apply to already-adopted sessions.
 * The runner replies with a ReprocessSessionResultMessage echoing requestId. */
export interface ReprocessSessionMessage {
  type: "reprocess_session";
  requestId: string;
  sessionId: string;
  /** Protocol v54+: omit the potentially unbounded replacement event array. */
  deferHistory?: boolean;
}

/** Browse the runner machine's filesystem to pick a workspace directory. `path` empty ⇒ $HOME. */
export interface ListDirectoryRequestMessage {
  type: "list_directory";
  requestId: string;
  /** Native host, or a specific WSL distro. Absent ⇒ native. */
  context?: AgentContext;
  path: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface ListDirectoryResultMessage {
  type: "list_directory_result";
  requestId: string;
  ok: boolean;
  error?: string;
  /** The resolved absolute path that was listed, and its parent (null at the root). */
  path?: string;
  parent?: string | null;
  entries?: DirectoryEntry[];
}

/** One entry in a session-root file listing. `path` is RELATIVE to the session root (POSIX-style
 * `/` separators on the wire regardless of host OS) so the dashboard never handles absolute
 * box paths. */
export interface SessionFileEntry {
  name: string;
  /** Root-relative path with `/` separators, e.g. "src/components/App.tsx". */
  path: string;
  isDir: boolean;
  /** File size in bytes; absent for directories (and when the WSL stat is unavailable). */
  size?: number;
}

/** Files panel: list one directory level under a session's root (worktreePath ?? repoPath — the
 * runner resolves it from box meta; the dashboard only ever names root-relative paths). `path`
 * empty ⇒ the root itself. Runner replies with ListSessionFilesResultMessage. */
export interface ListSessionFilesRequestMessage {
  type: "list_session_files";
  requestId: string;
  sessionId: string;
  /** Root-relative directory to list ("" = session root). */
  path: string;
}

export interface ListSessionFilesResultMessage {
  type: "list_session_files_result";
  requestId: string;
  ok: boolean;
  error?: string;
  /** Echo of the (normalized) root-relative directory that was listed. */
  path?: string;
  entries?: SessionFileEntry[];
}

/** Files panel: read one file under a session's root. Content is UTF-8 text, capped runner-side
 * (`truncated` marks a partial read); binary files return `binary: true` with no content. */
export interface ReadSessionFileRequestMessage {
  type: "read_session_file";
  requestId: string;
  sessionId: string;
  /** Root-relative file path. */
  path: string;
}

/* --------------------------- per-session shells --------------------------- */

export type ShellKind = "shell" | "agent_tui";
export type ShellStatus = "running" | "reconnecting" | "exited";

export interface ShellOutputChunk {
  /** Runner-monotonic within one shell lifetime. Duplicate replay is idempotent at the CP. */
  seq: number;
  stream: "stdout" | "stderr";
  data: string;
}

/** Durable shell metadata. Output bodies use the bounded history page rather than this list DTO. */
export interface ShellView {
  shellId: string;
  sessionId: string;
  name: string;
  createdAt: number;
  /** A real PTY backs this shell (xterm renderer + raw keystrokes). Absent/false ⇒ pipe mode. */
  pty?: boolean;
  /** Ordinary shell or an explicitly separate provider TUI process. */
  kind?: ShellKind;
  /** Reconnecting never means exited: input waits for authoritative runner inventory. */
  status?: ShellStatus;
  exitCode?: number | null;
  updatedAt?: number;
  outputStartSeq?: number;
  outputEndSeq?: number;
  outputTruncated?: boolean;
}

export interface ShellHistoryPage {
  shellId: string;
  chunks: ShellOutputChunk[];
  nextAfter: number;
  hasMore: boolean;
  /** True when retention removed at least one chunk before the returned range. */
  truncatedBefore: boolean;
}

/** Open a persistent shell or separately spawned provider TUI process in the session's root
 * (worktreePath ?? repoPath, resolved by the runner from box meta). POSIX/WSL use util-linux
 * `script`; Windows native uses ConPTY when supported by the runner. */
export interface ShellOpenMessage {
  type: "shell_open";
  requestId: string;
  sessionId: string;
  shellId: string;
  name?: string;
  createdAt?: number;
  kind?: ShellKind;
  /** True only for the Agent TUI opened atomically by create-session. Manual attachments omit
   * this field and retain the pre-v67 immediate-open behavior. */
  fenceStart?: true;
  /** Initial terminal size (PTY shells; ignored in pipe mode). Runner clamps to sane bounds. */
  cols?: number;
  rows?: number;
}

export interface ShellOpenResultMessage {
  type: "shell_open_result";
  requestId: string;
  ok: boolean;
  error?: string;
  /** Whether a real PTY was allocated (dashboards pick renderer/input mode on this). */
  pty?: boolean;
}

/** Best-effort terminal resize (PTY shells; no-op in pipe mode). Fire-and-forget like input. */
export interface ShellResizeMessage {
  type: "shell_resize";
  shellId: string;
  cols: number;
  rows: number;
}

/** Raw stdin passthrough — the dashboard sends whole input lines (with trailing newline). */
export interface ShellInputMessage {
  type: "shell_input";
  shellId: string;
  data: string;
}

export interface ShellCloseMessage {
  type: "shell_close";
  shellId: string;
}

/** Streamed shell output (runner→CP→UI). The CP durably retains a bounded replay tail. */
export interface ShellOutputMessage {
  type: "shell_output";
  sessionId: string;
  shellId: string;
  stream: "stdout" | "stderr";
  data: string;
  /** Present on v57+ runners; omitted by rolling-compatible older runners. */
  seq?: number;
}

/** The shell process exited (command `exit`, kill, or runner-side close). `code` null when
 * killed by signal / unknown. */
export interface ShellExitMessage {
  type: "shell_exit";
  sessionId: string;
  shellId: string;
  code: number | null;
  /** Last runner output sequence observed before exit. */
  outputSeq?: number;
}

/** Bounded runner replay for one retained live/exited terminal after transport reconnect. */
export interface ShellSnapshotMessage {
  type: "shell_snapshot";
  sessionId: string;
  shellId: string;
  name: string;
  createdAt: number;
  pty: boolean;
  kind: ShellKind;
  status: Exclude<ShellStatus, "reconnecting">;
  exitCode: number | null;
  outputStartSeq: number;
  outputEndSeq: number;
  outputTruncated: boolean;
  chunks: ShellOutputChunk[];
}

/** Authoritative fence: retained active rows absent from shellIds are no longer alive. */
export interface ShellInventoryCompleteMessage {
  type: "shell_inventory_complete";
  shellIds: string[];
}

export interface ReadSessionFileResultMessage {
  type: "read_session_file_result";
  requestId: string;
  ok: boolean;
  error?: string;
  path?: string;
  content?: string;
  /** Full size in bytes (may exceed the returned content when truncated). */
  size?: number;
  truncated?: boolean;
  binary?: boolean;
}

export interface GitFileChange {
  /** Porcelain status code, e.g. "M", "A", "??", "D". */
  status: string;
  path: string;
}

/** Additive protocol-v76 facts shared by status and summary. A missing property means a pre-v76 or
 * rolling-skew producer omitted it. A present null means the v76 runner checked and the fact is
 * unavailable (for example an unborn HEAD, no upstream, or no remote-tracking refs). */
export interface GitRepositoryFacts {
  branch: string;
  hasChanges: boolean;
  /** Commits ahead of baseRef when available, otherwise ahead of the configured upstream. This
   * preserves the pre-v76 upstream fallback; 0 only when neither comparison is available. */
  ahead: number;
  remoteUrl: string | null;
  /** Short HEAD object id, or null for an unborn or unresolvable HEAD. */
  headSha?: string | null;
  detached?: boolean;
  /** Configured upstream (for example origin/feature), or null when absent or stale. */
  upstreamBranch?: string | null;
  /** Atomic left/right counts for @{upstream}...HEAD, or null together when unavailable. */
  aheadUpstream?: number | null;
  behindUpstream?: number | null;
  /** Default-branch comparison ref. Existing ahead and behind use it when present and retain their
   * legacy configured-upstream fallback when it is absent. */
  baseRef?: string | null;
  worktreeKind?: "primary" | "linked";
  /** True or false when Git can answer; null when the installed Git cannot report shallow state. */
  shallow?: boolean | null;
  /** Raw porcelain categories overlap intentionally: a conflicted path can also be staged and/or
   * modified. Counts are paths, not mutually-exclusive buckets. */
  stagedCount?: number;
  modifiedCount?: number;
  untrackedCount?: number;
  conflictedCount?: number;
  operation?: "merge" | "rebase" | "cherry_pick" | "revert" | "bisect" | null;
  /** Unix epoch milliseconds for the newest observable write to the repository's shared
   * remote-tracking ref state (loose refs/remotes or packed-refs), or null when unavailable. */
  remoteRefsAt?: number | null;
}

export interface GitStatusInfo extends GitRepositoryFacts {
  branch: string;
  files: GitFileChange[];
  /** True when files is capped for transport; aggregate counts and hasChanges still cover all paths. */
  filesTruncated?: boolean;
  hasChanges: boolean;
  /** Commits ahead of the upstream/base (0 if unknown). */
  ahead: number;
  remoteUrl: string | null;
  /** Paths whose porcelain X column reports index state; overlaps conflictedCount intentionally. */
  stagedCount?: number;
  /** Working-tree line totals vs HEAD (`git diff HEAD --numstat`, staged + unstaged, tracked
   * files only — binary rows don't count). Omitted by pre-v20 runners. */
  addedLines?: number;
  deletedLines?: number;
}

export interface GitCommitInfo {
  sha: string;
  message: string;
  filesChanged: number;
  /** True when the commit took only the staged set (no `git add -A`). */
  stagedOnly?: boolean;
}

/* --- Git summary (pinned summary card: PR + checks at a glance) --- */

/** The open PR for the session branch, from `gh pr view`. */
export interface GitPrSummary {
  number: number;
  title: string;
  url: string;
  /** gh's PR state vocabulary: OPEN | MERGED | CLOSED. */
  state: string;
}

/** Check rollup for that PR (CheckRuns + commit StatusContexts combined). */
export interface GitChecksSummary {
  failing: number;
  pending: number;
  passing: number;
  /** Names of the failing checks (bounded) — feeds the "Fix" prompt. */
  failingNames: string[];
  /** The PR's checks tab, when the PR is known. */
  url: string | null;
}

/**
 * One read powering the pinned summary: branch/ahead-behind/line totals plus the PR and its
 * checks. PR/checks come from `gh` on the runner and are TTL-cached there; they are null when
 * gh is missing, unauthenticated, or the branch has no PR — never an error.
 */
export interface GitSummaryInfo extends GitRepositoryFacts {
  branch: string;
  ahead: number;
  behind: number;
  hasChanges: boolean;
  addedLines: number;
  deletedLines: number;
  remoteUrl: string | null;
  pr: GitPrSummary | null;
  checks: GitChecksSummary | null;
}

/* --- Rich diff / review pane (PR-A, read-only) --- */

/**
 * Which change-set a diff request covers:
 *   uncommitted - working tree + index vs HEAD, plus untracked files (name-only).
 *   all_branch  - the session branch vs its merge-base with the default branch.
 *   last_turn   - the worktree vs the snapshot taken at the start of the most recent prompt turn.
 */
export type GitDiffScope = "uncommitted" | "all_branch" | "last_turn";

/** One line of a unified diff, in symbol form. `status` is the leading column:
 * ' ' = context, '+' = added, '-' = removed. `text` excludes that leading symbol. */
export interface GitDiffLine {
  status: " " | "+" | "-";
  text: string;
}

/** A single `@@ … @@` hunk of a file diff. Counts/starts come from the hunk header. */
export interface GitHunk {
  /** The raw `@@ -a,b +c,d @@` header line (with any trailing section heading). */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: GitDiffLine[];
  /** True when the file's final line has no trailing newline (git's "\ No newline at end of file"). */
  noNewlineAtEof?: boolean;
  /** Uncommitted scope only: this exact hunk (same HEAD-side position + byte-identical lines) is in the index. */
  staged?: boolean;
}

/** A per-file diff. `hunks` is empty for pure renames, mode-only changes, and binaries. */
export interface GitDiffFile {
  path: string;
  /** Source path for a rename/copy; absent otherwise. */
  oldPath?: string;
  /** Change kind: modify | add | delete | rename | untracked (working-tree file not in HEAD). */
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  binary: boolean;
  hunks: GitHunk[];
}

/** Aggregate change stats for a diff, mirroring `git diff --shortstat`. */
export interface GitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** The parsed result of a diff request — the files, a content hash, and summary stats. */
export interface GitDiffInfo {
  scope: GitDiffScope;
  files: GitDiffFile[];
  /** Protocol v50+, uncommitted scope only: canonical HEAD->index and index->worktree panes.
   * The combined `files` field remains for compatibility and branch/last-turn scopes. */
  stagedFiles?: GitDiffFile[];
  unstagedFiles?: GitDiffFile[];
  /** sha256 (hex) over the normalized raw diff text plus, for the uncommitted scope ONLY, a
   * name-only manifest of untracked files (other scopes carry untracked content inside the raw
   * diff itself) — a stable identity for the change-set, used to detect a stale diff before
   * per-hunk staging. */
  diffHash: string;
  /** Protocol v50+, uncommitted scope only: sha256 over combined, staged, unstaged, and untracked
   * manifests. Fine-grained mutations use this stronger identity; `diffHash` remains stable across
   * index-only movement for legacy multi-hunk staging and durable review anchors. */
  fineDiffHash?: string;
  /** Protocol v51+, pane-local anchor identities. A finding authored in one canonical pane must
   * not be attached to the same numeric line in the other pane. */
  stagedDiffHash?: string;
  unstagedDiffHash?: string;
  stats: GitDiffStats;
  stagedStats?: GitDiffStats;
  unstagedStats?: GitDiffStats;
}

export interface GitPrInfo {
  /** PR URL (from gh) or a prefilled compare URL fallback. */
  url: string;
  branch: string;
  pushed: boolean;
  /** True when `gh` created a real PR; false when we returned a compare URL. */
  createdWithGh: boolean;
}

/** One top-level GitHub PR review thread. Replies remain remote context and do not become
 * duplicate local findings. Timestamps are epoch milliseconds. */
export interface GitHubReviewThread {
  threadId: string;
  commentId: number;
  url: string;
  path: string;
  side: ReviewFindingSide;
  line: number;
  body: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  commitId: string;
  subjectType: "line" | "file";
  resolved: boolean;
  outdated: boolean;
}

/** Authoritative, complete read of the current branch's GitHub review threads. */
export interface GitHubReviewSyncInfo {
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  pullRequestHeadOid: string;
  pullRequestBaseOid: string;
  localHeadOid: string;
  /** all_branch diff identity, usable as an inline anchor only when localHeadOid matches the PR. */
  diffHash: string;
  threads: GitHubReviewThread[];
  synchronizedAt: number;
}

export interface GitHubReviewReconciliation {
  imported: number;
  updated: number;
  resolved: number;
  reopened: number;
  dismissedMissing: number;
}

/** Result of a git action, keyed by which action ran. */
export interface GitActionData {
  status?: GitStatusInfo;
  summary?: GitSummaryInfo;
  diff?: GitDiffInfo;
  commit?: GitCommitInfo;
  pr?: GitPrInfo;
  githubReview?: GitHubReviewSyncInfo;
  podReconciliation?: {
    status: "applied" | "already_applied" | "conflicted";
    sourceHead: string;
    targetHead: string;
    mergeBase: string;
    resultHead?: string;
    conflictPaths?: string[];
  };
  reviewFindings?: ReviewFindingsResponse;
  reviewReconciliation?: GitHubReviewReconciliation;
}

/** Machine-readable failure classes handled across the runner/control-plane/UI boundary. */
export type GitErrorCode = "GIT_STALE" | "GIT_APPLY_FAILED" | "GIT_NO_REPOSITORY";

export interface GitActionResultMessage {
  type: "git_result";
  requestId: string;
  ok: boolean;
  error?: string;
  /** Present for failures the UI handles specially (stale diff / index conflict → refetch). */
  code?: GitErrorCode;
  data?: GitActionData;
}

export type ControlPlaneToRunner =
  | RegisteredMessage
  | RegisterRejectedMessage
  | PolicyHookCredentialRegisteredMessage
  | AgentControlCredentialRegisteredMessage
  | StartSessionMessage
  | PromptSessionMessage
  | SteerSessionMessage
  | ResolveSteeringAttemptMessage
  | InvokeSessionCommandMessage
  | DurableSessionCommandMessage
  | CancelSessionMessage
  | InterruptTurnMessage
  | CancelQueuedPromptMessage
  | ReadQueuedPromptMessage
  | EditQueuedPromptMessage
  | StopSessionMessage
  | RearmGovernanceMessage
  | ResolvePermissionMessage
  | AnswerQuestionMessage
  | RewindSessionMessage
  | ForkSessionMessage
  | SessionWorktreeRequestMessage
  | RediscoverMessage
  | RefreshSubscriptionUsageMessage
  | GenerateSessionTitleMessage
  | ConfigureSessionNamingCustomModelMessage
  | DeleteSessionNamingCustomModelKeyMessage
  | TestSessionNamingCustomModelMessage
  | LogoutAgentMessage
  | AcpRegistryApprovalMessage
  | SkillsSyncMessage
  | SkillsSyncManifestMessage
  | SkillsSyncContentMessage
  | SkillsSyncCompleteMessage
  | GitActionRequestMessage
  | SessionHistoryRequestMessage
  | SessionHistoryPageRequestMessage
  | DeleteSessionMessage
  | ListExternalSessionsRequestMessage
  | AdoptSessionMessage
  | ReprocessSessionMessage
  | ListDirectoryRequestMessage
  | ListSessionFilesRequestMessage
  | ReadSessionFileRequestMessage
  | ShellOpenMessage
  | ShellInputMessage
  | ShellResizeMessage
  | ShellCloseMessage
  | HostActionMessage;

/* ========================================================================== */
/* Control Plane -> UI (WebSocket live stream)                                 */
/* ========================================================================== */

export interface UiSnapshotMessage {
  type: "snapshot";
  /** Additive UI-channel capabilities. Absent on older control planes. */
  capabilities?: {
    sessionSubscriptions?: boolean;
    boundedDelivery?: boolean;
    paginatedSessionHistory?: boolean;
    /** The snapshot carries an authoritative durable Project inventory and live Project events. */
    projects?: boolean;
    /** The control plane can register a browsed folder as a new Project Location. */
    createProjectLocations?: boolean;
    /** Project and Location creation/settings support explicit, preflighted access scopes. */
    accessScopeManagement?: boolean;
    /** New Session can atomically create a session and open its separate provider TUI. */
    nativeTuiLaunch?: boolean;
    /** Archive keeps nonterminal sessions visible until durable Stop evidence releases capacity. */
    stopBeforeArchive?: boolean;
    /** Durable Stop operations expose bounded failure metadata and an idempotent recovery API. */
    stopFailureRecovery?: boolean;
    /** Per-user durable session reminders and scoped live reminder events are available. */
    sessionReminders?: boolean;
  };
  runners: RunnerView[];
  boxes: BoxView[];
  sessions: SessionView[];
  /** Optional for rolling compatibility with control planes predating durable Projects. */
  projects?: ProjectView[];
  /** Current user's pending and recently fired reminders. Absent on older control planes. */
  reminders?: SessionReminderView[];
  runs: RunView[];
  /** Optional only for compatibility with pre-pod control planes. */
  pods?: PodView[];
}

export interface UiRunnerUpsertMessage {
  type: "runner_upsert";
  runner: RunnerView;
}

export interface UiRunnerRemovedMessage {
  type: "runner_removed";
  runnerId: string;
}

export interface UiBoxUpsertMessage {
  type: "box_upsert";
  box: BoxView;
}

export interface UiBoxRemovedMessage {
  type: "box_removed";
  boxId: string;
}

export interface UiSessionUpsertMessage {
  type: "session_upsert";
  session: SessionView;
}

export interface UiSessionRemovedMessage {
  type: "session_removed";
  sessionId: string;
}

export interface UiSessionReminderUpsertMessage {
  type: "session_reminder_upsert";
  /** Exact reminder owner used by the control plane's fail-closed fan-out boundary. */
  userId: string;
  reminder: SessionReminderView;
}

export interface UiSessionReminderRemovedMessage {
  type: "session_reminder_removed";
  /** Exact reminder owner used by the control plane's fail-closed fan-out boundary. */
  userId: string;
  sessionId: string;
}

export interface UiProjectUpsertMessage {
  type: "project_upsert";
  project: ProjectView;
}

export interface UiProjectRemovedMessage {
  type: "project_removed";
  projectId: string;
}

export interface UiSessionEventMessage {
  type: "session_event";
  event: SessionEvent;
}

/** A session's whole event log was replaced (e.g. by reprocess/re-import). Dashboards drop their
 * cached events for the session and adopt this set — appended live events would otherwise duplicate
 * against the box's freshly re-issued ids. */
export interface UiSessionEventsResetMessage {
  type: "session_events_reset";
  sessionId: string;
  /** Generation of this replacement. Optional for rolling compatibility with older senders. */
  eventEpoch?: number;
  events: SessionEvent[];
}

/** Live shell output relayed to dashboards; bounded durable history is hydrated separately. */
export interface UiShellOutputMessage {
  type: "shell_output";
  sessionId: string;
  shellId: string;
  stream: "stdout" | "stderr";
  data: string;
  seq?: number;
}

export interface UiShellExitMessage {
  type: "shell_exit";
  sessionId: string;
  shellId: string;
  code: number | null;
  outputSeq?: number;
}

/** Runner inventory is now authoritative; mounted docks refresh metadata and bounded history. */
export interface UiShellRegistryReconciledMessage {
  type: "shell_registry_reconciled";
  runnerId: string;
  sessionIds: string[];
}

export interface UiRunUpsertMessage {
  type: "run_upsert";
  run: RunView;
}

export interface UiRunRemovedMessage {
  type: "run_removed";
  runId: string;
}

export interface UiPodUpsertMessage {
  type: "pod_upsert";
  pod: PodView;
}

export interface UiPodRemovedMessage {
  type: "pod_removed";
  podId: string;
}

export interface UiPodContextEntryMessage {
  type: "pod_context_entry";
  entry: PodContextEntry;
}

/** Confirms that the server has atomically replaced this socket's high-volume stream selection.
 * The browser performs a cursor fetch after this ordered acknowledgement, closing the race between
 * navigation over the WebSocket and history hydration over a separate HTTP connection. */
export interface UiSessionSubscriptionsAppliedMessage {
  type: "session_subscriptions_applied";
  revision: number;
  /** Exact authorized selection accepted by the control plane. */
  sessionIds: string[];
  podIds: string[];
}

export type ControlPlaneToUi =
  | UiSnapshotMessage
  | UiRunnerUpsertMessage
  | UiRunnerRemovedMessage
  | UiBoxUpsertMessage
  | UiBoxRemovedMessage
  | UiSessionUpsertMessage
  | UiSessionRemovedMessage
  | UiSessionReminderUpsertMessage
  | UiSessionReminderRemovedMessage
  | UiProjectUpsertMessage
  | UiProjectRemovedMessage
  | UiSessionEventMessage
  | UiSessionEventsResetMessage
  | UiShellOutputMessage
  | UiShellExitMessage
  | UiShellRegistryReconciledMessage
  | UiRunUpsertMessage
  | UiRunRemovedMessage
  | UiPodUpsertMessage
  | UiPodRemovedMessage
  | UiPodContextEntryMessage
  | UiSessionSubscriptionsAppliedMessage;

/** One dashboard view can display one pod (at most 12 members today) or a larger parallel run.
 * Leave headroom for future run sizes without admitting multi-thousand-query subscription frames. */
export const MAX_UI_SESSION_SUBSCRIPTIONS = 256;
export const MAX_UI_POD_SUBSCRIPTIONS = 1;

/** Browser dashboards replace their live high-volume session subscription whenever navigation
 * changes. Metadata upserts remain global within the caller's authorization scope; only event,
 * event-reset, and shell streams are narrowed by this set. Older dashboards send no message and
 * retain the legacy all-session stream for rolling compatibility. */
export interface UiSessionSubscriptionsMessage {
  type: "session_subscriptions";
  /** Monotonic per-WebSocket replacement id. Starts at 1. */
  revision: number;
  sessionIds: string[];
  podIds: string[];
}

/** An authenticated dashboard confirms it received the durable continuation projection. This is
 * deliberately narrower than claiming an OS notification was shown or a human saw it. */
export interface UiBackgroundDeliveryObservedMessage {
  type: "background_delivery_observed";
  sessionId: string;
  continuationId: string;
}

export type UiToControlPlane = UiSessionSubscriptionsMessage | UiBackgroundDeliveryObservedMessage;

/* ========================================================================== */
/* UI -> Control Plane (REST request/response bodies)                          */
/* ========================================================================== */

export interface CreateSessionRequest {
  runnerId: string;
  workspaceId: string;
  /** Optional during rolling upgrades. New clients send the exact durable Project and Location;
   * old clients omit both and the control plane infers only from the exact runner/workspace pair. */
  projectId?: string | null;
  projectLocationId?: string | null;
  agentId: string;
  /** One-shot launch intent. Omitted by older clients and defaults to the structured Direct flow. */
  launchSurface?: "direct" | "native_tui";
  title?: string;
  prompt?: string;
  images?: PromptImageInput[];
  useWorktree?: boolean;
  /** Preferred v60 selection. If supplied, it must belong to runnerId and agrees with useWorktree. */
  executionTargetId?: string;
  /** Cloud-only source session and existing workflow artifacts to transfer/prove. */
  executionHandoff?: { sourceSessionId?: string; artifactIds?: string[] };
  config?: SessionConfig;
  /** An ad-hoc directory chosen via the remote browser; overrides `workspaceId` when set. */
  workspacePath?: string;
  /** ACP-only session overrides. The control plane validates and persists only secret references. */
  acpSessionContext?: AcpSessionContextConfig;
}

export interface CreateRunRequest {
  runnerId: string;
  workspaceId: string;
  /** Exact durable Project assignment. Omit both fields for legacy exact-Location inference. */
  projectId?: string | null;
  projectLocationId?: string | null;
  agentIds: string[];
  task: string;
  title?: string;
  useWorktree?: boolean;
  config?: SessionConfig;
  /** Run-wide accumulated-cost ceiling (USD); absent ⇒ unlimited. Applied to each member. */
  costBudgetUsd?: number;
  /** Run-wide tool-call limit; absent ⇒ unlimited. Applied to each member. */
  maxToolCalls?: number;
}

export interface PromptRequest {
  text: string;
  images?: PromptImageInput[];
  config?: SessionConfig;
  slashCommand?: string;
}

/** Body for POST /api/sessions/:id/steer. Exactly one of direct content or promotePromptId is
 * accepted by the route. A fresh submissionId identifies each user action, including promotion. */
export interface SteerRequest {
  submissionId: string;
  turnId: string;
  text?: string;
  images?: PromptImageInput[];
  promotePromptId?: string;
}

/** Explicit user-owned display title. The control plane normalizes whitespace and persists it
 * independently of runner availability; later provider/runner title updates cannot replace it. */
export interface SetSessionTitleRequest {
  title: string;
}

export interface ApproveRequest {
  requestId: string;
  optionId: string | null;
}

export interface SetColumnRequest {
  column: BoardColumn;
}

export interface SetArchivedRequest {
  archived: boolean;
}

export interface SnoozeScheduleInput {
  /** Absolute Unix time in milliseconds. The server never reparses the user's expression. */
  scheduledFor: number;
  /** IANA time-zone identifier used to explain the instant and preserve edit intent. */
  timeZone: string;
  /** The exact bounded expression or local datetime entered by the user. */
  originalExpression: string;
}

export interface SetSessionReminderRequest extends SnoozeScheduleInput {
  wakePolicy: SessionReminderWakePolicy;
  /** Required when replacing an existing reminder; rejects stale multi-client edits. */
  expectedRevision?: number;
  /** Identity paired with expectedRevision so a removed-and-recreated reminder cannot be mistaken
   * for the caller's prior reminder when both happen to have the same revision. */
  expectedReminderId?: string;
  /** Fired-state facts copied from the caller's observed reminder only when Undo restores it.
   * The server requires an optimistic revision and validates both bounded fields. */
  restoreFired?: {
    firedAt: number;
    wakeReason: SessionReminderWakeReason;
  };
}

/** Body for POST /api/sessions/:id/workspace — re-file a session under a workspace ("Move to
 * project"). null ⇒ back to the "Chats" bucket. */
export interface SetWorkspaceRequest {
  workspaceId: string | null;
}

/** Create a durable Project independently of its sessions and Locations. */
export interface CreateProjectRequest {
  name: string;
  /** Explicit owner. Omitted only for compatibility with older clients. */
  owner?: ResourceOwner;
}

/** Rename and/or show/hide a durable Project. Omitted fields remain unchanged. */
export interface UpdateProjectRequest {
  name?: string;
  hidden?: boolean;
}

/** Link an exact runner/workspace Location to a Project. */
export interface AddProjectLocationRequest {
  runnerId: string;
  workspaceId: string;
}

/** Register a new folder-backed workspace and link it directly to one durable Project. */
export interface CreateProjectLocationRequest {
  runnerId: string;
  name: string;
  path: string;
  /** Explicit owner. Omitted only for compatibility with older clients. */
  owner?: ResourceOwner;
}

export interface AccessScopeAffectedProject {
  projectId: string;
  name: string;
}

/** Exact, server-derived impact that must be shown before changing Project or Location access. */
export interface AccessScopeChangePreview {
  resource: "project" | "workspace";
  resourceId: string;
  runnerId?: string;
  currentScope: ResourceScope;
  targetScope: ResourceScope;
  affectedProjects: AccessScopeAffectedProject[];
  activeSessionCount: number;
  totalSessionCount: number;
  sessionsToNarrow: number;
  compatible: boolean;
  reason?: string;
  /** Binds confirmation to the exact relationships, sessions, and scopes inspected by the server. */
  confirmationToken?: string;
}

/** Content-safe, durable evidence for one committed Project or Location scope transition. */
export interface AccessScopeAuditView {
  scopeChangeId: string;
  mutationAuditId?: string;
  actorId: string;
  userId: string;
  deviceId?: string;
  organizationId: string;
  resource: "project" | "workspace";
  resourceId: string;
  runnerId?: string;
  currentScope: ResourceScope;
  targetScope: ResourceScope;
  affectedProjectIds: string[];
  activeSessionIds: string[];
  sessionIds: string[];
  narrowedSessionIds: string[];
  createdAt: number;
}

export interface UpdateAccessScopeRequest {
  owner: ResourceOwner;
  confirmationToken: string;
}

/** @deprecated Rolling-compatibility request for older clients. New clients add a shared
 * Location membership to the target Project and remove the source membership separately. */
export interface MoveProjectLocationRequest {
  locationId: string;
}

/** Path parameter input used by clients removing a Location link. */
export interface RemoveProjectLocationRequest {
  locationId: string;
}

/** Path parameter input used by clients choosing a Project's default Location. */
export interface SetDefaultProjectLocationRequest {
  locationId: string;
}

/** Assign a session to a durable Project. The server resolves the session's exact compatible
 * Location; null explicitly moves it to No Project. */
export interface SetProjectRequest {
  projectId: string | null;
  /** Explicitly register/link an adopted session's existing Location when the target Project does
   * not own it yet. The route requires Project-management permission before honoring this flag. */
  linkLocation?: boolean;
}

/** Body for POST /api/sessions/:id/git — the action plus its parameters. */
export interface GitActionRequest {
  action: GitAction["kind"];
  /** For diff. */
  scope?: GitDiffScope;
  /** For commit. */
  message?: string;
  /** For commit: force commit-everything even when hunks are staged. */
  all?: boolean;
  /** For commit: the client's belief about whether anything is staged (GIT_STALE guard). */
  expectStaged?: boolean;
  /** For open_pr. */
  title?: string;
  body?: string;
  branch?: string;
  /** For stage_hunk / stage_lines. */
  direction?: "stage" | "unstage";
  filePath?: string;
  hunkIndex?: number;
  /** For stage_lines: unique source-hunk line indices (only +/- lines are accepted). */
  lineIndices?: number[];
  diffHash?: string;
}

export interface RunnersResponse {
  runners: RunnerView[];
}

/** Body for POST /api/boxes — bootstrap a runner on a remote machine over SSH. */
export interface AddBoxRequest {
  /** User-owned Machine name shown throughout the dashboard. */
  displayName?: string;
  /** SSH target, e.g. `user@host`. */
  sshTarget: string;
  sshPort?: number;
  /** Optional workspace path on the box; defaults to the box's home directory. */
  workspacePath?: string;
}

export interface BoxesResponse {
  boxes: BoxView[];
}

/** A connectable host parsed from the dashboard machine's ~/.ssh/config, offered for import in
 * "Add a box". Wildcard-pattern Host entries are excluded. */
export interface SshConfigHost {
  /** The `Host` alias. */
  host: string;
  /** Resolved `HostName`, if the config sets one. */
  hostName?: string;
  user?: string;
  port?: number;
}

export interface BoxResponse {
  box: BoxView;
}

export interface SessionsResponse {
  sessions: SessionView[];
}

export interface ProjectsResponse {
  projects: ProjectView[];
}

export interface ProjectResponse {
  project: ProjectView;
}

export interface DeleteProjectResponse {
  deleted: true;
}

export interface ArchiveProjectSessionsResponse {
  project: ProjectView;
  /** Updated sessions are returned so clients can offer the established archive undo flow. */
  sessions: SessionView[];
  /** Exact sessions changed from unarchived to archived by this atomic operation.
   * Absent on Project-capable control planes released before exact archive undo support. */
  archivedSessionIds?: string[];
  /** Sessions whose provider stop must be confirmed before the server files them as archived. */
  pendingSessionIds?: string[];
  /** Sessions whose Stop operation failed without proving runtime capacity was released. */
  failedSessionIds?: string[];
}

export interface SessionEventsResponse {
  events: SessionEvent[];
  /** CP-owned replacement generation for stale-page rejection. Absent on legacy control planes. */
  eventEpoch?: number;
  /** CP event seq to pass as `after` for the next cached page. */
  nextAfter?: number;
  /** More rows were already cached at the response's point-in-time read. */
  hasMoreCached?: boolean;
  /** The contiguous runner cursor reached the last runner tail known for this generation. */
  cacheComplete?: boolean;
  /** Backward reads only: CP event seq to pass as `before` for the next older page. Absent when
   * no rows were returned, since an empty page carries no cursor to page below. */
  nextBefore?: number;
  /** Backward reads only: older cached rows exist below this page's oldest returned seq. */
  hasMoreOlder?: boolean;
  /** Backward reads that requested turn alignment: whether the page begins at a user-anchored turn
   * start. False when no anchor was within the extension cap, so the page begins mid-turn. */
  turnAligned?: boolean;
}

export interface RunsResponse {
  runs: RunView[];
}

export interface SessionResponse {
  session: SessionView;
}

export interface SideChatResponse {
  sideChat: SideChatView | null;
}

export interface RunResponse {
  run: RunView;
  sessions: SessionView[];
}

export interface PodsResponse {
  pods: PodView[];
}

export interface PodResponse {
  pod: PodView;
  sessions: SessionView[];
}

export interface PodContextPage {
  entries: PodContextEntry[];
  /** Pass as `before` to load the next older page. */
  beforeSeq?: number;
}

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** Parse a JSON websocket frame into T, or return null on malformed input. */
export function parseMessage<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "stopped"];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
