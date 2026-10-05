import React, { useId, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { CheckIcon, ChevronRightIcon } from "../Icons.js";
import { SegmentedControl, Select, type SelectOption } from "./ChoiceControls.js";

/**
 * Settings rows, as visually distinct primitives.
 *
 * Verified in the running desktop app, three of these rendered pixel-identically — a bold title, a
 * dim description, and nothing else:
 *
 *     role="radio"   aria-checked="false"   ← Light
 *     role="switch"  aria-checked="false"   ← Desktop Alerts
 *     (no role)                             ← Keyboard Shortcuts, which opens a dialog
 *
 * Only the *selected* radio showed anything, a `✓` in a 14px gutter. So an off switch was
 * indistinguishable from an unselected radio and from a plain navigation link, and there was no
 * on-screen indication that Desktop Alerts was a toggle at all. `role="switch"` promises an on/off
 * control; a checkmark is not one.
 *
 * Each primitive carries an affordance that says what kind of control it is even before you read the
 * label: a pill group, a value with a caret, a track, a chevron.
 *
 * ONE ROW PER SETTING is the second rule, and it is why the one-of-N row is a group of pills rather
 * than a stack of rows. Appearance offered Theme, Colour Scheme and Density as ten full-width rows
 * carrying one option each, so three settings filled a screen and the alternatives a reader is
 * choosing BETWEEN were never visible together — the options were laid out like separate settings
 * because they were shaped like separate settings, which is also why the panel had three headings
 * for three settings. `SegmentedRow` and `SelectRow` put the whole choice in the row’s trailing
 * slot, where every other kind of control already sits, so a setting is a line again.
 *
 * The two are not interchangeable, and the split is the one `ChoiceControls` already draws: pills
 * for a handful of short labels worth showing at once, a listbox when the options need a description
 * or a decoration to choose between. Both DELEGATE to that file rather than restating its keyboard
 * contract — a second radiogroup implementation is a second set of arrow-key bugs, and a second
 * listbox is a second set of dismissal paths that forget to restore something.
 */

interface RowShellProps {
  title: string;
  description?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

function rowClass(extra: string, disabled?: boolean): string {
  return `ui-row ${extra}${disabled ? " is-disabled" : ""}`;
}

function RowBody({ title, titleId, badge, description, descriptionId, descriptionHidden, failure }: {
  title: string;
  /** So a control can be named by the title alone. */
  titleId?: string;
  /** A short flag after the title ("Custom"), outside the title so it is not part of the name. */
  badge?: ReactNode;
  description?: ReactNode;
  /** So a row whose control is a separate element can point at this sentence. */
  descriptionId?: string;
  /** For a sentence the row's control already carries: exposed twice, it is announced twice. */
  descriptionHidden?: boolean;
  /**
   * A failed change, shown in place of the description (§8.5). The description keeps its place
   * underneath, hidden, so the row stays exactly as tall and nothing below it moves. `undefined` is
   * a row that cannot fail; `null` one that has not.
   */
  failure?: ReactNode;
}) {
  const titleNode = <span className="ui-row-title" id={titleId}>{title}</span>;
  const descriptionNode = description && (
    <span className="ui-row-desc" id={descriptionId} aria-hidden={Boolean(failure) || descriptionHidden || undefined}>
      {description}
    </span>
  );
  return (
    <span className="ui-row-body">
      {badge ? <span className="ui-row-title-line">{titleNode}{badge}</span> : titleNode}
      {failure === undefined ? descriptionNode : (
        <span className={`ui-row-desc-slot${failure ? " is-failed" : ""}`}>
          {descriptionNode}
          {failure && <span className="ui-row-desc ui-row-failure">{failure}</span>}
        </span>
      )}
    </span>
  );
}

/** One setting, every option visible. The unselected pills are pills, never blank space. */
export function SegmentedRow({
  title,
  description,
  options,
  value,
  disabled,
  disabledReason,
  onChange,
  label,
}: {
  title: string;
  /** Shown only when the selected option has nothing to say for itself — see below. */
  description?: ReactNode;
  options: ReadonlyArray<{ value: string; label: string; description?: string }>;
  value: string;
  disabled?: boolean;
  /**
   * Why the row cannot be operated, rendered under the pills and associated with the group.
   *
   * A row-level disable is every option at once, so the primitive reads it as ONE reason for the
   * whole group rather than five identical tooltips. Without it a disabled row is a faded control
   * that says nothing about who took it away — §11.3's "never hide a setting that could exist"
   * is only kept if the unavailable setting can still explain itself.
   */
  disabledReason?: string;
  onChange: (value: string) => void;
  /** The group’s accessible name, where the row’s title is not the right one. Defaults to the title. */
  label?: string;
}) {
  /*
   * The SELECTED option’s description becomes the row’s, rather than being dropped.
   *
   * Each option owns a sentence — "Follow this device’s appearance", "More on screen at once" — and
   * a pill is too small to carry one. Dropping them was the alternative and it loses the only
   * writing that says what the setting DOES: a row titled "Theme" reading "System" states the value
   * twice and explains nothing. Showing the selected one keeps the row a single line, spends a slot
   * the shell already renders, and makes the sentence track the choice — it answers "what am I
   * getting?" rather than "what could I get?", which is the question someone reading their own
   * settings actually has. The unselected sentences are not lost so much as deferred: the pill
   * labels are the choice, and the sentence for a pill you are considering appears when you take it.
   */
  const selected = options.find((option) => option.value === value);
  return (
    <div className={rowClass("ui-row-choice", disabled)}>
      <span />
      <RowBody
        title={title}
        description={selected?.description ?? description}
        // The pills carry the same sentence, referenced from the radio it belongs to. Left exposed
        // here as well it is announced twice — once as a sibling of the group and again on the
        // focused option — so the visible copy is for reading, not for the tree. A row-level
        // description with no option behind it is nobody else’s, and stays exposed.
        descriptionHidden={Boolean(selected?.description)}
      />
      <span className="ui-row-choice-control">
        <SegmentedControl
          label={label ?? title}
          value={value}
          onChange={onChange}
          // `disabled` is per OPTION in the primitive, which is what keeps an unavailable choice in
          // the roving order and able to explain itself rather than dropping it out of the keyboard’s
          // reach. A row-level disable is therefore every option at once, not a flag on the group —
          // and the reason travels with it, or the group has nothing to say for itself.
          options={options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            disabled,
            disabledReason: disabled ? disabledReason : undefined,
          }))}
        />
      </span>
    </div>
  );
}

/**
 * Too many options to show at once, or options that need a decoration to tell apart.
 *
 * The trailing control is the shared `Select` listbox, so the closed row STATES the current value
 * rather than only naming the setting: a picker whose resting state reads "Colour Scheme" and not
 * "Dracula" is a row that cannot be read, only opened.
 */
export function SelectRow({
  title,
  description,
  options,
  value,
  disabled,
  onChange,
  onPreview,
  label,
  menuWidth,
  estimatedOptionHeight,
}: {
  title: string;
  description?: ReactNode;
  options: readonly SelectOption<string>[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** For a setting whose effect can be shown while the list is browsed. See `Select`. */
  onPreview?: (value: string | null) => void;
  label?: string;
  menuWidth?: number;
  estimatedOptionHeight?: number;
}) {
  // The trigger names the setting and its value; the sentence beside it — "Applies to both the light
  // and the dark theme" — was a sibling nothing pointed at, so tabbing straight to the control never
  // reached it. `useId` rather than the title: two pickers titled the same would share one target.
  const descriptionId = `${useId()}-desc`;
  return (
    <div className={rowClass("ui-row-choice", disabled)}>
      <span />
      <RowBody title={title} description={description} descriptionId={description ? descriptionId : undefined} />
      <span className="ui-row-choice-control">
        <Select
          className="ui-row-picker"
          label={label ?? title}
          options={options}
          value={value}
          onChange={onChange}
          onPreview={onPreview}
          describedBy={description ? descriptionId : undefined}
          disabled={disabled}
          menuWidth={menuWidth}
          estimatedOptionHeight={estimatedOptionHeight}
        />
      </span>
    </div>
  );
}

/** A switch is named one way: by its label said again, or by visible text it points at. */
type SwitchName = { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

export type SwitchProps = SwitchName & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  describedBy?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Replaces the standalone look; `SwitchRow` makes the whole row the switch. */
  className?: string;
  /** A settings row's text, drawn before the track (`SwitchRow`). Never "On" or "Off". */
  children?: ReactNode;
  switchRef?: Ref<HTMLButtonElement>;
};

/**
 * On/off (§8.4). A real track and knob, which is what role="switch" promises, and the app's only
 * switch: `SwitchRow` renders this with the row's text inside it, and a switch that sits in a row
 * beside other controls renders it alone.
 *
 * Standalone, it is named by `label` (the visible label it sits beside, said again) or by
 * `labelledBy`; it never shows "On" or "Off", because the knob's position is the state.
 *
 * `busy` is for a toggle whose backing request is in flight. Callers must keep passing the last
 * CONFIRMED value as `checked` — reporting the pending value instead announces aria-checked="false"
 * while the thing being switched off is still live, and a slow or failed request leaves that lie
 * on screen until it snaps back.
 */
export function Switch({ checked, onChange, label, labelledBy, describedBy, disabled, busy, className, children, switchRef }: SwitchProps) {
  return (
    <button
      ref={switchRef}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={`ui-switch-control ${className ?? "ui-switch-standalone"}${busy ? " is-busy" : ""}${disabled ? " is-disabled" : ""}`}
      onClick={() => onChange(!checked)}
    >
      {children}
      <span className="ui-switch" aria-hidden="true" />
    </button>
  );
}

/** How long an instant setting's "Saved" check stays at the row's right edge (§8.6). */
export const SAVED_MS = 2000;

/** A change that did not save: one sentence for the row, and the action that repeats the change. */
export interface RowFailure {
  message: string;
  /** The server's own words: announced with the sentence and shown as its tooltip. */
  detail?: string;
  onRetry: () => void;
}

/**
 * An on/off setting: the whole row is the switch.
 *
 * `saved` shows the quiet "Saved" check at the row's right edge (§8.6); the caller turns it on when
 * the change is confirmed and off `SAVED_MS` later. It is announced through a polite region beside
 * the row, because text inside the switch would become part of its name.
 *
 * `failure` is for a row whose change can fail (§8.5, #2158): pass `null` until one does. The
 * sentence then takes the description's place with **Try Again** after it, and the switch keeps the
 * confirmed value. A button cannot hold another button, so while the failure shows the row is a
 * plain row around a standalone switch in the same column. The description stays in the layout
 * underneath, hidden, so the row keeps its height and nothing below it moves. Focus the change of
 * shape drops is handed to the switch; focus that has moved elsewhere is left alone.
 */
export function SwitchRow({
  title,
  badge,
  description,
  checked,
  disabled,
  busy,
  saved,
  failure,
  anchorId,
  onClick,
}: RowShellProps & {
  checked: boolean;
  busy?: boolean;
  saved?: boolean;
  /** A short flag after the title, such as "Custom". */
  badge?: ReactNode;
  failure?: RowFailure | null;
  /** An id for links that scroll to this row. Only for a row that passes `failure`. */
  anchorId?: string;
}) {
  // Named by its title and described by its sentence, so the name is the setting's and nothing more.
  const id = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  /** Whether focus was last inside this row. A removed element takes focus with it silently. */
  const focusInside = useRef(false);
  const failed = Boolean(failure);
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) switchRef.current?.focus();
  }, [failed, busy]);
  const body = (
    <RowBody
      title={title}
      titleId={`${id}-title`}
      badge={badge}
      description={description}
      descriptionId={`${id}-desc`}
      failure={failure === undefined ? undefined : failure && (
        <>
          <span id={`${id}-failure`} title={failure.detail}>{failure.message}</span>{" "}
          <button type="button" className="link ui-row-retry" onClick={failure.onRetry}>Try Again</button>
        </>
      )}
    />
  );
  const control = {
    switchRef,
    labelledBy: `${id}-title`,
    describedBy: failed ? `${id}-failure` : description ? `${id}-desc` : undefined,
    checked,
    disabled,
    busy,
    onChange: () => onClick?.(),
  };
  const row = failed ? (
    <div className={rowClass("ui-row-switch ui-row-failed")}>
      <span />
      {body}
      <Switch {...control} />
    </div>
  ) : (
    <Switch {...control} className={rowClass("ui-row-switch")}>
      <span />
      {body}
      {saved && <span className="ui-row-saved" aria-hidden="true"><CheckIcon size={14} />Saved</span>}
    </Switch>
  );
  if (saved === undefined && failure === undefined) return row;
  const status = saved ? `${title} saved` : failure ? [`${title} not saved.`, failure.message, failure.detail].filter(Boolean).join(" ") : "";
  return (
    <>
      {failure === undefined ? row : (
        <div
          className="ui-row-frame"
          id={anchorId}
          onFocus={() => { focusInside.current = true; }}
          onBlur={(event) => {
            // A removed element blurs with no next target: that is the drop this row repairs.
            if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
          }}
        >
          {row}
        </div>
      )}
      <span className="sr-only" role="status">{status}</span>
    </>
  );
}

/** Goes somewhere. A leading icon and a trailing chevron — and no selection gutter, which
 *  previously made a navigation action look like a control with an indeterminate state. */
/**
 * A row that states something rather than controlling it.
 *
 * No role, because there is nothing to operate: a `switch` with `aria-checked="false"` says the
 * setting is OFF, which is a different fact from "not built yet" and a false one when the real
 * value is simply unknown. Still a row, so it sits in the list looking like the settings around it
 * and cannot be mistaken for missing.
 */
export function StaticRow({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="ui-row ui-row-static">
      <span className="ui-row-body">
        <span className="ui-row-title">{title}</span>
        {description && <span className="ui-row-desc">{description}</span>}
      </span>
    </div>
  );
}

export function NavRow({
  title,
  description,
  icon,
  disabled,
  onClick,
  expanded,
  controls,
  buttonRef,
  id,
  badge,
  hasPopup,
}: RowShellProps & {
  icon?: ReactNode;
  expanded?: boolean;
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** An id for links that scroll to this row. */
  id?: string;
  /** A short flag after the title, such as an effect label. */
  badge?: ReactNode;
  /** For a row that opens a dialog rather than a page. */
  hasPopup?: "dialog";
}) {
  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-haspopup={hasPopup}
      className={rowClass("ui-row-nav", disabled)}
      onClick={onClick}
    >
      <span className="ui-row-icon" aria-hidden="true">{icon}</span>
      <RowBody title={title} badge={badge} description={description} />
      <span className="ui-row-chevron" aria-hidden="true"><ChevronRightIcon size={16} /></span>
    </button>
  );
}
