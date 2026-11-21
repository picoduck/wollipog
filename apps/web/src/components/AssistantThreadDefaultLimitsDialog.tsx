import { useId, useState } from "react";
import type { AssistantThreadLimits } from "@wollipog/protocol";
import { assistantThreadsUnavailable } from "../assistant-threads.js";
import { parseCount, parseUsd } from "../guardrail-values.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox } from "./ui/ChoiceControls.js";

export function AssistantThreadDefaultLimitsDialog({ limits, onClose, onSave }: {
  limits: AssistantThreadLimits;
  onClose: () => void;
  onSave: (limits: AssistantThreadLimits) => Promise<void>;
}) {
  const form = useId();
  const [cost, setCost] = useState(limits.costUsd?.toString() ?? "");
  const [launches, setLaunches] = useState(limits.launchedSessions?.toString() ?? "");
  const [noCostLimit, setNoCostLimit] = useState(limits.costUsd === null);
  const [noLaunchLimit, setNoLaunchLimit] = useState(limits.launchedSessions === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const persist = async (next: AssistantThreadLimits) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      await onSave(next);
      onClose();
    } catch (cause) {
      setError(assistantThreadsUnavailable(cause)
        ? "This version of Wollipog uses fixed Assistant thread limits. Update Wollipog to change them."
        : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (saving) return;
    if (!noCostLimit && !cost.trim()) return setError("Enter a cost budget or choose No Limit.");
    if (!noLaunchLimit && !launches.trim()) return setError("Enter a session launch limit or choose No Limit.");
    const budget = parseUsd(noCostLimit ? "" : cost);
    const count = parseCount(noLaunchLimit ? "" : launches, Number.POSITIVE_INFINITY);
    if (!budget.ok) return setError(budget.error);
    if (budget.value !== null && budget.value !== limits.costUsd && (!Number.isSafeInteger(Math.round(budget.value * 100)) ||
        Number(budget.value.toFixed(2)) !== budget.value)) {
      return setError("Enter a cost budget in whole cents, such as 2.50.");
    }
    if (!count.ok) return setError(count.error);
    await persist({ costUsd: budget.value, launchedSessions: count.value });
  };

  return (
    <Modal
      title="Default Thread Limits"
      description="These limits apply to new Assistant threads."
      onClose={saving ? () => {} : onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <BusyButton className="btn primary" type="submit" form={form} busy={saving} progress="Saving limits…">Save Limits</BusyButton>
      </>}
    >
      <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="field" role="group" aria-label="Cost Budget">
          <label className="field">
            <span>Cost Budget (USD)</span>
            <input value={noCostLimit ? "" : cost} placeholder={noCostLimit ? "No Limit" : undefined} inputMode="decimal"
              disabled={saving || noCostLimit} onChange={(event) => setCost(event.target.value)} />
          </label>
          <Checkbox label="No Limit" checked={noCostLimit} disabled={saving} onChange={setNoCostLimit} />
        </div>
        <div className="field" role="group" aria-label="Session Launch Limit">
          <label className="field">
            <span>Session Launch Limit</span>
            <input value={noLaunchLimit ? "" : launches} placeholder={noLaunchLimit ? "No Limit" : undefined} inputMode="numeric"
              disabled={saving || noLaunchLimit} onChange={(event) => setLaunches(event.target.value)} />
          </label>
          <Checkbox label="No Limit" checked={noLaunchLimit} disabled={saving} onChange={setNoLaunchLimit} />
        </div>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
      </form>
    </Modal>
  );
}
