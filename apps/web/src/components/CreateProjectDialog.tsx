import { useState, type FormEvent } from "react";
import type { ProjectView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Modal } from "./common.js";

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!busy) onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({ name: name.trim() });
      onCreated(project);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create Project"
      onClose={close}
      describedBy="create-project-description"
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" form="create-project-form" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create Project"}
          </button>
        </>
      )}
    >
      <form id="create-project-form" className="form" onSubmit={(event) => void submit(event)}>
        <p id="create-project-description" className="muted">
          A Project is a durable home for related sessions. Admins create organization-visible Projects; members create Projects visible only to themselves. You can add Locations after creating it.
        </p>
        <label className="field">
          <span>Project Name</span>
          <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
