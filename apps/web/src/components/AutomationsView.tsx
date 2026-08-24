import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentDefinition,
  AutomationAction,
  AutomationExecution,
  AutomationSchedule,
  AutomationSpec,
  AutomationTriggerCredential,
  AutomationTriggerKind,
  AutomationTriggerView,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { AutomationsIcon } from "./Icons.js";
import { Empty } from "./common.js";
import { useApi } from "../api-context.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { titleCaseLabel } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { machineOptionLabels } from "../runners.js";
import { useExperiments } from "../use-experiments.js";
import { agentDisplayName } from "../agent-presentation.js";
import { Select } from "./ui/ChoiceControls.js";
import {
  buildSpec,
  defaults,
  formFrom,
  specOf,
  withAgent,
  withModel,
  type FormState,
} from "../automation-form.js";

type ActionKind = AutomationAction["kind"];

function formatTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function actionSummary(action: AutomationAction): string {
  if (action.kind === "prompt_session") return `Prompt session ${action.sessionId}`;
  if (action.kind === "workflow_run") return `Workflow ${action.request.workflowId} on ${action.request.runnerId}`;
  return `Create ${action.request.agentId} session on ${action.request.runnerId}`;
}

export function AutomationsView() {
  const api = useApi();
  const instances = useInstances();
  const publicOrigin = instancePublicOrigin(instances);
  const { confirm } = useFeedback();
  // Workflow runs belong to the Multi-Agent experiment: with it off, this view must not offer
  // creating one. An automation that ALREADY uses the action keeps its option so editing it
  // renders truthfully — the flag hides surfaces, it does not orphan stored data.
  const multiAgentEnabled = useExperiments().flags.multiAgent;
  // The conductor is advertised by every runner that can host one, but it is a feature behind
  // the device-local Conductor-Led Work experiment. With the switch off it must not be
  // schedulable here — while an automation ALREADY targeting it keeps its stored agent visible,
  // the same never-silently-rewrite rule the rest of this form follows.
  const conductorEnabled = useExperiments().flags.conductor;
  const automationAgents = (agents: readonly AgentDefinition[] | undefined, keepId: string) =>
    (agents ?? []).filter((agent) => conductorEnabled || agent.id !== "conductor" || agent.id === keepId);
  const defaultAgentId = (agents: readonly AgentDefinition[] | undefined) =>
    automationAgents(agents, "")[0]?.id ?? "";
  const runners = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  // Passing the correlated Box matters for an SSH Machine left unnamed: runnerDisplay falls back
  // to the ssh target, so it reads as "build-linux" rather than an opaque runner id.
  const machineLabels = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return machineOptionLabels([...runners.values()], (id) => boxByRunner.get(id));
  }, [boxes, runners]);
  const sessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  const { navigate } = useStoreActions();
  const [items, setItems] = useState<AutomationSchedule[]>([]);
  const [details, setDetails] = useState<Record<string, AutomationExecution[]>>({});
  const [triggers, setTriggers] = useState<Record<string, AutomationTriggerView[]>>({});
  const [credential, setCredential] = useState<AutomationTriggerCredential | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [form, setForm] = useState<FormState>(defaults);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The exact stored spec behind `editingId`. Saving replaces the whole spec, so the builder needs
  // the original to carry across every field this form does not render.
  const [editingSpec, setEditingSpec] = useState<AutomationSpec | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The newest refresh that has been STARTED. Only it may commit.
   *
   * This list is polled every five seconds and also refreshed after every mutation, so two are
   * routinely in flight. Without a generation, a slow earlier request commits after a later one and
   * the screen goes backwards — and because the editor now closes when its automation leaves the
   * list, going backwards means silently discarding someone's unsaved form for an automation that
   * still exists.
   */
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = (refreshGeneration.current += 1);
    const current = () => generation === refreshGeneration.current;

    // The automation list is authoritative and is committed on its own. It used to share a
    // `Promise.all` with the workflow definitions, so a rejected workflow fetch threw away a
    // successful list — which meant a deleted automation stayed on screen, the editor stayed open
    // on it, and Save sent `updateAutomation` for an ID the control plane no longer had.
    const automationResult = await api.automations();
    if (!current()) return;
    setItems(automationResult.automations);

    const workflowsLoaded = api.workflowDefinitions()
      .then((workflowResult) => { if (current()) setWorkflows(workflowResult); });

    const loaded = await Promise.all(automationResult.automations.map(async (item) => {
      const [detail, triggerResult] = await Promise.all([
        api.automation(item.automationId),
        api.automationTriggers(item.automationId),
      ]);
      return [item.automationId, detail.executions, triggerResult.triggers] as const;
    }));
    if (!current()) return;
    setDetails(Object.fromEntries(loaded.map(([id, executions]) => [id, executions])));
    setTriggers(Object.fromEntries(loaded.map(([id, _executions, triggerItems]) => [id, triggerItems])));
    // Awaited last so a workflow failure is still reported, but only after the list it has no
    // business blocking has been committed.
    await workflowsLoaded;
  }, [api]);

  useEffect(() => {
    let active = true;
    const load = () => refresh().catch((cause) => active && setError((cause as Error).message));
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const selectedRunner = runners.get(form.runnerId);
  const selectedFallback = runners.get(form.fallbackRunnerId);
  const carriedAlternateRunnerIds = new Set(editingSpec?.runnerPolicy.kind === "alternate" &&
      editingSpec.action.kind === form.actionKind
    ? editingSpec.runnerPolicy.targets.slice(1).map((target) => target.runnerId)
    : []);
  // Model, effort, and permission mode are agent-scoped: the runner advertises them per agent, and
  // the pickers must never offer a value the selected agent cannot honour. A value already stored
  // but no longer advertised is still listed, so editing an automation cannot silently rewrite it.
  const agentCapabilities = selectedRunner?.agents.find((agent) => agent.id === form.agentId)?.capabilities;
  // An explicit alternate runs the SAME stored config on a different agent, so the finished spec is
  // validated against it on save. Narrowing the pickers instead was tried and reverted; see
  // `alternateConfigError`.
  const alternateCapabilities = form.actionKind === "create_session" && form.runnerPolicy === "alternate"
    ? selectedFallback?.agents.find((agent) => agent.id === form.fallbackAgentId)?.capabilities
    : undefined;
  const modelOptions = useMemo(() => {
    const advertised = (agentCapabilities?.models ?? []).filter((model) => !model.hidden);
    return form.model && !advertised.some((model) => model.id === form.model)
      ? [{ id: form.model, displayName: form.model }, ...advertised]
      : advertised;
  }, [agentCapabilities, form.model]);
  const effortOptions = useMemo(() => {
    const model = agentCapabilities?.models.find((candidate) => candidate.id === form.model);
    const advertised = (model?.efforts?.length ? model.efforts : agentCapabilities?.effortLevels) ?? [];
    return form.effort && !advertised.includes(form.effort) ? [form.effort, ...advertised] : advertised;
  }, [agentCapabilities, form.model, form.effort]);
  const permissionModeOptions = useMemo(() => {
    const advertised = agentCapabilities?.permissionModes ?? [];
    return form.permissionMode && !advertised.includes(form.permissionMode)
      ? [form.permissionMode, ...advertised]
      : advertised;
  }, [agentCapabilities, form.permissionMode]);
  const editableSessions = useMemo(() => [...sessions.values()]
    .filter((session) => !session.archived && !["completed", "failed", "stopped"].includes(session.status))
    .sort((a, b) => a.title.localeCompare(b.title)), [sessions]);
  const promptRunner = form.actionKind === "prompt_session"
    ? runners.get(sessions.get(form.sessionId)?.runnerId ?? "")
    : undefined;
  const incompatibleRunners = [form.actionKind === "prompt_session" ? promptRunner : selectedRunner,
    form.runnerPolicy === "alternate" ? selectedFallback : undefined]
    .filter((runner) => runner && (runner.protocolVersion ?? 0) < 53);

  useEffect(() => {
    if (!form.runnerId && runners.size) {
      const runner = [...runners.values()][0]!;
      setForm((current) => ({
        ...current, runnerId: runner.runnerId, workspaceId: runner.workspaces[0]?.id ?? "",
        agentId: defaultAgentId(runner.agents),
      }));
    }
  }, [form.runnerId, runners]);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const currentSpec = (): AutomationSpec => buildSpec(form, {
    projectsSupported,
    projects: projects.values(),
    ...(editingSpec ? { base: editingSpec } : {}),
    ...(alternateCapabilities ? { alternateCapabilities } : {}),
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const spec = currentSpec();
      if (editingId) await api.updateAutomation(editingId, spec);
      else await api.createAutomation(spec);
      setEditingId(null);
      setEditingSpec(null);
      setForm(defaults());
      setShowForm(false);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Opening and closing the editor, in one place each.
   *
   * `showForm` and `editingId` are two pieces of one state, and every caller that moved only one of
   * them left the other behind. Cancel closed the editor with `editingId` still set, so the next
   * opener that only flipped `showForm` — the empty state's own New Automation — reopened the editor
   * titled "Edit Automation" over the previous form. If the automation it pointed at had since been
   * deleted, Save sent `updateAutomation` for an ID the control plane no longer has.
   */
  const closeEditor = () => {
    setShowForm(false);
    setEditingId(null);
    setEditingSpec(null);
    setForm(defaults());
  };

  const openNewAutomation = () => {
    setEditingId(null);
    setEditingSpec(null);
    setForm(defaults());
    setShowForm(true);
  };

  // Deleting the automation that is open for editing leaves the editor pointed at an ID the control
  // plane no longer has, and Save would send `updateAutomation` for it. The list is polled, so the
  // disappearance is the signal — including when the delete happened in another tab.
  useEffect(() => {
    if (editingId && !items.some((item) => item.automationId === editingId)) closeEditor();
  }, [editingId, items]);

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createTrigger = async (automation: AutomationSchedule, kind: AutomationTriggerKind) => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createAutomationTrigger(automation.automationId, {
        kind,
        name: `${automation.name} ${kind === "chatops" ? "chat-ops" : "webhook"}`.slice(0, 80),
      });
      setCredential(created);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rotateTrigger = async (automationId: string, triggerId: string) => {
    setBusy(true);
    setError(null);
    try {
      const rotated = await api.rotateAutomationTrigger(automationId, triggerId);
      setCredential(rotated);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revokeTrigger = async (automationId: string, triggerId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAutomationTrigger(automationId, triggerId);
      if (credential?.trigger.triggerId === triggerId) setCredential(null);
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="automations-view">
      <div className="view-heading automation-heading">
        <div>
          <h2>Durable Automations</h2>
          <p>Schedules use durable runner receipts and stable command IDs. Keep the control plane and its SQLite database online; sleeping runners wait or expire by policy.</p>
        </div>
        <button className="btn primary" type="button" onClick={openNewAutomation}>New Automation</button>
      </div>
      {error && <div className="automation-error" role="alert">{error}</div>}

      {showForm && (
        <div className="automation-editor" aria-label={editingId ? "Edit Automation" : "New Automation"}>
          <div className="automation-editor-head">
            <h3>{editingId ? "Edit Automation" : "New Automation"}</h3>
            <button className="icon-btn" type="button" aria-label="Close Automation Editor" onClick={closeEditor}>×</button>
          </div>
          <div className="automation-form-grid">
            <label>Name<input value={form.name} maxLength={120} onChange={(event) => patch("name", event.target.value)} /></label>
            <label>Cron (Minute Hour Day Month Weekday)<input value={form.cron} maxLength={128} onChange={(event) => patch("cron", event.target.value)} /></label>
            <label>Timezone<input value={form.timezone} maxLength={128} onChange={(event) => patch("timezone", event.target.value)} /></label>
            <label>Action<select value={form.actionKind} onChange={(event) => {
              const kind = event.target.value as ActionKind;
              setForm((current) => ({ ...current, actionKind: kind,
                runnerPolicy: kind === "prompt_session" && current.runnerPolicy === "alternate" ? "wait" : current.runnerPolicy,
                concurrency: kind === "prompt_session" && current.concurrency === "parallel" ? "wait" : current.concurrency }));
            }}><option value="create_session">Create Session</option><option value="prompt_session">Prompt Existing Session</option>{(multiAgentEnabled || form.actionKind === "workflow_run") && <option value="workflow_run">Start Workflow Run</option>}</select></label>

            {form.actionKind === "prompt_session" ? (
              <label className="automation-span">Session<select value={form.sessionId} onChange={(event) => patch("sessionId", event.target.value)}>
                <option value="">Select a Session…</option>
                {editableSessions.map((session) => <option key={session.id} value={session.id}>{session.title} · {session.status}</option>)}
              </select></label>
            ) : (
              <>
                <label>Machine<select value={form.runnerId} onChange={(event) => {
                  const runner = runners.get(event.target.value);
                  setForm((current) => ({ ...withAgent(current, defaultAgentId(runner?.agents)),
                    runnerId: event.target.value, workspaceId: runner?.workspaces[0]?.id ?? "" }));
                }}>{[...runners.values()].map((runner) => <option
                  key={runner.runnerId} value={runner.runnerId}
                  disabled={runner.runnerId !== form.runnerId && carriedAlternateRunnerIds.has(runner.runnerId)}
                >{machineLabels.get(runner.runnerId)}</option>)}</select></label>
                <label>Workspace<select value={form.workspaceId} onChange={(event) => patch("workspaceId", event.target.value)}>
                  {(selectedRunner?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select></label>
                {form.actionKind === "create_session" ? <label>Agent<select value={form.agentId} onChange={(event) => setForm((current) => withAgent(current, event.target.value))}>
                  {automationAgents(selectedRunner?.agents, form.agentId).map((agent) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}
                </select></label> : <label>Workflow<select value={form.workflowId} onChange={(event) => patch("workflowId", event.target.value)}>
                  {workflows.map((workflow) => <option key={`${workflow.workflowId}:${workflow.version}`} value={workflow.workflowId}>{workflow.name} · v{workflow.version}</option>)}
                </select></label>}
              </>
            )}
            {form.actionKind === "create_session" && <>
              {modelOptions.length > 0 && <div className="automation-field">
                <span className="field-label">Model</span>
                <Select label="Model" value={form.model} onChange={(value) => setForm((current) => withModel(current, value, agentCapabilities))}
                  options={[{ value: "", label: "Agent Default" },
                    ...modelOptions.map((model) => ({
                      value: model.id,
                      label: model.displayName ?? model.id,
                      ...(model.description ? { description: model.description } : {}),
                    }))]} />
              </div>}
              {effortOptions.length > 0 && <div className="automation-field">
                <span className="field-label">Reasoning Effort</span>
                <Select label="Reasoning Effort" value={form.effort} onChange={(value) => patch("effort", value)}
                  options={[{ value: "", label: "Agent Default" },
                    ...effortOptions.map((effort) => ({ value: effort, label: titleCaseLabel(effort) }))]} />
              </div>}
              {permissionModeOptions.length > 0 && <div className="automation-field">
                <span className="field-label">Permission Mode</span>
                <Select label="Permission Mode" value={form.permissionMode} onChange={(value) => patch("permissionMode", value)}
                  options={[{ value: "", label: "Agent Default" },
                    ...permissionModeOptions.map((mode) => ({ value: mode, label: titleCaseLabel(mode) }))]} />
              </div>}
              <div className="automation-field">
                <span className="field-label">Workspace Strategy</span>
                <Select label="Workspace Strategy" value={form.useWorktree ? "worktree" : "in_place"}
                  onChange={(value) => patch("useWorktree", value === "worktree")}
                  options={[
                    { value: "worktree", label: "Worktree", description: "Each run gets an isolated checkout." },
                    { value: "in_place", label: "In Place", description: "Each run works directly in the workspace." },
                  ]} />
              </div>
            </>}
            <label className="automation-span">{form.actionKind === "workflow_run" ? "Task" : "Prompt"}<textarea value={form.prompt} maxLength={65_536} rows={4} onChange={(event) => patch("prompt", event.target.value)} /></label>
            <label>Misfire<select value={form.misfire} onChange={(event) => patch("misfire", event.target.value as FormState["misfire"])}><option value="skip">Skip Missed Fires</option><option value="fire_once">Run Once</option><option value="catch_up">Bounded Catch-Up</option></select></label>
            {form.misfire === "catch_up" && <label>Catch-Up Cap<input type="number" min="1" max="10" value={form.catchUpRuns} onChange={(event) => patch("catchUpRuns", event.target.value)} /></label>}
            <label>Runner Availability<select value={form.runnerPolicy} onChange={(event) => patch("runnerPolicy", event.target.value as FormState["runnerPolicy"])}><option value="wait">Wait</option><option value="expire">Expire</option>{form.actionKind !== "prompt_session" && <option value="alternate">Use Explicit Alternate</option>}</select></label>
            {form.runnerPolicy !== "wait" && <label>Expiry (Minutes)<input type="number" min="1" max="43200" value={form.expiryMinutes} onChange={(event) => patch("expiryMinutes", event.target.value)} /></label>}
            {form.runnerPolicy === "alternate" && <>
              <label>Alternate Machine<select value={form.fallbackRunnerId} onChange={(event) => {
                const runner = runners.get(event.target.value);
                setForm((current) => ({ ...current, fallbackRunnerId: event.target.value,
                  fallbackWorkspaceId: runner?.workspaces[0]?.id ?? "", fallbackAgentId: defaultAgentId(runner?.agents) }));
              }}><option value="">Select…</option>{[...runners.values()]
                .filter((runner) => runner.runnerId !== form.runnerId && !carriedAlternateRunnerIds.has(runner.runnerId))
                .map((runner) => <option key={runner.runnerId} value={runner.runnerId}>{machineLabels.get(runner.runnerId)}</option>)}</select></label>
              <label>Alternate Workspace<select value={form.fallbackWorkspaceId} onChange={(event) => patch("fallbackWorkspaceId", event.target.value)}>{(selectedFallback?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
              {form.actionKind === "create_session" && <label>Alternate Agent<select value={form.fallbackAgentId} onChange={(event) => patch("fallbackAgentId", event.target.value)}>{automationAgents(selectedFallback?.agents, form.fallbackAgentId).map((agent) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}</select></label>}
            </>}
            <label>Concurrency<select value={form.concurrency} onChange={(event) => patch("concurrency", event.target.value as FormState["concurrency"])}><option value="wait">Wait for Previous</option><option value="skip">Skip While Active</option>{form.actionKind !== "prompt_session" && <option value="parallel">Allow Parallel</option>}</select></label>
            <label>Max Additional Cost (USD)<input type="number" min="0.01" max="10000" step="0.01" value={form.maxCostUsd} onChange={(event) => patch("maxCostUsd", event.target.value)} /></label>
            <label>Max Tool Calls<input type="number" min="1" max="100000" value={form.maxToolCalls} onChange={(event) => patch("maxToolCalls", event.target.value)} /></label>
            <fieldset className="automation-span"><legend>Web Push Events</legend><div className="automation-checks">{(["started", "succeeded", "failed", "expired"] as const).map((event) => <label key={event}><input type="checkbox" checked={form.pushEvents.includes(event)} onChange={(change) => patch("pushEvents", change.target.checked ? [...form.pushEvents, event] : form.pushEvents.filter((item) => item !== event))} />{titleCaseLabel(event)}</label>)}</div></fieldset>
            <label className="automation-enable"><input type="checkbox" checked={form.enabled} onChange={(event) => patch("enabled", event.target.checked)} />Enabled</label>
          </div>
          {incompatibleRunners.length > 0 && <div className="automation-error" role="alert">
            Update and restart {incompatibleRunners.map((runner) => runner!.hostname).join(", ")} to protocol 53 before this automation can run. Durable delivery never falls back to an older fire-and-forget command.
          </div>}
          <p className="automation-hint">Five-field cron uses the selected IANA timezone. Spring-forward gaps are skipped; repeated fall-back wall times fire once. Session actions are bounded by both ceilings; workflow ceilings apply separately to each member session.</p>
          <div className="automation-editor-actions"><button className="btn ghost" type="button" onClick={closeEditor}>Cancel</button><button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Automation"}</button></div>
        </div>
      )}

      <div className="automation-list">
        {items.length === 0 && !showForm && (
          <Empty
            icon={<AutomationsIcon size={28} />}
            title="No Automations Yet"
            // This screen exposed an `h3` before the conversion, and heading navigation is how a
            // screen-reader user finds a section. Losing it is not a styling change.
            headingLevel={3}
            hint="Create a finite, auditable schedule that runs while this control plane stays online."
            action={
              <button type="button" className="btn primary sm" onClick={openNewAutomation}>
                New Automation
              </button>
            }
          />
        )}
        {items.map((item) => {
          const executions = details[item.automationId] ?? [];
          const triggerItems = triggers[item.automationId] ?? [];
          const latest = executions[0];
          return <article className="automation-card" key={item.automationId}>
            <div className="automation-card-head"><div><h3>{item.name}</h3><p>{actionSummary(item.action)}</p></div><span className={`automation-state ${item.enabled ? "enabled" : "paused"}`}>{item.enabled ? "Enabled" : "Paused"}</span></div>
            <dl className="automation-facts"><div><dt>Schedule</dt><dd><code>{item.cron}</code> · {item.timezone}</dd></div><div><dt>Next Fire</dt><dd>{formatTime(item.nextFireAt)}</dd></div><div><dt>Last Result</dt><dd>{latest ? `${titleCaseLabel(latest.status)} · ${formatTime(latest.completedAt ?? latest.startedAt ?? latest.createdAt)}` : "Never"}</dd></div><div><dt>Policies</dt><dd>{titleCaseLabel(item.misfirePolicy.kind)} · {titleCaseLabel(item.runnerPolicy.kind)} · {titleCaseLabel(item.concurrencyPolicy)}</dd></div><div><dt>Ceilings</dt><dd>${item.limits.maxCostUsd} · {item.limits.maxToolCalls} Tools</dd></div></dl>
            {latest?.error && <p className="automation-execution-error">{latest.error}</p>}
            <div className="automation-card-actions automation-trigger-create"><button className="btn ghost sm" disabled={busy} onClick={() => void createTrigger(item, "webhook")}>Add Webhook</button><button className="btn ghost sm" disabled={busy} onClick={() => void createTrigger(item, "chatops")}>Add Chat-Ops</button><small>Pausing blocks cron and signed triggers, but credentials can be configured while paused.</small></div>
            {triggerItems.length > 0 && <div className="automation-triggers" aria-label="Signed Out-of-Band Triggers"><h4>Signed Triggers</h4>{triggerItems.map((trigger) => {
              const endpoint = publicOrigin
                ? `${publicOrigin}/hooks/v1/automation-triggers/${trigger.triggerId}`
                : "Unavailable until This Machine has a reachable dashboard address";
              const revealed = credential?.trigger.triggerId === trigger.triggerId ? credential : null;
              return <div className="automation-trigger" key={trigger.triggerId}><div><strong>{trigger.name}</strong><span>{titleCaseLabel(trigger.kind)} · Key Generation {trigger.generation} · {trigger.invocationCount === 1 ? "1 Delivery" : `${trigger.invocationCount} Deliveries`}</span>{trigger.lastInvokedAt && <small>Last Signed Delivery {formatTime(trigger.lastInvokedAt)}</small>}</div><code>{endpoint}</code>{revealed && <div className="automation-trigger-secret" role="status"><strong>Copy this signing secret now. It will not be shown again.</strong><code>{revealed.secret}</code><button className="btn ghost sm" type="button" onClick={() => void navigator.clipboard.writeText(revealed.secret)}>Copy Secret</button><button className="btn ghost sm" type="button" onClick={() => setCredential(null)}>Hide</button></div>}<p>{trigger.kind === "chatops" ? 'Signed body: {"eventId":"...","command":"run","sender":"opaque actor"}' : 'Signed body: {"eventId":"..."}'}</p><div className="automation-trigger-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Rotate signing secret?", message: "The previous secret stops working immediately.", confirmLabel: "Rotate Secret", tone: "danger" })) await rotateTrigger(item.automationId, trigger.triggerId); })()}>Rotate Secret</button><button className="btn danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Revoke signed trigger?", message: "Pending unclaimed deliveries will be rejected.", confirmLabel: "Revoke Trigger", tone: "danger" })) await revokeTrigger(item.automationId, trigger.triggerId); })()}>Revoke</button></div></div>;
            })}<p className="automation-hint">Send <code>application/vnd.wollipog.automation-trigger+json</code> with X-Wollipog-Timestamp, X-Wollipog-Nonce, and X-Wollipog-Signature. Signed deliveries only select this fixed automation; they cannot override prompts, runners, paths, or ceilings.</p></div>}
            <div className="automation-card-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void mutate(() => api.updateAutomation(item.automationId, { ...specOf(item), enabled: !item.enabled }))}>{item.enabled ? "Pause" : "Enable"}</button><button className="btn ghost sm" onClick={() => { setEditingId(item.automationId); setEditingSpec(specOf(item)); setForm(formFrom(specOf(item))); setShowForm(true); }}>Edit</button><button className="btn danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: `Delete “${item.name}”?`, message: "The automation is removed permanently. Execution history remains in the audit database.", confirmLabel: "Delete Automation", tone: "danger" })) { if (editingId === item.automationId) closeEditor(); await mutate(() => api.deleteAutomation(item.automationId)); } })()}>Delete</button></div>
            {executions.length > 0 && <details className="automation-history"><summary>Execution History ({executions.length})</summary><div className="automation-history-list">{executions.map((execution) => <div className="automation-execution" key={execution.executionId}><div><strong>{titleCaseLabel(execution.status)}</strong><span>{formatTime(execution.scheduledFor)}</span></div><code>{execution.idempotencyKey}</code>{execution.commands?.length ? <ul className="automation-command-list" aria-label="Durable Runner Command Receipts">{execution.commands.map((command) => <li key={command.commandId}><span>{titleCaseLabel(command.kind.replace("_", " "))} · {titleCaseLabel(command.state)}</span><small>{command.attemptCount} delivery attempt{command.attemptCount === 1 ? "" : "s"}</small>{command.lastError && <em>{command.lastError}</em>}</li>)}</ul> : execution.deliveryMode === "legacy_at_most_once" ? <small className="automation-legacy-delivery">Legacy At-Most-Once Delivery</small> : null}{execution.error && <p>{execution.error}</p>}{execution.sessionId && <button className="link-button" type="button" onClick={() => navigate({ name: "session", id: execution.sessionId! })}>Open Session</button>}</div>)}</div></details>}
          </article>;
        })}
      </div>
    </section>
  );
}
