import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ProjectView } from "@wollipog/protocol";
import { accessScopeChoices } from "../access-scopes.js";
import { useApi } from "../api-context.js";
import { AccessScopeField, useAccessScopeIdentity } from "./AccessScopeControls.js";
import { Modal } from "./common.js";

export function CreateProjectDialog({
  onClose,
  onCreated,
  accessScopeManagementSupported,
}: {
  onClose: () => void;
  onCreated: (project: ProjectView) => void;
  accessScopeManagementSupported: boolean;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeKey, setScopeKey] = useState("");
  const { identity, error: identityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const scopeChoices = useMemo(() => identity ? accessScopeChoices(identity) : [], [identity]);
  useEffect(() => {
    if (!identity || scopeKey) return;
    const defaultKey = identity.context.role === "owner" || identity.context.role === "admin"
      ? `organization:${identity.context.organizationId}`
      : `user:${identity.context.userId}`;
    setScopeKey(scopeChoices.some((choice) => choice.key === defaultKey)
      ? defaultKey : scopeChoices[0]?.key ?? "");
  }, [identity, scopeChoices, scopeKey]);
  const close = () => {
    if (!busy) onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const selectedScope = scopeChoices.find((choice) => choice.key === scopeKey);
    if (busy || !name.trim() || (accessScopeManagementSupported && !selectedScope)) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({
        name: name.trim(),
        ...(selectedScope ? { owner: selectedScope.owner } : {}),
      });
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
          <button
            type="submit"
            className="btn primary"
            form="create-project-form"
            disabled={busy || !name.trim() || (accessScopeManagementSupported &&
              !scopeChoices.some((choice) => choice.key === scopeKey))}
          >
            {busy ? "Creating…" : "Create Project"}
          </button>
        </>
      )}
    >
      <form id="create-project-form" className="form" onSubmit={(event) => void submit(event)}>
        <p id="create-project-description" className="muted">
          A Project is a durable home for related sessions. Choose who can discover and manage it; Locations must use the same or broader access. You can add Locations after creating it.
        </p>
        <label className="field">
          <span>Project Name</span>
          <input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        {accessScopeManagementSupported && scopeChoices.length > 0 && (
          <AccessScopeField choices={scopeChoices} value={scopeKey} onChange={setScopeKey} disabled={busy} />
        )}
        {accessScopeManagementSupported && !identity && !identityError && (
          <span className="muted">Loading permitted access scopes…</span>
        )}
        {accessScopeManagementSupported && identity?.context.role === "viewer" && (
          <span className="muted">Your Viewer role cannot create Projects.</span>
        )}
        {identityError && <div className="form-error" role="alert">Access scopes could not be loaded: {identityError}</div>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
    </Modal>
  );
}
