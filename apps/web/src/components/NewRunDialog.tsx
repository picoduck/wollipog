import { useEffect, useMemo, useState } from "react";
import { type BoxView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { AgentIcon } from "./AgentIcon.js";
import {
  advancedAgentOptions,
  agentOptions,
  defaultRunAgentIds,
  primaryAgentOptions,
  runnableAgentIds,
} from "./agent-options.js";
import { Modal } from "./common.js";
import {
  conductorAgentId,
  defaultWorkflowBindings,
  workflowAgentRoles,
  workflowBindingsComplete,
  type RunWorkMode,
} from "../workflow-presets.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { matchesShortcut } from "../shortcuts.js";
import {
  NO_PROJECT_SELECTION,
  isLaunchableProjectLocation,
  projectRunPlacementIssue,
  projectSelectionLabel,
  projectSessionPlacement,
  suggestedProjectLocation,
} from "../project-session-selection.js";
import { projectAudienceVisibilitySummary } from "../session-project-assignment.js";
import { machineOptionLabels } from "../runners.js";

export function NewRunDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { runners, boxes, projects, projectsSupported, navigate } = useStore();
  const online = useMemo(
    () => [...runners.values()].filter((r) => r.status === "online"),
    [runners],
  );
  // Declared after `online`, which it reads. An unnamed SSH Machine falls back to its Box's SSH
  // target ("build-linux") only when the Box is available here — without it the option renders the
  // opaque connection id instead.
  const boxByRunner = useMemo(() => {
    const map = new Map<string, BoxView>();
    for (const box of boxes.values()) map.set(box.runnerId, box);
    return map;
  }, [boxes]);
  // Machine names are user-owned and not unique, so labels disambiguate only where they collide.
  const machineLabels = useMemo(
    () => machineOptionLabels(online, (runnerId) => boxByRunner.get(runnerId)),
    [boxByRunner, online],
  );

  const projectList = useMemo(
    () => [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [projects],
  );
  const projectNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projectList) counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
    return counts;
  }, [projectList]);
  const [projectSelection, setProjectSelection] = useState(projectsSupported ? "" : NO_PROJECT_SELECTION);
  const selectedProject = projectSelection && projectSelection !== NO_PROJECT_SELECTION
    ? projects.get(projectSelection) ?? null
    : null;
  const [projectLocationId, setProjectLocationId] = useState("");
  const selectedProjectLocation = selectedProject?.locations.find((location) => location.id === projectLocationId) ?? null;
  const projectLocationLaunchable = !!selectedProjectLocation && isLaunchableProjectLocation(selectedProjectLocation, runners);
  const availableProjectLocations = selectedProject?.locations.filter((location) =>
    isLaunchableProjectLocation(location, runners)) ?? [];

  const [runnerId, setRunnerId] = useState(projectsSupported ? "" : online[0]?.runnerId ?? "");
  const runner = runners.get(runnerId);
  const options = useMemo(() => agentOptions(runner?.agents ?? []), [runner?.agents]);
  const primaryOptions = useMemo(() => primaryAgentOptions(options).filter((option) => !option.disabled), [options]);
  const advancedOptions = useMemo(() => advancedAgentOptions(options).filter((option) => !option.disabled), [options]);
  const runnableIds = useMemo(() => runnableAgentIds(runner?.agents ?? []), [runner?.agents]);
  const [workspaceId, setWorkspaceId] = useState(runner?.workspaces[0]?.id ?? "");
  const [agentIds, setAgentIds] = useState<string[]>(() => defaultRunAgentIds(runner?.agents ?? []));
  const [mode, setMode] = useState<RunWorkMode>("parallel");
  const [workflows, setWorkflows] = useState<Awaited<ReturnType<typeof api.workflowDefinitions>>>([]);
  const [workflowId, setWorkflowId] = useState("builtin:build-review");
  const workflow = workflows.find((candidate) => candidate.workflowId === workflowId);
  const [agentBindings, setAgentBindings] = useState<Record<string, string>>({});
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickRunner = (id: string) => {
    setRunnerId(id);
    const r = runners.get(id);
    setWorkspaceId(r?.workspaces[0]?.id ?? "");
    setAgentIds(defaultRunAgentIds(r?.agents ?? []));
  };

  const pickProjectLocation = (locationId: string) => {
    setProjectLocationId(locationId);
    const location = selectedProject?.locations.find((candidate) => candidate.id === locationId);
    if (location) {
      pickRunner(location.runnerId);
      setWorkspaceId(location.workspaceId);
    } else {
      pickRunner("");
    }
  };

  const pickProject = (value: string) => {
    setProjectSelection(value);
    setProjectLocationId("");
    if (value === NO_PROJECT_SELECTION) {
      pickRunner(online[0]?.runnerId ?? "");
      return;
    }
    const project = projects.get(value);
    const location = project ? suggestedProjectLocation(project, runners) : null;
    if (location) {
      setProjectLocationId(location.id);
      pickRunner(location.runnerId);
      setWorkspaceId(location.workspaceId);
    } else {
      pickRunner("");
    }
  };

  const toggleAgent = (id: string) =>
    setAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // If the selected runner goes offline (or the first one arrives while open), re-sync —
  // otherwise the selects show options whose values never made it into state.
  useEffect(() => {
    if (projectsSupported && projectSelection !== NO_PROJECT_SELECTION) return;
    if (!online.some((r) => r.runnerId === runnerId)) {
      pickRunner(online[0]?.runnerId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, projectSelection, projectsSupported]);

  useEffect(() => {
    if (!projectsSupported || !selectedProjectLocation) return;
    if (selectedProjectLocation.runnerId !== runnerId || selectedProjectLocation.workspaceId !== workspaceId) {
      pickRunner(selectedProjectLocation.runnerId);
      setWorkspaceId(selectedProjectLocation.workspaceId);
    }
    // Preserve an unavailable exact choice so the dialog explains it instead of silently moving
    // the run to another repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsSupported, selectedProjectLocation, runnerId, workspaceId]);

  useEffect(() => {
    setAgentIds((ids) => ids.filter((id) => runnableIds.includes(id)));
  }, [runnableIds]);

  useEffect(() => {
    let current = true;
    void api.workflowDefinitions()
      .then((definitions) => {
        if (!current) return;
        setWorkflows(definitions);
        if (!definitions.some((definition) => definition.workflowId === workflowId)) {
          setWorkflowId(definitions[0]?.workflowId ?? "");
        }
      })
      .catch((cause: unknown) => { if (current) setError((cause as Error).message); });
    return () => { current = false; };
    // The definition catalog is immutable per version; load once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    setAgentBindings(defaultWorkflowBindings(workflow, runner?.agents ?? []));
  }, [workflow, runner?.agents]);

  const bindingOptions = options.filter((option) => !option.disabled && option.agent.id !== "conductor");
  const workflowReady = Boolean(workflow && workflowBindingsComplete(workflow, agentBindings));
  const projectPlacementIssue = projectRunPlacementIssue(
    projectsSupported,
    projectSelection,
    selectedProject,
    selectedProjectLocation,
    runners,
  );
  const placementReady = !projectsSupported
    ? !!runnerId && !!workspaceId
    : projectSelection === NO_PROJECT_SELECTION
      ? !!runnerId && !!workspaceId
      : projectPlacementIssue === null;
  const workSelectionReady = mode === "parallel" ? agentIds.length > 0 : workflowReady;
  const selectionReady = placementReady && workSelectionReady;
  const selectedProjectVisibility = selectedProject
    ? projectAudienceVisibilitySummary(selectedProject.audience)
    : null;
  const workflowHasExternalConductor = mode === "workflow"
    && conductorAgentId(runner?.agents ?? []) !== undefined
    && selectedProject?.audience !== "organization";
  const projectVisibilityCopy = projectSelection === NO_PROJECT_SELECTION
    ? "This run will use the selected folder without being added to a Project."
    : !selectedProject
      ? "Choose a Project to organize related run sessions, or choose No Project."
      : selectedProjectVisibility
        ? `A Project keeps related run sessions together. ${selectedProjectVisibility}. ${workflowHasExternalConductor
          ? "Worker session transcripts use the Project's visibility. The conductor session runs outside the Project with organization visibility."
          : "New run session transcripts use the Project's visibility."}`
        : "A Project keeps related run sessions together across Locations. This control plane does not report the Project's visibility.";

  const submit = async () => {
    // Re-entrancy guard: Ctrl/Cmd+Enter bypasses the footer button's disabled attribute, and a
    // duplicate createRun spawns a whole extra fleet of worktrees + agent processes.
    if (busy) return;
    setError(null);
    if (projectPlacementIssue) return setError(projectPlacementIssue);
    if (!runnerId || !workspaceId) return setError("Pick a runner and workspace.");
    if (mode === "parallel" && agentIds.length < 1) return setError("Pick at least one agent.");
    if (mode === "workflow" && (!workflow || !workflowBindingsComplete(workflow, agentBindings))) {
      return setError("Bind every workflow role to an available agent.");
    }
    if (!task.trim()) return setError("Enter a task.");
    setBusy(true);
    try {
      const placement = projectSessionPlacement(projectsSupported, selectedProject, selectedProjectLocation, {
        runnerId,
        workspaceId,
      });
      const { run } = mode === "parallel"
        ? await api.createRun({
            ...placement,
            agentIds,
            task: task.trim(),
            title: title.trim() || undefined,
            useWorktree: true,
          })
        : await api.createWorkflowRun({
            ...placement,
            workflowId: workflow!.workflowId,
            workflowVersion: workflow!.version,
            task: task.trim(),
            title: title.trim() || undefined,
            useWorktree: true,
            agentBindings,
            orchestratorAgentId: conductorAgentId(runner?.agents ?? []),
          });
      navigate({ name: "run", id: run.id });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New Multi-Agent Run"
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error">{error}</span>}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !selectionReady || !task.trim()}>
            {busy
              ? "Starting…"
              : mode === "workflow"
                ? "Start Workflow"
                : agentIds.length === 0
                  ? "Run Agents"
                  : `Run ${agentIds.length} Agent${agentIds.length === 1 ? "" : "s"}`}
          </button>
        </>
      }
    >
      {online.length === 0 && <p className="muted">No runners online. Start a runner first.</p>}
      {!projectsSupported && online.length === 0 ? null : (
        <div className="form">
          <div className="field">
            <span>Preset</span>
            <div className="workflow-preset-grid" role="radiogroup" aria-label="Run Preset" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
              <button type="button" role="radio" aria-checked={mode === "parallel"} tabIndex={mode === "parallel" ? 0 : -1} className={`workflow-preset ${mode === "parallel" ? "on" : ""}`} onClick={() => setMode("parallel")}>
                <strong>Parallel Comparison</strong>
                <span>Send the same task to selected agents in isolated worktrees.</span>
              </button>
              <button type="button" role="radio" aria-checked={mode === "workflow"} tabIndex={mode === "workflow" ? 0 : -1} className={`workflow-preset ${mode === "workflow" ? "on" : ""}`} onClick={() => setMode("workflow")}>
                <strong>Build + Review Workflow</strong>
                <span>Dispatch role-specific steps and converge through durable artifacts and gates.</span>
              </button>
            </div>
          </div>
          <p className="muted">
            {mode === "parallel"
              ? "The same task runs against every selected agent, each in its own isolated worktree, so you can compare results side by side."
              : conductorAgentId(runner?.agents ?? [])
                ? "Workers start idle. The conductor receives the workflow instance and advances only the graph's ready roles."
                : "Workers start idle. Use the workflow controls in the run or an existing conductor to advance ready roles."}
          </p>
          {projectsSupported && (
            <label className="field">
              <span>Project</span>
              <select autoFocus aria-label="Project" value={projectSelection} onChange={(event) => pickProject(event.target.value)}>
                <option value="">Choose a Project…</option>
                <option value={NO_PROJECT_SELECTION}>No Project</option>
                {projectList.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectSelectionLabel(project, (projectNameCounts.get(project.name) ?? 0) > 1)}
                  </option>
                ))}
              </select>
              <span className="muted">{projectVisibilityCopy}</span>
            </label>
          )}

          {projectsSupported && selectedProject && (
            <label className="field">
              <span>Project Location</span>
              {selectedProject.locations.length === 0 ? (
                <span className="project-location-reason">This Project has no Locations. Add a Location before starting a run.</span>
              ) : (
                <select value={projectLocationId} onChange={(event) => pickProjectLocation(event.target.value)}>
                  <option value="">Choose a Location…</option>
                  {selectedProject.locations.map((location) => {
                    const launchable = isLaunchableProjectLocation(location, runners);
                    return (
                      <option key={location.id} value={location.id} disabled={!launchable}>
                        {location.path} · {location.runnerId}{launchable ? "" : " (Unavailable)"}
                      </option>
                    );
                  })}
                </select>
              )}
              {selectedProject.locations.length > 0 && availableProjectLocations.length === 0 && (
                <span className="project-location-reason">No Locations are currently available. Bring a linked machine online or update this Project's Locations.</span>
              )}
              {availableProjectLocations.length > 1 && !projectLocationId && (
                <span className="muted">Choose the exact Location for this run.</span>
              )}
              {selectedProjectLocation && !projectLocationLaunchable && availableProjectLocations.length > 0 && (
                <span className="project-location-reason">The selected Location is unavailable. Choose another Location.</span>
              )}
            </label>
          )}

          {(!projectsSupported || projectSelection === NO_PROJECT_SELECTION) && (
            <>
              <div className="field-row">
                <label className="field">
                  <span>Machine</span>
                  <select value={runnerId} onChange={(e) => pickRunner(e.target.value)}>
                    {online.map((r) => (
                      <option key={r.runnerId} value={r.runnerId}>
                        {machineLabels.get(r.runnerId)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Workspace</span>
                  <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                    {runner?.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}

          {mode === "parallel" ? (
            <div className="field">
              <span>Agents</span>
              <div className="agent-picks">
                {primaryOptions.map(({ agent: a, label }) => (
                  <label key={a.id} className={`agent-pick ${agentIds.includes(a.id) ? "on" : ""}`}>
                    <input type="checkbox" checked={agentIds.includes(a.id)} onChange={() => toggleAgent(a.id)} />
                    <AgentIcon driver={a.driver ?? "acp"} agentName={a.name} size={13} />
                    {label}
                  </label>
                ))}
              </div>
              {advancedOptions.length > 0 && (
                <details className="advanced-agents">
                  <summary>Advanced Agents</summary>
                  <p className="muted">Non-interactive targets are not selected by default.</p>
                  <div className="agent-picks">
                    {advancedOptions.map(({ agent: a, label }) => (
                      <label key={a.id} className={`agent-pick ${agentIds.includes(a.id) ? "on" : ""}`}>
                        <input type="checkbox" checked={agentIds.includes(a.id)} onChange={() => toggleAgent(a.id)} />
                        <AgentIcon driver={a.driver ?? "acp"} agentName={a.name} size={13} />
                        {label}
                      </label>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ) : (
            <>
              <label className="field">
                <span>Workflow</span>
                <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} disabled={!workflows.length}>
                  {workflows.map((definition) => (
                    <option key={definition.workflowId} value={definition.workflowId}>{definition.name} · v{definition.version}</option>
                  ))}
                </select>
                {workflow?.description && <span className="muted">{workflow.description}</span>}
              </label>
              <div className="field">
                <span>Role Bindings</span>
                <div className="workflow-role-bindings">
                  {workflowAgentRoles(workflow).map((role) => (
                    <label key={role}>
                      <span>{role}</span>
                      <select value={agentBindings[role] ?? ""} onChange={(event) => setAgentBindings((current) => ({ ...current, [role]: event.target.value }))}>
                        <option value="">Choose an Agent…</option>
                        {bindingOptions.map(({ agent: candidate, label }) => (
                          <option key={candidate.id} value={candidate.id}>{label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          <label className="field">
            <span>Title (Optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label className="field">
            <span>Task</span>
            <textarea
              value={task}
              rows={5}
              placeholder={mode === "parallel" ? "The task to send to every selected agent…" : "The goal the workflow should converge on…"}
              autoFocus={!projectsSupported}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (matchesShortcut(e.nativeEvent, "submit-run")) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
