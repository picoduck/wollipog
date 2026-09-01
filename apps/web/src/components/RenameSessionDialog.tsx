import { useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Modal } from "./common.js";

/**
 * The one rename workflow, shared by the session header's ⋯ menu and the row/card context
 * menus (#154): validation, the 120-character ceiling, and the whitespace collapse live here
 * once, so the surfaces cannot drift on what a legal session name is.
 */
export function RenameSessionDialog({
  session,
  onClose,
  onRenamed,
  returnFocusRef,
}: {
  session: Pick<SessionView, "id" | "title">;
  onClose: () => void;
  onRenamed?: (updated: SessionView) => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const [draft, setDraft] = useState(session.title);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const close = () => {
    if (submittingRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (submittingRef.current) return;
    const normalized = draft.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setError("Enter a session name.");
      return;
    }
    if (normalized.length > 120) {
      setError("Session names must be 120 characters or fewer.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await api.renameSession(session.id, normalized);
      onClose();
      onRenamed?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Rename Session"
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          <button className="btn ghost" type="button" onClick={close} disabled={submitting}>Cancel</button>
          <button className="btn primary" type="submit" form="rename-session-form" disabled={submitting}>
            {submitting ? "Saving…" : "Save"}
          </button>
        </>
      )}
    >
      <form
        id="rename-session-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field-label" htmlFor="rename-session-title">Session Name</label>
        <input
          id="rename-session-title"
          className="input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={120}
          autoFocus
          disabled={submitting}
        />
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
