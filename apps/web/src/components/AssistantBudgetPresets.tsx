const amounts = [25, 50, 100, 250] as const;
export type AssistantBudgetSelection = typeof amounts[number] | "custom" | "none";

export function assistantBudgetSelection(value: number | null): AssistantBudgetSelection {
  return value === null ? "none" : amounts.find((amount) => amount === value) ?? "custom";
}

export function AssistantBudgetPresets({ value, selection, disabled, onChange }: {
  value: string;
  selection: AssistantBudgetSelection;
  disabled?: boolean;
  onChange: (value: string, selection: AssistantBudgetSelection) => void;
}) {
  return <div className="field">
    <div className="assistant-budget-presets" role="group" aria-label="Budget Presets">
      {amounts.map((amount) => <button key={amount} type="button" className="btn"
        aria-pressed={selection === amount} disabled={disabled}
        onClick={() => onChange(String(amount), amount)}>{`$${amount}`}</button>)}
      <button type="button" className="btn" aria-pressed={selection === "custom"} disabled={disabled}
        onClick={() => onChange(value, "custom")}>Custom…</button>
      <button type="button" className="btn" aria-pressed={selection === "none"} disabled={disabled}
        onClick={() => onChange("", "none")}>No Limit</button>
    </div>
    {selection === "custom" && <label className="field">
      <span>Custom Budget (USD)</span>
      <input value={value} inputMode="decimal" disabled={disabled}
        onChange={(event) => onChange(event.target.value, "custom")} />
    </label>}
  </div>;
}
