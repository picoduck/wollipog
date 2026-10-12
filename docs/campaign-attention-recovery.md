# Deferred Campaign Attention Recovery

Runner registration and explicit runtime batches publish campaign attention once per affected
campaign. They do not rescan or commit campaign state for every child. Two independent baselines
are required:

- A durable request baseline generates owed `request_resolved` and `human_blockers_cleared` events.
- Process-local notification progress records only human request occurrences newly reported to the
  notifier, so overlapping batches do not repeat an urgent alert already in flight.

## Crash Boundary

Before accepting the first deferred mutation for a runner/campaign pair, the control plane commits
a write-ahead checkpoint in `orchestrator_campaign_attention_checkpoints`. It stores counts, hashed
request identities and the capture timestamp, not titles, question text, answers or credentials.
Failure to commit this checkpoint prevents the mutation. A crash before the mutation is harmless:
recovery compares the unchanged authoritative state and produces no removed-request transition.

On runner reconciliation, retained checkpoints restore the original request baseline. Publication
still uses current ownership and current descendant requests. Fresh events commit in chunks of 32;
stable event identities make a partially committed publication replay-safe. The checkpoint is
removed only after publication completes. Deletion of the campaign or runner cascades its rows.

An immediate publication can clear a subset of a deferred batch's original human blockers. The
cleared event and consumption of every overlapping human baseline commit atomically. Orchestrator
request identities remain intact until their resolved events have been published. This prevents a
restart from manufacturing a second cleared event from the older, larger human-token set.

Consumed human baselines carry a durable `humanBaselineConsumed` marker. If an immediate
publication observes a fresh human blocker group while a batch remains open, it rearms only those
spent wakeup baselines with the current count and occurrence hashes in a separate
`humanWakeupBaseline` field. Notification baselines are never advanced by rearming: initially
empty and consumed baselines may still owe an urgent alert for a deferred question. A clear marks
all overlapping checkpoints spent, including a batch that began empty. Original Orchestrator
tokens and capture timestamps are preserved. A later deferred clear therefore retains its distinct
wakeup identity across restart and replay, without requiring a separate provider turn per group.
Recovery also rearms spent baselines from still-authoritative human requests before accepting
deferred mutations, covering interruption between the fresh question commit and its publication.

Recovery creates events, not permission to execute them. Existing continuation admission still
checks current policy/ownership, human blockers, Stop, archive, completion, single-flight and
ambiguous-result state. It does not answer a question, grant an approval or replay an uncertain
provider turn. Recovery runs on runner registration/runtime reconciliation; a disconnected runner
cannot execute a continuation.

## Waking the Orchestrator

Each continuation is a full-context model turn, so events wake the root Orchestrator only when it
has something to learn or do (#3083):

- **Its own resolutions wake nobody.** Every request resolution records who settled it, keyed by
  the same hashed identity the projection publishes, in
  `orchestrator_campaign_request_resolutions`. When the campaign Orchestrator settled a request
  itself, through `resolve_descendant_workflow_decision` or another descendant resolution, its
  removal records no `request_resolved` event. Any other removal of an Orchestrator-owned request
  still does. A human settling a human-owned gate records one too, besides `human_blockers_cleared`,
  which fires only once the last human gate goes.
- **Bursts share one turn.** These events are delivered after a one-second fan-in:
  - `child_ready`, `child_blocked` and `human_blockers_cleared`;
  - a `request_resolved` whose removal was caused by a human, or by no recorded resolver at all
    (an unknown resolver may have been a human).

  Any other event waits 30 seconds from the oldest undelivered event. Urgency is judged across
  the whole pending queue, not just one 64-event delivery slice. A prompt event carries everything
  pending with it, so the window never delays a human gate. The control plane checks every five
  seconds.
- **The payload says whether to act.** Each event names:
  - its request's category and title;
  - the child's current status;
  - for a settled request, its outcome and the resolver that caused the removal.

  The prompt also carries compact campaign counts and an `Action needed` line.
  - **Titles** appear only where the Orchestrator can list the request at delivery: while it is
    still pending and Orchestrator-owned, or when an Orchestrator-owned request was settled. They
    are written by child sessions, so they are flattened to one line, stripped of brackets, and
    labeled as data.
  - **`Action needed: no`** requires nothing pending for the Orchestrator, no held child, no report
    to verify, no required cleanup, and no human or unattributed resolution. It lets the turn end
    without the `get_campaign` and `list_descendant_requests` sweep.

  The prompt is control-plane text that the runner forwards verbatim, so no protocol change is
  involved.

Resolution rows are kept for seven days, so a deferred batch that replays a removal still finds
its resolver. A missing row only costs an extra wake-up.

## Notification Boundary

Own-session status/approval/delivery progress and reported child occurrences are separate from the
durable baseline. When a notifier sees added human work, only its newly added occurrence tokens are
remembered. A direct publication that merely observes a deferred question does not consume its
still-owed notification. Reported tokens augment notification comparison only; they never change
the request baseline used to generate durable events. Their lifetime ends when the last overlapping
runner batch for the campaign retires. This does not promise exactly-once push delivery across a
control-plane crash or notification-provider failure.

## Diagnostics and Verification

The bounded `campaign_attention_checkpoints_recovered` diagnostic reports entry point, runner,
recovery correlation ID and affected campaign count, without request content. If a campaign has
not resumed, inspect its checkpoint row, continuation events/cursor, current human blockers and
latest continuation state; do not manually replay an ambiguous accepted command.

`campaign_human_attention_rearmed` identifies a fresh group retained by an open batch. It records
the publication entry point, campaign, correlation ID and checkpoint count, not question contents.
Together these signals answer whether a fresh group was retained, recovered after restart, and
published as a distinct event; continuation state explains why an event did or did not resume work.

`registration-reconciliation.test.ts` tests real SIGKILL after session commits, during a partial
event publication and after event commit but before checkpoint retirement. It also verifies current
authority boundaries, atomic rollback, new versus already-reported questions and campaign-scaled
work. `runner-channel.integration.test.ts` retains the existing two-second HTTP/pong budgets while
replaying 1,500 retained campaign children against a file-backed control plane.
