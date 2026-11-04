import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
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
  accessScopeImpact,
  accessScopeLabel,
  accessScopeSentence,
  canChangeAccessScope,
  resourceOwnerKey,
  scopeAudienceContainedForIdentity,
  type AccessScopeChoice,
} from "../access-scopes.js";
import { Modal, Spinner } from "./common.js";
import { BuildingIcon, LockIcon, TeamIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select } from "./ui/ChoiceControls.js";
import { SettingRow } from "./ui/SettingsRows.js";

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
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [api, enabled]);
  return { identity, error };
}

/** The 16px icon for an access level: a lock for a person, people for a team, a building for the
 * organization (§18). */
export function AccessScopeIcon({ owner }: { owner: ResourceOwner }) {
  return owner.kind === "user" ? <LockIcon /> : owner.kind === "team" ? <TeamIcon /> : <BuildingIcon />;
}

/**
 * The access a new Project or Location starts with (New Project, Add Location): a full-width Select
 * whose options carry who each one reaches. The helper is the caller's own sentence, so it never
 * repeats the chosen option's description.
 */
export function AccessScopeField({
  choices,
  value,
  onChange,
  disabled,
  label = "Access Scope",
  helper,
}: {
  choices: readonly AccessScopeChoice[];
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  label?: string;
  helper?: ReactNode;
}) {
  const helperId = useId();
  return (
    <div className="field">
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
        describedBy={helper ? helperId : undefined}
        disabled={disabled}
        estimatedOptionHeight={52}
      />
      {helper && <p className="field-helper" id={helperId}>{helper}</p>}
    </div>
  );
}

/** A Project's Location, for the Location whose access blocks a Project change. */
export interface AccessScopeLocation {
  runnerId: string;
  workspaceId: string;
  name: string;
  scope?: ResourceScope;
  canManage?: boolean;
}

type ScopeResource =
  | { kind: "project"; projectId: string; name: string; locations?: readonly AccessScopeLocation[] }
  | { kind: "workspace"; runnerId: string; workspaceId: string; name: string };

async function previewChange(api: ApiClient, resource: ScopeResource, owner: ResourceOwner) {
  return resource.kind === "project"
    ? (await api.previewProjectAccessScope(resource.projectId, owner)).preview
    : (await api.previewWorkspaceAccessScope(resource.runnerId, resource.workspaceId, owner)).preview;
}

/** The saved access and every access this person may change it to. */
function changeableChoices(identity: IdentityAdministrationView, scope: ResourceScope): AccessScopeChoice[] {
  const currentKey = resourceOwnerKey(scope.owner);
  return accessScopeChoices(identity, scope).filter((choice) =>
    choice.key === currentKey || canChangeAccessScope(identity, scope, choice.owner));
}

/** Whether Change Access would offer anything besides the saved access. */
export function hasOtherAccessChoice(identity: IdentityAdministrationView, scope: ResourceScope): boolean {
  return changeableChoices(identity, scope).length > 1;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Change Project Access and Change Location Access (§7, #2960). The choice is made here, beside its
 * impact: picking another access runs the server's preview, which words the change by who loses or
 * gains access, and Change Access applies it with the preview's confirmation token. `initialOwner`
 * opens it with that choice already picked, as an access correction does.
 */
export function AccessScopeChangeDialog({
  resource,
  scope,
  initialOwner,
  identity,
  onClose,
  onUpdated,
}: {
  resource: ScopeResource;
  /** The saved access. */
  scope: ResourceScope;
  initialOwner?: ResourceOwner;
  identity: IdentityAdministrationView;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const api = useApi();
  const choices = useMemo(() => changeableChoices(identity, scope), [identity, scope]);
  const currentKey = resourceOwnerKey(scope.owner);
  const [selectedKey, setSelectedKey] = useState(() => {
    const key = initialOwner ? resourceOwnerKey(initialOwner) : currentKey;
    return choices.some((choice) => choice.key === key) ? key : currentKey;
  });
  const selected = choices.find((choice) => choice.key === selectedKey);
  const changing = selected !== undefined && selectedKey !== currentKey;
  // Each result is kept with the choice it answers, so a slow preview for an earlier choice is
  // never shown, or applied, as the impact of the current one.
  const [preview, setPreview] = useState<{ key: string; value: AccessScopeChangePreview } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [locationChange, setLocationChange] = useState<{ location: AccessScopeLocation; scope: ResourceScope } | null>(null);
  const resourceKey = resource.kind === "project"
    ? `project:${resource.projectId}:${resource.name}`
    : `workspace:${resource.runnerId}:${resource.workspaceId}:${resource.name}`;
  // Keyed by strings, not objects: a refreshed Project hands over equal scopes as new objects, which
  // must not ask for the same preview again.
  useEffect(() => {
    if (!changing) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    void previewChange(api, resource, selected.owner).then((value) => {
      if (current) setPreview({ key: selectedKey, value });
    }).catch((cause) => {
      if (current) setPreviewError({ key: selectedKey, message: errorMessage(cause) });
    });
    return () => { current = false; };
  }, [api, resourceKey, selectedKey, changing, previewAttempt]);

  const loaded = changing && preview?.key === selectedKey ? preview.value : null;
  const failed = changing && previewError?.key === selectedKey ? previewError.message : null;
  const checking = changing && !loaded && !failed;
  const impact = loaded ? accessScopeImpact(loaded, identity) : null;
  const canApply = Boolean(loaded?.compatible && loaded.confirmationToken);
  const choose = (key: string) => {
    if (busy) return;
    setSelectedKey(key);
    setApplyError(null);
  };
  const apply = async () => {
    if (!selected || !loaded?.compatible || !loaded.confirmationToken || busy) return;
    setBusy(true);
    setApplyError(null);
    try {
      if (resource.kind === "project") {
        await api.updateProjectAccessScope(resource.projectId, selected.owner, loaded.confirmationToken);
      } else {
        await api.updateWorkspaceAccessScope(resource.runnerId, resource.workspaceId, selected.owner, loaded.confirmationToken);
      }
      onUpdated();
      onClose();
    } catch (cause) {
      setApplyError(errorMessage(cause));
      // The token is bound to what the server inspected; ask for a fresh preview before another try.
      setPreviewAttempt((attempt) => attempt + 1);
    } finally {
      setBusy(false);
    }
  };

  // The Location whose narrower access blocks a Project change, when this person may widen it.
  const blockingLocation = (() => {
    if (impact?.kind !== "incompatible" || !impact.blockedByLocation || resource.kind !== "project" || !selected) return null;
    const target: ResourceScope = { organizationId: identity.context.organizationId, owner: selected.owner };
    const location = resource.locations?.find((entry) =>
      entry.scope && !scopeAudienceContainedForIdentity(identity, target, entry.scope));
    if (!location?.scope || location.canManage === false ||
        !canChangeAccessScope(identity, location.scope, selected.owner)) return null;
    return { location, scope: location.scope };
  })();

  const announcement = checking ? "Checking which sessions this affects…"
    : impact?.kind === "narrowing" ? impact.title
      : impact?.kind === "broadening" ? impact.text
        : impact?.kind === "incompatible" ? `Can't change access. ${impact.message}` : "";

  return (
    <Modal
      title={resource.kind === "project" ? "Change Project Access" : "Change Location Access"}
      description={resource.name}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          {!changing && <span className="access-change-reason">Choose a different access level.</span>}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton
            className="btn primary"
            busy={busy}
            progress="Changing access…"
            disabled={!canApply}
            onClick={() => void apply()}
          >
            Change Access
          </BusyButton>
        </>
      )}
    >
      <ChoiceRows
        label="Access"
        options={choices.map((choice) => ({
          value: choice.key,
          title: choice.label,
          description: choice.description,
          icon: <AccessScopeIcon owner={choice.owner} />,
          status: choice.key === currentKey ? <StatusBadge tone="neutral" noDot label="Current" /> : undefined,
        }))}
        value={selectedKey}
        onChange={choose}
      />
      <span className="sr-only" role="status">{announcement}</span>
      {checking && (
        <p className="access-change-checking"><Spinner decorative />Checking which sessions this affects…</p>
      )}
      {impact?.kind === "narrowing" && <Notice tone="warning" title={impact.title}>{impact.body}</Notice>}
      {impact?.kind === "broadening" && <p className="access-change-sentence">{impact.text}</p>}
      {impact?.kind === "incompatible" && (
        <Notice
          tone="danger"
          title="Can't Change Access"
          actions={blockingLocation && (
            <button type="button" className="btn sm" onClick={() => setLocationChange(blockingLocation)}>
              Change Location Access…
            </button>
          )}
        >
          {impact.message}
        </Notice>
      )}
      {failed && (
        <Notice
          tone="danger"
          role="alert"
          title="Couldn't Check This Change"
          actions={<button type="button" className="btn sm" onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>Try Again</button>}
          details={failed}
        >
          Change Access stays off until the check succeeds.
        </Notice>
      )}
      {applyError && (
        <Notice tone="danger" role="alert" title="Couldn't Change Access" details={applyError}>
          Check the impact again, then try once more.
        </Notice>
      )}
      {locationChange && selected && (
        <AccessScopeChangeDialog
          resource={{
            kind: "workspace",
            runnerId: locationChange.location.runnerId,
            workspaceId: locationChange.location.workspaceId,
            name: locationChange.location.name,
          }}
          scope={locationChange.scope}
          initialOwner={selected.owner}
          identity={identity}
          onClose={() => setLocationChange(null)}
          onUpdated={() => {
            onUpdated();
            setPreviewAttempt((attempt) => attempt + 1);
          }}
        />
      )}
    </Modal>
  );
}

/**
 * The saved access as a readout (§8.2): its icon, its label and who it reaches, with Change… in the
 * control column. The new access is chosen inside Change Access, beside its impact, so nothing here
 * ever shows an access that is not saved. A Viewer, or anyone who can't change the resource
 * (`readOnly`), sees the readout alone. It is one row of the caller's settings surface (#2962).
 */
export function AccessScopeSettings({
  resource,
  scope,
  identity,
  disabled,
  readOnly: resourceReadOnly,
  onUpdated,
}: {
  resource: ScopeResource;
  scope: ResourceScope;
  identity: IdentityAdministrationView | null;
  disabled?: boolean;
  readOnly?: boolean;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ids = useId();
  const titleId = `${ids}-title`;
  const descriptionId = `${ids}-desc`;
  const buttonId = `${ids}-change`;
  const canChange = useMemo(() => identity ? hasOtherAccessChoice(identity, scope) : false, [identity, scope]);
  if (!identity) return <SettingRow title="Access" busy busyLabel="Loading access…" />;
  const readOnly = resourceReadOnly || identity.context.role === "viewer";
  return (
    <>
      <SettingRow
        trailing
        title={accessScopeLabel(scope, identity)}
        titleId={titleId}
        icon={<AccessScopeIcon owner={scope.owner} />}
        description={accessScopeSentence(scope, identity)}
        descriptionId={descriptionId}
        control={!readOnly && (
          <button
            id={buttonId}
            type="button"
            className="btn sm"
            disabled={disabled || !canChange}
            aria-haspopup="dialog"
            aria-labelledby={`${buttonId} ${titleId}`}
            aria-describedby={descriptionId}
            onClick={() => setOpen(true)}
          >
            Change…
          </button>
        )}
      />
      {open && (
        <AccessScopeChangeDialog
          resource={resource}
          scope={scope}
          identity={identity}
          onClose={() => setOpen(false)}
          onUpdated={onUpdated}
        />
      )}
    </>
  );
}
