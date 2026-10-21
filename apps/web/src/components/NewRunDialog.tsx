import { useEffect, useId, useMemo, useRef, useState } from "react";
import { runnerSupportsProtocol, type BoxView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useStore } from "../store.js";
import { AgentIcon } from "./AgentIcon.js";
import { Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import {
  defaultWorkflowBindings,
  workflowBindingsComplete,
  type RunWorkMode,
} from "../workflow-presets.js";
import { ChoiceRows, SegmentedControl, Select, type SelectOption } from "./ui/ChoiceControls.js";
import { matchesShortcut } from "../shortcuts.js";
import {
  NO_PROJECT_SELECTION,
  projectNameQualifiers,
  projectSessionPlacement,
  suggestedProjectLocation,
} from "../project-session-selection.js";
import { machineOptionLabels } from "../runners.js";
import { podMachineNames } from "../pod-session-choices.js";
import {
  RUN_TYPE_DESCRIPTION,
  defaultRunAgentIds,
  newRunBlockedReason,
  runAgentChoices,
  runLocationOptions,
  runVisibilitySentence,
  selectableRunAgentIds,
  workflowHumanRoles,
  workflowRoleFields,
} from "../run-dialog-choices.js";

/** A failed create request in one sentence (§8.5, §13.2); the server's words stay behind Show Details. */
function startFailureSentence(error: unknown, mode: RunWorkMode): string {
  if (!(error instanceof ApiError)) return "Wollipog couldn't reach the server. Check your connection and try again.";
  if (error.status === 403) return "You don't have permission to start a run here.";
  return mode === "workflow"
    ? "The workflow didn't start. Check the choices above and try again."
    : "The run didn't start. Check the choices above and try again.";
}

/**
 * New Multi-Agent Run (#2978; docs/design-system.md §3.1, §7.1–§7.3, §7.5, §8.1, §8.4–§8.5, §12,
 * §13.2, §17): the type, the task, where it runs, then the agents (Compare Agents) or the workflow
 * and its roles (Run a Workflow), and an optional title last. The primary stays disabled with its
 * reason in the footer until the run can start; a server error is a danger notice at the body's end.
 * With no Machine online a warning leads the body and the form stays visible. On a phone it is a
 * full-height sheet. While the run is starting the dialog cannot be dismissed, so the person always
 * lands on the run it made or sees why it wasn't.
 */
export function NewRunDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { runners, boxes, projects, projectsSupported, navigate } = useStore();
  const ids = useId();
  const online = useMemo(
    () => [...runners.values()].filter((r) => r.status === "online"),
    [runners],
  );
  // An unnamed SSH Machine falls back to its Box's SSH target ("build-linux") only when the Box is
  // available here — without it the option renders the opaque connection id instead.
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
  // Locations and agent rows name a Machine without ever falling back to its connection id.
  const machineNames = useMemo(
    () => podMachineNames(runners.values(), (runnerId) => boxByRunner.get(runnerId)),
    [boxByRunner, runners],
  );

  const projectList = useMemo(
    () => [...projects.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [projects],
  );
  // Until the person chooses, the selection follows whether this server has projects, which the
  // first snapshot may tell the dialog only after it opened.
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const projectSelection = projectChoice ?? (projectsSupported ? "" : NO_PROJECT_SELECTION);
  const placedByMachine = !projectsSupported || projectSelection === NO_PROJECT_SELECTION;
  const selectedProject = projectSelection && projectSelection !== NO_PROJECT_SELECTION
    ? projects.get(projectSelection) ?? null
    : null;
  const [projectLocationId, setProjectLocationId] = useState("");
  const selectedProjectLocation = selectedProject?.locations.find((location) => location.id === projectLocationId) ?? null;

  const [runnerId, setRunnerId] = useState(projectsSupported ? "" : online[0]?.runnerId ?? "");
  const runner = runners.get(runnerId);
  const machine = machineNames.get(runnerId) ?? machineLabels.get(runnerId) ?? "this machine";
  const agentChoices = useMemo(
    () => runAgentChoices(runner?.agents ?? [], machine,
      runnerSupportsProtocol(runner?.protocolVersion, "verifiedAgentAvailability")),
    [machine, runner?.agents, runner?.protocolVersion],
  );
  const selectableIds = useMemo(() => selectableRunAgentIds(runner?.agents ?? []), [runner?.agents]);
  const [workspaceId, setWorkspaceId] = useState(runner?.workspaces[0]?.id ?? "");
  const [agentIds, setAgentIds] = useState<string[]>(() => defaultRunAgentIds(runner?.agents ?? []));
  const [mode, setMode] = useState<RunWorkMode>("parallel");
  const [workflows, setWorkflows] = useState<Awaited<ReturnType<typeof api.workflowDefinitions>> | null>(null);
  const [workflowsFailure, setWorkflowsFailure] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState("builtin:build-review");
  const workflow = workflows?.find((candidate) => candidate.workflowId === workflowId);
  const [agentBindings, setAgentBindings] = useState<Record<string, string>>({});
  const [task, setTask] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ sentence: string; detail: string } | null>(null);
  // Set on every setup, not only the first: StrictMode replays setup and cleanup once, and a flag
  // only ever cleared would drop the answer after the replay.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const starting = useRef(false);

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
    setProjectChoice(value);
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

  // If the selected Machine goes offline (or the first one arrives while open), re-sync —
  // otherwise the pickers show options whose values never made it into state.
  useEffect(() => {
    if (!placedByMachine) return;
    if (!online.some((r) => r.runnerId === runnerId)) {
      pickRunner(online[0]?.runnerId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, placedByMachine]);

  useEffect(() => {
    if (placedByMachine) return;
    // A project's run has a Machine only through its chosen Location.
    if (!selectedProjectLocation) {
      if (runnerId) pickRunner("");
      return;
    }
    if (selectedProjectLocation.runnerId !== runnerId || selectedProjectLocation.workspaceId !== workspaceId) {
      pickRunner(selectedProjectLocation.runnerId);
      setWorkspaceId(selectedProjectLocation.workspaceId);
    }
    // Preserve an unavailable exact choice so the dialog explains it instead of silently moving
    // the run to another repository.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedByMachine, selectedProjectLocation, runnerId, workspaceId]);

  // An agent that signs out or disappears while the dialog is open stops counting.
  useEffect(() => {
    setAgentIds((current) => current.filter((id) => selectableIds.includes(id)));
  }, [selectableIds]);

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
      .catch((cause: unknown) => {
        if (!current) return;
        setWorkflows([]);
        setWorkflowsFailure(cause instanceof Error && cause.message ? cause.message : String(cause));
      });
    return () => { current = false; };
    // The definition catalog is immutable per version; load once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // A role is prebound only to an agent this run can start. A choice the person made stays while
  // that agent can still start, so a Machine's routine update does not undo it.
  useEffect(() => {
    setAgentBindings((current) => {
      const next = defaultWorkflowBindings(workflow, (runner?.agents ?? []).filter((agent) => selectableIds.includes(agent.id)));
      for (const { key } of workflowRoleFields(workflow)) {
        const chosen = current[key];
        if (chosen && selectableIds.includes(chosen)) next[key] = chosen;
      }
      return next;
    });
  }, [workflow, runner?.agents, selectableIds]);

  const roleFields = workflowRoleFields(workflow);
  const humanRoles = workflowHumanRoles(workflow);
  const chosenAgentIds = agentIds.filter((id) => selectableIds.includes(id));
  const blockedReason = newRunBlockedReason({
    task,
    machinesOnline: online.length > 0,
    placedByMachine,
    projectChosen: projectSelection !== "",
    project: selectedProject,
    location: selectedProjectLocation,
    runners,
    runnerId: runner?.status === "online" ? runnerId : "",
    workspaceId,
    mode,
    agentCount: chosenAgentIds.length,
    workflowChosen: Boolean(workflow),
    workflowBound: Boolean(workflow && workflowBindingsComplete(workflow, agentBindings) &&
      Object.values(agentBindings).every((id) => selectableIds.includes(id))),
  });
  const reasonId = `${ids}-reason`;
  const typeHelperId = `${ids}-type`;
  const projectHelperId = `${ids}-project`;
  const visibility = projectsSupported ? runVisibilitySentence(selectedProject, projectSelection === NO_PROJECT_SELECTION) : null;

  const close = () => { if (!starting.current) onClose(); };

  const submit = async () => {
    // Ctrl/Cmd+Enter bypasses the footer button, and a duplicate create spawns a whole extra fleet
    // of worktrees and agent processes.
    if (starting.current || blockedReason) return;
    starting.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const placement = projectSessionPlacement(projectsSupported, selectedProject, selectedProjectLocation, {
        runnerId,
        workspaceId,
      });
      const { run } = mode === "parallel"
        ? await api.createRun({
            ...placement,
            agentIds: chosenAgentIds,
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
          });
      starting.current = false;
      if (!mounted.current) return;
      navigate({ name: "run", id: run.id });
      onClose();
    } catch (cause) {
      starting.current = false;
      if (!mounted.current) return;
      setFailure({
        sentence: startFailureSentence(cause, mode),
        detail: cause instanceof Error && cause.message ? cause.message : String(cause),
      });
      setBusy(false);
    }
  };

  // Two projects with one name are told apart by where each runs, as precisely as they need (as in
  // New Session): the Machine, then its folder, then a longer path. A Machine is never named by id.
  const projectQualifiers = projectNameQualifiers(projectList, (runnerId) => machineNames.get(runnerId) ?? "Unnamed Machine");
  const projectOptions: SelectOption<string>[] = [
    ...projectList.map((project) => {
      const where = projectQualifiers.get(project.id);
      return {
        value: project.id,
        label: project.name,
        ...(where ? { description: where, selectedLabel: `${project.name} · ${where}` } : {}),
      };
    }),
    { value: NO_PROJECT_SELECTION, label: "No Project", separator: projectList.length > 0 },
  ];
  const locationOptions = selectedProject ? runLocationOptions(selectedProject, runners, machineNames) : [];

  const agentsPlaceholder = online.length === 0 ? "Bring a machine online to see its agents."
    : placedByMachine ? "Choose a machine to see its agents."
      : !selectedProject ? "Choose a project to see its agents."
        : "Choose a location to see its agents.";

  const projectField = (
    <div className="field">
      <span>Project</span>
      <Select<string>
        label="Project"
        value={projectSelection || null}
        onChange={pickProject}
        options={projectOptions}
        placeholder="Choose a Project…"
        searchable={projectList.length > 8}
        noun="projects"
        describedBy={visibility ? projectHelperId : undefined}
      />
      {visibility && <p className="field-helper" id={projectHelperId}>{visibility}</p>}
    </div>
  );

  const roleOptions: SelectOption<string>[] =agentChoices.map(({ option, description, disabledReason }) => ({
    value: option.agent.id,
    label: option.label,
    ...(disabledReason ? { disabled: true, disabledReason } : { description }),
  }));

  return (
    <Modal
      title="New Multi-Agent Run"
      phoneSheet="full"
      onClose={close}
      footer={
        <>
          {blockedReason && <span className="new-run-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          <BusyButton
            className="btn primary"
            busy={busy}
            progress={mode === "workflow" ? "Starting the workflow…" : "Starting the agents…"}
            disabled={Boolean(blockedReason)}
            aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void submit()}
          >
            {mode === "workflow"
              ? "Start Workflow"
              : chosenAgentIds.length === 0
                ? "Run Agents"
                : `Run ${chosenAgentIds.length} Agent${chosenAgentIds.length === 1 ? "" : "s"}`}
          </BusyButton>
        </>
      }
    >
      {online.length === 0 && (
        <Notice
          tone="warning"
          title="No Machines Online"
          actions={(
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => {
                if (starting.current) return;
                navigate({ name: "runners", section: "machines" });
                onClose();
              }}
            >
              Open Connections
            </button>
          )}
        >
          Start Wollipog on a machine to run agents.
        </Notice>
      )}
      <div className="form">
        <div className="field">
          <SegmentedControl<RunWorkMode>
            className="block"
            label="Run Type"
            value={mode}
            onChange={setMode}
            describedBy={typeHelperId}
            options={[
              { value: "parallel", label: "Compare Agents" },
              { value: "workflow", label: "Run a Workflow" },
            ]}
          />
          <p className="field-helper" id={typeHelperId}>{RUN_TYPE_DESCRIPTION[mode]}</p>
        </div>

        <label className="field">
          <span>Task</span>
          <textarea
            value={task}
            rows={3}
            placeholder={mode === "parallel" ? "e.g. Add retry with backoff to the uploads client" : "e.g. Build and review the uploads retry change"}
            autoFocus
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (matchesShortcut(e.nativeEvent, "submit-run")) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>

        {/* Project beside its Location; with No Project, Project alone above Machine and Folder. */}
        {projectsSupported && (placedByMachine ? projectField : (
          <div className="field-row">
            {projectField}
            <div className="field">
              <span>Location</span>
              <Select<string>
                label="Location"
                value={selectedProjectLocation ? selectedProjectLocation.id : null}
                onChange={pickProjectLocation}
                options={locationOptions}
                placeholder={!selectedProject ? "Choose a Project First"
                  : locationOptions.length === 0 ? "No Locations Yet" : "Choose a Location…"}
                disabled={!selectedProject || locationOptions.length === 0}
              />
            </div>
          </div>
        ))}

        {placedByMachine && (
          <div className="field-row">
            <div className="field">
              <span>Machine</span>
              <Select<string>
                label="Machine"
                value={runner?.status === "online" ? runnerId : null}
                onChange={pickRunner}
                options={online.map((r) => ({ value: r.runnerId, label: machineLabels.get(r.runnerId) ?? r.hostname }))}
                placeholder={online.length === 0 ? "No Machines Online" : "Choose a Machine…"}
                disabled={online.length === 0}
              />
            </div>
            <div className="field">
              <span>Folder</span>
              <Select<string>
                label="Folder"
                value={workspaceId || null}
                onChange={setWorkspaceId}
                options={(runner?.workspaces ?? []).map((w) => ({ value: w.id, label: w.name, description: w.path }))}
                placeholder={runner ? "Choose a Folder…" : "Choose a Machine First"}
                disabled={!runner || runner.workspaces.length === 0}
              />
            </div>
          </div>
        )}

        {mode === "parallel" ? (
          <div className="field">
            <span id={`${ids}-agents`}>Agents</span>
            {!runner ? (
              <p className="field-helper">{agentsPlaceholder}</p>
            ) : agentChoices.length === 0 ? (
              <p className="field-helper">{`No agents are set up on ${machine}.`}</p>
            ) : (
              <ChoiceRows<string>
                multiple
                className="surface new-run-agents"
                label="Agents"
                labelledBy={`${ids}-agents`}
                value={chosenAgentIds}
                onChange={toggleAgent}
                options={agentChoices.map(({ option, description, disabledReason }) => ({
                  value: option.agent.id,
                  title: option.label,
                  icon: <AgentIcon driver={option.agent.driver ?? "acp"} agentName={option.agent.name} size={16} />,
                  ...(disabledReason ? { disabled: true, disabledReason } : { description }),
                }))}
              />
            )}
          </div>
        ) : (
          <>
            <div className="field">
              <span>Workflow</span>
              <Select<string>
                label="Workflow"
                value={workflow ? workflow.workflowId : null}
                onChange={setWorkflowId}
                options={(workflows ?? []).map((definition) => ({
                  value: definition.workflowId,
                  label: definition.name,
                  description: `Version ${definition.version}`,
                }))}
                placeholder={workflows?.length === 0 ? "No Workflows" : "Choose a Workflow…"}
                disabled={!workflows?.length}
              />
              {workflow?.description && <p className="field-helper">{workflow.description}</p>}
            </div>
            {workflowsFailure && (
              <Notice tone="danger" compact details={<code>{workflowsFailure}</code>}>
                Wollipog couldn't load the workflows. Close New Multi-Agent Run and open it again to retry.
              </Notice>
            )}
            {workflow && (
              <fieldset className="new-run-roles">
                <legend>Roles</legend>
                {!runner ? (
                  <p className="field-helper">{agentsPlaceholder}</p>
                ) : roleFields.map((role) => (
                  <div className="field" key={role.key}>
                    <span>{role.label}</span>
                    <Select<string>
                      label={role.label}
                      value={agentBindings[role.key] || null}
                      onChange={(agentId) => setAgentBindings((current) => ({ ...current, [role.key]: agentId }))}
                      options={roleOptions}
                      placeholder="Choose an Agent…"
                    />
                  </div>
                ))}
                {humanRoles.length > 0 && (
                  <dl className="facts">
                    {humanRoles.map((role) => (
                      <div key={role}><dt>{role}</dt><dd>You, in the run</dd></div>
                    ))}
                  </dl>
                )}
              </fieldset>
            )}
          </>
        )}

        <label className="field">
          <span>Title (Optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      {failure && (
        <Notice tone="danger" role="alert" details={<code>{failure.detail}</code>}>
          {failure.sentence}
        </Notice>
      )}
    </Modal>
  );
}
