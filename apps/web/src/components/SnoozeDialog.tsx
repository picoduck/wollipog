import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionReminderView, SessionReminderWakePolicy, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import {
  browserTimeZone,
  exactReminderSchedule,
  formatReminderInstant,
  parseReminderExpression,
  storedReminderSchedule,
  suggestReminderExpressions,
  type ParsedReminderSchedule,
} from "../reminder-schedule.js";
import { useAnchoredMenuStyle } from "./interactions.js";
import { Modal } from "./common.js";
import {
  ChoiceCards,
  InlineListbox,
  SegmentedControl,
  selectMenuDesiredHeight,
  useTouchTargetMode,
} from "./ui/ChoiceControls.js";

const REMINDER_PRESETS = [
  { expression: "later today", label: "Later Today" },
  { expression: "tomorrow morning", label: "Tomorrow Morning" },
  { expression: "next week", label: "Next Week" },
  { expression: "next month", label: "Next Month" },
] as const;
type ReminderPresetExpression = typeof REMINDER_PRESETS[number]["expression"];
const REMINDER_PRESET_OPTIONS = REMINDER_PRESETS.map((preset) => ({
  value: preset.expression,
  label: preset.label,
}));

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
  const [selectedPreset, setSelectedPreset] = useState<ReminderPresetExpression | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState<ParsedReminderSchedule | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [wakePolicy, setWakePolicy] = useState<SessionReminderWakePolicy>(initialDraft.wakePolicy);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [creatingFromDraft, setCreatingFromDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconciled, setReconciled] = useState<{
    reminder: SessionReminderView | null;
    liveKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciliationFailed, setReconciliationFailed] = useState(false);
  const expressionRef = useRef<HTMLInputElement>(null);
  const suggestionListId = `${useId()}-suggestions`;
  const focusExpressionAfterReloadRef = useRef(false);
  const reconcilingRef = useRef(false);
  const submittingRef = useRef(false);
  const liveReminderKey = reminderKey(reminder);
  const liveReminderKeyRef = useRef(liveReminderKey);
  liveReminderKeyRef.current = liveReminderKey;
  const localTimeZone = browserTimeZone();
  const timeZone = loadedReminder && !scheduleTouched ? loadedReminder.timeZone : localTimeZone;
  const returnedReminder = loadedReminder?.state === "fired" ? loadedReminder : undefined;
  const reschedulingFiredReminder = returnedReminder !== undefined && !creatingFromDraft;
  const currentReminder = reconciled ? reconciled.reminder ?? undefined : reminder;
  const mutationReminder = creatingFromDraft ? undefined : loadedReminder;
  const conflict = submitting ? null : reminderConflict(mutationReminder, currentReminder);
  const suggestions = useMemo(
    () => suggestReminderExpressions(expression, new Date()),
    [expression],
  );
  const activeSuggestionIndex = suggestions.length === 0 || activeSuggestion < 0
    ? -1
    : Math.min(activeSuggestion, suggestions.length - 1);
  const activeSuggestionValue = suggestions[activeSuggestionIndex];
  const suggestionPopupOpen = suggestionsOpen && suggestions.length > 0;
  const coarsePointer = useTouchTargetMode();
  const suggestionListStyle = useAnchoredMenuStyle(suggestionPopupOpen, expressionRef, {
    desiredHeight: selectMenuDesiredHeight({
      optionCount: suggestions.length,
      maxOptionLines: 2,
      coarsePointer,
    }),
    matchTriggerWidth: true,
  });
  const parsed = useMemo(() => {
    if (loadedReminder && !scheduleTouched) {
      return returnedReminder ? null : storedReminderSchedule(loadedReminder);
    }
    if (selectedSuggestion) return selectedSuggestion;
    if (selectedPreset) return parseReminderExpression(selectedPreset, new Date());
    return exact
      ? exactReminderSchedule(exact)
      : parseReminderExpression(expression, new Date());
  }, [exact, expression, localTimeZone, loadedReminder, returnedReminder, scheduleTouched, selectedPreset, selectedSuggestion]);
  const scheduleSource = returnedReminder && !scheduleTouched
    ? "None Selected"
    : loadedReminder && !scheduleTouched
    ? "Stored Reminder"
    : selectedSuggestion
      ? "Autocomplete"
      : selectedPreset
        ? `Preset — ${REMINDER_PRESETS.find((preset) => preset.expression === selectedPreset)?.label ?? "Selected"}`
      : exact
        ? "Exact Date and Time"
        : expression.trim()
          ? "Natural Language"
          : "None Selected";
  const scheduleMessage = parsed
    ? formatReminderInstant(parsed.scheduledFor, parsed.timeZone)
    : invalidScheduleMessage(expression, exact, selectedPreset);

  useLayoutEffect(() => {
    if (!focusExpressionAfterReloadRef.current) return;
    focusExpressionAfterReloadRef.current = false;
    expressionRef.current?.focus();
  }, [creatingFromDraft, loadedReminder]);

  useEffect(() => {
    setReconciled((current) => current && current.liveKey !== liveReminderKey ? null : current);
  }, [liveReminderKey]);

  useEffect(() => {
    if (!suggestionPopupOpen || activeSuggestionIndex < 0) return;
    document.getElementById(`${suggestionListId}-${activeSuggestionIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSuggestionIndex, suggestionListId, suggestionPopupOpen]);

  const reload = () => {
    const next = draftForReminder(currentReminder);
    focusExpressionAfterReloadRef.current = true;
    setCreatingFromDraft(false);
    setLoadedReminder(currentReminder);
    setExpression(next.expression);
    setExact(next.exact);
    setSelectedPreset(null);
    setSelectedSuggestion(null);
    setSuggestionsOpen(false);
    setWakePolicy(next.wakePolicy);
    setScheduleTouched(false);
    setError(null);
    setReconciliationFailed(false);
  };

  const createNewFromDraft = () => {
    focusExpressionAfterReloadRef.current = true;
    setCreatingFromDraft(true);
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

  const submit = async (schedule = parsed) => {
    if (!schedule || submittingRef.current || conflict) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setReconciliationFailed(false);
    try {
      await onSave({
        ...schedule,
        wakePolicy,
        expectedRevision: mutationReminder?.revision ?? 0,
        ...(mutationReminder ? { expectedReminderId: mutationReminder.reminderId } : {}),
        ...(reschedulingFiredReminder ? { rescheduleFired: true } : {}),
      }, mutationReminder);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) await reconcile();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const selectSuggestion = (suggestion: NonNullable<typeof activeSuggestionValue>, submitAfterSelection = false) => {
    setScheduleTouched(true);
    setSelectedPreset(null);
    setSelectedSuggestion(suggestion);
    setExact("");
    setExpression(suggestion.originalExpression);
    setSuggestionsOpen(false);
    if (submitAfterSelection) void submit(suggestion);
  };

  const remove = async () => {
    if (!onRemove || !loadedReminder || creatingFromDraft || submitting || conflict) return;
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
      title={creatingFromDraft
        ? "Create New Reminder"
        : reschedulingFiredReminder
          ? "Snooze Again"
          : loadedReminder ? "Edit Reminder" : "Snooze Session"}
      onClose={onClose}
      describedBy="snooze-description"
      footer={<>
        {!creatingFromDraft && loadedReminder && onRemove && <button
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
          {submitting
            ? "Saving…"
            : creatingFromDraft
              ? "Create New Reminder"
              : reschedulingFiredReminder
                ? "Snooze Again"
                : loadedReminder ? "Update Reminder" : "Snooze Session"}
        </button>
      </>}
    >
      <form id="snooze-session-form" className="snooze-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p id="snooze-description">
          {creatingFromDraft
            ? "The preserved schedule, time zone, and wake policy will create a new reminder. The removed reminder will not be restored."
            : returnedReminder
            ? `This session returned from snooze after ${formatReminderInstant(returnedReminder.scheduledFor, returnedReminder.timeZone)}. Choose a new time to snooze it again.`
            : "Snoozing changes Inbox visibility only. Running work and lifecycle state continue unchanged."}
        </p>
        <span className="sr-only" role="status" aria-live="polite">
          {creatingFromDraft
            ? "Creating a new reminder from the preserved draft. The removed reminder will not be restored."
            : ""}
        </span>
        {conflict && (
          <div className="snooze-conflict" role="alert" aria-live="assertive">
            <strong>Stored Reminder Changed</strong>
            <span>{conflict} Your local draft is preserved. {currentReminder
              ? "Continue reviewing it, or reload before saving."
              : "Create a new reminder from this draft, or discard it and start from defaults."}</span>
            {currentReminder ? (
              <button className="btn sm" type="button" onClick={reload}>Reload Reminder</button>
            ) : (<>
              <button className="btn sm" type="button" onClick={createNewFromDraft}>
                Create New Reminder from Draft
              </button>
              <button className="btn sm" type="button" onClick={reload}>Start New Reminder</button>
            </>)}
          </div>
        )}
        {reconciling && <p className="form-error" role="status">Loading current reminder state…</p>}
        {error && !reconciling && <p className="form-error" role="alert">
          {error}
          {reconciliationFailed && onReconcile && <>{" "}<button className="btn sm" type="button" onClick={() => void reconcile()}>
            Retry Reconciliation
          </button></>}
        </p>}
        <SegmentedControl
          className="snooze-presets"
          label="Reminder Presets"
          options={REMINDER_PRESET_OPTIONS}
          value={selectedPreset}
          onChange={(preset) => {
            setScheduleTouched(true);
            setSelectedPreset(preset);
            setSelectedSuggestion(null);
            setExact("");
            setExpression("");
            setSuggestionsOpen(false);
          }}
        />
        <label className="field-label" htmlFor="snooze-expression">Natural Language</label>
        <div className="snooze-expression-combobox">
          <input
            ref={expressionRef}
            id="snooze-expression"
            className="input"
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={suggestionPopupOpen}
            aria-controls={suggestionPopupOpen ? suggestionListId : undefined}
            aria-activedescendant={suggestionPopupOpen && activeSuggestionValue
              ? `${suggestionListId}-${activeSuggestionIndex}`
              : undefined}
            aria-describedby="snooze-expression-hint"
            value={expression}
            onChange={(event) => {
              setScheduleTouched(true);
              setSelectedPreset(null);
              setSelectedSuggestion(null);
              setExact("");
              setExpression(event.target.value);
              setActiveSuggestion(-1);
              setSuggestionsOpen(Boolean(event.target.value.trim()));
            }}
            onBlur={() => setSuggestionsOpen(false)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Tab") {
                setSuggestionsOpen(false);
                return;
              }
              if (event.key === "Escape" && suggestionPopupOpen) {
                event.preventDefault();
                event.stopPropagation();
                setSuggestionsOpen(false);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (suggestions.length === 0) return;
                event.preventDefault();
                if (!suggestionPopupOpen) {
                  setSuggestionsOpen(true);
                  setActiveSuggestion(event.key === "ArrowDown" ? 0 : suggestions.length - 1);
                  return;
                }
                if (activeSuggestionIndex < 0) {
                  setActiveSuggestion(event.key === "ArrowDown" ? 0 : suggestions.length - 1);
                  return;
                }
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveSuggestion((activeSuggestionIndex + delta + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Enter" && suggestionPopupOpen && activeSuggestionValue) {
                event.preventDefault();
                selectSuggestion(activeSuggestionValue, true);
              }
            }}
            placeholder="Try “in 2 hours”"
            autoComplete="off"
            autoFocus
          />
          {suggestionPopupOpen && (
            <InlineListbox
              id={suggestionListId}
              label="Schedule Suggestions"
              options={suggestions}
              activeIndex={activeSuggestionIndex}
              getKey={(suggestion) => suggestion.originalExpression}
              onActiveChange={setActiveSuggestion}
              onSelect={selectSuggestion}
              className="snooze-suggestions ui-searchable-combobox-list ui-select-list"
              style={suggestionListStyle}
              renderOption={(suggestion) => (
                <span className="ui-select-option-body">
                  <span>{suggestion.originalExpression}</span>
                  <small className="ui-select-option-desc">
                    {formatReminderInstant(suggestion.scheduledFor, suggestion.timeZone)}
                  </small>
                </span>
              )}
            />
          )}
        </div>
        <span className="field-hint" id="snooze-expression-hint">Start typing to see schedules supported by the reminder parser. Numeric dates belong in Exact Date and Time.</span>
        <label className="field-label" htmlFor="snooze-exact">Exact Date and Time</label>
        <input id="snooze-exact" className="input" type="datetime-local" value={exact} onChange={(event) => { setScheduleTouched(true); setSelectedPreset(null); setSelectedSuggestion(null); setSuggestionsOpen(false); setExact(event.target.value); }} />
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
          <span>{scheduleMessage}</span>
          <span>Schedule Source: {scheduleSource}</span>
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
    expression: exact ? "" : reminder?.originalExpression ?? "",
    exact,
    wakePolicy: reminder?.wakePolicy ?? "until_activity",
  };
}

function invalidScheduleMessage(
  expression: string,
  exact: string,
  selectedPreset: ReminderPresetExpression | null,
): string {
  if (exact) return "Choose an exact date and time in the future.";
  if (selectedPreset === "later today") return "Later Today is no longer available. Choose another future schedule.";
  const normalized = expression.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) return "Choose a preset or enter a future schedule.";
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(normalized)) {
    return "Numeric dates are ambiguous. Use Exact Date and Time instead.";
  }
  if (/^in 0 (minute|minutes|hour|hours|day|days)$/.test(normalized)) {
    return "That schedule is not in the future. Choose a positive interval.";
  }
  const todayClock = /^today(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(normalized);
  if (todayClock) {
    const hour = Number(todayClock[1]);
    const minute = Number(todayClock[2] ?? "0");
    const validHour = todayClock[3] ? hour >= 1 && hour <= 12 : hour <= 23;
    if (!validHour || minute > 59) {
      return "Enter a valid clock time, such as today at 3:30 PM.";
    }
    return "That time is not in the future. Choose a later time or use tomorrow.";
  }
  return "Complete a supported phrase or choose a schedule suggestion.";
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
