import { SegmentedControl } from "./ui/ChoiceControls.js";

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
    <SegmentedControl appearance="chips" label="Budget Presets" value={String(selection)}
      options={[
        ...amounts.map((amount) => ({ value: String(amount), label: `$${amount}`, disabled })),
        { value: "custom", label: "Custom…", disabled },
        { value: "none", label: "No Limit", disabled },
      ]}
      onChange={(next) => {
        if (next === "custom") onChange(value, next);
        else if (next === "none") onChange("", next);
        else onChange(next, assistantBudgetSelection(Number(next)));
      }} />
    {selection === "custom" && <label className="field">
      <span>Custom Budget (USD)</span>
      <input value={value} inputMode="decimal" disabled={disabled}
        onChange={(event) => onChange(event.target.value, "custom")} />
    </label>}
  </div>;
}
