import { useRef, useState } from "react";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

const FORM_ID = "rename-location-form";
const FIELD_ID = "rename-location-name";
const HELPER_ID = "rename-location-name-helper";
const ERROR_ID = "rename-location-name-error";

/** A location name as the server stores it: trimmed, with runs of whitespace collapsed. */
export function normalizeLocationName(draft: string): string {
  return draft.trim().replace(/\s+/g, " ");
}

/** Why a draft is not a legal location name, or null when it is. */
export function locationNameError(draft: string): string | null {
  const name = normalizeLocationName(draft);
  if (!name) return "Enter a location name.";
  if (name.length > 120) return "Location names must be 120 characters or fewer.";
  return null;
}

/**
 * Rename Location… (#4151): one Location Name field, starting with the location's current name. The
 * name is the location's label in this project only; the folder, the machine and other projects
 * keep theirs. An invalid name is shown on the field (§8.5); a request that fails is a danger notice
 * above the footer and keeps the name as typed, so Save can be pressed again. An unchanged name
 * closes without a request.
 */
export function RenameLocationDialog({ currentName, rename, onClose }: {
  currentName: string;
  rename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(currentName);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  const close = () => {
    if (savingRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (savingRef.current) return;
    const problem = locationNameError(draft);
    setError(problem);
    setEdited(true);
    if (problem) {
      fieldRef.current?.focus();
      return;
    }
    const name = normalizeLocationName(draft);
    if (name === currentName) {
      onClose();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await rename(name);
      savingRef.current = false;
      onClose();
    } catch (cause) {
      savingRef.current = false;
      setFailure((cause as Error).message);
      fieldRef.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Rename Location"
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={saving}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={FORM_ID} busy={saving}
            progress="Saving the location name…">
            Save
          </BusyButton>
        </>
      )}
    >
      <form
        id={FORM_ID}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <div className="field-head"><label htmlFor={FIELD_ID}>Location Name</label></div>
          <input
            ref={fieldRef}
            id={FIELD_ID}
            autoFocus
            autoComplete="off"
            value={draft}
            maxLength={120}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ERROR_ID : HELPER_ID}
            // Read-only rather than disabled while saving, so a field submitted with Enter keeps focus.
            readOnly={saving}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setEdited(true);
              // An error showing clears as soon as the value is valid (§8.5).
              if (error) setError(locationNameError(next));
            }}
            onBlur={() => { if (edited && !savingRef.current) setError(locationNameError(draft)); }}
          />
          {error
            ? <FieldError id={ERROR_ID}>{error}</FieldError>
            : (
              <p className="field-helper" id={HELPER_ID}>
                The name this project shows for the location. The folder and other projects keep theirs.
              </p>
            )}
        </div>
        {failure && <Notice tone="danger" role="alert" title="Couldn't Rename the Location">{failure}</Notice>}
      </form>
    </Modal>
  );
}
