# Session Reminders

Session reminders (the **Snooze Session** action) are per-user Inbox organization. They never stop,
pause, restart, archive, or otherwise change the runtime or lifecycle state of a session.

- The Snooze dialog (#2181) leads with preset tiles (Later Today, Tomorrow Morning, Next Week,
  Next Month, Someday when the server supports it, and Custom…), each showing the time it resolves
  to. Custom… reveals one **Snooze Until** field that takes phrases ("in 2 hours", "tomorrow 3pm")
  and named dates ("dec 10 9am", or the ISO "2026-12-10 09:00"); a numeric date such as "12/10/26"
  is refused at the field with both of its readings, because its day and month order is a locale's
  guess. One line under the form says when the session returns.
- **Return Early If It Needs Me** is the wake policy. Checked (the default) is `until_activity`:
  the session wakes at its scheduled instant or sooner for a qualifying agent response, approval,
  question, failure, or managed background result. Unchecked is `regardless`: it wakes only on
  schedule. While either policy is pending, the session appears only in **Snoozed**, where safety
  and input-required states remain visible and actionable.
- Each stored schedule includes an absolute instant, the IANA time zone shown when it was created,
  and the original expression. `in N days` means exactly N elapsed 24-hour periods. Editing a
  reminder keeps its stored instant until the schedule is changed, so a browser in another time
  zone never reinterprets it; its summary names the stored zone.
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
- If a stored reminder changes while its Snooze dialog is open, the local schedule and Return Early
  draft stay intact and the dialog announces the conflict in one warning notice. Saving and removal
  remain unavailable, with the reason beside the footer, until the user deliberately reloads the
  stored reminder (or, when it was removed, creates a new reminder from the draft or starts over). Optimistic edits, removals, and
  acknowledgements compare both revision and reminder identity so a removed-and-recreated reminder
  or newer snooze cannot be mistaken for the prior row. Dismissal Undo restores the removed state
  only when no current reminder exists, so it cannot overwrite a newer snooze.
- SQLite backup and restore include the `session_reminders` table. Cross-instance session transfer
  does not currently transfer reminders; this is intentionally deferred until session transfer has
  a user-identity mapping contract.
