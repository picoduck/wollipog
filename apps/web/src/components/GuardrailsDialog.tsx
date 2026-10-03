import { useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_LIVE_CHILD_LIMIT, type SessionConfig, type SessionView } from "@wollipog/protocol";
import {
  checkpointAboveThreshold,
  formatUsd,
  GUARDRAIL_FIELDS,
  guardrailDraft,
  guardrailFieldError,
  guardrailPatch,
  type GuardrailDraft,
  type GuardrailField,
} from "../guardrail-values.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { CostIcon, CountIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

export type GuardrailsDialogSession = Pick<SessionView,
  | "costBudgetUsd" | "costCheckpointsUsd" | "costCheckpointApprovedUsd" | "costUsd"
  | "maxToolCalls" | "toolCallCount" | "maxChildSessions" | "liveChildCapacity">;

const CHECKPOINT_WARNING = "This checkpoint won't pause separately, because the recurring threshold is lower.";

/**
 * The session's spending, tool-call and live-child limits (#2175): one dialog with labeled fields,
 * their help always visible, and an explicit save (docs/design-system.md §7, §8.1, §8.5, §8.6).
 *
 * These are money limits, so nothing applies while typing: Save Guardrails validates every field,
 * then sends what changed in one configuration request and waits for it. A typo keeps the dialog
 * open with the error in place of the field's helper; a failed request keeps the values and shows
 * a danger notice above the footer. A person refused configuration (#1857) reads the fields and
 * the refusal, and cannot save.
 */
export function GuardrailsDialog({
  session,
  configRefusal,
  onSave,
  onClose,
  returnFocusRef,
}: {
  session: GuardrailsDialogSession;
  /** Why this person may not change the session's configuration, or null when they may. */
  configRefusal: string | null;
  /** Sends the configuration and settles when the server has answered; rejects on failure. */
  onSave: (patch: Partial<SessionConfig>) => Promise<void>;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const idBase = useId();
  const id = (part: string) => `${idBase}-${part}`;
  // The limits as the dialog opened: a change the server reports meanwhile does not move a field
  // the person is reading, and a save compares against what they saw.
  const [opened] = useState(() => session);
  const [openedDraft] = useState<GuardrailDraft>(() => guardrailDraft(session));
  const [draft, setDraft] = useState<GuardrailDraft>(openedDraft);
  const [edited, setEdited] = useState<ReadonlySet<GuardrailField>>(() => new Set());
  const [errors, setErrors] = useState<Partial<Record<GuardrailField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const inputs = useRef<Partial<Record<GuardrailField, HTMLInputElement | null>>>({});
  const readOnly = configRefusal !== null;

  const close = () => {
    if (savingRef.current) return;
    onClose();
  };

  const save = async () => {
    if (savingRef.current || readOnly) return;
    const result = guardrailPatch(opened, draft);
    setEdited(new Set(GUARDRAIL_FIELDS));
    if (!result.ok) {
      setErrors(result.errors);
      // §8.5: focus moves to the first invalid field, which announces its error.
      const first = GUARDRAIL_FIELDS.find((field) => result.errors[field]);
      if (first) inputs.current[first]?.focus();
      return;
    }
    setErrors({});
    if (Object.keys(result.patch).length === 0) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await onSave(result.patch);
      onClose();
    } catch (cause) {
      setFailure((cause as Error).message || "The server did not accept the limits.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const field = (
    name: GuardrailField,
    label: string,
    icon: ReactNode,
    inputMode: "decimal" | "numeric",
    helper: string,
    extra?: { placeholder?: string; warning?: string | null },
  ) => {
    const error = errors[name];
    const inputId = id(name);
    const helperId = id(`${name}-helper`);
    const errorId = id(`${name}-error`);
    const warningId = id(`${name}-warning`);
    const warning = extra?.warning ?? null;
    return (
      <div className="field">
        <div className="field-head"><label htmlFor={inputId}>{label}</label></div>
        <span className="input-affix">
          <span className="input-affix-text" aria-hidden="true">{icon}</span>
          <input
            ref={(element) => { inputs.current[name] = element; }}
            id={inputId}
            type="text"
            inputMode={inputMode}
            autoComplete="off"
            spellCheck={false}
            placeholder={extra?.placeholder}
            value={draft[name]}
            // Read-only rather than disabled, so a Viewer can still select and read the value, and
            // a field submitted with Enter keeps focus while saving.
            readOnly={readOnly || saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={[error ? errorId : helperId, warning ? warningId : null].filter(Boolean).join(" ")}
            onChange={(event) => {
              const next = event.target.value;
              setDraft((current) => ({ ...current, [name]: next }));
              setEdited((current) => new Set(current).add(name));
              // An error showing clears as soon as the value is valid (§8.5).
              if (error) setErrors((current) => ({ ...current, [name]: guardrailFieldError(name, next, openedDraft) ?? undefined }));
            }}
            onBlur={() => {
              if (!edited.has(name) || savingRef.current) return;
              setErrors((current) => ({ ...current, [name]: guardrailFieldError(name, draft[name], openedDraft) ?? undefined }));
            }}
          />
        </span>
        {error ? <FieldError id={errorId}>{error}</FieldError> : <p className="field-helper" id={helperId}>{helper}</p>}
        {warning && <FieldWarning id={warningId}>{warning}</FieldWarning>}
      </div>
    );
  };

  const approved = session.costCheckpointApprovedUsd;
  const capacity = session.liveChildCapacity;
  const refusalId = id("refusal");
  return (
    <Modal
      title="Guardrails"
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          <p className="guardrails-reason" id={refusalId}>
            {configRefusal ?? "Empty cost and tool-call fields mean no limit."}
          </p>
          <button className="btn" type="button" onClick={close} disabled={saving}>Cancel</button>
          <BusyButton
            className="btn primary"
            type="submit"
            form={id("form")}
            busy={saving}
            progress="Saving the guardrails…"
            disabled={readOnly}
            aria-describedby={readOnly ? refusalId : undefined}
          >
            Save Guardrails
          </BusyButton>
        </>
      )}
    >
      <form
        id={id("form")}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {field("costBudgetUsd", "Recurring Cost Threshold", <CostIcon size={14} />, "decimal",
          `Pauses when spend reaches this amount. Continue allows another equal amount. ${formatUsd(session.costUsd ?? 0)} spent so far.`)}
        {field("costCheckpointsUsd", "Cost Checkpoints", <CostIcon size={14} />, "decimal",
          "One-time pauses at these totals, separated by commas." +
            (approved != null ? ` Approved through ${formatUsd(approved)}.` : ""),
          { warning: checkpointAboveThreshold(draft) ? CHECKPOINT_WARNING : null })}
        {field("maxToolCalls", "Tool-Call Threshold", <CountIcon size={14} />, "numeric",
          "Pauses after this many tool calls." +
            (session.maxToolCalls != null && session.toolCallCount != null ? ` ${session.toolCallCount} used.` : ""))}
        {field("maxChildSessions", "Live Child Limit", <CountIcon size={14} />, "numeric",
          "How many child sessions can run at once. Set 0 to pause new children." +
            (capacity ? ` ${capacity.occupied} of ${capacity.limit} in use.` : ""),
          { placeholder: String(DEFAULT_LIVE_CHILD_LIMIT) })}
        {failure && <Notice tone="danger" role="alert" title="Couldn't Save the Guardrails">{failure}</Notice>}
      </form>
    </Modal>
  );
}
