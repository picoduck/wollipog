import { ErrorIcon } from "./Icons.js";

/**
 * The editor save bar (docs/design-system.md §8.6): sticky at the bottom of a multi-field editor,
 * shown only while there is something to save or a save failed. A failed save turns it into a
 * danger bar whose primary action is Try Again; the typed values stay in the editor.
 */
export function SaveBar({
  dirty,
  busy = false,
  error = null,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  busy?: boolean;
  /** One sentence for people; the raw failure belongs behind Show Details in the editor. */
  error?: string | null;
  onDiscard: () => void;
  onSave: () => void;
}) {
  if (!dirty && !error) return null;
  return (
    <div className={`save-bar${error ? " is-error" : ""}`} role={error ? "alert" : undefined}>
      {error && <ErrorIcon className="save-bar-icon" size={16} aria-hidden="true" />}
      <span className="save-bar-message">{error ?? "Unsaved changes"}</span>
      <button type="button" className="btn ghost" disabled={busy} onClick={onDiscard}>Discard</button>
      <button type="button" className="btn primary" disabled={busy} onClick={onSave}>
        {busy ? "Saving…" : error ? "Try Again" : "Save"}
      </button>
    </div>
  );
}
