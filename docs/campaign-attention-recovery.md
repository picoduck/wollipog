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
spent baselines with the current count and occurrence hashes. Initially empty baselines are not
advanced: they may still owe an urgent notification for a deferred question. Original Orchestrator
tokens and capture timestamps are preserved. A later deferred clear therefore retains its distinct
wakeup identity across restart and replay, without requiring a separate provider turn per group.

Recovery creates events, not permission to execute them. Existing continuation admission still
checks current policy/ownership, human blockers, Stop, archive, completion, single-flight and
ambiguous-result state. It does not answer a question, grant an approval or replay an uncertain
provider turn. Recovery runs on runner registration/runtime reconciliation; a disconnected runner
cannot execute a continuation.

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
