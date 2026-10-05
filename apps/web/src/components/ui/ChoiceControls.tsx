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
import { flushSync } from "react-dom";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "../Icons.js";
import {
  handleRovingChoiceKeyDown,
  rovingChoiceStop,
  useAnchoredMenuStyle,
  useDismissiblePopover,
} from "../interactions.js";
import { MOBILE_BREAKPOINT_PX } from "../useIsMobile.js";

/** An option's label and the second lines under it: its description and, when unavailable, why. */
interface ListboxOptionText {
  label: string;
  description?: string;
  reason?: string;
}

/**
 * The label alone names an option and its second lines describe it, as a menu item's do (§9.1):
 * read together as one name, options were long, hard to tell apart and slow to reach with a
 * screen reader's first-letter navigation, which matches the name. Returns the option's
 * `aria-labelledby`/`aria-describedby` and the body that carries those ids, so Select and
 * InlineListbox options are named and described the same way.
 */
function optionTextParts(id: string, { label, description, reason }: ListboxOptionText) {
  const describedBy = [description ? `${id}-desc` : null, reason ? `${id}-reason` : null]
    .filter(Boolean).join(" ");
  return {
    labelledBy: `${id}-label`,
    describedBy: describedBy || undefined,
    body: (
      <span className="ui-select-option-body">
        <span id={`${id}-label`}>{label}</span>
        {description && <small className="ui-select-option-desc" id={`${id}-desc`}>{description}</small>}
        {reason && <small className="ui-select-option-reason" id={`${id}-reason`}>{reason}</small>}
      </span>
    ),
  };
}

/**
 * An always-open listbox owned by another control, such as an autocomplete textbox.
 *
 * The owner keeps DOM focus and drives the active index; this primitive only centralizes the
 * listbox/option semantics so data pickers do not grow their own incompatible choice markup.
 *
 * Options with a label and second lines pass `optionText`, which names each option by its label
 * and describes it by the rest, as Select does. `renderOption` is for options whose whole content
 * is their name, such as a file path behind a decorative icon.
 */
export function InlineListbox<T>({
  id,
  label,
  options,
  activeIndex,
  getKey,
  renderOption,
  optionText,
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
  onSelect: (option: T) => void;
  onActiveChange?: (index: number) => void;
  isOptionDisabled?: (option: T) => boolean;
  className?: string;
  before?: ReactNode;
  after?: ReactNode;
  style?: CSSProperties;
} & (
  | { optionText: (option: T) => ListboxOptionText; renderOption?: never }
  | { renderOption: (option: T) => ReactNode; optionText?: never }
)) {
  return (
    <div
      className={className}
      role="listbox"
      id={id}
      aria-label={label}
      style={style}
      onMouseDown={(event) => event.preventDefault()}
    >
      {before}
      {options.map((option, index) => {
        const optionDisabled = isOptionDisabled?.(option) ?? false;
        const optionId = `${id}-${index}`;
        const text = optionText ? optionTextParts(optionId, optionText(option)) : null;
        return (
          <button
            type="button"
            role="option"
            id={optionId}
            aria-selected={index === activeIndex}
            aria-disabled={optionDisabled || undefined}
            aria-labelledby={text?.labelledBy}
            aria-describedby={text?.describedBy}
            tabIndex={-1}
            className={`ui-inline-listbox-option${index === activeIndex ? " is-active" : ""}`
              + `${optionDisabled ? " is-disabled" : ""}`}
            key={getKey(option)}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => onActiveChange?.(index)}
            onClick={() => { if (!optionDisabled) onSelect(option); }}
          >
            {text ? text.body : renderOption?.(option)}
          </button>
        );
      })}
      {after}
    </div>
  );
}

/**
 * The 16px marker a Checkbox row or a ChoiceRow leads with (§8.4), drawn over a real input.
 *
 * The input IS the box — `appearance: none` restyles it rather than hiding it — so focus, `:checked`,
 * `:disabled` and the platform's keyboard contract all belong to the element the user sees. The
 * check and the radio dot are siblings the stylesheet reveals from `input:checked`, which is how
 * the drawn state and the announced state come from one value.
 */
function ChoiceMark({ type, className, ...input }: {
  type: "checkbox" | "radio";
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return (
    <span className={`${type === "checkbox" ? "checkbox-mark" : "radio-mark"}${className ? ` ${className}` : ""}`}>
      <input type={type} {...input} />
      {type === "checkbox"
        ? <CheckIcon size={14} className="checkbox-check" />
        : <span className="radio-dot" aria-hidden="true" />}
    </span>
  );
}

/**
 * A labelled binary choice: a 16px box with its visible label, and the whole row as the target.
 *
 * The bare 13px input this replaces had only an `aria-label`, so every caller drew its own label
 * beside it and only the box itself was clickable — far below 44px on a phone. The row is a
 * `<label>`, so a click anywhere on it toggles the input and Space toggles it from the keyboard.
 *
 * Copy (§8.4, §17.1): an ordinary label is Title Case; a `consent` label is a sentence the user
 * agrees to ("I understand this deletes 3 assignments") and stays in sentence case. The flag is
 * what `ui-copy-style.test.ts` reads to tell the two apart.
 */
export function Checkbox({
  checked,
  disabled,
  label,
  helper,
  consent,
  ariaLabel,
  labelHidden,
  className,
  title,
  describedBy,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  /** The visible label; Title Case unless `consent`. */
  label: string;
  /** An optional second line in `--text-dim`, announced as the checkbox's description. */
  helper?: ReactNode;
  /** A sentence the user agrees to; its label stays in sentence case. */
  consent?: boolean;
  /**
   * A fuller accessible name where the visible label repeats across a list ("Reviewed" beside every
   * evidence item). It must contain the visible label, so speech input can still say what it sees.
   */
  ariaLabel?: string;
  /** Icon-only use inside a dense row that is already labelled elsewhere: no visible label. */
  labelHidden?: boolean;
  className?: string;
  title?: string;
  /**
   * The id of text elsewhere that describes the box, such as why it is unavailable. An icon-only
   * box has no helper line of its own, so a refusal is announced through this and `title`.
   */
  describedBy?: string;
  onChange: (checked: boolean) => void;
}) {
  const ids = useId();
  const change = (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked);
  if (labelHidden) {
    return (
      <ChoiceMark
        type="checkbox"
        className={className}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
        title={title}
        onChange={change}
      />
    );
  }
  const labelId = `${ids}-label`;
  const helperId = `${ids}-helper`;
  return (
    <label
      className={`checkbox${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <ChoiceMark
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelId}
        aria-describedby={[helper ? helperId : undefined, describedBy].filter(Boolean).join(" ") || undefined}
        onChange={change}
      />
      <span className="checkbox-label" id={labelId}>{label}</span>
      {helper && <span className="checkbox-helper" id={helperId}>{helper}</span>}
    </label>
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
 *   ChoiceRows        options that need a description or an icon to choose between. A preset.
 *   ChoiceList        a compact list of radio rows with a trailing value. A worktree.
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
  value: T | null;
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
        className={`seg${className ? ` ${className}` : ""}`}
        role="radiogroup"
        aria-label={label}
        aria-describedby={groupReason ? reasonId : undefined}
        // Disabled options stay in the arrow order so their reason is reachable without a mouse;
        // activating one is refused by its own `onClick`, so focus moves and nothing is selected.
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
              className="seg-option"
              title={option.disabled ? option.disabledReason ?? option.title : option.title}
              onClick={() => { if (!option.disabled) onChange(option.value); }}
            >
              {option.label}
              {perOptionReasons && option.disabledReason && (
                <small className="seg-option-reason">{option.disabledReason}</small>
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
      {groupReason && <small id={reasonId} className="seg-reason">{groupReason}</small>}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------
 * ChoiceRow
 * ---------------------------------------------------------------------------------------------- */

export interface ChoiceRowOption<T extends string> {
  value: T;
  /** Title Case label. It alone (with `status`) is the option's accessible name. */
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
  /**
   * One line in `--text-dim`, ellipsized on desktop and wrapped to two lines on phones. The full
   * text stays in the accessible description, and in a tooltip when it is a string.
   */
  description?: ReactNode;
  icon?: ReactNode;
  /** The trailing slot: a value or a status that belongs at the row's end. */
  meta?: ReactNode;
  disabled?: boolean;
  /** Why it is disabled. Rendered as the row's second line — §11.3: never hide a setting that could exist. */
  disabledReason?: string;
  /** `data-*` attributes for the row's input, for a caller that finds its controls again (the
   * question card restores focus to the same choice when it moves, #2196). */
  inputData?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * One row of a choice group (§8.4): a leading 16px radio or checkbox, the title, an optional
 * one-line description, an optional icon and a trailing meta slot.
 *
 * The row is a `<label>` around a real input, so the whole row is the target, arrow keys and Space
 * are the platform's, and the selected look (`--surface-selected` with the accent control) is drawn
 * from `input:checked` — the look can never disagree with what is announced, because there is only
 * one value (the §8.4 rule from #1805).
 *
 * The marker leads and is aligned to the title's FIRST line, so in a group whose rows have one-line
 * and two-line text the markers still form one column. The cards this replaces centred a trailing
 * marker on the whole card, so two cards of different heights put their markers at different
 * heights and the eye had to find each one.
 *
 * An unavailable row cannot be checked by click, Space or arrows, but stays reachable; it keeps its
 * size, reads in faint text and shows its reason in place of the description. The description stays
 * in its accessible description, beside the reason.
 *
 * `show` is the list-beside-a-detail form (Import from Git's skills beside their files, #1983): the
 * marker becomes a target of its own, and the rest of the row is a button that shows the row
 * without changing its checkbox. There the fill follows the row shown (`aria-current`) rather than
 * the checked input, which the marker draws on its own, so each look still has one source.
 */
export function ChoiceRow({
  type,
  name,
  checked,
  onSelect,
  title,
  status,
  description,
  icon,
  meta,
  disabled,
  disabledReason,
  inputData,
  compact,
  show,
}: Omit<ChoiceRowOption<string>, "value"> & {
  type: "radio" | "checkbox";
  /** The radio group's shared name, which is what makes arrows move between its rows. */
  name?: string;
  checked: boolean;
  /** A radio calls this when it becomes checked; a checkbox on every toggle. */
  onSelect: () => void;
  /** The ChoiceList form: one line, no description. */
  compact?: boolean;
  /** The row's body shows it in a detail beside the list; `current` marks the row shown, and
   * `controls` names the detail's id. */
  show?: { current: boolean; onShow: () => void; controls?: string };
}) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-desc`;
  const reasonId = `${ids}-reason`;
  const showReason = Boolean(disabled && disabledReason);
  const describedBy = [
    description ? descriptionId : null,
    showReason ? reasonId : null,
  ].filter(Boolean).join(" ") || undefined;
  const select = () => { if (!disabled) onSelect(); };
  const mark = (
    <ChoiceMark
      {...inputData}
      type={type}
      name={name}
      checked={checked}
      // `aria-disabled`, not `disabled`: a natively disabled radio drops out of the arrow order,
      // so the row and its reason would be reachable by mouse and by nothing else. The change is
      // refused instead — `onSelect` is never called, and React restores the checked input the
      // controlled value names — so arrows reach it, a screen reader announces it with its
      // reason, and nothing is selected.
      aria-disabled={disabled || undefined}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onChange={select}
      // A checked radio fires no `change` when it is clicked (or Space is pressed on it) again,
      // but the cards this replaced reported that re-selection, and callers rely on it: New
      // Session records an explicit role override, Move to Project re-applies the choice. `checked`
      // is the value before this click, so a first selection is reported once, by `change`.
      onClick={type === "radio" && checked ? select : undefined}
    />
  );
  const content = <>
    {icon && <span className="choice-row-icon" aria-hidden="true">{icon}</span>}
    <span className="choice-row-body">
      <span className="choice-row-title" id={titleId}>
        {title}
        {status && <span className="choice-row-status">{status}</span>}
      </span>
      {description && (
        <span
          className={showReason ? "sr-only" : "choice-row-desc"}
          id={descriptionId}
          title={typeof description === "string" ? description : undefined}
        >
          {description}
        </span>
      )}
      {showReason && <small className="choice-row-reason" id={reasonId}>{disabledReason}</small>}
    </span>
    {meta && <span className="choice-row-meta">{meta}</span>}
  </>;
  const modifiers = `${compact ? " compact" : ""}${disabled ? " is-disabled" : ""}`;
  if (show) {
    return (
      <div className={`choice-row has-show${modifiers}${show.current ? " is-current" : ""}`}>
        <label className="choice-row-mark-target">{mark}</label>
        <button
          type="button"
          className="choice-row-show"
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          aria-current={show.current || undefined}
          aria-controls={show.controls}
          onClick={show.onShow}
        >
          {content}
        </button>
      </div>
    );
  }
  return <label className={`choice-row${modifiers}`}>{mark}{content}</label>;
}

/**
 * A group of ChoiceRows: options that need room to explain themselves.
 *
 * Single and multiple selection are the same component because they looked identical in six
 * different places and differed only in role — `.loc-pick` and `.workflow-preset` were single,
 * `.agent-pick` and `.advanced-agent-pick` were checkbox-backed multiples. The input type says which
 * it is, and so does the marker: a ring with a dot for one-of, a box with a tick for many-of.
 *
 * A single group is native radios sharing one `name`, so Tab reaches the checked row (or the first
 * row when nothing is checked) and arrows move and select within the group — the
 * behaviour the hand-written roving handler used to imitate.
 */
export function ChoiceRows<T extends string>({
  options,
  value,
  onChange,
  label,
  multiple,
  className,
  id,
  labelledBy,
  describedBy,
  invalid,
  show,
}: {
  options: readonly ChoiceRowOption<T>[];
  onChange: (value: T) => void;
  /** The group's accessible name. Required: an unlabelled radiogroup announces only its options. */
  label: string;
  className?: string;
  id?: string;
  /** Visible text that names the group instead of `label` (a question above its options). */
  labelledBy?: string;
  /** The group's description: a field error while it shows (§8.5), or why nothing can be chosen. */
  describedBy?: string;
  /** The group's answer is invalid (§8.5). Announced on a radio group; a checkbox group has no
   * invalid state of its own, so its error is reached through `describedBy`. */
  invalid?: boolean;
  /** Each row's body shows that row in a detail beside the list (ChoiceRow's `show`): `value` is
   * the row shown, and `controls` the detail's id. */
  show?: { value: NoInfer<T> | null; onShow: (value: T) => void; controls?: string };
} & ({ multiple: true; value: readonly NoInfer<T>[] } | { multiple?: false; value: NoInfer<T> | null })) {
  // The mode decides the shape, so the types cannot disagree with it: a single mode given an array
  // silently selected nothing, and a multiple mode given a scalar selected one row and then could
  // never deselect it. `null` is a real single-choice state — an approval question starts
  // unanswered — so it is normalised to an empty set rather than forced into a fake selection.
  const selectedValues = multiple ? value : value === null ? [] : [value as T];
  const name = useId();
  return (
    <div
      id={id}
      className={`choice-rows${className ? ` ${className}` : ""}`}
      role={multiple ? "group" : "radiogroup"}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={!multiple && invalid ? true : undefined}
    >
      {options.map((option) => (
        <ChoiceRow
          key={option.value}
          type={multiple ? "checkbox" : "radio"}
          name={multiple ? undefined : name}
          checked={selectedValues.includes(option.value)}
          onSelect={() => onChange(option.value)}
          title={option.title}
          status={option.status}
          description={option.description}
          icon={option.icon}
          meta={option.meta}
          disabled={option.disabled}
          disabledReason={option.disabledReason}
          inputData={option.inputData}
          show={show && { current: show.value === option.value, onShow: () => show.onShow(option.value), controls: show.controls }}
        />
      ))}
    </div>
  );
}

export interface ChoiceListOption<T extends string> {
  value: T;
  /** Title Case label. */
  label: string;
  /** The trailing value — a count, a branch, a time. */
  meta?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * The compact ChoiceRow group (`.choice-list`): radio rows with a trailing value and no
 * description, for pickers inside sheets and presets — a list to pick from rather than options to
 * weigh. Same native radios, same leading marker column, a single-line row.
 */
export function ChoiceList<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  id,
}: {
  options: readonly ChoiceListOption<T>[];
  value: NoInfer<T> | null;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  id?: string;
}) {
  const name = useId();
  return (
    <div
      id={id}
      className={`choice-list${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option) => (
        <ChoiceRow
          key={option.value}
          compact
          type="radio"
          name={name}
          checked={option.value === value}
          onSelect={() => onChange(option.value)}
          title={option.label}
          icon={option.icon}
          meta={option.meta}
          disabled={option.disabled}
          disabledReason={option.disabledReason}
        />
      ))}
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
export function filterSearchableComboboxOptions<O extends Omit<SearchableComboboxOption<string>, "value">>(
  options: readonly O[],
  query: string,
): O[] {
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
 * The sentence a search with no results shows (§12.2): "No projects match “wolipog”."
 *
 * A message rather than a label, so it names what was searched and reads in sentence case. The
 * caller supplies the plural noun, because only it knows what the list holds.
 */
export function noMatchSentence(noun: string, query: string): string {
  return `No ${noun} match “${query.trim()}”.`;
}

/**
 * A row that follows the no-match sentence and turns a failed search into a next step
 * ("Create Project…"). Only this one action lives in the list; any other footer action belongs to
 * the area that owns the picker.
 */
export interface PickerCreateOption {
  /** Title Case, ending in an ellipsis when it opens a dialog. */
  label: string;
  /** Called with the query that found nothing, after the list has closed. */
  onSelect: (query: string) => void;
}

function NoMatchRow({ noun, query }: { noun: string; query: string }) {
  return (
    <p className="ui-select-empty ui-select-no-match">
      <SearchIcon size={14} />
      <span>{noMatchSentence(noun, query)}</span>
    </p>
  );
}

function CreateOptionRow({ id, label, active, onSelect, onActive }: {
  id: string;
  label: string;
  active: boolean;
  onSelect: () => void;
  onActive?: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={active}
      tabIndex={-1}
      className={`ui-select-option${active ? " is-active" : ""}`}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onActive}
      onClick={onSelect}
    >
      <PlusIcon size={14} />
      <span className="ui-select-option-body"><span>{label}</span></span>
    </button>
  );
}

/**
 * The leading and trailing slots a picker's field draws INSIDE its own edge (§8.4): a 16px icon
 * before the value, and the 14px chevron after it. Inside rather than beside, so the field's left
 * edge lines up with every other field in the form.
 */
function LeadingIcon({ icon }: { icon: ReactNode }) {
  return <span className="ui-picker-leading-icon" aria-hidden="true">{icon}</span>;
}

/**
 * An editable list autocomplete built on InlineListbox.
 *
 * DOM focus stays on the input while `aria-activedescendant` moves through the popup. Unavailable
 * options stay in that arrow order so their rendered reason can be inspected, but activation is
 * refused in both this owner and InlineListbox. Enter belongs to selection only while the popup is
 * open; once closed it is deliberately untouched so an enclosing form can own default submission.
 *
 * It reads as a picker, like the Select beside it (§8.4): the same trailing chevron, which opens and
 * closes the list without moving the caret, and an optional brand icon inside the field. Focus opens
 * the list with the caret after the value rather than selecting it — a selection painted the value
 * in the native highlight and let the next keystroke silently replace it.
 */
export function SearchableCombobox<T extends string>({
  options,
  value,
  onChange,
  label,
  describedBy,
  placeholder = "Search…",
  emptyLabel = "Nothing to choose from",
  noun = "options",
  createOption,
  leadingIcon,
  disabled = false,
  className,
  inputId,
  autoFocus,
}: {
  options: readonly SearchableComboboxOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  describedBy?: string;
  placeholder?: string;
  /** Shown when there is nothing to choose from at all, before any search. */
  emptyLabel?: string;
  /** The plural, lowercase noun a search with no results names: "No projects match “x”." */
  noun?: string;
  /** An optional next step after a search that found nothing. */
  createOption?: PickerCreateOption;
  /** A 16px decoration drawn inside the field, before the value. Hidden from assistive technology. */
  leadingIcon?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Optional DOM id for associating a visible label with the editable owner. */
  inputId?: string;
  /** Claim focus when the editable owner is initially mounted. */
  autoFocus?: boolean;
}) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const coarsePointer = useTouchTargetMode();
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
  const noMatch = searching && query.trim() !== "" && results.length === 0;
  // The create row is the list's only option when it shows, so it is also the active one.
  const showCreate = noMatch && Boolean(createOption);
  const createId = `${listboxId}-create`;
  const desiredHeight = selectMenuDesiredHeight({
    optionCount: results.length + (showCreate ? 1 : 0),
    maxOptionLines: results.reduce((most, option) => Math.max(most, 1
      + (option.description ? 1 : 0)
      + (option.disabled && option.disabledReason ? 1 : 0)), 1),
    coarsePointer,
  });
  const listStyle = useAnchoredMenuStyle(open, inputRef, {
    desiredHeight,
    matchTriggerWidth: true,
    measure: () => document.getElementById(listboxId),
    maxHeight: SELECT_MENU_MAX_HEIGHT_PX,
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
  const create = () => {
    if (!createOption) return;
    const searched = query;
    close();
    createOption.onSelect(searched.trim());
  };
  // The chevron toggles the list and leaves the caret where it is: its mousedown is cancelled, so
  // focus never leaves the field. From an unfocused field it focuses the field, whose focus opens it.
  const toggleFromChevron = () => {
    if (disabled) return;
    if (open) {
      close();
      return;
    }
    const input = inputRef.current;
    if (input && document.activeElement !== input) input.focus();
    else openAll();
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
      className={`ui-searchable-combobox${leadingIcon ? " has-leading-icon" : ""}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      {leadingIcon && <LeadingIcon icon={leadingIcon} />}
      <input
        id={inputId}
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        role="combobox"
        aria-label={label}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open
          ? showCreate ? createId : activeOption ? `${listboxId}-${activeIndex}` : undefined
          : undefined}
        aria-disabled={disabled || undefined}
        readOnly={disabled}
        autoComplete="off"
        className="ui-searchable-combobox-input"
        placeholder={placeholder}
        value={inputValue}
        onFocus={(event) => {
          if (disabled) return;
          if (!open) openAll();
          // The caret goes after the value, collapsed. A pointer focus then moves it to where the
          // click landed, which is the platform's behaviour for any other text field.
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
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
            if (showCreate) create();
            else if (activeOption) commit(activeOption);
          }
        }}
      />
      <span
        className="ui-picker-chevron"
        aria-hidden="true"
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleFromChevron}
      >
        <ChevronDownIcon size={14} className="ui-select-caret" />
      </span>
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
          className="ui-searchable-combobox-list menu listbox"
          style={listStyle}
          before={noMatch
            ? <NoMatchRow noun={noun} query={query} />
            : results.length === 0
              ? <p className="ui-select-empty">{emptyLabel}</p>
              : undefined}
          after={showCreate && createOption
            ? <CreateOptionRow id={createId} label={createOption.label} active onSelect={create} />
            : undefined}
          optionText={(option) => ({
            label: option.label,
            description: option.description,
            reason: option.disabled ? option.disabledReason : undefined,
          })}
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
   * The Title Case section this option belongs to. Consecutive options with the same group are
   * listed under one section label (§9.1) inside a `role="group"` named by it; options without one
   * are listed bare.
   */
  group?: string;
  /**
   * A decoration shown before the label, in the trigger as well as in the list.
   *
   * Hiding it from assistive technology is the CALLER's job and every caller owes it: the label
   * already carries the name, so a swatch that announces itself makes the option read twice. A slot
   * rather than an icon prop because the colour-scheme picker needs three dots per option, which no
   * icon component is.
   */
  swatch?: ReactNode;
  /** Extra terms a `searchable` Select's filter matches, as SearchableComboboxOption's do. */
  keywords?: readonly string[];
  disabled?: boolean;
  /** Rendered in the option, not a tooltip — §11.3: never hide a setting that could exist. */
  disabledReason?: string;
}

/** Split a list into runs of consecutive options that share a `group`, keeping each option's index
 * in the whole list, which the option ids and the active highlight count. */
export function selectOptionRuns<O extends { group?: string }>(options: readonly O[]): Array<{
  group: string | undefined;
  start: number;
  options: Array<{ option: O; index: number }>;
}> {
  const runs: Array<{ group: string | undefined; start: number; options: Array<{ option: O; index: number }> }> = [];
  options.forEach((option, index) => {
    const last = runs.at(-1);
    if (last && last.group === option.group) last.options.push({ option, index });
    else runs.push({ group: option.group, start: index, options: [{ option, index }] });
  });
  return runs;
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
 * The height `styles.css` gives every `.ui-select-option` under {@link TOUCH_TARGET_MEDIA}: the
 * option's `min-height` is `--control-h`, which the coarse-pointer block sets to 44px.
 *
 * Duplicated from the stylesheet because CSS cannot export a number, which is exactly how the two
 * drifted: the estimator below budgeted 34px for an option the stylesheet was rendering at 44px.
 * The unit test asserts the arithmetic and that this matches the stylesheet's token; the mobile
 * E2E spec asserts the rendered list agrees.
 */
export const TOUCH_OPTION_MIN_HEIGHT_PX = 44;

/**
 * The open list's own box (`.menu.listbox`): 4px of padding top and bottom, plus its 1px border on
 * each edge.
 *
 * It counts because `box-sizing: border-box` is global, so the `max-height` the anchored-menu
 * helper sets has to cover the chrome as well as the rows inside it. The old estimate budgeted 8px
 * here and forgot the border — 2px of the 22px it was short.
 */
export const SELECT_LIST_CHROME_PX = 10;

/** The narrowest an open Select list gets (docs/design-system.md §8.3), viewport permitting. */
export const SELECT_LIST_MIN_WIDTH_PX = 280;

/** Past this the list scrolls on purpose: the options genuinely do not fit. */
export const SELECT_MENU_MAX_HEIGHT_PX = 320;

/** `--control-h` outside the coarse-pointer block: the height every field and trigger shares. */
const COMPACT_CONTROL_HEIGHT_PX = 32;

/**
 * What a searchable Select's filter row adds to its list: one field at the control height the
 * stylesheet gives this pointer, plus the 4px (`--space-1`) that separates it from the first option.
 */
export function selectFilterRowHeight(coarsePointer: boolean): number {
  return (coarsePointer ? TOUCH_OPTION_MIN_HEIGHT_PX : COMPACT_CONTROL_HEIGHT_PX) + 4;
}

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
 * The exact condition `styles.css` applies the 44px touch floor under: its one coarse-pointer block
 * (docs/design-system.md §2.8, §15.3). Touch sizing follows the pointer, not the viewport, so a
 * narrow desktop window keeps the compact list and a touch tablet gets the touch one.
 *
 * Kept character-for-character identical to the stylesheet's query; a unit test reads the
 * stylesheet and fails when the two disagree.
 */
export const TOUCH_TARGET_MEDIA = "(pointer: coarse)";

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
 * Attaching or detaching a touch screen, or moving the window to a display with a different primary
 * pointer, changes which rule the stylesheet applies, and a menu whose height was budgeted under
 * the other one is this same clipping defect arriving a second way.
 */
export function useTouchTargetMode(): boolean {
  return useMediaMatch(TOUCH_TARGET_MEDIA);
}

/**
 * Where a picker is tap-only (a list you open and tap) rather than a field you type into: a
 * phone-width window as well as any touch pointer, so a narrow window keeps the picker a phone gets.
 *
 * A presentation choice, not a size: the touch SIZE follows the pointer alone
 * ({@link TOUCH_TARGET_MEDIA}), and this deliberately stays on the wider condition it always had.
 */
export const TAP_ONLY_PICKER_MEDIA =
  `(max-width: ${MOBILE_BREAKPOINT_PX}px), (pointer: coarse), (hover: none)`;

export function useTapOnlyPicker(): boolean {
  return useMediaMatch(TAP_ONLY_PICKER_MEDIA);
}

function useMediaMatch(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      // `resize` as well as the query, for the reason `useIsMobile` subscribes to both: an emulated
      // or automated viewport can deliver the resize before the MediaQueryList change event.
      window.addEventListener("resize", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    () => window.matchMedia(query).matches,
    // Server-rendered markup has no pointer to ask about. The compact case is the safe guess — it
    // is what the desktop stylesheet renders — and the first client layout corrects it.
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
 *
 * A `searchable` Select is the touch form of SearchableCombobox: the open list leads with a filter
 * field of its own, focused, so a long list can still be narrowed by typing. The filter lives in the
 * list rather than in the trigger because the trigger sits in a sheet the software keyboard covers,
 * and the list is placed where there is room. The list keeps the side it opened on while the filter
 * narrows it, so the field being typed into never moves.
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
  leadingIcon,
  searchable = false,
  noun = "options",
  createOption,
  disabled = false,
  invalid = false,
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
  /** A 16px decoration drawn inside the trigger, before the value. Hidden from assistive technology. */
  leadingIcon?: ReactNode;
  /** Lead the open list with a focused filter field. */
  searchable?: boolean;
  /** The plural, lowercase noun a filter with no results names: "No projects match “x”." */
  noun?: string;
  /** An optional next step after a filter that found nothing. */
  createOption?: PickerCreateOption;
  disabled?: boolean;
  /** The chosen value is invalid (§8.5): the trigger carries `aria-invalid`, which draws its red
   * edge inside a `.field`. Pair it with `describedBy` pointing at the field's error. */
  invalid?: boolean;
  className?: string;
  /** Requested open-list width; collision handling still clamps it to the viewport. */
  menuWidth?: number;
  /** Row budget for content that may wrap. The viewport remains the final height bound. */
  estimatedOptionHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const coarsePointer = useTouchTargetMode();
  const popover = useDismissiblePopover(open, setOpen, "ui-select");
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // What the list shows: every option, or a searchable list's matches. Every index below — the
  // active one, the option ids, the preview — counts THIS list.
  const visible = useMemo(
    () => searchable ? filterSearchableComboboxOptions(options, query) : [...options],
    [options, query, searchable],
  );
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
  const noMatch = searchable && query.trim() !== "" && visible.length === 0;
  const showCreate = noMatch && Boolean(createOption);
  useEffect(() => {
    if (!open) return;
    // After the controller's own focus effect, not instead of it: it focuses the first button in
    // the panel, and every option is a button, so DOM focus and aria-activedescendant pointed at
    // different options. With activedescendant driving, focus belongs on the list — or, when the
    // list is searchable, on its filter, which drives the same activedescendant.
    const frame = requestAnimationFrame(() => (searchable ? filterRef.current : popover.panelRef.current)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, popover, searchable]);
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
  const previewValue = open ? visible[activeIndex]?.value ?? null : null;
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
    desiredHeight: Math.min(SELECT_MENU_MAX_HEIGHT_PX, selectMenuDesiredHeight({
      // Every option, even while a filter narrows them: a searchable list keeps the box it opened
      // with (see below), and the no-match sentence with its create row needs two rows of it.
      optionCount: Math.max(options.length, createOption ? 2 : 1),
      // Counted from what each option will actually render, so a caller cannot add a line the
      // budget has not accounted for.
      maxOptionLines: options.reduce((most, option) => Math.max(most, 1
        + (option.description ? 1 : 0)
        + (option.disabled && option.disabledReason ? 1 : 0)), 1),
      estimatedOptionHeight,
      coarsePointer,
    }) + (searchable ? selectFilterRowHeight(coarsePointer) : 0)),
    // At least as wide as the trigger and at least SELECT_LIST_MIN_WIDTH_PX, so a short trigger does
    // not wrap its option descriptions onto five lines (§8.3). The helper still clamps to the viewport.
    desiredWidth: Math.max(menuWidth ?? 0, SELECT_LIST_MIN_WIDTH_PX),
    minTriggerWidth: true,
    // The estimate above counts lines as written; a description that wraps at the list's width is
    // taller. The list grows to what it renders, still within SELECT_MENU_MAX_HEIGHT_PX.
    measure: () => popover.panelRef.current,
    maxHeight: SELECT_MENU_MAX_HEIGHT_PX,
  });
  // A searchable list that opened ABOVE its trigger holds the height it was placed at. It is anchored
  // by its bottom edge, so shrinking to its matches slid the filter being typed into down the screen
  // with every keystroke. A list anchored by its top edge keeps its filter still as it shrinks.
  const panelStyle = searchable && listStyle?.top === "auto"
    ? { ...listStyle, height: listStyle.maxHeight }
    : listStyle;

  const openAt = (index: number) => {
    setActive(Math.max(0, index));
    setQuery("");
    if (!searchable) {
      setOpen(true);
      return;
    }
    // Rendered and focused inside the same user gesture: iOS raises the software keyboard only for a
    // focus that happens synchronously in the tap or keypress that asked for it.
    flushSync(() => setOpen(true));
    filterRef.current?.focus();
  };
  const commit = (option: SelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    // close(true) returns focus to the trigger, which survives the teardown; close(false) left
    // keyboard position on <body>, the defect #207 fixed in the rail's sheet.
    popover.close(true);
  };
  const create = () => {
    if (!createOption) return;
    const searched = query.trim();
    popover.close(true);
    createOption.onSelect(searched);
  };
  const filter = (next: string) => {
    setQuery(next);
    // The first result a keypress can commit, as Home would choose.
    setActive(Math.max(0, filterSearchableComboboxOptions(options, next).findIndex((option) => !option.disabled)));
  };

  const optionId = (index: number) => `${popover.panelId}-option-${index}`;
  const listId = searchable ? `${popover.panelId}-list` : popover.panelId;
  const createId = `${popover.panelId}-create`;
  const activeDescendant = showCreate ? createId : visible[activeIndex] ? optionId(activeIndex) : undefined;

  /**
   * The list's keyboard contract, owned by whatever holds focus while it is open: the list itself,
   * or a searchable list's filter. Space belongs to the filter's text there, so only the list
   * commits with it; Escape and Tab are the root's in both forms.
   */
  const navigate = (event: React.KeyboardEvent<HTMLElement>, spaceCommits: boolean) => {
    const step = (delta: number) => {
      event.preventDefault();
      if (visible.length === 0) return;
      let next = activeIndex;
      for (let hop = 0; hop < visible.length; hop += 1) {
        next = (next + delta + visible.length) % visible.length;
        if (!visible[next]?.disabled) break;
      }
      setActive(next);
    };
    if (event.key === "ArrowDown") return step(1);
    if (event.key === "ArrowUp") return step(-1);
    if (event.key === "Home") { event.preventDefault(); return setActive(visible.findIndex((o) => !o.disabled)); }
    if (event.key === "End") { event.preventDefault(); return setActive(visible.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0).pop() ?? 0); }
    if (event.key === "Enter" || (spaceCommits && event.key === " ")) {
      event.preventDefault();
      if (showCreate) return create();
      const option = visible[activeIndex];
      if (option) commit(option);
      return;
    }
    // Escape comes from the shared popover controller so this behaves like every other menu in the
    // app. Tab is handled on the ROOT instead of here: it has to close the list from the trigger as
    // well, which this handler never sees.
    if (!searchable) popover.onPanelKeyDown(event as React.KeyboardEvent<HTMLDivElement>);
  };

  // The label alone names an option and its second lines describe it (see optionTextParts).
  const renderOption = (option: SelectOption<T>, index: number) => {
    const id = optionId(index);
    const text = optionTextParts(id, {
      label: option.label,
      description: option.description,
      reason: option.disabled ? option.disabledReason : undefined,
    });
    return (
      <button
        key={option.value}
        id={id}
        type="button"
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined}
        aria-labelledby={text.labelledBy}
        aria-describedby={text.describedBy}
        tabIndex={-1}
        className={`ui-select-option${option.value === value ? " is-selected" : ""}`
          + `${index === activeIndex ? " is-active" : ""}${option.disabled ? " is-disabled" : ""}`}
        onMouseEnter={() => setActive(index)}
        onClick={() => commit(option)}
      >
        {option.swatch}
        {text.body}
        {option.value === value && <CheckIcon size={14} />}
      </button>
    );
  };

  const rows = (
    <>
      {noMatch
        ? <NoMatchRow noun={noun} query={query} />
        : visible.length === 0 && <p className="ui-select-empty">{emptyLabel}</p>}
      {selectOptionRuns(visible).map((run) => {
        const options = run.options.map(({ option, index }) => renderOption(option, index));
        if (run.group === undefined) return options;
        const labelId = `${popover.panelId}-group-${run.start}`;
        return (
          <div key={labelId} role="group" aria-labelledby={labelId}>
            <div className="menu-label" id={labelId} role="presentation">{run.group}</div>
            {options}
          </div>
        );
      })}
      {showCreate && createOption && (
        <CreateOptionRow id={createId} label={createOption.label} active onSelect={create} />
      )}
    </>
  );


  return (
    <div
      className={`ui-select${className ? ` ${className}` : ""}`}
      ref={rootRef}
      onKeyDown={(event) => {
        if (!open) return;
        // A key that belongs to an IME composition in the filter — Escape dismissing a candidate
        // list, most of all — is the input method's, not a dismissal of this list.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
        className={`ui-select-trigger${leadingIcon ? " has-leading-icon" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // The trigger's accessible name is the LABEL AND THE VALUE. `aria-label` alone replaced the
        // content, so the chosen option was never announced — the control read as "Project" whether
        // it said Alpha or nothing at all.
        aria-label={`${label}: ${selected?.label ?? placeholder}`}
        aria-describedby={describedBy}
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        onClick={() => { if (!disabled) (open ? popover.close(true) : openAt(options.findIndex((o) => o.value === value))); }}
        onKeyDown={(event) => {
          if (disabled) return;
          // Modified Enter belongs to an enclosing form's explicit shortcut; only plain Enter
          // owns this trigger's ordinary open-listbox behavior.
          const unmodifiedEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey;
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || unmodifiedEnter || event.key === " ") {
            event.preventDefault();
            openAt(event.key === "ArrowUp" ? lastEnabledIndex : options.findIndex((o) => o.value === value));
          }
        }}
      >
        {leadingIcon && <LeadingIcon icon={leadingIcon} />}
        {selected?.swatch}
        <span className={`ui-select-value${selected ? "" : " is-placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDownIcon size={14} className="ui-select-caret" />
      </button>
      {open && !searchable && (
        <div
          className="menu listbox"
          id={popover.panelId}
          ref={popover.panelRef}
          role="listbox"
          aria-label={label}
          aria-activedescendant={activeDescendant}
          tabIndex={-1}
          style={panelStyle}
          onKeyDown={(event) => navigate(event, true)}
        >
          {rows}
        </div>
      )}
      {open && searchable && (
        <div
          className="menu listbox"
          id={popover.panelId}
          ref={popover.panelRef}
          tabIndex={-1}
          style={panelStyle}
        >
          <div className="ui-select-filter-row">
            <SearchIcon size={14} className="ui-select-filter-icon" />
            <input
              ref={filterRef}
              type="text"
              role="combobox"
              className="ui-select-filter"
              aria-label={`Search ${label} Options`}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeDescendant}
              placeholder="Search…"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(event) => filter(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                // Shifted Home and End still select text in the field.
                if ((event.key === "Home" || event.key === "End") && event.shiftKey) return;
                navigate(event, false);
              }}
            />
          </div>
          <div role="listbox" id={listId} aria-label={label}>
            {rows}
          </div>
        </div>
      )}
    </div>
  );
}
