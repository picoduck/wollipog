import { useEffect, useId, useMemo, useState } from "react";
import type {
  AccessScopeChangePreview,
  IdentityAdministrationView,
  ResourceOwner,
  ResourceScope,
} from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { useApi } from "../api-context.js";
import {
  accessScopeChoices,
  accessScopeLabel,
  resourceOwnerKey,
  sameResourceScope,
  type AccessScopeChoice,
} from "../access-scopes.js";
import { Modal } from "./common.js";
import { Select } from "./ui/ChoiceControls.js";

export function useAccessScopeIdentity(enabled: boolean) {
  const api = useApi();
  const [identity, setIdentity] = useState<IdentityAdministrationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void api.getIdentity().then((value) => {
      if (current) setIdentity(value);
    }).catch((cause) => {
      if (current) setError((cause as Error).message);
    });
    return () => { current = false; };
  }, [api, enabled]);
  return { identity, error };
}

export function AccessScopeField({
  choices,
  value,
  onChange,
  disabled,
  label = "Access Scope",
}: {
  choices: readonly AccessScopeChoice[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const selected = choices.find((choice) => choice.key === value);
  const descriptionId = useId();
  return (
    <div className="field access-scope-field">
      <span>{label}</span>
      <Select
        options={choices.map((choice) => ({
          value: choice.key,
          label: choice.label,
          description: choice.description,
        }))}
        value={value}
        onChange={onChange}
        label={label}
        describedBy={selected ? descriptionId : undefined}
        disabled={disabled}
        estimatedOptionHeight={52}
      />
      {selected && <small id={descriptionId}>{selected.description}</small>}
    </div>
  );
}

type ScopeResource =
  | { kind: "project"; projectId: string; name: string }
  | { kind: "workspace"; runnerId: string; workspaceId: string; name: string };

async function previewChange(api: ApiClient, resource: ScopeResource, owner: ResourceOwner) {
  return resource.kind === "project"
    ? (await api.previewProjectAccessScope(resource.projectId, owner)).preview
    : (await api.previewWorkspaceAccessScope(resource.runnerId, resource.workspaceId, owner)).preview;
}

export function AccessScopeChangeDialog({
  resource,
  owner,
  identity,
  onClose,
  onUpdated,
}: {
  resource: ScopeResource;
  owner: ResourceOwner;
  identity: IdentityAdministrationView;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<AccessScopeChangePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resourceKey = resource.kind === "project"
    ? `project:${resource.projectId}:${resource.name}`
    : `workspace:${resource.runnerId}:${resource.workspaceId}:${resource.name}`;
  const ownerKey = resourceOwnerKey(owner);
  useEffect(() => {
    let current = true;
    setError(null);
    void previewChange(api, resource, owner).then((value) => {
      if (current) setPreview(value);
    }).catch((cause) => {
      if (current) setError((cause as Error).message);
    });
    return () => { current = false; };
  }, [api, ownerKey, resourceKey]);
  const apply = async () => {
    if (!preview?.compatible || !preview.confirmationToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (resource.kind === "project") {
        await api.updateProjectAccessScope(resource.projectId, owner, preview.confirmationToken);
      } else {
        await api.updateWorkspaceAccessScope(resource.runnerId, resource.workspaceId, owner, preview.confirmationToken);
      }
      onUpdated();
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
      setPreview(null);
      try {
        setPreview(await previewChange(api, resource, owner));
      } catch { /* keep the mutation error */ }
    } finally {
      setBusy(false);
    }
  };
  const targetScope: ResourceScope = {
    organizationId: identity.context.organizationId,
    owner,
  };
  return (
    <Modal
      title={resource.kind === "project" ? "Change Project Access" : "Change Location Access"}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !preview?.compatible || !preview.confirmationToken}
            onClick={() => void apply()}
          >
            {busy ? "Applying…" : "Apply Access Change"}
          </button>
        </>
      )}
    >
      <div className="access-scope-preview">
        <p>
          Change <strong>{resource.name}</strong> to <strong>{accessScopeLabel(targetScope, identity)}</strong>?
          Access is never broadened without this explicit confirmation.
        </p>
        {!preview && !error && <p className="muted">Checking every Project, Location, and session relationship…</p>}
        {preview && (
          <>
            <dl>
              <div><dt>Affected Projects</dt><dd>{preview.affectedProjects.length}</dd></div>
              <div><dt>Active Sessions</dt><dd>{preview.activeSessionCount}</dd></div>
              <div><dt>Total Sessions</dt><dd>{preview.totalSessionCount}</dd></div>
              <div><dt>Sessions Narrowed</dt><dd>{preview.sessionsToNarrow}</dd></div>
            </dl>
            {preview.affectedProjects.length > 0 && (
              <p className="muted">Project Memberships: {preview.affectedProjects.map((project) => project.name).join(", ")}</p>
            )}
            {!preview.compatible && <div className="form-error" role="alert">{preview.reason}</div>}
          </>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

export function AccessScopeSettings({
  resource,
  scope,
  identity,
  disabled,
  onUpdated,
}: {
  resource: ScopeResource;
  scope: ResourceScope;
  identity: IdentityAdministrationView | null;
  disabled?: boolean;
  onUpdated: () => void;
}) {
  const choices = useMemo(() => identity ? accessScopeChoices(identity, scope) : [], [identity, scope]);
  const currentKey = resourceOwnerKey(scope.owner);
  const [selectedKey, setSelectedKey] = useState(currentKey);
  const [dialogOwner, setDialogOwner] = useState<ResourceOwner | null>(null);
  useEffect(() => setSelectedKey(currentKey), [currentKey]);
  const selected = choices.find((choice) => choice.key === selectedKey);
  if (!identity) return <span className="muted">Loading access controls…</span>;
  const administers = identity.context.role === "owner" || identity.context.role === "admin";
  return (
    <div className="access-scope-settings">
      <AccessScopeField
        choices={choices}
        value={selectedKey}
        onChange={setSelectedKey}
        disabled={disabled || !administers}
      />
      <button
        type="button"
        className="btn"
        disabled={disabled || !administers || !selected || sameResourceScope(scope, {
          organizationId: identity.context.organizationId,
          owner: selected.owner,
        })}
        onClick={() => selected && setDialogOwner(selected.owner)}
      >
        Review Access Change
      </button>
      {!administers && <span className="muted">Ask an organization owner or admin to change access.</span>}
      {dialogOwner && (
        <AccessScopeChangeDialog
          resource={resource}
          owner={dialogOwner}
          identity={identity}
          onClose={() => setDialogOwner(null)}
          onUpdated={onUpdated}
        />
      )}
    </div>
  );
}
