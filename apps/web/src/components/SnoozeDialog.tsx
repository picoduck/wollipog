import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
  returnFocusRef,
}: {
  reminder?: SessionReminderView;
  onClose: () => void;
  onSave: (request: SetSessionReminderRequest) => Promise<void>;
  onRemove?: (expectedRevision: number, expectedReminderId: string) => Promise<void>;
  /** Where focus returns on close when the dialog was opened from a context menu (#154). */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const [loadedReminder, setLoadedReminder] = useState<SessionReminderView | undefined>(() => reminder);
  const initialDraft = draftForReminder(loadedReminder);
  const [expression, setExpression] = useState(initialDraft.expression);
  const [exact, setExact] = useState(initialDraft.exact);
  const [wakePolicy, setWakePolicy] = useState<SessionReminderWakePolicy>(initialDraft.wakePolicy);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expressionRef = useRef<HTMLInputElement>(null);
  const focusExpressionAfterReloadRef = useRef(false);
  const localTimeZone = browserTimeZone();
  const timeZone = loadedReminder && !scheduleTouched ? loadedReminder.timeZone : localTimeZone;
  const returnedReminder = loadedReminder?.state === "fired" ? loadedReminder : undefined;
  const conflict = submitting ? null : reminderConflict(loadedReminder, reminder);
  const parsed = useMemo(() => {
    if (loadedReminder && !scheduleTouched) return storedReminderSchedule(loadedReminder);
    return exact
      ? exactReminderSchedule(exact)
      : parseReminderExpression(expression, new Date());
  }, [exact, expression, localTimeZone, loadedReminder, scheduleTouched]);

  useLayoutEffect(() => {
    if (!focusExpressionAfterReloadRef.current) return;
    focusExpressionAfterReloadRef.current = false;
    expressionRef.current?.focus();
  }, [loadedReminder]);

  const reload = () => {
    const next = draftForReminder(reminder);
    focusExpressionAfterReloadRef.current = true;
    setLoadedReminder(reminder);
    setExpression(next.expression);
    setExact(next.exact);
    setWakePolicy(next.wakePolicy);
    setScheduleTouched(false);
    setError(null);
  };

  const submit = async () => {
    if (!parsed || submitting || conflict) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        ...parsed,
        wakePolicy,
        expectedRevision: loadedReminder?.revision ?? 0,
        ...(loadedReminder ? { expectedReminderId: loadedReminder.reminderId } : {}),
      });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!onRemove || !loadedReminder || submitting || conflict) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRemove(loadedReminder.revision, loadedReminder.reminderId);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      {...(returnFocusRef ? { returnFocusRef } : {})}
      className="snooze-dialog"
      title={loadedReminder ? "Edit Reminder" : "Snooze Session"}
      onClose={onClose}
      describedBy="snooze-description"
      footer={<>
        {loadedReminder && onRemove && <button
          className="btn ghost"
          type="button"
          onClick={() => void remove()}
          disabled={submitting}
          aria-disabled={Boolean(conflict) || undefined}
        >
          {loadedReminder.state === "fired" ? "Dismiss Reminder" : "Remove Reminder"}
        </button>}
        <span className="modal-foot-spacer" />
        <button className="btn ghost" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
        <button
          className="btn primary"
          type="submit"
          form="snooze-session-form"
          disabled={!parsed || submitting}
          aria-disabled={Boolean(conflict) || undefined}
        >
          {submitting ? "Saving…" : loadedReminder ? "Update Reminder" : "Snooze Session"}
        </button>
      </>}
    >
      <form id="snooze-session-form" className="snooze-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p id="snooze-description">
          {returnedReminder
            ? `This session returned from snooze after ${formatReminderInstant(returnedReminder.scheduledFor, returnedReminder.timeZone)}. Choose a new time to snooze it again.`
            : "Snoozing changes Inbox visibility only. Running work and lifecycle state continue unchanged."}
        </p>
        {conflict && (
          <div className="snooze-conflict" role="alert" aria-live="assertive">
            <strong>Stored Reminder Changed</strong>
            <span>{conflict} Your local draft is preserved. Continue reviewing it, or reload before saving.</span>
            <button className="btn sm" type="button" onClick={reload}>
              {reminder ? "Reload Reminder" : "Start New Reminder"}
            </button>
          </div>
        )}
        <div className="snooze-presets" role="group" aria-label="Reminder Presets">
          {["later today", "tomorrow morning", "in 1 day", "in 7 days"].map((preset) => (
            <button key={preset} className="btn sm" type="button" onClick={() => { setScheduleTouched(true); setExact(""); setExpression(preset); }}>
              {preset === "later today" ? "Later Today" : preset === "tomorrow morning" ? "Tomorrow Morning" : preset === "in 1 day" ? "In 1 Day" : "In 7 Days"}
            </button>
          ))}
        </div>
        <label className="field-label" htmlFor="snooze-expression">Natural Language</label>
        <input ref={expressionRef} id="snooze-expression" className="input" aria-describedby="snooze-expression-hint" value={expression} onChange={(event) => { setScheduleTouched(true); setExact(""); setExpression(event.target.value); }} placeholder="e.g. in 2 hours" autoFocus />
        <span className="field-hint" id="snooze-expression-hint">Supported phrases are shown by the presets, plus “in N minutes/hours/days” and “today/tomorrow at 3:30 pm.” Ambiguous numeric dates are not guessed.</span>
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

function draftForReminder(reminder?: SessionReminderView): {
  expression: string;
  exact: string;
  wakePolicy: SessionReminderWakePolicy;
} {
  const exact = reminder && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(reminder.originalExpression)
    ? reminder.originalExpression : "";
  return {
    expression: exact ? "" : reminder?.originalExpression ?? "tomorrow morning",
    exact,
    wakePolicy: reminder?.wakePolicy ?? "until_activity",
  };
}

function reminderConflict(
  loaded: SessionReminderView | undefined,
  current: SessionReminderView | undefined,
): string | null {
  if (!loaded && !current) return null;
  if (!loaded) return "A reminder was created in another client.";
  if (!current) return "The reminder was removed in another client.";
  if (loaded.reminderId !== current.reminderId) {
    return "The reminder was removed and recreated in another client.";
  }
  if (loaded.revision === current.revision) return null;
  if (loaded.state !== "fired" && current.state === "fired") return "The reminder already fired.";
  return "The reminder was updated in another client.";
}
