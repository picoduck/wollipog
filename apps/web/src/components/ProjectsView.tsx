import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BoxView,
  type ProjectLocationView,
  type ProjectView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { archiveProjectWithFeedback } from "../project-actions.js";
import {
  filterManagedProjects,
  locationSessionCount,
  projectAfterRemoval,
  projectAvailabilityLabel,
  type ProjectLocationCandidate,
  type ProjectVisibilityFilter,
} from "../project-management.js";
import { runnerDisplay } from "../runners.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { useFeedback } from "./FeedbackProvider.js";
import { PlusIcon, SearchIcon } from "./Icons.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { projectAudienceVisibilitySummary } from "../session-project-assignment.js";
import { Modal, Skeleton } from "./common.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

type DialogState =
  | { kind: "create" }
  | { kind: "add-location" }
  | { kind: "delete" };

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
      title={`Delete ${project.name}?`}
      onClose={close}
      describedBy="delete-project-consequences"
      footer={(
        <>
          <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className="btn danger" disabled={busy || confirmation !== project.name} onClick={() => void onDelete()}>
            {busy ? "Deleting…" : "Delete Project"}
          </button>
        </>
      )}
    >
      <div className="form">
        <div id="delete-project-consequences" className="danger-note">
          Sessions will move to No Project and Locations will be unlinked. Sessions and files are not deleted, and archived sessions stay archived. The Project itself is permanently deleted.
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
  const storedProjects = useStoreSelector((state) => state.projects);
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  const projectLocationCreationSupported = useStoreSelector((state) => state.projectLocationCreationSupported);
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
  const createButtonRef = useRef<HTMLButtonElement>(null);

  const projectMap = useMemo(() => {
    const map = new Map(storedProjects);
    for (const [id, project] of overrides) map.set(id, project);
    for (const id of deletedIds) map.delete(id);
    return map;
  }, [deletedIds, overrides, storedProjects]);
  const allProjects = useMemo(() => filterManagedProjects(projectMap.values(), "", "all"), [projectMap]);
  const visibleProjects = useMemo(() => filterManagedProjects(projectMap.values(), query, visibility), [projectMap, query, visibility]);
  const selected = selectedProjectId ? projectMap.get(selectedProjectId) ?? null : null;
  const boxByRunner = useMemo(() => new Map([...boxes.values()].map((box: BoxView) => [box.runnerId, box])), [boxes]);

  useEffect(() => {
    if (!selected && selectedProjectId && snapshotLoaded) {
      const fallback = visibleProjects[0] ?? allProjects[0];
      navigate(fallback ? { name: "projects", id: fallback.id } : { name: "projects" });
    }
  }, [allProjects, navigate, selected, selectedProjectId, snapshotLoaded, visibleProjects]);
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
  const runProjectMutation = async (key: string, action: () => Promise<ProjectView>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const project = await action();
      applyProject(project);
      return project;
    } catch (cause) {
      setError((cause as Error).message);
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
      showToast(selected.hidden ? "Project shown in Inbox." : "Project hidden from Inbox.");
    } catch { /* inline error */ }
  };
  const archiveSessions = async () => {
    if (!selected || selected.unarchivedSessionCount === 0) return;
    const accepted = await confirm({
      title: `Archive ${selected.unarchivedSessionCount} Session${selected.unarchivedSessionCount === 1 ? "" : "s"}?`,
      message: `Archive every unarchived session in “${selected.name}”? The Project and its Locations will remain.`,
      confirmLabel: "Archive Sessions",
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
      title: `Remove ${location.name}?`,
      message: `New sessions in this Project will no longer use ${location.path}. The folder is not deleted, existing sessions stay in this Project, and other Projects using this Location are unaffected.${last ? " This Project will remain with no Locations." : ""}`,
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

  if (!snapshotLoaded) {
    // The placeholder renders the REAL intro and the REAL grid shell, because neither depends on
    // the snapshot — the intro is static copy and the grid's minimum height is its own. Sizing a
    // standalone Skeleton to match instead needs a number copied from the stylesheet, and the
    // copy was wrong: six 44px rows reserved ~296px for a layout whose grid alone has a 720px
    // minimum, so the load finished with a ~500px jump. `.skeleton { flex: 1 }` did not save it —
    // `.main-body` is a flex ITEM, not a flex container, so the rule never applied.
    return (
      <div className="projects-view">
        <div className="projects-intro">
          <div>
            <h2>Manage Projects</h2>
            <p>Projects organize related sessions. Locations are folders on connected machines where sessions run.</p>
          </div>
          {/* Disabled rather than omitted: it holds its own width, and there is nothing to create
              a Project against until the snapshot says which machines are connected. */}
          <button type="button" className="btn primary" disabled>
            <PlusIcon />
            <span>Create Project</span>
          </button>
        </div>
        <div className="project-manager-grid">
          <Skeleton rows={6} announce="Loading projects" />
        </div>
      </div>
    );
  }
  if (!projectsSupported) {
    return (
      <div className="project-manager-unavailable">
        <strong>Project Management Unavailable</strong>
        <span>Update the connected control plane to manage durable Projects and Locations.</span>
      </div>
    );
  }

  return (
    <div className="projects-view">
      <div className="projects-intro">
        <div>
          <h2>Manage Projects</h2>
          <p>Projects organize related sessions. Locations are folders on connected machines where sessions run.</p>
        </div>
        <button ref={createButtonRef} type="button" className="btn primary" onClick={() => openDialog({ kind: "create" })}>
          <PlusIcon />
          <span>Create Project</span>
        </button>
      </div>
      <div className="project-manager-grid">
        <aside className={`project-manager-list${selected ? " has-selection" : ""}`} aria-label="Projects">
          <label className="project-manager-search">
            <span className="sr-only">Search Projects</span>
            <SearchIcon />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" />
          </label>
          {/* Was `role="group"` with `aria-pressed`, which describes three independent toggles
              rather than one choice of three. */}
          <SegmentedControl
            className="is-block"
            label="Inbox Visibility"
            value={visibility}
            options={[
              { value: "all", label: "All" },
              { value: "visible", label: "Visible" },
              { value: "hidden", label: "Hidden" },
            ]}
            onChange={setVisibility}
          />
          <div className="project-manager-items">
            {visibleProjects.map((project) => {
              const active = project.id === selected?.id;
              const available = project.locations.filter((location) => location.availability === "available").length;
              return (
                <button
                  type="button"
                  key={project.id}
                  className={`project-manager-item${active ? " active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => navigate({ name: "projects", id: project.id })}
                >
                  <span className="project-manager-item-heading">
                    <strong>{project.name}</strong>
                    {project.hidden && <span className="project-hidden-badge">Hidden</span>}
                  </span>
                  <span>{project.unarchivedSessionCount} Session{project.unarchivedSessionCount === 1 ? "" : "s"} · {project.locations.length} Location{project.locations.length === 1 ? "" : "s"}</span>
                  <span>{available > 0 ? `${available} Available` : project.locations.length ? "No Locations Available" : "No Locations"}</span>
                </button>
              );
            })}
            {visibleProjects.length === 0 && (
              <div className="project-manager-empty compact">
                <strong>No Projects Found</strong>
                <span>{allProjects.length ? "Try another search or Inbox visibility filter." : "Create a Project to organize related sessions."}</span>
              </div>
            )}
          </div>
        </aside>
        <main className={`project-manager-detail${selected ? " is-open" : ""}`}>
          {!selected ? (
            <div className="project-manager-empty">
              <strong>{allProjects.length ? "Select a Project" : "Create Your First Project"}</strong>
              <span>{allProjects.length ? "Choose a Project to manage its Locations and sessions." : "Projects remain available even when they have no sessions or every machine is offline."}</span>
              {!allProjects.length && <button type="button" className="btn primary" onClick={() => openDialog({ kind: "create" })}>Create Project</button>}
            </div>
          ) : (
            <>
              <button type="button" className="project-manager-back" onClick={() => navigate({ name: "projects" })}>← Back to Projects</button>
              <div className="project-detail-heading">
                <div>
                  <h2>{selected.name}</h2>
                  <span className="muted project-detail-meta">Project ID: {selected.id}</span>
                  {projectAudienceVisibilitySummary(selected.audience) && (
                    <span className="muted project-detail-meta">{projectAudienceVisibilitySummary(selected.audience)}</span>
                  )}
                </div>
                <span className={`project-visibility-state${selected.hidden ? " is-hidden" : ""}`}>
                  {selected.hidden ? "Hidden from Inbox" : "Shown in Inbox"}
                </span>
              </div>
              {selected.canManage === false && (
                <div className="project-permission-note" role="note">
                  You can view this Project, but you don’t have permission to manage it.
                </div>
              )}
              {error && <div className="form-error project-manager-error" role="alert">{error}</div>}
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
                  <div><strong>{selected.unarchivedSessionCount}</strong><span>Inbox Sessions</span></div>
                  <div><strong>{selected.totalSessionCount}</strong><span>Total Sessions</span></div>
                  <div><strong>{selected.locations.length}</strong><span>Locations</span></div>
                </div>
                <button type="button" className="btn" disabled={selected.canManage === false || busy !== null} onClick={() => void toggleHidden()}>
                  {busy === "visibility" ? "Saving…" : selected.hidden ? "Show Project" : "Hide Project"}
                </button>
              </section>
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
                            ? runnerCapabilityRequirement(runner?.protocolVersion, "hostActions", "Reveal in File Manager")
                            : null;
                      return (
                        <article className="project-location-row" key={location.id}>
                          <div className="project-location-main">
                            <div className="project-location-heading">
                              <strong>{location.name}</strong>
                              {location.isDefault && <span className="project-default-badge">Default</span>}
                              <span className={`project-availability availability-${location.availability}`}>{projectAvailabilityLabel(location.availability)}</span>
                            </div>
                            <code title={location.path}>{location.path}</code>
                            <span className="muted">{display.name} · {display.kind === "ssh" ? "SSH" : "Native Runner"}{count === null ? "" : ` · ${count} Session${count === 1 ? "" : "s"}`}</span>
                            {revealReason && <span className="project-location-reason">{revealReason}</span>}
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
                  {busy === "archive" ? "Archiving…" : "Archive Sessions"}
                </button>
              </section>
              <section className="project-detail-section project-danger-zone" aria-labelledby="project-danger-heading">
                <div className="project-section-heading"><div><h3 id="project-danger-heading">Danger Zone</h3><p>Deleting removes only Project metadata. Sessions and files are retained.</p></div></div>
                <button type="button" className="btn danger" disabled={selected.canManage === false || busy !== null} onClick={() => openDialog({ kind: "delete" })}>Delete Project</button>
              </section>
            </>
          )}
        </main>
      </div>
      {dialog?.kind === "create" && (
        <CreateProjectDialog
          onClose={() => setDialog(null)}
          onCreated={(project) => {
            applyProject(project);
            setDialog(null);
            navigate({ name: "projects", id: project.id });
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
          onClose={() => setDialog(null)}
          onManageConnections={manageConnections}
          onAdd={async (candidate: ProjectLocationCandidate) => {
            const { project } = await api.addProjectLocation(selected.id, { runnerId: candidate.runnerId, workspaceId: candidate.workspaceId });
            applyProject(project);
          }}
          onCreate={async (location) => {
            const { project } = await api.createProjectLocation(selected.id, location);
            applyProject(project);
          }}
        />
      )}
      {dialog?.kind === "delete" && selected && (
        <DeleteProjectDialog project={selected} busy={busy === "delete"} error={error} onClose={() => setDialog(null)} onDelete={deleteProject} />
      )}
    </div>
  );
}
