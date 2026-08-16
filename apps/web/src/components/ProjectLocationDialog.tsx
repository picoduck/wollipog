import { useEffect, useMemo, useState } from "react";
import {
  runnerSupportsProtocol,
  type BoxView,
  type ProjectView,
  type ResourceOwner,
  type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import {
  accessScopeChoices,
  accessScopeLabel,
  canChangeAccessScope,
  resourceOwnerKey,
  scopeAudienceContainedForIdentity,
} from "../access-scopes.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import {
  buildProjectLocationCandidates,
  projectAvailabilityLabel,
  projectLocationMembershipState,
  type ProjectLocationCandidate,
} from "../project-management.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import {
  AccessScopeChangeDialog,
  AccessScopeField,
  useAccessScopeIdentity,
} from "./AccessScopeControls.js";
import { Modal } from "./common.js";

interface NewProjectLocation {
  runnerId: string;
  name: string;
  path: string;
  owner?: ResourceOwner;
}

export function projectLocationCreationError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404 && cause.message.trim().toLocaleLowerCase() === "not found") {
    return "This control plane does not support creating a Location from a new folder. Update or restart the control plane so it matches this dashboard, then try again.";
  }
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "The Location could not be added.";
}

function locationNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).pop() || trimmed || "Root";
}

export function ProjectLocationDialog({
  project,
  projects,
  runners,
  boxes,
  canCreateLocation,
  accessScopeManagementSupported,
  onClose,
  onAdd,
  onCreate,
  onManageConnections,
}: {
  project: ProjectView;
  projects: readonly ProjectView[];
  runners: ReadonlyMap<string, RunnerView>;
  boxes: ReadonlyMap<string, BoxView>;
  canCreateLocation: boolean;
  accessScopeManagementSupported: boolean;
  onClose: () => void;
  onAdd: (candidate: ProjectLocationCandidate) => Promise<void>;
  onCreate: (location: NewProjectLocation) => Promise<void>;
  onManageConnections: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runnerId, setRunnerId] = useState("");
  const [locationName, setLocationName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [folderSelection, setFolderSelection] = useState<{ runnerId: string; path: string } | null>(null);
  const [createExpanded, setCreateExpanded] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [scopeKey, setScopeKey] = useState("");
  const [scopeCorrection, setScopeCorrection] = useState<{
    resource: { kind: "project"; projectId: string; name: string } |
      { kind: "workspace"; runnerId: string; workspaceId: string; name: string };
    owner: ResourceOwner;
  } | null>(null);
  const { identity, error: identityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const close = () => {
    if (!busyKey) onClose();
  };
  const boxByRunner = useMemo(() => new Map([...boxes.values()].map((box) => [box.runnerId, box])), [boxes]);
  const browseMachines = useMemo(() => [...runners.values()]
    .filter((runner) => runner.status === "online" &&
      runnerSupportsProtocol(runner.protocolVersion, "directoryListing"))
    .map((runner) => ({
      runner,
      display: runnerDisplay(runner, boxByRunner.get(runner.runnerId), runner.runnerId),
    }))
    .sort((left, right) =>
      left.display.name.localeCompare(right.display.name) ||
      left.runner.runnerId.localeCompare(right.runner.runnerId)), [boxByRunner, runners]);
  // A Location is one exact (Machine, Workspace) pair, so an ambiguous Machine option here creates
  // the pair against the wrong host and filesystem.
  const machineLabels = useMemo(
    () => machineOptionLabels(browseMachines.map(({ runner }) => runner),
      (runnerId) => boxByRunner.get(runnerId)),
    [boxByRunner, browseMachines],
  );
  const selectedMachine = browseMachines.find(({ runner }) => runner.runnerId === runnerId) ?? browseMachines[0] ?? null;
  const selectedRunnerId = selectedMachine?.runner.runnerId ?? "";
  const selectedFolder = folderSelection?.runnerId === selectedRunnerId ? folderSelection.path : null;
  const creationScopeChoices = useMemo(() => identity ? accessScopeChoices(identity)
    .filter((choice) => {
      const scope = { organizationId: identity.context.organizationId, owner: choice.owner };
      return (!project.scope || scopeAudienceContainedForIdentity(identity, project.scope, scope)) &&
        (!selectedMachine?.runner.scope ||
          scopeAudienceContainedForIdentity(identity, scope, selectedMachine.runner.scope));
    }) : [], [identity, project.scope, selectedMachine]);
  useEffect(() => {
    if (!accessScopeManagementSupported || creationScopeChoices.length === 0) return;
    const preferred = project.scope ? resourceOwnerKey(project.scope.owner) : creationScopeChoices[0]!.key;
    if (!creationScopeChoices.some((choice) => choice.key === scopeKey)) {
      setScopeKey(creationScopeChoices.some((choice) => choice.key === preferred)
        ? preferred : creationScopeChoices[0]!.key);
    }
  }, [accessScopeManagementSupported, creationScopeChoices, project.scope, scopeKey]);
  const candidates = useMemo(() => buildProjectLocationCandidates(projects, runners.values()), [projects, runners]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return candidates.filter((candidate) => {
      if (!normalized) return true;
      const machine = runnerDisplay(
        runners.get(candidate.runnerId),
        boxByRunner.get(candidate.runnerId),
        candidate.runnerId,
      ).name;
      return `${candidate.name} ${candidate.path} ${machine} ${candidate.runnerId}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [boxByRunner, candidates, query, runners]);
  const projectById = useMemo(() => new Map(projects.map((item) => [item.id, item])), [projects]);

  const changeMachine = (nextRunnerId: string) => {
    setRunnerId(nextRunnerId);
    setFolderSelection(null);
    setLocationName("");
    setNameEdited(false);
    setBrowsing(false);
    setError(null);
  };

  const pickFolder = (path: string) => {
    setFolderSelection({ runnerId: selectedRunnerId, path });
    if (!nameEdited) setLocationName(locationNameFromPath(path));
    setBrowsing(false);
    setError(null);
  };

  const toggleCreate = () => {
    if (busyKey) return;
    setCreateExpanded((current) => !current);
    setBrowsing(false);
    setError(null);
  };

  const create = async () => {
    const name = locationName.trim();
    const selectedScope = creationScopeChoices.find((choice) => choice.key === scopeKey);
    if (busyKey || !selectedRunnerId || !selectedFolder || !name ||
        (accessScopeManagementSupported && !selectedScope)) return;
    setBusyKey("create");
    setError(null);
    try {
      await onCreate({
        runnerId: selectedRunnerId,
        name,
        path: selectedFolder,
        ...(selectedScope ? { owner: selectedScope.owner } : {}),
      });
      onClose();
    } catch (cause) {
      setError(projectLocationCreationError(cause));
    } finally {
      setBusyKey(null);
    }
  };

  const choose = async (candidate: ProjectLocationCandidate) => {
    const targetLink = candidate.links.find((link) => link.projectId === project.id);
    const relinkingHere = targetLink?.availability === "runner_removed";
    if (busyKey || (targetLink && !relinkingHere)) return;
    setError(null);
    setBusyKey(candidate.key);
    try {
      await onAdd(candidate);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Modal title={`Add Location to ${project.name}`} onClose={close} wide className="project-location-dialog">
      <div className="project-location-picker">
        <p className="muted">Add an existing Location to this Project. Its other Project memberships and sessions will not change. If the folder is not registered yet, create a new Location from a connected machine.</p>
        <div className="project-location-create-disclosure">
          <button
            type="button"
            className="project-location-create-toggle"
            aria-expanded={createExpanded}
            aria-controls="create-project-location-panel"
            disabled={busyKey !== null || !canCreateLocation}
            onClick={toggleCreate}
          >
            <span className="project-location-create-heading">
              <strong id="create-project-location-heading">Create New Location</strong>
              <span className="muted">Register a folder on a connected machine.</span>
            </span>
            <span className="project-location-create-indicator" aria-hidden="true">
              {createExpanded ? "−" : "+"}
            </span>
          </button>
          {!canCreateLocation && (
            <div className="project-location-compatibility" role="status">
              <strong>Control Plane Update Required</strong>
              <span>
                This control plane cannot register a new folder as a Location. Update or restart it
                so it matches this dashboard. Existing Locations can still be added below.
              </span>
            </div>
          )}
          {createExpanded && (
          <section
            id="create-project-location-panel"
            className="project-location-create"
            aria-labelledby="create-project-location-heading"
          >
          {browseMachines.length > 0 ? (
            <>
              <div className="project-location-create-fields">
                <label className="field">
                  <span>Machine</span>
                  <select
                    value={selectedRunnerId}
                    disabled={busyKey !== null}
                    onChange={(event) => changeMachine(event.target.value)}
                  >
                    {browseMachines.map(({ runner, display }) => (
                      <option key={runner.runnerId} value={runner.runnerId}>
                        {machineLabels.get(runner.runnerId) ?? display.name}
                        {" · "}{display.kind === "ssh" ? "SSH" : "Native Runner"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Location Name</span>
                  <input
                    value={locationName}
                    disabled={busyKey !== null}
                    placeholder="Filled from the selected folder"
                    onChange={(event) => {
                      setLocationName(event.target.value);
                      setNameEdited(true);
                    }}
                  />
                </label>
              </div>
              <div className="field">
                <span>Folder</span>
                <div className="project-location-folder">
                  <code title={selectedFolder ?? undefined}>
                    {selectedFolder ?? "No Folder Selected"}
                  </code>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busyKey !== null}
                    onClick={() => setBrowsing((current) => !current)}
                  >
                    {browsing ? "Close Browser" : selectedFolder ? "Choose Another Folder…" : "Browse for a Folder…"}
                  </button>
                </div>
              </div>
              {accessScopeManagementSupported && creationScopeChoices.length > 0 && (
                <AccessScopeField
                  choices={creationScopeChoices}
                  value={scopeKey}
                  onChange={setScopeKey}
                  disabled={busyKey !== null}
                  label="Location Access"
                />
              )}
              {accessScopeManagementSupported && !identity && !identityError && (
                <span className="muted">Loading permitted access scopes…</span>
              )}
              {accessScopeManagementSupported && identity && creationScopeChoices.length === 0 && (
                <div className="project-location-error" role="alert">
                  <strong>No Compatible Access Scope</strong>
                  <span>
                    No access scope you can assign is compatible with both this Project and Machine.
                    Change the Project or Machine access first.
                  </span>
                </div>
              )}
              {browsing && selectedMachine && (
                <DirectoryPicker
                  runnerId={selectedMachine.runner.runnerId}
                  protocolVersion={selectedMachine.runner.protocolVersion}
                  onPick={pickFolder}
                  onCancel={() => setBrowsing(false)}
                />
              )}
              <div className="project-location-create-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busyKey !== null || !selectedFolder || !locationName.trim() ||
                    (accessScopeManagementSupported && !creationScopeChoices.some((choice) => choice.key === scopeKey))}
                  onClick={() => void create()}
                >
                  {busyKey === "create" ? "Adding…" : "Add Location"}
                </button>
              </div>
            </>
          ) : (
            <div className="project-location-machine-empty">
              <span>No compatible machines are online. Connect or update a machine to browse its filesystem.</span>
              <button type="button" className="btn" onClick={onManageConnections}>Manage Connections</button>
            </div>
          )}
          </section>
          )}
        </div>
        {error && (
          <div className="project-location-error" role="alert">
            <strong>Location Could Not Be Added</strong>
            <span>{error}</span>
          </div>
        )}
        {identityError && (
          <div className="project-location-error" role="alert">
            <strong>Access Scopes Could Not Be Loaded</strong>
            <span>{identityError}</span>
          </div>
        )}
        <div className="project-location-existing-heading">
          <strong>Existing Locations</strong>
          <span className="muted">A Location can be used by more than one Project.</span>
        </div>
        <label className="field">
          <span>Search Locations</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Machine, folder, or path"
          />
        </label>
        <div className="project-location-candidates" role="list">
          {filtered.map((candidate) => {
            const runner = runners.get(candidate.runnerId);
            const display = runnerDisplay(runner, boxByRunner.get(candidate.runnerId), candidate.runnerId);
            const { alreadyAdded, relinkRequired } = projectLocationMembershipState(candidate, project.id);
            const usedBy = candidate.links
              .filter((link) => link.projectId !== project.id)
              .map((link) => projectById.get(link.projectId)?.name)
              .filter((name): name is string => Boolean(name));
            const scopeCompatible = !accessScopeManagementSupported || !identity || !project.scope || !candidate.scope
              ? null
              : scopeAudienceContainedForIdentity(identity, project.scope, candidate.scope);
            const scopeCheckPending = accessScopeManagementSupported && !identity && !identityError;
            const scopeCheckFailed = accessScopeManagementSupported && !identity && Boolean(identityError);
            const scopeCheckUnavailable = accessScopeManagementSupported && Boolean(identity) &&
              (!project.scope || !candidate.scope);
            const canNarrowProject = Boolean(identity && project.scope && candidate.scope &&
              project.canManage !== false && canChangeAccessScope(identity, project.scope, candidate.scope.owner));
            const canBroadenLocation = Boolean(identity && project.scope && candidate.scope &&
              candidate.canManage !== false && canChangeAccessScope(identity, candidate.scope, project.scope.owner));
            return (
              <article className="project-location-candidate" role="listitem" key={candidate.key}>
                <div className="project-location-main">
                  <div className="project-location-heading">
                    <strong>{candidate.name}</strong>
                    <span className={`project-availability availability-${candidate.availability}`}>
                      {projectAvailabilityLabel(candidate.availability)}
                    </span>
                  </div>
                  <code title={candidate.path}>{candidate.path}</code>
                  <span className="muted">{display.name} · {display.kind === "ssh" ? "SSH" : "Native Runner"}</span>
                  {candidate.scope && (
                    <span className="muted">Location Access: {accessScopeLabel(candidate.scope, identity)}</span>
                  )}
                  {usedBy.length > 0 && <span className="muted">Also Used by: {usedBy.join(", ")}</span>}
                  {scopeCompatible === false && (
                    <div className="project-location-reason">
                      This Location is narrower than the Project, so adding it would expose a private workspace.
                      {(canNarrowProject || canBroadenLocation) && (
                        <span className="project-location-corrections">
                          {canNarrowProject && candidate.scope && (
                            <button type="button" className="btn ghost sm" onClick={() => setScopeCorrection({
                              resource: { kind: "project", projectId: project.id, name: project.name },
                              owner: candidate.scope!.owner,
                            })}>Narrow Project Access</button>
                          )}
                          {canBroadenLocation && project.scope && (
                            <button type="button" className="btn ghost sm" onClick={() => setScopeCorrection({
                              resource: {
                                kind: "workspace",
                                runnerId: candidate.runnerId,
                                workspaceId: candidate.workspaceId,
                                name: candidate.name,
                              },
                              owner: project.scope!.owner,
                            })}>Broaden Location Access</button>
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {scopeCheckPending && <span className="muted">Checking access compatibility…</span>}
                  {scopeCheckUnavailable && (
                    <div className="project-location-reason">
                      Access scope details are unavailable, so this Location cannot be added safely.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn sm"
                  disabled={alreadyAdded || busyKey !== null || scopeCompatible === false ||
                    scopeCheckPending || scopeCheckFailed || scopeCheckUnavailable}
                  onClick={() => void choose(candidate)}
                >
                  {busyKey === candidate.key
                    ? "Saving…"
                    : alreadyAdded
                      ? "Already Added"
                      : relinkRequired
                        ? "Relink Location"
                        : "Add to Project"}
                </button>
              </article>
            );
          })}
          {filtered.length === 0 && (
            <div className="project-manager-empty">
              <strong>{candidates.length === 0 ? "No Locations Found" : "No Matching Locations"}</strong>
              <span>{candidates.length === 0
                ? "Create a new Location above or connect another machine."
                : "Try a different machine, folder, or path."}</span>
            </div>
          )}
        </div>
      </div>
      {scopeCorrection && identity && (
        <AccessScopeChangeDialog
          resource={scopeCorrection.resource}
          owner={scopeCorrection.owner}
          identity={identity}
          onClose={() => setScopeCorrection(null)}
          onUpdated={onClose}
        />
      )}
    </Modal>
  );
}
