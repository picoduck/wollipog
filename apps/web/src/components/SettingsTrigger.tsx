import React, { useId } from "react";
import { shortcutDisplay } from "../shortcuts.js";
import { useRailPreferences } from "../use-rail-preferences.js";
import { SettingsIcon } from "./Icons.js";
import { RAIL_DISABLED_NOTE, RAIL_ICON_SIZE, RailItemText } from "./Rail.js";

/**
 * The desktop rail's Settings item: a routed destination, never a dialog trigger. It is a
 * `.rail-item` like every destination, so it has the same rest, hover, focus and current-page
 * treatment and the same tooltip (§4.1), and its name in the labelled rail (#1968). The shell
 * renders it on desktop only, so the stored preference alone decides the labels here.
 *
 * `disabled` is the rail's own disabled form (#3004): `aria-disabled`, faint ink, the tooltip's
 * `RAIL_DISABLED_NOTE`, in the 64px rail, and it opens nothing.
 */
export function SettingsTrigger({ active, onOpen, disabled = false }: {
  active: boolean;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const descriptionId = useId();
  const binding = shortcutDisplay("open-settings");
  const { labels } = useRailPreferences();
  if (disabled) {
    return (
      <>
        <button
          type="button"
          className="rail-item"
          aria-label="Settings"
          aria-describedby={descriptionId}
          aria-disabled="true"
          data-rail-tip="Settings"
          data-rail-note={RAIL_DISABLED_NOTE}
        >
          <SettingsIcon size={RAIL_ICON_SIZE} />
        </button>
        <span id={descriptionId} className="sr-only">{RAIL_DISABLED_NOTE}</span>
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`rail-item${active ? " active" : ""}`}
        aria-label="Settings"
        aria-describedby={descriptionId}
        aria-current={active ? "page" : undefined}
        data-rail-tip="Settings"
        data-rail-keys={binding}
        onClick={onOpen}
      >
        <SettingsIcon size={RAIL_ICON_SIZE} />
        <RailItemText labelled={labels} name="Settings" keys={binding} />
      </button>
      <span id={descriptionId} className="sr-only">Open Settings. Keyboard shortcut: {binding}</span>
    </>
  );
}
