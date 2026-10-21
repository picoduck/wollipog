import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AutomationAction,
  AutomationSchedule,
  AutomationSpec,
  RunnerView,
  WorkflowDefinition,
} from "@wollipog/protocol";
import {
  AUTOMATION_CHOOSE_ALTERNATE_INSTALLATION, AUTOMATION_CHOOSE_INSTALLATION,
  AUTOMATION_SAVED_ALTERNATE_INSTALLATION_UNAVAILABLE, AUTOMATION_SAVED_ALTERNATE_ORCHESTRATOR_INSTALLATION_UNAVAILABLE,
  AUTOMATION_SAVED_ALTERNATE_ROLE_INSTALLATION_UNAVAILABLE, AUTOMATION_SAVED_INSTALLATION_UNAVAILABLE,
  AUTOMATION_SAVED_ORCHESTRATOR_INSTALLATION_UNAVAILABLE, AUTOMATION_SAVED_ROLE_INSTALLATION_UNAVAILABLE,
  automationChooseWorkflowInstallation,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import {
  bindableAgents, bindingAvailable, defaultAgentId, installationFor, offeredAgents,
  resolvedInstallationAgentId, unboundInstallationUnavailable,
} from "../automation-installations.js";
import {
  buildSpec, defaults, formFrom, scheduleError, specOf, validTimeZone, withAgent, withModel, type FormState,
} from "../automation-form.js";
import { agentDisplayName } from "../agent-presentation.js";
import { titleCaseLabel } from "../format.js";
import { useLeaveGuard } from "../leave-guard.js";
import { useReportEntityTitle } from "../entity-title.js";
import { backLabel, ENTITY_FALLBACK_TITLES, type AutomationEditorRoute } from "../navigation.js";
import { machineOptionLabels } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useExperiments } from "../use-experiments.js";
import { agentOptions } from "./agent-options.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { AutomationScheduleFields } from "./AutomationScheduleFields.js";
import { AutomationsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { DetailBar } from "./PageHeader.js";
import { SaveBar } from "./SaveBar.js";
import { State } from "./State.js";
import { Checkbox, ChoiceRows, Select, type ChoiceRowOption, type SelectOption } from "./ui/ChoiceControls.js";

type ActionKind = AutomationAction["kind"];
type Runner = RunnerView | undefined;

/** Item 8 of #2967: why Run a Workflow is still offered while its experiment is off. */
export const MULTI_AGENT_OFF_HELPER =
  "The Multi-Agent Runs experiment is turned off in Settings › Experimental, but you can still edit and save this action.";

const ACTIONS: Record<ActionKind, { title: string; description: string }> = {
  create_session: { title: "Start a Session", description: "Start a new session on a machine with the prompt." },
  prompt_session: { title: "Prompt a Session", description: "Send the prompt to a session that's already open." },
  workflow_run: { title: "Run a Workflow", description: "Start a multi-agent workflow run with the task." },
};

/**
 * A save refused because of one field (§8.5): its message goes under that field, which is marked
 * invalid, rather than into the notice above the save bar. `field` is a key of `FieldKey`.
 */
export class AutomationFieldError extends Error {
  constructor(readonly field: FieldKey, message: string) {
    super(message);
  }
}

/**
 * The fields a save error can belong to. Roles are keyed as the request binds them: `role:<agent
 * id>` and `orchestrator`, with `alternate:` in front for the other machine's.
 */
type FieldKey = "cron" | "timezone" | "agent" | "fallbackRunner" | "fallbackAgent" | `role:${string}`
  | "orchestrator" | `alternate:role:${string}` | "alternate:orchestrator";

/** Time Zone's error (§8.5), for a stored zone the scheduler does not know. */
const TIMEZONE_ERROR = "Choose a time zone from the list.";

/**
 * Whether a save error is about the other machine. The client's own checks (the alternate's
 * Project Location, the alternate agent's config) name "alternate", as do the control plane's
 * runner-policy refusals; its per-target capability refusal names the target as
 * `"<runner>/<folder>…"`, which is the alternate when it is the other machine's.
 */
function isAlternateTargetError(message: string, form: FormState): boolean {
  if (form.runnerPolicy !== "alternate") return false;
  return /\balternate\b/i.test(message) ||
    Boolean(form.fallbackRunnerId && message.includes(`"${form.fallbackRunnerId}/`));
}

/** Everything the editor holds that a save reads: the form, and the installation choices beside it. */
interface Draft {
  form: FormState;
  /** Pin the primary agent to its current installation on save. */
  rebindPrimary: boolean;
  rebindAlternate: boolean;
  primaryAgentTouched: boolean;
  alternateAgentTouched: boolean;
  workflowBindingEdits: Record<string, string>;
  alternateWorkflowBindingEdits: Record<string, string>;
}

function draftOf(form: FormState, rebind: { primary?: boolean; alternate?: boolean } = {}): Draft {
  return {
    form,
    rebindPrimary: rebind.primary ?? false,
    rebindAlternate: rebind.alternate ?? false,
    primaryAgentTouched: false,
    alternateAgentTouched: false,
    workflowBindingEdits: {},
    alternateWorkflowBindingEdits: {},
  };
}

/** Compared by value, key by key, so the order fields were written in can never read as an edit. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * An edited automation's draft. A saved installation that the Machine now advertises under another
 * agent id loads as that agent, and is marked for re-pinning, so the field shows what will run.
 */
function editDraft(spec: AutomationSpec, runners: ReadonlyMap<string, RunnerView>): Draft {
  const loaded = formFrom(spec);
  let refreshedPrimary = false;
  let refreshedAlternate = false;
  if (spec.action.kind === "create_session") {
    const current = spec.action.installationBindings?.agent;
    if (current) loaded.agentId = resolvedInstallationAgentId(
      runners.get(spec.action.request.runnerId), current) ?? loaded.agentId;
    refreshedPrimary = loaded.agentId !== spec.action.request.agentId;
    if (spec.runnerPolicy.kind === "alternate") {
      const alternate = spec.runnerPolicy.targets[0];
      const saved = alternate?.installationBindings?.agent;
      if (saved) loaded.fallbackAgentId = resolvedInstallationAgentId(
        runners.get(alternate.runnerId), saved) ?? loaded.fallbackAgentId;
      refreshedAlternate = Boolean(alternate && loaded.fallbackAgentId !== alternate.agentId);
    }
  }
  return draftOf(loaded, { primary: refreshedPrimary, alternate: refreshedAlternate });
}

/** A Machine's first Folder and first runnable Agent, as switching to it starts with. */
function withMachine(form: FormState, runner: Runner): FormState {
  return {
    ...withAgent(form, defaultAgentId(runner?.agents)),
    runnerId: runner?.runnerId ?? "",
    workspaceId: runner?.workspaces[0]?.id ?? "",
  };
}

/** The machine a new automation starts on: the first one online, else the first one. */
function firstMachine(runners: ReadonlyMap<string, RunnerView>): Runner {
  const list = [...runners.values()];
  return list.find((runner) => runner.status === "online") ?? list[0];
}

/**
 * The Automation editor (#2967): `/automations/new` and `/automations/~<id>/edit`, laid out by the
 * Editor save model (docs/design-system.md §8.6) in four sections. It loads what it edits, then
 * hands it to the form, which is keyed by it, so another automation always starts a fresh draft.
 */
export function AutomationEditor({ route }: { route: AutomationEditorRoute }) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const automationId = route.kind === "edit" ? route.automationId : null;
  const [stored, setStored] = useState<
    | { state: "loading" }
    | { state: "loaded"; automation: AutomationSchedule }
    | { state: "missing" }
    | { state: "failed"; message: string }
  >({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [workflowsAttempt, setWorkflowsAttempt] = useState(0);

  useEffect(() => {
    if (automationId === null) return;
    let active = true;
    setStored({ state: "loading" });
    api.automation(automationId).then(
      (result) => { if (active) setStored({ state: "loaded", automation: result.automation }); },
      (cause) => {
        if (!active) return;
        setStored(cause instanceof ApiError && cause.status === 404
          ? { state: "missing" }
          : { state: "failed", message: (cause as Error).message });
      },
    );
    return () => { active = false; };
  }, [api, automationId, attempt]);

  useEffect(() => {
    let active = true;
    setWorkflowsError(null);
    api.workflowDefinitions().then(
      (result) => { if (active) setWorkflows(result); },
      (cause) => { if (active) setWorkflowsError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, workflowsAttempt]);

  // An edit returns to the automation's page (#2968); a new automation, and one that is gone, to
  // the list.
  const toList = () => navigate({ name: "automations" });
  const back = automationId === null ? toList : () => navigate({ name: "automation", id: automationId });
  const fallbackTitle = automationId === null ? "New Automation" : "Edit Automation";
  const fallbackBack = automationId === null ? backLabel("automations") : `Back to ${ENTITY_FALLBACK_TITLES.automation}`;
  const frame = (title: string, body: ReactNode, onBack = back, label = fallbackBack) => (
    <div className="automation-editor">
      <DetailBar title={title} backLabel={label} onBack={onBack} />
      <div className="page form">{body}</div>
    </div>
  );

  if (automationId !== null && stored.state === "missing") {
    return frame(fallbackTitle, (
      <State
        icon={<AutomationsIcon />}
        title="Automation Not Found"
        actions={<button type="button" className="btn primary" onClick={toList}>{backLabel("automations")}</button>}
      >
        It may have been deleted.
      </State>
    ), toList, backLabel("automations"));
  }
  if (automationId !== null && stored.state === "failed") {
    return frame(fallbackTitle, (
      <State
        variant="error"
        title="Couldn't Load This Automation"
        details={stored.message}
        actions={<button type="button" className="btn sm" onClick={() => setAttempt((current) => current + 1)}>Try Again</button>}
      >
        Check the connection to the control plane, then try again.
      </State>
    ));
  }
  const automation = stored.state === "loaded" ? stored.automation : null;
  if (!snapshotLoaded || (automationId !== null && !automation)) {
    return frame(fallbackTitle, <State variant="loading">Loading the automation…</State>);
  }
  return (
    <AutomationEditorForm
      key={automation ? `${automation.automationId}:${automation.revision}` : "new"}
      automation={automation}
      workflows={workflows}
      workflowsError={workflowsError}
      onRetryWorkflows={() => setWorkflowsAttempt((current) => current + 1)}
      onBack={back}
    />
  );
}

function AutomationEditorForm({
  automation,
  workflows,
  workflowsError,
  onRetryWorkflows,
  onBack,
}: {
  /** The stored automation being edited, or null for a new one. */
  automation: AutomationSchedule | null;
  workflows: readonly WorkflowDefinition[];
  workflowsError: string | null;
  onRetryWorkflows: () => void;
  onBack: () => void;
}) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const { confirm, showToast } = useFeedback();
  // Workflow runs belong to the Multi-Agent experiment: with it off, the editor must not offer
  // creating one. An automation that ALREADY uses the action keeps its choice so editing it renders
  // truthfully — the flag hides surfaces, it does not orphan stored data — and says why (#236).
  const multiAgentEnabled = useExperiments().flags.multiAgent;
  const runners = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const sessions = useStoreSelector((state) => state.sessions);
  const projects = useStoreSelector((state) => state.projects);
  const projectsSupported = useStoreSelector((state) => state.projectsSupported);
  // Passing the correlated Box matters for an SSH Machine left unnamed: runnerDisplay falls back
  // to the ssh target, so it reads as "build-linux" rather than an opaque runner id.
  const machineLabels = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return machineOptionLabels([...runners.values()], (id) => boxByRunner.get(id));
  }, [boxes, runners]);

  const isNew = automation === null;
  // The exact stored spec being edited, updated by each save. Saving replaces the whole spec, so the
  // builder needs it to carry across every field this form does not render.
  const [editingSpec, setEditingSpec] = useState<AutomationSpec | null>(() => automation ? specOf(automation) : null);
  const [savedName, setSavedName] = useState(automation?.name ?? "");
  // The window title reads "Edit <Name>" as the bar does (#2968).
  useReportEntityTitle(
    automation ? { name: "automations", editor: { kind: "edit", automationId: automation.automationId } } : { name: "automations", editor: { kind: "new" } },
    automation ? savedName : null,
  );
  const [baseline, setBaseline] = useState<Draft>(() => automation
    ? editDraft(specOf(automation), runners)
    : draftOf(withMachine(defaults(), firstMachine(runners))));
  const [draft, setDraft] = useState<Draft>(baseline);
  const { form } = draft;
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ field: FieldKey | null; message: string } | null>(null);
  // Whether Schedule's error shows (§8.5): after a blur that followed an edit, and after a submit,
  // until the expression is valid again.
  const [cronChecked, setCronChecked] = useState(false);
  const dirty = !sameValue(draft, baseline);

  // A new automation opened before any machine reported starts on the first one that does.
  useEffect(() => {
    if (!isNew || form.runnerId || runners.size === 0) return;
    const runner = firstMachine(runners);
    const apply = (current: Draft): Draft => current.form.runnerId
      ? current : { ...current, form: withMachine(current.form, runner) };
    setBaseline(apply);
    setDraft(apply);
  }, [isNew, form.runnerId, runners]);

  const update = (change: (current: Draft) => Draft) => {
    setDraft(change);
    // A field error is about the value that was refused; any edit may be the fix (§8.5).
    setFailure((current) => current?.field ? null : current);
  };
  const setForm = (change: (current: FormState) => FormState) =>
    update((current) => ({ ...current, form: change(current.form) }));
  const patch = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const selectedRunner = runners.get(form.runnerId);
  const selectedFallback = runners.get(form.fallbackRunnerId);
  const selectedWorkflow = workflows.find((workflow) => workflow.workflowId === form.workflowId &&
    workflow.version === (editingSpec?.action.kind === "workflow_run" &&
      editingSpec.action.request.workflowId === form.workflowId
      ? editingSpec.action.request.workflowVersion ?? workflow.version : workflow.version));
  // One field per agent the workflow binds, labelled by the roles that agent plays ("Builder
  // Agent"); human steps are the person, in the run.
  const workflowRoles = useMemo(() => {
    const roles = new Map<string, string[]>();
    for (const node of selectedWorkflow?.nodes ?? []) {
      if (node.kind !== "agent" || !node.agentId) continue;
      const names = roles.get(node.agentId) ?? [];
      const name = titleCaseLabel(node.role);
      if (!names.includes(name)) names.push(name);
      roles.set(node.agentId, names);
    }
    return [...roles].map(([key, names]) => ({ key, label: names.join(" and ") }));
  }, [selectedWorkflow]);
  const humanSteps = selectedWorkflow?.nodes.filter((node) => node.kind === "human_gate") ?? [];
  const roleLabel = (key: string) => workflowRoles.find((role) => role.key === key)?.label ?? titleCaseLabel(key);

  const primaryInstallationIssue = editingSpec?.action.kind === "create_session" &&
    editingSpec.action.request.runnerId === form.runnerId && !draft.rebindPrimary
    ? editingSpec.action.installationBindings?.agent
      ? !bindingAvailable(selectedRunner, editingSpec.action.installationBindings.agent)
      : unboundInstallationUnavailable(selectedRunner, form.agentId,
        editingSpec.action.installationBindings === undefined)
    : false;
  const carriedAlternateRunnerIds = new Set(editingSpec?.runnerPolicy.kind === "alternate" &&
      editingSpec.action.kind === form.actionKind &&
      form.runnerPolicy === "alternate"
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
    .filter((runner): runner is RunnerView => Boolean(runner) && (runner!.protocolVersion ?? 0) < 53);

  const storedWorkflowAction = editingSpec?.action.kind === "workflow_run";
  const offersWorkflow = multiAgentEnabled || storedWorkflowAction;
  const workflowKeptWhileOff = !multiAgentEnabled && storedWorkflowAction;

  const currentSpec = (): AutomationSpec => {
    const spec = buildSpec(form, {
      projectsSupported,
      projects: projects.values(),
      ...(editingSpec ? { base: editingSpec } : {}),
      ...(alternateCapabilities ? { alternateCapabilities } : {}),
    });
    if (spec.action.kind === "create_session") {
      const previous = editingSpec?.action.kind === "create_session" ? editingSpec.action : undefined;
      if (draft.primaryAgentTouched && previous?.installationBindings?.agent &&
          form.runnerId === previous.request.runnerId && form.agentId === previous.request.agentId &&
          resolvedInstallationAgentId(selectedRunner, previous.installationBindings.agent) !== form.agentId) {
        spec.action.installationBindings = {};
      }
      if (draft.rebindPrimary) {
        const installation = installationFor(selectedRunner, form.agentId);
        if (!installation) throw new AutomationFieldError("agent", AUTOMATION_CHOOSE_INSTALLATION);
        spec.action.installationBindings = { ...spec.action.installationBindings, agent: installation };
      }
      if (draft.rebindAlternate && spec.runnerPolicy.kind === "alternate") {
        const installation = installationFor(selectedFallback, form.fallbackAgentId);
        if (!installation) throw new AutomationFieldError("fallbackAgent", AUTOMATION_CHOOSE_ALTERNATE_INSTALLATION);
        spec.runnerPolicy.targets[0]!.installationBindings = {
          ...spec.runnerPolicy.targets[0]!.installationBindings, agent: installation,
        };
      }
      if (draft.alternateAgentTouched && !draft.rebindAlternate && spec.runnerPolicy.kind === "alternate" &&
          editingSpec?.runnerPolicy.kind === "alternate") {
        const previousTarget = editingSpec.runnerPolicy.targets[0];
        const target = spec.runnerPolicy.targets[0];
        if (previousTarget?.installationBindings?.agent && target &&
            target.runnerId === previousTarget.runnerId && target.agentId === previousTarget.agentId &&
            resolvedInstallationAgentId(selectedFallback, previousTarget.installationBindings.agent) !== target.agentId) {
          target.installationBindings = {};
        }
      }
    } else if (spec.action.kind === "workflow_run" && Object.keys(draft.workflowBindingEdits).length) {
      const request = spec.action.request;
      const bindings = { ...request.agentBindings };
      const installations = { ...spec.action.installationBindings };
      for (const [key, agentId] of Object.entries(draft.workflowBindingEdits)) {
        const installation = installationFor(selectedRunner, agentId);
        const configAgent = bindableAgents(selectedRunner).some((option) =>
          option.agent.id === agentId && !option.agent.installation);
        if (!installation && !configAgent) throw new AutomationFieldError(key as FieldKey, automationChooseWorkflowInstallation(
          key === "orchestrator" ? "the Orchestrator" : roleLabel(key.slice("role:".length)), false));
        if (key === "orchestrator") {
          request.orchestratorAgentId = agentId;
          if (installation) installations.orchestrator = installation;
          else delete installations.orchestrator;
          continue;
        }
        const role = key.slice("role:".length);
        bindings[role] = agentId;
        if (installation) installations[key] = installation;
        else delete installations[key];
      }
      request.agentBindings = bindings;
      spec.action.installationBindings = installations;
    }
    if (spec.action.kind === "workflow_run" && spec.runnerPolicy.kind === "alternate" &&
        Object.keys(draft.alternateWorkflowBindingEdits).length) {
      const target = spec.runnerPolicy.targets[0]!;
      const bindings = { ...target.agentBindings };
      const installations = { ...target.installationBindings };
      for (const [key, agentId] of Object.entries(draft.alternateWorkflowBindingEdits)) {
        const installation = installationFor(selectedFallback, agentId);
        const configAgent = bindableAgents(selectedFallback).some((option) =>
          option.agent.id === agentId && !option.agent.installation);
        if (!installation && !configAgent) throw new AutomationFieldError(`alternate:${key}` as FieldKey,
          automationChooseWorkflowInstallation(
            key === "orchestrator" ? "the Orchestrator" : roleLabel(key.slice("role:".length)), true));
        if (key === "orchestrator") {
          target.orchestratorAgentId = agentId;
          if (installation) installations.orchestrator = installation;
          else delete installations.orchestrator;
          continue;
        }
        const role = key.slice("role:".length);
        bindings[role] = agentId;
        if (installation) installations[key] = installation;
        else delete installations[key];
      }
      target.agentBindings = bindings;
      target.installationBindings = installations;
    }
    return spec;
  };

  // A field error moves focus to the field it marks (§8.5), which announces it.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!failure?.field) return;
    rootRef.current?.querySelector<HTMLElement>('.automation-editor-form [aria-invalid="true"]')?.focus();
  }, [failure]);

  // Leaving with unsaved changes asks first (§8.6). Cancel and a finished create leave on purpose.
  const leaving = useRef(false);
  useLeaveGuard(dirty, (leave) => {
    if (leaving.current) return leave();
    void confirm({
      title: "Discard Changes",
      message: isNew
        ? "This automation hasn't been created. Discarding it keeps nothing."
        : `“${savedName}” has changes that aren't saved. Discarding them keeps the saved automation.`,
      confirmLabel: "Discard Changes",
      cancelLabel: "Keep Editing",
      tone: "danger",
    }).then((discard) => { if (discard) leave(); });
  });
  const leaveTo = (to: () => void) => {
    leaving.current = true;
    to();
  };

  // Whether this editor is still on screen when a save settles (Strict Mode remounts set it again).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const save = async () => {
    let spec: AutomationSpec;
    setFailure(null);
    // The scheduler's own checks (#2971) run before anything is sent; the field takes focus instead.
    const problem = scheduleError(form.cron, { timezone: form.timezone, enabled: form.enabled, now: Date.now() });
    if (problem) {
      setCronChecked(true);
      setFailure({ field: "cron", message: problem });
      return;
    }
    if (!validTimeZone(form.timezone)) {
      setFailure({ field: "timezone", message: TIMEZONE_ERROR });
      return;
    }
    try {
      spec = currentSpec();
    } catch (cause) {
      const message = (cause as Error).message;
      setFailure({
        field: cause instanceof AutomationFieldError ? cause.field
          : isAlternateTargetError(message, form) ? "fallbackRunner" : null,
        message,
      });
      return;
    }
    setSaving(true);
    try {
      if (automation) {
        const saved = await api.updateAutomation(automation.automationId, spec);
        showToast("Changes saved.", { tone: "success" });
        // Left while the update ran: the toast says it saved, and there is no editor to reload.
        if (!mounted.current) return;
        const next = specOf(saved);
        const reloaded = editDraft(next, runners);
        setEditingSpec(next);
        setSavedName(saved.name);
        setBaseline(reloaded);
        setDraft(reloaded);
      } else {
        await api.createAutomation(spec);
        showToast("Automation created.", { tone: "success" });
        // A create that settles after the person left (Back, then Discard Changes) must not move
        // them: the page they are on now, possibly another editor's draft, is theirs. A replacing
        // navigation is not asked by the leave guard, so this check is the only thing in the way.
        if (mounted.current) leaveTo(() => navigate({ name: "automations" }, { replace: true }));
      }
    } catch (cause) {
      const message = (cause as Error).message;
      if (mounted.current) setFailure({ field: isAlternateTargetError(message, form) ? "fallbackRunner" : null, message });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const discard = () => {
    if (isNew) {
      leaveTo(onBack);
      return;
    }
    setDraft(baseline);
    setFailure(null);
    setCronChecked(false);
  };

  const scheduleCheck = { timezone: form.timezone, enabled: form.enabled, now: Date.now() };
  const cronProblem = scheduleError(form.cron, scheduleCheck);

  const ids = useId();
  const fieldId = (key: string) => `${ids}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const errorFor = (key: FieldKey) => failure?.field === key ? failure.message : null;
  /** A field's error under its control (§8.5), and the props that point the control at it. */
  const fieldError = (key: FieldKey) => {
    const message = errorFor(key);
    const id = `${fieldId(key)}-error`;
    return {
      invalid: Boolean(message),
      describedBy: message ? id : undefined,
      node: message ? <FieldError id={id}>{message}</FieldError> : null,
    };
  };

  const machineOption = (runner: RunnerView, disabledReason?: string): SelectOption<string> => ({
    value: runner.runnerId,
    label: machineLabels.get(runner.runnerId) ?? runner.runnerId,
    ...(runner.status !== "online" ? { status: statusMeta("machine", "offline") } : {}),
    ...(disabledReason ? { disabled: true, disabledReason } : {}),
  });
  const folderOptions = (runner: Runner): SelectOption<string>[] => (runner?.workspaces ?? [])
    .map((workspace) => ({ value: workspace.id, label: workspace.name, description: workspace.path }));
  const agentSelectOptions = (runner: Runner, current: string): SelectOption<string>[] => {
    const disabled = new Set(agentOptions(runner?.agents ?? []).filter((option) => option.disabled)
      .map((option) => option.agent.id));
    return offeredAgents(runner?.agents, current).map((agent) => ({
      value: agent.id,
      label: agentDisplayName(agent, runner?.agents),
      ...(disabled.has(agent.id) ? { disabled: true, disabledReason: "Unavailable on this machine." } : {}),
    }));
  };
  const roleOptions = (runner: Runner, boundId: string): SelectOption<string>[] => [
    ...(!bindableAgents(runner).some((option) => option.agent.id === boundId)
      ? [{ value: boundId, label: `${boundId} (Unavailable)` }] : []),
    ...bindableAgents(runner).map((option) => ({ value: option.agent.id, label: option.label })),
  ];
  /** The warning beside an agent field whose saved installation is gone, with its Rebind action. */
  const installationWarning = (message: string, canRebind: boolean, rebind: () => void) => (
    <Notice
      tone="warning"
      compact
     
      actions={<button type="button" className="btn sm" disabled={!canRebind} onClick={rebind}>Use Current Installation</button>}
    >
      {message}
    </Notice>
  );

  // Switching the action fills Machine, Folder and Agent only where they are EMPTY. A stored value
  // the current discovery cannot find (a machine that has not reported, a folder or agent it no
  // longer lists) is the automation's, and saving must carry it, so it is never replaced here.
  // Reselecting the checked action (ChoiceRow reports it) changes nothing.
  const chooseAction = (kind: ActionKind) => update((current) => {
    const previous = current.form;
    if (previous.actionKind === kind) return current;
    let next: FormState = {
      ...previous,
      actionKind: kind,
      runnerPolicy: kind === "prompt_session" && previous.runnerPolicy === "alternate" ? "wait" : previous.runnerPolicy,
      concurrency: kind === "prompt_session" && previous.concurrency === "parallel" ? "wait" : previous.concurrency,
    };
    let rebound = current;
    if (kind !== "prompt_session") {
      if (!next.runnerId) {
        next = withMachine(next, firstMachine(runners));
        rebound = { ...current, rebindPrimary: false, primaryAgentTouched: true, workflowBindingEdits: {} };
      } else {
        const runner = runners.get(next.runnerId);
        if (!next.workspaceId) next = { ...next, workspaceId: runner?.workspaces[0]?.id ?? "" };
        if (kind === "create_session" && !next.agentId) next = withAgent(next, defaultAgentId(runner?.agents));
      }
    }
    return { ...rebound, form: next };
  });

  const actionChoices: ChoiceRowOption<ActionKind>[] = (["create_session", "prompt_session", "workflow_run"] as const)
    .filter((kind) => kind !== "workflow_run" || offersWorkflow)
    .map((kind) => ({
      value: kind,
      title: ACTIONS[kind].title,
      description: ACTIONS[kind].description,
      ...(kind === "workflow_run" && workflowKeptWhileOff ? { describedBy: fieldId("workflow-off") } : {}),
    }));

  const sessionOptions: SelectOption<string>[] = [
    ...(form.sessionId && !editableSessions.some((session) => session.id === form.sessionId)
      ? [{ value: form.sessionId, label: sessions.get(form.sessionId)?.title ?? form.sessionId, description: "Not open" }] : []),
    ...editableSessions.map((session) => ({ value: session.id, label: session.title, description: titleCaseLabel(session.status) })),
  ];

  const agentError = fieldError("agent");
  const fallbackRunnerError = fieldError("fallbackRunner");
  const fallbackAgentError = fieldError("fallbackAgent");

  const primaryRoleFields = form.actionKind === "workflow_run" && workflowRoles.map(({ key: role, label }) => {
    const stored = editingSpec?.action.kind === "workflow_run" &&
      editingSpec.action.request.workflowId === form.workflowId &&
      editingSpec.action.request.runnerId === form.runnerId ? editingSpec.action : null;
    const reference = stored?.installationBindings?.[`role:${role}`];
    const boundId = draft.workflowBindingEdits[`role:${role}`] ??
      (reference ? resolvedInstallationAgentId(selectedRunner, reference) : undefined) ??
      stored?.request.agentBindings?.[role] ?? role;
    const unavailable = Boolean(stored) && !draft.workflowBindingEdits[`role:${role}`] && (reference
      ? !bindingAvailable(selectedRunner, reference)
      : !selectedRunner?.agents.some((agent) => agent.id === boundId && !agent.installation));
    const error = fieldError(`role:${role}`);
    const bind = (agentId: string) => update((current) => ({
      ...current, workflowBindingEdits: { ...current.workflowBindingEdits, [`role:${role}`]: agentId },
    }));
    return (
      <div className="field" key={role}>
        <span className="field-label">{label} Agent</span>
        <Select label={`${label} Agent`} value={boundId} onChange={bind} options={roleOptions(selectedRunner, boundId)}
          invalid={error.invalid} describedBy={error.describedBy} />
        {error.node}
        {unavailable && installationWarning(AUTOMATION_SAVED_ROLE_INSTALLATION_UNAVAILABLE,
          Boolean(installationFor(selectedRunner, boundId)), () => bind(boundId))}
      </div>
    );
  });

  const primaryOrchestratorField = form.actionKind === "workflow_run" && editingSpec?.action.kind === "workflow_run" &&
    editingSpec.action.request.runnerId === form.runnerId &&
    editingSpec.action.request.workflowId === form.workflowId &&
    editingSpec.action.request.orchestratorAgentId && (() => {
      const stored = editingSpec.action as Extract<AutomationAction, { kind: "workflow_run" }>;
      const reference = stored.installationBindings?.orchestrator;
      const boundId = draft.workflowBindingEdits.orchestrator ??
        (reference ? resolvedInstallationAgentId(selectedRunner, reference) : undefined) ??
        stored.request.orchestratorAgentId!;
      const unavailable = !draft.workflowBindingEdits.orchestrator && (reference
        ? !bindingAvailable(selectedRunner, reference)
        : !selectedRunner?.agents.some((agent) => agent.id === boundId && !agent.installation));
      const error = fieldError("orchestrator");
      const bind = (agentId: string) => update((current) => ({
        ...current, workflowBindingEdits: { ...current.workflowBindingEdits, orchestrator: agentId },
      }));
      return (
        <div className="field">
          <span className="field-label">Orchestrator Agent</span>
          <Select label="Orchestrator Agent" value={boundId} onChange={bind} options={roleOptions(selectedRunner, boundId)}
            invalid={error.invalid} describedBy={error.describedBy} />
          {error.node}
          {unavailable && installationWarning(AUTOMATION_SAVED_ORCHESTRATOR_INSTALLATION_UNAVAILABLE,
            Boolean(installationFor(selectedRunner, boundId)), () => bind(boundId))}
        </div>
      );
    })();

  const alternateRoleFields = form.actionKind === "workflow_run" && form.runnerPolicy === "alternate" &&
    workflowRoles.map(({ key: role, label }) => {
      const oldTarget = editingSpec?.runnerPolicy.kind === "alternate" &&
        editingSpec.action.kind === "workflow_run" &&
        editingSpec.action.request.workflowId === form.workflowId &&
        editingSpec.runnerPolicy.targets[0]?.runnerId === form.fallbackRunnerId
        ? editingSpec.runnerPolicy.targets[0] : undefined;
      const reference = oldTarget?.installationBindings?.[`role:${role}`];
      const primaryChoice = draft.workflowBindingEdits[`role:${role}`] ??
        (editingSpec?.action.kind === "workflow_run" &&
          editingSpec.action.request.workflowId === form.workflowId &&
          editingSpec.action.request.runnerId === form.runnerId
          ? editingSpec.action.request.agentBindings?.[role] : undefined);
      // A pin on an inherited target describes the old primary identity. Save-time pinning will
      // replace it when that identity changes, so display the new choice.
      const inheritedPrimaryChanged = Boolean(oldTarget && oldTarget.agentBindings?.[role] === undefined &&
        (primaryChoice ?? role) !== (editingSpec?.action.kind === "workflow_run"
          ? editingSpec.action.request.agentBindings?.[role] ?? role : role));
      const effectiveReference = inheritedPrimaryChanged ? undefined : reference;
      const boundId = draft.alternateWorkflowBindingEdits[`role:${role}`] ??
        (effectiveReference ? resolvedInstallationAgentId(selectedFallback, effectiveReference) : undefined) ??
        oldTarget?.agentBindings?.[role] ??
        primaryChoice ?? role;
      const unavailable = Boolean(oldTarget) && !draft.alternateWorkflowBindingEdits[`role:${role}`] && (effectiveReference
        ? !bindingAvailable(selectedFallback, effectiveReference)
        : inheritedPrimaryChanged
          ? !bindableAgents(selectedFallback).some((option) => option.agent.id === boundId &&
              (!option.agent.installation || installationFor(selectedFallback, boundId)))
          : !selectedFallback?.agents.some((agent) => agent.id === boundId && !agent.installation));
      const error = fieldError(`alternate:role:${role}`);
      const bind = (agentId: string) => update((current) => ({
        ...current,
        alternateWorkflowBindingEdits: { ...current.alternateWorkflowBindingEdits, [`role:${role}`]: agentId },
      }));
      return (
        <div className="field" key={role}>
          <span className="field-label">Other {label} Agent</span>
          <Select label={`Other ${label} Agent`} value={boundId} onChange={bind} options={roleOptions(selectedFallback, boundId)}
            invalid={error.invalid} describedBy={error.describedBy} />
          {error.node}
          {unavailable && installationWarning(AUTOMATION_SAVED_ALTERNATE_ROLE_INSTALLATION_UNAVAILABLE,
            Boolean(installationFor(selectedFallback, boundId)), () => bind(boundId))}
        </div>
      );
    });

  const alternateOrchestratorField = form.actionKind === "workflow_run" && form.runnerPolicy === "alternate" &&
    editingSpec?.action.kind === "workflow_run" && (() => {
      const storedAction = editingSpec.action as Extract<AutomationAction, { kind: "workflow_run" }>;
      const oldTarget = editingSpec.runnerPolicy.kind === "alternate" &&
        storedAction.request.workflowId === form.workflowId &&
        editingSpec.runnerPolicy.targets[0]?.runnerId === form.fallbackRunnerId
        ? editingSpec.runnerPolicy.targets[0] : undefined;
      const primaryChoice = draft.workflowBindingEdits.orchestrator ??
        (storedAction.request.workflowId === form.workflowId &&
          storedAction.request.runnerId === form.runnerId
          ? storedAction.request.orchestratorAgentId : undefined);
      if (!oldTarget?.orchestratorAgentId && !primaryChoice) return null;
      const reference = oldTarget?.installationBindings?.orchestrator;
      const inheritedPrimaryChanged = Boolean(oldTarget && !oldTarget.orchestratorAgentId &&
        primaryChoice !== storedAction.request.orchestratorAgentId);
      const effectiveReference = inheritedPrimaryChanged ? undefined : reference;
      const boundId = draft.alternateWorkflowBindingEdits.orchestrator ??
        (effectiveReference ? resolvedInstallationAgentId(selectedFallback, effectiveReference) : undefined) ??
        oldTarget?.orchestratorAgentId ?? primaryChoice!;
      const unavailable = Boolean(oldTarget) && !draft.alternateWorkflowBindingEdits.orchestrator && (effectiveReference
        ? !bindingAvailable(selectedFallback, effectiveReference)
        : inheritedPrimaryChanged
          ? !bindableAgents(selectedFallback).some((option) => option.agent.id === boundId &&
              (!option.agent.installation || installationFor(selectedFallback, boundId)))
          : !selectedFallback?.agents.some((agent) => agent.id === boundId && !agent.installation));
      const error = fieldError("alternate:orchestrator");
      const bind = (agentId: string) => update((current) => ({
        ...current, alternateWorkflowBindingEdits: { ...current.alternateWorkflowBindingEdits, orchestrator: agentId },
      }));
      return (
        <div className="field">
          <span className="field-label">Other Orchestrator Agent</span>
          <Select label="Other Orchestrator Agent" value={boundId} onChange={bind} options={roleOptions(selectedFallback, boundId)}
            invalid={error.invalid} describedBy={error.describedBy} />
          {error.node}
          {unavailable && installationWarning(AUTOMATION_SAVED_ALTERNATE_ORCHESTRATOR_INSTALLATION_UNAVAILABLE,
            Boolean(installationFor(selectedFallback, boundId)), () => bind(boundId))}
        </div>
      );
    })();

  const alternateInstallationIssue = form.actionKind === "create_session" &&
    editingSpec?.runnerPolicy.kind === "alternate" && !draft.rebindAlternate && (() => {
      const oldTarget = editingSpec.runnerPolicy.targets[0];
      if (!oldTarget || oldTarget.runnerId !== form.fallbackRunnerId) return false;
      const reference = oldTarget.installationBindings?.agent;
      return reference ? !bindingAvailable(selectedFallback, reference)
        : unboundInstallationUnavailable(selectedFallback, form.fallbackAgentId,
          oldTarget.installationBindings === undefined);
    })();

  // The other machine: never the primary, and never a later stored alternate, which is carried
  // unchanged. The stored first alternate is listed even while offline or gone, so editing shows it.
  const otherMachineOptions: SelectOption<string>[] = [
    ...[...runners.values()]
      .filter((runner) => runner.runnerId !== form.runnerId && !carriedAlternateRunnerIds.has(runner.runnerId))
      .map((runner) => machineOption(runner)),
    ...(form.fallbackRunnerId && !runners.has(form.fallbackRunnerId)
      ? [{ value: form.fallbackRunnerId, label: form.fallbackRunnerId, status: statusMeta("machine", "offline") }] : []),
  ];

  const pushEvents = ["started", "succeeded", "failed", "expired"] as const;
  const editorTitle = isNew ? "New Automation" : `Edit ${savedName}`;
  // An edit's Back returns to the automation's page, by its name (#2968).
  const editorBack = isNew ? backLabel("automations") : `Back to ${savedName}`;
  const workflowHelperId = fieldId("workflow-off");
  const workflowOptions: SelectOption<string>[] = [
    ...(form.workflowId && !workflows.some((workflow) => workflow.workflowId === form.workflowId)
      ? [{ value: form.workflowId, label: form.workflowId, description: workflowsError ? "Workflows couldn't be loaded." : "Not available" }]
      : []),
    ...workflows.map((workflow) => ({
      value: workflow.workflowId, label: workflow.name, description: `Version ${workflow.version}`,
    })),
  ];

  return (
    <div className="automation-editor" ref={rootRef}>
      <DetailBar title={editorTitle} backLabel={editorBack} onBack={onBack} />
      <div className="page form">
        <form className="automation-editor-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <section className="section" aria-labelledby={fieldId("what")}>
            <div className="section-head"><h2 className="section-title" id={fieldId("what")}>What to Run</h2></div>
            <label className="field">
              <span>Name</span>
              <input value={form.name} maxLength={120} onChange={(event) => patch("name", event.target.value)} />
            </label>
            <div className="field">
              <span className="field-label" id={fieldId("action")}>Action</span>
              <ChoiceRows label="Action" labelledBy={fieldId("action")} value={form.actionKind} options={actionChoices}
                onChange={chooseAction} />
              {workflowKeptWhileOff && <p className="field-helper" id={workflowHelperId}>{MULTI_AGENT_OFF_HELPER}</p>}
            </div>
            {form.actionKind === "prompt_session" ? (
              <div className="field">
                <span className="field-label">Session</span>
                <Select label="Session" value={form.sessionId || null} onChange={(value) => patch("sessionId", value)}
                  options={sessionOptions} placeholder="Select a Session…" emptyLabel="No open sessions" />
              </div>
            ) : (
              <>
                <div className="field-row">
                  <div className="field">
                    <span>Machine</span>
                    <Select
                      label="Machine"
                      value={form.runnerId || null}
                      placeholder={runners.size ? "Select a Machine…" : "No Machines Connected"}
                      emptyLabel="No machines are connected"
                      onChange={(runnerId) => update((current) => ({
                        ...current,
                        rebindPrimary: false,
                        primaryAgentTouched: true,
                        workflowBindingEdits: {},
                        form: { ...withMachine(current.form, runners.get(runnerId)), runnerId },
                      }))}
                      options={[...runners.values()].map((runner) => machineOption(runner,
                        runner.runnerId !== form.runnerId && carriedAlternateRunnerIds.has(runner.runnerId)
                          ? "Saved as another machine for this automation." : undefined))}
                    />
                  </div>
                  <div className="field">
                    <span className="field-label">Folder</span>
                    <Select label="Folder" value={form.workspaceId || null} onChange={(value) => patch("workspaceId", value)}
                      options={folderOptions(selectedRunner)}
                      placeholder={selectedRunner?.workspaces.length ? "Select a Folder…" : "No Folders on This Machine"}
                      emptyLabel="This machine has no folders" />
                  </div>
                </div>
                {form.actionKind === "create_session" ? (
                  <div className="field">
                    <span className="field-label">Agent</span>
                    <Select
                      label="Agent"
                      value={form.agentId || null}
                      placeholder={selectedRunner?.agents.length ? "Select an Agent…" : "No Agents on This Machine"}
                      emptyLabel="This machine has no agents"
                      onChange={(agentId) => update((current) => ({
                        ...current, rebindPrimary: false, primaryAgentTouched: true, form: withAgent(current.form, agentId),
                      }))}
                      options={agentSelectOptions(selectedRunner, form.agentId)}
                      invalid={agentError.invalid}
                      describedBy={agentError.describedBy}
                    />
                    {agentError.node}
                    {primaryInstallationIssue && installationWarning(AUTOMATION_SAVED_INSTALLATION_UNAVAILABLE,
                      Boolean(installationFor(selectedRunner, form.agentId)),
                      () => update((current) => ({ ...current, rebindPrimary: true })))}
                  </div>
                ) : (
                  <>
                    <div className="field">
                      <span className="field-label">Workflow</span>
                      <Select label="Workflow" value={form.workflowId || null} onChange={(value) => patch("workflowId", value)}
                        options={workflowOptions} placeholder="Select a Workflow…" emptyLabel="No workflows yet" />
                      {workflowsError && (
                        <Notice tone="warning" compact
                          actions={<button type="button" className="btn sm" onClick={onRetryWorkflows}>Try Again</button>}
                          details={workflowsError}>
                          Workflows couldn't be loaded.
                        </Notice>
                      )}
                    </div>
                    {primaryRoleFields}
                    {primaryOrchestratorField}
                    {humanSteps.map((node) => (
                      <label className="field" key={node.nodeId}>
                        <span>{titleCaseLabel(node.role)}</span>
                        <input className="is-read-only" readOnly value="You, in the run" />
                      </label>
                    ))}
                  </>
                )}
              </>
            )}
            {form.actionKind === "create_session" && (
              <>
                {(modelOptions.length > 0 || effortOptions.length > 0) && (
                  <div className="field-row">
                    {modelOptions.length > 0 && (
                      <div className="field">
                        <span className="field-label">Model</span>
                        <Select label="Model" value={form.model}
                          onChange={(value) => setForm((current) => withModel(current, value, agentCapabilities))}
                          options={[{ value: "", label: "Agent Default" },
                            ...modelOptions.map((model) => ({
                              value: model.id,
                              label: model.displayName ?? model.id,
                              ...(model.description ? { description: model.description } : {}),
                            }))]} />
                      </div>
                    )}
                    {effortOptions.length > 0 && (
                      <div className="field">
                        <span className="field-label">Reasoning Effort</span>
                        <Select label="Reasoning Effort" value={form.effort} onChange={(value) => patch("effort", value)}
                          options={[{ value: "", label: "Agent Default" },
                            ...effortOptions.map((effort) => ({ value: effort, label: titleCaseLabel(effort) }))]} />
                      </div>
                    )}
                  </div>
                )}
                <div className="field-row">
                  {permissionModeOptions.length > 0 && (
                    <div className="field">
                      <span className="field-label">Permission Mode</span>
                      <Select label="Permission Mode" value={form.permissionMode} onChange={(value) => patch("permissionMode", value)}
                        options={[{ value: "", label: "Agent Default" },
                          ...permissionModeOptions.map((mode) => ({ value: mode, label: titleCaseLabel(mode) }))]} />
                    </div>
                  )}
                  <div className="field">
                    <span className="field-label">Workspace Strategy</span>
                    <Select label="Workspace Strategy" value={form.useWorktree ? "worktree" : "in_place"}
                      onChange={(value) => patch("useWorktree", value === "worktree")}
                      options={[
                        { value: "worktree", label: "Worktree", description: "Each run gets an isolated checkout." },
                        { value: "in_place", label: "In Place", description: "Each run works directly in the folder." },
                      ]} />
                  </div>
                </div>
              </>
            )}
            {incompatibleRunners.length > 0 && (
              <Notice tone="warning">
                Update and restart {incompatibleRunners.map((runner) => runner.hostname).join(", ")} to protocol 53
                before this automation can run. Durable delivery never falls back to an older fire-and-forget command.
              </Notice>
            )}
            <label className="field">
              <span>{form.actionKind === "workflow_run" ? "Task" : "Prompt"}</span>
              <textarea value={form.prompt} maxLength={65_536} rows={4} onChange={(event) => patch("prompt", event.target.value)} />
            </label>
          </section>

          <section className="section" aria-labelledby={fieldId("when")}>
            <div className="section-head"><h2 className="section-title" id={fieldId("when")}>When to Run</h2></div>
            <AutomationScheduleFields
              idPrefix={fieldId("schedule")}
              cron={form.cron}
              timezone={form.timezone}
              enabled={form.enabled}
              cronError={cronChecked ? cronProblem : null}
              timezoneError={errorFor("timezone")}
              onCronChange={(cron) => {
                patch("cron", cron);
                // A valid expression clears the error; an invalid one shows again on the next blur.
                if (!scheduleError(cron, scheduleCheck)) setCronChecked(false);
              }}
              onCronBlur={() => setCronChecked(true)}
              onTimezoneChange={(timezone) => patch("timezone", timezone)}
            />
            <Checkbox label="Enabled" checked={form.enabled} onChange={(checked) => patch("enabled", checked)} />
          </section>

          <section className="section" aria-labelledby={fieldId("limits")}>
            <div className="section-head"><h2 className="section-title" id={fieldId("limits")}>Limits</h2></div>
            <div className="field-row">
              <div className="field">
                <span className="field-label">If a Run Is Missed</span>
                <Select label="If a Run Is Missed" value={form.misfire}
                  onChange={(value) => patch("misfire", value as FormState["misfire"])}
                  options={[
                    { value: "skip", label: "Skip It" },
                    { value: "fire_once", label: "Run It Once" },
                    { value: "catch_up", label: "Catch Up" },
                  ]} />
              </div>
              {form.misfire === "catch_up" && (
                <label className="field">
                  <span>Catch Up at Most</span>
                  <input className="w-xs" type="number" min="1" max="10" value={form.catchUpRuns}
                    aria-describedby={fieldId("catch-up-help")} onChange={(event) => patch("catchUpRuns", event.target.value)} />
                  <p className="field-helper" id={fieldId("catch-up-help")}>Missed runs</p>
                </label>
              )}
            </div>
            <div className="field-row">
              <div className="field">
                <span className="field-label">If the Machine Is Offline</span>
                <Select label="If the Machine Is Offline" value={form.runnerPolicy}
                  onChange={(value) => patch("runnerPolicy", value as FormState["runnerPolicy"])}
                  options={[
                    { value: "wait", label: "Wait Until It's Back" },
                    { value: "expire", label: "Give Up After a While" },
                    ...(form.actionKind !== "prompt_session" ? [{ value: "alternate", label: "Use Another Machine" }] : []),
                  ]} />
              </div>
              {form.runnerPolicy !== "wait" && (
                <label className="field">
                  <span>Give Up After</span>
                  <input className="w-xs" type="number" min="1" max="43200" value={form.expiryMinutes}
                    aria-describedby={fieldId("expiry-help")} onChange={(event) => patch("expiryMinutes", event.target.value)} />
                  <p className="field-helper" id={fieldId("expiry-help")}>In minutes</p>
                </label>
              )}
            </div>
            {form.runnerPolicy === "alternate" && (
              <>
                <div className="field-row">
                  <div className="field">
                    <span className="field-label">Other Machine</span>
                    <Select
                      label="Other Machine"
                      value={form.fallbackRunnerId || null}
                      placeholder="Select a Machine…"
                      emptyLabel="No other machine is connected"
                      onChange={(fallbackRunnerId) => update((current) => {
                        const runner = runners.get(fallbackRunnerId);
                        return {
                          ...current,
                          rebindAlternate: false,
                          alternateAgentTouched: true,
                          alternateWorkflowBindingEdits: {},
                          form: { ...current.form, fallbackRunnerId,
                            fallbackWorkspaceId: runner?.workspaces[0]?.id ?? "",
                            fallbackAgentId: defaultAgentId(runner?.agents) },
                        };
                      })}
                      options={otherMachineOptions}
                      invalid={fallbackRunnerError.invalid}
                      describedBy={fallbackRunnerError.describedBy}
                    />
                    {fallbackRunnerError.node}
                  </div>
                  <div className="field">
                    <span className="field-label">Other Folder</span>
                    <Select label="Other Folder" value={form.fallbackWorkspaceId || null}
                      onChange={(value) => patch("fallbackWorkspaceId", value)}
                      options={folderOptions(selectedFallback)}
                      placeholder={selectedFallback?.workspaces.length ? "Select a Folder…" : "No Folders Available"}
                      emptyLabel="The other machine has no folders" />
                  </div>
                </div>
                {form.actionKind === "create_session" && (
                  <div className="field">
                    <span className="field-label">Other Agent</span>
                    <Select
                      label="Other Agent"
                      value={form.fallbackAgentId || null}
                      placeholder={selectedFallback?.agents.length ? "Select an Agent…" : "No Agents Available"}
                      emptyLabel="The other machine has no agents"
                      onChange={(fallbackAgentId) => update((current) => ({
                        ...current, rebindAlternate: false, alternateAgentTouched: true,
                        form: { ...current.form, fallbackAgentId },
                      }))}
                      options={agentSelectOptions(selectedFallback, form.fallbackAgentId)}
                      invalid={fallbackAgentError.invalid}
                      describedBy={fallbackAgentError.describedBy}
                    />
                    {fallbackAgentError.node}
                    {alternateInstallationIssue && installationWarning(AUTOMATION_SAVED_ALTERNATE_INSTALLATION_UNAVAILABLE,
                      Boolean(installationFor(selectedFallback, form.fallbackAgentId)),
                      () => update((current) => ({ ...current, rebindAlternate: true })))}
                  </div>
                )}
                {alternateRoleFields}
                {alternateOrchestratorField}
              </>
            )}
            <div className="field-row">
              <div className="field">
                <span className="field-label">If the Last Run Is Still Going</span>
                <Select label="If the Last Run Is Still Going" value={form.concurrency}
                  onChange={(value) => patch("concurrency", value as FormState["concurrency"])}
                  options={[
                    { value: "wait", label: "Wait for It to Finish" },
                    { value: "skip", label: "Skip This Run" },
                    ...(form.actionKind !== "prompt_session" ? [{ value: "parallel", label: "Run Both at Once" }] : []),
                  ]} />
              </div>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Cost Limit</span>
                <span className="input-affix w-xs">
                  <span className="input-affix-text" aria-hidden="true">$</span>
                  <input type="number" min="0.01" max="10000" step="0.01" value={form.maxCostUsd}
                    aria-describedby={fieldId("cost-help")} onChange={(event) => patch("maxCostUsd", event.target.value)} />
                </span>
                <p className="field-helper" id={fieldId("cost-help")}>
                  {form.actionKind === "workflow_run"
                    ? "Additional spend for each agent in a run, in US dollars."
                    : "Additional spend for each run, in US dollars."}
                </p>
              </label>
              <label className="field">
                <span>Tool Call Limit</span>
                <input className="w-xs" type="number" min="1" max="100000" value={form.maxToolCalls}
                  aria-describedby={fieldId("tools-help")} onChange={(event) => patch("maxToolCalls", event.target.value)} />
                <p className="field-helper" id={fieldId("tools-help")}>
                  {form.actionKind === "workflow_run" ? "For each agent in a run." : "For each run."}
                </p>
              </label>
            </div>
          </section>

          <section className="section" aria-labelledby={fieldId("notifications")}>
            <div className="section-head"><h2 className="section-title" id={fieldId("notifications")}>Notifications</h2></div>
            <div className="field">
              <span className="field-label" id={fieldId("push")}>Web Push</span>
              <div className="automation-checks" role="group" aria-labelledby={fieldId("push")}>
                {pushEvents.map((event) => (
                  <Checkbox key={event} label={titleCaseLabel(event)} checked={form.pushEvents.includes(event)}
                    onChange={(checked) => patch("pushEvents", checked
                      ? [...form.pushEvents, event] : form.pushEvents.filter((item) => item !== event))} />
                ))}
              </div>
            </div>
          </section>

          {failure && !failure.field && (
            <Notice tone="danger" className="automation-editor-failure" details={failure.message}>
              {isNew ? "This automation wasn't created." : "These changes weren't saved."} Fix what the details
              below describe, then try again.
            </Notice>
          )}
        </form>
        <SaveBar
          dirty={dirty || saving}
          busy={saving}
          error={failure ? (isNew ? "Couldn't create the automation." : "Couldn't save the changes.") : null}
          alwaysShown={isNew}
          saveLabel={isNew ? "Create Automation" : "Save Changes"}
          discardLabel={isNew ? "Cancel" : "Discard"}
          onDiscard={discard}
          onSave={() => void save()}
        />
      </div>
    </div>
  );
}
