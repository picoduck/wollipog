import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BoxView, ProjectLocationView, ProjectView, UpdateProjectRequest } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import {
  archiveProjectWithFeedback,
  projectArchiveMessage,
  projectDeleteMessage,
  projectNoLocationsLeftNote,
  projectRemoveLocationMessage,
  sessionCountLabel,
} from "../project-actions.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { sessionArchiveRequiresStop } from "../archive-actions.js";
import {
  filterManagedProjects,
  projectAfterRemoval,
  type LocationMachineName,
  type ProjectVisibilityFilter,
} from "../project-management.js";
import { runnerDisplay } from "../runners.js";
import { projectCreationRetryAvailable, useStoreActions, useStoreSelector } from "../store.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { AccessScopeSettings, useAccessScopeIdentity } from "./AccessScopeControls.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { PlusIcon, ProjectsIcon } from "./Icons.js";
import { DetailBar, PageHeader, type ActionsMenuChoice } from "./PageHeader.js";
import { archiveDetailRows } from "./ProjectSplitMenu.js";
import { backLabel, destination, type ProjectsPane } from "../navigation.js";
import { useIsMobile } from "./useIsMobile.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { ProjectLocationRow, ProjectLocationsEmpty } from "./ProjectLocationRow.js";
import { suggestedProjectLocation } from "../project-session-selection.js";
import { accessScopeLabel } from "../access-scopes.js";
import { writeClipboardText } from "../clipboard.js";
import { DetailSection } from "./DetailSection.js";
import { PROJECT_ACTIONS_LABEL, ProjectDetailHeader, projectDetailMenu, projectNewSessionBlocker } from "./ProjectDetailHeader.js";
import { DetailSkeleton } from "./common.js";
import { Notice } from "./Notice.js";
import { ProjectList } from "./ProjectList.js";
import { ProjectsOverview } from "./ProjectsOverview.js";
import { projectsOverviewAttention } from "../projects-overview.js";
import { State } from "./State.js";

type DialogState =
  | { kind: "create" }
  | { kind: "add-location"; projectId: string; onboarding?: boolean };

/** A failed project action: the sentence the detail's notice leads with, and the raw message behind
 * its Show Details (§13.2). */
interface ProjectActionError {
  sentence: string;
  detail: string;
}

/** A confirmation chosen from a ⋯ sheet replaces it on a phone, and Back brings it back (§7.5).
 * A ⋯ unmounts with what it acts on (a removed location's row, a project gone from the route), so
 * Back from a confirmation whose object has gone reopens nothing. */
const backToMenu = ({ reopen }: ActionsMenuChoice) => ({ label: "Back to More Actions", run: reopen });

const PROJECTS = destination("projects");

export function ProjectsView({
  selectedProjectId,
  pane,
  onNewSession,
}: {
  selectedProjectId?: string;
  /** `/projects/overview`: the Projects Overview as its own route, which a phone opens from the list. */
  pane?: ProjectsPane;
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
  const projectCreationRetrySupported = useStoreSelector(projectCreationRetryAvailable);
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
  const [error, setError] = useState<ProjectActionError | null>(null);
  /** The project whose Delete Project is open. It can go missing meanwhile (a removal before the
   * answer, or a snapshot without it), and the confirmation settles where the route goes once it
   * closes, not the missing-route fallback. */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  /** False once the page has gone: a confirmation that outlives it must not move the route. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const { identity: accessIdentity, error: accessIdentityError } = useAccessScopeIdentity(accessScopeManagementSupported);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  /** The project whose Name field takes focus once its detail shows (the overview's Rename…). */
  const [focusNameOf, setFocusNameOf] = useState<string | null>(null);

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
  /** The list when a confirmation settles, which can be well after it opened. */
  const latestProjects = useRef(allProjects);
  latestProjects.current = allProjects;
  /** The route's project when a confirmation settles, which Back can have changed meanwhile. */
  const routeProjectId = useRef(selectedProjectId);
  routeProjectId.current = selectedProjectId;
  const visibleProjects = useMemo(() => filterManagedProjects(projectMap.values(), query, visibility, machineName),
    [machineName, projectMap, query, visibility]);
  const selected = selectedProjectId ? projectMap.get(selectedProjectId) ?? null : null;
  const dialogProject = dialog?.kind === "add-location" ? projectMap.get(dialog.projectId) ?? null : null;
  // One list for the overview's Needs Attention and the phone's Projects Overview row, so the two
  // counts cannot differ.
  const overviewAttention = useMemo(() => projectsOverviewAttention(allProjects, runners, machineName),
    [allProjects, machineName, runners]);
  const selectedStopsRuntime = selected ? [...sessions.values()].some((session) =>
    session.projectId === selected.id && !session.archived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)
  ) : false;

  useEffect(() => {
    // While its Delete Project is open, the confirmation decides where to go once it closes.
    if (!selected && selectedProjectId && snapshotLoaded && confirmingDelete !== selectedProjectId) {
      const fallback = visibleProjects[0] ?? allProjects[0];
      navigate(fallback ? { name: "projects", id: fallback.id } : { name: "projects" });
    }
  }, [allProjects, confirmingDelete, navigate, selected, selectedProjectId, snapshotLoaded, visibleProjects]);
  // Each pane scrolls on its own (§6). A new route starts the detail at its top; on a phone, where
  // the route swaps the whole screen, focus moves to the new page title, which shows no ring (§16.1).
  const listBodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const routeKey = selectedProjectId ?? pane;
  const previousRoute = useRef(routeKey);
  useLayoutEffect(() => {
    if (previousRoute.current === routeKey) return;
    previousRoute.current = routeKey;
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (isMobile) document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [routeKey, isMobile]);
  // Rename… lands on the Name field once its project's detail is on screen, after the page title
  // has taken focus above, so the field is what keeps it.
  useEffect(() => {
    if (!focusNameOf || selected?.id !== focusNameOf) return;
    setFocusNameOf(null);
    nameInputRef.current?.focus();
  }, [focusNameOf, selected?.id]);
  // A phone hides the list while a detail is open, which loses its scroll position; Back puts the
  // list back where it was (§6.2). Recorded only while the list is on screen.
  const listScrollTop = useRef(0);
  const detailOpen = Boolean(selectedProjectId || pane);
  useLayoutEffect(() => {
    if (!detailOpen && listBodyRef.current) listBodyRef.current.scrollTop = listScrollTop.current;
  }, [detailOpen]);
  useEffect(() => {
    setError(null);
  }, [selected?.id]);
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
  const fail = (sentence: string, cause: unknown) => setError({ sentence, detail: (cause as Error).message });
  /** `failure` is the notice's sentence; null where the form that saved shows its own error. */
  const runProjectMutation = async (key: string, action: () => Promise<ProjectView>, failure: string | null) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      const project = await action();
      applyProject(project);
      return project;
    } catch (cause) {
      if (failure) fail(failure, cause);
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  /** A change from the settings editor, which shows its own failure: the save bar's, or the row's. */
  const updateSettings = async (key: string, changes: UpdateProjectRequest) => {
    if (!selected) return;
    const project = await runProjectMutation(key, async () => (await api.updateProject(selected.id, changes)).project, null);
    if (!project) throw new Error("Another change to this project is still saving.");
  };
  const archiveSessions = async (choice: ActionsMenuChoice) => {
    if (!selected || selected.unarchivedSessionCount === 0) return;
    const count = selected.unarchivedSessionCount;
    // The sessions the page has loaded, with their shared status; the server archives every
    // unarchived one, so those it has not loaded join "and N more" (#2051).
    const { rows, overflow } = archiveDetailRows(
      [...sessions.values()].filter((session) => session.projectId === selected.id && !session.archived),
      count,
    );
    const accepted = await confirm({
      title: selectedStopsRuntime ? `Archive and Stop ${sessionCountLabel(count)}` : `Archive ${sessionCountLabel(count)}`,
      message: projectArchiveMessage({
        projectName: selected.name,
        count,
        stops: selectedStopsRuntime,
        onProjectPage: true,
      }),
      detailRows: rows,
      detailRowsOverflow: overflow,
      confirmLabel: selectedStopsRuntime ? "Archive and Stop" : "Archive Sessions",
      ...(selectedStopsRuntime ? { tone: "danger" as const } : {}),
      back: backToMenu(choice),
    });
    if (!accepted) return;
    setBusy("archive");
    setError(null);
    try {
      await archiveProjectWithFeedback({ projectId: selected.id, projectName: selected.name, api, showToast, showUndo });
    } catch (cause) {
      fail("Couldn't archive the project's sessions.", cause);
    } finally {
      setBusy(null);
    }
  };
  const removeLocation = async (location: ProjectLocationView, choice: ActionsMenuChoice) => {
    if (!selected) return;
    const accepted = await confirm({
      title: "Remove Location",
      message: projectRemoveLocationMessage(selected.name, machineName(location)),
      ...(selected.locations.length === 1
        ? { details: <p className="confirmation-note">{projectNoLocationsLeftNote(selected.name)}</p> }
        : {}),
      // The path is its own mono row rather than wrapping mid-sentence (§11.3).
      detailRows: [{ label: location.path, labelStyle: "mono" }],
      confirmLabel: "Remove Location",
      tone: "danger",
      back: backToMenu(choice),
    });
    if (!accepted) return;
    try {
      await runProjectMutation(`remove:${location.id}`, async () => (await api.removeProjectLocation(selected.id, location.id)).project,
        "Couldn't remove the location.");
      showToast("Location removed. The folder and sessions were not deleted.");
    } catch { /* inline error */ }
  };
  const makeDefault = async (location: ProjectLocationView) => {
    if (!selected) return;
    try {
      await runProjectMutation(`default:${location.id}`, async () => (await api.setDefaultProjectLocation(selected.id, location.id)).project,
        "Couldn't make that location the default.");
    } catch { /* inline error */ }
  };
  const reveal = async (location: ProjectLocationView) => {
    setError(null);
    try {
      await api.revealWorkspace(location.runnerId, location.path);
    } catch (cause) {
      fail("Couldn't reveal the location in the file manager.", cause);
    }
  };
  const deleteProject = async (choice: ActionsMenuChoice) => {
    // One Delete Project at a time: a second would share the first's route suppression.
    if (!selected || busy || confirmingDelete !== null) return;
    const project = selected;
    setError(null);
    // Where to go if the project is gone when the confirmation closes: its neighbour, chosen while
    // the list still holds it, and chosen again as the request is sent. A removal broadcast can
    // arrive before the answer, and a list read after it no longer holds the project.
    let successor = projectAfterRemoval(latestProjects.current, project.id)?.id ?? null;
    // While the confirmation is open it decides where the route goes, not the missing-route fallback.
    setConfirmingDelete(project.id);
    const deleted = await confirm({
      title: "Delete Project",
      message: projectDeleteMessage(project.name, project.totalSessionCount),
      confirmLabel: "Delete Project",
      tone: "danger",
      // A fixed label: a long name would make "Type <name> to Confirm" a paragraph. The helper names it.
      typeToConfirm: project.name,
      typeToConfirmLabel: "Type the Project Name to Confirm",
      progress: "Deleting the project…",
      // The request cannot be withdrawn once sent, so Cancel waits for its answer.
      cancelWhileRunning: false,
      back: backToMenu(choice),
      // The dialog stays open with the button busy, and a failure stays in it with the typed name (§7.4).
      onConfirm: async () => {
        successor = projectAfterRemoval(latestProjects.current, project.id)?.id ?? successor;
        setBusy("delete");
        try {
          await api.deleteProject(project.id);
        } catch (cause) {
          throw new ConfirmationFailure("Couldn't delete the project. Nothing was changed.", (cause as Error).message);
        } finally {
          setBusy(null);
        }
      },
    });
    // Two separate things once the confirmation closes, in one step whatever the order of the
    // answer and any broadcast.
    // 1. Deletion: only a DELETE this client sent and the server confirmed hides the project and
    //    says so. A project that is merely absent (a removal after a lost answer, or a snapshot
    //    without it after access changed) is the store's to show or hide.
    // 2. The route: if the page is still on the project and it is deleted or absent, the route
    //    goes to the neighbour if it is still there, else the first project, else the overview.
    //    A replace, so the route that cannot be shown is not left behind.
    const absent = deleted || !latestProjects.current.some((candidate) => candidate.id === project.id);
    if (absent && mounted.current && routeProjectId.current === project.id) {
      const remaining = latestProjects.current.filter((candidate) => candidate.id !== project.id);
      const next = remaining.find((candidate) => candidate.id === successor) ?? remaining[0] ?? null;
      // Before clearing `confirmingDelete`, so the render that re-enables the fallback sees it.
      navigate(next ? { name: "projects", id: next.id } : { name: "projects" }, { replace: true });
    }
    if (deleted) setDeletedIds((current) => new Set(current).add(project.id));
    setConfirmingDelete(null);
    if (deleted) showToast("Project deleted. Sessions moved to No Project.");
  };
  const manageConnections = () => navigate({ name: "runners", section: "machines" });
  const refreshSelectedProject = async () => {
    if (!selected) return;
    try {
      applyProject((await api.project(selected.id)).project);
      showToast("Access changed.");
    } catch (cause) {
      fail("Access changed, but the project couldn't be reloaded.", cause);
    }
  };
  /** Copies `text` from a ⋯ item and confirms it with a toast that shows what was copied. */
  const copyFromMenu = async (text: string, copiedMessage: string, failedMessage: string) => {
    // ⋯ has handed focus back to its trigger; a write reports, and a refused one falls back, only
    // while the page is mounted and focus is still there or nowhere.
    const from = document.activeElement;
    const current = () => mounted.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === from);
    const copied = await writeClipboardText(text, current);
    if (copied === null) return;
    if (from instanceof HTMLElement && (document.activeElement === document.body || document.activeElement === null)) from.focus();
    if (copied) showToast(copiedMessage, { tone: "success", detail: text, detailStyle: "mono" });
    else showToast(failedMessage, { tone: "error" });
  };
  /** The project with its default location chosen, or the only one that can host a session. With
   * several and no default, New Session asks which. */
  const newSessionPreset = (project: ProjectView): NewSessionPreset => {
    const location = suggestedProjectLocation(project, runners);
    return location
      ? { runnerId: location.runnerId, workspaceId: location.workspaceId, projectId: project.id, projectLocationId: location.id }
      : { projectId: project.id };
  };

  /** The starter setup file onboarding offers for the location it just added. The location exists
   * whatever happens here, so a failure is a warning about the file, not Add Location's error, and
   * the location's ⋯ offers Create Starter Setup File again (#2965). Only a refusal proves there is
   * no file; after a lost reply the warning says so, and the row's own read decides whether its ⋯
   * still offers one. */
  const createStarterSetup = async (project: ProjectView, added: ProjectLocationView | undefined) => {
    const warn = (refused: boolean, raw: string) => showToast(refused
      ? "Location added, but its starter setup file couldn't be created."
      : "Location added, but Wollipog couldn't confirm its starter setup file.", {
      tone: "warning",
      detail: `${refused
        ? "Try again from the location's ⋯ menu."
        : "If the location has none, its ⋯ menu offers Create Starter Setup File."}${raw ? ` ${raw}` : ""}`,
    });
    if (!added) {
      warn(true, "The new location wasn't in Wollipog's reply.");
      return;
    }
    try {
      await api.generateProjectLocationWorktreeSetup(project.id, added.id);
    } catch (cause) {
      warn(cause instanceof ApiError && cause.status < 500,
        cause instanceof Error ? cause.message.trim() : String(cause).trim());
      return;
    }
    // Best effort, as from the location's ⋯: the session's setup suggestion keeps its own Dismiss.
    void api.dismissWorktreeSetupNotice(project.id).catch((cause: unknown) => {
      console.warn("Dismissing the worktree setup notice failed", cause);
    });
  };

  const openProject = (projectId: string) => navigate({ name: "projects", id: projectId });
  const renameProject = (projectId: string) => {
    setFocusNameOf(projectId);
    openProject(projectId);
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
  // On a phone the list and the open project, or the overview, are two routes, so the open detail
  // takes the detail bar and its Back (§4.3, §6.2). The bar sits inside the fill page, where it is full-bleed like
  // every detail bar and shares the column's height with the panes.
  const phoneDetail = isMobile && detailOpen && !spanningEmpty;
  const newSessionBlocker = selected ? projectNewSessionBlocker(selected, runners, machineName) : null;
  // The saved scope, the one the access field below reads, so the two never disagree. A team or a
  // person is named only once the identity directory has loaded; until then the field says it is
  // loading, and the meta line shows no access rather than "Unknown Team".
  const accessLabel = accessScopeManagementSupported && selected?.scope &&
    (accessIdentity !== null || selected.scope.owner.kind === "organization")
    ? accessScopeLabel(selected.scope, accessIdentity) : null;
  const newSession = selected ? {
    label: "New Session",
    disabled: newSessionBlocker !== null,
    onClick: () => onNewSession(newSessionPreset(selected)),
  } : null;
  const detailMenu = selected ? projectDetailMenu(selected, { stopsRuntime: selectedStopsRuntime, busy: busy !== null }, {
    onCopyId: () => void copyFromMenu(selected.id, "Project ID copied.", "Couldn't copy the project ID."),
    onArchive: (choice) => void archiveSessions(choice),
    onDelete: (choice) => void deleteProject(choice),
  }) : [];
  return (
    <section className="page full fill">
      {phoneDetail && (
        <DetailBar
          title={selected?.name ?? (selectedProjectId ? "Project" : "Projects Overview")}
          backLabel={backLabel("projects")}
          onBack={() => navigate({ name: "projects" })}
          primary={newSession ? { ...newSession, icon: <PlusIcon />, title: newSessionBlocker ?? undefined } : undefined}
          menu={detailMenu}
          menuLabel={PROJECT_ACTIONS_LABEL}
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
          onSelect={openProject}
          // On a phone the overview is a route of its own, opened from the list's first row (§6.2).
          overview={isMobile ? { count: overviewAttention.length, onOpen: () => navigate({ name: "projects", pane: "overview" }) } : undefined}
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
            // The default detail (§6.1): /projects beside the list, and /projects/overview on its own.
            // A search changes only the list, so the overview always counts every project.
            <ProjectsOverview
              projects={allProjects}
              attention={overviewAttention}
              machineName={machineName}
              showTitle={!phoneDetail}
              onOpenProject={openProject}
              onAddLocation={(projectId) => openDialog({ kind: "add-location", projectId })}
              onRename={renameProject}
              onNewProject={() => openDialog({ kind: "create" })}
              onConnectMachine={manageConnections}
            />
          ) : (
            // The header, then the notices, then one section recipe in a fixed order (#2959). Each
            // location is a ProjectLocationRow (#2961); Settings, Memory Sharing and Child Session
            // Defaults are setting rows saved by one save bar at the end (ProjectSettings, #2962, #2963).
            <div className="project-detail">
              <ProjectDetailHeader
                project={selected}
                showTitle={!phoneDetail}
                newSession={newSession!}
                blocker={newSessionBlocker}
                menu={detailMenu}
                access={accessLabel}
              />
              {selected.canManage === false && (
                <Notice tone="neutral" compact role="note">You can view this project, but you can't change it.</Notice>
              )}
              {error && (
                <Notice tone="danger" role="alert" onDismiss={() => setError(null)}
                  details={<div className="code-well"><code>{error.detail}</code></div>}>
                  {error.sentence}
                </Notice>
              )}
              {accessIdentityError && (
                <Notice tone="danger" role="alert" details={<div className="code-well"><code>{accessIdentityError}</code></div>}>
                  Access controls couldn't be loaded, so access can't be changed here.
                </Notice>
              )}
              <DetailSection
                title="Locations"
                note="The folders this project runs in; new sessions use the default first when it's available."
                // No Locations carries its own Add Location… (§12.1), so the head's steps aside.
                actions={selected.locations.length > 0 && (
                  <button type="button" className="btn" disabled={selected.canManage === false || busy !== null} onClick={() => openDialog({ kind: "add-location", projectId: selected.id })}>
                    <PlusIcon />
                    <span>Add Location…</span>
                  </button>
                )}
              >
                {selected.locations.length === 0 ? (
                  <ProjectLocationsEmpty
                    canManage={selected.canManage !== false}
                    machineOnline={[...runners.values()].some((runner) => runner.status === "online")}
                    onAdd={() => openDialog({ kind: "add-location", projectId: selected.id })}
                    onOpenConnections={manageConnections}
                  />
                ) : (
                  <ul className="surface project-locations" aria-label="Locations">
                    {selected.locations.map((location) => (
                      <ProjectLocationRow
                        key={location.id}
                        project={selected}
                        location={location}
                        runner={runners.get(location.runnerId)}
                        machine={runnerDisplay(runners.get(location.runnerId), boxByRunner.get(location.runnerId), location.runnerId)}
                        setupSupported={worktreeSetupConfigSupported}
                        accessSupported={accessScopeManagementSupported}
                        identity={accessIdentity}
                        identityError={accessIdentityError}
                        busy={busy !== null}
                        onNewSession={() => onNewSession({
                          runnerId: location.runnerId,
                          workspaceId: location.workspaceId,
                          projectId: selected.id,
                          projectLocationId: location.id,
                        })}
                        onReveal={() => void reveal(location)}
                        onCopyPath={() => void copyFromMenu(location.path, "Path copied.", "Couldn't copy the path.")}
                        onMakeDefault={() => void makeDefault(location)}
                        onRemove={(choice) => void removeLocation(location, choice)}
                        onAccessChanged={() => void refreshSelectedProject()}
                      />
                    ))}
                  </ul>
                )}
              </DetailSection>
              <ProjectSettings
                key={selected.id}
                project={selected}
                busy={busy}
                nameInputRef={nameInputRef}
                access={accessScopeManagementSupported && selected.scope && (
                  <AccessScopeSettings
                    resource={{ kind: "project", projectId: selected.id, name: selected.name, locations: selected.locations }}
                    scope={selected.scope}
                    identity={accessIdentity}
                    readOnly={selected.canManage === false}
                    disabled={busy !== null}
                    onUpdated={() => void refreshSelectedProject()}
                  />
                )}
                runners={runners}
                machine={(runnerId) => runnerDisplay(runners.get(runnerId), boxByRunner.get(runnerId), runnerId)}
                onSave={(changes) => updateSettings("settings", changes)}
                onSetSessionsTab={(shown) => updateSettings("visibility", { hidden: !shown })}
              />
            </div>
          )}
        </div>
      </div>
      )}
      {dialog?.kind === "create" && (
        <CreateProjectDialog
          accessScopeManagementSupported={accessScopeManagementSupported}
          retrySupported={projectCreationRetrySupported}
          projects={allProjects}
          onClose={() => setDialog(null)}
          onCreated={(project) => {
            applyProject(project);
            navigate({ name: "projects", id: project.id });
            setDialog({ kind: "add-location", projectId: project.id, onboarding: true });
          }}
        />
      )}
      {dialog?.kind === "add-location" && dialogProject && (
        <ProjectLocationDialog
          project={dialogProject}
          projects={allProjects}
          runners={runners}
          boxes={boxes}
          canCreateLocation={projectLocationCreationSupported}
          accessScopeManagementSupported={accessScopeManagementSupported}
          onboarding={dialog.onboarding}
          setupFileSupported={worktreeSetupConfigSupported}
          onClose={() => setDialog(null)}
          onManageConnections={manageConnections}
          onAdded={async (project, location, generateSetup) => {
            applyProject(project);
            if (generateSetup) await createStarterSetup(project, location);
          }}
        />
      )}
    </section>
  );
}
