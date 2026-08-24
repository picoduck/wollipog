import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  type ProjectLocationView,
  type ProjectView,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BoxView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import { useStore } from "../store.js";
import { legacyWorkspaceLocationsByName, workspaceLocationKey } from "../projects.js";
import {
  NO_PROJECT_SELECTION,
  isLaunchableProjectLocation,
  initialProjectSelectionForPreset,
  projectForSessionPreset,
  projectFallbacksAwaitingStore,
  projectLocationForSessionPreset,
  projectInventoryWithFallbacks,
  projectSelectionLabel,
  projectSessionPlacement,
  suggestedProjectLocation,
} from "../project-session-selection.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import { shortenPath } from "../format.js";
import { loadAgentDefaults, saveAgentDefault } from "../agent-defaults.js";
import {
  advancedAgentOptions,
  agentMeta,
  agentOptions,
  currentAgentSelectionIssue,
  isAdvancedAgentId,
  primaryAgentOptions,
  savedAgentSelection,
} from "./agent-options.js";
import { AgentIcon } from "./AgentIcon.js";
import { Modal } from "./common.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { conductorAgentId, type SessionWorkMode } from "../workflow-presets.js";
import { useExperiments } from "../use-experiments.js";
import { handleRovingChoiceKeyDown, rovingChoiceTabIndex } from "./interactions.js";
import { useInstanceScope } from "../instance-scope.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { projectAvailabilityLabel, type ProjectLocationCandidate } from "../project-management.js";
import { agentDisplayName, GENERATED_CONDUCTOR_DISPLAY_NAME } from "../agent-presentation.js";
import { projectAudienceVisibilitySummary } from "../session-project-assignment.js";
import { supportsAgentTui } from "../shells-panel.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

/**
 * New Session is intentionally minimal — pick where it runs (runner + agent + workspace) and go.
 * Model, reasoning effort, approvals, and the first message are all chosen in the chat itself
 * (the composer bar), like the Codex app, so they can be changed per turn.
 */
/** Pre-selection for launches from a project's menu ("Create permanent worktree"). */
export interface NewSessionPreset {
  runnerId?: string;
  workspaceId?: string;
  projectId?: string | null;
  projectLocationId?: string;
  worktree?: boolean;
  /** Legacy workspace-group display name used only with control planes lacking durable Projects. */
  projectName?: string;
}

export function NewSessionDialog({
  onClose,
  onOpenTerminal,
  preset,
}: {
  onClose: () => void;
  onOpenTerminal?: () => void;
  preset?: NewSessionPreset;
}) {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const {
    runners,
    sessions,
    boxes,
    projects: storedProjects,
    projectsSupported,
    projectLocationCreationSupported,
    accessScopeManagementSupported,
    nativeTuiLaunchSupported,
    navigate,
  } = useStore();
  const [projectOverrides, setProjectOverrides] = useState(() => new Map<string, ProjectView>());
  const projects = useMemo(
    () => projectInventoryWithFallbacks(storedProjects, projectOverrides),
    [projectOverrides, storedProjects],
  );
  useEffect(() => {
    setProjectOverrides((current) => {
      const pending = projectFallbacksAwaitingStore(storedProjects, current);
      return pending.size === current.size && [...pending].every(([id, project]) => current.get(id) === project)
        ? current
        : pending;
    });
  }, [projectOverrides, storedProjects]);
  const projectList = useMemo(
    () => [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [projects],
  );
  const online = useMemo(() => [...runners.values()].filter((r) => r.status === "online"), [runners]);
  const boxByRunner = useMemo(() => {
    const m = new Map<string, BoxView>();
    for (const b of boxes.values()) m.set(b.runnerId, b);
    return m;
  }, [boxes]);
  const machineLabels = useMemo(
    () => machineOptionLabels(online, (id) => boxByRunner.get(id)),
    [boxByRunner, online],
  );
  // Legacy control planes have no durable Project inventory. Keep their exact runner/workspace
  // quick-picks during rolling upgrades, but never use this name-based path in Project mode.
  // ones whose runner is online AND still advertises the workspace can host a new session —
  // a stale workspace id would otherwise fall through to some other directory at Create time.
  const locations = useMemo(() => {
    if (projectsSupported || !preset?.projectName) return [];
    return legacyWorkspaceLocationsByName(sessions.values(), preset.projectName).filter((l) => {
      const r = runners.get(l.runnerId);
      return r?.status === "online" && r.workspaces.some((w) => w.id === l.workspaceId);
    });
  }, [preset?.projectName, projectsSupported, sessions, runners]);

  const presetProject = useMemo(
    () => projectsSupported ? projectForSessionPreset(projectList, preset) : null,
    [preset, projectList, projectsSupported],
  );
  const presetProjectLocation = useMemo(
    () => presetProject ? projectLocationForSessionPreset(presetProject, preset) : null,
    [preset, presetProject],
  );
  const initialProjectSelection = initialProjectSelectionForPreset(projectsSupported, presetProject, preset);
  const initialProjectLocation = presetProject
    ? presetProjectLocation ?? (preset?.projectLocationId ? null : suggestedProjectLocation(presetProject, runners))
    : null;
  const [projectSelection, setProjectSelection] = useState(initialProjectSelection);
  const [projectLocationId, setProjectLocationId] = useState(initialProjectLocation?.id ?? "");
  const projectSelectionChangedRef = useRef(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [addingLocation, setAddingLocation] = useState(false);

  const [agentDefaults, setAgentDefaults] = useState(() => loadAgentDefaults(instanceScope));
  const [runnerId, setRunnerId] = useState(
    initialProjectLocation?.runnerId ?? preset?.runnerId ?? (projectsSupported ? "" : online[0]?.runnerId ?? ""),
  );
  const runner = runners.get(runnerId);
  const browseSupported = runnerSupportsProtocol(runner?.protocolVersion, "directoryListing");
  const browseHint = runnerCapabilityRequirement(runner?.protocolVersion, "directoryListing", "Directory browsing");
  const [workspaceId, setWorkspaceId] = useState(
    (preset?.workspaceId && runner?.workspaces.some((w) => w.id === preset.workspaceId)
      ? preset.workspaceId
      : initialProjectLocation?.workspaceId && runner?.workspaces.some((w) => w.id === initialProjectLocation.workspaceId)
        ? initialProjectLocation.workspaceId
      : runner?.workspaces[0]?.id) ?? "",
  );
  // With the experiment off, no conductor exists anywhere in this dialog — not in the plain
  // agent picker and not as the Conductor-Led Work preset; the guard effect below also resets
  // a stranded conductor work mode back to an agent session. Read before the initial options
  // because the first agent selection must already respect it.
  const conductorExperimentEnabled = useExperiments().flags.conductor;
  const initialAgentOptions = agentOptions(runner?.agents ?? [], { includeConductor: conductorExperimentEnabled });
  const initialAgentSelection = savedAgentSelection(initialAgentOptions, agentDefaults[runnerId]);
  const [agentId, setAgentId] = useState(initialAgentSelection.agentId);
  const [workMode, setWorkMode] = useState<SessionWorkMode>("agent");
  const [launchSurface, setLaunchSurface] = useState<"direct" | "native_tui">("direct");
  const [advancedOpen, setAdvancedOpen] = useState(
    () => isAdvancedAgentId(initialAgentOptions, initialAgentSelection.agentId),
  );
  const [useWorktree, setUseWorktree] = useState(preset?.worktree ?? false);
  const [executionTargetId, setExecutionTargetId] = useState("");
  const [cloudBudgetUsd, setCloudBudgetUsd] = useState("");
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>([]);
  const [browsedPath, setBrowsedPath] = useState<string | null>(null); // ad-hoc directory from the browser
  const registeredLocationSelected = !browsedPath && locations.some(
    (location) => location.runnerId === runnerId && location.workspaceId === workspaceId,
  );
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retainedSessionId, setRetainedSessionId] = useState<string | null>(null);
  const selectedProjectId = projectSelection && projectSelection !== NO_PROJECT_SELECTION ? projectSelection : null;
  const selectedProject = selectedProjectId ? projects.get(selectedProjectId) ?? null : null;
  const selectedProjectLocation = selectedProject?.locations.find((location) => location.id === projectLocationId) ?? null;
  const projectLocationLaunchable = !!selectedProjectLocation && isLaunchableProjectLocation(selectedProjectLocation, runners);
  const projectLocationsAvailable = selectedProject?.locations.filter((location) =>
    isLaunchableProjectLocation(location, runners)) ?? [];

  const agentOpts = useMemo(
    () => agentOptions(runner?.agents ?? [], { includeConductor: conductorExperimentEnabled }),
    [runner?.agents, conductorExperimentEnabled],
  );
  const primaryOpts = useMemo(() => primaryAgentOptions(agentOpts), [agentOpts]);
  const advancedOpts = useMemo(() => advancedAgentOptions(agentOpts), [agentOpts]);
  const selectedAgentOption = agentOpts.find((option) => option.agent.id === agentId);
  const executionTargets = (runner?.executionTargets ?? []).filter((target) =>
    (!target.compatibleAgentIds || target.compatibleAgentIds.includes(agentId)) &&
    !((target.adapter === "container" || target.adapter === "cloud") && selectedAgentOption?.agent.context?.kind === "wsl")
  );
  const executionTarget = executionTargets.find((target) => target.id === executionTargetId) ??
    executionTargets.find((target) => target.adapter === "host" &&
      target.workspaceStrategy === (useWorktree ? "worktree" : "in_place"));
  const availableConductorId = conductorExperimentEnabled ? conductorAgentId(runner?.agents ?? []) : undefined;
  const agent = selectedAgentOption?.agent;
  const nativeTuiRunnerSupported = supportsAgentTui(agent?.driver, runner?.protocolVersion, runner?.os);
  const nativeTuiStartFenceSupported = runnerSupportsProtocol(
    runner?.protocolVersion,
    "sessionStartFencedShells",
  );
  const nativeTuiStartFenceHint = runnerCapabilityRequirement(
    runner?.protocolVersion,
    "sessionStartFencedShells",
    "Initial Native TUI launch",
  );
  const nativeTuiHostTarget = !executionTarget || executionTarget.adapter === "host";
  const nativeTuiSupported = nativeTuiLaunchSupported && workMode === "agent" &&
    nativeTuiRunnerSupported && nativeTuiStartFenceSupported &&
    nativeTuiHostTarget && !selectedAgentOption?.disabled;
  const workspace = runner?.workspaces.find((item) => item.id === workspaceId);
  const directoryGrants = !browsedPath && (agent?.driver ?? "acp") === "acp"
    ? (workspace?.additionalDirectoryGrants ?? [])
    : [];
  const savedSelection = savedAgentSelection(agentOpts, agentDefaults[runnerId]);
  const selectionIssue = currentAgentSelectionIssue(agentOpts, agentId, agentDefaults[runnerId]);
  // Browse the runner's filesystem in the selected agent's context (native host vs a WSL distro).
  const browseDistro = agent?.context?.kind === "wsl" ? agent.context.distro : undefined;

  // Keep the selection pointing at a visible option — the raw first agent may be a suppressed ACP
  // duplicate, and switching runners can strand the previous id.
  useEffect(() => {
    if (agentOpts.length && !agentOpts.some((option) => option.agent.id === agentId)) {
      setAgentId(savedSelection.agentId);
    }
  }, [agentOpts, agentId, savedSelection.agentId]);

  const selectAgent = (id: string) => {
    setAgentId(id);
    setAgentDefaults((defaults) => saveAgentDefault(defaults, runnerId, id, instanceScope));
  };

  const selectHostMode = (worktree: boolean) => {
    setUseWorktree(worktree);
    const hostTarget = runner?.executionTargets?.find((target) =>
      target.adapter === "host" && target.workspaceStrategy === (worktree ? "worktree" : "in_place")
    );
    setExecutionTargetId(hostTarget?.id ?? "");
    setCloudBudgetUsd("");
  };

  const selectExecutionTarget = (id: string) => {
    const target = executionTargets.find((candidate) => candidate.id === id);
    if (!target) return;
    setExecutionTargetId(target.id);
    setUseWorktree(target.workspaceStrategy !== "in_place");
    if (target.adapter !== "host") setAdditionalDirectories([]);
    if (target.adapter === "cloud" && target.policy) {
      const current = Number(cloudBudgetUsd);
      if (!Number.isFinite(current) || current < target.policy.cost.minimumBudgetUsd || current > target.policy.cost.maximumBudgetUsd) {
        setCloudBudgetUsd(String(target.policy.cost.minimumBudgetUsd));
      }
    } else {
      setCloudBudgetUsd("");
    }
  };

  const selectWorkMode = (next: SessionWorkMode) => {
    if (next === "conductor") {
      if (!availableConductorId) return;
      setWorkMode("conductor");
      setAgentId(availableConductorId);
      selectHostMode(false);
      return;
    }
    setWorkMode("agent");
    setAgentId(savedSelection.agentId);
  };

  const pickRunner = (id: string) => {
    setRunnerId(id);
    const r = runners.get(id);
    setWorkspaceId(r?.workspaces[0]?.id ?? "");
    const options = agentOptions(r?.agents ?? [], { includeConductor: conductorExperimentEnabled });
    const selection = savedAgentSelection(options, agentDefaults[id]);
    setAgentId(workMode === "conductor" ? (conductorAgentId(r?.agents ?? []) ?? selection.agentId) : selection.agentId);
    setAdvancedOpen(isAdvancedAgentId(options, selection.agentId));
    setBrowsedPath(null);
    setBrowsing(false);
    setAdditionalDirectories([]);
    setExecutionTargetId("");
    setCloudBudgetUsd("");
  };

  // Project location quick-pick: point runner + workspace at an existing (machine, directory).
  // `locations` is pre-filtered to advertised workspaces, so a missing id here means the runner
  // changed under us mid-click — keep the current selection rather than silently falling back
  // to the runner's FIRST workspace (which would create the session in the wrong repo).
  const pickLocation = (loc: { runnerId: string; workspaceId: string }) => {
    const r = runners.get(loc.runnerId);
    if (!r?.workspaces.some((w) => w.id === loc.workspaceId)) return;
    setRunnerId(loc.runnerId);
    setWorkspaceId(loc.workspaceId);
    const options = agentOptions(r.agents, { includeConductor: conductorExperimentEnabled });
    const selection = savedAgentSelection(options, agentDefaults[loc.runnerId]);
    setAgentId(workMode === "conductor" ? (conductorAgentId(r.agents) ?? selection.agentId) : selection.agentId);
    setAdvancedOpen(isAdvancedAgentId(options, selection.agentId));
    setBrowsedPath(null);
    setBrowsing(false);
    setAdditionalDirectories([]);
    setExecutionTargetId("");
    setCloudBudgetUsd("");
  };

  const pickProjectLocation = (location: ProjectLocationView) => {
    setProjectLocationId(location.id);
    pickLocation(location);
  };

  const pickProject = (value: string) => {
    projectSelectionChangedRef.current = true;
    setProjectSelection(value);
    setProjectLocationId("");
    setBrowsedPath(null);
    setBrowsing(false);
    setAdditionalDirectories([]);
    if (value === NO_PROJECT_SELECTION) {
      pickRunner(preset?.runnerId && online.some((candidate) => candidate.runnerId === preset.runnerId)
        ? preset.runnerId
        : online[0]?.runnerId ?? "");
      return;
    }
    const project = projects.get(value);
    if (!project) {
      pickRunner("");
      return;
    }
    const suggested = suggestedProjectLocation(project, runners);
    if (suggested) pickProjectLocation(suggested);
    else pickRunner("");
  };

  const applyProject = (project: ProjectView) => {
    setProjectOverrides((current) => new Map(current).set(project.id, project));
  };

  // A Project preset can arrive before the authoritative Project inventory during socket hydration.
  // Apply it once when it becomes resolvable, but never replace an explicit choice made in the dialog.
  useEffect(() => {
    if (!projectsSupported || projectSelection || projectSelectionChangedRef.current || !presetProject) return;
    setProjectSelection(presetProject.id);
    const location = presetProjectLocation ??
      (preset?.projectLocationId ? null : suggestedProjectLocation(presetProject, runners));
    if (location) pickProjectLocation(location);
    else pickRunner("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetProject, presetProjectLocation, projectSelection, projectsSupported]);

  // If the selected runner goes offline (or one arrives while open), re-sync to an online runner.
  useEffect(() => {
    if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION) return;
    if (!online.some((r) => r.runnerId === runnerId)) {
      pickRunner(online[0]?.runnerId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, projectSelection, projectsSupported]);

  useEffect(() => {
    if (!projectsSupported || !selectedProject || !projectLocationId) return;
    const current = selectedProject.locations.find((location) => location.id === projectLocationId);
    if (!current) {
      setProjectLocationId("");
      pickRunner("");
      return;
    }
    if (current.runnerId !== runnerId || current.workspaceId !== workspaceId) pickLocation(current);
    // Preserve an unavailable selection so the dialog explains the stale exact preset instead of
    // silently launching in another folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectLocationId, projectsSupported, selectedProject, runnerId, workspaceId]);

  useEffect(() => {
    if (workMode === "conductor" && !availableConductorId) {
      setWorkMode("agent");
      setAgentId(savedSelection.agentId);
    }
  }, [workMode, availableConductorId, savedSelection.agentId]);

  useEffect(() => {
    if (launchSurface === "native_tui" && !nativeTuiSupported) setLaunchSurface("direct");
  }, [launchSurface, nativeTuiSupported]);

  // A browsed path may no longer apply once the agent's context (native/WSL) changes.
  useEffect(() => {
    setBrowsedPath(null);
    setBrowsing(false);
    setAdditionalDirectories([]);
    setExecutionTargetId("");
    setCloudBudgetUsd("");
  }, [runnerId, agentId]);

  const cloudBudget = Number(cloudBudgetUsd);
  const cloudBudgetValid = executionTarget?.adapter !== "cloud" || Boolean(executionTarget.policy &&
    Number.isFinite(cloudBudget) && cloudBudget >= executionTarget.policy.cost.minimumBudgetUsd &&
    cloudBudget <= executionTarget.policy.cost.maximumBudgetUsd);
  const projectPlacementValid = !projectsSupported
    ? !!runnerId && (!!workspaceId || !!browsedPath)
    : projectSelection === NO_PROJECT_SELECTION
      ? !!runnerId && (!!workspaceId || !!browsedPath)
      : !!selectedProject && projectLocationLaunchable;
  const valid = projectPlacementValid && !!agentId && !!selectedAgentOption && !selectedAgentOption.disabled &&
    (!executionTarget || executionTarget.available) && cloudBudgetValid &&
    (launchSurface !== "native_tui" || nativeTuiSupported) && !retainedSessionId;

  // Enter submits from any plain field. Exemptions: the directory browser's path input
  // preventDefaults its own Enter (navigate, not submit); buttons keep Enter as click; selects
  // are skipped because Firefox dispatches the Enter that COMMITS an open dropdown choice
  // (Chrome swallows it) — submitting there would create a session mid-configuration. e.repeat
  // drops held-key auto-repeats.
  const submitOnEnter = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.repeat) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
    e.preventDefault();
    void submit();
  };

  const submit = async () => {
    // Re-entrancy guard: the Enter path bypasses the footer button's disabled attribute, and a
    // second submit while createSession is in flight would spawn a duplicate session.
    if (busy) return;
    setError(null);
    if (!valid) {
      if (projectsSupported && !projectSelection) setError("Choose a Project or No Project.");
      else if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION && !projectLocationLaunchable) {
        setError("Choose an available Project Location.");
      } else setError("Pick a runner, workspace, and agent.");
      return;
    }
    setBusy(true);
    try {
      const placement = projectSessionPlacement(
        projectsSupported,
        projectSelection === NO_PROJECT_SELECTION ? null : selectedProject,
        projectSelection === NO_PROJECT_SELECTION ? null : selectedProjectLocation,
        { runnerId, workspaceId },
      );
      const session = await api.createSession({
        ...placement,
        agentId,
        useWorktree,
        executionTargetId: executionTarget?.id,
        config: executionTarget?.adapter === "cloud" ? { costBudgetUsd: cloudBudget } : undefined,
        workspacePath: (!projectsSupported || projectSelection === NO_PROJECT_SELECTION) ? browsedPath ?? undefined : undefined,
        acpSessionContext: additionalDirectories.length ? { additionalDirectories } : undefined,
        ...(launchSurface === "native_tui" ? { launchSurface: "native_tui" as const } : {}),
      });
      navigate({ name: "session", id: session.id });
      if (launchSurface === "native_tui") onOpenTerminal?.();
      onClose();
    } catch (e) {
      if (e instanceof ApiError &&
          (e.code === "NATIVE_TUI_LAUNCH_AMBIGUOUS" ||
            e.code === "NATIVE_TUI_COMPENSATION_FAILED") &&
          typeof e.details?.sessionId === "string") {
        setRetainedSessionId(e.details.sessionId);
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    {!creatingProject && !addingLocation && <Modal
      title="New Session"
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          {retainedSessionId && (
            <button
              className="btn ghost"
              onClick={() => {
                navigate({ name: "session", id: retainedSessionId });
                onClose();
              }}
            >
              Open Retained Session
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !valid}>
            {busy ? "Creating…" : "Create Session"}
          </button>
        </>
      }
    >
      <div className="form" onKeyDown={submitOnEnter}>
        {online.length === 0 && <p className="muted">No runners online. Start a runner first.</p>}
        {projectsSupported && (
            <>
              <label className="field">
                <span>Project</span>
                <select aria-label="Project" value={projectSelection} onChange={(event) => pickProject(event.target.value)}>
                  <option value="">Choose a Project…</option>
                  {projectList.map((project) => {
                    const duplicateName = projectList.some((candidate) => candidate.id !== project.id && candidate.name === project.name);
                    return <option key={project.id} value={project.id}>{projectSelectionLabel(project, duplicateName)}{project.hidden ? " (Hidden)" : ""}</option>;
                  })}
                  <option value={NO_PROJECT_SELECTION}>No Project</option>
                </select>
              </label>
              <div className="new-session-project-actions">
                <span className="muted">
                  {projectSelection === NO_PROJECT_SELECTION
                    ? "This session will run in the selected folder without being added to a Project."
                    : !selectedProject
                      ? "Choose a Project to organize the new session, or choose No Project."
                      : projectAudienceVisibilitySummary(selectedProject.audience)
                      ? `A Project is a durable home across Locations. ${projectAudienceVisibilitySummary(selectedProject.audience)}. New session transcripts use the Project's visibility.`
                      : "A Project is a durable home for related sessions across Locations. This control plane does not report the Project's visibility."}
                </span>
                <button type="button" className="btn ghost sm" onClick={() => setCreatingProject(true)}>Create Project…</button>
              </div>
            </>
          )}

          {projectsSupported && selectedProject && (
            <div className="field">
              <span>Project Location</span>
              {selectedProject.locations.length > 0 ? (
                <div className="loc-picks" role="radiogroup" aria-label="Project Location" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
                  {selectedProject.locations.map((location) => {
                    const r = runners.get(location.runnerId);
                    const display = runnerDisplay(r, boxByRunner.get(location.runnerId), location.runnerId);
                    const selected = location.id === projectLocationId;
                    const launchable = isLaunchableProjectLocation(location, runners);
                    return (
                      <button
                        type="button"
                        key={location.id}
                        role="radio"
                        aria-checked={selected}
                        aria-disabled={!launchable}
                        disabled={!launchable}
                        tabIndex={launchable && (selected || (!projectLocationLaunchable && location.id === projectLocationsAvailable[0]?.id)) ? 0 : -1}
                        className={`loc-pick ${selected ? "on" : ""}`}
                        onClick={() => pickProjectLocation(location)}
                      >
                        <span className="loc-host">
                          {display.name}
                          <span className={`loc-kind loc-${display.kind}`}>{display.kind === "ssh" ? "SSH" : "Local"}</span>
                          <span className={`project-availability availability-${location.availability}`}>{projectAvailabilityLabel(location.availability)}</span>
                        </span>
                        <span className="loc-path" title={location.path}>{shortenPath(location.path)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="project-manager-empty compact">
                  <strong>No Project Locations</strong>
                  <span>Add a Location to this Project before starting a session.</span>
                </div>
              )}
              {selectedProject.locations.length > 0 && projectLocationsAvailable.length === 0 && (
                <span className="project-location-reason">No Locations are currently available. Bring a linked machine online or update this Project’s Locations.</span>
              )}
              {projectLocationsAvailable.length > 1 && !projectLocationId && <span className="muted">Choose a Location for this session.</span>}
              {selectedProjectLocation && !projectLocationLaunchable && projectLocationsAvailable.length > 0 && (
                <span className="project-location-reason">The selected Location is unavailable. Choose another Location.</span>
              )}
              <button
                type="button"
                className="btn ghost sm"
                disabled={selectedProject.canManage === false}
                title={selectedProject.canManage === false ? "Project management permission is required" : undefined}
                onClick={() => setAddingLocation(true)}
              >
                Add Location…
              </button>
              {selectedProject.canManage === false && <span className="muted">You do not have permission to manage this Project’s Locations.</span>}
            </div>
          )}

          {(!projectsSupported || projectSelection === NO_PROJECT_SELECTION) && (
            <>
          {locations.length > 1 && (
            <div className="field">
              <span>Location</span>
              <div className="loc-picks" role="radiogroup" aria-label="Workspace Location" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
                {locations.map((loc, locationIndex) => {
                  const r = runners.get(loc.runnerId);
                  const disp = runnerDisplay(r, boxByRunner.get(loc.runnerId), loc.runnerId);
                  const ws = r?.workspaces.find((w) => w.id === loc.workspaceId);
                  const on = runnerId === loc.runnerId && workspaceId === loc.workspaceId && !browsedPath;
                  return (
                    <button
                      type="button"
                      key={workspaceLocationKey(loc.runnerId, loc.workspaceId)}
                      role="radio"
                      aria-checked={on}
                      tabIndex={rovingChoiceTabIndex(on, registeredLocationSelected, locationIndex)}
                      className={`loc-pick ${on ? "on" : ""}`}
                      onClick={() => pickLocation(loc)}
                    >
                      <span className="loc-host">
                        {disp.name}
                        <span className={`loc-kind loc-${disp.kind}`}>{disp.kind === "ssh" ? "SSH" : "Local"}</span>
                      </span>
                      <span className="loc-path" title={ws?.path}>
                        {ws?.path ? shortenPath(ws.path) : loc.workspaceId}
                      </span>
                    </button>
                  );
                })}
              </div>
              <span className="muted">Choose from {locations.length} known workspace Locations.</span>
            </div>
          )}
          {online.length > 0 && <label className="field">
            <span>Machine</span>
            {online.length === 1 ? (
              // With a single online runner there is nothing to choose — show where it runs.
              <div className="static-pick">
                <span className="cctx-dot online-dot" />
                {runnerDisplay(online[0]!, boxByRunner.get(online[0]!.runnerId), online[0]!.runnerId).name}
              </div>
            ) : (
              <select value={runnerId} onChange={(e) => pickRunner(e.target.value)}>
                {online.map((r) => (
                  <option key={r.runnerId} value={r.runnerId}>
                    {machineLabels.get(r.runnerId)}
                  </option>
                ))}
              </select>
            )}
          </label>}

          {runner && <label className="field">
            <span>Workspace</span>
            {browsedPath ? (
              <div className="ws-chosen">
                <span className="ws-chosen-path" title={browsedPath}>
                  {browsedPath}
                </span>
                <button type="button" className="icon-btn" aria-label="Clear Workspace Selection" title="Clear — use a workspace" onClick={() => setBrowsedPath(null)}>
                  ✕
                </button>
              </div>
            ) : (
              <div className="ws-select">
                <select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setAdditionalDirectories([]); }}>
                  {runner?.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setBrowsing((b) => !b)}
                  disabled={!browseSupported}
                  title={browseSupported ? "Browse the machine for a directory" : browseHint}
                >
                  {browsing ? "Close" : "Browse…"}
                </button>
              </div>
            )}
          </label>}

          {browsing && !browsedPath && runnerId && (
            <DirectoryPicker
              runnerId={runnerId}
              protocolVersion={runner?.protocolVersion}
              distro={browseDistro}
              onPick={(p) => {
                setBrowsedPath(p);
                setBrowsing(false);
              }}
              onCancel={() => setBrowsing(false)}
            />
          )}
            </>
          )}

          {directoryGrants.length > 0 && executionTarget?.adapter === "host" && (
            <fieldset className="field">
              <legend>Additional Directories (Preview)</legend>
              <span className="muted">Each directory expands this ACP agent's workspace access for this session only.</span>
              {directoryGrants.map((path) => (
                <label key={path} className="check-row">
                  <input
                    type="checkbox"
                    checked={additionalDirectories.includes(path)}
                    onChange={(event) => setAdditionalDirectories((current) => event.target.checked
                      ? [...current, path]
                      : current.filter((item) => item !== path))}
                  />
                  <span title={path}>{shortenPath(path)}</span>
                </label>
              ))}
            </fieldset>
          )}

          {/* Hidden entirely — not disabled-with-a-reason — when the experiment is off: unlike a
              missing runner conductor, absence here is this device's own choice, made on the
              Experimental settings page, and a one-option radiogroup would remain. */}
          {conductorExperimentEnabled && <div className="field">
            <span>Preset</span>
            <div className="workflow-preset-grid" role="radiogroup" aria-label="Session Preset" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
              <button type="button" role="radio" aria-checked={workMode === "agent"} tabIndex={workMode === "agent" || !availableConductorId ? 0 : -1} className={`workflow-preset ${workMode === "agent" ? "on" : ""}`} onClick={() => selectWorkMode("agent")}>
                <strong>Agent Session</strong>
                <span>Work directly with one selected provider.</span>
              </button>
              <button type="button" role="radio" aria-checked={workMode === "conductor"} tabIndex={workMode === "conductor" && availableConductorId ? 0 : -1} aria-disabled={!availableConductorId} disabled={!availableConductorId} className={`workflow-preset ${workMode === "conductor" ? "on" : ""}`} onClick={() => selectWorkMode("conductor")}>
                <strong>Conductor-Led Work</strong>
                <span>{availableConductorId ? "Delegate sessions, workflows, gates, and guardrails." : "Requires an available native Claude conductor."}</span>
              </button>
            </div>
          </div>}

          {workMode === "agent" ? <div className="field">
            <label htmlFor="new-session-agent">Agent</label>
            <div className="agent-select">
              <AgentIcon driver={agent?.driver ?? "acp"} agentName={agent?.name} size={15} />
              <select
                id="new-session-agent"
                value={selectedAgentOption?.advanced ? "" : agentId}
                onChange={(e) => selectAgent(e.target.value)}
                aria-label="Agent"
              >
                {selectedAgentOption?.advanced && <option value="">Advanced Agent Selected Below</option>}
                {primaryOpts.map(({ agent: a, label, disabled }) => (
                  <option key={a.id} value={a.id} disabled={disabled}>
                    {disabled ? `${label} (Needs Setup)` : label}
                  </option>
                ))}
              </select>
            </div>
            {agent && <span className="muted agent-meta">{agentMeta(agent)}</span>}
            {selectionIssue && (
              <div className="agent-default-warning" role="alert">
                <span>
                  {selectionIssue === "legacy"
                    ? "Your saved default uses Codex non-interactive mode. Codex App Server is recommended for new sessions."
                    : selectionIssue === "unavailable"
                      ? "The selected agent is unavailable on this runner."
                      : "Your saved default is no longer advertised by this runner."}
                </span>
                {savedSelection.recommendedId && savedSelection.recommendedId !== agentDefaults[runnerId] && (
                  <button type="button" className="btn ghost sm" onClick={() => selectAgent(savedSelection.recommendedId)}>
                    Use Recommended
                  </button>
                )}
              </div>
            )}
          </div> : (
            <div className="field">
              <span>Agent</span>
              <div className="static-pick">
                <AgentIcon driver={agent?.driver ?? "claude-code"} agentName={agent?.name} size={15} />
                {agent ? agentDisplayName(agent) : GENERATED_CONDUCTOR_DISPLAY_NAME}
              </div>
              <span className="muted">Manager reads are pre-approved; every mutation still presents an Allow/Reject card.</span>
            </div>
          )}

          {workMode === "agent" && advancedOpts.length > 0 && (
            <details
              className="advanced-agents"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>Advanced Agents</summary>
              <p className="muted">Non-interactive targets are intended for automation, rollback, or when Codex App Server is unavailable.</p>
              <div className="advanced-agent-picks" role="radiogroup" aria-label="Advanced Agents">
                {advancedOpts.map(({ agent: advanced, label, disabled }) => (
                  <label
                    className={`advanced-agent-pick ${agentId === advanced.id ? "on" : ""}`}
                    key={advanced.id}
                  >
                    <input
                      type="radio"
                      name="advanced-agent"
                      checked={agentId === advanced.id}
                      disabled={disabled}
                      onChange={() => selectAgent(advanced.id)}
                    />
                    <AgentIcon driver={advanced.driver ?? "acp"} agentName={advanced.name} size={13} />
                    <span>{disabled ? `${label} (Needs Setup)` : label}</span>
                  </label>
                ))}
              </div>
            </details>
          )}

          {workMode === "agent" && <div className="field">
            <span>Harness</span>
            <div className="workflow-preset-grid" role="radiogroup" aria-label="Harness" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
              <button
                type="button"
                role="radio"
                aria-checked={launchSurface === "direct"}
                tabIndex={launchSurface === "direct" ? 0 : -1}
                className={`workflow-preset ${launchSurface === "direct" ? "on" : ""}`}
                onClick={() => setLaunchSurface("direct")}
              >
                <strong>Direct</strong>
                <span>Use structured chat, tool events, approval cards, and manager controls.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={launchSurface === "native_tui"}
                tabIndex={launchSurface === "native_tui" ? 0 : -1}
                disabled={!nativeTuiSupported}
                className={`workflow-preset ${launchSurface === "native_tui" ? "on" : ""}`}
                onClick={() => setLaunchSurface("native_tui")}
              >
                <strong>Native TUI</strong>
                <span>Open a separate provider conversation in Terminal. Its activity does not appear in the structured transcript.</span>
              </button>
            </div>
            {!nativeTuiLaunchSupported && (
              <span className="muted">Native TUI launch requires a newer control plane.</span>
            )}
            {nativeTuiLaunchSupported && !nativeTuiRunnerSupported && (
              <span className="muted">Native TUI requires a supported Claude Code or Codex agent on a Windows or Linux runner.</span>
            )}
            {nativeTuiLaunchSupported && nativeTuiRunnerSupported && !nativeTuiStartFenceSupported && (
              <span className="muted">{nativeTuiStartFenceHint}</span>
            )}
            {nativeTuiLaunchSupported && nativeTuiRunnerSupported && nativeTuiStartFenceSupported && !nativeTuiHostTarget && (
              <span className="muted">Native TUI currently runs only on the host execution target.</span>
            )}
            {launchSurface === "native_tui" && (
              <span className="muted">No structured events or approval cards. Manager policy hook status appears after launch.</span>
            )}
          </div>}

          {workMode === "agent" && <div className="field">
            <span>Mode</span>
            {/* §11.1's headline example: this dialog used THREE choice patterns at once inside
                520px — a native select, aria-checked cards, and this bespoke `.seg`. One of them
                goes here; the rest follow as their screens are migrated. */}
            <SegmentedControl
              label="Session Mode"
              value={useWorktree ? "worktree" : "in-place"}
              options={[
                { value: "in-place", label: "In Place" },
                { value: "worktree", label: "Worktree" },
              ]}
              onChange={(mode) => selectHostMode(mode === "worktree")}
            />
            {executionTargets.length > 2 && (
              <label>
                <span>Execution Target</span>
                <select
                  aria-label="Execution Target"
                  value={executionTarget?.id ?? ""}
                  onChange={(event) => selectExecutionTarget(event.target.value)}
                >
                  {executionTargets.map((target) => (
                    <option key={target.id} value={target.id} disabled={!target.available}>
                      {target.name}{target.available ? "" : ` — ${target.unavailableReason ?? "unavailable"}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="muted">
              {useWorktree
                ? "Runs in an isolated git worktree — recommended for code changes."
                : "Runs directly in the workspace directory."}
            </span>
            {executionTarget && (
              <span className="muted">
                Target: {executionTarget.name} · Network {executionTarget.boundaries.network} · Secrets {executionTarget.boundaries.secrets} · Billing {executionTarget.boundaries.billing}
              </span>
            )}
            {executionTarget?.adapter === "cloud" && executionTarget.policy && (
              <label>
                <span>Cloud Cost Budget (USD)</span>
                <input
                  type="number"
                  min={executionTarget.policy.cost.minimumBudgetUsd}
                  max={executionTarget.policy.cost.maximumBudgetUsd}
                  step="0.01"
                  value={cloudBudgetUsd}
                  onChange={(event) => setCloudBudgetUsd(event.target.value)}
                />
                <span className="muted">
                  Estimated ${executionTarget.policy.cost.estimatedHourlyRateUsd}/Hour · Budget ${executionTarget.policy.cost.minimumBudgetUsd}–${executionTarget.policy.cost.maximumBudgetUsd} · {executionTarget.policy.admission.maxConcurrentSessions} Concurrent
                </span>
              </label>
            )}
          </div>}

          <p className="muted new-session-hint">
            {workMode === "conductor"
              ? "Describe the outcome after the session opens; the conductor will propose each manager mutation for approval."
              : "Pick the model, effort, approvals, and your first message once the session opens."}
          </p>
        </div>
    </Modal>}
    {creatingProject && (
      <CreateProjectDialog
        accessScopeManagementSupported={accessScopeManagementSupported}
        onClose={() => setCreatingProject(false)}
        onCreated={(project) => {
          projectSelectionChangedRef.current = true;
          applyProject(project);
          setCreatingProject(false);
          setProjectSelection(project.id);
          setProjectLocationId("");
          pickRunner("");
        }}
      />
    )}
    {addingLocation && selectedProject && (
      <ProjectLocationDialog
        project={selectedProject}
        projects={projectList}
        runners={runners}
        boxes={boxes}
        canCreateLocation={projectLocationCreationSupported}
        accessScopeManagementSupported={accessScopeManagementSupported}
        onClose={() => setAddingLocation(false)}
        onManageConnections={() => {
          setAddingLocation(false);
          onClose();
          navigate({ name: "runners", section: "machines" });
        }}
        onAdd={async (candidate: ProjectLocationCandidate) => {
          const { project } = await api.addProjectLocation(selectedProject.id, {
            runnerId: candidate.runnerId,
            workspaceId: candidate.workspaceId,
          });
          applyProject(project);
          const location = project.locations.find((item) => item.runnerId === candidate.runnerId && item.workspaceId === candidate.workspaceId);
          if (location) pickProjectLocation(location);
        }}
        onCreate={async (created) => {
          const { project } = await api.createProjectLocation(selectedProject.id, created);
          applyProject(project);
          const location = project.locations.find((item) =>
            item.runnerId === created.runnerId && item.path === created.path);
          if (location) pickProjectLocation(location);
        }}
      />
    )}
    </>
  );
}
