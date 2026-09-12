import { useEffect, useState } from "react";
import type { ChildSessionDefaults, ProjectView } from "@wollipog/protocol";

/** Keyed by Project identity by the caller, so switching Projects discards the old draft. */
export function ProjectChildDefaults({ project, disabled, onSave }: {
  project: ProjectView;
  disabled: boolean;
  onSave: (defaults: ChildSessionDefaults | null) => Promise<unknown>;
}) {
  const [cost, setCost] = useState(project.childSessionDefaults ? String(project.childSessionDefaults.costBudgetUsd) : "");
  const [tools, setTools] = useState(project.childSessionDefaults ? String(project.childSessionDefaults.maxToolCalls) : "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (dirty || saving) return;
    setCost(project.childSessionDefaults ? String(project.childSessionDefaults.costBudgetUsd) : "");
    setTools(project.childSessionDefaults ? String(project.childSessionDefaults.maxToolCalls) : "");
  }, [project.childSessionDefaults?.costBudgetUsd, project.childSessionDefaults?.maxToolCalls, dirty, saving]);
  const submit = async (defaults: ChildSessionDefaults | null) => {
    setSaving(true);
    setError(null);
    try { await onSave(defaults); setDirty(false); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save child session defaults."); }
    finally { setSaving(false); }
  };
  return <section className="project-detail-section" aria-labelledby="child-defaults-heading">
    <h3 id="child-defaults-heading">Child Session Defaults</h3>
    <p>These fallback per-child limits apply when the caller omits them. A bounded parent’s remaining allowance is always the ceiling. Without Project defaults, omitted limits remain unlimited for an unbounded parent.</p>
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
        <input type="number" min="0" step="any" required value={cost} placeholder="No Default" disabled={disabled || saving}
          onChange={(event) => { setCost(event.target.value); setDirty(true); }} />
      </label>
      <label className="field"><span>Child Tool-Call Limit</span>
        <input type="number" min="1" step="1" required value={tools} placeholder="No Default" disabled={disabled || saving}
          onChange={(event) => { setTools(event.target.value); setDirty(true); }} />
      </label>
      <button className="btn" type="submit" disabled={disabled || saving}>{saving ? "Saving…" : "Save Child Defaults"}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="btn" type="button" disabled={disabled || saving || !project.childSessionDefaults}
      onClick={() => void submit(null)}>Remove Child Defaults</button>
  </section>;
}
