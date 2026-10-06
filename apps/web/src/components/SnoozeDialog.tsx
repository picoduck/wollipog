import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SessionReminderView, SessionReminderWakePolicy, SetSessionReminderRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import {
  browserTimeZone,
  formatReminderInstant,
  formatReminderReturnDay,
  formatReminderTileTime,
  parseReminderExpression,
  reminderExpressionError,
  storedReminderSchedule,
  suggestReminderExpressions,
  timeZoneDisplayName,
  type ParsedReminderSchedule,
} from "../reminder-schedule.js";
import { useAnchoredMenuStyle } from "./interactions.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { AlarmClockIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import {
  Checkbox,
  ChoiceTiles,
  InlineListbox,
  SELECT_MENU_MAX_HEIGHT_PX,
  selectMenuDesiredHeight,
  useTouchTargetMode,
  type ChoiceTileOption,
} from "./ui/ChoiceControls.js";

const REMINDER_PRESETS = [
  { expression: "later today", label: "Later Today" },
  { expression: "tomorrow morning", label: "Tomorrow Morning" },
  { expression: "next week", label: "Next Week" },
  { expression: "next month", label: "Next Month" },
  { expression: "someday", label: "Someday" },
] as const;
type ReminderPresetExpression = typeof REMINDER_PRESETS[number]["expression"];
/** A preset tile, or Custom…, which reveals the Snooze Until field. */
type SnoozeChoice = ReminderPresetExpression | "custom";

const EXPRESSION_ID = "snooze-expression";
const EXPRESSION_HELPER_ID = "snooze-expression-helper";
const EXPRESSION_ERROR_ID = "snooze-expression-error";
const CHOICE_ERROR_ID = "snooze-choice-error";
const BLOCKED_REASON_ID = "snooze-blocked-reason";
/** Opening focus goes to the field only with a fine pointer, as Modal's does: on a touch phone it
 * would raise the keyboard over a sheet the person has not read yet. */
const FINE_POINTER_MEDIA = "(pointer: fine)";

/**
 * Snooze a session, edit its reminder or snooze it again (#2181).
 *
 * Six equal ChoiceTiles lead (docs/design-system.md §8.4), each with the time it resolves to; Custom…
 * reveals one Snooze Until field that takes phrases and named dates alike, with its error under it
 * (§8.5). One checkbox maps to the wake policy, and one line says when the session returns. The
 * primary stays enabled while the schedule is incomplete and moves focus to what is missing; it is
 * refused only during a reminder conflict, whose reason sits in the footer (§7.3).
 */
export function SnoozeDialog({
  sessionTitle,
  reminder,
  onClose,
  onSave,
  onRemove,
  onReconcile,
  returnFocusRef,
  supportsSomeday = false,
}: {
  /** The session's one-line title, the dialog's description. */
  sessionTitle: string;
  reminder?: SessionReminderView;
  onClose: () => void;
  onSave: (request: SetSessionReminderRequest, previous?: SessionReminderView) => Promise<void>;
  onRemove?: (previous: SessionReminderView) => Promise<void>;
  onReconcile?: () => Promise<SessionReminderView | null>;
  /** Capability-gated because older control planes require a scheduled instant. */
  supportsSomeday?: boolean;
  /** Where focus returns on close when the dialog was opened from a context menu (#154). */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const [loadedReminder, setLoadedReminder] = useState<SessionReminderView | undefined>(() => reminder);
  const [initialDraft] = useState(() => draftForReminder(loadedReminder, supportsSomeday));
  const [choice, setChoice] = useState<SnoozeChoice | null>(initialDraft.choice);
  const [expression, setExpression] = useState(initialDraft.expression);
  const [selectedSuggestion, setSelectedSuggestion] = useState<ParsedReminderSchedule | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [wakePolicy, setWakePolicy] = useState<SessionReminderWakePolicy>(initialDraft.wakePolicy);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [expressionEdited, setExpressionEdited] = useState(false);
  const [showFieldError, setShowFieldError] = useState(false);
  const [showChoiceError, setShowChoiceError] = useState(false);
  const [creatingFromDraft, setCreatingFromDraft] = useState(false);
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconciled, setReconciled] = useState<{
    reminder: SessionReminderView | null;
    liveKey: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciliationFailed, setReconciliationFailed] = useState(false);
  const expressionRef = useRef<HTMLInputElement>(null);
  const tilesRef = useRef<HTMLDivElement>(null);
  const suggestionListId = `${useId()}-suggestions`;
  /** Set when the next commit should focus the draft's control: after a reload, or a pointer on Custom…. */
  const focusDraftRef = useRef(false);
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  const reconcilingRef = useRef(false);
  const submittingRef = useRef(false);
  const liveReminderKey = reminderKey(reminder);
  const liveReminderKeyRef = useRef(liveReminderKey);
  liveReminderKeyRef.current = liveReminderKey;
  const submitting = pending !== null;
  const returnedReminder = loadedReminder?.state === "fired" ? loadedReminder : undefined;
  const reschedulingFiredReminder = returnedReminder !== undefined && !creatingFromDraft;
  const currentReminder = reconciled ? reconciled.reminder ?? undefined : reminder;
  const mutationReminder = creatingFromDraft ? undefined : loadedReminder;
  const conflict = submitting ? null : reminderConflict(mutationReminder, currentReminder);
  const custom = choice === "custom";
  const suggestions = useMemo(
    () => suggestReminderExpressions(expression, new Date())
      .filter((suggestion) => supportsSomeday || suggestion.scheduleKind !== "someday"),
    [expression, supportsSomeday],
  );
  const activeSuggestionIndex = suggestions.length === 0 || activeSuggestion < 0
    ? -1
    : Math.min(activeSuggestion, suggestions.length - 1);
  const activeSuggestionValue = suggestions[activeSuggestionIndex];
  const suggestionPopupOpen = custom && suggestionsOpen && suggestions.length > 0;
  const coarsePointer = useTouchTargetMode();
  const suggestionListStyle = useAnchoredMenuStyle(suggestionPopupOpen, expressionRef, {
    desiredHeight: selectMenuDesiredHeight({
      optionCount: suggestions.length,
      maxOptionLines: 2,
      coarsePointer,
    }),
    matchTriggerWidth: true,
    // A date that wraps at the list's width renders taller than the two lines counted above.
    measure: () => document.getElementById(suggestionListId),
    // Each query brings new dates, often as many as the last one had.
    measureKey: suggestions,
    maxHeight: SELECT_MENU_MAX_HEIGHT_PX,
  });

  const now = new Date();
  // Every time in the dialog reads in the zone its helper names, this browser's. A stored instant
  // is absolute, so showing it here reinterprets nothing, and saving still sends its own zone.
  const displayZone = browserTimeZone();
  const tileTime = (schedule: ParsedReminderSchedule) => formatReminderTileTime(
    schedule.scheduleKind === "timed" ? { ...schedule, timeZone: displayZone } : schedule,
    now.getTime(),
  );
  // Resolved when its inputs change, not on every render: a draft such as "in 2 hours" keeps the
  // instant it was given through a live update, a reconciliation or a Return Early toggle.
  const parsed = useMemo((): ParsedReminderSchedule | null => {
    if (loadedReminder && !scheduleTouched) {
      return returnedReminder ? null : storedReminderSchedule(loadedReminder);
    }
    if (!choice) return null;
    const schedule = choice === "custom"
      ? selectedSuggestion ?? parseReminderExpression(expression, new Date())
      : parseReminderExpression(choice, new Date());
    return schedule?.scheduleKind === "someday" && !supportsSomeday ? null : schedule;
  }, [choice, expression, loadedReminder, returnedReminder, scheduleTouched, selectedSuggestion, supportsSomeday]);
  // The field's error shows once it was left after an edit, or on submit (§8.5), and clears as soon
  // as the value resolves. An untouched stored schedule is never wrong.
  const fieldError = custom && showFieldError && !parsed
    ? reminderExpressionError(expression, now, supportsSomeday)
    : null;
  const choiceError = !custom && showChoiceError && !parsed
    ? choice ? reminderExpressionError(choice, now, supportsSomeday) : "Choose when it returns."
    : null;
  const tiles: ChoiceTileOption<SnoozeChoice>[] = [
    ...REMINDER_PRESETS
      .filter((preset) => supportsSomeday || preset.expression !== "someday")
      .map((preset) => {
        // The chosen tile shows the draft's own instant, which is what saving sends, not a fresh
        // resolution that moves on with the clock. `choose` never keeps a preset that does not resolve.
        const schedule = choice === preset.expression ? parsed : parseReminderExpression(preset.expression, now);
        return {
          value: preset.expression,
          label: preset.label,
          detail: schedule ? tileTime(schedule) : "Too late today",
          disabled: !schedule,
        };
      }),
    {
      value: "custom",
      label: "Custom…",
      detail: custom && parsed ? tileTime(parsed) : "Type a time",
      disabled: false,
    },
  ];
  const summary = !parsed
    ? null
    : parsed.scheduleKind === "someday"
      ? wakePolicy === "until_activity"
        ? "Stays snoozed until it needs you or you wake it."
        : "Stays snoozed until you wake it."
      : `Returns ${formatReminderReturnDay(parsed.scheduledFor, displayZone, now.getTime())}.`;
  const primaryLabel = creatingFromDraft
    ? "Create New Reminder"
    : reschedulingFiredReminder
      ? "Snooze Again"
      : loadedReminder ? "Update Reminder" : "Snooze Session";
  const blockedReason = !conflict
    ? null
    : currentReminder
      ? "Reload the reminder before saving."
      : "Create a new reminder or start over before saving.";

  // Opening focus (§7.2): the field when the draft is Custom… and a fine pointer is in use,
  // otherwise the tiles' one stop. This runs after Modal's own opening focus, a child effect.
  useEffect(() => {
    focusDraftControl(window.matchMedia?.(FINE_POINTER_MEDIA).matches ?? true);
  }, []);

  useLayoutEffect(() => {
    if (!focusDraftRef.current) return;
    focusDraftRef.current = false;
    focusDraftControl(true);
  });

  useEffect(() => {
    setReconciled((current) => current && current.liveKey !== liveReminderKey ? null : current);
  }, [liveReminderKey]);

  useEffect(() => {
    if (!suggestionPopupOpen || activeSuggestionIndex < 0) return;
    document.getElementById(`${suggestionListId}-${activeSuggestionIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeSuggestionIndex, suggestionListId, suggestionPopupOpen]);

  function focusDraftControl(field: boolean) {
    if (field && expressionRef.current) {
      expressionRef.current.focus();
      return;
    }
    tilesRef.current?.querySelector<HTMLElement>('.choice-tile[tabindex="0"]')?.focus();
  }

  const choose = (next: SnoozeChoice, byPointer: boolean) => {
    // A pointer on Custom… goes on to its field; arrows stay in the tiles so they can keep moving.
    // When Custom… is already chosen its field is mounted and nothing re-renders, so focus it now.
    if (next === choice) {
      if (next === "custom" && byPointer) expressionRef.current?.focus();
      return;
    }
    // A tile drawn before the clock passed its time (Later Today after 9 PM) is refused when
    // chosen, and the dialog redraws to say why, so a chosen preset always has its instant.
    if (next !== "custom" && !parseReminderExpression(next, new Date())) {
      redraw();
      return;
    }
    if (next === "custom" && byPointer) focusDraftRef.current = true;
    setScheduleTouched(true);
    setChoice(next);
    setSuggestionsOpen(false);
  };

  const reload = () => {
    const next = draftForReminder(currentReminder, supportsSomeday);
    focusDraftRef.current = true;
    setCreatingFromDraft(false);
    setLoadedReminder(currentReminder);
    setChoice(next.choice);
    setExpression(next.expression);
    setSelectedSuggestion(null);
    setSuggestionsOpen(false);
    setWakePolicy(next.wakePolicy);
    setScheduleTouched(false);
    setExpressionEdited(false);
    setShowFieldError(false);
    setShowChoiceError(false);
    setError(null);
    setReconciliationFailed(false);
  };

  const createNewFromDraft = () => {
    focusDraftRef.current = true;
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
      setError(`Couldn't load the current reminder. ${(cause as Error).message}`);
      setReconciliationFailed(true);
    } finally {
      reconcilingRef.current = false;
      setReconciling(false);
    }
  };

  const submit = async (schedule = parsed) => {
    if (submittingRef.current || conflict) return;
    if (!schedule) {
      // Short form (§8.5): the primary stays enabled, and pressing it shows what is missing there.
      if (custom) {
        setShowFieldError(true);
        expressionRef.current?.focus();
      } else {
        setShowChoiceError(true);
        focusDraftControl(false);
      }
      return;
    }
    submittingRef.current = true;
    setPending("save");
    setError(null);
    setReconciliationFailed(false);
    try {
      const request: SetSessionReminderRequest = {
        ...schedule,
        wakePolicy,
        expectedRevision: mutationReminder?.revision ?? 0,
        ...(mutationReminder ? { expectedReminderId: mutationReminder.reminderId } : {}),
        ...(reschedulingFiredReminder ? { rescheduleFired: true } : {}),
      };
      await onSave(request, mutationReminder);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) await reconcile();
    } finally {
      submittingRef.current = false;
      setPending(null);
    }
  };

  const selectSuggestion = (suggestion: ParsedReminderSchedule, submitAfterSelection = false) => {
    setScheduleTouched(true);
    setSelectedSuggestion(suggestion);
    setExpression(suggestion.originalExpression);
    setSuggestionsOpen(false);
    if (submitAfterSelection) void submit(suggestion);
  };

  const remove = async () => {
    if (!onRemove || !loadedReminder || creatingFromDraft || submittingRef.current || conflict) return;
    submittingRef.current = true;
    setPending("remove");
    setError(null);
    setReconciliationFailed(false);
    try {
      await onRemove(loadedReminder);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      if (cause instanceof ApiError && cause.status === 409) await reconcile();
    } finally {
      submittingRef.current = false;
      setPending(null);
    }
  };

  const dismissing = loadedReminder?.state === "fired";
  return (
    <Modal
      {...(returnFocusRef ? { returnFocusRef } : {})}
      title={creatingFromDraft
        ? "Create New Reminder"
        : reschedulingFiredReminder
          ? "Snooze Again"
          : loadedReminder ? "Edit Reminder" : "Snooze Session"}
      description={<span className="snooze-session-title" title={sessionTitle}>{sessionTitle}</span>}
      onClose={onClose}
      tertiary={!creatingFromDraft && loadedReminder && onRemove ? <BusyButton
        className="btn ghost"
        busy={pending === "remove"}
        progress={dismissing ? "Dismissing the reminder…" : "Removing the reminder…"}
        onClick={() => void remove()}
        disabled={pending === "save"}
        aria-disabled={Boolean(conflict) || undefined}
      >
        {dismissing ? "Dismiss Reminder" : "Remove Reminder"}
      </BusyButton> : undefined}
      footer={<>
        {blockedReason && <p className="snooze-blocked-reason" id={BLOCKED_REASON_ID}>{blockedReason}</p>}
        <button className="btn" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
        <BusyButton
          className="btn primary"
          type="submit"
          form="snooze-session-form"
          busy={pending === "save"}
          progress={creatingFromDraft
            ? "Creating the reminder…"
            : loadedReminder && !reschedulingFiredReminder ? "Updating the reminder…" : "Snoozing the session…"}
          disabled={pending === "remove"}
          aria-disabled={Boolean(conflict) || undefined}
          aria-describedby={blockedReason ? BLOCKED_REASON_ID : undefined}
        >
          {primaryLabel}
        </BusyButton>
      </>}
    >
      <form
        id="snooze-session-form"
        className="snooze-form"
        noValidate
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {creatingFromDraft
            ? "Creating a new reminder from the preserved draft. The removed reminder will not be restored."
            : ""}
        </span>
        {conflict && (
          <Notice
            tone="warning"
            role="alert"
            title="Reminder Changed"
            actions={currentReminder ? (
              <button className="btn sm" type="button" onClick={reload}>Reload Reminder</button>
            ) : (<>
              <button className="btn sm" type="button" onClick={createNewFromDraft}>
                Create New Reminder from Draft
              </button>
              <button className="btn sm" type="button" onClick={reload}>Start New Reminder</button>
            </>)}
          >
            {conflict} Your changes here are kept. {currentReminder
              ? "Reload it to see the current reminder."
              : "Create a new reminder from them, or start over."}
          </Notice>
        )}
        <div className="snooze-choice">
          <ChoiceTiles
            label="Return Time"
            options={tiles}
            value={choice}
            onChange={choose}
            groupRef={tilesRef}
            invalid={Boolean(choiceError)}
            describedBy={choiceError ? CHOICE_ERROR_ID : undefined}
          />
          {choiceError && <FieldError id={CHOICE_ERROR_ID}>{choiceError}</FieldError>}
        </div>
        {custom && (
          <div className="field">
            <label className="field-label" htmlFor={EXPRESSION_ID}>Snooze Until</label>
            <div className="snooze-expression-combobox">
              <input
                ref={expressionRef}
                id={EXPRESSION_ID}
                className="input"
                role="combobox"
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-expanded={suggestionPopupOpen}
                aria-controls={suggestionPopupOpen ? suggestionListId : undefined}
                aria-activedescendant={suggestionPopupOpen && activeSuggestionValue
                  ? `${suggestionListId}-${activeSuggestionIndex}`
                  : undefined}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? EXPRESSION_ERROR_ID : EXPRESSION_HELPER_ID}
                value={expression}
                onChange={(event) => {
                  setScheduleTouched(true);
                  setExpressionEdited(true);
                  setSelectedSuggestion(null);
                  setExpression(event.target.value);
                  setActiveSuggestion(-1);
                  setSuggestionsOpen(Boolean(event.target.value.trim()));
                }}
                onBlur={() => {
                  setSuggestionsOpen(false);
                  if (expressionEdited && !submittingRef.current) setShowFieldError(true);
                }}
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
                autoComplete="off"
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
                  className="snooze-suggestions ui-searchable-combobox-list menu listbox"
                  style={suggestionListStyle}
                  optionText={(suggestion) => ({
                    label: suggestion.originalExpression,
                    description: suggestion.scheduleKind === "someday"
                      ? "No automatic return time"
                      : formatReminderInstant(suggestion.scheduledFor, suggestion.timeZone),
                  })}
                />
              )}
            </div>
            {fieldError
              ? <FieldError id={EXPRESSION_ERROR_ID}>{fieldError}</FieldError>
              : (
                <p className="field-helper" id={EXPRESSION_HELPER_ID}>
                  Try “in 2 hours”, “tomorrow 3pm” or “dec 10 9am”. Times use {timeZoneDisplayName(displayZone)}.
                </p>
              )}
          </div>
        )}
        <div className="snooze-outcome">
          <Checkbox
            checked={wakePolicy === "until_activity"}
            label="Return Early If It Needs Me"
            helper="An approval, a question, a failure or finished background work brings it back sooner."
            onChange={(checked) => setWakePolicy(checked ? "until_activity" : "regardless")}
          />
          {/* Always in the document, so the line that appears is announced (a live region that is
              added with its text often is not). Empty, it has no height. */}
          <p className="snooze-summary" role="status" aria-live="polite">
            {summary && <><AlarmClockIcon size={16} aria-hidden="true" /><span>{summary}</span></>}
          </p>
        </div>
        {reconciling && <p className="snooze-reconciling" role="status">Loading the current reminder…</p>}
        {error && !reconciling && (
          <Notice
            tone="danger"
            role="alert"
            actions={reconciliationFailed && onReconcile ? (
              <button className="btn sm" type="button" onClick={() => void reconcile()}>Retry Reconciliation</button>
            ) : undefined}
          >
            {error}
          </Notice>
        )}
      </form>
    </Modal>
  );
}

function reminderKey(reminder?: SessionReminderView): string {
  return reminder ? `${reminder.reminderId}:${reminder.revision}:${reminder.state}` : "absent";
}

/**
 * Where a dialog starts. A new snooze and a fired one choose afresh; a Someday reminder starts on
 * its tile; a timed one starts on Custom… with its own words, saved as its stored instant until
 * something changes.
 */
function draftForReminder(reminder: SessionReminderView | undefined, supportsSomeday: boolean): {
  choice: SnoozeChoice | null;
  expression: string;
  wakePolicy: SessionReminderWakePolicy;
} {
  return {
    choice: !reminder || reminder.state === "fired"
      ? null
      : reminder.scheduleKind === "someday" && supportsSomeday ? "someday" : "custom",
    expression: reminder?.scheduleKind === "someday" ? "" : reminder?.originalExpression ?? "",
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
