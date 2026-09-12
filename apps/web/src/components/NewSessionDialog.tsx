import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  type ProjectLocationView,
  type ProjectView,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BoxView,
  type AgentHarnessDefaultsView,
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
import { shortenPath, permissionModeLabel, titleCaseLabel } from "../format.js";
import { orchestratorUnavailableReason, savedSessionPermissionMode } from "../session-preset-defaults.js";
import { loadAgentDefaults, saveAgentDefault } from "../agent-defaults.js";
import {
  agentMeta,
  agentOptions,
  currentAgentSelectionIssue,
  savedAgentSelection,
} from "./agent-options.js";
import { AgentIcon } from "./AgentIcon.js";
import { Modal } from "./common.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { useInstanceScope } from "../instance-scope.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { nativeTuiAccountingDetail } from "../native-tui-accounting.js";
import { projectAvailabilityLabel, type ProjectLocationCandidate } from "../project-management.js";
import { projectAudienceVisibilitySummary } from "../session-project-assignment.js";
import { supportsAgentTui } from "../shells-panel.js";
import { nativeTuiUnavailableReason } from "../native-tui-availability.js";
import {
  ChoiceCards,
  SearchableCombobox,
  SegmentedControl,
  Select,
  type SearchableComboboxOption,
} from "./ui/ChoiceControls.js";

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
  const projectOptions = useMemo<SearchableComboboxOption<string>[]>(() => {
    const nameCounts = new Map<string, number>();
    for (const project of projectList) nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
    return [
      ...projectList.map((project) => ({
        value: project.id,
        label: `${projectSelectionLabel(project, (nameCounts.get(project.name) ?? 0) > 1)}${project.hidden ? " (Hidden)" : ""}`,
        description: `${project.locations.length} Project Location${project.locations.length === 1 ? "" : "s"}${project.hidden ? ", hidden from the default Projects view" : ""}.`,
      })),
      {
        value: NO_PROJECT_SELECTION,
        label: "No Project",
        description: "Run in the selected folder without adding this session to a Project.",
      },
    ];
  }, [projectList]);
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
  const initialAgentOptions = agentOptions(runner?.agents ?? [], { includeConductor: false });
  const initialAgentSelection = savedAgentSelection(initialAgentOptions, agentDefaults[runnerId]);
  const [agentId, setAgentId] = useState(initialAgentSelection.agentId);
  const [presetOverride, setPresetOverride] = useState<"default" | "orchestrator">("default");
  const [harnessDefaults, setHarnessDefaults] = useState<{
    api: typeof api; scope: typeof instanceScope; view: AgentHarnessDefaultsView | null; error: boolean;
  } | null>(null);
  const [defaultsRetry, setDefaultsRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setHarnessDefaults(null);
    void api.agentHarnessDefaults().then(
      (view) => { if (!cancelled) setHarnessDefaults({ api, scope: instanceScope, view, error: false }); },
      (caught) => {
        if (!cancelled) setHarnessDefaults({
          api, scope: instanceScope, view: null, error: !(caught instanceof ApiError && caught.status === 404),
        });
      },
    );
    return () => { cancelled = true; };
  }, [api, instanceScope, defaultsRetry]);
  const defaultsReady = harnessDefaults?.api === api && harnessDefaults.scope === instanceScope && !harnessDefaults.error;
  const [launchSurface, setLaunchSurface] = useState<"direct" | "native_tui">("direct");
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
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [retainedSessionId, setRetainedSessionId] = useState<string | null>(null);
  const retainedSessionButtonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const generatedFormId = useId();
  const formId = `${generatedFormId}-new-session`;
  const projectInputId = `${generatedFormId}-project`;
  const agentInputId = `${generatedFormId}-agent`;
  const projectLocationOptionsId = `${generatedFormId}-project-locations`;
  const permissionOptionsId = `${generatedFormId}-permission-presets`;
  const harnessOptionsId = `${generatedFormId}-harnesses`;
  const selectedProjectId = projectSelection && projectSelection !== NO_PROJECT_SELECTION ? projectSelection : null;
  const selectedProject = selectedProjectId ? projects.get(selectedProjectId) ?? null : null;
  const selectedProjectLocation = selectedProject?.locations.find((location) => location.id === projectLocationId) ?? null;
  const projectLocationLaunchable = !!selectedProjectLocation && isLaunchableProjectLocation(selectedProjectLocation, runners);
  const projectLocationsAvailable = selectedProject?.locations.filter((location) =>
    isLaunchableProjectLocation(location, runners)) ?? [];

  const agentOpts = useMemo(
    () => agentOptions(runner?.agents ?? [], { includeConductor: false }),
    [runner?.agents],
  );
  const agentComboboxOptions = useMemo<SearchableComboboxOption<string>[]>(() => agentOpts.map((option) => {
    const metadata = agentMeta(option.agent);
    return {
      value: option.agent.id,
      label: option.label,
      description: `${option.advanced ? "Advanced Agent · " : ""}${metadata}`,
      disabled: option.disabled,
      disabledReason: option.disabled ? `Needs setup. ${metadata}` : undefined,
    };
  }), [agentOpts]);
  const selectedAgentOption = agentOpts.find((option) => option.agent.id === agentId);
  const executionTargets = (runner?.executionTargets ?? []).filter((target) =>
    (!target.compatibleAgentIds || target.compatibleAgentIds.includes(agentId)) &&
    !((target.adapter === "container" || target.adapter === "cloud") && selectedAgentOption?.agent.context?.kind === "wsl")
  );
  const executionTarget = executionTargets.find((target) => target.id === executionTargetId) ??
    executionTargets.find((target) => target.adapter === "host" &&
      target.workspaceStrategy === (useWorktree ? "worktree" : "in_place"));
  const agent = selectedAgentOption?.agent;
  const nativeTuiAccountingExplanation = nativeTuiAccountingDetail(agent);
  const savedPermissionMode = savedSessionPermissionMode(defaultsReady ? harnessDefaults?.view ?? null : null, agent);
  const orchestrator = presetOverride === "orchestrator" || savedPermissionMode === "orchestrator";
  const orchestratorContext = agent?.context?.kind ?? "native";
  const directWslOrchestrator = orchestratorContext === "wsl" &&
    ["claude-code", "codex", "codex-app-server"].includes(agent?.driver ?? "acp") &&
    agent?.wslAgentControl?.safeLauncherProtocolVersion === 1 &&
    runnerSupportsProtocol(runner?.protocolVersion, "wslSafeLauncher") &&
    runner?.runtime?.executionIsolation?.mode === "bwrap";
  const hostExecutionTarget = !executionTarget || executionTarget.adapter === "host";
  // Availability is DERIVED from the sentence that explains it, so the two cannot disagree. The
  // preset card is rendered either way now — §11.3 — and a disabled card whose reason contradicted
  // why it was disabled would be worse than the omission it replaced.
  const orchestratorUnavailable = orchestratorUnavailableReason({
    runnerSupportsOrchestration: runnerSupportsProtocol(runner?.protocolVersion, "sessionOrchestration"),
    agentOffersOrchestrator: agent?.capabilities?.permissionModes?.includes("orchestrator") ?? false,
    contextKind: orchestratorContext,
    directWslVerified: directWslOrchestrator,
    hostExecutionTarget,
  });
  const orchestratorSupported = orchestratorUnavailable === undefined;
  const directWslRequiresSafeOrchestrator = orchestratorContext === "wsl" &&
    launchSurface !== "native_tui" && runner?.runtime?.executionIsolation?.mode === "bwrap" &&
    hostExecutionTarget;
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
  const nativeTuiHostTarget = hostExecutionTarget;
  const orchestratorTuiSupported = runnerSupportsProtocol(runner?.protocolVersion, "orchestratorNativeTui");
  const orchestratorTuiHostContext = !orchestrator || (agent?.context?.kind ?? "native") === "native";
  // Availability DERIVED from the sentence that explains it, so the control and its reason cannot
  // disagree. The hand-assembled predicate this replaces enumerated the same conditions a second
  // time, which is how `selectedAgentOption?.disabled` came to grey the option out with no message.
  const nativeTuiUnavailable = nativeTuiUnavailableReason({
    launchSupported: nativeTuiLaunchSupported,
    agentReady: !selectedAgentOption?.disabled,
    orchestrator,
    orchestratorTuiSupported,
    orchestratorTuiHostContext,
    runnerSupported: nativeTuiRunnerSupported,
    startFenceSupported: nativeTuiStartFenceSupported,
    hostExecutionTarget: nativeTuiHostTarget,
    orchestratorTuiRequirement: runnerCapabilityRequirement(
      runner?.protocolVersion, "orchestratorNativeTui", "Orchestrator Native TUI",
    ),
    startFenceHint: nativeTuiStartFenceHint,
  });
  const nativeTuiSupported = nativeTuiUnavailable === undefined;
  const workspace = runner?.workspaces.find((item) => item.id === workspaceId);
  const directoryGrants = !browsedPath && (agent?.driver ?? "acp") === "acp"
    ? (workspace?.additionalDirectoryGrants ?? [])
    : [];
  const savedSelection = savedAgentSelection(agentOpts, agentDefaults[runnerId]);
  const selectionIssue = currentAgentSelectionIssue(agentOpts, agentId, agentDefaults[runnerId]);
  const suggestedAgentOption = agentOpts.find((option) => option.agent.id === savedSelection.recommendedId);
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

  const pickRunner = (id: string) => {
    setRunnerId(id);
    const r = runners.get(id);
    setWorkspaceId(r?.workspaces[0]?.id ?? "");
    const options = agentOptions(r?.agents ?? [], { includeConductor: false });
    const selection = savedAgentSelection(options, agentDefaults[id]);
    setAgentId(selection.agentId);
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
    const options = agentOptions(r.agents, { includeConductor: false });
    const selection = savedAgentSelection(options, agentDefaults[loc.runnerId]);
    setAgentId(selection.agentId);
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
    // An editable combobox can commit its current value again. Unlike a native select, that is a
    // real event, but it is not a new Project decision and must not erase an explicit Location.
    if (value === projectSelection) return;
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
    if (!orchestratorSupported) setPresetOverride("default");
  }, [orchestratorSupported]);

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
    (launchSurface !== "native_tui" || nativeTuiSupported) &&
    (defaultsReady || presetOverride === "orchestrator") &&
    (!orchestrator || orchestratorSupported) &&
    (!directWslRequiresSafeOrchestrator || (orchestrator && orchestratorSupported)) && !retainedSessionId;

  // Keep the secondary shortcut local to this dialog. Unmodified Enter is native form behavior: an
  // open combobox prevents it while committing its option, and a closed single-line input lets it
  // reach the real submit button. Modified Enter works from controls that own plain Enter.
  const submitOnModifiedEnter = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const focusValidationProblem = (selector?: string) => {
    if (!selector) return;
    formRef.current?.querySelector<HTMLElement>(selector)?.focus();
  };

  const submit = async () => {
    // Re-entrancy guard: the Enter path bypasses the footer button's disabled attribute, and a
    // second submit while createSession is in flight would spawn a duplicate session.
    if (busyRef.current) return;
    setError(null);
    if (!valid) {
      if (retainedSessionId) {
        setError("Open the retained session before creating another one.");
        retainedSessionButtonRef.current?.focus();
      } else if (projectsSupported && !projectSelection) {
        setError("Choose a Project or No Project.");
        focusValidationProblem('[role="combobox"][aria-label="Project"]');
      } else if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION && !projectLocationLaunchable) {
        setError("Choose an available Project Location.");
        focusValidationProblem(`[id="${projectLocationOptionsId}"] .ui-choice-card:not([aria-disabled="true"])`);
      } else if (!runnerId) {
        setError("Pick a runner, workspace, and agent.");
        focusValidationProblem('button[aria-label^="Machine:"]');
      } else if (!workspaceId && !browsedPath) {
        setError("Pick a runner, workspace, and agent.");
        focusValidationProblem('button[aria-label^="Workspace:"]');
      } else if (!agentId || !selectedAgentOption || selectedAgentOption.disabled) {
        setError("Pick a runner, workspace, and agent.");
        focusValidationProblem('[role="combobox"][aria-label="Agent"]');
      } else if (!defaultsReady && presetOverride !== "orchestrator") {
        setError(harnessDefaults?.error
          ? "Retry loading saved permission defaults before creating a session."
          : "Wait for saved permission defaults to finish loading.");
        focusValidationProblem('[data-validation-target="defaults"]');
      } else if (orchestrator && !orchestratorSupported) {
        setError("Choose an available Permission Preset.");
        focusValidationProblem(`[id="${permissionOptionsId}"] .ui-choice-card:not([aria-disabled="true"])`);
      } else if (directWslRequiresSafeOrchestrator && !orchestrator) {
        setError("Choose Orchestrator or another execution context.");
        focusValidationProblem(`[id="${permissionOptionsId}"] .ui-choice-card:not([aria-disabled="true"])`);
      } else if (launchSurface === "native_tui" && !nativeTuiSupported) {
        setError("Choose an available Harness.");
        focusValidationProblem(`[id="${harnessOptionsId}"] .ui-choice-card:not([aria-disabled="true"])`);
      } else if (executionTarget && !executionTarget.available) {
        setError("Choose an available Execution Target.");
        focusValidationProblem('button[aria-label^="Execution Target:"]');
      } else if (!cloudBudgetValid) {
        setError("Enter a Cloud Cost Budget within the allowed range.");
        focusValidationProblem('input[type="number"]');
      } else {
        setError("Complete the required session settings before creating a session.");
      }
      return;
    }
    busyRef.current = true;
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
        config: presetOverride === "orchestrator" ? { permissionMode: "orchestrator" }
          : executionTarget?.adapter === "cloud" ? { costBudgetUsd: cloudBudget } : undefined,
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
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <>
    {!creatingProject && !addingLocation && <Modal
      title="New Session"
      onClose={onClose}
      onKeyDown={submitOnModifiedEnter}
      footer={
        <>
          {error && <span className="form-error" role="alert">{error}</span>}
          {retainedSessionId && (
            <button
              ref={retainedSessionButtonRef}
              type="button"
              className="btn ghost"
              onClick={() => {
                navigate({ name: "session", id: retainedSessionId });
                onClose();
              }}
            >
              Open Retained Session
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={busy || !valid}>
            {busy ? "Creating…" : "Create Session"}
          </button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        {online.length === 0 && <p className="muted">No runners online. Start a runner first.</p>}
        {projectsSupported && (
            <>
              <div className="field">
                <label className="new-session-field-label" htmlFor={projectInputId}>Project</label>
                <SearchableCombobox<string>
                  inputId={projectInputId}
                  className="new-session-choice-control"
                  label="Project"
                  value={projectSelection || null}
                  onChange={pickProject}
                  options={projectOptions}
                  placeholder="Choose a Project…"
                  emptyLabel="No Matching Projects"
                />
              </div>
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
                <button type="button" className="btn ghost sm new-session-project-control" onClick={() => setCreatingProject(true)}>Create Project…</button>
              </div>
            </>
          )}

          {projectsSupported && selectedProject && (
            <div className="field">
              <span>Project Location</span>
              {selectedProject.locations.length > 0 ? (
                <ChoiceCards<string>
                  id={projectLocationOptionsId}
                  label="Project Location"
                  value={projectLocationId || null}
                  onChange={(id) => {
                    const location = selectedProject.locations.find((item) => item.id === id);
                    if (location) pickProjectLocation(location);
                  }}
                  options={selectedProject.locations.map((location) => {
                    const display = runnerDisplay(
                      runners.get(location.runnerId),
                      boxByRunner.get(location.runnerId),
                      location.runnerId,
                    );
                    const launchable = isLaunchableProjectLocation(location, runners);
                    return {
                      value: location.id,
                      title: display.name,
                      // The kind and the availability are STATUS, not description: they say what
                      // this Location is and whether it can host a session, which is the whole
                      // basis for choosing between two of them.
                      status: (
                        <>
                          <span className={`loc-kind loc-${display.kind}`}>{display.kind === "ssh" ? "SSH" : "Local"}</span>
                          <span className={`project-availability availability-${location.availability}`}>
                            {projectAvailabilityLabel(location.availability)}
                          </span>
                        </>
                      ),
                      description: <span title={location.path}>{shortenPath(location.path)}</span>,
                      disabled: !launchable,
                      // The availability label already names the cause — Runner Offline, Workspace
                      // Missing, Runner Removed — so the reason restates it as a sentence rather
                      // than inventing a second vocabulary for the same states.
                      disabledReason: launchable
                        ? undefined
                        : `${projectAvailabilityLabel(location.availability)} — this Location cannot host a session right now.`,
                    };
                  })}
                />
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
                className="btn ghost sm new-session-project-control"
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
              {/* The legacy workspace quick-pick, on the same primitive as Project Location so
                  the two read identically. No option here is ever unavailable: `locations` is
                  already filtered to runners that are online and still advertise the workspace. */}
              <ChoiceCards<string>
                label="Workspace Location"
                value={browsedPath ? null : workspaceLocationKey(runnerId, workspaceId)}
                onChange={(key) => {
                  const picked = locations.find(
                    (loc) => workspaceLocationKey(loc.runnerId, loc.workspaceId) === key,
                  );
                  if (picked) pickLocation(picked);
                }}
                options={locations.map((loc) => {
                  const runnerForLocation = runners.get(loc.runnerId);
                  const disp = runnerDisplay(runnerForLocation, boxByRunner.get(loc.runnerId), loc.runnerId);
                  const ws = runnerForLocation?.workspaces.find((w) => w.id === loc.workspaceId);
                  return {
                    value: workspaceLocationKey(loc.runnerId, loc.workspaceId),
                    title: disp.name,
                    status: (
                      <span className={`loc-kind loc-${disp.kind}`}>{disp.kind === "ssh" ? "SSH" : "Local"}</span>
                    ),
                    description: (
                      <span title={ws?.path}>{ws?.path ? shortenPath(ws.path) : loc.workspaceId}</span>
                    ),
                  };
                })}
              />
              <span className="muted">Choose from {locations.length} known workspace Locations.</span>
            </div>
          )}
          {online.length > 0 && <div className="field">
            <span>Machine</span>
            {online.length === 1 ? (
              // With a single online runner there is nothing to choose — show where it runs.
              <div className="static-pick">
                <span className="cctx-dot online-dot" />
                {runnerDisplay(online[0]!, boxByRunner.get(online[0]!.runnerId), online[0]!.runnerId).name}
              </div>
            ) : (
              <Select<string>
                label="Machine"
                value={runnerId || null}
                onChange={pickRunner}
                options={online.map((r) => ({
                  value: r.runnerId,
                  label: machineLabels.get(r.runnerId) ?? r.runnerId,
                }))}
              />
            )}
          </div>}

          {runner && <div className="field">
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
                <Select<string>
                  label="Workspace"
                  value={workspaceId || null}
                  onChange={(value) => { setWorkspaceId(value); setAdditionalDirectories([]); }}
                  options={(runner?.workspaces ?? []).map((w) => ({ value: w.id, label: w.name }))}
                />
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
          </div>}

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
              <ChoiceCards<string>
                multiple
                label="Additional Directories"
                value={additionalDirectories}
                onChange={(path) => setAdditionalDirectories((current) => current.includes(path)
                  ? current.filter((item) => item !== path)
                  : [...current, path])}
                options={directoryGrants.map((path) => ({
                  value: path,
                  title: shortenPath(path),
                  description: <span title={path}>{path}</span>,
                }))}
              />
            </fieldset>
          )}

          <div className="field">
            <label className="new-session-field-label" htmlFor={agentInputId}>Agent</label>
            <div className="agent-select">
              <AgentIcon driver={agent?.driver ?? "acp"} agentName={agent?.name} size={15} />
              <SearchableCombobox<string>
                inputId={agentInputId}
                className="new-session-choice-control"
                label="Agent"
                value={agentId || null}
                onChange={selectAgent}
                options={agentComboboxOptions}
                placeholder="Choose an Agent…"
                emptyLabel="No Matching Agents"
              />
            </div>
            {agent && <span className="muted agent-meta">{agentMeta(agent)}</span>}
            {selectionIssue && (
              <div className="agent-default-warning" role="alert">
                <span>
                  {selectionIssue === "legacy"
                    ? "Your saved default uses Codex non-interactive mode. Codex App Server supports interactive approvals and resumable conversations."
                    : selectionIssue === "unavailable"
                      ? "The selected agent is unavailable on this runner."
                      : "Your saved default is no longer advertised by this runner."}
                </span>
                {suggestedAgentOption && savedSelection.recommendedId !== agentDefaults[runnerId] && (
                  <button type="button" className="btn ghost sm" onClick={() => selectAgent(savedSelection.recommendedId)}>
                    Use {suggestedAgentOption.label}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="field">
            <span>Permission Preset</span>
            {/* Cards rather than the shared Select: two options that each need a sentence is the
                shape ChoiceCard exists for, and hiding them behind a trigger is what produced
                #832's clipping — a 76px menu over 98px of touch targets, with half of one of only
                two choices below the fold. Always visible, there is no menu to mis-measure. */}
            <ChoiceCards<"default" | "orchestrator">
              id={permissionOptionsId}
              label="Permission Preset"
              value={presetOverride}
              onChange={setPresetOverride}
              options={[
                {
                  value: "default",
                  title: !defaultsReady ? "Default (Not Loaded)"
                    : savedPermissionMode ? `Saved Default — ${titleCaseLabel(permissionModeLabel(savedPermissionMode, agent?.driver))}`
                    : "Harness Default",
                  description: "Use the approval behavior saved for this agent harness.",
                },
                {
                  value: "orchestrator",
                  title: "Orchestrator",
                  description: "Manage child sessions without shell or file-write tools. Cannot change after creation.",
                  // Rendered disabled rather than omitted. The list used to drop this option
                  // entirely when unsupported, leaving a one-option control that could not say
                  // whether the runner, the agent, the context or the target was the reason.
                  disabled: !orchestratorSupported,
                  disabledReason: orchestratorUnavailable,
                },
              ]}
            />
            {!defaultsReady && (harnessDefaults?.error ? <>
              <span className="form-error">Could not load saved permission defaults. Retry before using Default.</span>
              <button
                type="button"
                className="btn ghost sm"
                data-validation-target="defaults"
                onClick={() => setDefaultsRetry((value) => value + 1)}
              >
                Retry Defaults
              </button>
            </> : <span className="muted">Loading saved permission defaults…</span>)}
            {orchestrator && <>
              {presetOverride === "default" && <span className="muted">Orchestrator is your saved Agent Harness default. Change it in Settings to use another default.</span>}
              {!orchestratorSupported && <span className="form-error">The saved Orchestrator preset is unavailable here. {orchestratorUnavailable} Choose a compatible target or change the saved default in Settings.</span>}
            </>}
            {directWslRequiresSafeOrchestrator && !orchestrator &&
              <span className="form-error">Direct WSL with bubblewrap is available only through the verified Orchestrator launcher. Choose Orchestrator or another execution context.</span>}
          </div>

          <div className="field">
            <span>Harness</span>
            {/* Two fixed options that each need a sentence: the shape ChoiceCard exists for.
                The six mutually exclusive muted spans that used to sit below this group are now the
                unavailable option's own `disabledReason`, so the control and its explanation arrive
                together instead of as siblings a screen reader meets separately. */}
            <ChoiceCards<"direct" | "native_tui">
              id={harnessOptionsId}
              label="Harness"
              value={launchSurface}
              onChange={setLaunchSurface}
              options={[
                {
                  value: "direct",
                  title: "Direct",
                  description: "Use structured chat, tool events, approval cards, and manager controls.",
                },
                {
                  value: "native_tui",
                  title: "Native TUI",
                  description: "Open a separate provider conversation in Terminal. Usage accounting is unavailable.",
                  // `aria-disabled` rather than the `disabled` attribute the bespoke button used:
                  // that removed the option from the tab order entirely, so a keyboard user could
                  // not reach the reason it is unavailable.
                  disabled: !nativeTuiSupported,
                  disabledReason: nativeTuiUnavailable,
                },
              ]}
            />
            {launchSurface === "native_tui" && (
              <span className="muted">Usage Accounting: Unavailable. No structured events or approval cards. Native TUI spending and tool calls are not included in session usage or parent remaining-budget calculations. Sessions with cost budgets, cost checkpoints, or tool-call limits must use Direct. {nativeTuiAccountingExplanation && <>{nativeTuiAccountingExplanation} </>}Manager policy hook status appears after launch.</span>
            )}
          </div>

          <div className="field">
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
              <div className="field">
                <span>Execution Target</span>
                <Select<string>
                  label="Execution Target"
                  value={executionTarget?.id ?? null}
                  onChange={selectExecutionTarget}
                  options={executionTargets.map((target) => ({
                    value: target.id,
                    label: target.name,
                    // A native <option> cannot render a second line, so the reason used to be
                    // glued onto the label with an em dash. The shared Select has a slot for it.
                    disabled: !target.available,
                    disabledReason: target.available
                      ? undefined
                      : target.unavailableReason ?? "Unavailable on this runner.",
                  }))}
                />
              </div>
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
          </div>

          <p className="muted new-session-hint">
            Pick the model, effort, and your first message once the session opens.
          </p>
        </form>
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
