import { useMemo, useRef, useState } from "react";
import { schedulePreview, scheduleExamples, timeZoneChoices } from "../automation-form.js";
import { useTimelineClock } from "../timeline-clock.js";
import { FieldError } from "./FieldError.js";
import { ChevronDownIcon, ScheduleIcon } from "./Icons.js";
import { InfoPopover } from "./InfoPopover.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { useAccessibleMenu } from "./interactions.js";
import { SearchableCombobox } from "./ui/ChoiceControls.js";

/** The About Time Zones popover's words (#2971): the daylight-saving rules the scheduler follows. */
export const TIME_ZONE_RULES =
  "When clocks skip forward, a time that doesn't exist is skipped. When they fall back, a repeated time runs once.";

export const SCHEDULE_HELPER = "Minute, hour, day of month, month, weekday.";

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** The Schedule field's Examples menu button (§9.1): choosing an item fills the field. */
function ScheduleExamplesMenu({ onChoose }: { onChoose: (cron: string) => void }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "schedule-examples");
  const examples = useMemo(() => scheduleExamples(), []);
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn automation-cron-examples"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        Examples
        <ChevronDownIcon size={14} aria-hidden="true" />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Schedule Examples"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {examples.map((example) => (
            <MenuItem
              key={example.cron}
              description={<span className="automation-example-cron">{example.cron}</span>}
              onClick={() => {
                menu.close(false);
                onChoose(example.cron);
              }}
            >
              {example.label}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/**
 * The When to Run fields (#2971; docs/design-system.md §8.1, §8.4, §8.5, §9.1, §9.2): Schedule, a
 * monospace cron field with an Examples menu and a polite preview line in words under it, and Time
 * Zone, a searchable list of the browser's zones with the daylight-saving rules behind About Time
 * Zones. The editor owns the values and when an error shows; the preview is hidden while the
 * expression is invalid.
 */
export function AutomationScheduleFields({
  idPrefix,
  cron,
  timezone,
  enabled,
  cronError,
  timezoneError,
  onCronChange,
  onCronBlur,
  onTimezoneChange,
}: {
  /** A unique prefix for the fields' ids. */
  idPrefix: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** The Schedule field's error (§8.5), shown in its helper's place. */
  cronError: string | null;
  timezoneError: string | null;
  onCronChange: (cron: string) => void;
  /** The Schedule field lost focus after the person edited it. */
  onCronBlur: () => void;
  onTimezoneChange: (timezone: string) => void;
}) {
  const now = useTimelineClock(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const edited = useRef(false);
  const preview = schedulePreview(cron, { timezone, enabled, now, viewerTimeZone: viewerTimeZone() });
  // The browser's list is built once (about 400 zones, each formatted for its offset); only a stored
  // zone it does not list builds another, with that zone joined to it.
  const [listed] = useState(() => timeZoneChoices("", Date.now()));
  const zones = useMemo(() => listed.some((choice) => choice.value === timezone)
    ? listed : timeZoneChoices(timezone, Date.now()), [listed, timezone]);
  const ids = {
    cron: `${idPrefix}-cron`,
    cronHelp: `${idPrefix}-cron-help`,
    cronError: `${idPrefix}-cron-error`,
    preview: `${idPrefix}-cron-preview`,
    timezone: `${idPrefix}-timezone`,
    timezoneError: `${idPrefix}-timezone-error`,
  };
  const shownPreview = cronError ? null : preview;
  const cronDescribedBy = [cronError ? ids.cronError : ids.cronHelp, shownPreview ? ids.preview : null]
    .filter(Boolean).join(" ");
  return (
    <div className="field-row">
      <div className="field">
        <span><label htmlFor={ids.cron}>Schedule</label></span>
        <div className="automation-cron-control">
          <input
            ref={inputRef}
            id={ids.cron}
            className="automation-cron-input"
            value={cron}
            maxLength={128}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-invalid={cronError ? true : undefined}
            aria-describedby={cronDescribedBy}
            onChange={(event) => {
              edited.current = true;
              onCronChange(event.target.value);
            }}
            onBlur={() => {
              if (!edited.current) return;
              edited.current = false;
              onCronBlur();
            }}
          />
          <ScheduleExamplesMenu onChoose={(value) => {
            edited.current = false;
            onCronChange(value);
            inputRef.current?.focus();
          }} />
        </div>
        {cronError
          ? <FieldError id={ids.cronError}>{cronError}</FieldError>
          : <p className="field-helper" id={ids.cronHelp}>{SCHEDULE_HELPER}</p>}
        <p className="automation-schedule-preview" id={ids.preview} aria-live="polite">
          {shownPreview && <><ScheduleIcon size={14} aria-hidden="true" /><span>{shownPreview}</span></>}
        </p>
      </div>
      <div className="field">
        <span className="automation-zone-label">
          <label htmlFor={ids.timezone}>Time Zone</label>
          <InfoPopover tool="Time Zones" size="sm">{TIME_ZONE_RULES}</InfoPopover>
        </span>
        <SearchableCombobox<string>
          inputId={ids.timezone}
          label="Time Zone"
          options={zones}
          value={timezone}
          onChange={onTimezoneChange}
          placeholder="Search time zones"
          noun="time zones"
          invalid={Boolean(timezoneError)}
          describedBy={timezoneError ? ids.timezoneError : undefined}
        />
        {timezoneError && <FieldError id={ids.timezoneError}>{timezoneError}</FieldError>}
      </div>
    </div>
  );
}
