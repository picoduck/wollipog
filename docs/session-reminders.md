# Session Reminders

Session reminders (the **Snooze Session** action) are per-user Inbox organization. They never stop,
pause, restart, archive, or otherwise change the runtime or lifecycle state of a session.

- **Until Activity** wakes for a scheduled instant or qualifying agent response, approval,
  question, failure, or managed background result. **Regardless** wakes only on schedule. Safety and
  input-required states remain visible in the ordinary Inbox while snoozed.
- Each stored schedule includes an absolute instant, the IANA time zone shown when it was created,
  and the original expression. `in N days` means exactly N elapsed 24-hour periods. Exact local
  date/time input is previewed as an absolute zoned instant; ambiguous numeric dates are rejected.
- A machine that is offline at the scheduled instant fires the reminder during the next control-plane
  due sweep. Scheduled wakes return to the Inbox as **Returned from Snooze** with their snooze-end
  context; qualifying activity wakes return as **Activity Reminder** with the instant they were
  scheduled for. Both fire idempotently and stay visibly pinned until acknowledged. A successfully
  accepted human prompt acknowledges that user's fired reminder, including when submitted through
  the API. Failed, rejected, or offline prompt attempts leave it intact. Agent-control and other
  automated prompts carry no human identity and do not acknowledge user-owned reminders.
- A returned reminder can also be acknowledged with **Dismiss Reminder**. Dismissal offers **Undo**,
  which restores the exact fired reminder state. **Snooze Again…** opens the existing schedule for a
  new snooze instead of dismissing it.
- Archiving does not remove or fire a reminder, and reminders never unarchive a session. Archived
  sessions are omitted from both Inbox reminder views. Deleting a session cascades its reminders.
- Shared sessions have independent schedules for each user. A reminder remains owned by its creating
  user across access-scope changes, is acknowledged only by that user's accepted human prompt or
  explicit action, and is returned only while that user can access the session.
- If a stored reminder changes while its Snooze dialog is open, the local schedule and Wake Policy
  draft stay intact and the dialog announces the conflict. Saving and removal remain unavailable
  until the user deliberately reloads the stored reminder. Optimistic edits, removals, and
  acknowledgements compare both revision and reminder identity so a removed-and-recreated reminder
  or newer snooze cannot be mistaken for the prior row. Dismissal Undo restores the removed state
  only when no current reminder exists, so it cannot overwrite a newer snooze.
- SQLite backup and restore include the `session_reminders` table. Cross-instance session transfer
  does not currently transfer reminders; this is intentionally deferred until session transfer has
  a user-identity mapping contract.
