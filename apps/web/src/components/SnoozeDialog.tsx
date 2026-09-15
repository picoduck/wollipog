import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionReminderView, SessionReminderWakePolicy, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
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
  onReconcile,
  returnFocusRef,
}: {
  reminder?: SessionReminderView;
  onClose: () => void;
  onSave: (request: SetSessionReminderRequest, previous?: SessionReminderView) => Promise<void>;
  onRemove?: (previous: SessionReminderView) => Promise<void>;
  onReconcile?: () => Promise<SessionReminderView | null>;
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
  const [reconciling, setReconciling] = useState(false);
  const [reconciled, setReconciled] = useState<{
    reminder: SessionReminderView | null;
    liveKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciliationFailed, setReconciliationFailed] = useState(false);
  const expressionRef = useRef<HTMLInputElement>(null);
  const focusExpressionAfterReloadRef = useRef(false);
  const reconcilingRef = useRef(false);
  const liveReminderKey = reminderKey(reminder);
  const liveReminderKeyRef = useRef(liveReminderKey);
  liveReminderKeyRef.current = liveReminderKey;
  const localTimeZone = browserTimeZone();
  const timeZone = loadedReminder && !scheduleTouched ? loadedReminder.timeZone : localTimeZone;
  const returnedReminder = loadedReminder?.state === "fired" ? loadedReminder : undefined;
  const currentReminder = reconciled ? reconciled.reminder ?? undefined : reminder;
  const conflict = submitting ? null : reminderConflict(loadedReminder, currentReminder);
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

  useEffect(() => {
    setReconciled((current) => current && current.liveKey !== liveReminderKey ? null : current);
  }, [liveReminderKey]);

  const reload = () => {
    const next = draftForReminder(currentReminder);
    focusExpressionAfterReloadRef.current = true;
    setLoadedReminder(currentReminder);
    setExpression(next.expression);
    setExact(next.exact);
    setWakePolicy(next.wakePolicy);
    setScheduleTouched(false);
    setError(null);
    setReconciliationFailed(false);
  };

  const reconcile = async () => {
    if (!onReconcile || reconcilingRef.current) return;
    reconcilingRef.current = true;
    setReconciling(true);
    const startedWithLiveKey = liveReminderKeyRef.current;
    try {
      const authoritative = await onReconcile();
      const latestLiveKey = liveReminderKeyRef.current;
      if (latestLiveKey === startedWithLiveKey) {
        setReconciled({ reminder: authoritative, liveKey: latestLiveKey });
      } else {
        // A live change observed after the read started is the fresher client observation.
        setReconciled(null);
      }
      setError(null);
      setReconciliationFailed(false);
    } catch (cause) {
      setError(`Unable to load the current reminder state. ${(cause as Error).message}`);
      setReconciliationFailed(true);
    } finally {
      reconcilingRef.current = false;
      setReconciling(false);
    }
  };

  const submit = async () => {
    if (!parsed || submitting || conflict) return;
    setSubmitting(true);
    setError(null);
    setReconciliationFailed(false);
    try {
      await onSave({
        ...parsed,
        wakePolicy,
        expectedRevision: loadedReminder?.revision ?? 0,
        ...(loadedReminder ? { expectedReminderId: loadedReminder.reminderId } : {}),
      }, loadedReminder);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) await reconcile();
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!onRemove || !loadedReminder || submitting || conflict) return;
    setSubmitting(true);
    setError(null);
    setReconciliationFailed(false);
    try {
      await onRemove(loadedReminder);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) await reconcile();
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
              {currentReminder ? "Reload Reminder" : "Start New Reminder"}
            </button>
          </div>
        )}
        {reconciling && <p className="form-error" role="status">Loading current reminder state…</p>}
        {error && !reconciling && <p className="form-error" role="alert">
          {error}
          {reconciliationFailed && onReconcile && <>{" "}<button className="btn sm" type="button" onClick={() => void reconcile()}>
            Retry Reconciliation
          </button></>}
        </p>}
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
              description: "Return only at the scheduled time. Approvals, questions, and failures remain available on the session in Snoozed.",
            },
          ]}
          onChange={setWakePolicy}
        />
        <div className="snooze-preview" role="status" aria-live="polite">
          <strong>Scheduled Instant</strong>
          <span>{parsed ? formatReminderInstant(parsed.scheduledFor, parsed.timeZone) : "Enter an unambiguous future time."}</span>
          <span>Time Zone: {timeZone}</span>
        </div>
      </form>
    </Modal>
  );
}

function reminderKey(reminder?: SessionReminderView): string {
  return reminder ? `${reminder.reminderId}:${reminder.revision}:${reminder.state}` : "absent";
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
