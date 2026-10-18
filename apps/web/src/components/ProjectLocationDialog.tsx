import { useEffect, useId, useMemo, useRef, useState } from "react";
import { StatusBadge } from "./StatusBadge.js";
import {
  runnerSupportsProtocol,
  type BoxView,
  type IdentityAdministrationView,
  type ProjectView,
  type ResourceOwner,
  type ResourceScope,
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
  projectAvailabilityMeta,
  projectLocationMembershipState,
  type ProjectLocationCandidate,
} from "../project-management.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import {
  AccessScopeChangeDialog,
  AccessScopeField,
  useAccessScopeIdentity,
} from "./AccessScopeControls.js";
import { FieldError } from "./FieldError.js";
import { Modal } from "./common.js";
import { SearchIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, ChoiceRows, SegmentedControl, Select } from "./ui/ChoiceControls.js";

interface NewProjectLocation {
  runnerId: string;
  name: string;
  path: string;
  owner?: ResourceOwner;
}

type AddLocationMode = "existing" | "new";

export function projectLocationCreationError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404 && cause.message.trim().toLocaleLowerCase() === "not found") {
    return "This version of Wollipog does not support creating a Location from a new folder. Update or restart Wollipog so it matches this dashboard, then try again.";
  }
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "The Location could not be added.";
}

/** Words a Title Case name keeps lowercase unless they come first or last (AGENTS.md, UI Copy). */
const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "with"]);

/**
 * A Location Name from the folder it points at, in Title Case like every other location name:
 * "acme-storefront" → "Acme Storefront". Dashes, underscores and spaces separate words; a word keeps
 * the rest of its letters as written, so "iOS-app" reads "IOS App" rather than losing its casing.
 */
export function locationNameFromFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const folder = trimmed.split(/[\\/]/u).pop() || trimmed;
  const words = folder.split(/[-_\s]+/u).filter(Boolean);
  if (words.length === 0) return folder || "Root";
  return words.map((word, index) => {
    const lower = word.toLocaleLowerCase();
    if (index > 0 && index < words.length - 1 && MINOR_WORDS.has(lower)) return lower;
    return word.charAt(0).toLocaleUpperCase() + word.slice(1);
  }).join(" ");
}

/** "Is Shared Only With Builders", "Is Private to You": how a narrower location's access reads in
 * the mismatch notice's title. */
function narrowerAccessTitle(name: string, scope: ResourceScope, identity: IdentityAdministrationView): string {
  if (scope.owner.kind === "team") {
    const teamId = scope.owner.teamId;
    return `${name} Is Shared Only With ${identity.teams.find((team) => team.teamId === teamId)?.name ?? "One Team"}`;
  }
  if (scope.owner.kind === "user") {
    const label = accessScopeLabel(scope, identity);
    return `${name} Is ${label === "Private to Me" ? "Private to You" : label}`;
  }
  return `${name} Is Shared More Narrowly`;
}

/** Who a project's access reaches, for the mismatch notice's one sentence. */
function projectAudience(project: ProjectView, identity: IdentityAdministrationView): string {
  const owner = project.scope?.owner;
  if (!owner || owner.kind === "organization") return "everyone in your organization";
  if (owner.kind === "team") {
    const teamId = owner.teamId;
    return `everyone on ${identity.teams.find((team) => team.teamId === teamId)?.name ?? "its team"}`;
  }
  return owner.userId === identity.context.userId ? "you" : "its owner";
}

type ScopeCorrection = {
  resource: { kind: "project"; projectId: string; name: string } |
    { kind: "workspace"; runnerId: string; workspaceId: string; name: string };
  scope: ResourceScope;
  owner: ResourceOwner;
};

/**
 * Add Location (#2966, docs/design-system.md §7, §8.4, §10.2, §13.2): add a location that already
 * exists, or register a new folder, chosen with one switch and committed by the footer's one Add
 * Location. Existing locations are one surface of radio rows; the chosen row's offline or access
 * warning sits under the list. A mismatch keeps Add Location off, because the server would refuse
 * it, and offers the Change Access dialog that fixes it, stacked over this one.
 *
 * `onboarding` is the hand-off from New Project: a success notice leads, Cancel reads Skip for Now,
 * and, where the server can generate one (`setupFileSupported`), the Create a Starter Setup File
 * checkbox is the last field and applies to whichever location is added.
 */
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
  onboarding = false,
  setupFileSupported = false,
  returnFocusRef,
}: {
  project: ProjectView;
  projects: readonly ProjectView[];
  runners: ReadonlyMap<string, RunnerView>;
  boxes: ReadonlyMap<string, BoxView>;
  canCreateLocation: boolean;
  accessScopeManagementSupported: boolean;
  onClose: () => void;
  onAdd: (candidate: ProjectLocationCandidate, generateSetup: boolean) => Promise<void>;
  onCreate: (location: NewProjectLocation, generateSetup: boolean) => Promise<void>;
  onManageConnections: () => void;
  /** Opened right after New Project created `project`. */
  onboarding?: boolean;
  /** The server can create a starter setup file, so onboarding offers it. */
  setupFileSupported?: boolean;
  /** The control that opened this dialog, for focus to return to (a button inside New Session). */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ sentence: string; detail: string | null } | null>(null);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [runnerId, setRunnerId] = useState("");
  const [locationName, setLocationName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [folderSelection, setFolderSelection] = useState<{ runnerId: string; path: string } | null>(null);
  const [scopeKey, setScopeKey] = useState("");
  const [generateSetup, setGenerateSetup] = useState(false);
  const [scopeCorrection, setScopeCorrection] = useState<ScopeCorrection | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { identity, error: identityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const close = () => {
    if (!busy) onClose();
  };
  const boxByRunner = useMemo(() => new Map([...boxes.values()].map((box) => [box.runnerId, box])), [boxes]);
  const machineName = (id: string) => runnerDisplay(runners.get(id), boxByRunner.get(id), id).name;

  const candidates = useMemo(() => buildProjectLocationCandidates(projects, runners.values()), [projects, runners]);
  const addable = candidates.some((candidate) => !projectLocationMembershipState(candidate, project.id).alreadyAdded);
  // Existing Location when there is one to add; otherwise New Folder (§10.2). Chosen once, on open,
  // so a location that comes and goes never switches the dialog under the person.
  const [mode, setMode] = useState<AddLocationMode>(() => addable ? "existing" : "new");
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

  // The access check for one candidate: `null` while it can't be judged yet.
  const scopeCheckPending = accessScopeManagementSupported && !identity && !identityError;
  const scopeUnavailable = (candidate: ProjectLocationCandidate) => accessScopeManagementSupported && Boolean(identity) &&
    (!project.scope || !candidate.scope);
  const scopeCompatible = (candidate: ProjectLocationCandidate) =>
    !accessScopeManagementSupported || !identity || !project.scope || !candidate.scope
      ? null
      : scopeAudienceContainedForIdentity(identity, project.scope, candidate.scope);
  const rowState = (candidate: ProjectLocationCandidate) => {
    const { alreadyAdded, relinkRequired } = projectLocationMembershipState(candidate, project.id);
    return {
      alreadyAdded,
      relinkRequired,
      unavailable: alreadyAdded || scopeUnavailable(candidate),
    };
  };
  // A row the search hides is not chosen: Add Location never commits a row the person can't see.
  const chosen = mode === "existing" ? filtered.find((candidate) => candidate.key === chosenKey) ?? null : null;
  const chosenState = chosen ? rowState(chosen) : null;
  const chosenMismatch = chosen && scopeCompatible(chosen) === false ? chosen : null;

  // New Folder: every machine, with the ones that can't browse listed but unavailable (§8.4).
  const machines = useMemo(() => [...runners.values()]
    .map((runner) => ({
      runner,
      display: runnerDisplay(runner, boxByRunner.get(runner.runnerId), runner.runnerId),
      browsable: runner.status === "online" && runnerSupportsProtocol(runner.protocolVersion, "directoryListing"),
    }))
    .sort((left, right) =>
      Number(right.browsable) - Number(left.browsable) ||
      left.display.name.localeCompare(right.display.name) ||
      left.runner.runnerId.localeCompare(right.runner.runnerId)), [boxByRunner, runners]);
  // A Location is one exact (Machine, Workspace) pair, so an ambiguous Machine option here creates
  // the pair against the wrong host and filesystem.
  const machineLabels = useMemo(
    () => machineOptionLabels(machines.map(({ runner }) => runner),
      (runnerId) => boxByRunner.get(runnerId)),
    [boxByRunner, machines],
  );
  const anyOnline = machines.some(({ runner }) => runner.status === "online");
  const selectedMachine = machines.find(({ runner, browsable }) => browsable && runner.runnerId === runnerId) ??
    machines.find(({ browsable }) => browsable) ?? null;
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
  const creationScope = creationScopeChoices.find((choice) => choice.key === scopeKey);
  const creating = mode === "new" && canCreateLocation && selectedMachine !== null;

  const changeMachine = (nextRunnerId: string) => {
    setRunnerId(nextRunnerId);
    setFolderSelection(null);
    if (!nameEdited) setLocationName("");
    setError(null);
  };

  // The browser's current folder is the selection; the name follows it until the person edits it.
  const folderChanged = (path: string | null) => {
    // The picker is frozen while a commit is pending; this keeps the submitted folder regardless.
    if (busy) return;
    setFolderSelection(path === null ? null : { runnerId: selectedRunnerId, path });
    if (!nameEdited) setLocationName(path === null ? "" : locationNameFromFolder(path));
  };

  const switchMode = (next: AddLocationMode) => {
    if (busy) return;
    setMode(next);
    setError(null);
  };

  /** Why Add Location is off, for the footer's left slot (§7.3); null while it can commit. */
  const blockedReason = (() => {
    if (mode === "existing") {
      if (!chosen || chosenState?.unavailable) return "Choose a location or a folder.";
      if (identityError && accessScopeManagementSupported) return "Access levels couldn't be loaded.";
      if (scopeCheckPending) return "Checking access levels…";
      if (chosenMismatch) return "Match the access levels to continue.";
      return null;
    }
    if (!creating || !selectedFolder) return "Choose a location or a folder.";
    if (accessScopeManagementSupported) {
      if (identityError) return "Access levels couldn't be loaded.";
      if (!identity) return "Checking access levels…";
      if (!creationScope) return "No access level fits this project and machine.";
    }
    return null;
  })();

  const commit = async () => {
    if (busy || blockedReason) return;
    if (mode === "new") {
      const name = locationName.trim();
      if (!name) {
        setNameError("Enter a name for this location.");
        nameRef.current?.focus();
        return;
      }
      if (!selectedFolder) return;
      setBusy(true);
      setError(null);
      try {
        await onCreate({
          runnerId: selectedRunnerId,
          name,
          path: selectedFolder,
          ...(creationScope ? { owner: creationScope.owner } : {}),
        }, onboarding && setupFileSupported && generateSetup);
        onClose();
      } catch (cause) {
        // A bare legacy 404 becomes the update sentence; anything else keeps the server's words
        // behind Show Details (§8.5).
        const raw = cause instanceof Error ? cause.message.trim() : "";
        const legacy = cause instanceof ApiError && cause.status === 404 && raw.toLocaleLowerCase() === "not found";
        setError(legacy
          ? { sentence: projectLocationCreationError(cause), detail: null }
          : { sentence: "Wollipog couldn't add this folder. Try again.", detail: raw || null });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(chosen, onboarding && setupFileSupported && generateSetup);
      onClose();
    } catch (cause) {
      setError({
        sentence: "Wollipog couldn't add this location. Try again.",
        detail: cause instanceof Error && cause.message.trim() ? cause.message : null,
      });
    } finally {
      setBusy(false);
    }
  };

  const reasonId = `${ids}-reason`;
  const nameHelperId = `${ids}-name-helper`;
  const nameErrorId = `${ids}-name-error`;

  const existing = (
    <>
      <label className="input-affix" title="Searches location names, machines and paths.">
        <span className="input-affix-text" aria-hidden="true"><SearchIcon size={14} /></span>
        <input
          type="search"
          autoFocus
          aria-label="Search Locations"
          disabled={busy}
          placeholder="Search locations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {filtered.length > 0 ? (
        <ChoiceRows
          className="surface add-location-list"
          label="Locations"
          value={chosen?.key ?? null}
          onChange={(key) => { if (!busy) { setChosenKey(key); setError(null); } }}
          options={filtered.map((candidate) => {
            const { alreadyAdded, relinkRequired, unavailable } = rowState(candidate);
            const usedBy = candidate.links
              .filter((link) => link.projectId !== project.id)
              .map((link) => projectById.get(link.projectId)?.name)
              .filter((name): name is string => Boolean(name));
            const machine = machineName(candidate.runnerId);
            return {
              value: candidate.key,
              title: candidate.name,
              status: <StatusBadge meta={projectAvailabilityMeta(candidate.availability)} />,
              description: (
                <span className="add-location-line">
                  <span className="add-location-machine">{machine}</span>
                  <span className="add-location-path" title={candidate.path}><bdi>{candidate.path}</bdi></span>
                </span>
              ),
              meta: alreadyAdded ? "Already Added"
                : relinkRequired ? "Relink"
                  : usedBy.length > 0
                    ? <span title={`Used by ${usedBy.join(", ")}`}>Used by {usedBy[0]}{usedBy.length > 1 ? ` +${usedBy.length - 1}` : ""}</span>
                    : undefined,
              // Every row holds still while a commit is pending; only an unavailable one says why.
              disabled: unavailable || busy,
              disabledReason: alreadyAdded ? `It's already one of ${project.name}'s locations.`
                : unavailable ? "Its access can't be checked, so it can't be added." : undefined,
            };
          })}
        />
      ) : (
        <div className="surface">
          <div className="row add-location-empty" role="status">
            <SearchIcon size={16} />
            <span>
              {candidates.length === 0
                ? "There are no locations to add yet. Add a new folder instead."
                : "No locations match. Try a machine name, a folder or a path, or add a new folder."}
            </span>
          </div>
        </div>
      )}
      {chosen?.availability === "runner_offline" && (
        <Notice tone="warning" compact className="add-location-note">
          {machineName(chosen.runnerId)} is offline. You can add this location, but sessions can't start there until it reconnects.
        </Notice>
      )}
      {chosenMismatch && identity && project.scope && chosenMismatch.scope && (() => {
        const candidateScope = chosenMismatch.scope;
        const projectScope = project.scope;
        const canNarrowProject = project.canManage !== false &&
          canChangeAccessScope(identity, projectScope, candidateScope.owner);
        const canBroadenLocation = chosenMismatch.canManage !== false &&
          canChangeAccessScope(identity, candidateScope, projectScope.owner);
        return (
          <Notice
            tone="warning"
            title={narrowerAccessTitle(chosenMismatch.name, candidateScope, identity)}
            actions={(canNarrowProject || canBroadenLocation) && (
              <>
                {canNarrowProject && (
                  <button type="button" className="btn sm" aria-haspopup="dialog" onClick={() => setScopeCorrection({
                    resource: { kind: "project", projectId: project.id, name: project.name },
                    scope: projectScope,
                    owner: candidateScope.owner,
                  })}>Narrow Project Access…</button>
                )}
                {canBroadenLocation && (
                  <button type="button" className="btn sm" aria-haspopup="dialog" onClick={() => setScopeCorrection({
                    resource: {
                      kind: "workspace",
                      runnerId: chosenMismatch.runnerId,
                      workspaceId: chosenMismatch.workspaceId,
                      name: chosenMismatch.name,
                    },
                    scope: candidateScope,
                    owner: projectScope.owner,
                  })}>Broaden Location Access…</button>
                )}
              </>
            )}
          >
            {project.name} is shared with {projectAudience(project, identity)}, and a project's locations must be shared at least as widely.
          </Notice>
        );
      })()}
    </>
  );

  const newFolder = !canCreateLocation ? (
    <Notice tone="warning" title="Adding New Folders Needs an Update">
      This version of Wollipog can't register a new folder as a location. Update or restart Wollipog so it matches this dashboard. You can still add an existing location.
    </Notice>
  ) : !anyOnline ? (
    <Notice
      tone="neutral"
      title="No Machines Online"
      actions={<button type="button" className="btn sm" onClick={onManageConnections}>Open Connections</button>}
    >
      Start a machine to browse its folders.
    </Notice>
  ) : (
    <>
      <div className="field">
        <span>Machine</span>
        <Select
          label="Machine"
          value={selectedRunnerId || null}
          disabled={busy}
          onChange={changeMachine}
          options={machines.map(({ runner, display, browsable }) => ({
            value: runner.runnerId,
            label: machineLabels.get(runner.runnerId) ?? display.name,
            disabled: !browsable,
            ...(!browsable ? {
              disabledReason: runner.status !== "online"
                ? "Offline. Start it to browse its folders."
                : "Update Wollipog on this machine to browse its folders.",
            } : {}),
          }))}
        />
      </div>
      {selectedMachine && (
        <div className="field">
          <span>Folder</span>
          <DirectoryPicker
            runnerId={selectedMachine.runner.runnerId}
            machineName={selectedMachine.display.name}
            protocolVersion={selectedMachine.runner.protocolVersion}
            hideActions
            disabled={busy}
            onLocationChange={folderChanged}
            onPick={folderChanged}
            onCancel={close}
          />
        </div>
      )}
      <label className="field">
        <span>Location Name</span>
        <input
          ref={nameRef}
          value={locationName}
          disabled={busy}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? nameErrorId : nameHelperId}
          onChange={(event) => {
            setLocationName(event.target.value);
            setNameEdited(true);
            if (event.target.value.trim()) setNameError(null);
          }}
        />
        {nameError
          ? <FieldError id={nameErrorId}>{nameError}</FieldError>
          : <p className="field-helper" id={nameHelperId}>{nameEdited ? "Shown wherever this location is listed." : "Filled in from the folder name."}</p>}
      </label>
      {accessScopeManagementSupported && creationScopeChoices.length > 0 && (
        <AccessScopeField
          choices={creationScopeChoices}
          value={scopeKey}
          onChange={setScopeKey}
          disabled={busy}
          label="Location Access"
          helper="A location must be shared at least as widely as its project."
        />
      )}
      {accessScopeManagementSupported && identity && creationScopeChoices.length === 0 && (
        <Notice tone="warning" title="No Access Level Fits">
          None of the access levels you can assign fits both this project and this machine. Change the project's or the machine's access first.
        </Notice>
      )}
    </>
  );

  return (
    <Modal
      title={`Add Location to ${project.name}`}
      onClose={close}
      size="md"
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          {blockedReason && <span className="add-location-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {onboarding ? "Skip for Now" : "Cancel"}
          </button>
          <BusyButton
            className="btn primary"
            busy={busy}
            progress="Adding the location…"
            disabled={blockedReason !== null}
            aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void commit()}
          >
            Add Location
          </BusyButton>
        </>
      )}
    >
      {onboarding && (
        <Notice tone="success" compact className="add-location-note">
          {project.name} was created. Add the folder where its sessions run.
        </Notice>
      )}
      <SegmentedControl
        className="block"
        label="Add From"
        value={mode}
        onChange={switchMode}
        options={[
          { value: "existing", label: "Existing Location", disabled: busy },
          { value: "new", label: "New Folder", disabled: busy },
        ]}
      />
      {mode === "existing" ? existing : newFolder}
      {identityError && (
        <Notice tone="danger" role="alert" title="Couldn't Load Access Levels" details={identityError}>
          Wollipog needs them to check that a location fits this project. Close this and try again.
        </Notice>
      )}
      {onboarding && setupFileSupported && (
        <Checkbox
          checked={generateSetup}
          disabled={busy}
          label="Create a Starter Setup File"
          helper="Adds a setup file for review after the location is added. Nothing runs, and nothing is committed."
          onChange={setGenerateSetup}
        />
      )}
      {error && (
        <Notice tone="danger" role="alert" title="Couldn't Add the Location" details={error.detail ?? undefined}>
          {error.sentence}
        </Notice>
      )}
      {scopeCorrection && identity && (
        <AccessScopeChangeDialog
          resource={scopeCorrection.resource}
          scope={scopeCorrection.scope}
          initialOwner={scopeCorrection.owner}
          identity={identity}
          onClose={() => setScopeCorrection(null)}
          // The snapshot carries the new access; Add Location stays open and turns on once it matches.
          onUpdated={() => {}}
        />
      )}
    </Modal>
  );
}
