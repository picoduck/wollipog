import React, { useId, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { CopyButton, Spinner } from "../common.js";
import { FieldError } from "../FieldError.js";
import { CheckIcon, ChevronRightIcon } from "../Icons.js";
import { Notice } from "../Notice.js";
import { SegmentedControl, Select, type SelectOption } from "./ChoiceControls.js";

/**
 * Setting rows (docs/design-system.md §8.2): ONE grid for every preference, wherever it is shown.
 *
 *     Title                                              [ control 240 ]
 *     Description, one line of --text-dim 12px.
 *
 * Every row is `.setting-row`: a text cell and a fixed control column, `minmax(0, 1fr)
 * var(--setting-control-w, 240px)`. There is no leading gutter: an icon sits INSIDE the text cell, so
 * every title in a group starts at one left edge and every control ends at one right edge. Rows had
 * an empty first cell, static rows had none, and controls sat in 220px or 260px columns or at the far
 * edge, so titles and controls never lined up (#2947).
 *
 * The row kinds are thin wrappers over that grid, each with the affordance that says what kind of
 * control it is before you read the label: a track (`SwitchRow`), pills (`SegmentedRow`), a value
 * with a caret (`SelectRow`), a field with its unit (`NumberRow`), a value with Copy (`ValueRow`), a
 * chevron (`LinkRow`), a button (`ActionRow`), or nothing (`StaticRow`). An off switch, an unselected
 * radio and a navigation link once rendered pixel-identically; a row says what it is.
 *
 * ONE ROW PER SETTING: a one-of-N choice is one row whose control holds every option (pills for a
 * handful of short labels, a listbox when options need a description or a decoration to choose
 * between), never a stack of rows carrying one option each. Both delegate to `ChoiceControls` rather
 * than restating its keyboard contract.
 *
 * Under a 560px CONTAINER the control drops under its text at full width; switch, link and action
 * rows keep their control trailing. The container is the group's surface (`SettingsGroup`), not the
 * viewport, so the rule holds in the settings panel, a dialog and a detail pane alike.
 */

/**
 * A row's classes and its states. Each caller writes its classes out whole ("setting-row
 * setting-row-switch setting-row-trailing"), so every class a row renders is a literal argument here;
 * `setting-row-trailing` keeps the control beside the text in a narrow container.
 */
function rowClass(classes: string, { disabled, failed, extra }: { disabled?: boolean; failed?: boolean; extra?: string } = {}): string {
  return [classes, extra, disabled && "is-disabled", failed && "is-failed"].filter(Boolean).join(" ");
}

/** How long an instant setting's "Saved" check stays on its row (§8.6). */
export const SAVED_MS = 2000;

/** The quiet "Saved" check (§8.6). Hidden from assistive technology: the row's status region says it. */
function SavedCheck() {
  return <span className="setting-row-saved" aria-hidden="true"><CheckIcon size={14} />Saved</span>;
}

/** What a row's polite status region says: the Saved check, or a failure the row shows in place. */
function rowStatus(title: string, saved?: boolean, failure?: RowFailure | null): string {
  if (saved) return `${title} saved`;
  if (failure) return [`${title} not saved.`, failure.message, failure.detail].filter(Boolean).join(" ");
  return "";
}

interface RowTextProps {
  title: string;
  /** So a control can be named by the title alone. */
  titleId?: string;
  /** A 16px icon before the title, inside the text cell, so titles still share one left edge. */
  icon?: ReactNode;
  /** A short flag after the title ("Custom"), outside the title so it is not part of the name. */
  badge?: ReactNode;
  description?: ReactNode;
  /** So a row whose control is a separate element can point at this sentence. */
  descriptionId?: string;
  /** For a sentence the row's control already carries: exposed twice, it is announced twice. */
  descriptionHidden?: boolean;
  /**
   * A failed change, shown in place of the description (§8.5). `undefined` is a row that cannot
   * fail; `null` one that has not.
   */
  failure?: ReactNode;
  /** A change is saving: a 12px spinner leads the description, or `busyLabel` replaces it. */
  busy?: boolean;
  busyLabel?: ReactNode;
  /** The Saved check at the end of the text cell, for a control that fills its column. */
  saved?: boolean;
}

/**
 * The text cell. A sentence that replaces the description (a failure, a busy label) is drawn in the
 * same cell over the description, which stays in the layout underneath, hidden, so the row keeps its
 * height and nothing below it moves.
 */
function RowText({
  title, titleId, icon, badge, description, descriptionId, descriptionHidden, failure, busy, busyLabel, saved,
}: RowTextProps) {
  // With no sentence of its own the busy row still says what is happening.
  const busyText = busy ? busyLabel ?? (description ? undefined : "Saving…") : undefined;
  const replacement = failure || (busyText !== undefined ? <><Spinner decorative />{busyText}</> : null);
  const titleNode = <span className="setting-row-title" id={titleId}>{title}</span>;
  const descriptionNode = description && (
    <span className="setting-row-desc" id={descriptionId} aria-hidden={Boolean(replacement) || descriptionHidden || undefined}>
      {busy && !replacement && <Spinner decorative />}
      {description}
    </span>
  );
  const slotted = failure !== undefined || replacement;
  return (
    <span className="setting-row-text">
      {icon && <span className="setting-row-icon" aria-hidden="true">{icon}</span>}
      <span className="setting-row-label">
        {badge ? <span className="setting-row-title-line">{titleNode}{badge}</span> : titleNode}
        {slotted ? (
          <span className={`setting-row-desc-slot${failure ? " is-failed" : replacement ? " is-busy" : ""}`}>
            {descriptionNode}
            {replacement && (
              <span className={failure ? "setting-row-desc setting-row-failure" : "setting-row-desc"}>{replacement}</span>
            )}
          </span>
        ) : descriptionNode}
      </span>
      {saved && <SavedCheck />}
    </span>
  );
}

/**
 * The §8.2 grid with any control, for a setting none of the row kinds fits. Prefer a row kind: each
 * one carries its control's affordance and accessible names.
 *
 * `trailing` keeps the control beside the text in a narrow container, as switch, link and action rows
 * do; otherwise it drops under the text at full width.
 */
export function SettingRow({
  title,
  titleId,
  icon,
  badge,
  description,
  descriptionId,
  control,
  trailing,
  disabled,
  busy,
  busyLabel,
  saved,
  className,
}: Omit<RowTextProps, "failure" | "descriptionHidden"> & {
  control?: ReactNode;
  trailing?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={rowClass(trailing ? "setting-row setting-row-trailing" : "setting-row", { disabled, extra: className })} aria-busy={busy || undefined}>
      <RowText
        title={title}
        titleId={titleId}
        icon={icon}
        badge={badge}
        description={description}
        descriptionId={descriptionId}
        busy={busy}
        busyLabel={busyLabel}
        saved={saved}
      />
      {control && <span className="setting-row-control">{control}</span>}
      {saved !== undefined && <span className="sr-only" role="status">{rowStatus(title, saved)}</span>}
    </div>
  );
}

/** What every instant row's status props mean. */
interface InstantRowProps {
  /** The change is saving. The control keeps the confirmed value; the description says so. */
  busy?: boolean;
  /** The sentence while busy. Without one, a spinner leads the row's own description. */
  busyLabel?: ReactNode;
  /** The Saved check (§8.6): on when the change is confirmed, off `SAVED_MS` later. */
  saved?: boolean;
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
  busy,
  busyLabel,
  saved,
}: InstantRowProps & {
  title: string;
  /** Shown only when the selected option has nothing to say for itself — see below. */
  description?: ReactNode;
  options: ReadonlyArray<{ value: string; label: string; description?: string }>;
  value: string;
  disabled?: boolean;
  /**
   * Why the row cannot be operated, rendered under the pills and associated with the group. A
   * row-level disable is every option at once, so the primitive reads it as ONE reason for the whole
   * group rather than five identical tooltips (§11.3: an unavailable setting still explains itself).
   */
  disabledReason?: string;
  onChange: (value: string) => void;
  /** The group’s accessible name, where the row’s title is not the right one. Defaults to the title. */
  label?: string;
}) {
  /*
   * The SELECTED option’s description becomes the row’s, rather than being dropped.
   *
   * Each option owns a sentence and a pill is too small to carry one. Showing the selected one keeps
   * the row a single line and makes the sentence track the choice — it answers "what am I getting?",
   * which is the question someone reading their own settings actually has.
   */
  const selected = options.find((option) => option.value === value);
  return (
    <div className={rowClass("setting-row", { disabled })} aria-busy={busy || undefined}>
      <RowText
        title={title}
        description={selected?.description ?? description}
        // The pills carry the same sentence, referenced from the radio it belongs to. Left exposed
        // here as well it is announced twice. A row-level description with no option behind it is
        // nobody else’s, and stays exposed.
        descriptionHidden={Boolean(selected?.description)}
        busy={busy}
        busyLabel={busyLabel}
        saved={saved}
      />
      <span className="setting-row-control">
        <SegmentedControl
          label={label ?? title}
          value={value}
          onChange={onChange}
          // `disabled` is per OPTION in the primitive, which keeps an unavailable choice in the roving
          // order and able to explain itself. A row-level disable is every option at once — and the
          // reason travels with it.
          options={options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
            disabled,
            disabledReason: disabled ? disabledReason : undefined,
          }))}
        />
      </span>
      {saved !== undefined && <span className="sr-only" role="status">{rowStatus(title, saved)}</span>}
    </div>
  );
}

/** A listbox wide enough to read its options' descriptions on one or two lines (§8.3, §9.1). */
const DESCRIBED_MENU_WIDTH_PX = 360;

/**
 * Too many options to show at once, or options that need a decoration to tell apart.
 *
 * The control is the shared `Select`, so the closed row STATES the current value rather than only
 * naming the setting. Its list is at least as wide as the trigger and 280px, and 360px when options
 * carry descriptions, by default rather than per caller.
 *
 * An invalid value, in an editor that saves several rows at once, is `aria-invalid` with a
 * `FieldError` under the trigger (§8.5), as `NumberRow`'s is.
 */
export function SelectRow({
  title,
  description,
  options,
  value,
  disabled,
  disabledReason,
  error,
  onChange,
  onPreview,
  label,
  menuWidth,
  estimatedOptionHeight,
  busy,
  busyLabel,
  saved,
}: InstantRowProps & {
  title: string;
  description?: ReactNode;
  options: readonly SelectOption<string>[];
  value: string;
  disabled?: boolean;
  /** Why the row cannot be operated: visible under the control and part of its description. */
  disabledReason?: string;
  /** One sentence that says what is wrong with the value and how to fix it. */
  error?: string | null;
  onChange: (value: string) => void;
  /** For a setting whose effect can be shown while the list is browsed. See `Select`. */
  onPreview?: (value: string | null) => void;
  label?: string;
  menuWidth?: number;
  estimatedOptionHeight?: number;
}) {
  // The trigger names the setting and its value; the sentence beside it is pointed at, so tabbing
  // straight to the control still reaches it. `useId` rather than the title: two pickers titled the
  // same would share one target.
  const id = useId();
  const descriptionId = `${id}-desc`;
  const reasonId = `${id}-reason`;
  const errorId = `${id}-error`;
  const reason = disabled && disabledReason ? disabledReason : undefined;
  const describedBy = [error ? errorId : null, description ? descriptionId : null, reason ? reasonId : null]
    .filter(Boolean).join(" ") || undefined;
  return (
    <div className={rowClass("setting-row", { disabled })} aria-busy={busy || undefined}>
      <RowText
        title={title}
        description={description}
        descriptionId={description ? descriptionId : undefined}
        busy={busy}
        busyLabel={busyLabel}
        saved={saved}
      />
      {/* A `.field` while invalid, for the field's red edge (§8.5). */}
      <span className={error ? "setting-row-control field" : "setting-row-control"}>
        <Select
          label={label ?? title}
          options={options}
          value={value}
          onChange={onChange}
          onPreview={onPreview}
          describedBy={describedBy}
          disabled={disabled}
          invalid={Boolean(error)}
          menuWidth={menuWidth ?? (options.some((option) => option.description) ? DESCRIBED_MENU_WIDTH_PX : undefined)}
          estimatedOptionHeight={estimatedOptionHeight}
        />
        {error && <FieldError id={errorId}>{error}</FieldError>}
        {reason &&<small id={reasonId} className="setting-row-reason">{reason}</small>}
      </span>
      {saved !== undefined && <span className="sr-only" role="status">{rowStatus(title, saved)}</span>}
    </div>
  );
}

/**
 * A number (§8.3, §8.4): a 96px `.w-xs` field with its unit inside it ("30 s"). A long unit belongs
 * in the title or the description, which is why the field stays 96px.
 *
 * Named by the title and its unit. An invalid value is `aria-invalid` with a `FieldError` under the
 * field (§8.5), which the field points at while it shows. `value` is the field's text, so a person can
 * clear it while typing; the caller parses it.
 */
export function NumberRow({
  title,
  description,
  value,
  onChange,
  onBlur,
  unit,
  min,
  max,
  step,
  disabled,
  error,
  inputId,
  busy,
  busyLabel,
  saved,
}: InstantRowProps & {
  title: string;
  description?: ReactNode;
  value: string | number;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** A short unit drawn inside the field: "s", "min", "%". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** One sentence that says what is wrong and how to fix it. */
  error?: string | null;
  /** The field's id, for a link or a label elsewhere that has to reach it. */
  inputId?: string;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  const unitId = `${id}-unit`;
  const descriptionId = `${id}-desc`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, description ? descriptionId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={rowClass("setting-row setting-row-number", { disabled })} aria-busy={busy || undefined}>
      <RowText
        title={title}
        titleId={titleId}
        description={description}
        descriptionId={description ? descriptionId : undefined}
        busy={busy}
        busyLabel={busyLabel}
        saved={saved}
      />
      <span className="setting-row-control">
        <span className="field">
          <span className="input-affix w-xs">
            <input
              id={inputId ?? `${id}-input`}
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={step}
              value={value}
              disabled={disabled}
              aria-labelledby={unit ? `${titleId} ${unitId}` : titleId}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              onChange={(event) => onChange(event.currentTarget.value)}
              onBlur={onBlur}
            />
            {unit && <span className="input-affix-text" id={unitId}>{unit}</span>}
          </span>
          {error && <FieldError id={errorId}>{error}</FieldError>}
        </span>
      </span>
      {saved !== undefined && <span className="sr-only" role="status">{rowStatus(title, saved)}</span>}
    </div>
  );
}

/**
 * A read-only value in the control column: an address, a version, a count. `mono` for addresses,
 * versions and ids (§11.3). `copy` adds Copy, an `.icon-btn.sm` named for the value ("Copy Server
 * Address"): `true` copies `value` itself, a string copies that text instead.
 */
export function ValueRow({
  title,
  description,
  icon,
  value,
  mono,
  copy,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  value: ReactNode;
  mono?: boolean;
  copy?: boolean | string;
}) {
  const copyText = typeof copy === "string" ? copy : copy && typeof value === "string" ? value : undefined;
  return (
    <div className={rowClass("setting-row setting-row-value")}>
      <RowText title={title} icon={icon} description={description} />
      <span className="setting-row-control">
        <span
          className={`setting-row-value-text${mono ? " is-mono" : ""}`}
          title={typeof value === "string" ? value : undefined}
        >
          {value}
        </span>
        {copyText !== undefined && (
          <CopyButton text={copyText} iconOnly className="icon-btn sm" ariaLabel={`Copy ${title}`} />
        )}
      </span>
    </div>
  );
}

/**
 * A row that states something rather than controlling it. No role, because there is nothing to
 * operate: a `switch` with `aria-checked="false"` says the setting is OFF, which is a different fact
 * from "not built yet". Its title is full contrast; the description is the dim line every row has.
 */
export function StaticRow({ title, description, icon }: { title: string; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={rowClass("setting-row setting-row-static")}>
      <RowText title={title} icon={icon} description={description} />
    </div>
  );
}

/**
 * Goes somewhere: navigation only. The whole row is the button, with a trailing chevron and an
 * optional trailing word ("3 Policies"). It also opens a dialog (`hasPopup`) or discloses a region
 * (`expanded`, `controls`).
 */
export function LinkRow({
  title,
  description,
  icon,
  trailing,
  disabled,
  onClick,
  expanded,
  controls,
  buttonRef,
  id,
  badge,
  hasPopup,
  className,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** A short word before the chevron: a count or the current value. */
  trailing?: string;
  disabled?: boolean;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  /** An id for links that scroll to this row. */
  id?: string;
  /** A short flag after the title, such as an effect label. */
  badge?: ReactNode;
  /** For a row that opens a dialog rather than a page. */
  hasPopup?: "dialog";
  className?: string;
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
      className={rowClass("setting-row setting-row-link setting-row-trailing", { disabled, extra: className })}
      onClick={onClick}
    >
      <RowText title={title} icon={icon} badge={badge} description={description} />
      <span className="setting-row-control">
        {trailing && <span className="setting-row-link-word">{trailing}</span>}
        <span className="setting-row-chevron" aria-hidden="true"><ChevronRightIcon size={16} /></span>
      </span>
    </button>
  );
}

/**
 * One action for the setting, such as Edit…, as a button in the control column. The button is named
 * by its label and the row's title ("Edit… Claude Code"), so a list of rows does not read as a list
 * of identical buttons.
 */
export function ActionRow({
  title,
  description,
  icon,
  badge,
  actionLabel,
  actionIcon,
  actionId,
  onAction,
  disabled,
  hasPopup,
  buttonRef,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Title Case, with an ellipsis when it opens a dialog: "Edit…". */
  actionLabel: string;
  /** A 14px icon before the label. Icons are `aria-hidden`, so the label alone names the button. */
  actionIcon?: ReactNode;
  /** A stable id for the button, for a caller that finds it again after it remounts. */
  actionId?: string;
  onAction: () => void;
  disabled?: boolean;
  hasPopup?: "dialog";
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  const buttonId = actionId ?? `${id}-action`;
  return (
    <div className={rowClass("setting-row setting-row-trailing", { disabled })}>
      <RowText
        title={title}
        titleId={`${id}-title`}
        icon={icon}
        badge={badge}
        description={description}
        descriptionId={description ? `${id}-desc` : undefined}
      />
      <span className="setting-row-control">
        <button
          ref={buttonRef}
          id={buttonId}
          type="button"
          className="btn"
          disabled={disabled}
          aria-haspopup={hasPopup}
          aria-labelledby={`${buttonId} ${id}-title`}
          aria-describedby={description ? `${id}-desc` : undefined}
          onClick={onAction}
        >
          {actionIcon}
          {actionLabel}
        </button>
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

/** A change that did not save: one sentence for the row, and the action that repeats the change. */
export interface RowFailure {
  message: string;
  /** The server's own words: announced with the sentence and shown as its tooltip. */
  detail?: string;
  onRetry: () => void;
}

/**
 * An on/off setting: the whole row is the switch, its track at the control column's right edge.
 *
 * `saved` shows the quiet "Saved" check before the track (§8.6); the caller turns it on when the
 * change is confirmed and off `SAVED_MS` later. It is announced through a polite region beside the
 * row, because text inside the switch would become part of its name.
 *
 * `failure` is for a row whose change can fail (§8.5, #2158): pass `null` until one does. The
 * sentence then takes the description's place with **Try Again** after it, and the switch keeps the
 * confirmed value. A button cannot hold another button, so while the failure shows the row is a
 * plain row around a standalone switch in the same column. Focus the change of shape drops is
 * handed to the switch; focus that has moved elsewhere is left alone.
 *
 * A row with either is wrapped in `.setting-row-frame` with its status region, so a group's surface
 * sees one child per setting.
 */
export function SwitchRow({
  title,
  badge,
  icon,
  description,
  checked,
  disabled,
  busy,
  busyLabel,
  saved,
  failure,
  anchorId,
  onClick,
}: InstantRowProps & {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  checked: boolean;
  /** A short flag after the title, such as "Custom". */
  badge?: ReactNode;
  failure?: RowFailure | null;
  /** An id for links that scroll to this row. Only for a row that passes `saved` or `failure`. */
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
  const text = (
    <RowText
      title={title}
      titleId={`${id}-title`}
      icon={icon}
      badge={badge}
      description={description}
      descriptionId={`${id}-desc`}
      busy={busy && !failed}
      busyLabel={busyLabel}
      failure={failure === undefined ? undefined : failure && (
        <>
          <span id={`${id}-failure`} title={failure.detail}>{failure.message}</span>{" "}
          <button type="button" className="link setting-row-retry" onClick={failure.onRetry}>Try Again</button>
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
    <div className={rowClass("setting-row setting-row-switch setting-row-trailing", { failed: true })}>
      {text}
      <Switch {...control} />
    </div>
  ) : (
    <Switch {...control} className={rowClass("setting-row setting-row-switch setting-row-trailing")}>
      {text}
      {saved && <SavedCheck />}
    </Switch>
  );
  if (saved === undefined && failure === undefined) return row;
  return (
    <div
      className="setting-row-frame"
      id={anchorId}
      onFocus={() => { focusInside.current = true; }}
      onBlur={(event) => {
        // A removed element blurs with no next target: that is the drop this row repairs.
        if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
      }}
    >
      {row}
      <span className="sr-only" role="status">{rowStatus(title, saved, failure)}</span>
    </div>
  );
}

/**
 * A group of settings (§5.1, §8.2), for Settings and any other screen: a dialog, a detail pane.
 *
 * - The head: a title in `--type-section`, written in Title Case (never `text-transform`); an
 *   optional scope label as §11.3 meta ("This Device", "Your Account", "This Window", "This
 *   Machine"); and at most one head action. A Settings section with one group leaves out its title:
 *   the section's own heading already names it (#3019).
 * - An optional one-sentence description (`intro`).
 * - One `.surface` holding the rows, hairlines between them. It is the size container for the 560px
 *   rule, so the rows answer to the group's width rather than the viewport's.
 * - An optional foot line, or a disclosure (§5.5) holding what the rows leave out.
 *
 * `failure` is for an instant save that is not a switch (a switch fails in place): a compact danger
 * notice above the surface, with Retry. `notice` is any other compact notice about the whole group,
 * in the same place, such as a capability the group's settings are waiting for.
 */
export function SettingsGroup({
  title,
  scope,
  action,
  intro,
  foot,
  notice,
  failure,
  className,
  headingRef,
  children,
}: {
  title?: string;
  /** For a caller that moves focus to the group: the title becomes a programmatic focus target. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Who or what the group's settings apply to, in Title Case. */
  scope?: string;
  /** One `.btn.sm` (or `.btn.sm.ghost`) for the whole group, such as Reset to Default. */
  action?: ReactNode;
  /** One sentence in sentence case, between the head and the surface. */
  intro?: ReactNode;
  /** One line under the surface, or a disclosure with the rest of what the group needs to say. */
  foot?: ReactNode;
  /** A compact `Notice` (§13.2) between the description and the surface. */
  notice?: ReactNode;
  failure?: RowFailure | null;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const titleId = `${id}-title`;
  return (
    <section className={`settings-group${className ? ` ${className}` : ""}`} aria-labelledby={title ? titleId : undefined}>
      {(title || scope || action) && (
        <div className="settings-group-head">
          {title && (
            <h3 ref={headingRef} className="settings-group-title" id={titleId} tabIndex={headingRef ? -1 : undefined}>{title}</h3>
          )}
          {scope && <span className="settings-group-scope">{scope}</span>}
          {action && <span className="settings-group-action">{action}</span>}
        </div>
      )}
      {intro && <p className="settings-group-desc">{intro}</p>}
      {notice}
      {failure && (
        <Notice
          tone="danger"
          compact
          role="alert"
          actions={<button type="button" className="btn sm" onClick={failure.onRetry}>Retry</button>}
        >
          <span title={failure.detail}>{failure.message}</span>
        </Notice>
      )}
      <div className="settings-group-surface surface">{children}</div>
      {/* A block, not a paragraph, so the foot can be a disclosure (§5.5) as well as a line. */}
      {foot && <div className="settings-group-foot">{foot}</div>}
    </section>
  );
}
