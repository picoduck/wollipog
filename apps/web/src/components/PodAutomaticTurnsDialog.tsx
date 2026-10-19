import { useId, useRef, useState } from "react";
import type { PodArbitrationMode, PodOrchestrationPolicy, PodView, SessionView, UpdatePodOrchestrationRequest } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { podMemberChoiceLabel } from "../pod-presentation.js";
import { useStoreActions } from "../store.js";
import { FieldError } from "./FieldError.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select, type ChoiceRowOption, type SelectOption } from "./ui/ChoiceControls.js";

/** The policy a pod without one reports: the control plane's defaults. */
export const DEFAULT_POD_ORCHESTRATION_POLICY: PodOrchestrationPolicy = {
  mode: "manual",
  contextTokenBudget: 4_096,
  summaryTokenBudget: 512,
  maxTurns: 12,
  maxRepeatedOutputs: 2,
};

const MODE_OPTIONS: readonly ChoiceRowOption<PodArbitrationMode>[] = [
  { value: "manual", title: "Manual Only", description: "You relay every step." },
  { value: "round_robin", title: "Round Robin", description: "Members take turns in order." },
  { value: "lead_driven", title: "Lead Decides", description: "The lead picks who goes next." },
  { value: "event_triggered", title: "When a Member Finishes", description: "The next turn starts when a member settles." },
];

/** The context budgets the control plane accepts, as the member settings offer them. */
const CONTEXT_BUDGETS = [4_096, 8_192, 16_384, 32_768] as const;
const CONTEXT_OPTIONS: readonly SelectOption<string>[] = CONTEXT_BUDGETS.map((budget) => ({
  value: String(budget),
  label: `${budget.toLocaleString("en-US")} tokens`,
}));

export const MANUAL_ONLY_HELP = "Nothing to start: you relay each step from the huddle.";
const LEAD_REQUIRED = "Make exactly one member the lead to use this.";
const NO_STARTING_MEMBER = "Add a member who isn't the lead to start from.";

type NumberField = "maxTurns" | "maxRepeatedOutputs" | "summaryTokenBudget";

interface Draft {
  mode: PodArbitrationMode;
  contextTokenBudget: number;
  maxTurns: string;
  maxRepeatedOutputs: string;
  summaryTokenBudget: string;
  firstSessionId: string;
  instruction: string;
}

function wholeNumber(text: string): number | null {
  return /^\d+$/u.test(text.trim()) ? Number(text.trim()) : null;
}

/** The field's error for `draft`, in one sentence, or null (§8.5). The bounds are the control plane's. */
function numberError(field: NumberField, draft: Draft): string | null {
  const value = wholeNumber(draft[field]);
  const [min, max] = field === "maxTurns" ? [1, 100]
    : field === "maxRepeatedOutputs" ? [2, 5]
      : [128, Math.min(4_096, Math.floor(draft.contextTokenBudget / 2))];
  return value === null || value < min || value > max ? `Enter a whole number from ${min} to ${max.toLocaleString("en-US")}.` : null;
}

/** Who can take the first turn: anyone in Round Robin, anyone but the lead When a Member Finishes. */
function startingMembers(pod: PodView, mode: PodArbitrationMode) {
  return mode === "event_triggered" ? pod.members.filter((member) => member.role !== "lead") : pod.members;
}

/**
 * Automatic Turns… (#2980): how turns pass between members, their limits and the instruction for
 * the next turn, opened from the pod's ⋯. The dialog owns its draft, so reopening it shows the saved
 * policy. Save sends the same `UpdatePodOrchestrationRequest` the page's old panel sent; Save and
 * Start also starts turns.
 */
export function PodAutomaticTurnsDialog({ pod, sessions, onClose }: {
  pod: PodView;
  sessions: ReadonlyMap<string, SessionView>;
  onClose: () => void;
}) {
  const api = useApi();
  const { loadPodContext } = useStoreActions();
  const ids = useId();
  const saved = pod.orchestration?.policy ?? DEFAULT_POD_ORCHESTRATION_POLICY;
  const [draft, setDraft] = useState<Draft>(() => ({
    mode: saved.mode,
    contextTokenBudget: saved.contextTokenBudget,
    maxTurns: String(saved.maxTurns),
    maxRepeatedOutputs: String(saved.maxRepeatedOutputs),
    summaryTokenBudget: String(saved.summaryTokenBudget),
    firstSessionId: startingMembers(pod, saved.mode)[0]?.sessionId ?? "",
    instruction: "",
  }));
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({});
  const [edited, setEdited] = useState<Partial<Record<NumberField, boolean>>>({});
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  const [failure, setFailure] = useState<{ sentence: string; detail: string } | null>(null);
  const fieldRefs = useRef<Partial<Record<NumberField, HTMLInputElement | null>>>({});

  const automatic = draft.mode !== "manual";
  const choosesStart = draft.mode === "round_robin" || draft.mode === "event_triggered";
  const candidates = startingMembers(pod, draft.mode);
  const startingId = candidates.some((member) => member.sessionId === draft.firstSessionId)
    ? draft.firstSessionId
    : candidates[0]?.sessionId ?? "";
  const needsLead = draft.mode === "lead_driven" || draft.mode === "event_triggered";
  const leadCount = pod.members.filter((member) => member.role === "lead").length;
  const blockedReason = needsLead && leadCount !== 1 ? LEAD_REQUIRED
    : draft.mode === "event_triggered" && !startingId ? NO_STARTING_MEMBER
      : null;

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    // An error clears as soon as the value is valid (§8.5).
    setErrors((shown) => Object.fromEntries(Object.entries(shown).filter(([field]) => numberError(field as NumberField, next))));
  };

  const request = (): UpdatePodOrchestrationRequest => ({
    mode: draft.mode,
    contextTokenBudget: draft.contextTokenBudget,
    summaryTokenBudget: wholeNumber(draft.summaryTokenBudget)!,
    maxTurns: wholeNumber(draft.maxTurns)!,
    maxRepeatedOutputs: wholeNumber(draft.maxRepeatedOutputs)!,
  });

  const submit = async (start: boolean) => {
    if (busy || blockedReason) return;
    const fields: NumberField[] = ["maxTurns", "maxRepeatedOutputs", "summaryTokenBudget"];
    const found = Object.fromEntries(fields.flatMap((field) => {
      const message = numberError(field, draft);
      return message ? [[field, message]] : [];
    })) as Partial<Record<NumberField, string>>;
    setErrors(found);
    const first = fields.find((field) => found[field]);
    if (first) {
      fieldRefs.current[first]?.focus();
      return;
    }
    const policy = request();
    const current = pod.orchestration?.policy ?? DEFAULT_POD_ORCHESTRATION_POLICY;
    const changed = (Object.keys(policy) as (keyof UpdatePodOrchestrationRequest)[])
      .some((key) => policy[key] !== current[key]);
    setBusy(start ? "start" : "save");
    setFailure(null);
    let step: "save" | "start" = "save";
    try {
      if (changed) await api.updatePodOrchestration(pod.id, policy);
      if (start) {
        step = "start";
        const instruction = draft.instruction.trim();
        const result = await api.startPodOrchestration(pod.id, {
          ...(instruction ? { instruction } : {}),
          ...(choosesStart && startingId ? { firstSessionId: startingId } : {}),
        });
        if (result.appendedEntry) loadPodContext(pod.id, [result.appendedEntry]);
      }
      onClose();
    } catch (cause) {
      setFailure({
        sentence: step === "start"
          ? changed ? "Your changes were saved, but automatic turns didn't start." : "Automatic turns didn't start."
          : "Your changes weren't saved.",
        detail: (cause as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  const numberField = (field: NumberField, label: string, helper: string, bounds: { min: number; max: number; step?: number }) => {
    const helperId = `${ids}-${field}-helper`;
    const errorId = `${ids}-${field}-error`;
    const error = errors[field];
    return (
      <div className="field">
        <div className="field-head"><label htmlFor={`${ids}-${field}`}>{label}</label></div>
        <input
          ref={(element) => { fieldRefs.current[field] = element; }}
          id={`${ids}-${field}`}
          className="w-xs"
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step ?? 1}
          value={draft[field]}
          readOnly={Boolean(busy)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : helperId}
          onChange={(event) => {
            setEdited((current) => ({ ...current, [field]: true }));
            update({ [field]: event.target.value });
          }}
          onBlur={() => {
            if (!edited[field]) return;
            const message = numberError(field, draft);
            setErrors((current) => {
              const { [field]: _cleared, ...rest } = current;
              return message ? { ...rest, [field]: message } : rest;
            });
          }}
        />
        {error ? <FieldError id={errorId}>{error}</FieldError> : <p className="field-helper" id={helperId}>{helper}</p>}
      </div>
    );
  };

  const reasonId = `${ids}-reason`;
  const modeLabelId = `${ids}-mode`;
  const startLabelId = `${ids}-start`;
  const startLabel = draft.mode === "event_triggered" ? "Starting Member" : "First Member";
  const disabled = Boolean(blockedReason);
  return (
    <Modal
      title="Automatic Turns"
      description="Let members take turns without you relaying each step."
      onClose={onClose}
      footer={(
        <>
          {blockedReason && <span className="pod-turns-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {automatic ? (
            <>
              <BusyButton className="btn" busy={busy === "save"} progress="Saving automatic turns…"
                disabled={disabled || busy === "start"} aria-describedby={blockedReason ? reasonId : undefined}
                onClick={() => void submit(false)}>
                Save
              </BusyButton>
              <BusyButton className="btn primary" busy={busy === "start"} progress="Starting automatic turns…"
                disabled={disabled || busy === "save"} aria-describedby={blockedReason ? reasonId : undefined}
                onClick={() => void submit(true)}>
                Save and Start
              </BusyButton>
            </>
          ) : (
            <BusyButton className="btn primary" busy={busy === "save"} progress="Saving automatic turns…"
              onClick={() => void submit(false)}>
              Save
            </BusyButton>
          )}
        </>
      )}
    >
      <form
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit(automatic);
        }}
      >
        <div className="field">
          <span id={modeLabelId}>How Turns Pass</span>
          <ChoiceRows<PodArbitrationMode>
            label="How Turns Pass"
            labelledBy={modeLabelId}
            describedBy={draft.mode === "manual" ? `${modeLabelId}-help` : undefined}
            value={draft.mode}
            options={MODE_OPTIONS}
            onChange={(mode) => update({ mode })}
          />
          {draft.mode === "manual" && <p className="field-helper" id={`${modeLabelId}-help`}>{MANUAL_ONLY_HELP}</p>}
        </div>

        {choosesStart && candidates.length > 0 && (
          <div className="field">
            <span id={startLabelId}>{startLabel}</span>
            <Select<string>
              label={startLabel}
              value={startingId || null}
              options={candidates.map((member) => ({
                value: member.sessionId,
                label: podMemberChoiceLabel(member, sessions.get(member.sessionId)),
              }))}
              onChange={(firstSessionId) => update({ firstSessionId })}
            />
          </div>
        )}

        <div className="field-row">
          {numberField("maxTurns", "Turn Limit", "Turns", { min: 1, max: 100 })}
          {numberField("maxRepeatedOutputs", "Stop After Repeated Answers", "Identical answers in a row", { min: 2, max: 5 })}
        </div>
        <div className="field-row">
          <div className="field">
            <span>Context per Member</span>
            <Select<string>
              label="Context per Member"
              value={String(draft.contextTokenBudget)}
              options={CONTEXT_OPTIONS}
              onChange={(value) => update({ contextTokenBudget: Number(value) })}
            />
          </div>
          {numberField("summaryTokenBudget", "Summary Length", "In tokens", {
            min: 128, max: Math.min(4_096, Math.floor(draft.contextTokenBudget / 2)), step: 128,
          })}
        </div>

        {automatic && (
          <div className="field">
            <div className="field-head"><label htmlFor={`${ids}-instruction`}>Instruction for the Next Turn (Optional)</label></div>
            <textarea
              id={`${ids}-instruction`}
              rows={3}
              value={draft.instruction}
              readOnly={Boolean(busy)}
              aria-describedby={`${ids}-instruction-helper`}
              onChange={(event) => update({ instruction: event.target.value })}
            />
            <p className="field-helper" id={`${ids}-instruction-helper`}>Added to the huddle log when turns start.</p>
          </div>
        )}

        {failure && (
          <Notice tone="danger" role="alert" details={<code>{failure.detail}</code>}>
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
