import { useMemo, useState } from "react";
import type { SessionReminderView, SessionReminderWakePolicy, SetSessionReminderRequest } from "@wollipog/protocol";
import {
  browserTimeZone,
  exactReminderSchedule,
  formatReminderInstant,
  parseReminderExpression,
  storedReminderSchedule,
} from "../reminder-schedule.js";
import { Modal } from "./common.js";
import { ChoiceCards } from "./ui/ChoiceControls.js";

export function SnoozeDialog({
  reminder,
  onClose,
  onSave,
  onRemove,
}: {
  reminder?: SessionReminderView;
  onClose: () => void;
  onSave: (request: SetSessionReminderRequest) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const existingExact = reminder && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(reminder.originalExpression)
    ? reminder.originalExpression : "";
  const [expression, setExpression] = useState(existingExact ? "" : reminder?.originalExpression ?? "tomorrow morning");
  const [exact, setExact] = useState(existingExact);
  const [wakePolicy, setWakePolicy] = useState<SessionReminderWakePolicy>(reminder?.wakePolicy ?? "until_activity");
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localTimeZone = browserTimeZone();
  const timeZone = reminder && !scheduleTouched ? reminder.timeZone : localTimeZone;
  const parsed = useMemo(() => {
    if (reminder && !scheduleTouched) return storedReminderSchedule(reminder);
    return exact
      ? exactReminderSchedule(exact, localTimeZone)
      : parseReminderExpression(expression, new Date(), localTimeZone);
  }, [exact, expression, localTimeZone, reminder, scheduleTouched]);

  const submit = async () => {
    if (!parsed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        ...parsed,
        wakePolicy,
        expectedRevision: reminder?.revision ?? 0,
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!onRemove || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={reminder ? "Edit Reminder" : "Snooze Session"}
      onClose={onClose}
      describedBy="snooze-description"
      footer={<>
        {reminder && <button className="btn ghost" type="button" onClick={() => void remove()} disabled={submitting}>
          {reminder.state === "fired" ? "Dismiss Reminder" : "Remove Reminder"}
        </button>}
        <span className="modal-foot-spacer" />
        <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="btn primary" type="submit" form="snooze-session-form" disabled={!parsed || submitting}>
          {submitting ? "Saving…" : reminder ? "Update Reminder" : "Snooze Session"}
        </button>
      </>}
    >
      <form id="snooze-session-form" className="snooze-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p id="snooze-description">Snoozing changes Inbox visibility only. Running work and lifecycle state continue unchanged.</p>
        <div className="snooze-presets" role="group" aria-label="Reminder Presets">
          {["later today", "tomorrow morning", "in 1 day", "in 7 days"].map((preset) => (
            <button key={preset} className="btn sm" type="button" onClick={() => { setScheduleTouched(true); setExact(""); setExpression(preset); }}>
              {preset === "later today" ? "Later Today" : preset === "tomorrow morning" ? "Tomorrow Morning" : preset === "in 1 day" ? "In 1 Day" : "In 7 Days"}
            </button>
          ))}
        </div>
        <label className="field-label" htmlFor="snooze-expression">Natural Language</label>
        <input id="snooze-expression" className="input" value={expression} onChange={(event) => { setScheduleTouched(true); setExact(""); setExpression(event.target.value); }} placeholder="e.g. in 2 hours" autoFocus />
        <span className="field-hint">Supported phrases are shown by the presets, plus “in N minutes/hours/days” and “today/tomorrow at 3:30 pm.” Ambiguous numeric dates are not guessed.</span>
        <label className="field-label" htmlFor="snooze-exact">Exact Date and Time</label>
        <input id="snooze-exact" className="input" type="datetime-local" value={exact} onChange={(event) => { setScheduleTouched(true); setExact(event.target.value); }} />
        <ChoiceCards<SessionReminderWakePolicy>
          className="snooze-policy"
          label="Wake Policy"
          value={wakePolicy}
          options={[
            {
              value: "until_activity", title: "Until Activity",
              description: "Return at this time or sooner for an agent response, approval, question, failure, or managed background result.",
            },
            {
              value: "regardless", title: "Regardless",
              description: "Return only at the scheduled time; attention-required lifecycle states remain discoverable.",
            },
          ]}
          onChange={setWakePolicy}
        />
        <div className="snooze-preview" role="status" aria-live="polite">
          <strong>Scheduled Instant</strong>
          <span>{parsed ? formatReminderInstant(parsed.scheduledFor, parsed.timeZone) : "Enter an unambiguous future time."}</span>
          <span>Time Zone: {timeZone}</span>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
