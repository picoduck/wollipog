import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { CheckIcon, ChevronDownIcon } from "../Icons.js";
import {
  handleRovingChoiceKeyDown,
  rovingChoiceStop,
  useAnchoredMenuStyle,
  useDismissiblePopover,
} from "../interactions.js";
import { MOBILE_BREAKPOINT_PX } from "../useIsMobile.js";

/**
 * An always-open listbox owned by another control, such as an autocomplete textbox.
 *
 * The owner keeps DOM focus and drives the active index; this primitive only centralizes the
 * listbox/option semantics so data pickers do not grow their own incompatible choice markup.
 */
export function InlineListbox<T>({
  id,
  label,
  options,
  activeIndex,
  getKey,
  renderOption,
  onSelect,
  onActiveChange,
  isOptionDisabled,
  className,
  before,
  after,
  style,
}: {
  id: string;
  label: string;
  options: readonly T[];
  activeIndex: number;
  getKey: (option: T) => string;
  renderOption: (option: T) => ReactNode;
  onSelect: (option: T) => void;
  onActiveChange?: (index: number) => void;
  isOptionDisabled?: (option: T) => boolean;
  className?: string;
  before?: ReactNode;
  after?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={className} role="listbox" id={id} aria-label={label} style={style}>
      {before}
      {options.map((option, index) => {
        const optionDisabled = isOptionDisabled?.(option) ?? false;
        return (
          <button
            type="button"
            role="option"
            id={`${id}-${index}`}
            aria-selected={index === activeIndex}
            aria-disabled={optionDisabled || undefined}
            tabIndex={-1}
            className={`ui-inline-listbox-option${index === activeIndex ? " is-active" : ""}`
              + `${optionDisabled ? " is-disabled" : ""}`}
            key={getKey(option)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onActiveChange?.(index)}
            onClick={() => { if (!optionDisabled) onSelect(option); }}
          >
            {renderOption(option)}
          </button>
        );
      })}
      {after}
    </div>
  );
}

/** A labelled binary choice with the platform checkbox interaction contract. */
export function Checkbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

/**
 * Picking one of N, as three primitives instead of seventeen.
 *
 * §11.1 counted seventeen ways this app asks the same question, and the problem is not that any one
 * of them is wrong — it is that a user learns "accent border means selected" in the New Session
 * dialog and then meets solid accent fill, an underline, a box-shadow, a primary gradient, and
 * accent-coloured text elsewhere. The New Session dialog alone uses three of them inside 520px.
 *
 * Phase 2 was re-scoped to deliver six primitives and shipped three; these are the missing three,
 * and phase 6's screen-by-screen adoption is blocked until they exist.
 *
 * The choice of THREE is about shape, not taste — each answers a different question:
 *
 *   SegmentedControl  2-4 short, mutually exclusive options, always visible. A filter, a mode.
 *   ChoiceCard        options that need a description or an icon to choose between. A preset.
 *   Select            data-backed options that fit ordinary listbox navigation. A machine.
 *   SearchableCombobox data-backed options users need to narrow by typing. A project, an agent.
 *
 * All three share one selected treatment — accent border plus a tint — because that is the one the
 * app already used most, so adoption changes the fewest screens.
 */

/* ------------------------------------------------------------------------------------------------
 * SegmentedControl
 * ---------------------------------------------------------------------------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Explicit control name when the visible label changes responsively or includes decoration. */
  ariaLabel?: string;
  /** Shown on hover and to assistive technology when the label is an icon or an abbreviation. */
  title?: string;
  /**
   * The sentence this option owns, announced WITH the option rather than beside the group.
   *
   * A pill is too small to render one, so the caller shows the selected option's sentence in its
   * own layout — but a sibling paragraph is not attached to anything: focus reached "System,
   * selected, radio" and arrowing to Light changed a sentence no control pointed at. Referenced
   * from the radio, it travels with the option again.
   */
  description?: string;
  disabled?: boolean;
  /** Why it is disabled. Rendered, never hidden — §11.3: never hide a setting that could exist. */
  disabledReason?: string;
}

/**
 * A row of mutually exclusive options, all visible.
 *
 * `role="radiogroup"` with `role="radio"` children, NOT `aria-pressed` buttons. Four of the
 * seventeen patterns used `aria-pressed`, which announces "toggle button, pressed" — it says
 * nothing about the other options being alternatives, so a screen-reader user cannot tell a
 * segmented control from a row of independent toggles. Usage → range was doing exactly that.
 *
 * Keyboard is the roving pattern the rest of the app already uses: one tab stop for the group,
 * arrows move and select within it.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The group's accessible name. Required: an unlabelled radiogroup announces only its options. */
  label: string;
  className?: string;
}) {
  // One stop for the whole group, computed by `rovingChoiceStop`. The rule was inline here across
  // three rounds and each round fixed one branch of it: nothing selected, then selected but
  // disabled, then — because `option.disabled` was tested first — every option disabled, which took
  // the stop off all of them and left the group unreachable while the comment claimed otherwise.
  const stopAt = rovingChoiceStop(options.map((option) => ({
    selected: option.value === value,
    disabled: option.disabled,
  })));
  // When the WHOLE group is unavailable the reason belongs to the group, not to five identical
  // tooltips. Rendered and associated, because a `title` cannot be reached by touch and is
  // announced inconsistently — which made this primitive's "rendered, never hidden" claim false.
  // One group-level sentence only when there IS one sentence. Collapsing to the first reason left
  // "Requires admin" on screen while the option explained by "Unavailable offline" had nothing but
  // a `title` — the state this mechanism exists to prevent. Where the reasons differ, each option
  // keeps its own, rendered beside it.
  const reasons = options.filter((option) => option.disabled).map((option) => option.disabledReason);
  const allDisabled = options.length > 0 && options.every((option) => option.disabled);
  const groupReason = allDisabled && reasons.every((reason) => reason === reasons[0]) ? reasons[0] : undefined;
  const perOptionReasons = allDisabled && !groupReason;
  // `useId`, not the label: two mounted groups both labelled "Status" produced the same id, so both
  // `aria-describedby`s resolved to the first one and the second group announced the wrong reason.
  const ids = useId();
  const reasonId = `${ids}-unavailable`;
  // Off-screen rather than inside the button: content inside a radio joins its ACCESSIBLE NAME, so
  // the option would announce as "Light Always use the light palette" and the name would no longer
  // match the visible label. Rendered, not `aria-hidden`, because a described element that is hidden
  // from the tree is unreliable as an `aria-describedby` target across screen readers.
  const descriptionId = (index: number) => `${ids}-desc-${index}`;
  const describes = options.some((option) => option.description);
  return (
    <>
      <div
        className={`ui-seg${className ? ` ${className}` : ""}`}
        role="radiogroup"
        aria-label={label}
        aria-describedby={groupReason ? reasonId : undefined}
        // See the note beside ChoiceCards' handler: disabled options stay in the arrow order so
        // their reason is reachable without a mouse.
        onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio", { includeAriaDisabled: true })}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.ariaLabel}
              aria-disabled={option.disabled || undefined}
              aria-describedby={option.description ? descriptionId(index) : undefined}
              // `disabled` would remove it from the roving order, so a disabled option becomes
              // invisible to keyboard users rather than explained to them.
              tabIndex={index === stopAt ? 0 : -1}
              className={`ui-seg-option${selected ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
              title={option.disabled ? option.disabledReason ?? option.title : option.title}
              onClick={() => { if (!option.disabled) onChange(option.value); }}
            >
              {option.label}
              {perOptionReasons && option.disabledReason && (
                <small className="ui-seg-option-reason">{option.disabledReason}</small>
              )}
            </button>
          );
        })}
      </div>
      {describes && (
        <span className="sr-only">
          {options.map((option, index) => (
            option.description
              ? <span key={option.value} id={descriptionId(index)}>{option.description}</span>
              : null
          ))}
        </span>
      )}
      {groupReason && <small id={reasonId} className="ui-seg-reason">{groupReason}</small>}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * ChoiceCard
 * ---------------------------------------------------------------------------------------------- */

export interface ChoiceCardOption<T extends string> {
  value: T;
  title: string;
  /**
   * Short status shown BESIDE the title — a kind, a state, an availability.
   *
   * §11.1 names "options that need descriptions or status" as this primitive's remit, and the
   * Location pickers are the status half: a machine name alone does not say whether it is local or
   * SSH, or whether it can host a session right now. It sits on the title row rather than in
   * `description`, because a badge that wraps under a path reads as part of the path.
   *
   * It joins the option's accessible name, which is intended: "runner-1, Local, Available" is what
   * a screen-reader user needs to choose between two machines. Callers must therefore pass text, or
   * mark decorative parts `aria-hidden` themselves.
   */
  status?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Options that need room to explain themselves.
 *
 * Single and multiple selection are the same component because they looked identical in six
 * different places and differed only in role — `.loc-pick` and `.workflow-preset` were single,
 * `.agent-pick` and `.advanced-agent-pick` were checkbox-backed multiples, and a user could not
 * tell which was which until they clicked a second card and the first one either stayed on or
 * turned off. The role now says it, and so does the marker: a dot for one-of, a tick for many-of.
 */
/*
 * Arrows reach a DISABLED option; only activating it is refused.
 *
 * `handleRovingChoiceKeyDown` filters `aria-disabled` out of the roving set by default, and neither
 * primitive opted out — so an option the comments above promise is "rendered, never hidden" was
 * reachable by mouse and by nothing else. `rovingChoiceStop` never puts the tab stop on a disabled
 * option either, which left the arrows as the only way in, and they skipped it.
 *
 * Including them is safe because the activation guard lives on the option: the handler clicks
 * whatever it focuses, and each `onClick` below returns early when `option.disabled`. So focus
 * moves, the screen reader announces the option and its reason, and nothing is selected — which is
 * what the ARIA practices recommend for a radio that must explain why it is unavailable.
 */
export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  label,
  multiple,
  className,
}: {
  options: readonly ChoiceCardOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
} & ({ multiple: true; value: readonly NoInfer<T>[] } | { multiple?: false; value: NoInfer<T> | null })) {
  // The mode decides the shape, so the types cannot disagree with it: a single mode given an array
  // silently selected nothing, and a multiple mode given a scalar selected one card and then could
  // never deselect it. Both were expressible and neither was meaningful.
  // `null` is a real single-choice state — an approval question starts unanswered — and the type
  // rejecting it forced an adopter into a cast or a fake selection. Normalised to an empty set, so
  // the roving fallback's "nothing selected" branch handles it.
  const selectedValues = multiple ? value : value === null ? [] : [value as T];
  const isSelected = (option: ChoiceCardOption<T>) => selectedValues.includes(option.value);
  // Single-select cards rove exactly as the segmented control does, so they share the rule rather
  // than restating it — the restatement had the same all-disabled hole, in the same shape.
  // Multi-select does not rove: every checkbox is its own stop.
  const stopAt = rovingChoiceStop(options.map((option) => ({
    selected: isSelected(option),
    disabled: option.disabled,
  })));
  return (
    <div
      className={`ui-choice-cards${className ? ` ${className}` : ""}`}
      role={multiple ? "group" : "radiogroup"}
      aria-label={label}
      onKeyDown={multiple ? undefined : (event) => handleRovingChoiceKeyDown(event, "radio", { includeAriaDisabled: true })}
    >
      {options.map((option, index) => {
        const selected = isSelected(option);
        return (
          <button
            key={option.value}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={selected}
            aria-disabled={option.disabled || undefined}
            tabIndex={multiple || index === stopAt ? 0 : -1}
            className={`ui-choice-card${selected ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
            onClick={() => { if (!option.disabled) onChange(option.value); }}
          >
            {option.icon && <span className="ui-choice-card-icon" aria-hidden="true">{option.icon}</span>}
            <span className="ui-choice-card-body">
              <span className="ui-choice-card-title">
                {option.title}
                {option.status && <span className="ui-choice-card-status">{option.status}</span>}
              </span>
              {option.description && <span className="ui-choice-card-desc">{option.description}</span>}
              {option.disabled && option.disabledReason && (
                <small className="ui-choice-card-reason">{option.disabledReason}</small>
              )}
            </span>
            <span className={`ui-choice-mark${multiple ? " is-multi" : ""}`} aria-hidden="true">
              {selected && multiple ? <CheckIcon size={13} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * SearchableCombobox
 * ---------------------------------------------------------------------------------------------- */

export interface SearchableComboboxOption<T extends string> {
  value: T;
  label: string;
  /** Visible context that distinguishes duplicate or similarly named choices. */
  description?: string;
  /** Additional already-authorized terms that are useful to search but need not be repeated. */
  keywords?: readonly string[];
  disabled?: boolean;
  /** Rendered with the option so an unavailable result explains itself when arrows reach it. */
  disabledReason?: string;
}

/**
 * Filter without inventing metadata: every searchable term is supplied by the caller, which owns
 * the authorization boundary for Project paths, runner details and other potentially private
 * context. Terms are ANDed so "dashboard remote" can distinguish duplicate names.
 */
export function filterSearchableComboboxOptions<T extends string>(
  options: readonly SearchableComboboxOption<T>[],
  query: string,
): SearchableComboboxOption<T>[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = [
      option.label,
      option.description,
      option.disabled ? option.disabledReason : undefined,
      ...(option.keywords ?? []),
    ].filter((part): part is string => Boolean(part)).join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * An editable list autocomplete built on InlineListbox.
 *
 * DOM focus stays on the input while `aria-activedescendant` moves through the popup. Unavailable
 * options stay in that arrow order so their rendered reason can be inspected, but activation is
 * refused in both this owner and InlineListbox. Enter belongs to selection only while the popup is
 * open; once closed it is deliberately untouched so an enclosing form can own default submission.
 */
export function SearchableCombobox<T extends string>({
  options,
  value,
  onChange,
  label,
  describedBy,
  placeholder = "Search…",
  emptyLabel = "No Matches",
  disabled = false,
  className,
}: {
  options: readonly SearchableComboboxOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  describedBy?: string;
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const coarsePointer = useCoarsePointer();
  const selected = options.find((option) => option.value === value) ?? null;
  const results = useMemo(
    () => filterSearchableComboboxOptions(options, searching ? query : ""),
    [options, query, searching],
  );
  // Options may change while open (agent setup and runner availability are live), and filtering can
  // shrink the list under the previous index. Derive the safe index rather than repairing state in
  // an effect and rendering one frame with an aria-activedescendant that names nothing.
  const activeIndex = results.length === 0 ? 0 : Math.min(active, results.length - 1);
  const inputValue = searching ? query : selected?.label ?? "";
  const desiredHeight = selectMenuDesiredHeight({
    optionCount: results.length,
    maxOptionLines: results.reduce((most, option) => Math.max(most, 1
      + (option.description ? 1 : 0)
      + (option.disabled && option.disabledReason ? 1 : 0)), 1),
    coarsePointer,
  });
  const listStyle = useAnchoredMenuStyle(open, inputRef, {
    desiredHeight,
    matchTriggerWidth: true,
  });

  const close = () => {
    setOpen(false);
    setSearching(false);
  };
  const openAll = () => {
    const selectedIndex = options.findIndex((option) => option.value === value);
    setSearching(false);
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const commit = (option: SearchableComboboxOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const leaveWindow = () => close();
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    window.addEventListener("blur", leaveWindow);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
      window.removeEventListener("blur", leaveWindow);
    };
  }, [open]);

  const moveActive = (delta: number) => {
    if (results.length === 0) return;
    setActive((activeIndex + delta + results.length) % results.length);
  };
  const activeOption = results[activeIndex];
  const firstEnabledIndex = Math.max(0, results.findIndex((option) => !option.disabled));
  const lastEnabledIndex = results.reduce(
    (last, option, index) => option.disabled ? last : index,
    0,
  );

  return (
    <div
      className={`ui-searchable-combobox${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeOption ? `${listboxId}-${activeIndex}` : undefined}
        aria-disabled={disabled || undefined}
        readOnly={disabled}
        autoComplete="off"
        className="ui-searchable-combobox-input"
        placeholder={placeholder}
        value={inputValue}
        onFocus={(event) => {
          if (disabled) return;
          if (!open) openAll();
          event.currentTarget.select();
        }}
        onClick={() => { if (!disabled && !open) openAll(); }}
        onChange={(event) => {
          if (disabled) return;
          setQuery(event.target.value);
          setSearching(true);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Tab") {
            if (open) close();
            return;
          }
          const plainKey = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
          if (!plainKey) return;
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openAll();
              return;
            }
            moveActive(event.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (open && (event.key === "Home" || event.key === "End")) {
            event.preventDefault();
            // Up/Down deliberately reach unavailable results so their reason can be inspected;
            // Home/End retain Select's boundary shortcut to the first/last commit-capable result.
            setActive(event.key === "Home" ? firstEnabledIndex : lastEnabledIndex);
            return;
          }
          if (event.key === "Enter" && open) {
            event.preventDefault();
            if (activeOption) commit(activeOption);
          }
        }}
      />
      {open && (
        <InlineListbox
          id={listboxId}
          label={`${label} Options`}
          options={results}
          activeIndex={activeIndex}
          getKey={(option) => option.value}
          onActiveChange={setActive}
          isOptionDisabled={(option) => Boolean(option.disabled)}
          onSelect={commit}
          className="ui-searchable-combobox-list ui-select-list"
          style={listStyle}
          before={results.length === 0
            ? <p className="ui-select-empty">{emptyLabel}</p>
            : undefined}
          renderOption={(option) => (
            <span className="ui-select-option-body">
              <span>{option.label}</span>
              {option.description && <small className="ui-select-option-desc">{option.description}</small>}
              {option.disabled && option.disabledReason && (
                <small className="ui-select-option-reason">{option.disabledReason}</small>
              )}
            </span>
          )}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Select
 * ---------------------------------------------------------------------------------------------- */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /**
   * A decoration shown before the label, in the trigger as well as in the list.
   *
   * Hiding it from assistive technology is the CALLER's job and every caller owes it: the label
   * already carries the name, so a swatch that announces itself makes the option read twice. A slot
   * rather than an icon prop because the colour-scheme picker needs three dots per option, which no
   * icon component is.
   */
  swatch?: ReactNode;
  disabled?: boolean;
  /** Rendered in the option, not a tooltip — §11.3: never hide a setting that could exist. */
  disabledReason?: string;
}

/**
 * WHICH Selects have a preview live, oldest first — because more than one can, and only the newest
 * is the one on screen.
 *
 * Module-scoped because the channel is: a preview is one palette on one document, so every mounted
 * Select writes to a single place whether or not they agree about what belongs in it. Each instance
 * clearing that place unconditionally was the first half of the defect — with two pickers open, the
 * second one closing published its `null` over the first one's live preview, and the first never
 * republished because its own highlight had not moved.
 *
 * A single owner slot fixed that half and left the other, which is the same wrong screen reached
 * from the other side: when the CURRENT owner leaves, an older picker that is still open and still
 * highlighting something has already been forgotten, so the document falls back to the committed
 * palette while an open list says otherwise. What keeps that rare today is the focus dismisser —
 * opening a list focuses its panel, and every other open list treats that as a dismissal — but that
 * rule lives hundreds of lines from here and answers to its own requirements, and this channel
 * should not be one hover-preview away from a palette nobody chose. A stack answers both halves:
 * the newest publisher is what the document shows, and losing it uncovers the one underneath
 * rather than nothing.
 *
 * Each entry keeps the callback that MADE its publication rather than the picker's current prop. A
 * picker whose `onPreview` is taken away still has a preview on screen, and the only function that
 * can take it back is the one that put it there.
 */
interface LivePreview {
  /** The publishing instance, by the per-mount identity `instanceRef` below hands out. */
  readonly instance: object;
  /** What that picker is browsing, so an uncovered entry can be reasserted without asking it. */
  readonly value: string;
  /** The callback of record — see above. */
  readonly notify: (value: string | null) => void;
}
const livePreviews: LivePreview[] = [];

/** Take the top of the stack, replacing this instance's earlier entry rather than stacking on it. */
function publishPreview(instance: object, value: string, notify: (value: string | null) => void): void {
  const existing = livePreviews.findIndex((entry) => entry.instance === instance);
  if (existing >= 0) livePreviews.splice(existing, 1);
  livePreviews.push({ instance, value, notify });
  notify(value);
}

/**
 * Leave the stack, by whichever route ended the browse — a close, a commit, an unmount.
 *
 * Leaving from UNDER the top changes nothing on screen, so it publishes nothing: that picker's
 * preview was already covered, and announcing its withdrawal would blank a palette belonging to a
 * list that is still open. Leaving the top uncovers whoever is beneath and reasserts THEIR value,
 * because that picker never stopped browsing it. Only an empty stack means nobody is previewing,
 * and that is the one case that owes anyone a `null`.
 */
function withdrawPreview(instance: object): void {
  const index = livePreviews.findIndex((entry) => entry.instance === instance);
  if (index < 0) return;
  const [gone] = livePreviews.splice(index, 1);
  if (index !== livePreviews.length) return;
  const uncovered = livePreviews.at(-1);
  if (uncovered) uncovered.notify(uncovered.value);
  else gone?.notify(null);
}

/**
 * A live preview outlives a render, so a test that leaves one poisons the next: the abandoned entry
 * is still on the stack, and the next picker's dismissal uncovers a callback belonging to a tree
 * that no longer exists. Exported for tests only — in production an entry ends with its publisher.
 */
export function resetSelectPreviewRegistry(): void {
  livePreviews.length = 0;
}

/* ------------------------------------------------------------------------------------------------
 * How tall the open list ASKS to be
 * ---------------------------------------------------------------------------------------------- */

/**
 * The touch target `styles.css` gives every `.ui-select-option` under {@link TOUCH_TARGET_MEDIA}.
 *
 * Duplicated from the stylesheet because CSS cannot export a number, which is exactly how the two
 * drifted: the estimator below budgeted 34px for an option the stylesheet was rendering at 44px.
 * The unit test asserts the arithmetic; the mobile E2E spec asserts the rendered list agrees.
 */
export const TOUCH_OPTION_MIN_HEIGHT_PX = 44;

/**
 * `.ui-select-list`'s own box: 4px of padding top and bottom, plus its 1px border on each edge.
 *
 * It counts because `box-sizing: border-box` is global, so the `max-height` the anchored-menu
 * helper sets has to cover the chrome as well as the rows inside it. The old estimate budgeted 8px
 * here and forgot the border — 2px of the 22px it was short.
 */
export const SELECT_LIST_CHROME_PX = 10;

/** Past this the list scrolls on purpose: the options genuinely do not fit. */
export const SELECT_MENU_MAX_HEIGHT_PX = 320;

/** One line of option: the label on its own, for a pointer the touch floor does not apply to. */
const COMPACT_OPTION_HEIGHT_PX = 34;
/**
 * What each line AFTER the first adds.
 *
 * 18px, so a two-line option still budgets the 52px it always did — the rewrite below moved from
 * "described or not" to a line count, and the cases that already worked must not move with it.
 */
const EXTRA_OPTION_LINE_PX = 18;

/**
 * The exact condition `styles.css` applies the 44px touch floor under.
 *
 * Kept character-for-character identical to the stylesheet's query, and built from the breakpoint
 * constant the rest of the app already shares, so a change to one is a visible change to the other.
 */
export const TOUCH_TARGET_MEDIA =
  `(max-width: ${MOBILE_BREAKPOINT_PX}px), (pointer: coarse), (hover: none)`;

/**
 * The open list's height REQUEST, which the anchored-menu helper turns into a `max-height`.
 *
 * A request below what the options actually render is not a shorter list — it is a clipped one.
 * #832 hit that on the control least able to afford it: Permission Preset has two options, the
 * estimator asked for `2 × 34 + 8 = 76px`, and the coarse-pointer stylesheet was drawing them at
 * 44px each inside 10px of chrome. 98px of content in a 76px box scrolls, so half of one of only
 * two choices sat below the fold on a phone.
 *
 * So the per-option budget is the MAXIMUM of the caller's estimate and the floor the stylesheet
 * enforces for this pointer type — never a replacement for it, because a described option is
 * already taller than the floor and clamping it down would clip two-line options on exactly the
 * devices this exists to fix.
 */
export function selectMenuDesiredHeight(input: {
  optionCount: number;
  /**
   * The most lines any one option renders — its label, plus a description, plus a disabled reason.
   *
   * A line count rather than a `hasDescription` flag because an option renders up to three lines
   * and the flag could only distinguish two. #986's review caught the consequence: giving an option
   * a `disabledReason` added a line the budget did not know about, so the list asked for less height
   * than it drew and reproduced #832's clipping from the other direction. A count cannot fall behind
   * the markup the same way.
   */
  maxOptionLines: number;
  /** A caller's row budget for content that may wrap. Raised to the touch floor, never lowered. */
  estimatedOptionHeight?: number;
  coarsePointer: boolean;
}): number {
  const lines = Math.max(1, input.maxOptionLines);
  const estimated = input.estimatedOptionHeight
    ?? COMPACT_OPTION_HEIGHT_PX + EXTRA_OPTION_LINE_PX * (lines - 1);
  const perOption = input.coarsePointer
    ? Math.max(estimated, TOUCH_OPTION_MIN_HEIGHT_PX)
    : estimated;
  // An empty list still renders its `emptyLabel` paragraph, so it gets a row rather than the chrome
  // alone — the sliver a bare `optionCount` of 0 produced had nowhere to put the sentence that is
  // the whole reason an empty list stays open.
  const rows = Math.max(1, input.optionCount);
  return Math.min(SELECT_MENU_MAX_HEIGHT_PX, rows * perOption + SELECT_LIST_CHROME_PX);
}

/**
 * Whether the touch floor is live right now, tracked rather than sampled once.
 *
 * Rotating a tablet, docking a laptop, or merely dragging a window across 760px changes which rule
 * the stylesheet applies, and a menu whose height was budgeted under the other one is this same
 * clipping defect arriving a second way.
 */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(TOUCH_TARGET_MEDIA);
      mq.addEventListener("change", onChange);
      // `resize` as well as the query, for the reason `useIsMobile` subscribes to both: an emulated
      // or automated viewport can deliver the resize before the MediaQueryList change event.
      window.addEventListener("resize", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    () => window.matchMedia(TOUCH_TARGET_MEDIA).matches,
    // Server-rendered markup has no pointer to ask about. The compact budget is the safe guess —
    // it is what the desktop stylesheet renders — and the first client layout corrects it.
    () => false,
  );
}

/**
 * A popover list, for when the options are data rather than a fixed set.
 *
 * A native `<select>` renders OS chrome that ignores the theme entirely — on the light theme it was
 * the one control that stayed dark — and it cannot show a second line, an icon, or a disabled
 * reason. This is a listbox with the same keyboard contract: type-ahead is deliberately NOT
 * implemented here, because the palette already owns search and a half-working type-ahead is worse
 * than none.
 */
export function Select<T extends string>({
  options,
  value,
  onChange,
  onPreview,
  label,
  describedBy,
  placeholder = "Select…",
  emptyLabel = "Nothing to choose from",
  disabled = false,
  className,
  menuWidth,
  estimatedOptionHeight,
}: {
  options: readonly SelectOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /**
   * The option the highlight is currently ON, for a setting whose effect can be shown before it is
   * chosen — and `null` the moment the list stops browsing, by any route.
   *
   * Never a substitute for `onChange`: a preview is not a decision, and Escape has to be able to
   * put back what was there. Callers apply it and nothing else.
   */
  onPreview?: (value: T | null) => void;
  label: string;
  /**
   * The id of helper text the caller renders outside this control.
   *
   * A trigger names its setting and its value and nothing else, so a sentence sitting next to it —
   * "Applies to both the light and the dark theme" — is a sibling nothing points at, and never
   * reaches a screen-reader user who tabbed straight to the control.
   */
  describedBy?: string;
  placeholder?: string;
  /** Shown INSIDE the open list when there are no options, so the control still explains itself. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  /** Requested open-list width; collision handling still clamps it to the viewport. */
  menuWidth?: number;
  /** Row budget for content that may wrap. The viewport remains the final height bound. */
  estimatedOptionHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const coarsePointer = useCoarsePointer();
  const popover = useDismissiblePopover(open, setOpen, "ui-select");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // After the controller's own focus effect, not instead of it: it focuses the first button in
    // the panel, and every option is a button, so DOM focus and aria-activedescendant pointed at
    // different options. With activedescendant driving, focus belongs on the list.
    const frame = requestAnimationFrame(() => popover.panelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, popover]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) popover.close(false);
    };
    // Losing the WINDOW is a dismissal that produces no `focusin` at all — Alt+Tab, the address bar,
    // a devtools panel. Without it the list stays open and the previewed palette stays applied to an
    // app nobody is looking at, and returning to the window finds it that colour with no explanation.
    // Not capture, so this is the window's own blur rather than every element blur inside it.
    const leave = () => popover.close(false);
    // `focusin` as well as pointer: tabbing away is a dismissal too, and it is the one a keyboard
    // user hits. Capture, so a handler that stops propagation cannot leave the list open.
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss, true);
    window.addEventListener("blur", leave);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss, true);
      window.removeEventListener("blur", leave);
    };
  }, [open, popover]);
  /**
   * What the list is BROWSING, derived from the same `active` index the keyboard and the pointer
   * already move — not fired from each handler that moves it.
   *
   * Publishing it from the handlers means one call site per way of leaving the list, and the ones
   * that get forgotten are exactly the ones that matter: an Escape, an outside click or a Tab that
   * does not clear the preview leaves the previewed palette on screen permanently, with no control
   * still open to explain why the app changed colour. Derived, there is one rule — the list is
   * either browsing an option or it is not — and every dismissal satisfies it by closing.
   */
  const previewValue = open ? options[active]?.value ?? null : null;
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  /*
   * CHANGES only, which is why the last published value is tracked rather than the callback simply
   * being invoked. A closed picker is not previewing anything, so announcing that on mount is not
   * information — and it is actively wrong once a screen holds more than one of these: mounting a
   * second picker would publish null and cancel the first one's preview out from under it.
   *
   * Layout rather than passive, because a passive effect publishes after the browser has painted:
   * Escape showed one frame of the palette it was cancelling.
   */
  const publishedRef = useRef<T | null>(null);
  // This instance's identity on the stack above. An object rather than the component itself: two
  // Selects rendered from the same element type are the same function, so anything less than a
  // per-mount value would make every picker look like the same publisher.
  const instanceRef = useRef<object>({});
  const publish = (next: T | null) => {
    if (publishedRef.current === next) return;
    publishedRef.current = next;
    // A picker with nowhere to publish is not in this channel at all. Almost every Select in the app
    // is one, and taking a place on the stack it never writes to would leave the picker that DOES
    // preview covered by it — a palette nobody chose, applied for the rest of the session.
    //
    // Withdrawing rather than merely returning, because the prop can go away while a preview is
    // still on screen: a parent that stops passing `onPreview` mid-browse leaves an entry only the
    // callback of record can retire, and returning here left that entry on the stack for good.
    const notify = previewRef.current as ((value: string | null) => void) | undefined;
    if (next === null || !notify) withdrawPreview(instanceRef.current);
    else publishPreview(instanceRef.current, next, notify);
  };
  useLayoutEffect(() => { publish(previewValue); }, [previewValue]);
  // Unmounting IS a dismissal, and the only one the effect above cannot see: closing Settings
  // mid-browse never renders this component with a closed list, so without this the preview
  // outlives the picker that was showing it.
  useLayoutEffect(() => () => publish(null), []);

  const selected = options.find((option) => option.value === value) ?? null;
  const lastEnabledIndex = options.reduce((last, option, index) => (option.disabled ? last : index), 0);
  // The listbox is positioned by the shared anchored-menu helper, which flips it above the trigger
  // when there is no room below. Hardcoding `top: 100%` put the list off-screen for any control in
  // the lower half of the viewport — which is most of them, since selects sit inside dialogs.
  const listStyle = useAnchoredMenuStyle(open, popover.triggerRef, {
    // A described option is TWO lines, and a touch option is 44px whatever it contains, so the row
    // budget answers to both. Still a request rather than a size — the helper clamps to the
    // viewport and flips above the trigger.
    desiredHeight: selectMenuDesiredHeight({
      optionCount: options.length,
      // Counted from what each option will actually render, so a caller cannot add a line the
      // budget has not accounted for.
      maxOptionLines: options.reduce((most, option) => Math.max(most, 1
        + (option.description ? 1 : 0)
        + (option.disabled && option.disabledReason ? 1 : 0)), 1),
      estimatedOptionHeight,
      coarsePointer,
    }),
    ...(menuWidth === undefined
      ? { matchTriggerWidth: true }
      : { desiredWidth: menuWidth, minTriggerWidth: true }),
  });

  const openAt = (index: number) => {
    setActive(Math.max(0, index));
    setOpen(true);
  };
  const commit = (option: SelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    // close(true) returns focus to the trigger, which survives the teardown; close(false) left
    // keyboard position on <body>, the defect #207 fixed in the rail's sheet.
    popover.close(true);
  };

  const optionId = (index: number) => `${popover.panelId}-option-${index}`;

  return (
    <div
      className={`ui-select${className ? ` ${className}` : ""}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (!open) return;
        // Escape wherever focus sits inside an open Select — including on the TRIGGER, which is
        // where it stays when the list is empty and has nothing to focus. Unhandled there, it
        // bubbled to the enclosing modal and closed the whole dialog instead of the list.
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          popover.close(true);
          return;
        }
        if (event.key !== "Tab") return;
        /*
         * Tab in BOTH directions, here rather than through the focus dismisser.
         *
         * Shift+Tab from the list lands on this Select's OWN trigger, which is inside the root, so
         * the `focusin` handler that treats a focus move as a dismissal correctly decides nothing
         * left — and the list stayed open with a palette applied that nobody chose. Forward Tab was
         * only ever dismissed as a side effect of where focus happened to land next.
         *
         * Focus moves to the trigger first and synchronously: closing unmounts the panel that focus
         * is sitting in, and a browser continuing a Tab from a detached element restarts at the top
         * of the document. From the trigger, traversal continues to the real neighbour in either
         * direction. `close(false)` because focus is already where it belongs.
         */
        popover.triggerRef.current?.focus();
        popover.close(false);
      }}
    >
      <button
        ref={popover.triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popover.panelId : undefined}
        // The trigger's accessible name is the LABEL AND THE VALUE. `aria-label` alone replaced the
        // content, so the chosen option was never announced — the control read as "Project" whether
        // it said Alpha or nothing at all.
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) (open ? popover.close(true) : openAt(options.findIndex((o) => o.value === value))); }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAt(event.key === "ArrowUp" ? lastEnabledIndex : options.findIndex((o) => o.value === value));
          }
        }}
      >
        {selected?.swatch}
        <span className={`ui-select-value${selected ? "" : " is-placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDownIcon size={14} className="ui-select-caret" />
      </button>
      {open && (
        <div
          className="ui-select-list"
          id={popover.panelId}
          ref={popover.panelRef}
          role="listbox"
          aria-label={label}
          aria-activedescendant={options[active] ? optionId(active) : undefined}
          tabIndex={-1}
          style={listStyle}
          onKeyDown={(event) => {
            const step = (delta: number) => {
              event.preventDefault();
              if (options.length === 0) return;
              let next = active;
              for (let hop = 0; hop < options.length; hop += 1) {
                next = (next + delta + options.length) % options.length;
                if (!options[next]?.disabled) break;
              }
              setActive(next);
            };
            if (event.key === "ArrowDown") return step(1);
            if (event.key === "ArrowUp") return step(-1);
            if (event.key === "Home") { event.preventDefault(); return setActive(options.findIndex((o) => !o.disabled)); }
            if (event.key === "End") { event.preventDefault(); return setActive(options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0).pop() ?? 0); }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              const option = options[active];
              if (option) commit(option);
              return;
            }
            // Escape comes from the shared popover controller so this behaves like every other menu
            // in the app. Tab is handled on the ROOT instead of here: it has to close the list from
            // the trigger as well, which this handler never sees.
            popover.onPanelKeyDown(event);
          }}
        >
          {options.length === 0 && <p className="ui-select-empty">{emptyLabel}</p>}
          {options.map((option, index) => (
            <button
              key={option.value}
              id={optionId(index)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              tabIndex={-1}
              className={`ui-select-option${option.value === value ? " is-selected" : ""}`
                + `${index === active ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(option)}
            >
              {option.swatch}
              <span className="ui-select-option-body">
                <span>{option.label}</span>
                {option.description && <small className="ui-select-option-desc">{option.description}</small>}
                {option.disabled && option.disabledReason && (
                  <small className="ui-select-option-reason">{option.disabledReason}</small>
                )}
              </span>
              {option.value === value && <CheckIcon size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
