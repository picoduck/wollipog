import React, { useId } from "react";
import { shortcutDisplay } from "../shortcuts.js";
import { SettingsIcon } from "./Icons.js";
import { RAIL_ICON_SIZE } from "./Rail.js";

/**
 * The desktop rail's Settings item: a routed destination, never a dialog trigger. It is a
 * `.rail-item` like every destination, so it has the same rest, hover, focus and current-page
 * treatment and the same tooltip (§4.1).
 */
export function SettingsTrigger({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const descriptionId = useId();
  const binding = shortcutDisplay("open-settings");
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
      </button>
      <span id={descriptionId} className="sr-only">Open Settings. Keyboard shortcut: {binding}</span>
    </>
  );
}
