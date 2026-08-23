import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationAction,
  AutomationExecution,
  AutomationNotificationEvent,
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
import {
  automationProjectPlacement,
  validateAutomationAlternatePlacement,
} from "../automation-project-placement.js";

type ActionKind = AutomationAction["kind"];

interface FormState {
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  actionKind: ActionKind;
  runnerId: string;
  workspaceId: string;
  agentId: string;
  prompt: string;
  sessionId: string;
  workflowId: string;
  misfire: "skip" | "fire_once" | "catch_up";
  catchUpRuns: string;
  runnerPolicy: "wait" | "expire" | "alternate";
  expiryMinutes: string;
  fallbackRunnerId: string;
  fallbackWorkspaceId: string;
  fallbackAgentId: string;
  concurrency: AutomationSpec["concurrencyPolicy"];
  maxCostUsd: string;
  maxToolCalls: string;
  pushEvents: AutomationNotificationEvent[];
}

function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function defaults(): FormState {
  return {
    name: "", cron: "0 9 * * 1-5", timezone: localTimezone(), enabled: true,
    actionKind: "create_session", runnerId: "", workspaceId: "", agentId: "", prompt: "",
    sessionId: "", workflowId: "build-review", misfire: "skip", catchUpRuns: "2",
    runnerPolicy: "wait", expiryMinutes: "60", fallbackRunnerId: "", fallbackWorkspaceId: "",
    fallbackAgentId: "", concurrency: "wait", maxCostUsd: "5", maxToolCalls: "50",
    pushEvents: ["failed", "expired"],
  };
}

function specOf(schedule: AutomationSchedule): AutomationSpec {
  return {
    name: schedule.name, cron: schedule.cron, timezone: schedule.timezone, enabled: schedule.enabled,
    misfirePolicy: schedule.misfirePolicy, runnerPolicy: schedule.runnerPolicy,
    concurrencyPolicy: schedule.concurrencyPolicy, limits: schedule.limits,
    notifications: schedule.notifications, action: schedule.action,
  };
}

function formatTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function actionSummary(action: AutomationAction): string {
  if (action.kind === "prompt_session") return `Prompt session ${action.sessionId}`;
  if (action.kind === "workflow_run") return `Workflow ${action.request.workflowId} on ${action.request.runnerId}`;
  return `Create ${action.request.agentId} session on ${action.request.runnerId}`;
}

function formFrom(schedule: AutomationSchedule): FormState {
  const form = defaults();
  form.name = schedule.name;
  form.cron = schedule.cron;
  form.timezone = schedule.timezone;
  form.enabled = schedule.enabled;
  form.actionKind = schedule.action.kind;
  form.misfire = schedule.misfirePolicy.kind;
  form.catchUpRuns = schedule.misfirePolicy.kind === "catch_up" ? String(schedule.misfirePolicy.maxRuns) : "2";
  form.runnerPolicy = schedule.runnerPolicy.kind;
  form.expiryMinutes = schedule.runnerPolicy.kind === "expire"
    ? String(schedule.runnerPolicy.afterMinutes)
    : schedule.runnerPolicy.kind === "alternate" ? String(schedule.runnerPolicy.expireAfterMinutes ?? 60) : "60";
  form.concurrency = schedule.concurrencyPolicy;
  form.maxCostUsd = String(schedule.limits.maxCostUsd);
  form.maxToolCalls = String(schedule.limits.maxToolCalls);
  form.pushEvents = schedule.notifications.pushEvents;
  if (schedule.action.kind === "prompt_session") {
    form.sessionId = schedule.action.sessionId;
    form.prompt = schedule.action.request.text;
  } else {
    form.runnerId = schedule.action.request.runnerId;
    form.workspaceId = schedule.action.request.workspaceId;
    form.prompt = schedule.action.kind === "workflow_run" ? schedule.action.request.task : (schedule.action.request.prompt ?? "");
    if (schedule.action.kind === "create_session") form.agentId = schedule.action.request.agentId;
    else form.workflowId = schedule.action.request.workflowId;
    if (schedule.runnerPolicy.kind === "alternate") {
      const target = schedule.runnerPolicy.targets[0];
      if (target) {
        form.fallbackRunnerId = target.runnerId;
        form.fallbackWorkspaceId = target.workspaceId;
        form.fallbackAgentId = target.agentId ?? "";
      }
    }
  }
  return form;
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
        agentId: runner.agents[0]?.id ?? "",
      }));
    }
  }, [form.runnerId, runners]);

  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const buildSpec = (): AutomationSpec => {
    const projectList = [...projects.values()];
    const primaryPlacement = form.actionKind === "prompt_session"
      ? {}
      : automationProjectPlacement(projectsSupported, projectList, {
          runnerId: form.runnerId,
          workspaceId: form.workspaceId,
        });
    let action: AutomationAction;
    if (form.actionKind === "prompt_session") {
      action = { kind: "prompt_session", sessionId: form.sessionId, request: { text: form.prompt } };
    } else if (form.actionKind === "workflow_run") {
      action = { kind: "workflow_run", request: {
        runnerId: form.runnerId, workspaceId: form.workspaceId, workflowId: form.workflowId, task: form.prompt,
        ...primaryPlacement,
      } };
    } else {
      action = { kind: "create_session", request: {
        runnerId: form.runnerId, workspaceId: form.workspaceId, agentId: form.agentId,
        prompt: form.prompt, useWorktree: true, ...primaryPlacement,
      } };
    }
    const alternatePlacement = form.runnerPolicy === "alternate"
      ? automationProjectPlacement(projectsSupported, projectList, {
          runnerId: form.fallbackRunnerId,
          workspaceId: form.fallbackWorkspaceId,
        })
      : {};
    if (form.runnerPolicy === "alternate") {
      validateAutomationAlternatePlacement(projectsSupported, primaryPlacement, alternatePlacement);
    }
    const runnerPolicy: AutomationSpec["runnerPolicy"] = form.runnerPolicy === "wait"
      ? { kind: "wait" }
      : form.runnerPolicy === "expire"
        ? { kind: "expire", afterMinutes: Number(form.expiryMinutes) }
        : {
            kind: "alternate",
            targets: [{
              runnerId: form.fallbackRunnerId, workspaceId: form.fallbackWorkspaceId,
              ...alternatePlacement,
              ...(form.actionKind === "create_session" ? { agentId: form.fallbackAgentId } : {}),
            }],
            expireAfterMinutes: Number(form.expiryMinutes),
          };
    return {
      name: form.name, cron: form.cron, timezone: form.timezone, enabled: form.enabled,
      action,
      misfirePolicy: form.misfire === "catch_up"
        ? { kind: "catch_up", maxRuns: Number(form.catchUpRuns) }
        : { kind: form.misfire },
      runnerPolicy,
      concurrencyPolicy: form.actionKind === "prompt_session" && form.concurrency === "parallel" ? "wait" : form.concurrency,
      limits: { maxCostUsd: Number(form.maxCostUsd), maxToolCalls: Number(form.maxToolCalls) },
      notifications: { pushEvents: form.pushEvents },
    };
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const spec = buildSpec();
      if (editingId) await api.updateAutomation(editingId, spec);
      else await api.createAutomation(spec);
      setEditingId(null);
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
    setForm(defaults());
  };

  const openNewAutomation = () => {
    setEditingId(null);
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
                  setForm((current) => ({ ...current, runnerId: event.target.value,
                    workspaceId: runner?.workspaces[0]?.id ?? "", agentId: runner?.agents[0]?.id ?? "" }));
                }}>{[...runners.values()].map((runner) => <option key={runner.runnerId} value={runner.runnerId}>{machineLabels.get(runner.runnerId)}</option>)}</select></label>
                <label>Workspace<select value={form.workspaceId} onChange={(event) => patch("workspaceId", event.target.value)}>
                  {(selectedRunner?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select></label>
                {form.actionKind === "create_session" ? <label>Agent<select value={form.agentId} onChange={(event) => patch("agentId", event.target.value)}>
                  {(selectedRunner?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}
                </select></label> : <label>Workflow<select value={form.workflowId} onChange={(event) => patch("workflowId", event.target.value)}>
                  {workflows.map((workflow) => <option key={`${workflow.workflowId}:${workflow.version}`} value={workflow.workflowId}>{workflow.name} · v{workflow.version}</option>)}
                </select></label>}
              </>
            )}
            <label className="automation-span">{form.actionKind === "workflow_run" ? "Task" : "Prompt"}<textarea value={form.prompt} maxLength={65_536} rows={4} onChange={(event) => patch("prompt", event.target.value)} /></label>
            <label>Misfire<select value={form.misfire} onChange={(event) => patch("misfire", event.target.value as FormState["misfire"])}><option value="skip">Skip Missed Fires</option><option value="fire_once">Run Once</option><option value="catch_up">Bounded Catch-Up</option></select></label>
            {form.misfire === "catch_up" && <label>Catch-Up Cap<input type="number" min="1" max="10" value={form.catchUpRuns} onChange={(event) => patch("catchUpRuns", event.target.value)} /></label>}
            <label>Runner Availability<select value={form.runnerPolicy} onChange={(event) => patch("runnerPolicy", event.target.value as FormState["runnerPolicy"])}><option value="wait">Wait</option><option value="expire">Expire</option>{form.actionKind !== "prompt_session" && <option value="alternate">Use Explicit Alternate</option>}</select></label>
            {form.runnerPolicy !== "wait" && <label>Expiry (Minutes)<input type="number" min="1" max="43200" value={form.expiryMinutes} onChange={(event) => patch("expiryMinutes", event.target.value)} /></label>}
            {form.runnerPolicy === "alternate" && <>
              <label>Alternate Machine<select value={form.fallbackRunnerId} onChange={(event) => {
                const runner = runners.get(event.target.value);
                setForm((current) => ({ ...current, fallbackRunnerId: event.target.value,
                  fallbackWorkspaceId: runner?.workspaces[0]?.id ?? "", fallbackAgentId: runner?.agents[0]?.id ?? "" }));
              }}><option value="">Select…</option>{[...runners.values()].filter((runner) => runner.runnerId !== form.runnerId).map((runner) => <option key={runner.runnerId} value={runner.runnerId}>{machineLabels.get(runner.runnerId)}</option>)}</select></label>
              <label>Alternate Workspace<select value={form.fallbackWorkspaceId} onChange={(event) => patch("fallbackWorkspaceId", event.target.value)}>{(selectedFallback?.workspaces ?? []).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
              {form.actionKind === "create_session" && <label>Alternate Agent<select value={form.fallbackAgentId} onChange={(event) => patch("fallbackAgentId", event.target.value)}>{(selectedFallback?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}</select></label>}
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
            <div className="automation-card-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void mutate(() => api.updateAutomation(item.automationId, { ...specOf(item), enabled: !item.enabled }))}>{item.enabled ? "Pause" : "Enable"}</button><button className="btn ghost sm" onClick={() => { setEditingId(item.automationId); setForm(formFrom(item)); setShowForm(true); }}>Edit</button><button className="btn danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: `Delete “${item.name}”?`, message: "The automation is removed permanently. Execution history remains in the audit database.", confirmLabel: "Delete Automation", tone: "danger" })) { if (editingId === item.automationId) closeEditor(); await mutate(() => api.deleteAutomation(item.automationId)); } })()}>Delete</button></div>
            {executions.length > 0 && <details className="automation-history"><summary>Execution History ({executions.length})</summary><div className="automation-history-list">{executions.map((execution) => <div className="automation-execution" key={execution.executionId}><div><strong>{titleCaseLabel(execution.status)}</strong><span>{formatTime(execution.scheduledFor)}</span></div><code>{execution.idempotencyKey}</code>{execution.commands?.length ? <ul className="automation-command-list" aria-label="Durable Runner Command Receipts">{execution.commands.map((command) => <li key={command.commandId}><span>{titleCaseLabel(command.kind.replace("_", " "))} · {titleCaseLabel(command.state)}</span><small>{command.attemptCount} delivery attempt{command.attemptCount === 1 ? "" : "s"}</small>{command.lastError && <em>{command.lastError}</em>}</li>)}</ul> : execution.deliveryMode === "legacy_at_most_once" ? <small className="automation-legacy-delivery">Legacy At-Most-Once Delivery</small> : null}{execution.error && <p>{execution.error}</p>}{execution.sessionId && <button className="link-button" type="button" onClick={() => navigate({ name: "session", id: execution.sessionId! })}>Open Session</button>}</div>)}</div></details>}
          </article>;
        })}
      </div>
    </section>
  );
}
