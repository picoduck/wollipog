import { flushSync } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  WORKFLOW_DECISION_CATEGORIES,
  advertisesOrchestratorAdditiveRole,
  type ProjectLocationAvailability,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BoxView,
  type AgentHarnessDefaultsView,
  type CreateSessionRequest,
  type OrchestratorSettingsView,
  type SessionConfig,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { SkillsUnavailableNotice, useSessionSkillsUnavailable } from "./SkillsUnavailableNotice.js";
import { ApiError } from "../api.js";
import { projectCreationRetryAvailable, useStore } from "../store.js";
import { legacyWorkspaceLocationsByName, workspaceLocationKey } from "../projects.js";
import {
  NO_PROJECT_SELECTION,
  isLaunchableProjectLocation,
  initialProjectSelectionForPreset,
  projectForSessionPreset,
  projectFallbacksAwaitingStore,
  projectLocationForSessionPreset,
  projectInventoryWithFallbacks,
  projectSessionPlacement,
  suggestedProjectLocation,
} from "../project-session-selection.js";
import { machineOptionLabels, runnerDisplay } from "../runners.js";
import { permissionModeLabel, titleCaseLabel } from "../format.js";
import {
  controlPlaneSupportsIntegrationIsolation,
  orchestratorPresetPermissionsReason,
  orchestratorUnavailableReason,
  savedSessionPermissionMode,
} from "../session-preset-defaults.js";
import { loadAgentDefaults, saveAgentDefault } from "../agent-defaults.js";
import {
  agentOptions,
  agentSessionLimits,
  agentSetupProblem,
  agentSetupReason,
  currentAgentSelectionIssue,
  savedAgentName,
  savedAgentSelection,
} from "./agent-options.js";
import { AgentIcon } from "./AgentIcon.js";
import { Modal } from "./common.js";
import { AccountIdentifierRevealButton, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { ChooseFolderDialog } from "./ChooseFolderDialog.js";
import { useInstanceScope } from "../instance-scope.js";
import { CreateProjectDialog } from "./CreateProjectDialog.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";
import { projectAvailabilityLabel } from "../project-management.js";
import { BusyButton } from "./ui/BusyButton.js";
import { FieldError } from "./FieldError.js";
import { FieldWarning } from "./FieldWarning.js";
import { statusMeta } from "../status-meta.js";
import { Notice } from "./Notice.js";
import { FullControlLaunchPanel, type FullControlAuthorization } from "./FullControlPreparation.js";
import {
  evaluateOrchestratorPolicy,
  policyDraftFromDefaults,
  type OrchestratorPolicyContext,
  type OrchestratorPolicyDraft,
  type OrchestratorPolicyTab,
} from "../orchestrator-policy.js";
import { OrchestratorPolicyDialog, OrchestratorPolicySummary } from "./OrchestratorPolicyDialog.js";
import { supportsAgentTui } from "../shells-panel.js";
import { nativeTuiUnavailableReason } from "../native-tui-availability.js";
import { BotIcon, BranchIcon, ComputerIcon, FolderIcon, ShieldIcon, TerminalIcon } from "./Icons.js";
import { SessionOptions, describeBoundaries, type SessionOptionsAttention } from "./SessionOptions.js";
import { NumberRow, SegmentedRow, SelectRow, SettingRow, SettingsGroup, ValueRow } from "./ui/SettingsRows.js";
import {
  Checkbox,
  SearchableCombobox,
  Select,
  type PickerFooterAction,
  type SearchableComboboxOption,
  type SelectOption,
  useTapOnlyPicker,
} from "./ui/ChoiceControls.js";

/**
 * A location's availability as the live runner catalog sees it. The stored availability can still
 * read Available while its machine is offline or no longer advertises the folder, and the Location
 * field names what is actually in the way.
 */
function liveLocationAvailability(
  location: ProjectLocationView,
  runners: ReadonlyMap<string, RunnerView>,
): ProjectLocationAvailability {
  if (location.availability !== "available") return location.availability;
  const runner = runners.get(location.runnerId);
  if (runner?.status !== "online") return "runner_offline";
  return runner.workspaces.some((workspace) => workspace.id === location.workspaceId) ? "available" : "workspace_missing";
}

/**
 * A dollar amount as people write it, "$1", "$0.40", without rounding away precision a policy limit
 * has: a minimum of $1.004 reads "$1.004", because "$1.00" would name a value the field refuses.
 */
function usd(amount: number): string {
  return `$${Number.isInteger(amount) ? amount
    : amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 20, useGrouping: false })}`;
}

/** A path cut at its start, so the folder name and its parent stay whole: "…/repos/wollipog". */
function startTruncatedPath(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const segments = path.split(/[\\/]+/u).filter(Boolean);
  return segments.length <= 2 ? path : `…${separator}${segments.slice(-2).join(separator)}`;
}

/** An account's sign-in in the words Switch Account and Choose Another Account use (§11.2). */
function providerAccountDescription(authStatus: "authenticated" | "unauthenticated" | "unknown" | undefined): string {
  const status = authStatus === "authenticated" ? "signed_in"
    : authStatus === "unauthenticated" ? "sign_in_required" : "status_unknown";
  const { label } = statusMeta("provider_account", status);
  return status === "sign_in_required" ? `${label} · Sign in again before using it.` : label;
}

/** Why a chosen location cannot host the session, and what to do about it (§8.5). */
function unavailableLocationSentence(availability: ProjectLocationAvailability, machine: string): string {
  return availability === "workspace_missing"
    ? `${machine} no longer has this folder. Choose another location, or add the folder again.`
    : availability === "runner_removed"
      ? `${machine} was removed. Choose another location, or add one on another machine.`
      : `${machine} is offline. Start it, or add a location on another machine.`;
}

/**
 * A failed create request in one user sentence (§8.5, §13.2). The raw message stays behind Show
 * Details, so nothing the server says is lost.
 */
function createFailureSentence(error: unknown, kept: boolean): string {
  if (kept) return "Wollipog kept the session, but its terminal may not have opened.";
  if (!(error instanceof ApiError)) return "Wollipog couldn't reach the server. Check your connection and try again.";
  if (error.status === 403) return "You don't have permission to start a session here.";
  return "The machine didn't start the session. Check the choices above and try again.";
}

/**
 * New Session asks where a session runs and with which agent. Model, reasoning effort, approvals,
 * and the first message are all chosen in the chat itself (the composer bar), like the Codex app,
 * so they can be changed per turn.
 */
/** The field a submit's validation problem is shown under. `form` is the rare problem no field owns. */
type ProblemField = "project" | "location" | "machine" | "folder" | "agent" | "role" | "harness" | "mode" | "form";
/** The control a submit problem moved focus to, which is described by the problem's error. */
type ProblemControl =
  | "project" | "location" | "add-location" | "machine" | "folder" | "browse" | "agent" | "account"
  | "retained-session" | "open-connections" | "role" | "defaults" | "orchestrator-retry" | "orchestrator"
  | "full-control" | "harness" | "mode" | "execution-target" | "cloud-budget" | "create";

/** The controls that live inside Options, which a submit problem opens before focusing. */
const OPTIONS_CONTROLS: ReadonlySet<ProblemControl> = new Set<ProblemControl>([
  "role", "defaults", "orchestrator-retry", "orchestrator", "full-control",
  "harness", "mode", "execution-target", "cloud-budget",
]);

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
    conn,
    projectCreationRetrySupported,
    accessScopeManagementSupported,
    nativeTuiLaunchSupported,
    orchestratorRoleSupported,
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
  const machineName = (id: string) => runnerDisplay(runners.get(id), boxByRunner.get(id), id).name;
  // A project's option is its name; the second line says where it runs (§9.1). Two projects with
  // one name keep that name in the list, and the closed field adds the machine to tell them apart.
  const projectOptions = useMemo<SearchableComboboxOption<string>[]>(() => {
    const nameOf = (id: string) => runnerDisplay(runners.get(id), boxByRunner.get(id), id).name;
    const primaryOf = (project: ProjectView) => project.locations.find((location) => location.isDefault) ?? project.locations[0];
    // Where each project runs, said no more precisely than its same-named projects need: the machine,
    // then the machine and folder, then a longer path, and the project's id when nothing else differs.
    const qualifiers = new Map<string, string>();
    const sameName = new Map<string, ProjectView[]>();
    for (const project of projectList) sameName.set(project.name, [...(sameName.get(project.name) ?? []), project]);
    for (const group of sameName.values()) {
      if (group.length < 2) continue;
      const levels: Array<(project: ProjectView) => string> = [
        (project) => { const primary = primaryOf(project); return primary ? nameOf(primary.runnerId) : ""; },
        (project) => {
          const primary = primaryOf(project);
          return primary ? `${nameOf(primary.runnerId)} · ${primary.path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? primary.path}` : "";
        },
        (project) => { const primary = primaryOf(project); return primary ? `${nameOf(primary.runnerId)} · ${startTruncatedPath(primary.path)}` : ""; },
        (project) => { const primary = primaryOf(project); return primary ? `${nameOf(primary.runnerId)} · ${primary.path}` : ""; },
      ];
      const level = levels.find((qualify) => {
        const values = group.map(qualify);
        return values.every(Boolean) && new Set(values).size === group.length;
      });
      for (const project of group) {
        const primary = primaryOf(project);
        qualifiers.set(project.id, level
          ? level(project)
          : `${primary ? `${nameOf(primary.runnerId)} · ` : ""}Project ${project.id.slice(-6)}`);
      }
    }
    return [
      ...projectList.map((project) => {
        const primary = primaryOf(project);
        const qualifier = qualifiers.get(project.id);
        const machine = primary ? nameOf(primary.runnerId) : undefined;
        // The second line leads with what tells this project apart: its machine, or more when that
        // alone does not.
        const where = qualifier && qualifier !== machine ? qualifier : machine;
        const count = project.locations.length;
        const summary = !primary ? (where ? `${where} · No locations yet` : "No locations yet")
          : project.locations.every((location) => liveLocationAvailability(location, runners) === "runner_offline")
            ? `${where} · offline`
            : `${where} · ${count} location${count === 1 ? "" : "s"}`;
        return {
          value: project.id,
          label: project.name,
          description: project.hidden ? `Hidden · ${summary}` : summary,
          ...(qualifier ? { selectedLabel: `${project.name} · ${qualifier}` } : {}),
          keywords: project.locations.flatMap((location) => [nameOf(location.runnerId), location.path]),
        };
      }),
      {
        value: NO_PROJECT_SELECTION,
        label: "No Project",
        description: "Run in any folder on a machine, outside a project.",
        separator: true,
      },
    ];
  }, [boxByRunner, projectList, runners]);
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
  // New Project… and Add Location… end their fields' lists (§9.1). New Session stays open under the
  // dialogs they open (§7.1), and closing one returns focus to the field that opened it.
  const newProjectAction: PickerFooterAction = { label: "New Project…", onSelect: () => setCreatingProject(true) };
  const [addingLocation, setAddingLocation] = useState(false);
  const addLocationAction: PickerFooterAction = { label: "Add Location…", onSelect: () => setAddingLocation(true) };
  const locationFieldRef = useRef<HTMLDivElement>(null);
  // The Location control as it is when Add Location closes: its Select, or the No Locations
  // notice's Add Location… while the project has none.
  const locationFocusRef = useMemo(() => ({
    get current() {
      return locationFieldRef.current?.querySelector<HTMLElement>(
        '.ui-select-trigger, [data-validation-target="add-location"]',
      ) ?? null;
    },
  }), []);

  const [agentDefaults, setAgentDefaults] = useState(() => loadAgentDefaults(instanceScope));
  const [runnerId, setRunnerId] = useState(
    initialProjectLocation?.runnerId ?? preset?.runnerId ?? (projectsSupported ? "" : online[0]?.runnerId ?? ""),
  );
  const runner = runners.get(runnerId);
  const browseSupported = runnerSupportsProtocol(runner?.protocolVersion, "directoryListing");
  const browseHint = runnerCapabilityRequirement(runner?.protocolVersion, "directoryListing", "directory browsing");
  const [workspaceId, setWorkspaceId] = useState(
    (preset?.workspaceId && runner?.workspaces.some((w) => w.id === preset.workspaceId)
      ? preset.workspaceId
      : initialProjectLocation?.workspaceId && runner?.workspaces.some((w) => w.id === initialProjectLocation.workspaceId)
        ? initialProjectLocation.workspaceId
      : runner?.workspaces[0]?.id) ?? "",
  );
  const initialAgentOptions = agentOptions(runner?.agents ?? []);
  const initialAgentSelection = savedAgentSelection(initialAgentOptions, agentDefaults[runnerId], runner?.agents);
  const [agentId, setAgentId] = useState(initialAgentSelection.agentId);
  const [providerAccountId, setProviderAccountId] = useState("");
  // `undefined` until the user chooses: a saved Orchestrator harness default then selects the role
  // on the user's behalf, exactly as the saved preset did before the role became independent.
  const [roleOverride, setRoleOverride] = useState<"normal" | "orchestrator" | undefined>(undefined);
  // The Orchestrator policy this session launches with (#2955): the saved defaults and the changes
  // the Orchestrator Policy dialog applied. The dialog edits a copy; only Apply Policy changes this.
  const [policyDraft, setPolicyDraft] = useState<OrchestratorPolicyDraft>(
    () => policyDraftFromDefaults(DEFAULT_ORCHESTRATOR_DEFAULTS),
  );
  // The tab the Orchestrator Policy dialog opens on, while it is open.
  const [editingPolicy, setEditingPolicy] = useState<OrchestratorPolicyTab | null>(null);
  const customizeRef = useRef<HTMLButtonElement>(null);
  const [fullControlAuthorization, setFullControlAuthorization] = useState<FullControlAuthorization | null>(null);
  const [harnessDefaults, setHarnessDefaults] = useState<{
    api: typeof api; scope: typeof instanceScope; view: AgentHarnessDefaultsView | null; error: boolean;
  } | null>(null);
  const [defaultsRetry, setDefaultsRetry] = useState(0);
  const [orchestratorSettings, setOrchestratorSettings] = useState<{
    api: typeof api; scope: typeof instanceScope; view: OrchestratorSettingsView | null; error: string | null;
  } | null>(null);
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
  useEffect(() => {
    let cancelled = false;
    setOrchestratorSettings(null);
    void api.orchestratorSettings().then(
      (view) => {
        if (cancelled) return;
        setOrchestratorSettings({ api, scope: instanceScope, view, error: null });
        setPolicyDraft(policyDraftFromDefaults(view.defaults));
      },
      (caught) => {
        if (cancelled) return;
        setOrchestratorSettings({
          api,
          scope: instanceScope,
          view: null,
          // One sentence for every failure (§13.2): the raw error says nothing a person can act on,
          // and Retry is the way forward either way.
          error: "Couldn't load your Orchestrator defaults.",
        });
      },
    );
    return () => { cancelled = true; };
  }, [api, instanceScope, defaultsRetry]);
  const orchestratorSettingsReady = orchestratorSettings?.api === api &&
    orchestratorSettings.scope === instanceScope && !!orchestratorSettings.view;
  const [launchSurface, setLaunchSurface] = useState<"direct" | "native_tui">("direct");
  const [useWorktree, setUseWorktree] = useState(preset?.worktree ?? false);
  const [executionTargetId, setExecutionTargetId] = useState("");
  const [cloudBudgetUsd, setCloudBudgetUsd] = useState("");
  const [additionalDirectories, setAdditionalDirectories] = useState<string[]>([]);
  const [browsedPath, setBrowsedPath] = useState<string | null>(null); // ad-hoc directory from the browser
  const registeredLocationSelected = !browsedPath && locations.some(
    (location) => location.runnerId === runnerId && location.workspaceId === workspaceId,
  );
  // Browse… stacks Choose Folder over this dialog (#2271), and focus comes back to it.
  const [choosingFolder, setChoosingFolder] = useState(false);
  const browseButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceRowRef = useRef<HTMLDivElement>(null);
  // Use a Workspace unmounts itself; once the commit shows the picker again, focus moves to it.
  const workspacePickerRestoredRef = useRef(false);
  // Options (#2954): one closed row until something inside needs attention or the person opens it.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const skillsNoticeRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // A submit that finds a problem names it under the field it is about (§8.5) and focuses that field.
  const [fieldProblem, setFieldProblem] = useState<{
    field: ProblemField; message: string; control?: ProblemControl;
  } | null>(null);
  const [requestFailure, setRequestFailure] = useState<{ sentence: string; detail: string } | null>(null);
  const [retainedSessionId, setRetainedSessionId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const projectChoiceRef = useRef<HTMLDivElement>(null);
  // The Project control as it is when the dialog above it closes: the combobox, or on touch the
  // Select trigger, whichever this width renders. Read then, because the width may have changed.
  const projectPickerFocusRef = useMemo(() => ({
    get current() {
      return projectChoiceRef.current?.querySelector<HTMLElement>(
        '[role="combobox"][aria-label="Project"], button[aria-label^="Project:"]',
      ) ?? null;
    },
  }), []);
  const agentChoiceRef = useRef<HTMLDivElement>(null);
  const generatedFormId = useId();
  const formId = `${generatedFormId}-new-session`;
  const projectInputId = `${generatedFormId}-project`;
  const agentInputId = `${generatedFormId}-agent`;
  const folderInputId = `${generatedFormId}-folder`;
  const browseReasonId = `${generatedFormId}-browse-reason`;
  const touchChoicePicker = useTapOnlyPicker();
  const initialProjectAutoFocusRef = useRef(projectsSupported && !touchChoicePicker);
  useLayoutEffect(() => {
    // React's autoFocus runs when the editable Project owner mounts. Consume that one-time claim
    // after the opening commit so a later touch-to-desktop presentation swap cannot steal focus.
    initialProjectAutoFocusRef.current = false;
  }, []);
  // Opened with a project already chosen (from that project's sessions), Project holds focus with
  // its name selected and the list closed, so the first character typed replaces the name with a
  // search instead of extending it.
  useEffect(() => {
    const input = projectChoiceRef.current?.querySelector<HTMLInputElement>(".ui-searchable-combobox-input");
    if (input && document.activeElement === input && input.value) input.select();
  }, []);
  const previousTouchChoicePickerRef = useRef(touchChoicePicker);
  // Capture ownership DURING render, while the old control is still mounted. By the time a layout
  // effect runs after the media-query change, React has replaced the focused input or listbox and
  // the browser has already fallen back to <body>. This is the same boundary used for request and
  // rail focus handoffs elsewhere in the app.
  const focusedElementBeforeRender = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null;
  const responsiveChoiceFocusBeforeRender = previousTouchChoicePickerRef.current !== touchChoicePicker
    ? projectChoiceRef.current?.contains(focusedElementBeforeRender) ? "project"
      : agentChoiceRef.current?.contains(focusedElementBeforeRender) ? "agent"
        : null
    : null;
  useLayoutEffect(() => {
    const presentationChanged = previousTouchChoicePickerRef.current !== touchChoicePicker;
    previousTouchChoicePickerRef.current = touchChoicePicker;
    if (!presentationChanged || !responsiveChoiceFocusBeforeRender) return;
    const region = responsiveChoiceFocusBeforeRender === "project" ? projectChoiceRef.current : agentChoiceRef.current;
    const replacement = touchChoicePicker
      ? region?.querySelector<HTMLButtonElement>(".ui-select-trigger")
      : region?.querySelector<HTMLInputElement>(".ui-searchable-combobox-input");
    replacement?.focus();
  }, [responsiveChoiceFocusBeforeRender, touchChoicePicker]);
  const problemId = (field: ProblemField) => `${generatedFormId}-${field}-error`;
  const locationHelperId = `${generatedFormId}-location-helper`;
  const blockedReasonId = `${generatedFormId}-blocked-reason`;
  const cloudBudgetInputId = `${generatedFormId}-cloud-budget`;
  // Sentences that describe the control a problem with no field error of its own lands on.
  const noLocationsId = `${generatedFormId}-no-locations`;
  const noMachinesId = `${generatedFormId}-no-machines`;
  const failureSentenceId = `${generatedFormId}-failure`;
  const accountReasonId = `${generatedFormId}-account-reason`;
  const policyFailureId = `${generatedFormId}-policy-failure`;
  const selectedProjectId = projectSelection && projectSelection !== NO_PROJECT_SELECTION ? projectSelection : null;
  const selectedProject = selectedProjectId ? projects.get(selectedProjectId) ?? null : null;
  const selectedProjectLocation = selectedProject?.locations.find((location) => location.id === projectLocationId) ?? null;
  const projectLocationLaunchable = !!selectedProjectLocation && isLaunchableProjectLocation(selectedProjectLocation, runners);
  const projectLocationsAvailable = selectedProject?.locations.filter((location) =>
    isLaunchableProjectLocation(location, runners)) ?? [];

  const agentOpts = useMemo(
    () => agentOptions(runner?.agents ?? []),
    [runner?.agents],
  );
  const savedSelection = savedAgentSelection(agentOpts, agentDefaults[runnerId], runner?.agents);
  // The saved default this machine can start: the list leads with it and says so.
  const savedDefaultAgentId = agentDefaults[runnerId] && !savedSelection.issue ? savedSelection.agentId : "";
  const agentMachine = runner ? machineName(runnerId) : "";
  const agentAvailabilityVerified = runnerSupportsProtocol(runner?.protocolVersion, "verifiedAgentAvailability");
  // Ready on the machine first, led by the saved default, then Needs Setup, each in agentOptions'
  // family order (#2953). A second line only says what changes the choice: the default, which
  // installation, how the agent limits the session, or, for one that can't start, the fix.
  const agentComboboxOptions = useMemo<SearchableComboboxOption<string>[]>(() => {
    const ready = agentOpts.filter((option) => !option.disabled);
    return [
      ...ready.filter((option) => option.agent.id === savedDefaultAgentId),
      ...ready.filter((option) => option.agent.id !== savedDefaultAgentId),
      ...agentOpts.filter((option) => option.disabled),
    ].map((option) => {
      // The installation's path names its executable; the folder holding it tells two apart.
      const path = option.installationPath;
      const folder = path ? startTruncatedPath(path.replace(/[\\/]+[^\\/]*$/u, "") || path) : undefined;
      const description = [
        !option.disabled && option.agent.id === savedDefaultAgentId ? "Your default on this machine" : undefined,
        folder,
        ...(option.disabled ? [] : agentSessionLimits(option.agent)),
      ].filter(Boolean).join(" · ");
      return {
        value: option.agent.id,
        label: option.name,
        ...(folder ? { selectedLabel: `${option.name} · ${folder}` } : {}),
        group: option.disabled ? "Needs Setup" : `Ready on ${agentMachine}`,
        ...(description ? { description } : {}),
        disabled: option.disabled,
        disabledReason: option.disabled
          ? agentSetupReason(option.agent, agentMachine, agentAvailabilityVerified)
          : undefined,
      };
    });
  }, [agentOpts, savedDefaultAgentId, agentMachine, agentAvailabilityVerified]);
  const selectedAgentOption = agentOpts.find((option) => option.agent.id === agentId);
  const executionTargets = (runner?.executionTargets ?? []).filter((target) =>
    (!target.compatibleAgentIds || target.compatibleAgentIds.includes(agentId)) &&
    !((target.adapter === "container" || target.adapter === "cloud") && selectedAgentOption?.agent.context?.kind === "wsl")
  );
  const executionTarget = executionTargets.find((target) => target.id === executionTargetId) ??
    executionTargets.find((target) => target.adapter === "host" &&
      target.workspaceStrategy === (useWorktree ? "worktree" : "in_place"));
  const agent = selectedAgentOption?.agent;
  // Run On is offered only when the machine has more than its two host placements.
  const runOnOffered = executionTargets.length > 2;
  // The skills a container or cloud target can't see, named before creation as the session names
  // them after it (#2954).
  const skillsUnavailable = useSessionSkillsUnavailable({ runnerId, agentId, adapter: executionTarget?.adapter });
  // Choosing such a target brings its notice into view once, when it first shows in open Options.
  const skillsNoticeScrolledRef = useRef(false);
  useEffect(() => {
    if (!skillsUnavailable) skillsNoticeScrolledRef.current = false;
    else if (optionsOpen && !skillsNoticeScrolledRef.current && skillsNoticeRef.current) {
      skillsNoticeScrolledRef.current = true;
      skillsNoticeRef.current.scrollIntoView?.({ block: "nearest" });
    }
  }, [optionsOpen, skillsUnavailable]);
  // Inside the Agent field (§8.4), so its left edge lines up with Project's and every other field's.
  const agentIcon = <AgentIcon driver={agent?.driver ?? "acp"} agentName={agent?.name} size={16} />;
  const provider = agent?.driver === "claude-code" ? "claude"
    : agent?.driver === "codex" || agent?.driver === "codex-app-server" ? "codex" : null;
  const providerAccounts = (runner?.providerAccounts ?? []).filter((account) =>
    account.provider === provider &&
    ((agent?.context?.kind ?? "native") === "native" || account.id === agent?.defaultProviderAccountId));
  const savedProviderAccount = (agent?.context?.kind ?? "native") === "native"
    ? runner?.providerAccountDefaults?.find((choice) => choice.provider === provider)
    : undefined;
  const savedProviderAccountMissing = !!savedProviderAccount?.accountId &&
    !providerAccounts.some((account) => account.id === savedProviderAccount.accountId);
  const providerAccountTitles = maskedAccountTitles(providerAccounts.map((account) => account.label));
  // Bound to this exact account list: another Machine or Agent offers other accounts, hidden again.
  const [accountIdentifiersRevealed, toggleAccountIdentifiers] = useAccountIdentifierReveal(
    JSON.stringify([runnerId, agentId, providerAccountId, providerAccounts.map((account) => [account.id, account.label])]),
  );
  const accountSelectionKey = `${runnerId}\0${agentId}`;
  const previousAccountSelectionKey = useRef(accountSelectionKey);
  const accountChosenByUser = useRef(false);
  useEffect(() => {
    const selectionChanged = previousAccountSelectionKey.current !== accountSelectionKey;
    previousAccountSelectionKey.current = accountSelectionKey;
    if (selectionChanged) accountChosenByUser.current = false;
    if (accountChosenByUser.current && providerAccounts.some((account) => account.id === providerAccountId)) return;
    accountChosenByUser.current = false;
    const preferred = savedProviderAccount?.accountId ?? agent?.defaultProviderAccountId;
    setProviderAccountId(savedProviderAccountMissing ? "" :
      providerAccounts.find((account) => account.id === preferred)?.id ?? providerAccounts[0]?.id ?? "");
  }, [accountSelectionKey, agent?.defaultProviderAccountId, savedProviderAccount?.accountId,
    savedProviderAccountMissing, providerAccountId, providerAccounts.map((account) => account.id).join("\0")]);
  const savedPermissionMode = savedSessionPermissionMode(defaultsReady ? harnessDefaults?.view ?? null : null, agent);
  const savedPiModeUnavailableForTarget = agent?.driver === "pi" && executionTarget !== undefined &&
    executionTarget.adapter !== "host" && savedPermissionMode !== undefined &&
    savedPermissionMode !== "bypassPermissions" && savedPermissionMode !== "orchestrator";
  const savedOrchestratorDefault = savedPermissionMode === "orchestrator";
  const orchestrator = roleOverride === "orchestrator" || (roleOverride === undefined && savedOrchestratorDefault);
  const orchestratorContext = agent?.context?.kind ?? "native";
  const directWslOrchestrator = orchestratorContext === "wsl" &&
    ["claude-code", "codex", "codex-app-server"].includes(agent?.driver ?? "acp") &&
    agent?.wslAgentControl?.safeLauncherProtocolVersion === 1 &&
    runnerSupportsProtocol(runner?.protocolVersion, "wslSafeLauncher") &&
    runner?.runtime?.executionIsolation?.mode === "bwrap";
  const hostExecutionTarget = !executionTarget || executionTarget.adapter === "host";
  const missingRequiredAccountChoice = hostExecutionTarget && savedProviderAccountMissing && !providerAccountId;
  // Availability is DERIVED from the sentence that explains it, so the two cannot disagree. The
  // preset card is rendered either way now — §11.3 — and a disabled card whose reason contradicted
  // why it was disabled would be worse than the omission it replaced.
  // Two independent advertisements (#1294): the "orchestrator" permission mode says the COUPLED
  // PRESET is launchable here (including its strict filesystem boundary), while
  // `orchestratorAdditive` says the ROLE is launchable with ordinary provider permissions. A
  // bridge-verified Pi installation on a runner using the default `provider` isolation offers the
  // second and not the first, so reading only the mode hid the role entirely.
  const agentOffersOrchestratorPreset = agent?.capabilities?.permissionModes?.includes("orchestrator") === true;
  const agentOffersAdditiveRole = advertisesOrchestratorAdditiveRole(agent?.driver ?? "acp", agent?.capabilities);
  const orchestratorUnavailable = orchestratorUnavailableReason({
    runnerSupportsOrchestration: runnerSupportsProtocol(runner?.protocolVersion, "sessionOrchestration"),
    agentOffersOrchestrator: agentOffersOrchestratorPreset || agentOffersAdditiveRole,
    agentOrchestratorRequirement: agent?.codexAppServer?.orchestratorApproval?.failure,
    agentName: selectedAgentOption?.label,
    contextKind: orchestratorContext,
    directWslVerified: directWslOrchestrator,
    hostExecutionTarget,
  });
  const orchestratorSupported = orchestratorUnavailable === undefined;
  const executionPolicySupported = runnerSupportsProtocol(runner?.protocolVersion, "orchestratorExecutionPolicy");
  // Strict Project Isolation is delivered only by the coupled preset, so an installation that
  // offers just the additive role cannot provide it however good its filesystem boundary is.
  const strictProjectBoundaryAvailable = agentOffersOrchestratorPreset &&
    (directWslOrchestrator || (orchestratorContext === "native" && (
    agent?.driver === "codex" || agent?.driver === "codex-app-server"
      ? runner?.os === "linux" || runner?.os === "macos"
      : agent?.driver === "claude-code"
        ? ((runner?.os === "linux" && runner?.runtime?.executionIsolation?.mode === "bwrap") ||
          (runner?.os === "macos" && runner?.runtime?.executionIsolation?.mode === "seatbelt")) &&
          agent.capabilities?.permissionModes?.includes("dontAsk") === true
        : agent?.driver === "acp"
          ? (runner?.os === "linux" && runner?.runtime?.executionIsolation?.mode === "bwrap") ||
            (runner?.os === "macos" && runner?.runtime?.executionIsolation?.mode === "seatbelt")
          : false
  )));
  // Why the coupled preset sets an Orchestrator's permissions under a given Strict Project
  // Isolation, or undefined when it doesn't: the sentence that explains why the preset still applies
  // is also what decides that it applies. The dialog asks it for its own draft.
  const presetReasonFor = (strictProjectIsolation: boolean) => orchestratorPresetPermissionsReason({
    controlPlaneSupportsRole: orchestratorRoleSupported,
    runnerProtocolVersion: runner?.protocolVersion,
    driver: agent?.driver ?? "acp",
    contextKind: orchestratorContext,
    hostExecutionTarget,
    nativeTui: launchSurface === "native_tui",
    strictProjectIsolation,
    savedOrchestratorDefault,
  });
  // Which shape a non-strict Orchestrator would actually launch with. This forces Strict Project
  // Isolation off, because that is the only setting under which the availability derived from it is
  // consulted, and the two non-strict shapes have genuinely different preconditions.
  const nonStrictPresetPermissions = presetReasonFor(false) !== undefined;
  const providerExecutionAvailable = executionPolicySupported && orchestratorContext === "native" &&
    (nonStrictPresetPermissions
      // The non-strict COUPLED preset. It requires the PRESET advertisement, because a preset launch
      // submits `permissionMode: "orchestrator"` and the control plane refuses that mode from an
      // installation that does not advertise it. The two advertisements diverge for real since
      // #1308 — a Codex CLI without granular approvals now offers the additive role and not the
      // preset — so reading the additive one here would submit a launch creation answers with 409.
      // Pi (#1294) has no non-strict preset shape at all, and Codex's preset still forces
      // `sandbox_mode="workspace-write"`, which is audited on Linux and macOS only.
      ? agentOffersOrchestratorPreset &&
        ["codex", "codex-app-server", "claude-code"].includes(agent?.driver ?? "acp") &&
        (agent?.driver === "claude-code" || runner?.os === "linux" || runner?.os === "macos")
      // The ADDITIVE role: exactly the runner's own attestation, which is also what the control
      // plane checks, so the dialog cannot offer a launch creation refuses. Read that attestation
      // rather than `agent.piAgentControl`, which `agentsForControlPlane` deliberately clears
      // before publishing and the control-plane database never persists. It carries no platform
      // condition for Codex (#1308): the additive launch injects no sandbox, approval, or reviewer
      // setting, so the session keeps whatever its selected permission mode gives a normal Codex
      // session on that platform.
      : agentOffersAdditiveRole) &&
    (agent?.driver !== "claude-code" ||
      (agent.capabilities?.supportsApprovals === true &&
        agent.capabilities.permissionModes?.includes("default") === true));
  const orchestratorPresetReason = orchestrator
    ? presetReasonFor(policyDraft.values.execution.strictProjectIsolation)
    : undefined;
  const providerPermissionsPreset = orchestrator && orchestratorPresetReason !== undefined;
  // Strict Project Isolation, and every coupled-preset launch, already launches without provider
  // integrations. The control is then implied rather than independent, and the server stores the
  // same `true`, so the request withholds the choice in that state.
  const integrationIsolationImplied = policyDraft.values.execution.strictProjectIsolation ||
    providerPermissionsPreset;
  const effectiveIntegrationIsolation = integrationIsolationImplied ||
    policyDraft.values.execution.integrationIsolation;
  // An older control plane's override parser rejects `execution.integrationIsolation` outright; its
  // settings payload echoes the field only if it knows it.
  const integrationIsolationControlPlane = controlPlaneSupportsIntegrationIsolation(
    orchestratorSettings?.view?.defaults,
  );
  // The policy (#2955): one evaluation of the applied draft, shared with the Orchestrator Policy
  // dialog, which evaluates its own copy the same way.
  const orchestratorPolicyView = orchestratorSettingsReady ? orchestratorSettings?.view ?? null : null;
  const policyContext: OrchestratorPolicyContext | null = orchestratorPolicyView ? {
    view: orchestratorPolicyView,
    machine: runner ? machineName(runner.runnerId) : "this machine",
    runnerProtocolVersion: runner?.protocolVersion,
    driver: agent?.driver,
    hostExecutionTarget,
    agentOffersOrchestratorPreset,
    strictProjectBoundaryAvailable,
    providerExecutionAvailable,
    presetReason: presetReasonFor,
  } : null;
  const policy = policyContext ? evaluateOrchestratorPolicy(policyContext, policyDraft) : null;
  const policyProblem = policy?.problems[0] ?? null;
  const orchestratorOverrides = policy?.overrides ?? new Set<string>();
  const liveChildLimit = Number(policyDraft.limitText);
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
    "initial Native TUI launch",
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
    orchestratorPresetAvailable: agentOffersOrchestratorPreset,
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
  const selectionIssue = currentAgentSelectionIssue(agentOpts, agentId, agentDefaults[runnerId], runner?.agents);
  const suggestedAgentOption = agentOpts.find((option) => option.agent.id === savedSelection.recommendedId);
  // Agent lists what the chosen machine can start, so it waits for an online one (#2953).
  const agentWaitsFor = projectsSupported && projectSelection !== NO_PROJECT_SELECTION
    ? !selectedProjectLocation ? "Choose a Location First"
      : !projectLocationLaunchable ? "Choose an Online Location First" : null
    : !runner ? "Choose a Location First"
      : runner.status !== "online" ? "Choose an Online Location First" : null;
  // A saved default this machine can't start is the field's error; one that only needs updating is a
  // warning whose button applies the fix (§8.5).
  const savedAgentChoice = agentDefaults[runnerId];
  const agentDefaultProblem: { tone: "error" | "warning"; message: string; fix?: { label: string; id: string } } | null =
    agentWaitsFor || !runner ? null
      : selectionIssue === "unavailable" && selectedAgentOption ? {
        tone: "error",
        message: agentSetupProblem(selectedAgentOption.agent, agentAvailabilityVerified) === "not_installed"
          ? `${selectedAgentOption.name} isn't installed on ${agentMachine}. Choose another agent, or set it up in Connections.`
          : `${selectedAgentOption.name} can't start on ${agentMachine} until it's set up. Choose another agent, or set it up in Connections.`,
      }
      : selectionIssue === "missing" && savedAgentChoice ? {
        tone: "error",
        message: `${savedAgentName(savedAgentChoice, runner.agents) ?? "Your saved agent"} isn't installed on ${agentMachine}. Choose another agent, or set it up in Connections.`,
      }
      : selectionIssue === "legacy" ? {
        tone: "warning",
        message: "Your saved default uses Codex non-interactive mode, which is no longer supported. Codex App Server supports interactive approvals and resumable conversations.",
        ...(suggestedAgentOption && savedSelection.recommendedId !== savedAgentChoice
          ? { fix: { label: `Use ${suggestedAgentOption.name}`, id: suggestedAgentOption.agent.id } } : {}),
      }
      : selectionIssue === "unbound" ? {
        tone: "warning",
        message: `Your saved default doesn't say which installation of ${
          agentOpts.find((option) => option.agent.id === savedAgentChoice)?.name ?? "this agent"} it means.`,
        ...(suggestedAgentOption ? {
          fix: {
            label: savedSelection.recommendedId === savedAgentChoice ? "Use This Installation" : `Use ${suggestedAgentOption.name}`,
            id: suggestedAgentOption.agent.id,
          },
        } : {}),
      }
      : null;
  const agentDefaultProblemId = `${generatedFormId}-agent-default`;
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
    setAgentDefaults((defaults) => saveAgentDefault(
      defaults, runnerId, id, instanceScope, runner?.agents.find((candidate) => candidate.id === id),
    ));
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
    const options = agentOptions(r?.agents ?? []);
    const selection = savedAgentSelection(options, agentDefaults[id], r?.agents);
    setAgentId(selection.agentId);
    setBrowsedPath(null);
    setChoosingFolder(false);
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
    const options = agentOptions(r.agents);
    const selection = savedAgentSelection(options, agentDefaults[loc.runnerId], r.agents);
    setAgentId(selection.agentId);
    setBrowsedPath(null);
    setChoosingFolder(false);
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
    setFieldProblem(null);
    projectSelectionChangedRef.current = true;
    setProjectSelection(value);
    setProjectLocationId("");
    setBrowsedPath(null);
    setChoosingFolder(false);
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
    if (!orchestratorSupported) setRoleOverride(undefined);
  }, [orchestratorSupported]);

  useEffect(() => {
    if (launchSurface === "native_tui" && !nativeTuiSupported) setLaunchSurface("direct");
  }, [launchSurface, nativeTuiSupported]);

  // A browsed path may no longer apply once the agent's context (native/WSL) changes.
  useEffect(() => {
    setBrowsedPath(null);
    setChoosingFolder(false);
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
  // Independent provider permissions (#1281, #1293): a non-strict native Claude Code or Codex
  // Orchestrator keeps the same permission mode, tools, hooks, and MCP servers as a normal session.
  const savedPermissionTitle = !defaultsReady ? (harnessDefaults?.error ? "Default (Not Loaded)" : "Loading…")
    : savedPiModeUnavailableForTarget ? "Target Default — Full Access"
    : savedPermissionMode ? `Saved Default — ${titleCaseLabel(permissionModeLabel(savedPermissionMode, agent?.driver))}`
    : "Harness Default";
  const launchSelectionValid = projectPlacementValid && !!agentId && !!selectedAgentOption && !selectedAgentOption.disabled &&
    !missingRequiredAccountChoice &&
    (!executionTarget || executionTarget.available) && cloudBudgetValid &&
    (launchSurface !== "native_tui" || nativeTuiSupported) &&
    (defaultsReady || orchestrator) &&
    // Maximum Concurrent Children is part of the policy: under Full Control it is also the
    // campaign's concurrency, which must be at least 1, so the policy refuses 0 there.
    (!orchestrator || (orchestratorSupported && orchestratorSettingsReady && !policyProblem)) &&
    (!directWslRequiresSafeOrchestrator || (orchestrator && orchestratorSupported)) && !retainedSessionId;
  const controlPreview = policyDraft.controlMode;
  const valid = launchSelectionValid && (!orchestrator || controlPreview !== "full_control");
  // Full Control never falls back to ordinary creation: its one action authorizes the reviewed preflight.
  const fullControlLaunch = orchestrator && orchestratorSettingsReady && controlPreview === "full_control";
  // The chosen location, as the Location field reports it: why it can't host the session, if it can't.
  const selectedLocationProblem = selectedProjectLocation && !projectLocationLaunchable
    ? unavailableLocationSentence(
      liveLocationAvailability(selectedProjectLocation, runners),
      machineName(selectedProjectLocation.runnerId),
    )
    : null;
  // Create Session is disabled only for what nothing further down the form can fix (§7.3, §8.5), and
  // the footer says what that is. Anything else leaves it enabled: pressing it lands on the field.
  const blockedReason = online.length === 0 ? "Connect a machine to continue."
    : projectsSupported && selectedProject && selectedProject.locations.length === 0 ? "Add a location to continue."
      : projectsSupported && selectedProject &&
          (selectedProjectLocation ? !projectLocationLaunchable : projectLocationsAvailable.length === 0)
        ? "Choose an online location to continue."
        : runner && (!agentOpts.some((option) => !option.disabled) || selectedAgentOption?.disabled ||
            agentDefaultProblem?.tone === "error")
          ? "Choose an installed agent to continue."
          // A policy that can't launch is fixed in Orchestrator Policy, and says so here too (#2955).
          : orchestrator && orchestratorSupported && policyProblem ? policyProblem.message
            : null;

  // Validation feedback describes the state that produced it. Once any value participating in
  // validation changes, remove that stale diagnosis; request failures remain until the next submit.
  useEffect(() => {
    setFieldProblem(null);
  }, [
    projectSelection, selectedProject?.id, projectLocationId, projectLocationLaunchable,
    runnerId, workspaceId, browsedPath, agentId, selectedAgentOption?.disabled, providerAccountId,
    defaultsReady, harnessDefaults?.error, roleOverride, orchestrator, orchestratorSupported, controlPreview,
    directWslRequiresSafeOrchestrator, launchSurface, nativeTuiSupported,
    executionTargetId, executionTarget?.id, executionTarget?.available,
    cloudBudgetUsd, cloudBudgetValid, retainedSessionId,
    policyDraft, policyProblem?.message,
    orchestratorSettingsReady, orchestratorSettings?.error,
  ]);

  // Keep the secondary shortcut local to this dialog. Unmodified Enter is native form behavior: an
  // open combobox prevents it while committing its option, and a closed single-line input lets it
  // reach the real submit button. Modified Enter works from controls that own plain Enter.
  const submitOnModifiedEnter = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    if (event.repeat || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault();
      return;
    }
    const target = event.target as HTMLElement;
    const modifiedSubmit = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (modifiedSubmit) {
      event.preventDefault();
      // A visible query and highlighted option are uncommitted user intent. Require the popup's
      // ordinary Enter first instead of silently creating with the previously committed value.
      if (target.getAttribute("role") === "combobox" && target.getAttribute("aria-expanded") === "true") return;
      formRef.current?.requestSubmit();
      return;
    }
    const plainKey = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (plainKey && !valid &&
        !(target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement || target instanceof HTMLSelectElement)) {
      // Native implicit submission is suppressed when its default button is disabled. Keep the
      // visual disabled state, but route an eligible invalid Enter through our actionable feedback.
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  /** Where each control a submit problem can land on is found, in the dialog (the form or its footer). */
  const problemTargets: Record<ProblemControl, string> = {
    project: '[role="combobox"][aria-label="Project"], button[aria-label^="Project:"]',
    location: 'button[aria-label^="Location:"]:not([aria-disabled="true"])',
    "add-location": '[data-validation-target="add-location"]',
    machine: 'button[aria-label^="Machine:"]',
    folder: 'button[aria-label^="Workspace:"]',
    browse: '[data-validation-target="browse"]:not(:disabled)',
    agent: '[role="combobox"][aria-label="Agent"], button[aria-label^="Agent:"]',
    account: 'button[aria-label^="Account:"]',
    "retained-session": '[data-validation-target="retained-session"]',
    "open-connections": '[data-validation-target="open-connections"]',
    role: '.seg[aria-label="Role"] > .seg-option:not([aria-disabled="true"])',
    defaults: '[data-validation-target="defaults"]',
    "orchestrator-retry": 'button[data-validation-target="orchestrator-retry"]',
    orchestrator: 'button[data-validation-target="orchestrator-policy"]',
    "full-control": 'section[aria-label="Full Control Launch"] textarea',
    harness: '.seg[aria-label="Harness"] > .seg-option:not([aria-disabled="true"])',
    mode: '.seg[aria-label="Working Copy"] > .seg-option[aria-checked="true"]',
    "execution-target": 'button[aria-label^="Run On:"]',
    "cloud-budget": `[id="${cloudBudgetInputId}"]`,
    create: '[data-validation-target="create"]',
  };
  /** Focus the first of `controls` that renders now, falling back to Create Session, and say which. */
  const focusValidationProblem = (...controls: ProblemControl[]): ProblemControl => {
    // A problem inside Options opens it first, in this commit, so its control can take focus.
    if (controls[0] && OPTIONS_CONTROLS.has(controls[0]) && !optionsOpen) flushSync(() => setOptionsOpen(true));
    const dialog = formRef.current?.closest<HTMLElement>('[role="dialog"]') ?? formRef.current;
    for (const control of [...controls, "create" as const]) {
      const target = dialog?.querySelector<HTMLElement>(problemTargets[control]);
      if (!target) continue;
      target.focus();
      return control;
    }
    return "create";
  };

  const buildSessionRequest = (): CreateSessionRequest => {
    const placement = projectSessionPlacement(
      projectsSupported,
      projectSelection === NO_PROJECT_SELECTION ? null : selectedProject,
      projectSelection === NO_PROJECT_SELECTION ? null : selectedProjectLocation,
      { runnerId, workspaceId },
    );
    // An explicitly chosen Orchestrator sends the coupled preset only where it still applies;
    // otherwise the ordinary provider mode is resolved by the server exactly as for a normal
    // session. A saved Orchestrator default keeps delegating both role and mode to the server.
    const config: SessionConfig = {
      ...(roleOverride === "orchestrator" && (providerPermissionsPreset || !orchestratorRoleSupported)
        ? { permissionMode: "orchestrator" }
        : {}),
      ...(executionTarget?.adapter === "cloud" ? { costBudgetUsd: cloudBudget } : {}),
    };
    const orchestratorDraft = policyDraft.values;
    const decisionOverrides = Object.fromEntries(WORKFLOW_DECISION_CATEGORIES.flatMap((category) =>
      orchestratorOverrides.has(`delegation.decisions.${category}`)
        ? [[category, orchestratorDraft.delegation.decisions[category]]]
        : [],
    ));
    const executionOverridden = orchestratorOverrides.has("execution.strictProjectIsolation") ||
      orchestratorOverrides.has("execution.integrationIsolation");
    const orchestratorRequest = orchestrator ? {
      behavior: {
        ...(orchestratorOverrides.has("behavior.childHarness") ? { childHarness: orchestratorDraft.behavior.childHarness } : {}),
        ...(orchestratorOverrides.has("behavior.childModel") ? { childModel: orchestratorDraft.behavior.childModel } : {}),
        ...(orchestratorOverrides.has("behavior.childEffort") ? { childEffort: orchestratorDraft.behavior.childEffort } : {}),
        ...(orchestratorOverrides.has("behavior.maximumConcurrentChildren") ? { maximumConcurrentChildren: liveChildLimit } : {}),
        ...(orchestratorOverrides.has("behavior.followUps") ? { followUps: orchestratorDraft.behavior.followUps } : {}),
        ...(orchestratorOverrides.has("behavior.completion") ? { completion: orchestratorDraft.behavior.completion } : {}),
      },
      delegation: {
        ...(orchestratorOverrides.has("delegation.parentControl") ? { parentControl: orchestratorDraft.delegation.parentControl } : {}),
        ...(Object.keys(decisionOverrides).length ? { decisions: decisionOverrides } : {}),
      },
      // Each execution policy is sent only when this session actually overrode it, so an
      // untouched one keeps the provenance of the default it came from. Integration Isolation is
      // withheld while it is implied: the preset and Strict Project Isolation both launch without
      // integrations, the server derives `true` and attributes it to the policy that implied it,
      // and an explicit `false` in that state is a shape the control plane refuses.
      ...(executionOverridden ? { execution: {
        ...(orchestratorOverrides.has("execution.strictProjectIsolation")
          ? { strictProjectIsolation: orchestratorDraft.execution.strictProjectIsolation }
          : {}),
        // An older control plane rejects this key outright, so it is never sent there.
        ...(orchestratorOverrides.has("execution.integrationIsolation") &&
          !integrationIsolationImplied && integrationIsolationControlPlane
          ? { integrationIsolation: orchestratorDraft.execution.integrationIsolation }
          : {}),
      } } : {}),
    } : undefined;
    return {
      ...placement,
      agentId,
      ...(hostExecutionTarget && providerAccountId && accountChosenByUser.current ? { providerAccountId } : {}),
      ...(orchestratorRoleSupported && roleOverride !== undefined ? { role: roleOverride } : {}),
      useWorktree,
      executionTargetId: executionTarget?.id,
      config: Object.keys(config).length ? config : undefined,
      ...(orchestratorRequest ? { orchestrator: orchestratorRequest } : {}),
      workspacePath: (!projectsSupported || projectSelection === NO_PROJECT_SELECTION) ? browsedPath ?? undefined : undefined,
      acpSessionContext: additionalDirectories.length ? { additionalDirectories } : undefined,
      ...(launchSurface === "native_tui" ? { launchSurface: "native_tui" as const } : {}),
    };
  };

  const submit = async () => {
    // Re-entrancy guard: the Enter path bypasses the footer button's disabled attribute, and a
    // second submit while createSession is in flight would spawn a duplicate session.
    if (busyRef.current) return;
    setFieldProblem(null);
    // A kept session's failure stays: its Open Session is the way forward.
    if (!retainedSessionId) setRequestFailure(null);
    // Each problem is shown under its field, and focus moves to the first of its controls that renders
    // now. That control carries `aria-invalid` where it has one, and its `aria-describedby` names the
    // error, so focusing it announces why (§8.5). A problem with no message is already explained by
    // what its control is described by (a notice, the account's reason).
    const report = (field: ProblemField, message: string | null, ...controls: ProblemControl[]) => {
      const control = focusValidationProblem(...controls);
      setFieldProblem(message ? { field, message, control } : null);
    };
    if (fullControlLaunch) {
      if (!fullControlAuthorization?.ready) {
        report("role", "Full Control isn't ready yet. Resolve what the summary lists, or choose Custom in Orchestrator Policy.",
          "full-control", "orchestrator");
        return;
      }
      // The panel inside Options says why a launch did not start, so it must be on screen first.
      if (!optionsOpen) flushSync(() => setOptionsOpen(true));
      busyRef.current = true;
      setBusy(true);
      try { await fullControlAuthorization.authorize(); } catch { /* The panel shows why it did not start. */ }
      finally { busyRef.current = false; setBusy(false); }
      return;
    }
    if (!valid) {
      if (orchestrator && controlPreview === "full_control") {
        report("role", "Full Control isn't ready yet. Resolve what the summary lists, or choose Custom in Orchestrator Policy.",
          "full-control", "orchestrator", "orchestrator-retry", "role");
      } else if (retainedSessionId) {
        // The failure notice above the footer already says a session was kept; Open Session is next.
        report("form", null, "retained-session");
      } else if (online.length === 0) {
        // No Machines Online says why; Open Connections is the way forward.
        report("form", null, "open-connections");
      } else if (projectsSupported && !projectSelection) {
        report("project", "Choose a project, or choose No Project.", "project");
      } else if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION && !selectedProject) {
        report("project", "This project is no longer available. Choose another project.", "project");
      } else if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION && selectedProject &&
          selectedProject.locations.length === 0) {
        // The No Locations notice explains, and its Add Location… is next, unless only someone who
        // manages the project can add one.
        if (cannotAddLocation) {
          report("project", "This project has no locations, and you can't add one. Choose another project.", "project");
        } else {
          report("location", null, "add-location");
        }
      } else if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION && !projectLocationLaunchable) {
        // An unavailable choice already shows its own error under Location; an unchosen one needs one.
        report("location", selectedProjectLocation
          ? null
          : projectLocationsAvailable.length > 0
            ? "Choose where this session runs."
            : "No location of this project is online. Start its machine, or add a location on another machine.",
        "location", "project");
      } else if (!runnerId) {
        report("machine", "Choose a machine.", "machine", "project");
      } else if (!workspaceId && !browsedPath) {
        report("folder", "Choose a workspace, or browse for a folder.", "folder", "browse");
      } else if (!agentId || !selectedAgentOption || selectedAgentOption.disabled) {
        report("agent", agentDefaultProblem?.tone === "error" ? null : "Choose an installed agent.", "agent");
      } else if (missingRequiredAccountChoice) {
        // The Account field already says why, and its control is described by it.
        report("form", null, "account");
      } else if (!defaultsReady && !orchestrator) {
        report("role", harnessDefaults?.error
          ? "Retry loading saved permission defaults before creating a session."
          : "Wait for saved permission defaults to finish loading.",
        ...(harnessDefaults?.error ? ["defaults", "role"] as const : ["role"] as const));
      } else if (orchestrator && !orchestratorSupported) {
        report("role", "Choose an available Role.", "role");
      } else if (orchestrator && !orchestratorSettingsReady) {
        // While the policy loads there is nothing of it to focus, so the Session Role answers. A
        // failed load is its notice's to explain, and its Retry is described by it.
        report("role", orchestratorSettings?.error ? null : "Wait for your Orchestrator defaults to finish loading.",
          "orchestrator-retry", "role");
      } else if (orchestrator && policyProblem) {
        // The policy row already says what is wrong, and Customize… is described by it.
        report("role", null, "orchestrator", "role");
      } else if (directWslRequiresSafeOrchestrator && !orchestrator) {
        report("role", "Choose Orchestrator or another execution context.", "role");
      } else if (launchSurface === "native_tui" && !nativeTuiSupported) {
        report("harness", "Choose an available Harness.", "harness");
      } else if (executionTarget && !executionTarget.available) {
        report("mode", "Choose an available Run On target.", "execution-target", "mode");
      } else if (!cloudBudgetValid) {
        // The Cloud Budget field already shows its error, and the focused field is described by it.
        report("mode", null, "cloud-budget", "execution-target", "mode");
      } else {
        report("form", "Complete the required session settings before creating a session.", "create");
      }
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const session = await api.createSession(buildSessionRequest());
      navigate({ name: "session", id: session.id });
      if (launchSurface === "native_tui") onOpenTerminal?.();
      onClose();
    } catch (e) {
      const keptSessionId = e instanceof ApiError &&
          (e.code === "NATIVE_TUI_LAUNCH_AMBIGUOUS" ||
            e.code === "NATIVE_TUI_COMPENSATION_FAILED") &&
          typeof e.details?.sessionId === "string"
        ? e.details.sessionId
        : null;
      if (keptSessionId) setRetainedSessionId(keptSessionId);
      setRequestFailure({
        sentence: createFailureSentence(e, keptSessionId !== null),
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** The error a submit left under `field`, with the id its control points `aria-describedby` at. */
  const problemFor = (field: ProblemField) => fieldProblem?.field === field
    ? <FieldError id={problemId(field)}>{fieldProblem.message}</FieldError>
    : null;
  /** Whether a submit's problem is about `control`, and its description: `own` plus the error. */
  const controlInvalid = (control: ProblemControl) => fieldProblem?.control === control;
  const controlDescribedBy = (control: ProblemControl, own?: string) =>
    [own, fieldProblem?.control === control ? problemId(fieldProblem.field) : undefined].filter(Boolean).join(" ") || undefined;

  const openConnections = () => {
    onClose();
    navigate({ name: "runners", section: "machines" });
  };
  // Machines in Connections lists each machine with its agents (#2953).
  const setUpAgentsAction: PickerFooterAction = { label: "Set Up Agents in Connections", onSelect: openConnections };

  // Project takes focus as the dialog opens, with its list closed (#1143, #2951): typing filters
  // at once, Arrow Down opens it, and it never covers the form uninvited.
  const projectField = (
    <div className="field" ref={projectChoiceRef}>
      <label className="new-session-field-label" htmlFor={touchChoicePicker ? undefined : projectInputId}>Project</label>
      {touchChoicePicker ? (
        <Select<string>
          className="new-session-choice-control"
          label="Project"
          value={projectSelection || null}
          onChange={pickProject}
          options={projectOptions}
          placeholder="Choose a Project…"
          emptyLabel="No Projects Available"
          searchable
          noun="projects"
          footerAction={newProjectAction}
          invalid={controlInvalid("project")}
          describedBy={controlDescribedBy("project")}
        />
      ) : (
        <SearchableCombobox<string>
          inputId={projectInputId}
          autoFocus={initialProjectAutoFocusRef.current}
          openOnFocus={false}
          className="new-session-choice-control"
          label="Project"
          value={projectSelection || null}
          onChange={pickProject}
          options={projectOptions}
          placeholder="Choose a Project…"
          emptyLabel="No Projects Available"
          noun="projects"
          footerAction={newProjectAction}
          invalid={controlInvalid("project")}
          describedBy={controlDescribedBy("project")}
        />
      )}
      {problemFor("project")}
    </div>
  );

  // Each location is its machine, with its status and folder on the second line. An unavailable one
  // stays choosable so its reason can be read, and choosing it marks the field invalid (§8.5).
  const locationMachineCounts = new Map<string, number>();
  for (const location of selectedProject?.locations ?? []) {
    locationMachineCounts.set(location.runnerId, (locationMachineCounts.get(location.runnerId) ?? 0) + 1);
  }
  const locationOptions: SelectOption<string>[] = (selectedProject?.locations ?? []).map((location) => {
    const machine = machineName(location.runnerId);
    const folder = location.path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? location.path;
    return {
      value: location.id,
      label: machine,
      description: `${projectAvailabilityLabel(liveLocationAvailability(location, runners))} · ${startTruncatedPath(location.path)}`,
      ...((locationMachineCounts.get(location.runnerId) ?? 0) > 1 ? { selectedLabel: `${machine} · ${folder}` } : {}),
    };
  });
  const locationError = selectedLocationProblem ?? (fieldProblem?.field === "location" ? fieldProblem.message : null);
  const cannotAddLocation = selectedProject?.canManage === false;
  const locationField = (
    <div className="field" ref={locationFieldRef}>
      <span>Location</span>
      {selectedProject && selectedProject.locations.length === 0 ? (
        <Notice
          tone="neutral"
          compact
          className="new-session-no-locations"
          actions={cannotAddLocation ? undefined : (
            <button
              type="button"
              className="btn sm"
              data-validation-target="add-location"
              aria-describedby={noLocationsId}
              onClick={() => setAddingLocation(true)}
            >
              Add Location…
            </button>
          )}
        >
          <span id={noLocationsId}>This project has no locations yet. Add the folder where its sessions run.</span>
        </Notice>
      ) : (
        <Select<string>
          className="new-session-choice-control"
          label="Location"
          value={selectedProjectLocation ? selectedProjectLocation.id : null}
          onChange={(id) => {
            const location = selectedProject?.locations.find((item) => item.id === id);
            if (location) pickProjectLocation(location);
          }}
          options={locationOptions}
          placeholder={selectedProject ? "Choose a Location…" : "Choose a Project First"}
          disabled={!selectedProject}
          footerAction={selectedProject && !cannotAddLocation ? addLocationAction : undefined}
          invalid={!!locationError}
          describedBy={locationError ? problemId("location") : cannotAddLocation ? locationHelperId : undefined}
        />
      )}
      {locationError
        ? <FieldError id={problemId("location")}>{locationError}</FieldError>
        : cannotAddLocation && <p className="field-helper" id={locationHelperId}>You can't add locations to this project.</p>}
    </div>
  );

  // Always a Select, even with one machine online: it says where the session runs either way.
  const machineField = online.length > 0 ? (
    <div className="field">
      <span>Machine</span>
      <Select<string>
        label="Machine"
        value={runnerId || null}
        onChange={pickRunner}
        options={online.map((r) => ({
          value: r.runnerId,
          label: machineLabels.get(r.runnerId) ?? r.runnerId,
        }))}
        placeholder="Choose a Machine…"
        invalid={controlInvalid("machine")}
        describedBy={controlDescribedBy("machine")}
      />
      {problemFor("machine")}
    </div>
  ) : null;

  const folderField = runner ? (
    <div className="field">
      {browsedPath
        ? <label className="new-session-field-label" htmlFor={folderInputId}>Folder</label>
        : <span>Workspace</span>}
      {/* Browse… keeps its place in both states, so it is still there to take focus back
          when Choose Folder closes after filling the Folder field. */}
      <div className="folder-field-row" ref={workspaceRowRef}>
        {browsedPath ? (
          <input
            id={folderInputId}
            className="input folder-field-path is-read-only"
            value={browsedPath}
            title={browsedPath}
            readOnly
          />
        ) : (
          <Select<string>
            label="Workspace"
            value={workspaceId || null}
            onChange={(value) => { setWorkspaceId(value); setAdditionalDirectories([]); }}
            options={(runner?.workspaces ?? []).map((w) => ({ value: w.id, label: w.name }))}
            invalid={controlInvalid("folder")}
            describedBy={controlDescribedBy("folder")}
          />
        )}
        <button
          ref={browseButtonRef}
          type="button"
          className="btn"
          data-validation-target="browse"
          onClick={() => setChoosingFolder(true)}
          disabled={!browseSupported}
          aria-describedby={browseSupported ? undefined : browseReasonId}
        >
          Browse…
        </button>
      </div>
      {problemFor("folder") ?? (!browseSupported && <p className="field-helper" id={browseReasonId}>{browseHint}</p>)}
      {browsedPath && (
        <button
          type="button"
          className="btn ghost sm new-session-use-workspace"
          onClick={() => {
            workspacePickerRestoredRef.current = true;
            setBrowsedPath(null);
          }}
        >
          Use a Workspace
        </button>
      )}
    </div>
  ) : null;

  // A server without projects keeps its workspace quick-pick, as the same Location Select. Every
  // option can host a session: `locations` is already filtered to online, advertised workspaces.
  const legacyLocationField = locations.length > 1 ? (
    <div className="field">
      <span>Location</span>
      <Select<string>
        label="Location"
        value={browsedPath ? null : workspaceLocationKey(runnerId, workspaceId)}
        onChange={(key) => {
          const picked = locations.find((loc) => workspaceLocationKey(loc.runnerId, loc.workspaceId) === key);
          if (picked) pickLocation(picked);
        }}
        options={locations.map((loc) => {
          const path = runners.get(loc.runnerId)?.workspaces.find((w) => w.id === loc.workspaceId)?.path;
          return {
            value: workspaceLocationKey(loc.runnerId, loc.workspaceId),
            label: machineName(loc.runnerId),
            description: path ? startTruncatedPath(path) : loc.workspaceId,
          };
        })}
        placeholder="Choose a Location…"
      />
    </div>
  ) : null;

  useLayoutEffect(() => {
    if (!workspacePickerRestoredRef.current || browsedPath) return;
    workspacePickerRestoredRef.current = false;
    (workspaceRowRef.current?.querySelector<HTMLElement>(".ui-select-trigger") ?? browseButtonRef.current)?.focus();
  });

  // Options (#2954): the values its closed head lists, what inside needs attention, and the copy of
  // its rows that depends on more than one choice.
  const permissionsValue = providerPermissionsPreset && !savedOrchestratorDefault ? "Orchestrator Preset" : savedPermissionTitle;
  const permissionsDescription = providerPermissionsPreset ? "The Orchestrator preset sets them for this session."
    : savedPiModeUnavailableForTarget ? "This target can't show Pi's approval prompts, so commands run without them."
    : orchestrator
      ? effectiveIntegrationIsolation
        ? "An Orchestrator keeps them and adds only its orchestration tools. Change them in the composer after the session opens."
        : "An Orchestrator keeps them and its integrations, which typed decisions can't intercept. Change them in the composer after the session opens."
      : "Change them in the composer after the session opens.";
  const defaultsFailureId = `${generatedFormId}-defaults-failure`;
  const normalUnavailable = !orchestratorRoleSupported && savedOrchestratorDefault
    ? "Orchestrator is your saved Agent Harness default. Change it in Settings to use another default."
    : undefined;
  const roleDescription = roleOverride === undefined && savedOrchestratorDefault && orchestratorRoleSupported
    ? "Orchestrator is your saved default. Choose Normal to ignore it for this session, or change it in Settings."
    : "An Orchestrator delegates work to child sessions.";
  const roleUnavailableId = `${generatedFormId}-role-unavailable`;
  const roleWslId = `${generatedFormId}-role-wsl`;
  const savedOrchestratorUnavailable = orchestrator && !orchestratorSupported;
  const orchestratorRequired = directWslRequiresSafeOrchestrator && !orchestrator;
  const roleNoteIds = [savedOrchestratorUnavailable && roleUnavailableId, orchestratorRequired && roleWslId]
    .filter(Boolean).join(" ");
  const roleNotes = <>
    {savedOrchestratorUnavailable && <FieldError id={roleUnavailableId}>
      The saved Orchestrator preset is unavailable here. {orchestratorUnavailable} Choose a compatible target or change the saved default in Settings.
    </FieldError>}
    {orchestratorRequired && <FieldError id={roleWslId}>
      Direct WSL with bubblewrap is available only through the verified Orchestrator launcher. Choose Orchestrator or another execution context.
    </FieldError>}
    {/* With a policy to show, the role's problem sits under the policy it is about. */}
    {!(orchestrator && orchestratorSettingsReady) && problemFor("role")}
  </>;
  const optionsSummary = [
    { key: "role", icon: <BotIcon size={14} />, label: orchestrator ? "Orchestrator" : "Normal" },
    { key: "harness", icon: <TerminalIcon size={14} />, label: launchSurface === "native_tui" ? "Native TUI" : "Direct" },
    { key: "working-copy", icon: useWorktree ? <BranchIcon size={14} /> : <FolderIcon size={14} />, label: useWorktree ? "Worktree" : "In Place" },
    ...(runOnOffered && executionTarget ? [{ key: "run-on", icon: <ComputerIcon size={14} />, label: executionTarget.name }] : []),
    { key: "permissions", icon: <ShieldIcon size={14} />, label: permissionsValue },
  ];
  const optionsAttention: SessionOptionsAttention[] = [
    ...(skillsUnavailable ? [{ key: "skills", label: "Skills Unavailable" }] : []),
    ...(!defaultsReady && harnessDefaults?.error ? [{ key: "defaults", label: "Permissions Not Loaded" }] : []),
    ...(savedOrchestratorUnavailable ? [{ key: "orchestrator-unavailable", label: "Orchestrator Unavailable" }] : []),
    ...(orchestratorRequired ? [{ key: "orchestrator-required", label: "Orchestrator Required" }] : []),
    ...(orchestrator && !orchestratorSettingsReady && orchestratorSettings?.error
      ? [{ key: "policy-error", label: "Policy Not Loaded" }] : []),
    ...(orchestrator && orchestratorSettingsReady && policyProblem
      ? [{ key: "policy-invalid", label: "Policy Needs a Change" }] : []),
    // Full Control's footer action is disabled until its preparation inside Options is ready, and
    // only that preparation says what is missing.
    ...(fullControlLaunch && !fullControlAuthorization?.ready ? [{ key: "full-control", label: "Full Control Not Ready" }] : []),
    ...(!cloudBudgetValid ? [{ key: "cloud-budget", label: "Budget Out of Range" }] : []),
  ];

  return (
    <>
    <Modal
      title="New Session"
      description="Choose the model and write your first message once it opens."
      onClose={onClose}
      phoneSheet="full"
      onKeyDown={submitOnModifiedEnter}
      footer={
        <>
          {blockedReason && !fullControlLaunch && <p className="new-session-reason" id={blockedReasonId}>{blockedReason}</p>}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {fullControlLaunch
            ? <BusyButton type="submit" form={formId} className="btn primary" busy={busy} progress="Starting the campaign…"
              disabled={!fullControlAuthorization?.ready}>Authorize and Start</BusyButton>
            : <BusyButton type="submit" form={formId} className="btn primary" busy={busy} progress="Creating the session…"
              disabled={!!blockedReason} data-validation-target="create"
              aria-describedby={controlDescribedBy("create", blockedReason ? blockedReasonId : undefined)}>Create Session</BusyButton>}
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="form"
        noValidate
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        {online.length === 0 && (
          <Notice
            tone="neutral"
            title="No Machines Online"
            actions={(
              <button
                type="button"
                className="btn sm"
                data-validation-target="open-connections"
                aria-describedby={noMachinesId}
                onClick={openConnections}
              >
                Open Connections
              </button>
            )}
          >
            <span id={noMachinesId}>Start Wollipog on one of your machines, or connect a new one.</span>
          </Notice>
        )}
        {/* Where (§8.1): Project and Location share one row; with No Project, Project and Machine do,
            and Folder follows. A server without projects keeps Location, then Machine and Folder. */}
        {projectsSupported ? (
          <>
            <div className="field-row">
              {projectField}
              {projectSelection === NO_PROJECT_SELECTION ? machineField : locationField}
            </div>
            {projectSelection === NO_PROJECT_SELECTION && folderField}
          </>
        ) : (
          <>
            {legacyLocationField}
            <div className="field-row">
              {machineField}
              {folderField}
            </div>
          </>
        )}

          <div className="field">
            <label className="new-session-field-label" htmlFor={touchChoicePicker ? undefined : agentInputId}>Agent</label>
            <div ref={agentChoiceRef}>
              {touchChoicePicker ? (
                <Select<string>
                  className="new-session-choice-control"
                  label="Agent"
                  value={agentWaitsFor ? null : agentId || null}
                  onChange={selectAgent}
                  options={agentWaitsFor ? [] : agentComboboxOptions}
                  placeholder={agentWaitsFor ?? "Choose an Agent…"}
                  emptyLabel="No Agents Available"
                  leadingIcon={agentWaitsFor ? undefined : agentIcon}
                  searchable
                  noun="agents"
                  footerAction={setUpAgentsAction}
                  disabled={!!agentWaitsFor}
                  invalid={controlInvalid("agent") || agentDefaultProblem?.tone === "error"}
                  describedBy={controlDescribedBy("agent", agentDefaultProblem ? agentDefaultProblemId : undefined)}
                />
              ) : (
                <SearchableCombobox<string>
                  inputId={agentInputId}
                  className="new-session-choice-control"
                  label="Agent"
                  value={agentWaitsFor ? null : agentId || null}
                  onChange={selectAgent}
                  options={agentWaitsFor ? [] : agentComboboxOptions}
                  placeholder={agentWaitsFor ?? "Choose an Agent…"}
                  emptyLabel="No Agents Available"
                  leadingIcon={agentWaitsFor ? undefined : agentIcon}
                  noun="agents"
                  footerAction={setUpAgentsAction}
                  disabled={!!agentWaitsFor}
                  invalid={controlInvalid("agent") || agentDefaultProblem?.tone === "error"}
                  describedBy={controlDescribedBy("agent", agentDefaultProblem ? agentDefaultProblemId : undefined)}
                />
              )}
            </div>
            {problemFor("agent")}
            {agentDefaultProblem && (agentDefaultProblem.tone === "error"
              ? <FieldError id={agentDefaultProblemId}>{agentDefaultProblem.message}</FieldError>
              : (
                <FieldWarning
                  id={agentDefaultProblemId}
                  action={agentDefaultProblem.fix && (
                    <button type="button" className="btn sm" onClick={() => selectAgent(agentDefaultProblem.fix!.id)}>
                      {agentDefaultProblem.fix.label}
                    </button>
                  )}
                >
                  {agentDefaultProblem.message}
                </FieldWarning>
              ))}
          </div>

          {hostExecutionTarget && (providerAccounts.length > 1 || savedProviderAccountMissing) && (
            <div className="field">
              <div className="pid-field-head">
                <label className="new-session-field-label">Account</label>
                {providerAccounts.some((account) => isPersonalIdentifier(account.label)) && (
                  <AccountIdentifierRevealButton
                    label="Emails"
                    revealed={accountIdentifiersRevealed}
                    onToggle={toggleAccountIdentifiers}
                    withText
                  />
                )}
              </div>
              <Select<string>
                className="new-session-choice-control"
                label="Account"
                value={providerAccountId || null}
                onChange={(accountId) => { accountChosenByUser.current = true; setProviderAccountId(accountId); }}
                options={providerAccounts.map((account, index) => ({
                  value: account.id,
                  label: accountIdentifiersRevealed ? account.label : providerAccountTitles[index]!,
                  description: providerAccountDescription(account.authStatus),
                }))}
                placeholder="Choose an Account…"
                invalid={missingRequiredAccountChoice}
                describedBy={missingRequiredAccountChoice ? accountReasonId : undefined}
              />
              {missingRequiredAccountChoice && (
                <FieldError id={accountReasonId}>
                  The saved default account isn't on this machine anymore. Choose an account, or change the default in Machine Settings.
                </FieldError>
              )}
            </div>
          )}

          {/* Everything below Agent is one Options row (#2954), open when something in it needs the
              person. The request it builds is the same as when every option was on the form. */}
          <SessionOptions open={optionsOpen} onOpenChange={setOptionsOpen} summary={optionsSummary} attention={optionsAttention}>
            <SettingsGroup>
              <SegmentedRow
                title="Role"
                description={roleDescription}
                value={orchestrator ? "orchestrator" : "normal"}
                onChange={(value) => setRoleOverride(value === "orchestrator" ? "orchestrator" : "normal")}
                block
                describedBy={[roleNoteIds, controlDescribedBy("role")].filter(Boolean).join(" ") || undefined}
                invalid={controlInvalid("role")}
                error={roleNotes}
                options={[
                  // An older control plane resolves a saved Orchestrator default itself and cannot be
                  // told otherwise, so Normal is unavailable rather than silently ignored.
                  { value: "normal", label: "Normal", disabled: normalUnavailable !== undefined, disabledReason: normalUnavailable },
                  // Kept in place while unavailable, so the row can say whether the runner, the agent,
                  // the context or the target is the reason.
                  { value: "orchestrator", label: "Orchestrator", disabled: !orchestratorSupported, disabledReason: orchestratorUnavailable },
                ]}
              />
              {orchestrator && !orchestratorSettingsReady && !orchestratorSettings?.error && (
                <SettingRow title="Orchestrator Policy" busy busyLabel="Loading your Orchestrator defaults…" />
              )}
              {orchestrator && !orchestratorSettingsReady && orchestratorSettings?.error && (
                <div className="session-options-inset">
                  <Notice
                    tone="danger"
                    compact
                    actions={(
                      <button
                        type="button"
                        className="btn sm"
                        data-validation-target="orchestrator-retry"
                        aria-describedby={controlDescribedBy("orchestrator-retry", policyFailureId)}
                        onClick={() => setDefaultsRetry((value) => value + 1)}
                      >
                        Retry
                      </button>
                    )}
                  >
                    <span id={policyFailureId}>{orchestratorSettings.error}</span>
                  </Notice>
                </div>
              )}
              {orchestrator && policy && (
                <OrchestratorPolicySummary
                  draft={policyDraft}
                  evaluation={policy}
                  disabled={busy}
                  describedBy={controlDescribedBy("orchestrator")}
                  customizeRef={customizeRef}
                  onCustomize={() => setEditingPolicy(policyProblem?.tab ?? "behavior")}
                />
              )}
              {/* Full Control's readiness and its one authorization stay in New Session, under the
                  policy that chose it. */}
              {fullControlLaunch && (
                <div className="session-options-inset">
                  <FullControlLaunchPanel request={buildSessionRequest} selectionValid={launchSelectionValid} disabled={busy}
                    savedDefaults={orchestratorSettings?.view?.defaults ?? null}
                    onAuthorization={setFullControlAuthorization}
                    onCreated={(id) => { navigate({ name: "session", id }); onClose(); }}
                    onActivity={() => setFieldProblem(null)} />
                </div>
              )}
              {orchestrator && orchestratorSettingsReady && fieldProblem?.field === "role" && (
                <div className="session-options-inset">{problemFor("role")}</div>
              )}
              <SegmentedRow
                title="Harness"
                value={launchSurface}
                onChange={(value) => setLaunchSurface(value === "native_tui" ? "native_tui" : "direct")}
                block
                describedBy={controlDescribedBy("harness")}
                invalid={controlInvalid("harness")}
                error={problemFor("harness")}
                options={[
                  { value: "direct", label: "Direct", description: "Direct gives structured chat, approval cards and usage tracking." },
                  {
                    value: "native_tui",
                    label: "Native TUI",
                    description: "Native TUI opens the provider's own terminal UI. It doesn't track usage or show approval cards, so sessions with budgets must use Direct.",
                    disabled: !nativeTuiSupported,
                    disabledReason: nativeTuiUnavailable,
                  },
                ]}
              />
              <SegmentedRow
                title="Working Copy"
                description="A worktree keeps your checkout untouched. Recommended for code changes."
                value={useWorktree ? "worktree" : "in_place"}
                onChange={(value) => selectHostMode(value === "worktree")}
                block
                describedBy={controlDescribedBy("mode")}
                invalid={controlInvalid("mode")}
                error={runOnOffered ? undefined : problemFor("mode")}
                options={[
                  { value: "in_place", label: "In Place" },
                  { value: "worktree", label: "Worktree" },
                ]}
              />
              {runOnOffered && (
                <SelectRow
                  title="Run On"
                  description={executionTarget ? describeBoundaries(executionTarget.boundaries) : undefined}
                  value={executionTarget?.id ?? ""}
                  onChange={selectExecutionTarget}
                  error={fieldProblem?.field === "mode" ? fieldProblem.message : null}
                  options={executionTargets.map((target) => ({
                    value: target.id,
                    label: target.name,
                    // An unavailable target keeps its reason as the option's second line.
                    disabled: !target.available,
                    disabledReason: target.available ? undefined : target.unavailableReason ?? "Unavailable on this machine.",
                  }))}
                />
              )}
              {skillsUnavailable && (
                <div className="session-options-inset" ref={skillsNoticeRef}>
                  <SkillsUnavailableNotice
                    machine={runner ? runnerDisplay(runner, boxByRunner.get(runner.runnerId), runner.runnerId).name : ""}
                    adapter={skillsUnavailable.adapter}
                    skillNames={skillsUnavailable.skillNames}
                    onOpenSkills={() => { onClose(); navigate({ name: "skills" }); }}
                  />
                </div>
              )}
              {executionTarget?.adapter === "cloud" && executionTarget.policy && (
                <NumberRow
                  title="Cloud Budget"
                  description={`Stops the session at this amount. Between ${usd(executionTarget.policy.cost.minimumBudgetUsd)} and ${usd(executionTarget.policy.cost.maximumBudgetUsd)}, at about ${usd(executionTarget.policy.cost.estimatedHourlyRateUsd)} an hour.`}
                  value={cloudBudgetUsd}
                  onChange={setCloudBudgetUsd}
                  unit="USD"
                  min={executionTarget.policy.cost.minimumBudgetUsd}
                  max={executionTarget.policy.cost.maximumBudgetUsd}
                  step={0.01}
                  inputId={cloudBudgetInputId}
                  error={cloudBudgetValid ? null
                    : `Enter an amount from ${usd(executionTarget.policy.cost.minimumBudgetUsd)} to ${usd(executionTarget.policy.cost.maximumBudgetUsd)}.`}
                />
              )}
              {directoryGrants.length > 0 && executionTarget?.adapter === "host" && (
                <SettingRow
                  title="Extra Folders (Preview)"
                  description="Also let this agent use these folders, for this session only."
                  control={(
                    <div className="session-options-folders" role="group" aria-label="Extra Folders">
                      {directoryGrants.map((path) => (
                        <Checkbox
                          key={path}
                          className="session-options-folder"
                          label={path}
                          checked={additionalDirectories.includes(path)}
                          onChange={() => setAdditionalDirectories((current) => current.includes(path)
                            ? current.filter((item) => item !== path)
                            : [...current, path])}
                        />
                      ))}
                    </div>
                  )}
                />
              )}
              <ValueRow title="Permissions" value={permissionsValue} description={permissionsDescription} />
            </SettingsGroup>
            {providerPermissionsPreset && (
              <Notice tone="warning" title="Permissions Set by the Orchestrator Preset">
                <p>{orchestratorPresetReason}</p>
              </Notice>
            )}
            {!defaultsReady && harnessDefaults?.error && (
              <Notice
                tone="danger"
                compact
                actions={(
                  <button
                    type="button"
                    className="btn sm"
                    data-validation-target="defaults"
                    aria-describedby={controlDescribedBy("defaults", defaultsFailureId)}
                    onClick={() => setDefaultsRetry((value) => value + 1)}
                  >
                    Retry
                  </button>
                )}
              >
                <span id={defaultsFailureId}>Couldn't load your saved permissions.</span>
              </Notice>
            )}
          </SessionOptions>

          {problemFor("form")}
          {/* A request failure sits at the body's end, directly above the footer (§7.3, §13.2). */}
          {requestFailure && (
            <Notice
              tone="danger"
              role="alert"
              title="Couldn't Start the Session"
              actions={retainedSessionId ? (
                <button
                  type="button"
                  className="btn sm"
                  data-validation-target="retained-session"
                  aria-describedby={failureSentenceId}
                  onClick={() => {
                    navigate({ name: "session", id: retainedSessionId });
                    onClose();
                  }}
                >
                  Open Session
                </button>
              ) : undefined}
              details={requestFailure ? <code>{requestFailure.detail}</code> : undefined}
            >
              <span id={failureSentenceId}>{requestFailure?.sentence}</span>
            </Notice>
          )}
        </form>
    </Modal>
    {choosingFolder && runner && (
      <ChooseFolderDialog
        runnerId={runner.runnerId}
        machineName={runnerDisplay(runner, boxByRunner.get(runner.runnerId), runner.runnerId).name}
        protocolVersion={runner.protocolVersion}
        distro={browseDistro}
        returnFocusRef={browseButtonRef}
        onClose={() => setChoosingFolder(false)}
        onPick={(path) => {
          setBrowsedPath(path);
          setChoosingFolder(false);
        }}
      />
    )}
    {editingPolicy && policyContext && (
      <OrchestratorPolicyDialog
        context={policyContext}
        draft={policyDraft}
        initialTab={editingPolicy}
        returnFocusRef={customizeRef}
        onClose={() => setEditingPolicy(null)}
        onApply={(draft) => { setPolicyDraft(draft); setEditingPolicy(null); }}
      />
    )}
    {creatingProject && (
      <CreateProjectDialog
        accessScopeManagementSupported={accessScopeManagementSupported}
        retrySupported={projectCreationRetryAvailable({ conn, projectCreationRetrySupported })}
        projects={projectList}
        stacked
        returnFocusRef={projectPickerFocusRef}
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
        returnFocusRef={locationFocusRef}
        onClose={() => setAddingLocation(false)}
        onManageConnections={() => {
          setAddingLocation(false);
          onClose();
          navigate({ name: "runners", section: "machines" });
        }}
        onAdded={(project, location) => {
          applyProject(project);
          if (location) pickProjectLocation(location);
        }}
      />
    )}
    </>
  );
}
