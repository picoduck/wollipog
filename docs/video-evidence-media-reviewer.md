# Claude Code Media-Only Video Reviewer (#1321 PR B)

This is the runner side of delegated video evidence review: the launcher for a separate, managed
Claude Code reviewer that can see only the scoped media tools. It is never the root or the child.
It is fail-closed: no review can run until PR C wires the control-plane ports and a human records
a live certification. Nothing here registers a proof, activates hosting or changes a permission.

## What the Runner Launches

`MediaReviewerDispatcher` (`apps/runner/src/media-reviewer-dispatcher.ts`) owns one reviewer per
prepared command. It is reached only through the dedicated `media_review_dispatch` message, which
carries the exact prepared `start_session` command, the transport grant, the delivery-plan digest
and the attestation digest the control plane admitted. Generic `start_session` still refuses any
`mediaReviewPurpose` before workspace, credential or driver work.

Before any provider action the dispatcher checks that:

- the command digest, root, child, Session and generation all bind the prepared purpose;
- the grant binds the same reviewer, child, occurrence, evidence and operator-validation purpose, and has not expired;
- the delivery plan digest matches `pacedVideoReviewWindowPlan(grant.frames)`;
- the driver is Claude Code, the installation is re-proven and its attestation digest is unchanged;
- box-wide host admission is available.

Any refusal records a durable never-dispatched fence and sends `media_review_never_dispatched`.
Codex keeps its specific `builtin_tool_allowlist_unavailable` refusal. Otherwise the dispatcher
claims the runner's durable dispatch fence first. From then on the command is "possibly
dispatched": a duplicate dispatch, `media_review_readback` or runner restart only reads back the
durable outcome and never relaunches.

Each window runs `claude --bare -p --input-format stream-json --output-format stream-json --verbose
--tools "" --strict-mcp-config --mcp-config /relay/mcp.json --disable-slash-commands
--no-session-persistence --permission-mode dontAsk --allowedTools <the two media tools> --model M
--effort E --max-budget-usd B` inside `prepareEvidenceReviewNamespace`. The namespace never mounts
the host root or a project. It mounts:

- `/reviewer-state`: a fresh provider HOME, removed after the review;
- `/relay`: read-only, holding exactly `relay.cjs`, `mcp.json` and `media.sock`;
- `/relay-node`: the Node runtime that runs the relay;
- the DNS/TLS files the existing network grant needs.

The relay only joins its stdio to the one runner socket. The runner serves
`serveScopedVideoReviewMcp` on that socket for exactly one connection, so no credential, path or
URL crosses into the namespace.

## Startup Proof

The provider's own `system/init` event must report exactly:

- tools `mcp__media__review_video_evidence_frame` and `mcp__media__submit_video_evidence_verdict`;
- one connected `media` MCP server;
- no slash commands, no skills, and only built-in plugins;
- the pinned CLI version, the admitted model, `permissionMode: dontAsk`;
- `apiKeySource: ANTHROPIC_API_KEY`.

With stream-json input the CLI emits init only after the first user turn arrives, and repeats it on
every turn. So the media tools refuse every call until the current window's init is verified, and
each later init is verified again. Any `tool_use` outside the two names, or any server tool, kills
the window.

Verified offline on the pinned Claude Code 2.1.296 (no credential, no model request): this exact
flag set yields that init. Under `--bare`, auth is strictly `ANTHROPIC_API_KEY`, and
`--input-format stream-json` accepts follow-up user turns in one process.

## Fresh-Context Windows

The approved delivery shape is windowed fresh-context passes with carried notes (the
implementation decision was approved with conditions).

- **Why windows.** Claude Code resends its whole base64 history on every request, so the 32 MB API
  request cap binds long before the 1M-token context. A 1280×720 frame is ⌈1280/28⌉×⌈720/28⌉ =
  1196 image tokens.
- **The plan.** `pacedVideoReviewWindowPlan` (protocol) is deterministic from the grant alone.
  Windows of at most 60 frames and 24 MiB of base64 overlap by exactly one frame, with at most 32
  windows. Paced 360 is 7 windows; maximum 900 is 16.
- **Delivery.** Each window is a separate conversation. Every batch request carries `end`, so no
  batch crosses its window.
- **Batch size.** Batches are 20 frames. Claude Code 2.1.296 estimates 1600 tokens per tool-result
  image and, above its `MAX_MCP_OUTPUT_TOKENS` cap, downscales images instead of failing. The
  reviewer namespace alone sets the cap to 100000, which keeps a full batch on the no-inspection
  path at native pixels. That setting is part of the namespace policy digest.
- **Notes.** A non-final window must end with structured notes, validated by the runner against
  `validPacedVideoReviewWindowNotes`:
  - ordered, contiguous observations covering every frame of the window;
  - every transient with its exact index and native `ptsUs`;
  - criterion-relevant defects.

  Every earlier window's notes are carried into each later window. Invalid or oversized notes get
  one correction turn in the same conversation, which still holds the frames. If that also fails,
  the window fails. Notes are never truncated.
- **Verdict.** The verdict tool is accepted once, only in the final window, after every frame of
  that window was acknowledged. Every frame's delivery receipt remains required by the control
  plane.
- **Budget.** Each window gets the remaining `--max-budget-usd`, and the tool-call ceiling spans
  windows. An unpriced window stops the review, and a review with no priced window reports
  `priced: false` rather than an invented zero.

Planning cost at Opus 5.5 ($4/MTok input) is about $2.5–3.5 for paced 360 and $6–8 for maximum 900,
including per-window overhead and cache writes. Only provider-reported usage is evidence.

## Credentials

- **The reviewer's own Session credential.** The runner mints a random bearer, registers only its
  hash through `agent_control_credential` and waits for the acknowledgement. It keeps the bearer in
  memory for `VideoReviewTransport.request`, which posts to
  `/api/sessions/<reviewer>/video-evidence-review/*`. The bearer never enters the namespace.
- **The model credential.** This is a dedicated Anthropic API key provisioned by the operator at
  `<runner data dir>/media-reviewer/<agentId>/anthropic-api-key`. The file must be regular,
  runner-owned, mode 0600, and hold `sk-ant-apiNN-…`. bwrap receives it through a private
  NUL-separated `--args` pipe, so it appears in no argv, file inside the namespace, digest or log.
- **What is refused.** The operator's own Claude login is never copied: an OAuth refresh token in a
  reviewer HOME could rotate and invalidate the operator's own sessions. Without the key file, the
  runner advertises nothing.

## Advertisement

At each registration the runner re-proves every native Claude Code agent: pinned CLI and flags,
the key file, and a provider-less bwrap launch that runs `/relay-node` inside the actual namespace.
Only then, and only to a control plane at protocol ≥ `PACED_VIDEO_REVIEW_MIN_PROTOCOL` (223), does
the agent advertise `pacedVideoReviewContract` and `mediaReviewerAttestation`. The attestation
names the profile, CLI version, executable digest, namespace policy digest, the two tools,
`credential: dedicated_api_key` and the window-limits revision.

Advertisement clears `no_paced_video_peer` and nothing else. Review still refuses as
`live_validation` until a human records a certification, and as `reviewer_unavailable` until PR C
lands. The following refuse with a specific reason:

- single-executable runners, which have no Node runtime to mount;
- non-Linux or root runners;
- hosts without unprivileged user namespaces.

## Stop

`media_review_stop` is handled by `RunnerMediaActiveStops` with the dispatcher's own registry of
running reviewers. The permanent Stop intent is committed before the signal. The signal reaches
only the owned bwrap process group, and the acknowledgement is `media_review_stop_acknowledged`.
Neither the request nor the acknowledgement settles cost, capacity or quality.

## Left for PR C

The runner's side of the wire is defined here. The control plane does not yet handle
`media_review_dispatch_receipt` or `media_review_finished`, and it ignores them. PR C wires:

- **Session ports.** The `PreparedMediaSessions` `send` (→ `media_review_dispatch`), `reconcile`
  (→ `media_review_readback` plus the receipts) and `materialize` ports.
- **Runtime and permits.** The `preparedMediaRuntime` resolver and the
  `OperatorVideoValidationPermits` ports.
- **Stop.** The owning-handle port of `PreparedMediaActiveStops`, sending `media_review_stop` over
  the owning runner channel.
- **Plan binding.** `deliveryPlanSha256` bound into the grant binding and receipts, so the verdict
  binds to exactly how frames were delivered.
- **Attestation checks.** The runner attestation checked against the live-validation registry's
  capability and namespace digests.
- **Settlement.** Final usage settlement from `media_review_finished`.
- **Routes.** The agent route allowlist for the reviewer's media credential.

## Operator Live Certification

`apps/runner/scripts/claude-media-reviewer-probe.ts` (`pnpm probe:claude-media-reviewer`) runs
offline by default: it prints the attestation or the specific refusal. With `--live` and
`WOLLIPOG_MEDIA_PROBE_CONFIRM=paid`, it runs the real windowed reviewer in its real namespace with
the dedicated key, against a local stand-in for the media routes serving the operator's PNG frames.
It records per-window notes, the verdict, provider usage and digests, and never the key or frame
bytes. Agents must not run `--live`.

Each blind challenge's one-frame transient must sit in an **early** window (window 1 or 2) of the
paced and maximum profiles, so the final verdict can report it only through carried notes. A
transient in the final window proves within-window recall only. The three inspected runs and their
evidence are then recorded through the Human-only live-validation ingress.
