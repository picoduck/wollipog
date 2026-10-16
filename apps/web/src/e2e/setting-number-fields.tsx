import React from "react";
import { NumberRow, SettingsGroup } from "../components/ui/SettingsRows.js";

/*
 * The settings-rows harness's `?view=numbers` (#3185): one editable `NumberRow` per short unit, each
 * with the largest value its field allows, so a browser test can type that value and measure whether
 * the 96px field (§8.3) shows it whole beside its unit. `?view=kinds` keeps its read-only rows for
 * the grid's screenshots; these hold their own state so a typed value stays in the field.
 */

const FIELDS = [
  { title: "Request Timeout", unit: "ms", max: 30_000 },
  { title: "Idle Timeout", unit: "min", max: 10_080 },
  { title: "Poll Interval", unit: "s", max: 86_400 },
  { title: "Retention", unit: "d", max: 3_650 },
  { title: "Sample Rate", unit: "%", max: 100 },
  { title: "Port", unit: undefined, max: 65_535 },
] as const;

function EditableNumberRow({ title, unit, max }: (typeof FIELDS)[number]) {
  const [value, setValue] = React.useState(String(max));
  return <NumberRow title={title} description={`Up to ${max}.`} value={value} unit={unit} min={0} max={max} onChange={setValue} />;
}

export function NumberFields() {
  return (
    <SettingsGroup title="Number Fields" intro="Each field holds the largest value it allows.">
      {FIELDS.map((field) => <EditableNumberRow key={field.title} {...field} />)}
    </SettingsGroup>
  );
}
