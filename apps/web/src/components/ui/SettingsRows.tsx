import React, { useId, type ReactNode, type Ref } from "react";
import { ChevronRightIcon } from "../Icons.js";
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

function RowBody({ title, description, descriptionId, descriptionHidden }: {
  title: string;
  description?: ReactNode;
  /** So a row whose control is a separate element can point at this sentence. */
  descriptionId?: string;
  /** For a sentence the row's control already carries: exposed twice, it is announced twice. */
  descriptionHidden?: boolean;
}) {
  return (
    <span className="ui-row-body">
      <span className="ui-row-title">{title}</span>
      {description && (
        <span className="ui-row-desc" id={descriptionId} aria-hidden={descriptionHidden || undefined}>
          {description}
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

/**
 * On/off. A real track and knob, which is what role="switch" promises.
 *
 * `busy` is for a toggle whose backing request is in flight. Callers must keep passing the last
 * CONFIRMED value as `checked` — reporting the pending value instead announces aria-checked="false"
 * while the thing being switched off is still live, and a slow or failed request leaves that lie
 * on screen until it snaps back.
 */
export function SwitchRow({
  title,
  description,
  checked,
  disabled,
  busy,
  onClick,
}: RowShellProps & { checked: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={rowClass(`ui-row-switch${busy ? " is-busy" : ""}`, disabled)}
      onClick={onClick}
    >
      <span />
      <RowBody title={title} description={description} />
      <span className="ui-switch" aria-hidden="true" />
    </button>
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
}: RowShellProps & { icon?: ReactNode; expanded?: boolean; controls?: string; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      className={rowClass("ui-row-nav", disabled)}
      onClick={onClick}
    >
      <span className="ui-row-icon" aria-hidden="true">{icon}</span>
      <RowBody title={title} description={description} />
      <span className="ui-row-chevron" aria-hidden="true"><ChevronRightIcon size={15} /></span>
    </button>
  );
}
