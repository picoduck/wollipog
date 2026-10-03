import { useEffect, useRef, type ReactNode } from "react";

/**
 * The one listbox the composer's / and @ pickers open above it (#2155, docs/design-system.md §9.1).
 *
 * The textarea keeps DOM focus and owns the keys; this component draws what they move through and
 * reports pointer choices. Its parts are the `.picker*` block in the composer's CSS (§19.4): a
 * scrolling `.picker-list` of `.picker-group` sections and `.picker-item` options, `.picker-empty`
 * state rows under it, and a `.picker-foot` that stays in view with any note and the keys.
 *
 * Options carry `aria-disabled` rather than `disabled`, so they keep their place and announce their
 * reason, but a pointer cannot choose one and the owner never makes one active.
 */

export interface ComposerListboxSection<T> {
  key: string;
  /** A Title Case group label; a section without one renders its options directly. */
  label?: string;
  items: readonly T[];
}

export interface ComposerListboxOptionProps {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export interface ComposerListboxProps<T> {
  listboxId: string;
  label: string;
  sections: readonly ComposerListboxSection<T>[];
  getKey: (item: T) => string;
  getOptionId: (item: T) => string;
  activeKey: string | null;
  isDisabled?: (item: T) => boolean;
  /** Names and descriptions for an option whose whole text would be too long a name. */
  getOptionProps?: (item: T) => ComposerListboxOptionProps;
  renderItem: (item: T, state: { active: boolean; disabled: boolean }) => ReactNode;
  onActiveChange?: (item: T) => void;
  onSelect: (item: T) => void;
  /** `.picker-empty` rows: no results, loading, errors, a prompt to type. */
  states?: ReactNode;
  /** One sentence pinned in the footer, such as "more matches exist". */
  note?: ReactNode;
  /** What Enter does, named in the footer. */
  enterLabel: string;
}

export function ComposerListbox<T>({
  listboxId,
  label,
  sections,
  getKey,
  getOptionId,
  activeKey,
  isDisabled,
  getOptionProps,
  renderItem,
  onActiveChange,
  onSelect,
  states,
  note,
  enterLabel,
}: ComposerListboxProps<T>) {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const hasOptions = sections.some((section) => section.items.length > 0);

  useEffect(() => {
    if (!activeKey) return;
    optionRefs.current.get(activeKey)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const renderOption = (item: T) => {
    const key = getKey(item);
    const active = key === activeKey;
    const disabled = isDisabled?.(item) ?? false;
    return (
      <button
        key={key}
        ref={(element) => {
          if (element) optionRefs.current.set(key, element);
          else optionRefs.current.delete(key);
        }}
        id={getOptionId(item)}
        className={`picker-item${active ? " is-active" : ""}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={active}
        aria-disabled={disabled || undefined}
        {...getOptionProps?.(item)}
        onMouseMove={() => { if (!disabled && !active) onActiveChange?.(item); }}
        onClick={() => { if (!disabled) onSelect(item); }}
      >
        {renderItem(item, { active, disabled })}
      </button>
    );
  };

  return (
    // Pressing anywhere in the picker must not take focus from the textarea that owns it.
    <div className="picker" onMouseDown={(event) => event.preventDefault()}>
      <div className="picker-list" id={listboxId} role="listbox" aria-label={label}>
        {sections.map((section) => {
          if (!section.items.length) return null;
          if (!section.label) return section.items.map(renderOption);
          const labelId = `${listboxId}-group-${section.key}`;
          return (
            <div className="picker-group" role="group" aria-labelledby={labelId} key={section.key}>
              <div className="picker-group-label" id={labelId}>{section.label}</div>
              {section.items.map(renderOption)}
            </div>
          );
        })}
      </div>
      {states}
      <div className="picker-foot">
        {note && <p className="picker-note">{note}</p>}
        <div className="picker-keys" aria-hidden="true">
          {/* With no options there is nothing to move to or choose; only Escape does anything. */}
          {hasOptions && <>
            <span className="shortcut-hint"><kbd>↑</kbd><kbd>↓</kbd><span className="shortcut-hint-label">Move</span></span>
            <span className="shortcut-hint"><kbd>Enter</kbd><span className="shortcut-hint-label">{enterLabel}</span></span>
            <span className="shortcut-hint"><kbd>Tab</kbd><span className="shortcut-hint-label">Complete</span></span>
          </>}
          <span className="shortcut-hint"><kbd>Esc</kbd><span className="shortcut-hint-label">Close</span></span>
        </div>
      </div>
    </div>
  );
}

/** A row that is not an option: no results, a search in progress, an error, a prompt to type. */
export function ComposerListboxState({
  icon,
  tone,
  role,
  detail,
  children,
}: {
  icon?: ReactNode;
  tone?: "danger";
  role?: "status" | "alert";
  /** A second line in the helper style. */
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`picker-empty${tone ? ` t-${tone}` : ""}`} role={role}>
      {icon}
      <span className="picker-empty-text">
        <span>{children}</span>
        {detail && <span className="picker-empty-detail">{detail}</span>}
      </span>
    </div>
  );
}
