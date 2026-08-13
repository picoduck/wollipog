# Pod collaboration foundation

This slice implements phase 1 of the pod/huddle roadmap: first-class collaboration groups and
manual relay between existing isolated sessions. It deliberately does not treat a pod as another
multi-agent run. A run is an execution/workflow record; a pod is a durable collaboration boundary
whose membership can evolve and can span runners, workspaces, and agent providers.

## Product behavior

- Create a pod from 2–12 existing non-terminal sessions that were launched with worktree isolation.
- Keep at most one active-pod ownership claim per session. Closing a pod preserves its historical
  membership while allowing those sessions to participate in a later active pod.
- Add or remove members while the pod is active. An active pod cannot be reduced below two members.
- Automatically close a pod if session, runner, or box deletion drops it below two members.
- Select any non-empty subset of members and manually relay one message to all of them.
- Close a pod to freeze membership and disable new relays without deleting its history.
- Hydrate and stream every member timeline in the pod detail view; open any member's canonical
  session view for the complete review, files, shell, and approval surfaces.

## Trust and isolation boundary

Pod membership never grants shared filesystem access. The service rejects non-worktree sessions,
and relay requires each selected member to have an active `worktreePath`, a non-terminal session,
no unresolved control-plane guardrail, and an online owning runner. Every target is preflighted
synchronously before the first prompt is sent, so a stale/offline member does not silently produce
a partial logical relay under normal control-plane operation.

The relayed prompt includes the exact pod title and id before the caller's text. The runner remains
the source of truth for each member's user-message event and turn lifecycle. No credentials,
filesystem contents, or cross-session transcript content are copied into the pod record.

## Persistence and live updates

- `pods` owns title, objective, lifecycle, and timestamps.
- `pod_members` owns session membership and join time independently of run membership.
- Session, runner, and box deletion cascades membership removal, closes any undersized active pod,
  and broadcasts every changed pod to connected clients.
- Initial `/ui` snapshots include pods; subsequent membership, close, and relay activity uses
  `pod_upsert` deltas.
- REST endpoints under `/api/pods` provide create/read, member add/remove, close, and relay actions.

## Deliberate next boundaries

The initial collaboration foundation did not itself persist a pod-level context transcript or automatically fan member output
into other agents. The shared-context layer added the attributed append-only huddle log, explicit settled-output
selection, and delivery receipts. The follow-up `codex/pod-orchestration-controls` slice adds roles,
bounded per-member selection/summarization, arbitration, loop detection, and stop caps. Shared-
workspace editing remains out of scope until an explicit locking or merge/reconcile design is
reviewed.
