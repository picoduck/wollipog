import { useId } from "react";
import { ErrorIcon } from "./Icons.js";
import { BusyButton } from "./ui/BusyButton.js";

/**
 * The editor save bar (docs/design-system.md §8.6): sticky at the bottom of a multi-field editor,
 * shown only while there is something to save or a save failed, or from the start for a new record
 * (`alwaysShown`). A failed save turns it into a danger bar whose primary action is Try Again; the
 * typed values stay in the editor.
 *
 * Save is a `BusyButton` (§3.1): busy, it keeps its label and width beside a spinner and Discard is
 * disabled. A `blockedReason` refuses Save and says why in the message's place; Save stays focusable
 * (`aria-disabled`) and is described by the reason, so a press that the editor answers by blocking
 * does not drop focus.
 */
export function SaveBar({
  dirty,
  busy = false,
  error = null,
  saveLabel = "Save",
  discardLabel = "Discard",
  alwaysShown = false,
  blockedReason = null,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  busy?: boolean;
  /** One sentence for people; the raw failure belongs behind Show Details in the editor. */
  error?: string | null;
  /** Title Case: "Save Changes", "Create Automation", "Save Defaults". Try Again replaces it after a failure. */
  saveLabel?: string;
  /** Title Case; a new record passes "Cancel". */
  discardLabel?: string;
  /** Render while clean, for a new record whose create action is visible from the start. Save stays
   * enabled, so submitting an empty form runs the editor's validation. */
  alwaysShown?: boolean;
  /** One sentence that refuses Save until the draft is fixed: "Fix 1 setting to save". It takes the
   * message's place, ahead of a failure from an earlier draft. */
  blockedReason?: string | null;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const messageId = useId();
  if (!alwaysShown && !dirty && !error) return null;
  const blocked = Boolean(blockedReason);
  const failed = Boolean(error) && !blocked;
  const message = blocked ? blockedReason : failed ? error : dirty ? "Unsaved changes" : null;
  return (
    <div className={`save-bar${failed ? " is-error" : ""}`} role={failed ? "alert" : undefined}>
      {failed && <ErrorIcon className="save-bar-icon" size={16} aria-hidden="true" />}
      <span className="save-bar-message" id={messageId}>{message}</span>
      <button type="button" className="btn ghost" disabled={busy} onClick={onDiscard}>{discardLabel}</button>
      <BusyButton
        className="btn primary"
        busy={busy}
        progress="Saving changes…"
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? messageId : undefined}
        onClick={blocked ? undefined : onSave}
      >
        {failed ? "Try Again" : saveLabel}
      </BusyButton>
    </div>
  );
}
