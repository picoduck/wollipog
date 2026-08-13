import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "../Icons.js";
import {
  handleRovingChoiceKeyDown,
  rovingChoiceStop,
  useAnchoredMenuStyle,
  useDismissiblePopover,
} from "../interactions.js";

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
 *   Select            too many to show at once, or the list is data. A project, an agent.
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
        onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
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
      onKeyDown={multiple ? undefined : (event) => handleRovingChoiceKeyDown(event, "radio")}
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
              <span className="ui-choice-card-title">{option.title}</span>
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
    // A described option is TWO lines, so budgeting one line for it asks for a list half the height
    // of what it renders and scrolls a five-item picker that would have fitted. Still a request
    // rather than a size — the helper clamps to the viewport and flips above the trigger.
    desiredHeight: Math.min(320, Math.max(1, options.length)
      * (estimatedOptionHeight ?? (options.some((option) => option.description) ? 52 : 34)) + 8),
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
