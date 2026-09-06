import { useState } from "react";
import type { ChildSessionDefaults, ProjectView } from "@wollipog/protocol";

/** Keyed by Project identity by the caller, so switching Projects discards the old draft. */
export function ProjectChildDefaults({ project, disabled, onSave }: {
  project: ProjectView;
  disabled: boolean;
  onSave: (defaults: ChildSessionDefaults | null) => Promise<unknown>;
}) {
  const [cost, setCost] = useState(String(project.childSessionDefaults?.costBudgetUsd ?? 5));
  const [tools, setTools] = useState(String(project.childSessionDefaults?.maxToolCalls ?? 100));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (defaults: ChildSessionDefaults | null) => {
    setSaving(true);
    setError(null);
    try { await onSave(defaults); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save child session defaults."); }
    finally { setSaving(false); }
  };
  return <section className="project-detail-section" aria-labelledby="child-defaults-heading">
    <h3 id="child-defaults-heading">Child Session Defaults</h3>
    <p>Agent-created children use these allowances when the parent has no limit. A bounded parent’s remaining allowance takes precedence. These are per-child limits, not a combined budget for the session tree.</p>
    <form className="project-name-form" onSubmit={(event) => {
      event.preventDefault();
      const costBudgetUsd = Number(cost);
      const maxToolCalls = Number(tools);
      if (!Number.isFinite(costBudgetUsd) || costBudgetUsd <= 0 ||
          !Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1) {
        setError("Enter a positive cost limit and a positive whole-number tool-call limit.");
        return;
      }
      void submit({ costBudgetUsd, maxToolCalls });
    }}>
      <label className="field"><span>Child Cost Limit (USD)</span>
        <input type="number" min="0.01" step="any" required value={cost} disabled={disabled || saving}
          onChange={(event) => setCost(event.target.value)} />
      </label>
      <label className="field"><span>Child Tool-Call Limit</span>
        <input type="number" min="1" step="1" required value={tools} disabled={disabled || saving}
          onChange={(event) => setTools(event.target.value)} />
      </label>
      <button className="btn" type="submit" disabled={disabled || saving}>{saving ? "Saving…" : "Save Child Defaults"}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="btn" type="button" disabled={disabled || saving || !project.childSessionDefaults}
      onClick={() => void submit(null)}>Use Installation Defaults</button>
  </section>;
}
