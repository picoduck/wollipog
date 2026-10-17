import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { StatusBadge } from "./StatusBadge.js";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BoxView,
  type ProjectLocationView,
  type ProjectView,
  type WorktreeSetupConfigStatus,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { archiveProjectWithFeedback, projectArchiveMessage } from "../project-actions.js";
import { ProjectMemorySharingSettings } from "./ProjectMemorySharing.js";
import { ProjectChildDefaults } from "./ProjectChildDefaults.js";
import { sessionArchiveRequiresStop } from "../archive-actions.js";
import {
  filterManagedProjects,
  locationSessionCount,
  projectAfterRemoval,
  projectAvailabilityLabel,
  projectAvailabilityMeta,
  type LocationMachineName,
  type ProjectLocationCandidate,
  type ProjectVisibilityFilter,
} from "../project-management.js";
import { runnerDisplay } from "../runners.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { AccessScopeSettings, useAccessScopeIdentity } from "./AccessScopeControls.js";
import { useFeedback } from "./FeedbackProvider.js";
import { PlusIcon, ProjectsIcon } from "./Icons.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { backLabel, destination } from "../navigation.js";
import { useIsMobile } from "./useIsMobile.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { projectAudienceVisibilitySummary } from "../session-project-assignment.js";
import { DetailSkeleton, Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { ProjectList } from "./ProjectList.js";
import { State } from "./State.js";

type DialogState =
  | { kind: "create" }
  | { kind: "add-location"; onboarding?: boolean }
  | { kind: "delete" };

function ProjectLocationWorktreeSetup({ project, location, runnerProtocolVersion }: {
  project: ProjectView;
  location: ProjectLocationView;
  runnerProtocolVersion?: number | null;
}) {
  const api = useApi();
  const supported = runnerSupportsProtocol(runnerProtocolVersion, "worktreeSetupConfig");
  const [status, setStatus] = useState<WorktreeSetupConfigStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!supported || location.availability !== "available") return;
    let active = true;
    setStatus(null);
    setError(null);
    void api.projectLocationWorktreeSetup(project.id, location.id).then((result) => {
      if (active) setStatus(result.status);
    }).catch((cause) => {
      if (active) setError((cause as Error).message);
    });
    return () => { active = false; };
  }, [api, location.availability, location.id, project.id, supported]);
  if (!supported) return <span className="project-location-reason">Setup Status: Update this Machine to validate configuration.</span>;
  if (location.availability !== "available") return <span className="project-location-reason">Setup Status: Unavailable while this Location is offline.</span>;
  return (
    <div className="project-location-setup-status">
      <span>
        <strong>Setup Status: </strong>
        {status?.status === "valid" ? "Valid" : status?.status === "absent" ? "Not Configured"
          : status?.status === "invalid" ? "Invalid" : error ? "Unavailable" : "Checking…"}
      </span>
      {status?.status === "invalid" && <code role="alert">{status.error}</code>}
      {error && <span className="project-location-reason" role="alert">{error}</span>}
      {status?.status === "absent" && project.canManage !== false && (
        <button type="button" className="btn sm" disabled={busy} onClick={() => {
          setBusy(true);
          setError(null);
          void api.generateProjectLocationWorktreeSetup(project.id, location.id)
            .then((result) => {
              setStatus(result.status);
              return api.dismissWorktreeSetupNotice(project.id);
            })
            .catch((cause) => setError((cause as Error).message))
            .finally(() => setBusy(false));
        }}>{busy ? "Generating…" : "Generate Starter Config"}</button>
      )}
    </div>
  );
}

function DeleteProjectDialog({ project, busy, error, onClose, onDelete }: {
  project: ProjectView;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      title="Delete Project"
      size="sm"
      tone="danger"
      closeButton={false}
      onClose={close}
      describedBy="delete-project-consequences"
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy || confirmation !== project.name} onClick={() => void onDelete()}>
            {busy ? "Deleting…" : "Delete Project"}
          </button>
        </>
      )}
    >
      <div className="form">
        <div id="delete-project-consequences" className="danger-note">
          “{project.name}” is permanently deleted: its sessions move to No Project and its Locations are unlinked. Sessions and files are not deleted, and archived sessions stay archived.
        </div>
        <label className="field">
          <span>Type {project.name} to Confirm</span>
          <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

const PROJECTS = destination("projects");

export function ProjectsView({
  selectedProjectId,
  onNewSession,
}: {
  selectedProjectId?: string;
  onNewSession: (preset?: NewSessionPreset) => void;
}) {
  const api = useApi();
  const { confirm, showToast, showUndo } = useFeedback();
  const { navigate } = useStoreActions();
  const isMobile = useIsMobile();
  const storedProjects = useStoreSelector((state) => state.projects);
  const sessions = useStoreSelector((state) => state.sessions);
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  const projectLocationCreationSupported = useStoreSelector((state) => state.projectLocationCreationSupported);
  const accessScopeManagementSupported = useStoreSelector((state) => state.accessScopeManagementSupported);
  const worktreeSetupConfigSupported = useStoreSelector((state) => state.worktreeSetupConfigSupported);
  const stopBeforeArchiveSupported = useStoreSelector((state) => state.stopBeforeArchiveSupported);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const runners = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const [overrides, setOverrides] = useState(() => new Map<string, ProjectView>());
  const [deletedIds, setDeletedIds] = useState(() => new Set<string>());
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<ProjectVisibilityFilter>("all");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const { identity: accessIdentity, error: accessIdentityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const projectMap = useMemo(() => {
    const map = new Map(storedProjects);
    for (const [id, project] of overrides) map.set(id, project);
    for (const id of deletedIds) map.delete(id);
    return map;
  }, [deletedIds, overrides, storedProjects]);
  const boxByRunner = useMemo(() => new Map([...boxes.values()].map((box: BoxView) => [box.runnerId, box])), [boxes]);
  const machineName = useCallback<LocationMachineName>((location) =>
    runnerDisplay(runners.get(location.runnerId), boxByRunner.get(location.runnerId), location.runnerId).name,
  [boxByRunner, runners]);
  const allProjects = useMemo(() => filterManagedProjects(projectMap.values(), "", "all"), [projectMap]);
  const visibleProjects = useMemo(() => filterManagedProjects(projectMap.values(), query, visibility, machineName),
    [machineName, projectMap, query, visibility]);
  const selected = selectedProjectId ? projectMap.get(selectedProjectId) ?? null : null;
  const selectedStopsRuntime = selected ? [...sessions.values()].some((session) =>
    session.projectId === selected.id && !session.archived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)
  ) : false;

  useEffect(() => {
    if (!selected && selectedProjectId && snapshotLoaded) {
      const fallback = visibleProjects[0] ?? allProjects[0];
      navigate(fallback ? { name: "projects", id: fallback.id } : { name: "projects" });
    }
  }, [allProjects, navigate, selected, selectedProjectId, snapshotLoaded, visibleProjects]);
  // Each pane scrolls on its own (§6). A new selection starts the detail at its top; on a phone, where
  // the route swaps the whole screen, focus moves to the new page title, which shows no ring (§16.1).
  const listBodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousSelection = useRef(selectedProjectId);
  useLayoutEffect(() => {
    if (previousSelection.current === selectedProjectId) return;
    previousSelection.current = selectedProjectId;
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (isMobile) document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [selectedProjectId, isMobile]);
  // A phone hides the list while a project is open, which loses its scroll position; Back puts the
  // list back where it was (§6.2). Recorded only while the list is on screen.
  const listScrollTop = useRef(0);
  const detailOpen = Boolean(selectedProjectId);
  useLayoutEffect(() => {
    if (!detailOpen && listBodyRef.current) listBodyRef.current.scrollTop = listScrollTop.current;
  }, [detailOpen]);
  useEffect(() => {
    setRenameDraft(selected?.name ?? "");
    setError(null);
  }, [selected?.id, selected?.name]);
  useEffect(() => {
    if (overrides.size === 0) return;
    setOverrides((current) => {
      const next = new Map(current);
      let changed = false;
      for (const [id, project] of current) {
        const stored = storedProjects.get(id);
        if (stored && stored.updatedAt >= project.updatedAt) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [overrides.size, storedProjects]);

  const applyProject = (project: ProjectView) => {
    setOverrides((current) => new Map(current).set(project.id, project));
  };
  const openDialog = (next: DialogState) => {
    setError(null);
    setDialog(next);
  };
  const runProjectMutation = async (key: string, action: () => Promise<ProjectView>, reportError = true) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const project = await action();
      applyProject(project);
      return project;
    } catch (cause) {
      if (reportError) setError((cause as Error).message);
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !renameDraft.trim() || renameDraft.trim() === selected.name) return;
    try {
      await runProjectMutation("rename", async () => (await api.updateProject(selected.id, { name: renameDraft.trim() })).project);
      showToast("Project renamed.");
    } catch { /* inline error */ }
  };
  const toggleHidden = async () => {
    if (!selected) return;
    try {
      await runProjectMutation("visibility", async () => (await api.updateProject(selected.id, { hidden: !selected.hidden })).project);
      showToast(selected.hidden ? "Project shown in Sessions." : "Project hidden from Sessions.");
    } catch { /* inline error */ }
  };
  const archiveSessions = async () => {
    if (!selected || selected.unarchivedSessionCount === 0) return;
    const accepted = await confirm({
      title: selectedStopsRuntime ? "Archive and Stop Sessions" : "Archive Sessions",
      message: projectArchiveMessage({
        projectName: selected.name,
        count: selected.unarchivedSessionCount,
        stops: selectedStopsRuntime,
        onProjectPage: true,
      }),
      confirmLabel: selectedStopsRuntime ? "Archive and Stop" : "Archive Sessions",
      ...(selectedStopsRuntime ? { tone: "danger" as const } : {}),
    });
    if (!accepted) return;
    setBusy("archive");
    setError(null);
    try {
      await archiveProjectWithFeedback({ projectId: selected.id, projectName: selected.name, api, showToast, showUndo });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const removeLocation = async (location: ProjectLocationView) => {
    if (!selected) return;
    const last = selected.locations.length === 1;
    const accepted = await confirm({
      title: "Remove Location",
      message: `New sessions in “${selected.name}” will no longer use “${location.name}” at ${location.path}. The folder is not deleted, and existing sessions and other Projects are unaffected${last ? "; this Project will have no Locations left" : ""}.`,
      confirmLabel: "Remove Location",
      tone: "danger",
    });
    if (!accepted) return;
    try {
      await runProjectMutation(`remove:${location.id}`, async () => (await api.removeProjectLocation(selected.id, location.id)).project);
      showToast("Location removed. The folder and sessions were not deleted.");
    } catch { /* inline error */ }
  };
  const makeDefault = async (location: ProjectLocationView) => {
    if (!selected) return;
    try {
      await runProjectMutation(`default:${location.id}`, async () => (await api.setDefaultProjectLocation(selected.id, location.id)).project);
    } catch { /* inline error */ }
  };
  const reveal = async (location: ProjectLocationView) => {
    setError(null);
    try {
      await api.revealWorkspace(location.runnerId, location.path);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const deleteProject = async () => {
    if (!selected) return;
    setBusy("delete");
    setError(null);
    try {
      await api.deleteProject(selected.id);
      const next = projectAfterRemoval(allProjects, selected.id);
      setDeletedIds((current) => new Set(current).add(selected.id));
      setDialog(null);
      navigate(next ? { name: "projects", id: next.id } : { name: "projects" });
      showToast("Project deleted. Sessions moved to No Project.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const manageConnections = () => navigate({ name: "runners", section: "machines" });
  const refreshSelectedProject = async () => {
    if (!selected) return;
    try {
      applyProject((await api.project(selected.id)).project);
      showToast("Access scope updated.");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const header = (primary: boolean) => (
    <PageHeader
      title={PROJECTS.name}
      description={PROJECTS.description}
      // Disabled while loading rather than omitted: it holds its own width, and there is nothing to
      // create a project against until the snapshot says which machines are connected.
      primary={primary ? {
        label: "New Project",
        buttonRef: createButtonRef,
        disabled: !snapshotLoaded,
        onClick: () => openDialog({ kind: "create" }),
      } : undefined}
    />
  );

  if (snapshotLoaded && !projectsSupported) {
    return (
      <section className="page full fill">
        <PageHeader title={PROJECTS.name} description={PROJECTS.description} />
        <div className="master-detail-state">
          <Notice tone="warning" title="Projects Need an Update" headingLevel={2}>
            Update Wollipog to manage projects and locations. Your sessions aren’t affected.
          </Notice>
        </div>
      </section>
    );
  }

  // No projects is one state across both panes (§6.1, §12.1), and that state offers creation, so the
  // header's primary steps aside while it shows.
  const spanningEmpty = snapshotLoaded && allProjects.length === 0;
  // On a phone the list and the open project are two routes, so the open project takes the detail
  // bar and its Back (§4.3, §6.2). The bar sits inside the fill page, where it is full-bleed like
  // every detail bar and shares the column's height with the panes.
  const phoneDetail = isMobile && detailOpen && !spanningEmpty;
  const noMatch = snapshotLoaded && allProjects.length > 0 && visibleProjects.length === 0;
  return (
    <section className="page full fill">
      {phoneDetail && (
        <DetailBar
          title={selected?.name ?? "Project"}
          backLabel={backLabel("projects")}
          onBack={() => navigate({ name: "projects" })}
        />
      )}
      {!phoneDetail && header(!spanningEmpty)}
      {spanningEmpty ? (
        <div className="master-detail-state">
          <State
            icon={<ProjectsIcon />}
            title={`No ${PROJECTS.name} Yet`}
            headingLevel={2}
            actions={
              <>
                <button type="button" className="btn primary lg" onClick={() => openDialog({ kind: "create" })}>
                  <PlusIcon />
                  New Project
                </button>
                <button type="button" className="btn" onClick={manageConnections}>Connect a Machine</button>
              </>
            }
          >
            A project is a repository on one or more of your machines. Sessions start inside a project.
          </State>
        </div>
      ) : (
      <div className="master-detail" data-detail-open={detailOpen ? "" : undefined}>
        <ProjectList
          projects={snapshotLoaded ? allProjects : null}
          shown={visibleProjects}
          query={query}
          onQueryChange={setQuery}
          visibility={visibility}
          onVisibilityChange={setVisibility}
          machineName={machineName}
          selectedId={selected?.id ?? null}
          onSelect={(projectId) => navigate({ name: "projects", id: projectId })}
          bodyRef={listBodyRef}
          onBodyScroll={(event) => {
            // A hidden list reports 0; that is not where the person left it.
            if (event.currentTarget.clientHeight > 0) listScrollTop.current = event.currentTarget.scrollTop;
          }}
        />
        <div ref={detailRef} className="master-detail-detail" data-focus-zone="main" tabIndex={-1}>
          {!snapshotLoaded ? (
            // While the snapshot loads, the list's skeleton is the one announcement.
            <DetailSkeleton />
          ) : !selected ? (
            // Until the Projects Overview (#2958), a desktop with no selection keeps this placeholder.
            // A search with no match is answered in the list alone, so it steps aside then (§12.2).
            noMatch ? null : (
              <div className="project-manager-empty">
                <strong>Select a Project</strong>
                <span>Choose a Project to manage its Locations and sessions.</span>
              </div>
            )
          ) : (
            // One grid item, so the detail keeps its own flow until its header and sections (#2959).
            <div>
              <div className="project-detail-heading">
                <div>
                  <h2>{selected.name}</h2>
                  <span className="muted project-detail-meta">Project ID: {selected.id}</span>
                  {projectAudienceVisibilitySummary(selected.audience) && (
                    <span className="muted project-detail-meta">{projectAudienceVisibilitySummary(selected.audience)}</span>
                  )}
                </div>
                <span className={`project-visibility-state${selected.hidden ? " is-hidden" : ""}`}>
                  {selected.hidden ? "Hidden from Sessions" : "Shown in Sessions"}
                </span>
              </div>
              {selected.canManage === false && (
                <div className="project-permission-note" role="note">
                  You can view this Project, but you don’t have permission to manage it.
                </div>
              )}
              {error && <div className="form-error project-manager-error" role="alert">{error}</div>}
              {accessIdentityError && (
                <div className="form-error project-manager-error" role="alert">
                  Access controls could not be loaded: {accessIdentityError}
                </div>
              )}
              <section className="project-detail-section" aria-labelledby="project-details-heading">
                <div className="project-section-heading">
                  <div><h3 id="project-details-heading">Project Details</h3><p>Renaming a Project does not rename its folders or Locations.</p></div>
                </div>
                <form className="project-name-form" onSubmit={(event) => void rename(event)}>
                  <label className="field">
                    <span>Project Name</span>
                    <input value={renameDraft} disabled={selected.canManage === false || busy !== null} maxLength={120} onChange={(event) => setRenameDraft(event.target.value)} />
                  </label>
                  <button type="submit" className="btn" disabled={selected.canManage === false || busy !== null || !renameDraft.trim() || renameDraft.trim() === selected.name}>
                    <span>{busy === "rename" ? "Saving…" : "Save Changes"}</span>
                  </button>
                </form>
                <div className="project-counts" aria-label="Project Counts">
                  <div><strong>{selected.activeSessionCount}</strong><span>Active Sessions</span></div>
                  <div><strong>{selected.unarchivedSessionCount}</strong><span>Unarchived Sessions</span></div>
                  <div><strong>{selected.totalSessionCount}</strong><span>Total Sessions</span></div>
                  <div><strong>{selected.locations.length}</strong><span>Locations</span></div>
                </div>
                <button type="button" className="btn" disabled={selected.canManage === false || busy !== null} onClick={() => void toggleHidden()}>
                  {busy === "visibility" ? "Saving…" : selected.hidden ? "Show Project" : "Hide Project"}
                </button>
                {accessScopeManagementSupported && selected.scope && (
                  <AccessScopeSettings
                    resource={{ kind: "project", projectId: selected.id, name: selected.name }}
                    scope={selected.scope}
                    identity={accessIdentity}
                    disabled={selected.canManage === false || busy !== null}
                    onUpdated={() => void refreshSelectedProject()}
                  />
                )}
              </section>
              <ProjectMemorySharingSettings key={`memory:${selected.id}`} project={selected} runners={runners}
                disabled={selected.canManage === false || busy !== null}
                onSave={async (memorySharing) => {
                  const result = await runProjectMutation("memory-sharing",
                    async () => (await api.updateProject(selected.id, { memorySharing })).project, false);
                  if (!result) throw new Error("Could not save the memory policy.");
                }} />
              {selected.childSessionDefaults !== undefined && <ProjectChildDefaults
                key={selected.id}
                project={selected}
                disabled={selected.canManage === false || busy !== null}
                onSave={async (childSessionDefaults) => {
                  const result = await runProjectMutation("child-defaults",
                    // This form owns its error alert; do not announce the rejection twice.
                    async () => (await api.updateProject(selected.id, { childSessionDefaults })).project, false);
                  if (!result) throw new Error("Could not save child session defaults.");
                }}
              />}
              <section className="project-detail-section" aria-labelledby="project-locations-heading">
                <div className="project-section-heading">
                  <div><h3 id="project-locations-heading">Locations</h3><p>Exact folders where this Project can run. The default is used first when available.</p></div>
                  <button type="button" className="btn" disabled={selected.canManage === false || busy !== null} onClick={() => openDialog({ kind: "add-location" })}>
                    <PlusIcon />
                    <span>Add Location</span>
                  </button>
                </div>
                {selected.locations.length === 0 ? (
                  <div className="project-manager-empty location-empty">
                    <strong>No Project Locations</strong>
                    <span>Add a folder on a connected machine to start sessions here.</span>
                    <div>
                      <button type="button" className="btn primary" disabled={selected.canManage === false} onClick={() => openDialog({ kind: "add-location" })}>Add Location</button>
                      <button type="button" className="btn" onClick={manageConnections}>Manage Connections</button>
                    </div>
                  </div>
                ) : (
                  <div className="project-location-list">
                    {selected.locations.map((location) => {
                      const runner = runners.get(location.runnerId);
                      const display = runnerDisplay(runner, boxByRunner.get(location.runnerId), location.runnerId);
                      const count = locationSessionCount(location);
                      const hostActionsSupported = runnerSupportsProtocol(runner?.protocolVersion, "hostActions");
                      const wslOnWindows = runner?.os === "windows" && location.path.startsWith("/");
                      const canLaunch = location.availability === "available";
                      const canReveal = canLaunch && hostActionsSupported && !wslOnWindows;
                      const revealReason = !canLaunch
                        ? `${projectAvailabilityLabel(location.availability)} Locations cannot be revealed.`
                        : wslOnWindows
                          ? "WSL workspace paths cannot be revealed from this machine."
                          : !hostActionsSupported
                            ? runnerCapabilityRequirement(runner?.protocolVersion, "hostActions", "revealing files in the file manager")
                            : null;
                      return (
                        <article className="project-location-row" key={location.id}>
                          <div className="project-location-main">
                            <div className="project-location-heading">
                              <strong>{location.name}</strong>
                              {location.isDefault && <span className="project-default-badge">Default</span>}
                              <StatusBadge meta={projectAvailabilityMeta(location.availability)} />
                            </div>
                            <code title={location.path}>{location.path}</code>
                            <span className="muted">{display.name} · {display.kind === "ssh" ? "SSH" : "Native Runner"}{count === null ? "" : ` · ${count} Session${count === 1 ? "" : "s"}`}</span>
                            {accessScopeManagementSupported && location.scope && (
                              <AccessScopeSettings
                                resource={{
                                  kind: "workspace",
                                  runnerId: location.runnerId,
                                  workspaceId: location.workspaceId,
                                  name: location.name,
                                }}
                                scope={location.scope}
                                identity={accessIdentity}
                                disabled={location.canManage === false || selected.canManage === false || busy !== null}
                                onUpdated={() => void refreshSelectedProject()}
                              />
                            )}
                            {revealReason && <span className="project-location-reason">{revealReason}</span>}
                            {worktreeSetupConfigSupported && (
                              <ProjectLocationWorktreeSetup project={selected} location={location}
                                runnerProtocolVersion={runner?.protocolVersion} />
                            )}
                          </div>
                          <div className="project-location-actions">
                            <button
                              type="button"
                              className="btn sm"
                              disabled={!canLaunch}
                              onClick={() => onNewSession({
                                runnerId: location.runnerId,
                                workspaceId: location.workspaceId,
                                projectId: selected.id,
                                projectLocationId: location.id,
                              })}
                            >
                              New Session Here
                            </button>
                            <button type="button" className="btn sm" disabled={!canReveal} onClick={() => void reveal(location)}>Reveal in File Manager</button>
                            <button type="button" className="btn sm" disabled={selected.canManage === false || location.isDefault || location.availability === "runner_removed" || busy !== null} onClick={() => void makeDefault(location)}>Make Default</button>
                            <button type="button" className="btn sm danger-text" disabled={selected.canManage === false || busy !== null} onClick={() => void removeLocation(location)}>Remove Location</button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
              <section className="project-detail-section" aria-labelledby="project-session-actions-heading">
                <div className="project-section-heading"><div><h3 id="project-session-actions-heading">Session Actions</h3><p>Archiving sessions leaves this Project and its Locations in place.</p></div></div>
                <button type="button" className="btn" disabled={selected.canManage === false || selected.unarchivedSessionCount === 0 || busy !== null} onClick={() => void archiveSessions()}>
                  {busy === "archive" ? "Archiving…" : selectedStopsRuntime ? "Archive and Stop Sessions" : "Archive Sessions"}
                </button>
              </section>
              <section className="project-detail-section project-danger-zone" aria-labelledby="project-danger-heading">
                <div className="project-section-heading"><div><h3 id="project-danger-heading">Danger Zone</h3><p>Deleting removes only Project metadata. Sessions and files are retained.</p></div></div>
                <button type="button" className="btn ghost danger" disabled={selected.canManage === false || busy !== null} onClick={() => openDialog({ kind: "delete" })}>Delete Project</button>
              </section>
            </div>
          )}
        </div>
      </div>
      )}
      {dialog?.kind === "create" && (
        <CreateProjectDialog
          accessScopeManagementSupported={accessScopeManagementSupported}
          onClose={() => setDialog(null)}
          onCreated={(project) => {
            applyProject(project);
            navigate({ name: "projects", id: project.id });
            setDialog({ kind: "add-location", onboarding: true });
          }}
        />
      )}
      {dialog?.kind === "add-location" && selected && (
        <ProjectLocationDialog
          project={selected}
          projects={allProjects}
          runners={runners}
          boxes={boxes}
          canCreateLocation={projectLocationCreationSupported}
          accessScopeManagementSupported={accessScopeManagementSupported}
          onboarding={dialog.onboarding && worktreeSetupConfigSupported}
          onClose={() => setDialog(null)}
          onManageConnections={manageConnections}
          onAdd={async (candidate: ProjectLocationCandidate, generateSetup) => {
            const { project } = await api.addProjectLocation(selected.id, { runnerId: candidate.runnerId, workspaceId: candidate.workspaceId });
            applyProject(project);
            if (generateSetup) {
              const added = project.locations.find((location) =>
                location.runnerId === candidate.runnerId && location.workspaceId === candidate.workspaceId);
              if (!added) throw new Error("Location was added, but its setup configuration could not be generated. Retry from Project Settings.");
              try {
                await api.generateProjectLocationWorktreeSetup(project.id, added.id);
                await api.dismissWorktreeSetupNotice(project.id);
              } catch (cause) {
                throw new Error(`Location was added, but setup generation failed: ${(cause as Error).message}. Retry from Project Settings.`);
              }
            }
          }}
          onCreate={async (location, generateSetup) => {
            const { project } = await api.createProjectLocation(selected.id, location);
            applyProject(project);
            if (generateSetup) {
              const added = project.locations.find((candidate) =>
                candidate.runnerId === location.runnerId && candidate.path === location.path);
              if (!added) throw new Error("Location was added, but its setup configuration could not be generated. Retry from Project Settings.");
              try {
                await api.generateProjectLocationWorktreeSetup(project.id, added.id);
                await api.dismissWorktreeSetupNotice(project.id);
              } catch (cause) {
                throw new Error(`Location was added, but setup generation failed: ${(cause as Error).message}. Retry from Project Settings.`);
              }
            }
          }}
        />
      )}
      {dialog?.kind === "delete" && selected && (
        <DeleteProjectDialog project={selected} busy={busy === "delete"} error={error} onClose={() => setDialog(null)} onDelete={deleteProject} />
      )}
    </section>
  );
}
