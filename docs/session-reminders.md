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
  due sweep. The reminder is labeled **Overdue** after one minute. Due and activity reminders fire
  idempotently and stay visibly pinned until the user chooses **Dismiss Reminder**.
- Archiving does not remove or fire a reminder, and reminders never unarchive a session. Archived
  sessions are omitted from both Inbox reminder views. Deleting a session cascades its reminders.
- Shared sessions have independent schedules for each user. A reminder remains owned by its creating
  user across access-scope changes, but is returned only while that user can access the session.
- SQLite backup and restore include the `session_reminders` table. Cross-instance session transfer
  does not currently transfer reminders; this is intentionally deferred until session transfer has
  a user-identity mapping contract.
