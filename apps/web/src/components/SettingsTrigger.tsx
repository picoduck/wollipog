import { useId } from "react";
import { shortcutDisplay } from "../shortcuts.js";
import { GearIcon } from "./Icons.js";

/** A routed destination shared by the responsive rail/header layouts, never a dialog trigger. */
export function SettingsTrigger({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const descriptionId = useId();
  const binding = shortcutDisplay("open-settings");
  return (
    <div className="settings-control">
      <button
        type="button"
        className="settings-trigger"
        title={`Settings (${binding})`}
        aria-label="Settings"
        aria-describedby={descriptionId}
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
      >
        <GearIcon size={14} />
      </button>
      <span id={descriptionId} className="sr-only">Open Settings. Keyboard shortcut: {binding}</span>
    </div>
  );
}
