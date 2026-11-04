import React, { useId, useRef, useState } from "react";
import type { UsageDailyBudgetPolicy, UsageRetentionPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  BUDGET_HISTORY_FIELDS,
  budgetDraft,
  budgetHistoryChanges,
  budgetHistoryErrors,
  dailyHelper,
  draftValues,
  fixFieldsSentence,
  SAVED_TOAST,
  saveFailureSentence,
  savedToastDetail,
  shortenHistoryMessage,
  shorterWarning,
  type BudgetHistoryDraft,
  type BudgetHistoryField,
  type BudgetHistorySaved,
} from "../budget-history.js";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useIsMobile } from "./useIsMobile.js";

const BUDGET_HELPER = "New turns pause for the rest of the UTC day once a person reaches it. Leave empty for no limit.";
const HOURLY_HELPER = "1 to 90 days.";
const HISTORY_NOTE = "Only usage charts use this history. Transcripts and audit logs are kept separately.";

interface SaveFailure {
  sentence: string;
  detail: string;
}

/**
 * Budget and History (#3015): the daily budget per person and how long usage history is kept, for
 * owners and admins, in one `<form noValidate>` with one Save Changes (§7, §8.6 Dialog).
 *
 * Fields validate on blur after an edit and all of them on submit, which moves focus to the first
 * invalid one and sends nothing. Save Changes sends only what differs from what is saved: the budget,
 * then the retention, stopping at the first failure. A shorter period first asks Shorten Usage
 * History, which stacks on desktop and replaces the sheet on a phone; Back or Cancel there keeps
 * every value and returns focus to Save Changes. A part that saved is reported to the page at once
 * and becomes the dialog's baseline, so a retry sends only what is left.
 */
export function BudgetHistoryDialog({
  budget,
  retention,
  focusBudget = false,
  onBudgetSaved,
  onRetentionSaved,
  onClose,
}: {
  budget: UsageDailyBudgetPolicy;
  retention: UsageRetentionPolicy;
  /** Change Budget… opens the dialog with focus in the budget field, on every pointer. */
  focusBudget?: boolean;
  onBudgetSaved: (budget: UsageDailyBudgetPolicy) => void;
  onRetentionSaved: (retention: UsageRetentionPolicy) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const phone = useIsMobile();
  const ids = useId();
  const formId = `budget-history-${ids}`;
  const fieldId = (field: BudgetHistoryField, part: "input" | "helper" | "error" | "warning") => `${ids}-${field}-${part}`;
  const [saved, setSaved] = useState<BudgetHistorySaved>(() => ({
    budgetUsd: budget.perUserUsd,
    hourlyDays: retention.hourlyDays,
    dailyDays: retention.dailyDays,
  }));
  const [draft, setDraft] = useState<BudgetHistoryDraft>(() => ({
    budget: budgetDraft(budget.perUserUsd),
    hourly: String(retention.hourlyDays),
    daily: String(retention.dailyDays),
  }));
  const [edited, setEdited] = useState<Partial<Record<BudgetHistoryField, boolean>>>({});
  // Whether each field's error is showing. The message itself is computed from the current values,
  // so Daily Totals' range follows Hourly Detail while its error shows.
  const [shown, setShown] = useState<Partial<Record<BudgetHistoryField, boolean>>>({});
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saving, setSaving] = useState(false);
  // Held from Save Changes until the save settles, through the confirmation, so a second submit
  // can neither ask twice nor send twice.
  const submitting = useRef(false);
  const savingRef = useRef(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const inputRefs = {
    budget: useRef<HTMLInputElement>(null),
    hourly: useRef<HTMLInputElement>(null),
    daily: useRef<HTMLInputElement>(null),
  };

  const errors = budgetHistoryErrors(draft);
  const visibleErrors = BUDGET_HISTORY_FIELDS.filter((field) => shown[field] && errors[field]);
  const warnings = {
    hourly: errors.hourly ? null : shorterWarning("hourly", draft.hourly, saved.hourlyDays),
    daily: errors.daily ? null : shorterWarning("daily", draft.daily, saved.dailyDays),
  };

  const close = () => {
    if (!savingRef.current) onClose();
  };

  const change = (field: BudgetHistoryField, value: string) => {
    if (savingRef.current) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    setFailure(null);
    setEdited((current) => ({ ...current, [field]: true }));
    // An error clears as soon as the value is valid (§8.5); a new one waits for blur or submit.
    if (shown[field] && !budgetHistoryErrors(next)[field]) setShown((current) => ({ ...current, [field]: false }));
  };

  const blur = (field: BudgetHistoryField) => {
    if (edited[field]) setShown((current) => ({ ...current, [field]: true }));
  };

  const submit = async () => {
    if (submitting.current) return;
    if (BUDGET_HISTORY_FIELDS.some((field) => errors[field])) {
      setShown({ budget: true, hourly: true, daily: true });
      inputRefs[BUDGET_HISTORY_FIELDS.find((field) => errors[field])!].current?.focus();
      return;
    }
    const next = draftValues(draft);
    const changes = budgetHistoryChanges(next, saved);
    if (!changes.budget && !changes.retention) {
      onClose();
      return;
    }
    submitting.current = true;
    try {
      if ((changes.shorterHourly || changes.shorterDaily) && !await confirm({
        title: "Shorten Usage History",
        message: shortenHistoryMessage(next, changes, Date.now(), retention.coverageStartedAt),
        confirmLabel: "Shorten History",
        tone: "danger",
        returnFocus: saveRef,
      })) return;
      savingRef.current = true;
      setSaving(true);
      setFailure(null);
      let step: "budget" | "retention" = "budget";
      try {
        if (changes.budget) {
          const result = await api.updateUsageDailyBudget(next.budgetUsd);
          setSaved((current) => ({ ...current, budgetUsd: result.dailyBudget.perUserUsd }));
          onBudgetSaved(result.dailyBudget);
        }
        step = "retention";
        let savedRetention: Pick<UsageRetentionPolicy, "hourlyDays" | "dailyDays"> = saved;
        if (changes.retention) {
          const result = await api.updateUsageRetention({ hourlyDays: next.hourlyDays, dailyDays: next.dailyDays });
          savedRetention = result.retention;
          setSaved((current) => ({ ...current, hourlyDays: result.retention.hourlyDays, dailyDays: result.retention.dailyDays }));
          onRetentionSaved(result.retention);
        }
        savingRef.current = false;
        setSaving(false);
        showToast(SAVED_TOAST, { tone: "success", detail: savedToastDetail(next.budgetUsd, savedRetention) });
        onClose();
      } catch (cause) {
        savingRef.current = false;
        setSaving(false);
        setFailure({
          sentence: saveFailureSentence(step, changes),
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    } finally {
      submitting.current = false;
    }
  };

  const describedBy = (field: BudgetHistoryField, warning: string | null) => [
    shown[field] && errors[field] ? fieldId(field, "error") : fieldId(field, "helper"),
    warning ? fieldId(field, "warning") : null,
  ].filter(Boolean).join(" ");

  /** A field's helper, or the error that replaces it (§8.5), then its warning. */
  const foot = (field: BudgetHistoryField, helper: string, warning: string | null) => (
    <>
      {shown[field] && errors[field]
        ? <FieldError id={fieldId(field, "error")}>{errors[field]}</FieldError>
        : <p className="field-helper" id={fieldId(field, "helper")}>{helper}</p>}
      {warning && <FieldWarning id={fieldId(field, "warning")}>{warning}</FieldWarning>}
    </>
  );

  const daysField = (field: "hourly" | "daily", label: string, helper: string) => (
    <div className="field">
      <div className="field-head"><label htmlFor={fieldId(field, "input")}>{label}</label></div>
      <input
        ref={inputRefs[field]}
        id={fieldId(field, "input")}
        className="w-xs"
        type="number"
        inputMode="numeric"
        value={draft[field]}
        readOnly={saving}
        aria-invalid={shown[field] && errors[field] ? true : undefined}
        aria-describedby={describedBy(field, warnings[field])}
        onChange={(event) => change(field, event.target.value)}
        onBlur={() => blur(field)}
      />
      {foot(field, helper, warnings[field])}
    </div>
  );

  return (
    <Modal
      title="Budget and History"
      description="Applies to everyone who uses this Wollipog."
      onClose={close}
      size="md"
      {...(focusBudget ? { initialFocusRef: inputRefs.budget } : {})}
      footer={(
        <>
          {/* On a phone the field errors carry it: the sheet's footer holds two buttons (§7.5). */}
          {!phone && visibleErrors.length > 0 && (
            <p className="budget-history-reason">{fixFieldsSentence(visibleErrors.length)}</p>
          )}
          <button type="button" className="btn" onClick={close} disabled={saving}>Cancel</button>
          <BusyButton ref={saveRef} className="btn primary" type="submit" form={formId} busy={saving} progress="Saving budget and history…">
            Save Changes
          </BusyButton>
        </>
      )}
    >
      <form
        id={formId}
        className="form budget-history-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <section className="budget-history-section" aria-labelledby={`${ids}-budget-heading`}>
          <h3 id={`${ids}-budget-heading`}>Daily Budget</h3>
          <div className="field">
            <div className="field-head"><label htmlFor={fieldId("budget", "input")}>Daily Budget per Person (Optional)</label></div>
            <span className="input-affix w-xs">
              <span className="input-affix-text" aria-hidden="true">$</span>
              <input
                ref={inputRefs.budget}
                id={fieldId("budget", "input")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft.budget}
                readOnly={saving}
                aria-invalid={shown.budget && errors.budget ? true : undefined}
                aria-describedby={describedBy("budget", null)}
                onChange={(event) => change("budget", event.target.value)}
                onBlur={() => blur("budget")}
              />
            </span>
            {foot("budget", BUDGET_HELPER, null)}
          </div>
        </section>
        <section className="budget-history-section" aria-labelledby={`${ids}-history-heading`}>
          <h3 id={`${ids}-history-heading`}>History Kept</h3>
          <p className="budget-history-note">{HISTORY_NOTE}</p>
          <div className="field-row">
            {daysField("hourly", "Hourly Detail", HOURLY_HELPER)}
            {daysField("daily", "Daily Totals", dailyHelper(draft.hourly))}
          </div>
        </section>
        {failure && (
          <Notice tone="danger" role="alert" title="Couldn't Save Changes" details={<code>{failure.detail}</code>}>
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
