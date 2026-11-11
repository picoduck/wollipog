/**
 * Runner protocol version ledger (#975).
 *
 * `PROTOCOL_VERSION` is the highest version recorded below. Runners, control planes and clients
 * exchange it at registration, and `RUNNER_CAPABILITY_MIN_PROTOCOL` gates each capability on it, so
 * a version means "this build supports every change up to and including this one". Versions
 * therefore land on the default branch in increasing order. A number that no merged change used
 * simply has no entry.
 *
 * To claim a version, insert its entry directly below the `// vN slot` anchor of the next free
 * version: a `// N: ...` comment describing the change, then the line `N,`. Leave the anchor itself
 * and every other line in place. Each version has its own anchor, so pull requests that claim
 * different versions edit different lines and merge without a conflict, while two that claim the
 * same version conflict at once.
 *
 * `node scripts/protocol-version-ledger.mjs` checks this file and, in CI, each tested commit
 * against its parent: every entry's comment and number agree, versions increase, and every version
 * a branch adds is greater than the default branch's `PROTOCOL_VERSION`. When the default branch
 * has moved past a claim, the check names both values and the version to claim instead; move the
 * entry under that version's anchor and update any capability floor that used the old number.
 * `--extend` appends more anchors when few remain.
 */
const PROTOCOL_VERSION_HISTORY: readonly number[] = [
  // 4: snapshot carries `boxes`; box_upsert/box_removed + run_removed messages; AddBoxRequest/BoxView.
  4,
  // 5: Phase 2 box-owned sessions — RegisterMessage.sessionSnapshots, session_history req/result,
  //    session_event seq/ts; delete_session.
  5,
  // 6: Phase 3 adopt external CLI sessions — ExternalSessionDescriptor, list_external_sessions
  //    req/result, adopt_session.
  6,
  // 7: chat-log fidelity — `final?` on user/agent/thought payloads (whole-message vs stream-chunk).
  //    Additive + optional; not enforced at the handshake, so older runners interop unchanged.
  7,
  // 8: reprocess_session req/result — re-import an adopted session's transcript with the current parser.
  8,
  // 9: session_events_reset broadcast + `adopted` on SessionSnapshot/SessionView (gates reprocess).
  9,
  // 10: per-model reasoning effort on AgentModel; list_directory req/result + CreateSessionRequest.workspacePath.
  10,
  // 11: Context and governance additions (additive, optional) — AgentModel.contextWindow (context meter);
  //     SessionConfig.costBudgetUsd + CreateRunRequest.costBudgetUsd (cost-budget gating, applied per
  //     session / to run members); ThreadType + SessionView.threadType (projects sidebar). Event/message
  //     *variants* land with the phase that emits+handles them, not here, so no consumer breaks.
  11,
  // 12: Phase 2 rich-diff / review pane (PR-A, read-only) — GitDiffScope/GitDiffLine/GitHunk/GitDiffFile/
  //     GitDiffInfo; GitAction gains {kind:'diff';scope}; GitActionData.diff?; GitActionRequest.scope?.
  //     Additive + optional; older runners simply don't advertise the diff action.
  12,
  // 13: Phase 2 rich-diff PR-B + last_turn — GitAction stage_hunk {direction,filePath,hunkIndex,diffHash};
  //     commit.all?/expectStaged?; GitActionRequest direction?/filePath?/hunkIndex?/diffHash?/all?/
  //     expectStaged?; GitHunk.staged?; GitStatusInfo.stagedCount?; GitCommitInfo.stagedOnly?;
  //     git_result.code? (GitErrorCode); git_action.timeoutMs? (queued-mutation expiry). last_turn
  //     scope goes live (runner-side turn-start tree snapshot in box meta.json — behavioral, no new wire
  //     shapes; SessionSnapshot unchanged). Additive + optional.
  13,
  // 14: Phase 8a/8b guardrails — PendingApproval.kind gains 'max_tool_calls'; PolicyRule/PolicyDecision
  //     vocabulary + POLICY_APPROVAL_KINDS/isPolicyApproval(); SessionConfig.maxToolCalls;
  //     SessionView.maxToolCalls/toolCallCount; CreateRunRequest.maxToolCalls. Additive + optional;
  //     CP-side only (SessionSnapshot and runner wire unchanged — guardrails are invisible to runners).
  14,
  // 15: adopt/version-skew UX — ExternalSessionDescriptor.resumable (a matching agent exists on the
  //     box for that driver+context, so the UI can offer "Adopt & continue" vs "Adopt as read-only");
  //     RegisterMessage.protocolVersion + RunnerView.protocolVersion (outdated-runner badge);
  //     RunnerView.agentsRefreshed (a discovery pass has reported since register — an empty agent list
  //     means "none installed", gating the install hints, not "still probing"). Additive + optional;
  //     older runners omit them all — descriptors default to resumable and the badge stays off.
  //     Also the pre-durable-Project SetWorkspaceRequest compatibility adapter
  //     (POST /api/sessions/:id/workspace; CP-owned like board_column, invisible to runners).
  15,
  // 16: session Files panel — list_session_files / read_session_file req/result (+ SessionFileEntry).
  //     Paths on the wire are RELATIVE to the session root (worktreePath ?? repoPath, resolved by the
  //     runner from box meta — the dashboard never names absolute paths). Additive + optional; older
  //     runners just never answer, which the CP surfaces as a timeout.
  16,
  // 17: per-session Shells panel — shell_open req/result, shell_input, shell_close (CP→runner);
  //     shell_output / shell_exit (runner→CP, ephemeral — never persisted to the event log);
  //     UiShellOutputMessage / UiShellExitMessage + ShellView. Pipe-based streaming console (no
  //     PTY — node-pty is a native module this repo can't carry): raw stdin passthrough into a
  //     persistent `sh` / `cmd /q` spawned in the session root. Additive + optional.
  17,
  // 18: AgentDefinition.bin — discovery's logical binary name ("claude"/"codex"), the stable
  //     launch-target identity for config↔discovery merging now that version-manager installs
  //     launch as `node <entry.js>` with generically-named entry files. Additive + optional.
  18,
  // 19: PTY shells — shell_open gains cols/rows, shell_open_result + ShellView gain `pty`
  //     (a real PTY was allocated: POSIX/WSL via util-linux `script`, still no native modules;
  //     Windows native stays pipe-based); new shell_resize (CP→runner, fire-and-forget).
  //     shell_output data is RAW terminal bytes when pty — dashboards render with xterm.js.
  //     Additive + optional: pre-v19 runners ignore cols/rows and omit pty ⇒ pipe behavior.
  19,
  // 20: pinned summary — GitStatusInfo gains addedLines/deletedLines (working-tree numstat totals
  //     vs HEAD, tracked files only). Additive + optional; older runners omit them and the
  //     dashboard's Changes row falls back to the changed-file count.
  20,
  // 21: git summary — GitAction gains {kind:'summary'}; GitSummaryInfo/GitPrSummary/
  //     GitChecksSummary; GitActionData.summary?. One read powering the pinned summary's PR
  //     title + failing-checks rows: status bits + `gh pr view` (PR + check rollup, TTL-cached
  //     runner-side; gh missing/unauth ⇒ pr/checks null and the rows hide). Additive + optional;
  //     older runners reject the unknown kind, which the dashboard treats as "no PR info".
  21,
  // 22: host actions + editor discovery — EditorInfo; RunnerMetadata.editors?/
  //     AgentsUpdatedMessage.editors?/RunnerView.editors? (discovery probes local editor CLIs);
  //     host_action (CP→runner: open_editor / reveal on a session root or explicit path) +
  //     host_action_result. Additive + optional; older runners ignore the unknown message and
  //     the CP request times out with a clear error, and no editors ⇒ the button hides.
  22,
  // 23: visible + cancelable prompt queue — QueuedPromptView; SessionView.queued?; session_queue
  //     (runner→CP, ephemeral — the prompts waiting behind the running turn, relayed to dashboards
  //     never persisted); cancel_queued_prompt (CP→runner: drop one not-yet-started prompt).
  //     Additive + optional: pre-v23 runners never emit a queue ⇒ the UI shows none.
  23,
  // 24: trust surface — structured agent questions (AgentQuestion/QuestionOption;
  //     question_request / question_resolved events; answer_question CP→runner;
  //     PendingApproval kind "question" + questions) and approval context (ApprovalContext on
  //     permission_request + PendingApproval: tool name + a bounded rendering of its input, so
  //     approval cards state WHAT is being approved). Additive + optional: pre-v24 runners never
  //     emit questions/context ⇒ the UI shows none.
  24,
  // 25: per-turn checkpoints + rewind — checkpoint / checkpoint_restored events (worktree
  //     sessions anchor each turn's pre-turn tree under compatibility refs in both
  //     refs/wollipog/<sessionId>/turn-<n> and refs/mam/<sessionId>/turn-<n>);
  //     rewind_session req / rewind_result (CP→runner request/response: restore the worktree
  //     to a checkpoint tree; files only — the agent conversation continues). Additive +
  //     optional: pre-v25 runners never emit checkpoints ⇒ the UI shows no rewind affordance.
  25,
  // 26: subagent tree attribution — optional `parentToolUseId` on the payload variants a subagent
  //     can emit (agent_message/agent_thought/tool_call/tool_call_update/plan/file_edit). The
  //     claude driver reads stream-json `parent_tool_use_id` (the id of the spawning Task tool
  //     call); the UI nests those events under their parent Task block. Additive + optional:
  //     pre-v26 runners never set it ⇒ the UI renders the timeline flat, as before.
  26,
  // 27: Codex app-server compatibility discovery — optional AgentDefinition.codexAppServer reports
  //     the resolved CLI version, verification mode, pinned contract fingerprint, and a structured
  //     fallback reason. Additive + optional: pre-v27 runners omit it and clients retain the legacy
  //     Codex presentation; old control planes persist no value and continue to launch codex exec.
  27,
  // 28: provider-native conversation forks — conversation_checkpoint events mark completed
  //     provider turns; fork_session / fork_result mint a new provider session plus an isolated
  //     worktree at that exact post-turn state. Additive + optional: older runners emit no fork
  //     points and the dashboard shows no fork affordance.
  28,
  // 29: privacy-safe driver operational telemetry. Runners emit bounded, content-free launch,
  //     resume, approval, crash, and fallback observations; the control plane stores hourly
  //     aggregates only. SessionLaunchSpec.agentVersion supplies the discovered version dimension.
  29,
  // 30: Claude Code launch-readiness discovery — optional AgentDefinition.claudeCode reports the
  //     resolved CLI's verified flags/modes, safe auth/billing classification, and PATH diagnostics.
  30,
  // 31: recursive subagent fidelity — `agent` is the normalized Task/agent tool kind and optional
  //     parent/duration fields on token_usage let capable runners attach subagent rollups. Additive +
  //     optional: pre-v31 runners keep flat usage totals and the UI derives status/duration when able.
  31,
  // 32: context-native isolation and admission — RunnerMetadata/RunnerView.runtime advertises the
  //     external data root and box process ceiling. WSL worktrees execute inside their distro and
  //     session status `queued` exposes FIFO admission waits. Additive + optional.
  32,
  // 33: ACP authentication choices reuse the approval transport with an optional authentication
  //     purpose/kind and bounded option descriptions. Pre-v33 peers render a normal approval card.
  33,
  // 34: capability-gated provider logout request/result; runners refresh the content-free agent
  //     authStatus after a confirmed ACP login/logout. Older runners expose no sign-out action.
  34,
  // 35: ACP-native external-session discovery binds every descriptor to its exact configured agent
  //     id; correlated adopt results return only runner-revalidated descriptors/snapshots.
  35,
  // 36: session snapshots carry live session-scoped agent capabilities; runtime snapshot updates keep
  //     ACP modes/config options/commands isolated between concurrent sessions.
  36,
  // 37: stable ACP usage/title updates carry provider context fill, cumulative USD cost, and explicit
  //     generated/user/provider title ownership through runner snapshots.
  37,
  // 38: ACP session context carries secret-free MCP definitions plus explicitly selected additional
  //     directories. Workspace metadata exposes only operator-granted directory choices.
  38,
  // 39: stabilized ACP Registry v1 metadata. Registry entries remain unavailable until a local
  //     launch is discovered or an explicit install approval is completed; capabilities and auth
  //     status are still derived exclusively from the live ACP initialize handshake.
  39,
  // 40: explicit, version-bound approval/revocation for Registry package launches. Binary archive
  //     distributions remain manual-only because Registry v1 supplies no integrity digest.
  40,
  // 41: AgentDefinition explicitly reports runner-local ACP stdio transport. Direct Streamable
  //     HTTP/WebSocket remains an Active upstream RFD and is rejected by runner config.
  41,
  // 42: provider-aware weighted admission diagnostics. RunnerRuntimeInfo optionally advertises exact
  //     agent-id process limits and capacity weights; unlisted agents retain limit=unbounded/weight=1.
  42,
  // 43: runner-owned Linux/WSL bubblewrap isolation policy diagnostics. Provider mode preserves the
  //     existing driver sandbox; bwrap mode is fail-closed and may additionally deny network access.
  43,
  // 44: optional provider-state orphan age/byte controls. Runners journal exact cleanup, claim WSL
  //     partitions before GC, and report the effective bounded-retention policy in runtime metadata.
  44,
  // 45: audited native platform isolation adapters. macOS Seatbelt gates filesystem writes/network;
  //     Windows Job Objects provide an explicitly process-only kill-on-close tree boundary.
  45,
  // 46: append-only governance audit records capture approval requests, policy asks, and resolutions
  //     with reviewer identity, bounded scope, and content digests instead of raw tool input.
  46,
  // 47: runner-side mid-turn cost/tool guardrails cancel at the first normalized threshold event;
  //     Continue re-arms the next bounded allowance window through rearm_governance.
  47,
  // 48: reviewer-neutral governance decisions. review_decision carries a typed model-review verdict;
  //     ApprovalContext.escalatedBy attributes a subsequent human approval to the reviewer that
  //     escalated it. Additive + optional; older runners retain their existing approval flow.
  48,
  // 49: declarative approval policies match contextual/stateful input across organization, runner,
  //     workspace, agent, branch, tool, path, and network scopes. ApprovalContext gains the bounded
  //     scope fields capable drivers can prove. Additive + optional.
  49,
  // 50: high-fidelity local review exposes canonical staged/unstaged diff panes plus stale-guarded
  //     line staging and tracked-file discard. Older runners retain combined diff + hunk staging.
  50,
  // 51: read-only GitHub review reconciliation imports durable PR review threads with explicit
  //     remote provenance and resolution/outdated state. No GitHub mutation is implied.
  51,
  // 52: pod worktree reconciliation merges one clean same-runner member head into another through
  //     runner-owned session metadata and returns immutable merge/conflict provenance.
  52,
  // 53: durable automation commands use a distinct runner message, stable command identity, and
  //     monotonic runner receipts. This makes control-plane/socket retries deduplicated at the
  //     runner-acceptance boundary without claiming provider-side exactly-once execution.
  53,
  // 54: agent launch environment is runner-local. Runner metadata, control-plane persistence,
  //     session snapshots, and durable commands carry no values or reference names; the runner
  //     resolves literal/fromEnv config immediately before every provider process launch.
  54,
  // 55: indexed, bounded runner history pages. A distinct session_history_page request/result freezes
  //     the runner log epoch and durable tail for each page chain; legacy session_history remains
  //     unchanged for rolling compatibility. Fork/reprocess may defer their event arrays so the
  //     control plane rehydrates through the bounded page channel.
  55,
  // 56: prompt image bodies are immutable artifact references on control-plane/runner durable and
  //     WebSocket boundaries. The runner verifies and materializes bytes only at the provider edge.
  56,
  // 57: durable detachable terminal sessions. Shell output carries runner-monotonic sequence ids;
  //     reconnecting runners replay bounded per-shell snapshots and finish with an authoritative
  //     inventory fence. Shell metadata/history survives dashboard and control-plane restarts,
  //     while agent TUI mirrors remain explicitly separate processes from structured agent control.
  57,
  // 58: native Windows shells use ConPTY, and dashboards may request a provider TUI as a separately
  //     spawned process. The TUI never reuses the structured agent process or its control stream.
  58,
  // 59: canonical file/line/column/symbol deep links and precise editor launches. Location-aware
  //     host actions use a distinct message kind so an older control plane rejects them instead of
  //     silently dropping the location and opening only the session root.
  59,
  // 60: provider-neutral execution-target descriptors separate placement/workspace policy from the
  //     agent driver. Existing local, worktree, and SSH-box launches project into the new contract;
  //     additive fields let pre-v60 peers continue using runnerId + useWorktree unchanged.
  60,
  // 61: runner-owned container targets advertise digest-pinned environment templates, compatible
  //     agent ids, deterministic setup-check provenance, and explicit no-secret/no-billing bounds.
  61,
  // 62: runner-owned cloud proxy targets add immutable git/artifact handoff receipts plus explicit
  //     target-metered cost budgets and per-target admission. Adapter credentials stay runner-local.
  62,
  // 63: Codex App Server session discovery reuses the existing Codex rollout store while preserving
  //     the selected interactive driver for adoption. Older runners only understand Codex exec
  //     discovery and must not report a misleading empty App Server result.
  63,
  // 64: Agent capabilities report per-permission-mode elicitation transports. The optional field
  //     keeps older runners compatible; absence means unknown rather than unsupported.
  64,
  // 65: Claude policy hooks bind a per-session credential hash and acknowledge it before HTTP.
  65,
  // 66: hook-backed governance adds durable same-invocation ask polling and per-policy timeouts.
  66,
  // 67: initial Native TUI launch can fence shell_open behind the matching session-start generation.
  67,
  // 68: native session snapshots may report the provider-resolved model separately from the selected
  //     alias, preserving config semantics while making the actual executing model visible.
  68,
  // 69: Claude background-work lifetime is runner-owned and visible. Optional BackgroundWorkState
  //     on SessionSnapshot/SessionView keeps older runners and control planes wire-compatible.
  69,
  // 70: optional provider message identity preserves streamed agent-text boundaries. Consumers
  //     retain legacy adjacency coalescing when the field is absent, so rolling peers stay compatible.
  70,
  // 71: interrupt_turn is an explicit non-terminal active-turn interruption. It preserves queued
  //     prompts and records a transcript-visible turn_interrupted result without changing the
  //     legacy cancel_session lifecycle contract used by older control planes and workflows.
  71,
  // 72: active-turn coordinates move to the authoritative ephemeral queue projection and correlated
  //     interrupt_turn_result acknowledgements distinguish delivery from an applied interruption.
  72,
  // 73: conversation steering uses a distinct correlated request/result, explicit provider
  //     capability, durable control-plane attempt receipts, and runner-owned accepted user events.
  73,
  // 74: slash-command metadata gains an optional argument hint. Native session snapshots may overlay
  //     their exact command set without freezing catalog-owned model, effort, or approval controls.
  74,
  // 75: runner-authorized session commands use opaque catalog identities and a distinct durable
  //     invocation/receipt lane. Structured execution remains fail-closed until a provider proves it.
  75,
  // 76: additive Git visibility facts distinguish HEAD/upstream/default-base divergence, primary vs.
  //     linked worktrees, dirty categories, in-progress operations, shallow repositories, and the
  //     shared remote-ref timestamp. Git status/summary may target a primary checkout by session id;
  //     the runner resolves its authoritative repoPath and all other actions remain linked-only.
  76,
  // 77: runners authenticate a read-only control-plane identity attestation before opening mutable
  //     local stores, so persistent state can be bound to the installation rather than an endpoint.
  77,
  // 78: durable queued prompts share one command/queue/event identity and pre-admission queues are
  //     projected live, allowing exact cancellation without inferring authority from persisted rows.
  78,
  // 79: provider-authentication terminal receipts use a distinct error code. A v79 runner sending
  //     to an older control plane downgrades only the wire projection to COMMAND_CANCELLED so the
  //     older validator still accepts a terminal receipt; the runner-local journal keeps exact truth.
  79,
  // 80: runner-owned subscription-usage sources publish normalized, secret-free provider windows;
  //     correlated refresh requests remain no-turn and preserve last-known control-plane snapshots.
  80,
  // 81: Claude managed background work distinguishes an external-job wait from the durable
  //     continuation-delivery barrier. Older peers continue to treat the optional state as absent.
  81,
  // 82: projection-safe managed background-job snapshots and structured continuation evidence let
  //     the control plane durably track transcript projection and dashboard observation.
  82,
  // 83: runners explicitly classify provider background-work tracking. Providers without a
  //     lifecycle signal report `untracked` instead of letting an absent field imply safety.
  //     Structured continuation evidence carries bounded provider-neutral terminal summaries.
  83,
  // 84: replacement starts carry a control-plane launch identity that runners persist and echo in
  //     live status and reconnect snapshots, proving which runtime crossed a durable Stop fence.
  84,
  // 85: stop_session carries a durable operation identity and correlated acceptance or rejection.
  //     Older runners retain the conservative Stop Pending behavior.
  85,
  // 86: structured questions may include provider-declared free-text input, optional fields,
  //     secret entry, primitive format/length/range constraints, and multi-select cardinality.
  //     All fields are additive; pre-v86 peers retain the original required-choice behavior.
  86,
  // 87: streamed agent responses gain a content-free completion event. New runners emit it only at
  //     an authoritative successful turn boundary; older runners omit it and reminders retain their
  //     scheduled fallback. The separate event avoids replaying message text for legacy consumers.
  87,
  // 88: structured request resolution events gain an optional bounded reason so replacement,
  //     provider-side settlement, explicit submission, and dismissal remain distinguishable in
  //     durable history. Pre-v88 peers retain the existing optionId/answered presentation.
  88,
  // 89: Stop delivery attempts carry a distinct durable identity in addition to their stable
  //     operation identity, so delayed results cannot cross an authorized retry boundary. Older
  //     peers retain conservative Stop Pending behavior because they cannot prove the attempt.
  89,
  // 90: Managed agent skills: the control plane pushes the authoritative desired skill set for a
  //     machine (skills_sync) and the runner reports authoritative deployment state (skills_state).
  //     Pre-v90 runners never receive the new messages because the capability gate fails closed.
  90,
  // 91: the Conductor's runner env gate (WOLLIPOG_CONDUCTOR) is removed; the device-local
  //     Conductor-Led Work experiment (default off, versioned client storage) becomes the only
  //     gate. A runner synthesizes and advertises the conductor only to a v91+ control plane:
  //     older deployments serve web bundles that both default the experiment ON and cannot
  //     distinguish a legacy stored opt-in, so unconditional advertisement to them would surface
  //     the feature to users who never chose it.
  91,
  // 92: authoritative cross-harness subagent lifecycle. Tool events may carry a provider-observed
  //     subagentLifecycle independent of the foreground session lifecycle, and command output can be
  //     attributed to its spawning agent. Pre-v92 runners omit both fields; dashboards retain the
  //     existing conservative session/tool inference and flat command-output presentation.
  92,
  // 93: runner-hosted semantic session naming. A correlated metadata request executes through the
  //     session's exact native Codex or Claude account on its owning runner, with ephemeral/no-tool
  //     provider state and a bounded secret-free result. Older runners are never sent the request.
  93,
  // 94: runner-local custom session-naming endpoints. Owners/admins provision a write-only API key
  //     to one selected runner, while the control plane persists only secret-free configuration and
  //     readiness. Configuration, deletion, testing, and title generation are capability-gated.
  94,
  // 95: session naming may target an explicit authenticated runner harness, advertised model, and
  //     reasoning effort instead of inheriting them from the session. Older runner-account settings
  //     keep their v93 follow-session behavior until an owner/admin saves an explicit target.
  95,
  // 96: managed skill desired-state delivery splits metadata from digest-addressed content. A
  //     runner requests only missing versions and applies the authoritative manifest only after an
  //     explicit completion frame; pre-v96 peers retain the bounded single-frame v90 protocol. The
  //     runner also reports bounded managed-link removal events; older runners omit that projection.
  96,
  // 97: session-naming target drift uses precise runner failure codes for missing harnesses and
  //     models. Because protocol v96 shipped on both sides of the unversioned vocabulary addition,
  //     new runners downgrade those codes for every pre-v97 control plane.
  97,
  // 98: native session capability overlays can revoke or restore steering when a verified
  //     persistent provider transport falls back at runtime. Older peers retain catalog truth.
  98,
  // 99: queued-prompt editing uses capability-gated correlated reads and idempotent revision-fenced
  //     replacements. The runner remains authoritative for mutability, identity, and FIFO position.
  99,
  // 100: every native session receives a runner-minted, exact-session control credential and the
  //      runner's Wollipog CLI entrypoint. The same credential authenticates the provider-neutral
  //      stdio MCP surface; only its hash crosses the runner socket or reaches durable storage.
  100,
  // 101: session_worktree/session_worktree_result correlated operations plus durable active and
  //      linked worktree metadata. Additive + optional; pre-v101 runners reject worktree routes.
  101,
  // 102: explicit session-worktree discard plus conservative runner-side PR-state reconciliation.
  //      Older peers retain create/attach/select and never receive the destructive operation.
  102,
  // 103: token_usage carries the cache-creation and reasoning buckets, and the control plane prices
  //      every parentless record against a model rate table when the provider reports no cost.
  //      Usage aggregates gain the five token buckets, cost provenance, cache savings, a by-model
  //      breakdown, and rate-table status. Older runners keep sending the flat shape; the control
  //      plane prices it from input, cached input, and output alone.
  103,
  // 104: token_usage carries the model that produced the record, so a session that switches models
  //      attributes each turn to the model that ran it; the control plane keeps a per-session
  //      per-model ledger and serves it from GET /api/sessions/:id/usage. Codex app-server runners
  //      publish the provider context gauge (used tokens over the model window). Older runners
  //      omit the model and the control plane keys on the session's resolved model as before.
  104,
  // 105: cost governance. SessionConfig.costCheckpointsUsd parks a session once per checkpoint with
  //      a Continue/Stop card ahead of the hard budget; a budgeted session whose usage cannot be
  //      priced fails closed with a cost_unpriced card; an organization-wide per-user daily budget
  //      parks a user's sessions with a daily_budget card until the day rolls over or an owner or
  //      admin raises it. All control-plane owned; runners see the new config field as opaque.
  105,
  // 106: priced_session_cost acknowledges the control-plane-priced cumulative USD total after each
  //      parentless usage event. Current runners persist that total and apply the existing mid-turn
  //      cost guardrail to it; older runners keep provider-reported local cost enforcement.
  //      Settled managed work also clears its current-state badge, while the control plane projects a
  //      bounded, privacy-safe job inventory for the inspectable Background Work panel. The runner
  //      input remains compatible with v82 inventories; pre-v106 `resumed` is a legacy sentinel.
  //      Provider-neutral workspace references are runner-minted, root-scoped, revision-bound
  //      prompt attachments. Search and minting remain bounded inside the session execution root;
  //      pre-v106 runners reject the structured attachment instead of silently dropping it.
  //      Forge-neutral source-control metadata and review reconciliation add GitLab.com plus exact-
  //      host self-managed GitLab support. Legacy GitHub action/result fields remain accepted so a
  //      rolling control-plane/runner/web deployment falls back to the established GitHub workflow.
  106,
  // 107: answer_recovered_question extends the durable command receipt lane so a structured answer
  //      can resume an established provider conversation after runner/process loss without replay.
  //      A runner-owned recovery occurrence id prevents provider request-id reuse from aliasing two
  //      different interrupted questions.
  107,
  // 108: optional worker ownership and concurrent provider requests in the existing approval
  //      record. Ownership is a normalized spawning-tool id, never a raw provider thread id.
  108,
  // 109: session orchestration preset, trusted child attribution, and child creation guardrails.
  109,
  // 110: explicit cross-provider checkpoint handoffs carry a bounded portable draft and a fresh
  //      destination identity.
  110,
  // 111: on-demand, read-only machine skill discovery and bounded snapshot retrieval.
  111,
  // 112: isolated native orchestrator TUI launch and live-TUI agent-control authentication.
  112,
  // 113: progress-aware session worktree creation with bounded phase heartbeats.
  113,
  // 114: loopback host-administration status route and public dashboard origin for pairing links.
  114,
  // 115: explicitly confirmed, runner-revalidated machine skill adoption.
  115,
  // 116: bounded machine skill adoption recovery inspection and explicit restore.
  116,
  // 117: loopback host-administration doctor route (`wollipog admin doctor`).
  117,
  // 118: agent-spawn events may carry bounded, structured display identity. The control plane uses
  //      the complete runner history to expose a bounded child-session registry without making the
  //      dashboard's currently loaded transcript window an identity or liveness source.
  118,
  // 119: portable machine skill snapshots and native Windows skill deployment.
  119,
  // 120: native macOS no-follow machine skill snapshots.
  120,
  // 121: content-free Native TUI accounting readiness diagnostics. Discovery reports only
  //      provider contracts it can prove from the live CLI; absent or incomplete proof remains
  //      unavailable and never enables usage attribution or budget enforcement.
  121,
  // 122: AgentModel.baseModelId separates base model identity from context-window variants;
  //      `contextWindow` is provider evidence only, and native drivers publish the effective
  //      post-launch context window and occupancy through the session gauge.
  122,
  // 123: authenticated, target-local Agent Control bridge for structured Direct WSL harnesses.
  123,
  // 124: Direct WSL is launchable only through the attested no-follow target-local launcher.
  124,
  // 125: mixed-context WSL machine skill snapshots and deployment.
  125,
  // 126: Codex service-tier discovery and per-session selection. AgentModel carries the provider's
  //      open-string tier catalog/default and SessionConfig carries the selected tier through
  //      persistence, forks, resumes, and turn starts. Older peers omit the additive fields.
  126,
  // 127: Codex App Server usage derives each turn from replay-safe cumulative thread deltas while
  //      retaining the final response for context occupancy. Codex usage written by older runners
  //      may contain only the final upstream response and must be presented as incomplete history.
  127,
  // 128: provider-history quarantine. A conversation whose stored history the provider rejects
  //      before inference is durably marked unusable, stops accepting prompts and compaction, and
  //      exposes a bounded, content-free recovery coordinate instead.
  128,
  // 129: runners report an exact runner-owned governance trip so the control plane can always
  //      materialize the Continue / Stop decision that holds the runner queue.
  129,
  // 130: policy-hook terminal decisions become content-safe runner-owned session events. A
  //      correlated CP -> runner append fence orders the event before the hook response can release
  //      its exact tool call; pre-v130 peers retain audit-backed client synthesis.
  130,
  // 131: merged change-request linkage may carry the forge-verified head OID so runners can safely
  //      discard its worktree after the remote branch and local upstream disappear.
  131,
  // 132: control-plane-authoritative, revisioned per-Machine runner capacity can be applied live;
  //      runners report lease usage, queued demand, and exact admission bottlenecks.
  132,
  // 133: attach matches a worktree against the REPOSITORY that registers it rather than against the
  //      worktree's own directory, so a registered worktree outside every configured Project
  //      Location is attachable, and the result carries a content-free platform-isolation notice
  //      saying whether the live process can already write there. Older runners omit the notice and
  //      the control plane presents it as unknown.
  133,
  // 134: managed background continuations record a durable terminal missing-result boundary after
  //      provider acceptance. The control plane keeps that audit evidence separately from a user's
  //      idempotent acknowledgement, so accepted in-flight work is never mislabeled or replayed.
  134,
  // 135: runner capacity reports batch filesystem diagnostics, bound high-cardinality blocker groups,
  //      and may expose separate active-turn, resident-process, and retained-session dimensions.
  135,
  // 136: explicit human-owned Parent Control delegates eligible descendant questions and approvals.
  //      Requests carry control-plane occurrence identity and parent-resolution provenance; older
  //      runners fail closed because delegated resolutions require this protocol capability.
  136,
  // 137: capacity admission distinguishes transient cross-process mutation-lock contention from
  //      resource exhaustion and bounded-fairness queue ordering. Older peers receive a neutral
  //      runner-capacity recheck reason instead of the new blocker vocabulary.
  137,
  // 138: Agent Control child creation accepts an explicit reasoning effort alongside the model.
  //      New clients fail closed against older control planes instead of silently dropping it;
  //      calls that omit effort retain the protocol-v100 creation contract.
  138,
  // 139: typed workflow decisions bind Parent Control delegation to an explicit category, exact
  //      resource snapshot, controlling session, and human-owned policy revision. Resolution and
  //      one-shot consumption are separate server-authoritative boundaries.
  139,
  // 140: Orchestrator campaigns expose a credential-free effective-policy/status projection,
  //      deduplicate follow-up recommendations, and verify child reports before policy-driven
  //      stop-and-archive completion.
  140,
  // 141: repository-owned worktree setup exposes content-safe lifecycle state and bounded progress;
  //      environment values and copied file contents remain runner-private.
  141,
  // 142: an approved PR-merge workflow decision can arm one exact canonical enqueue command. The
  //      matching runner permission consumes it only after delivery succeeds; older peers fail
  //      closed instead of silently treating action arming as the v139 immediate-consume contract.
  142,
  // 143: Orchestrator campaign projections separate human-owned requests from agent-actionable
  //      requests so current clients can surface parent attention without conflating lifecycle.
  143,
  // 144: Orchestrator coordination behavior is independent from optional strict project isolation.
  //      Launch specs carry the immutable effective restriction so older peers retain strict mode.
  144,
  // 145: runner-owned worktree port blocks and repository teardown lifecycle state are additive;
  //      exact teardown commands and environment values remain runner-private.
  145,
  // 146: worktree setup configuration discovery distinguishes absent, valid, and invalid input;
  //      older peers omit the status and clients preserve that case as unknown. Starter generation
  //      is a narrow runner-owned mutation that cannot name an arbitrary destination.
  146,
  // 147: Guardian-direct action reconciliation carries a provider-structured approval-review receipt bound
  //      to the App Server thread, turn, target item, and command digest. PR-merge action admission now
  //      requires this version so mixed deployments fail closed on uncorrelated review records.
  147,
  // 148: App Server action admission is causally fenced in the runner-owned event log before the
  //      arming call returns. The returned thread, turn, history generation, and sequence bind a
  //      later Guardian receipt to an invocation that began after that exact provider-side boundary.
  148,
  // 149: durable campaign events fan into an idempotent parent continuation command. The command
  //      carries a content-free event range and older peers fail closed instead of accepting an
  //      unclassified synthetic provider turn.
  149,
  // 150: approved-but-unconsumed PR merge actions can be reconciled from an exact successful
  //      provider-history command after its exact admission call plus a forge-verified merged head.
  //      Older peers cannot supply both proofs and fail closed without changing the decision.
  150,
  // 151: App Server action admission separates the runner session turn from the provider turn, and
  //      reconciliation can bind one exact successful command to a later durable Guardian receipt.
  151,
  // 152: subscription-usage snapshots may carry a bounded, user-recognizable active-account label.
  //      The optional field preserves rolling compatibility and remains scoped to the exact runner
  //      source that reported it; it is display-only and never an identity or authorization key.
  152,
  // 153: workflow-action reconciliation can bind a durable provider item completion after its exact
  //      Guardian receipt, and Codex runners can recover exact successful command proof from the
  //      provider's append-only rollout after App Server restart or compaction.
  153,
  // 154: agent discovery publishes an explicit evidence-backed availability result plus a bounded,
  //      content-free unavailable reason. Clients and control planes fail closed when older runners
  //      omit availability instead of treating an unverified configured launch as runnable.
  154,
  // 155: native Pi RPC harness discovery and execution. AgentDriverKind gains `pi`; live discovery
  //      supplies its model/effort/command catalog and only verified v155 runners advertise it.
  155,
  // 156: external Pi sessions are discovered from their native JSONL store and adopted through a
  //      runner-owned copy. Older runners cannot prove that opening a session leaves its source
  //      history untouched, so clients and control planes keep the action disabled for them.
  156,
  // 157: Orchestrator campaign policy binds child harness, model, and effort as one capability-
  //      checked selection. Older Orchestrator runners cannot guide automatic harness resolution,
  //      so fixed-harness campaigns fail with an upgrade requirement instead of dropping the bind.
  157,
  // 158: structured Claude Orchestrator launches carry a finite immutable campaign issue scope.
  //      Older runners cannot enforce it, so scoped issue coordination fails with an upgrade
  //      requirement instead of silently reverting to approval cards or strict-mode denial.
  158,
  // 159: discard_worktree reports whether runner-owned retirement completed immediately or was
  //      durably deferred until the provider releases the managed worktree.
  159,
  // 160: Orchestrator is an additive session role independent of the provider permission mode. A
  //      non-strict native Claude Code Orchestrator keeps the ordinary permission mode, built-in tool
  //      inventory, hooks, and configured MCP servers, and only gains Wollipog's orchestration tools,
  //      instructions, and scoped credential. Older runners would launch such a session as an
  //      ordinary one, so the control plane refuses the combination instead of degrading silently.
  160,
  // 161: pre-launch worktree verification publishes a durable, content-free recovery block and a
  //      distinct known-not-delivered prompt receipt. Older peers receive the conservative cancelled
  //      receipt and never see recovery state they cannot act on.
  161,
  // 162: the additive Orchestrator role extends to the native Codex and Codex App Server harnesses.
  //      A non-strict Codex Orchestrator keeps the selected permission mode's sandbox and approval
  //      semantics, its apps, plugins, hooks, multi-agent and multimodal tools, and every configured
  //      MCP server, and gains only Wollipog's MCP server and the Orchestrator instructions. A v160
  //      runner recognises the launch policy block but has no additive Codex shape for it: it refuses
  //      the launch outright, and an even older runner would start an ordinary Codex session with no
  //      orchestration surface while the control plane still granted orchestrator routes and a scoped
  //      credential. The combination is therefore refused with upgrade guidance rather than degraded.
  162,
  // 163: the additive Orchestrator role extends to the native Pi harness. A non-strict Pi
  //      Orchestrator launches exactly as an ordinary Pi session — extensions, skills, prompt
  //      templates, context files, and the built-in tool inventory are all retained, and the selected
  //      permission mode keeps enforcing approvals through the verified Agent Control bridge — and
  //      gains only the Wollipog orchestration tools already carried by that bridge plus the
  //      Orchestrator instructions. A v162 runner has no additive Pi shape for the launch policy
  //      block, and an older runner would start an ordinary Pi session with no orchestration surface
  //      while the control plane still granted orchestrator routes and a scoped credential, so the
  //      combination is refused with upgrade guidance rather than degraded. The ACP harness is
  //      deliberately excluded: #1306 audited its provider-mode permission contract and found it not
  //      sound (ADR 0010), so an ACP Orchestrator keeps the coupled preset.
  163,
  // 164: Integration Isolation is an Orchestrator execution policy of its own, independent of Strict
  //      Project Isolation and of the role. When it is enabled an additive Orchestrator launches with
  //      only Wollipog's management tools as integrations — no user-configured MCP servers, hooks,
  //      plugins, apps, extensions, skills, prompt templates, or ambient context files — while the
  //      provider permission mode, built-in tool inventory, sandbox and approval behaviour, and the
  //      project boundary stay exactly those of the ordinary additive launch. An older runner
  //      recognises the launch policy block but ignores the new field and would launch WITH every
  //      ambient integration the human asked to remove, so the control plane refuses the combination
  //      with upgrade guidance rather than silently broadening the launch. When the policy is
  //      disabled nothing new is required of the runner and the launch is byte-identical to v163's.
  164,
  // 165: the git status read publishes a content identity for the uncommitted tracked diff.
  //      GitStatusInfo gains contentSignature — a digest of `git diff HEAD --unified=0`, whose
  //      per-file headers carry git's own object ids for the worktree content. Every other status
  //      fact describes the SHAPE of the change set, so an in-place edit that rewrites a line
  //      without adding, removing, or staging anything left them all identical and the Review diff
  //      could silently lag the working tree. A present null means the runner checked and did not
  //      compute it (the change set exceeds the read's hashing budget, or HEAD is unborn); an
  //      absent field means a pre-v165 runner, and clients fall back to the status entries exactly
  //      as before. Additive + optional; no new runner behaviour is required of it.
  165,
  // 166: an Orchestrator resolving a descendant's typed workflow decision may attach a bounded
  //      child-facing message. Unlike the audit rationale it is retained on the decision, shown in
  //      the child's own decision view, and delivered to the child as the prompt that resumes it;
  //      the governance audit records only its digest. The gate runs the other way from most
  //      entries: the runner's management tool refuses to send a message to a pre-v166 control
  //      plane, which would drop the unknown field and let the resolver believe the child was told.
  //      Nothing new is required of either runner — the delivery is an ordinary prompt and the view
  //      field is passed through verbatim.
  166,
  // 167: an Orchestrator assigned UI Evidence Approval can inspect the evidence it decides on.
  //      A ui_evidence_approval evidence item gains an optional artifactId (+ mediaType) naming a
  //      first-class Session artifact that holds the exact bytes. The runner's session-management
  //      MCP server gains review_descendant_ui_evidence, which delivers one digest-verified image to
  //      the controlling Orchestrator as MCP image content and makes the control plane record a
  //      review receipt; approval by an Orchestrator requires a receipt for every item. A pre-v167
  //      runner has no such reader, so the control plane keeps those decisions human-owned.
  167,
  // 168: the Pi driver reports a steer that Pi acknowledged after its run settled as `uncertain`
  //      instead of a definite `stale_turn`, so the runner no longer re-queues text the provider may
  //      already hold. No wire shape changes; the control plane uses the version only to decide
  //      whether a Pi session may join the automatic mid-turn steering lane. A pre-v168 runner keeps
  //      Pi on queue-only admission, because its driver can still deliver such a message twice.
  168,
  // 169: an agent can attach an image file to its own session without the bytes entering the
  //      model's context. The control plane gains POST /api/sessions/:id/artifacts/screenshots,
  //      which confines a session credential to its own session and answers with metadata only; the
  //      runner's management tool attach_session_artifact (CLI: `wollipog artifact attach`) reads a
  //      named file on the runner host, uploads it there, and returns the artifact id, media type,
  //      size, and SHA-256. The gate runs runner-to-control-plane: the tool refuses a pre-v169
  //      control plane, which has no such route, rather than falling back to a base64 tool argument.
  169,
  // 170: runners advertise opaque provider-account ids and labels, bind a selected account to a
  //      session, and report account-scoped subscription usage. Credential directories remain
  //      runner-local and never cross the protocol boundary.
  170,
  // 171: an existing Claude or Codex session can schedule a same-Machine provider-account switch.
  //      The runner applies it only at a safe turn boundary, re-pins provider identity for the new
  //      credential home, resumes the same conversation, and reports an explicit parked failure.
  //      Runner-owned provider login supervisors also expose bounded, secret-minimized progress, accept
  //      one-shot paste-back codes, and persist newly authenticated accounts without sending provider
  //      credentials through the control plane. Older runners retain instruction-only auth cards.
  171,
  // 172: account-scoped skill inventory, discovery, adoption, and recovery carry the opaque
  //      provider-account id that resolves the credential home on the runner. Older peers retain
  //      legacy default-home skill behavior rather than merging or mutating an ambiguous scope.
  172,
  // 173: a revisioned, opt-in per-Machine setting lets the runner automatically schedule that same
  //      safe-boundary switch after a provider usage-window rejection. It remains disabled by
  //      default, and exhausted, unauthenticated, or cooling-down accounts are never selected.
  173,
  // 174: session reminders may explicitly use the `someday` schedule kind, with no scheduled
  //      instant or time zone. The UI capability keeps new clients from sending that shape to an
  //      older control plane; omitted scheduleKind remains the legacy timed representation.
  174,
  // 175: runners advertise independently probed harness installations with stable identities.
  //      The control plane can pin one installation per Machine and execution context, and rejects
  //      launch requests that do not resolve to that exact candidate while a pin exists.
  175,
  // 176: runner-probed container and opt-in cloud-adapter harness installations are target-bound.
  //      Exact installation ids travel with the immutable execution target and are enforced by the
  //      runner; older peers cannot persist or launch a target-specific choice.
  176,
  // 177: the control plane synchronizes saved harness choices to the runner before background usage
  //      inventory, and updates them when changed. Usage probes and external adoption enforce them.
  177,
  // 178: automatic provider-account switching pauses when harness choices cannot be synchronized.
  //      A newer control plane also suppresses it for older runners with a saved selection.
  178,
  // 179: runners attest `imageToolResults` per agent installation: its MCP client hands image
  //      content from a tool result to the model. Orchestrator UI evidence review consults that
  //      attestation instead of prompt-image transport (`supportsImages`), which describes sending an
  //      image in a prompt, not receiving one from a tool. A pre-v179 runner attests nothing, so the
  //      control plane keeps UI Evidence Approval human-owned for it.
  179,
  // 180: an Authentication Required card can ask the runner for a fresh, provider-reported current
  //      identity and choose another same-Machine, same-provider account without first accepting
  //      the current one. The identity reply is ephemeral: it answers one authorized request and
  //      never enters events, snapshots, logs, or stored identity evidence. The selection rechecks
  //      the chosen credential context and pins the identity it observed before provider work
  //      resumes. Older runners keep the existing recovery actions.
  180,
  // 181: native macOS runners adopt an unmanaged skill directory and inspect or restore its recovery
  //      journal through the fixed descriptor-anchored helper, with the same explicit confirmation,
  //      source recheck, preserved original, and exclusive link publication as Linux. Older macOS
  //      runners keep the snapshot-only refusal.
  181,
  // 182: native Windows runners adopt, inspect, and restore the same way through a fixed handle-based
  //      helper: the source stays pinned without delete sharing until a handle-relative no-replace
  //      rename, and the managed link is a junction published only by creating a new directory.
  //      Older Windows runners keep the snapshot-only refusal; WSL locations stay refused.
  182,
  // 183: runners re-verify every managed skill store copy on each reconciliation and report a copy
  //      whose bytes no longer match its version digest (typically a hand edit made through a
  //      harness link) in the additive `skills_state.drift` field. A drifted copy is never
  //      overwritten or deleted by reconciliation, update, or store GC; its links are held until a
  //      correlated `skill_drift` read or confirmed restore resolves it. Older control planes drop
  //      the unknown field, and older runners report no drift rather than a false clean result.
  183,
  // 184: Windows runners adopt, inspect, and restore Windows-hosted WSL locations inside the distro
  //      through the fixed in-distro helper, which takes the distro HOME lease itself. Recovery
  //      operations from a WSL distro carry an optional `context`; the runner reports them only to a
  //      control plane at this version, and older runners keep refusing WSL adoption.
  184,
  // 185: runners report every edited copy a restore kept aside in the store (`.drift-<id>`) in the
  //      additive `skills_state.keptAside` field, record the skill, version, variant, and time when
  //      they keep one aside, and accept a correlated `skill_kept_aside` read and a confirmed,
  //      observation-fenced discard. Older control planes drop the unknown field, and older runners
  //      report no kept-aside copies rather than a false empty result.
  185,
  // 186: sessions may attach bounded MP4/WebM video artifacts from a file. Older control planes
  //      understand only screenshot attachments and must never receive a video upload.
  186,
  // 187: runners report a prompt they accepted but cannot start because a worktree or account
  //      handoff is waiting on unfinished background work as the three-valued `queueHold` snapshot
  //      field, with `queued` status, and clear both explicitly. The control plane derives a
  //      `worktree_rebind` or `provider_account_switch` hold from it beside the v161 worktree
  //      recovery hold. Older runners leave the field absent, so a queued prompt behind such a
  //      barrier is invisible to them as before.
  187,
  // 188: a Machine owner can remove a provider account. The runner drops it from its configuration
  //      and deletes the runner-created credential home unless a session still depends on it. A new
  //      sign-in whose provider identity matches an account already on the Machine is discarded
  //      instead of being recorded twice. Older runners do not offer removal.
  188,
  // 189: an Orchestrator may receive every frame of a strictly bounded source video through the
  //      existing one-image MCP result, in manifest order. Old runners must retain human ownership.
  189,
  // 190: the session owner or the controlling Orchestrator of a session's campaign can stop one
  //      managed background job by id with a correlated `stop_background_job` request. The runner
  //      ends only that job, records it as `killed` with the actor, and proceeds as though it had
  //      ended on its own; the provider conversation and the session's other jobs keep running.
  //      Older runners do not offer the action, and the control plane refuses it for them.
  190,
  // 191: an explicit restart keeps the session's queued prompts, including decision resumes, and
  //      runs them after the relaunch in their original order. For Claude Code it carries the
  //      replaced conversation's background job records: an unfinished job is recorded as killed by
  //      the restart, and a finished result no conversation received is reported once to the new
  //      conversation through a managed continuation. The queue hold reports `restartKeepsQueue`.
  //      Older runners discard the queue and the records on restart, as before.
  191,
  // 192: a managed background job Wollipog ended carries `endedBy` on its snapshot: who asked (the
  //      runner itself, a person by role, or the controlling Orchestrator session), why, and when.
  //      No account identifier crosses. A stop Claude confirms only after the request was answered
  //      `unconfirmed` keeps the actor who asked. Older runners send no `endedBy`, and the dashboard
  //      shows the job as killed without saying who ended it, as before.
  192,
  // 193: a campaign archive can request managed worktree retirement with an additional delivery
  //      proof: the exact head is on the default branch or a forge-verified merged pull request.
  //      Older runners keep archive cleanup pending rather than discarding pushed unmerged work.
  193,
  // 194: human-owned Orchestrator issue-closure decisions and runner-managed GitHub execution.
  194,
  // 195: authoritative per-project saved-memory policy; Claude directory selection is runner-owned.
  195,
  // 196: campaign work ledger (#2417): root-keyed work items, attempts, work-item verification,
  //      reported stages, and recommendation disposition, recorded through Orchestrator-only
  //      operations that grant no publication, dispatch, merge, or decision authority. The contract
  //      is docs/campaign-work-ledger.md. Older control planes omit `OrchestratorCampaignProjection.work`
  //      and `SessionView.campaignMembership`, which clients present as unsupported, never as empty.
  196,
  // 197: request pricing coordinates, independent child usage, and raw cumulative Claude checkpoints.
  197,
  // 198: campaign forge status (#2417 slice 8): the control plane asks the runner hosting a root
  //      campaign to read the GitHub pull requests its work items name (`campaign_forge_observe`)
  //      through the runner's existing `gh` login, and the runner answers with status data only.
  //      Older runners are never asked; their campaigns show `unavailable{runner_unsupported}`.
  198,
  // 199: revision-aware historical cost corrections survive runner replay and reconnect.
  199,
  // 200: answer summaries (#2188): the control plane sends a content-safe `answerSummary` with
  //      `answer_question` and `answer_recovered_question`, and the runner records it as `answers`
  //      on the `question_resolved` it emits for exactly that request. Secret and email answers keep
  //      no content. Additive + optional: older runners ignore the field and older control planes
  //      send none, so the transcript row shows its status without an answer.
  200,
  // 201: artifact upload preferences reach session launch/resume instruction preparation. The
  //      control plane refreshes the non-secret preference outside durable command digests;
  //      older runners receive no field they cannot apply. Upload discovery grants no authority.
  201,
  // 202: every choice question accepts custom text. Multi-select labels remain arrays;
  //      a string is an exclusive custom response, even when it equals an offered label.
  202,
  // 203: human-initiated, correlated existing-session role conversion. Prepare retires the quiet
  //      provider; commit revokes old credentials before resuming the same conversation. Older peers
  //      refuse conversion. Snapshot receipts reconcile interrupted replies without inventing roles.
  203,
  // 204: Claude Code's init-time slash command catalog (#1224). Runners record `context_compacted`
  //      when the provider compacts a conversation; older peers have the event omitted from their
  //      dense history. Session capability overlays may carry `unsupportedSlashCommands` and an `mcp`
  //      command source; both are additive, so an older client lists MCP prompts as harness commands
  //      and sends an unsupported command as text, as before.
  204,
  // 205: who answered (#2527): the control plane sends `answeredByUserId`, the organization user who
  //      submitted the answer, with `answer_question` and `answer_recovered_question`, and the runner
  //      records it on the `question_resolved` it emits for exactly that request, so a shared session
  //      names its answering member per occurrence. Additive + optional: older runners ignore the
  //      field and older control planes send none; such answers read without a name, as before.
  205,
  // 206: a queued-prompt view carries `imageCount`, the number of image attachments with workspace
  //      references excluded, beside `hasImages` (#2533). The runner's live queue and the control
  //      plane's durable rows both fill it in. Additive + optional: an older peer omits it, and the
  //      queue tray labels an image-only message "Image attachment" instead of "N images", as before.
  206,
  // 207: tool exit codes (#2456): `tool_call` and `tool_call_update` carry the integer `exitCode` a
  //      provider reported for the call (Codex command items today), and a failed step shows it
  //      exactly. Additive + optional: older runners send none, so clients keep matching exit code
  //      text in the output, and older clients ignore the field.
  207,
  // 208: human-approved, revisioned campaign issue scope and bounded epic member proposals.
  208,
  // 209: replacement connections resume bounded manual skill correlations from current-server
  //      pending authority and retained runner-local admission; old peers retain timeout fallback.
  209,
  // 210: content-bound cost correction coordinates and explicitly approved metadata repair.
  210,
  // 211: who resolved a permission (#2628): the control plane sends `resolvedBy`, the organization
  //      user who submitted the decision or the governance policy that auto-resolved it, with
  //      `resolve_permission`, and the runner records it on the `permission_resolved` it emits for
  //      exactly that request, so a Decision Record names its decider per occurrence. Additive +
  //      optional: older runners ignore the field and older control planes send none; such
  //      resolutions name nobody, as before.
  211,
  // 212: lightweight session summaries and byte-bounded dashboard snapshot pages (#2769).
  212,
  // 213: authoritative bounded history previews in an explicit runner coordinate space (#2881).
  213,
  // 214: read-only descendant workflow decision inspection and nonterminal keyset pages.
  214,
  // 215: human-authorized Full Control boundary and shared, reasoned campaign authority; trusted
  //      provider request-source envelopes. Omission preserves Custom and older-peer behavior.
  215,
  // 216: live Claude Code usage (#3086): display-only provisional per-request `token_usage` records
  //      closed by a `settled` record. Runners send them only to a v216+ control plane.
  216,
  // 217: bounded Full Control issue lineage, publication admission and verified closure.
  217,
  // 218: durable campaign allowance, final managed usage and controlled native review admission.
  218,
  // 219: session snapshots carry cumulative rate-priced usage per pricing key, with cache buckets, so
  //      a snapshot covering unseen records prices them as event-first ingestion would (#3111).
  219,
  // 220: child creation may name its campaign work item (#3106): `CreateSessionRequest.campaignWorkItemId`
  //      records the child's ledger attempt before its launch is sent. An older control plane would
  //      ignore the field and leave the child unattributed, so the runner's tool and CLI refuse it
  //      against a pre-v220 control plane instead of sending it.
  220,
  // 221: pre-acceptance background capacity retry exhaustion, separate from accepted missing results.
  221,
  // 222: CLI/MCP event readers never use the legacy unpaged hydration fallback.
  222,
  // 223: runner-mediated session cross-model review (#3306): `session_review_job` and
  //      `cancel_session_review_job` commands, the `session_review_job_update` reply, and
  //      `RunnerRuntimeInfo.sessionReview`. The control plane sends a job only to a v223+ runner that
  //      advertises the capability, and the session tools refuse against an older control plane.
  223,
  // 225: provider profile grants (#3239): `adopt_provider_profile` / `revoke_provider_profile_grant`
  //      and their results, `RegisterMessage.providerProfileIds`, `RegisteredMessage.providerProfileGrants`
  //      (the complete active grants for the profiles this runner reports, plus its own accounts'
  //      pending grants), `ProviderAccountDefinition.profile`, and `SessionSnapshot.providerProfileId`
  //      (the profile a session's account binding recorded), and `StartProviderLoginMessage.profileGrantId`
  //      (the pending grant for an account created through Add Account as a managed profile). The
  //      control plane sends profile commands only to a v225+ runner; a runner projects profiles, and
  //      uses a HOME holding a profile marker, only for a v225+ control plane that lists a grant for it.
  225,
  // 226: review sessions (#3368): `SessionLaunchSpec.review`, `SessionView.kind`/`review`,
  //      `RunnerRuntimeInfo.reviewSession` and the `review_session_update` reply. The control plane
  //      creates a review session only on a v226+ runner that advertises the reviewer, and the
  //      session tools refuse against an older control plane.
  226,
  // 227: runner-managed deletion of an isolated session's own refs (#3316): the `delete_refs`
  //      `session_worktree` operation, `SessionWorktreeResultMessage.refDeletion` and the
  //      `worktree_refs_deleted` audit event. The control plane sends it only to a v227+ runner, and
  //      the session tools refuse against an older control plane.
  227,
  // 228: review runs (#3369): `ReviewLaunchPolicy.history`/`fullReason`, and `round`/`verdict` on
  //      `review_session_update`. The control plane sends a run's history only to a v228+ runner,
  //      which plans the round, scopes delta and rebase reviews and validates every attempt against
  //      the review contract; an older runner keeps reviewing full and unvalidated.
  228,
  // 229: Owner/Admin recovery of a stale provider-HOME lease (#3241): `inspect_provider_home_lease`
  //      and `recover_provider_home_lease` with their results. The control plane sends them only to
  //      a v229+ runner, and a runner answers them only for a v229+ control plane.
  229,
  // 230: Full Control worktree containment (#2940): runner filesystem evidence carries
  //      `filesystem.containment` (version 1) only after canonicalizing every target, the cwd and the
  //      session's worktree root. The control plane makes a tool request approvable only with it, so
  //      evidence from an older runner is unresolved and gets the standing decline. A v230 runner also
  //      keeps an accepted Dismiss Recovery durable until the provider turn settles, so only then does
  //      the control plane fence its standing sign-in dismissal permanently.
  230,
  // 231: runner archived-history retention: bounded trim request/result, gated by capability.
  231,
  // 232: campaign review sessions (#3371): review launches preserve campaignBudgetDispatch and
  //      report final usage checkpoints. Older runners drop it, so campaign reviews require v232.
  232,
  // 233: typed provider-HOME launch refusals (#3240): session snapshots carry
  //      `providerHomeRefusal`, the code of the lease refusal that stopped the session's last launch,
  //      so clients offer a recovery action per code. Older peers omit it and show only the text.
  233,
  // 235: extend v233 providerHomeRefusal with specific recovery causes and authorized, path-free
  //      lease-inspection process observations (#3585). Older peers retain the original shapes.
  235,
  // 236: human-approved automation creation proposals, exact execution and durable creation receipts.
  236,
  // 237: post-upvote review extensions (#3641): bind upvotedHeadSha and require delta scope.
  //      Older peers cannot admit these extensions or receive their review history marker.
  237,
  // 239: GitLab typed merges (#3602): a `pr_merge` snapshot for a host-qualified GitLab project pins
  //      its merge method, squash and source-branch settings; consuming it first asks the child's
  //      runner for `gitlab_merge_preflight`, which an older runner cannot answer, so the control
  //      plane refuses a GitLab merge decision for a pre-v239 child runner.
  239,
  // 240: display-only background follow-up execution, queue timing and blocker facts (#3682).
  240,
  // 242: closing references in GitHub merges (#3713): a GitHub `pr_merge` snapshot may declare
  //      `intendedClosures`, and requesting or arming it first asks the child's runner for
  //      `github_merge_preflight`, which reports every issue the merge would close. The control plane
  //      refuses an undeclared closure and records the check on the decision. A pre-v242 child runner
  //      is not asked; its decisions carry no `closingReferenceCheck`.
  242,
  // 243: optional server-verified review-session citations on merge decisions (#3371).
  243,
  // 244: GitLab review sessions (#3539): a review session's `pullRequest.repository` may name a
  //      host-qualified GitLab project and `number` a merge request IID. An older runner cannot read
  //      a merge request, so the control plane refuses a GitLab review for a pre-v244 runner.
  244,
  // 247: release a queue hold now (#3752). A worktree or provider-account handoff hold reports
  //      `canRelease` when its live provider can end the work it waits on, and `release_queue_hold`
  //      runs the hold's deadline path at once for the session owner or its controlling Orchestrator.
  //      An older runner reports no `canRelease`, and the control plane refuses the request for it.
  247,
  // 248: waiting for a busy provider account (#3240): a `start_session` may set
  //      `waitForProviderHome`, and the runner then retries a busy provider-HOME lease, reporting
  //      `providerHomeWait` on the starting session, instead of failing the launch. A refused
  //      conversation fork's `fork_result` carries the typed `providerHomeRefusal`. The control plane
  //      sends the wait request only to a v248+ runner; older peers keep failing busy launches.
  248,
  // 249: GitLab campaign issues (#3539): issue closure and campaign issue scope accept a host-qualified
  //      GitLab project. The runner reads and closes the issue with `glab` (a not-planned closure
  //      states its reason in a note), and a GitLab epic is its member checklist only. The control
  //      plane refuses GitLab closure or scope work on a pre-v249 runner. Publication stays GitHub-only.
  249,
  // 250: a queue hold names the work it waits on that Background Work does not list (#3752):
  //      `unlistedJobs`, each a provisional launch or an unregistered task id, and the runner no
  //      longer counts a pending id whose job this conversation already ended. Display only; an
  //      older peer omits or ignores the field.
  250,
  // 253: provider sign-in failure codes (#3519): a failed `ProviderLoginView` may carry
  //      `failureCode` from the closed `PROVIDER_LOGIN_FAILURE_CODES`, first
  //      `account_already_on_machine` for a duplicate account the runner discarded. Its `error`
  //      sentence is unchanged. The control plane passes only a known code through and puts
  //      `unrecognized` in place of any other, and dashboards fall back to matching the sentence only
  //      when the code is absent (an older runner or control plane).
  253,
  // 254: retire native review jobs; new runners require the retirement-aware control plane (#3371).
  254,
  // 255: a worktree switch a session made itself continues automatically (#3810). The control plane
  //      marks a create/attach/select that the session's own agent credential requested with
  //      `requestedBySession`, and the runner then submits one continuation turn once the relaunch the
  //      switch needs has run in the selected worktree. Every isolation notice says whether that
  //      continuation will follow (`continuesAfterRelaunch`), and create and select now return the
  //      notice as attach always has. An older runner gets no flag and goes idle after the relaunch.
  255,
  // 256: a session switching worktrees says so (#3810). A snapshot may carry `worktreeSwitch` while the
  //      runner is about to relaunch the provider in the selected worktree, or is relaunching it, so
  //      the session reads Switching Worktree instead of Idle. Display only; an older runner never
  //      reports it, and an older control plane or dashboard ignores it.
  256,
  // 258: a refused Agent TUI open is typed like a refused session launch (#3338). When the TUI's
  //      provider-HOME lease refuses it, `shell_open_result` carries the same `providerHomeRefusal` a
  //      session or fork reports, and the control plane passes a valid one to the client with its
  //      error. The runner sends it only to a v258+ control plane; older peers keep the text alone.
  258,
  // 259: Codex command sandbox nesting (#3843). Inside the runner's own bubblewrap boundary, a Codex
  //      App Server whose sandbox cannot start runs its commands under `externalSandbox`, so that
  //      boundary is the single sandbox. Anywhere else the launch fails, and its `failed`
  //      `session_status` carries `launchFailure: "codex_sandbox_unavailable"`, which a campaign
  //      reports as blocked work for the person. Discovery marks such a Codex installation
  //      unsupported with the `codex_sandbox_unavailable` failure code. An older peer omits or
  //      ignores both.
  259,
  // 260: importing an existing sign-in into a managed provider profile (#3719). A runner that can
  //      import reports `runtime.providerCredentialImport` (native Linux and macOS only, Codex only)
  //      and accepts `import_provider_credential`, which copies a Codex API-key sign-in from the
  //      runner user's own HOME or a configured account into a new managed profile and replies
  //      `import_provider_credential_result`. The control plane sends it only to a v260 runner that
  //      reports the capability; older runners never receive an import request.
  260,
  // 262: unlisted handoff work carries first-observed start times and its full count (#3894).
  //      The oldest item's type may be provisional/unregistered. Runners map these to unknown
  //      for older control planes, whose enum validation would otherwise discard the whole hold.
  262,
  // 263: session-scoped restartResumesConversation capability (#2515). Retry Turn reads the
  //      runner's actual retained conversation state; older peers omit it and clients fail closed.
  263,
  // 264: reserved by the async-review question continuation change (#3938, PR #3939).
  // v265: Orchestrators can withdraw pending human-owned review-round requests (#3941).
  264,
  // 266: campaign dirty-worktree diagnostics and controlling-Orchestrator recovery (#3942).
  266,
  // 268: immutable pre-dispatch fixedBy campaign plan relationships (#3943), with a client
  //      capability floor so older servers cannot silently ignore the new plan field.
  268,
  // 269: the requester or controlling Orchestrator withdraws a pending or approved, unconsumed and
  //      unarmed workflow decision with a reason (#3917), through
  //      POST /api/sessions/:id/workflow-decisions/:occurrenceId/withdraw. Older control planes have
  //      no route, so current clients refuse by name rather than sending it.
  269,
  // 270: FIFO processing barriers pace runner replay independently of WebSocket liveness.
  270,
  // 272: merge-queue watches (#4071). A session parks on its own enqueued pull request through
  //      POST /api/sessions/:id/pull-request-watch; the control plane sends
  //      pull_request_watch_start/cancel, the runner polls GitHub and answers with
  //      pull_request_watch_update, and the session is prompted once with the outcome. Sessions and
  //      campaigns show the watch. Older runners and control planes keep blocking waits.
  272,
  // 275: campaign handoffs (#4070). Campaign status gains terminal `complete_with_handoffs`, the
  //      projection lists `handoffs`, `update_campaign_work_item` records an item's `handoff`, and
  //      POST /api/sessions/:id/orchestrator-campaign/work-items/:itemId/delivery records delivery
  //      from forge-verified merged pull requests or a child's exact report. Dashboards below 275
  //      receive the status as `waiting_human`. GitHub forge observations carry `defaultBranch`, and
  //      a `status` git action may name a non-selected worktree the session still links; one it no
  //      longer links fails with `GIT_WORKTREE_UNLINKED`.
  275,
  // 276: delegated image evidence review (#4074). An Orchestrator hands a pending
  //      ui_evidence_approval decision's images to a managed reviewer Session whose receipts and
  //      verdict the server records, and resolves with delegatedImageReview. The reviewer launches
  //      on the root's runner with only its two review tools; older peers keep direct review.
  276,
  // 277: base-branch merges and capped Full Control review extensions (#4075). A runner proves a
  //      head is one strict merge of the moved base onto the last valid head; the control plane
  //      sends `history.baseMergeRounds` only to such a runner and then counts that round outside
  //      the epoch's budget, or records a reviewed-head equivalence (round mode `equivalent`) that
  //      the merge gate accepts. Under Full Control, the controlling Orchestrator owns
  //      review_round_extension up to a per-pull-request cap when both the requester's and the
  //      controller's runners are v277; older peers keep it with the person.
  277,
  // 278: Issue-closure inspection can read an epic's members and their states (`epicMembers`, #4060), so
  //      a Full Control completed closure of an in-scope epic can be proven from its closed members.
  278,
  // 279: workspace removal (#4123). DELETE /api/runners/:id/workspaces/:workspaceId unregisters a
  //      Workspace. A managed one is removed in the control plane; a configured one is sent as
  //      remove_workspace, and the runner records the removal in its data directory, stops
  //      advertising it and answers remove_workspace_result. Runner views tag each Workspace's
  //      `source`. Older runners keep their configured Workspaces and the control plane refuses.
  279,
  // 281: Owner decisions (#4064). A Full Control root asks its campaign's owner a typed question that
  //      only that person can answer (`owner_decision`), and hands a pending Orchestrator-owned
  //      occurrence to the owner, one way. Both need a v281 root runner and control plane; an older
  //      root keeps today's behavior.
  281,
  // 282: Full Control response attribution (#4063). When the server's Full Control policy dismisses a
  //      question or declines a tool call, `answer_question` and `resolve_permission` carry
  //      `automaticResponse`: the policy and, only when it is safe to name, the request class. A v282
  //      runner whose provider result carries text (Claude Code) tells the agent that Wollipog
  //      declined it under Full Control, that no person saw it and what to do instead (for a root's
  //      question, including the v281 owner-decision route). The field is sent only to a v282 runner;
  //      older runners keep the fixed person-worded text and the separate notices. A person's
  //      dismissal or decline never carries it.
  282,
  // 283: distinguish explicit-account availability from effective-default readiness (#4078).
  283,
  // 284: Wollipog-performed forge actions (#4067). The requester of an approved
  //      `merged_branch_deletion` (which may now name `pullRequest` and `headSha`) or of an approved,
  //      armed GitHub `pr_merge` calls POST /api/sessions/:id/workflow-decisions/:occurrenceId/execute;
  //      the control plane sends `forge_decision_action` to the child's runner, which deletes the
  //      branch by compare-and-delete or runs the canonical enqueue through the session's own forge
  //      login and answers `forge_decision_action_result`. The decision records `forgeAction`.
  //      GitHub forge observations carry `headBranch` and `crossRepository`, and the campaign
  //      projection lists `mergedBranches`; a pending merged branch keeps a campaign from
  //      `verified_complete`. Older runners never receive the action, and their campaigns keep
  //      today's completion.
  284,
  // 285: Decision Model runtime (#4101). The control plane sends `run_decision`, one tool-less,
  //      schema-constrained attempt on an explicit harness target, and a v285 runner answers
  //      `run_decision_result` with the structured output, usage and a typed error class. Discovery
  //      advertises `decisionCalls` on Claude Code and Codex App Server. An older runner never
  //      receives the call: the control plane records a non-transient `runner_incapable` failure and
  //      the caller's one typed, person-owned request follows.
  285,
  // 287: a regular session recovers from a repository mismatch (#4138). request_location_switch
  //      (`wollipog location-switch`) asks the control plane to inspect the session's Project
  //      Locations and create a human-owned `location_switch` workflow decision naming the verified
  //      Locations of the task's repository; only the session's owner decides it, and the requester
  //      executes the exact approved option. Orchestrators and child sessions are refused with their
  //      role's guidance. Older runners and control planes refuse the tool by name. (286 is claimed
  //      by an open pull request.)
  287,
  // 288: multi-repository campaign boundaries (#4117). A Full Control boundary may carry
  //      `repositories`, one entry per verified repository of the campaign's Project with its
  //      ordered Location ids. A launch inspects every Project Location; only a v288 root runner
  //      receives the list, and a Location whose runner is older is excluded as too old. Older
  //      roots keep single-repository boundaries, and stored boundaries read as one entry. (It
  //      was first claimed as 286, which no released version uses.)
  288,
  // 289: Switch and Continue (#4138). A same-runner `location_switch` approval can name the action
  //      `switch`; the control plane sends `session_location_switch` to the session's runner, which
  //      re-verifies the target workspace, path and origin, records `pendingLocationSwitch` durably,
  //      and at the next turn boundary moves the live session into a new (or recovered-branch)
  //      worktree of the target repository, carries the provider conversation over and continues.
  //      Snapshots carry `locationSwitch` (pending or failed); the control plane moves the session
  //      row only under a consumed switch naming exactly that Location.
  289,
  // 291: issue facts for selection scope (#4103). A `campaign_issue_scope` inspection may ask for
  //      `facts`; a v291 runner then answers `issueFacts` for each requested number: whether it is
  //      an issue or a pull request, its state, labels, assignees, title and a bounded body excerpt.
  //      A pull request is reported there instead of failing the read. The control plane's
  //      selection floors read these facts; an older runner reports none, so its selection
  //      proposals take the owner's route.
  291,
  // 295: closing patterns in GitLab merges (#3762). A GitLab `pr_merge` snapshot may declare
  //      `intendedClosures`, and requesting or arming it first asks the child's runner for
  //      `gitlab_merge_closures`, which reports every issue the merge would close: GitLab's default
  //      closing pattern on the description, and GitLab's own `closes_issues` list. The control plane
  //      refuses a closure that differs from the declaration and records the check on the decision.
  //      Under Full Control a checked GitLab merge whose closures are all in scope is then owned like a
  //      GitHub one. A pre-v295 child runner is not asked; its decisions carry no check and stay
  //      human-owned under Full Control. (292 to 294 are claimed by pull requests still open.)
  295,
  // 296: an owner rule on a typed workflow decision (#4137). request_workflow_decision
  //      (`wollipog decision request --owner-rule-source/--owner-rule-quote`) accepts an optional,
  //      bounded `ownerRule` naming the installed or user-authored file, and the quoted requirement,
  //      that keeps the gate for a person. The occurrence is created human-owned (`owner_kept`)
  //      under any mode, grant or category; later requests for the same resource stay the person's,
  //      and Campaign Status lists it under Waiting for You with the rule. A runner refuses the field
  //      against an older control plane, which would drop it.
  296,
  // 297: campaign activity status (#4146). Campaign Active means work is actually running: a turn, a
  //      child, a background job, a pending continuation, a parked pull request with a wake
  //      registered, or the server's own repair. Idle campaigns read `complete_needs_cleanup`
  //      (terminal, with a `cleanup` list naming each item's action), `verified_complete`, or `stuck`
  //      (with the undelivered `stuck` items); the projection's `activity` lists what is live and the
  //      server's one automatic repair of idle leftovers. Dashboards below 297 receive
  //      `complete_needs_cleanup` as `complete_with_handoffs` (below 275 as `waiting_human`) and
  //      `stuck` as `blocked`. (292-294 are claimed by open pull requests.)
  297,
  // 298: tracked waits (#1280, #4249). A runner's Wollipog MCP server reports each `wait_session`
  //      and `wait_pull_request` call through POST /api/sessions/:id/waits (start, successful polls,
  //      end), and the control plane projects `SessionView.waits`, classified under the liveness
  //      contract in session-waits.ts. An older control plane refuses the report and the runner
  //      stops reporting that call; an older dashboard ignores the field and shows the lifecycle.
  //      (292, 300, 301 and 302 are claimed by open pull requests.)
  298,
  // 302: granted issue numbers reach a live Custom Orchestrator (#4269). When a Custom campaign's
  //      first-message reading grants issue numbers, the control plane sends its v302 runner a
  //      `campaign_issue_scope` `grant_issue_numbers` operation naming the campaign session and those
  //      numbers. The runner sets them on the live launch policy (the routine-write classifier reads
  //      it on each ask) and on the stored launch metadata (the issue-closure checks read it), only for
  //      that live root Orchestrator and only while it holds no issue numbers and no issue scope; the
  //      same numbers again are a no-op. An older runner is never sent it and keeps the next-launch
  //      path. (299 to 301 are claimed by pull requests still open.)
  302,
  // 303: Owner Questions (#4270). request_owner_decision takes `kind: "question"`: an owner_decision
  //      whose snapshot reads `kind: "question"` takes 0 to 12 suggested options, is presented as an
  //      agent question with a free-text answer, and is answered through the session's question
  //      route; the answer reaches the root as a prompt. It grants nothing, so scope, boundary and
  //      policy changes leave it pending. A v303 runner sends the field only to a v303 control plane;
  //      a v303 control plane accepts it only from a v303 root runner. (299-301 are claimed by open
  //      pull requests.)
  303,
  // 307: typed Decision questions (#4283). A Decision kind may ask a list of typed questions
  //      (boolean, choice or score, optionally one answer per item) in one `run_decision` call whose
  //      output schema requires one answer per question and item, each with a value, a confidence and
  //      a short evidence string. The control plane derives the verdict from the answers with the
  //      kind's fixed rule and confidence threshold, records them on the occurrence, and projects
  //      `DecisionOccurrenceView.typedAnswers`. A v307 runner accepts the larger schema and output
  //      (DECISION_SCHEMA_MAX_CHARS, DECISION_OUTPUT_MAX_BYTES); a typed call is never sent to an older
  //      runner, which records a non-transient `runner_incapable` failure and takes the person route.
  //      Older dashboards ignore the field. (304 to 306 are claimed by open pull requests.)
  307,
  // 308: the Orchestrator proposes a Full Control campaign's scope (#4282). The owner's first message
  //      is no longer read into a scope grant: the campaign starts with an empty scope (grant status
  //      `proposal`) and dispatches nothing until the Orchestrator's initial proposal is admitted.
  //      request_campaign_issue_scope_change takes `proposal` (each issue's origin and rationale, the
  //      count, constraints and withheld operations). Deterministic floors run first; a proposal with
  //      nothing checkable beyond owner-named issues is admitted with no model call, and anything else
  //      is the owner's one approval, presented as an Owner Question. A v308 runner sends `proposal`
  //      only to a v308 control plane; a v308 control plane reads it only from a v308 root runner, and
  //      an older runner's proposal takes the owner route, and one that can't report issue facts is
  //      refused. (304 to 306 are claimed by open pull requests.)
  308,
  // 310: campaign control metadata carries its own authoritative ordering (#3363). A campaign
  //      issue scope synchronization, and an Orchestrator launch policy, add `controlRevision`: the
  //      campaign root's policy revision the control was read at. A runner keeps the newest control
  //      it was sent and never lets a delayed or reordered update replace it with an older one, even
  //      within one issue-scope revision. A pre-v310 runner is never sent the field and keeps
  //      replacing control with each synchronization.
  310,
  // 312: the Decision Model checks a scope proposal's stated constraints (#4282). A proposal that
  //      states anything checkable is asked the `scope_check` kind's typed questions in one call (the
  //      count, named versus merely mentioned, each stated constraint per chosen issue, omissions and
  //      withheld operations; never priority), and the server derives admit, refuse or uncertain. The
  //      recorded proposal carries `constraintCheck`; Campaign Status shows its answers. The call goes
  //      only to a runner with typed Decision questions (v307), and any other outcome is the owner's
  //      one approval. (309 to 311 are claimed by open pull requests.)
  312,
  // 313: repository-qualified campaign issue scope (#4118). The control plane stores the scope as
  //      `issues`, `{ repository, number }` pairs across the boundary's repositories, and sends each
  //      participating runner only its own Location repository's numbers, in the earlier shape. A
  //      v313 runner accepts that part when its origin is any repository of the boundary, not only
  //      the launch one. An Orchestrator participant in another boundary repository needs v313;
  //      one-repository campaigns are unchanged for older runners. (This change first claimed 290,
  //      293, 299, 301, 304, 305 and 309, which no released version uses; 292 and 300 are claimed by
  //      open pull requests.)
  313,
  // 315: merges in repositories without required checks (#4119). A GitHub merge preflight may ask
  //      for `checks`; the runner then also reads every check reported for the head, how many
  //      GitHub marks required, and whether its merge state is clean, so the control plane can
  //      verify a `pr_merge` snapshot whose `checksBasis` is `all_reported`. A pre-v315 runner is
  //      never asked, and the basis is refused for it. (This change first claimed 292, which no
  //      released version uses; 314 is claimed by an open pull request.)
  315,
  // 317: campaign repository additions (#4117). A campaign root asks its owner to add one Project
  //      Location's repository with request_campaign_repository_addition (`wollipog campaign
  //      repository-addition`); the control plane inspects the Location first and creates a
  //      human-owned `campaign_repository_addition` decision, and the root carries out the exact
  //      approved Location with execute_campaign_repository_addition. Older runners and control
  //      planes refuse the tools by name. (This change first claimed 290, 292, 294, 300 and 314, which
  //      no released version uses; 316 is claimed by an open pull request.)
  317,
  // 318: an Orchestrator's scope proposal names issues in any boundary repository (#4118). Each other
  //      repository's issues are read through one of its own Locations: `campaign_launch_inspect` takes
  //      `facts` and returns `issueFacts`, sent only to a v318 runner; an older one is refused by name
  //      and nothing changes. `proposal.repositoryName` is the repository the Orchestrator says the owner's
  //      message limits the work to, which the server resolves against the boundary and the constraint
  //      check judges. A v318 runner sends it only to a v318 control plane; older dashboards show the
  //      launch repository for an issue that names another. (This change first claimed 316, which no
  //      released version uses.)
  318,
  // 320: an Orchestrator's scope proposal names every repository the owner's first message limits the
  //      work to (#4117). `proposal.repositoryNames` replaces `repositoryName`, which a v318 or v319
  //      runner still sends and reads as a one-entry list; a record with one name reads the same way.
  //      Admitting the initial scope re-mints the boundary without the other repositories, and their
  //      Locations show as available in Campaign Status. A v320 runner sends one name to a v318 or v319
  //      control plane, and refuses several. Older dashboards don't show available Locations.
  320,
  // 322: a campaign's epics are repository-qualified (#4118). `issueAuthority.otherEpics` holds the
  //      boundary's other repositories' epics and is stripped for an older runner, which keeps reading
  //      `epics` as the launch repository's. `lineage.epic` and `get_campaign_issue_scope` take an optional
  //      `repository`. `campaign_launch_inspect` takes `epic` and returns `candidates`, sent only to a
  //      v322 runner; an older one is refused by name and nothing changes. A v322 runner sends a
  //      repository only to a v322 control plane. A Full Control launch's `otherIssues` are read through a
  //      Location of each repository with today's plain issue read. (This change first claimed 317 and
  //      319, which no released version uses for it; 321 is claimed by an open pull request.)
  322,
  // 323: issue closure through a Location (#4119). A `github_issue_closure` message may name a
  //      `location`: the runner inspects or closes the issue in that Location's own path, with its
  //      own forge login, instead of in an Orchestrator session's checkout, refuses an origin other
  //      than the named repository, and records each execution in a durable attempt file. Its `execute`
  //      stops at the mutation fence and answers `prepared`, and a `commit` lets it go on once the
  //      control plane has rechecked the campaign's authority. A closure in a campaign
  //      repository other than the launch one needs such a Location's runner at v323;
  //      an older runner is never sent it, and a runner refuses `repository` on an older control
  //      plane, which would ignore it. (This change first claimed 319, 320 and 321, which no released
  //      version uses.)
  323,
  // 324: a new Custom campaign starts with the repositories its Project verified (#4118), in the
  //      `repositories` list v317 added, and a Custom seed proposal refuses `repositoryNames` by name
  //      rather than ignoring it. Both are the control plane's: no runner or client needs this version.
  324,
  // 325: human-controlled reviewer executable permission policy on each Machine.
  325,
  // 326: forge facts about another campaign repository's pull requests are read through one of its
  //      Locations (#4119). `campaign_forge_observe` may name a `location`: the runner reads with its
  //      own forge login, without an Orchestrator session, and refuses a pull request of any other
  //      repository. A runner below v326 is never sent one, and its Location's facts read
  //      `runner_unsupported` rather than falling back to the root's login. (This change first
  //      claimed 325, which another change took.)
  326,
  // 327: a publication in another of a campaign's repositories is created through a Location of that
  //      repository (#4119). `forge_decision_action` may name a `location` and an `issue_publication`
  //      action: that runner creates the issue with its own forge login, with no session of its own,
  //      and answers the issue number. Consuming such a decision is refused, and a runner below v327
  //      is never sent one, so the requester's login is never used instead.
  327,
  // v328 slot
  // v329 slot
  // 329: Issue-closure decisions expose durable approval provenance (#4301). Approved re-requests
  //      are refused with the executable occurrence and digest; older readers may ignore provenance.
  329,
  // v330 slot
  // 330: a consumed `pr_merge` is watched until it lands (#4323). `merge_closure_watch` asks the
  //      child's runner what the pull request or merge request would close, in any state, or to take
  //      it out of the merge queue or train. While it is open at the approved head, closures that no
  //      longer match `intendedClosures` dequeue it and the decision stops covering it; a landed merge
  //      that closed an issue nobody approved is reported to the campaign's owner. A runner below v330
  //      is never sent one, and its merges keep the checks they had before. (This change first claimed
  //      328, which no released version uses.)
  330,
  // v331 slot
  // 331: A runner reports a campaign worker's retirement fence that no later runner process can lift
  //      (`SessionSnapshot.campaignRetirementHold`, #4331), and the control plane lets the campaign's
  //      owner, never an agent, release such a held slot. A runner below v331 reports no hold. (This
  //      change first claimed 330, which another change took.)
  331,
  // v332 slot
  // 332: child implementation questions explicitly carry kind: "question" (#4359). They use
  //      normal question forms and return free text without leaving a consumable action grant.
  //      Absent kind retains legacy approval semantics; older peers refuse new question requests.
  332,
  // v333 slot
  // v334 slot
  // 334: Per-provider account selection policy (#4353). A runner reports each account's verified
  //      billing and usage-limit cooldown, and rechecks a policy-chosen account before binding a new
  //      session. Priority Order is refused on a runner below v334, which could not recheck it, and
  //      its explicit account choices keep working. Older clients cannot overwrite a non-fixed policy.
  334,
  // v335 slot
  // 335: Review any owned worktree without selecting it; concurrent admission per pull request (#4329).
  335,
  // v336 slot
  // v337 slot
  // 337: Agent tools and the CLI can name a provider account (#4353). The control plane resolves an
  //      opaque account reference and refuses an account an agent can't use. A runner's tools refuse
  //      a choice below v337, where the reference would not resolve.
  337,
  // v338 slot
  // 338: Runs and workflows name an account per member (#4353), with an agent's opaque reference under
  //      the same refusals as a session. A runner's tools refuse a choice below v338, where a run's
  //      control plane would ignore it.
  338,
  // v339 slot
  // v340 slot
  // 340: Server-derived owner scope review causes retain verified publication lineage (#4333).
  340,
  // v341 slot
  // 341: subscription-usage snapshots may carry `subscriptionIdentity`, a one-way fingerprint of the
  //      provider account, and source views an opaque `subscriptionKey` derived from it, so one
  //      subscription on several machines shows once. Each usage window may carry `observedAt`, so
  //      machines' readings compare by when each was reported. Additive: an older runner sends
  //      neither and its sources stay separate; an older control plane drops both fields.
  341,
  // v342 slot
  // 342: A refresh also reads Claude subscription usage, through Claude Code's `get_usage` control
  //      request, and source views say which can be refreshed one at a time. A runner reads Claude
  //      only for a control plane at v342, whose refresh deadline counts those sources; an older
  //      runner keeps reporting Claude usage from session responses alone.
  342,
  // v343 slot
  // 343: Read-only forge summaries include base/head, mergeability and named CI checks (#1270).
  343,
  // v344 slot
  // 344: Approved PR merge decision reads and resolution prompts expose the canonical action (#4242).
  344,
  // v345 slot
  // 345: Read-only authoritative forge request diffs with pinned revision metadata (#1270).
  345,
  // v346 slot
  // v347 slot
  // 347: bounded published-issue field/read diagnostics and trailing body whitespace tolerance (#4404).
  347,
  // v348 slot
  // 348: Server-proven repository limits for exact owner-named scope proposals (#4402).
  348,
  // v349 slot
  // v350 slot
  // v351 slot
  // 351: Runner-verifiable failed campaign run evidence for follow-up relatedness (#4401).
  351,
  // v352 slot
  // v353 slot
  // v354 slot
  // 354: Runner-proven protocol renumbers in free base-merge review rounds (#4399).
  354,
  // v355 slot
  // 355: Read-only reconciliation of consumed uncertain issue closures (#4398).
  355,
  // v356 slot
  // 356: Audit byte-verified UI evidence receipt reuse across approval occurrences.
  356,
  // v357 slot
  // 357: Timestamped provider setup observations and transport-independent SSH readiness (#4438).
  357,
  // v358 slot
  // v359 slot
  // v360 slot
  // v361 slot
  // 361: Disclose runner-enforced provider/command credential-home write separation (#3922).
  361,
  // v362 slot
  // v363 slot
  // v364 slot
  // v365 slot
  // v366 slot
  // v367 slot
  // v368 slot
  // v369 slot
  // v370 slot
  // v371 slot
  // v372 slot
  // v373 slot
  // v374 slot
  // v375 slot
  // v376 slot
  // v377 slot
  // v378 slot
  // v379 slot
  // v380 slot
  // v381 slot
  // v382 slot
  // v383 slot
  // v384 slot
  // v385 slot
  // v386 slot
  // v387 slot
  // v388 slot
  // v389 slot
  // v390 slot
  // v391 slot
  // v392 slot
  // v393 slot
  // v394 slot
  // v395 slot
  // v396 slot
  // v397 slot
  // v398 slot
  // v399 slot
  // v400 slot
  // v401 slot
  // v402 slot
  // v403 slot
  // v404 slot
  // v405 slot
  // v406 slot
  // v407 slot
  // v408 slot
  // v409 slot
  // v410 slot
  // v411 slot
  // v412 slot
  // v413 slot
  // v414 slot
  // v415 slot
  // v416 slot
  // v417 slot
  // v418 slot
  // v419 slot
  // v420 slot
  // v421 slot
  // v422 slot
  // v423 slot
  // v424 slot
  // v425 slot
  // v426 slot
  // v427 slot
  // v428 slot
  // v429 slot
  // v430 slot
  // v431 slot
  // v432 slot
  // v433 slot
  // v434 slot
  // v435 slot
  // v436 slot
  // v437 slot
  // v438 slot
  // v439 slot
  // v440 slot
  // v441 slot
  // v442 slot
  // v443 slot
  // v444 slot
  // v445 slot
  // v446 slot
  // v447 slot
  // v448 slot
  // v449 slot
  // v450 slot
  // v451 slot
  // v452 slot
  // v453 slot
  // v454 slot
  // v455 slot
  // v456 slot
  // v457 slot
  // v458 slot
  // v459 slot
  // v460 slot
  // v461 slot
  // v462 slot
  // v463 slot
  // v464 slot
  // v465 slot
  // v466 slot
  // v467 slot
  // v468 slot
  // v469 slot
  // v470 slot
  // v471 slot
  // v472 slot
  // v473 slot
  // v474 slot
  // v475 slot
  // v476 slot
  // v477 slot
  // v478 slot
  // v479 slot
  // v480 slot
  // v481 slot
  // v482 slot
  // v483 slot
  // v484 slot
  // v485 slot
  // v486 slot
  // v487 slot
  // v488 slot
  // v489 slot
  // v490 slot
  // v491 slot
  // v492 slot
  // v493 slot
  // v494 slot
  // v495 slot
  // v496 slot
  // v497 slot
  // v498 slot
  // v499 slot
  // v500 slot
  // v501 slot
  // v502 slot
  // v503 slot
  // v504 slot
  // v505 slot
  // v506 slot
  // v507 slot
  // v508 slot
  // v509 slot
  // v510 slot
  // v511 slot
  // v512 slot
  // v513 slot
  // v514 slot
  // v515 slot
  // v516 slot
  // v517 slot
  // v518 slot
  // v519 slot
  // v520 slot
  // v521 slot
  // v522 slot
  // v523 slot
  // v524 slot
  // v525 slot
  // v526 slot
  // v527 slot
];

export const PROTOCOL_VERSION: number = Math.max(...PROTOCOL_VERSION_HISTORY);
