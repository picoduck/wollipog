import React, { Fragment, useState, type ReactNode } from "react";
import { buildModelPicker, useModelPickerCatalog, type ModelPickerContext, type ModelPickerOption } from "../model-picker.js";
import { ChevronDownIcon, ChevronRightIcon } from "./Icons.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { handleRovingChoiceKeyDown, useDismissiblePopover } from "./interactions.js";
import type { SelectOption } from "./ui/ChoiceControls.js";

interface ChoiceProps {
  options: readonly SelectOption<string>[];
  value: string | null;
  context: ModelPickerContext;
}

export function ModelPickerList({ options, value, context, renderOption }: ChoiceProps & {
  renderOption: (option: ModelPickerOption) => ReactNode;
}) {
  const catalog = useModelPickerCatalog();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [older, setOlder] = useState<ReadonlySet<string>>(() => new Set());
  const { lead, groups, trailing } = buildModelPicker(options, value, context, catalog);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (option: ModelPickerOption, family = "") => {
    const text = [family, option.label, ...(option.keywords ?? [])].join(" ").toLowerCase();
    return terms.every(term => text.includes(term));
  };
  const before = lead.filter(option => matches(option));
  const after = trailing.filter(option => matches(option));
  const found = groups.map(group => ({ ...group, options: group.options.filter(option => matches(option, group.name)) }))
    .filter(group => group.options.length > 0);
  return <div data-model-picker-list>
    <input className="model-picker-search" type="search" aria-label="Search Models" placeholder="Search models"
      value={query} onChange={event => setQuery(event.currentTarget.value)} />
    {before.map(renderOption)}
    {!before.length && !after.length && !found.length && <p className="ui-select-empty">No matching models.</p>}
    {found.map(group => {
      if (group.options.length === 1) return <Fragment key={group.name}>{renderOption(group.options[0]!)}</Fragment>;
      const selected = group.options.find(option => option.value === value);
      const open = terms.length > 0 || (expanded.get(group.name) ?? Boolean(selected));
      const showOlder = older.has(group.name);
      const count = group.options.filter(option => option.legacy && option.value !== value).length;
      return <div key={group.name}>
        <button type="button" className="menu-item" aria-expanded={open} disabled={terms.length > 0}
          onClick={() => setExpanded(previous => new Map(previous).set(group.name, !open))}>
          <span className="menu-body"><span className="menu-text">{group.name}</span>
            {!open && selected && <span className="menu-desc">{selected.label}</span>}
          </span>
          <span className="menu-trail" aria-hidden="true">
            {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          </span>
        </button>
        {open && <div className="model-picker-family">
          {group.options.filter(option => !option.legacy || showOlder || terms.length || option.value === value).map(renderOption)}
          {count > 0 && !terms.length && <button type="button" className="menu-item" aria-expanded={showOlder}
            onClick={() => setOlder(previous => {
              const next = new Set(previous);
              if (showOlder) next.delete(group.name);
              else next.add(group.name);
              return next;
            })}>
            {showOlder ? "Hide Older Versions" : "Show Older Versions"}{" ("}{count}{")"}
          </button>}
        </div>}
      </div>;
    })}
    {after.map(renderOption)}
  </div>;
}

export function ModelOption({ option, selected, onSelect }: {
  option: ModelPickerOption; selected: boolean; onSelect: () => void;
}) {
  return <MenuItem role="radio" checked={selected} data-model-choice
    description={option.disabledReason ?? option.description}
    aria-disabled={option.disabled || option.retained || undefined}
    onClick={() => { if (!option.disabled && !option.retained) onSelect(); }}>
    {option.label}
  </MenuItem>;
}

export function ModelPicker({ label, value, options, context, onChange, disabled, invalid, describedBy, placeholder }: ChoiceProps & {
  label: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}) {
  const catalog = useModelPickerCatalog();
  const { lead, groups, trailing } = buildModelPicker(options, value, context, catalog);
  const selected = [...lead, ...groups.flatMap(group => group.options), ...trailing].find(option => option.value === value);
  const selectedLabel = selected?.selectedLabel ?? selected?.label ?? placeholder ?? "Select…";
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "model-picker");
  return <div className="ui-select" onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) popover.close(false);
  }}>
    <button type="button" ref={popover.triggerRef} className="ui-select-trigger"
      aria-label={label + ": " + selectedLabel} aria-describedby={describedBy} aria-invalid={invalid || undefined}
      aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? popover.panelId : undefined}
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) popover.toggle(); }}
      onKeyDown={disabled ? undefined : popover.onTriggerKeyDown}>
      <span className="ui-select-value">{selectedLabel}</span><ChevronDownIcon size={14} />
    </button>
    {open && <MenuSurface inline role="dialog" id={popover.panelId} label={label} tabIndex={-1}
      width={320} surfaceRef={popover.panelRef} anchor={{ trigger: popover.triggerRef }}
      onDismiss={() => popover.close(true)} onKeyDown={popover.onPanelKeyDown}>
      <div role="radiogroup" aria-label={label} onKeyDown={event =>
        handleRovingChoiceKeyDown(event, "radio", { activate: false })}>
        <ModelPickerList options={options} value={value} context={context} renderOption={option =>
          <ModelOption key={option.value} option={option} selected={option.value === value} onSelect={() => {
            onChange(option.value);
            popover.close(true);
          }} />} />
      </div>
    </MenuSurface>}
  </div>;
}
