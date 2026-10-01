import { useEffect, useRef, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { sessionDisplayTitle } from "../session-title.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

const FIELD_ID = "rename-session-title";
const HELPER_ID = "rename-session-title-helper";
const ERROR_ID = "rename-session-title-error";

/** Why a draft is not a legal session name, or null when it is. */
function sessionNameError(draft: string): string | null {
  const normalized = draft.trim().replace(/\s+/g, " ");
  if (!normalized) return "Enter a session name.";
  if (normalized.length > 120) return "Session names must be 120 characters or fewer.";
  return null;
}

/**
 * The one rename workflow, shared by the session header's ⋯ menu and the row/card context
 * menus (#154): validation, the 120-character ceiling, and the whitespace collapse live here
 * once, so the surfaces cannot drift on what a legal session name is.
 *
 * One `.field` (docs/design-system.md §8.1, §8.5): an invalid name is shown on the field itself,
 * as the error that replaces its helper, and the primary stays enabled so submitting re-validates.
 * A request that fails is a danger notice above the footer, since the name itself was valid.
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
  // A generated title can run to several lines; the field starts with the name the session shows.
  const [draft, setDraft] = useState(() => sessionDisplayTitle(session.title));
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  // Focus the name with the caret at its start, so the beginning of a long title is what shows.
  // This runs after Modal's own opening focus, which is a child effect.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(0, 0);
    field.scrollLeft = 0;
  }, []);

  const close = () => {
    if (submittingRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (submittingRef.current) return;
    const problem = sessionNameError(draft);
    setError(problem);
    setEdited(true);
    if (problem) {
      fieldRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const updated = await api.renameSession(session.id, draft.trim().replace(/\s+/g, " "));
      onClose();
      onRenamed?.(updated);
    } catch (cause) {
      setFailure((cause as Error).message);
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
          <button className="btn" type="button" onClick={close} disabled={submitting}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form="rename-session-form" busy={submitting}
            progress="Renaming the session…">
            Rename Session
          </BusyButton>
        </>
      )}
    >
      <form
        id="rename-session-form"
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <div className="field-head"><label htmlFor={FIELD_ID}>Session Name</label></div>
          <input
            ref={fieldRef}
            id={FIELD_ID}
            value={draft}
            maxLength={120}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ERROR_ID : HELPER_ID}
            // Read-only rather than disabled while saving, so a field submitted with Enter keeps focus.
            readOnly={submitting}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setEdited(true);
              // An error showing clears as soon as the value is valid (§8.5).
              if (error) setError(sessionNameError(next));
            }}
            onBlur={() => { if (edited && !submittingRef.current) setError(sessionNameError(draft)); }}
          />
          {error
            ? <FieldError id={ERROR_ID}>{error}</FieldError>
            : <p className="field-helper" id={HELPER_ID}>Shown in the session list and at the top of this page.</p>}
        </div>
        {failure && <Notice tone="danger" role="alert" title="Couldn't Rename the Session">{failure}</Notice>}
      </form>
    </Modal>
  );
}
