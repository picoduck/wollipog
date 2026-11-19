import { useId, useState } from "react";
import type { AssistantThreadLimits } from "@wollipog/protocol";
import { assistantThreadsUnavailable } from "../assistant-threads.js";
import { parseCount, parseUsd } from "../guardrail-values.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

export function AssistantThreadLimitsDialog({ defaults, limits, onClose, onSave }: {
  defaults?: boolean;
  limits: AssistantThreadLimits;
  onClose: () => void;
  onSave: (limits: AssistantThreadLimits) => Promise<void>;
}) {
  const form = useId();
  const [cost, setCost] = useState(limits.costUsd?.toString() ?? "");
  const [launches, setLaunches] = useState(limits.launchedSessions?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    const budget = parseUsd(cost);
    const count = parseCount(launches, Number.POSITIVE_INFINITY);
    if (!budget.ok) return setError(budget.error);
    if (budget.value !== null && (!Number.isSafeInteger(Math.round(budget.value * 100)) ||
        Number(budget.value.toFixed(2)) !== budget.value)) {
      return setError("Enter a cost budget in whole cents, such as 2.50.");
    }
    if (!count.ok) return setError(count.error);
    setError(null);
    setSaving(true);
    try {
      await onSave({ costUsd: budget.value, launchedSessions: count.value });
      onClose();
    } catch (cause) {
      setError(assistantThreadsUnavailable(cause)
        ? "This version of Wollipog uses fixed Assistant thread limits. Update Wollipog to change them."
        : cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={defaults ? "Default Thread Limits" : "Thread Limits"}
      description={defaults ? "These limits apply to new Assistant threads." : "The budget covers this thread and the work it launches."}
      onClose={saving ? () => {} : onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <BusyButton className="btn primary" type="submit" form={form} busy={saving} progress="Saving limits…">Save Limits</BusyButton>
      </>}
    >
      <form id={form} className="form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field">
          <span>Cost Budget (USD)</span>
          <input value={cost} inputMode="decimal" disabled={saving} placeholder="No Budget" onChange={(event) => setCost(event.target.value)} />
        </label>
        <label className="field">
          <span>Session Launch Limit</span>
          <input value={launches} inputMode="numeric" disabled={saving} placeholder="No Limit" onChange={(event) => setLaunches(event.target.value)} />
        </label>
        <p className="muted">Clear either field to remove its limit. Set the launch limit to 0 to pause new launches.</p>
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
      </form>
    </Modal>
  );
}
