import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import type {
  AutomationAction,
  AutomationExecution,
  AutomationSchedule,
  AutomationTriggerCredential,
  AutomationTriggerDeliveryMetadata,
  AutomationTriggerKind,
  AutomationTriggerSessionSelector,
  AutomationTriggerView,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { AUTOMATION_INSTALLATION_UNAVAILABLE } from "@wollipog/protocol";
import { AutomationsIcon } from "./Icons.js";
import { useApi } from "../api-context.js";
import { startVisiblePolling } from "../visible-polling.js";
import { titleCaseLabel } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";
import { OutboundEventSubscriptions } from "./OutboundEventSubscriptions.js";
import { PageHeader } from "./PageHeader.js";
import { destination } from "../navigation.js";
import { specOf } from "../automation-form.js";
import { bindingAvailable, unboundInstallationUnavailable } from "../automation-installations.js";

interface TriggerDraft {
  automationId: string;
  kind: AutomationTriggerKind;
  name: string;
  configurable: boolean;
  allowPrompt: boolean;
  parameterNames: string;
  missingReferences: "reject" | "use_stored";
  sessionSelectors: AutomationTriggerSessionSelector[];
}

function deliverySummary(delivery: AutomationTriggerDeliveryMetadata): string {
  const parts = delivery.fields.map((field) => field === "parameters" && delivery.parameterNames.length
    ? `Parameters ${delivery.parameterNames.join(", ")}`
    : titleCaseLabel(field));
  if (delivery.targetSelector) parts.push(`Target ${titleCaseLabel(delivery.targetSelector)}`);
  return parts.join(" · ") || "No Optional Fields";
}

function toggleSelector(
  current: AutomationTriggerSessionSelector[],
  selector: AutomationTriggerSessionSelector,
  checked: boolean,
): AutomationTriggerSessionSelector[] {
  return checked ? [...current, selector] : current.filter((candidate) => candidate !== selector);
}

function formatTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function actionSummary(action: AutomationAction): string {
  if (action.kind === "prompt_session") return `Prompt session ${action.sessionId}`;
  if (action.kind === "workflow_run") return `Workflow ${action.request.workflowId} on ${action.request.runnerId}`;
  return `Create ${action.request.agentId} session on ${action.request.runnerId}`;
}

/**
 * A single automation, collapsed by default. Its own `expanded` state — not a lookup keyed by id in
 * the parent — is what survives the 5s poll: React preserves a component instance's hooks across
 * re-renders as long as its `key` (the automation id) matches, regardless of `items` being a fresh
 * array each refresh. The body is unmounted rather than hidden while collapsed, so a collapsed card
 * has no reachable focus targets and no displayed signing secret — the secret itself stays in the
 * parent's `credential` state, untouched by mount/unmount, so re-expanding shows it again.
 */
function AutomationCard({
  id,
  name,
  action,
  enabled,
  unhealthy,
  children,
}: {
  id: string;
  name: string;
  action: string;
  enabled: boolean;
  unhealthy: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleId = `automation-toggle-${id}`;
  const bodyId = `automation-body-${id}`;
  return (
    <article className="automation-card">
      <h3 className="automation-card-heading">
        <button
          type="button"
          id={toggleId}
          className="automation-card-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="automation-card-summary">
            <span className="automation-card-name">{name}</span>
            <span className="automation-card-action">{action}</span>
          </span>
          <span className="automation-card-meta">
            {unhealthy && <StatusBadge meta={statusMeta("automation", "target_unavailable")} />}
            <StatusBadge meta={statusMeta("automation", enabled ? "enabled" : "paused")} />
            <span className="automation-card-chevron" aria-hidden="true">▸</span>
          </span>
        </button>
      </h3>
      {expanded && (
        <div id={bodyId} role="region" aria-labelledby={toggleId} className="automation-card-body">
          {children}
        </div>
      )}
    </article>
  );
}

export function AutomationsView() {
  const api = useApi();
  const publicOrigin = useDashboardPublicOrigin();
  const { confirm } = useFeedback();
  const runners = useStoreSelector((state) => state.runners);
  const projects = useStoreSelector((state) => state.projects);
  const { navigate } = useStoreActions();
  const [items, setItems] = useState<AutomationSchedule[]>([]);
  /** The list has been read once; before that an empty list proves nothing (§12). */
  const [listLoaded, setListLoaded] = useState(false);
  const [details, setDetails] = useState<Record<string, AutomationExecution[]>>({});
  const [triggers, setTriggers] = useState<Record<string, AutomationTriggerView[]>>({});
  const [credential, setCredential] = useState<AutomationTriggerCredential | null>(null);
  const [triggerDraft, setTriggerDraft] = useState<TriggerDraft | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ source: "poll" | "mutation" | "refresh"; message: string } | null>(null);
  // A user action owns its error even if an earlier poll settles later. Effect cleanup also
  // revokes that ownership so an obsolete API client cannot publish or clear a newer error.
  const errorRevision = useRef(0);
  const beginMutation = () => {
    const revision = ++errorRevision.current;
    setError(null);
    return revision;
  };
  const mutationFailed = (revision: number, cause: unknown) => {
    setError((previous) => revision === errorRevision.current
      ? { source: "mutation", message: (cause as Error).message } : previous);
  };

  // Polls skip a busy refresh. A mutation waits for it and then reads its own authoritative result.
  const refreshInFlight = useRef<Promise<boolean> | null>(null);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async (onlyWhileVisible = false, active?: () => boolean) => {
    while (refreshInFlight.current) {
      await refreshInFlight.current.catch(() => {});
    }
    if (active?.() === false || (onlyWhileVisible && document.visibilityState === "hidden")) return false;
    const work = (async () => {
      const generation = (refreshGeneration.current += 1);
      const current = () => generation === refreshGeneration.current;

      // Commit the authoritative list independently, so a workflow failure cannot leave a deleted
      // automation's editor open and allow Save to send an ID the control plane no longer has.
      const automationResult = await api.automations();
      if (!current()) return false;
      setItems(automationResult.automations);
      setListLoaded(true);

      const workflowsLoaded = api.workflowDefinitions()
        .then((workflowResult) => { if (current()) setWorkflows(workflowResult); });

      const detailsLoaded = Promise.allSettled(automationResult.automations.map(async (item) => {
        const [detail, triggerResult] = await Promise.allSettled([
          api.automation(item.automationId),
          api.automationTriggers(item.automationId),
        ]);
        if (detail.status === "rejected") throw detail.reason;
        if (triggerResult.status === "rejected") throw triggerResult.reason;
        return [item.automationId, detail.value.executions, triggerResult.value.triggers] as const;
      })).then((results) => {
        const loaded = results.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
        if (!current()) return;
        setDetails(Object.fromEntries(loaded.map(([id, executions]) => [id, executions])));
        setTriggers(Object.fromEntries(loaded.map(([id, _executions, triggerItems]) => [id, triggerItems])));
      });
      // Keep the refresh busy until every fan-out request settles, even when one endpoint fails.
      const results = await Promise.allSettled([workflowsLoaded, detailsLoaded]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return current();
    })();
    refreshInFlight.current = work;
    try {
      return await work;
    } finally {
      refreshInFlight.current = null;
    }
  }, [api]);

  // Only call after a write explicitly resolves successfully. A failed authoritative read is
  // recoverable by polling; a rejected/unknown-acceptance write still belongs to mutationFailed.
  const refreshAfterMutation = async (revision: number) => {
    if (revision !== errorRevision.current) return;
    try {
      await refresh(false, () => revision === errorRevision.current);
    } catch (cause) {
      setError((previous) => revision === errorRevision.current
        ? { source: "refresh", message: (cause as Error).message } : previous);
    }
  };

  useEffect(() => {
    let active = true;
    let initialRefresh = true;
    const load = () => {
      // A previous effect's request can still be settling after Strict Mode cleanup or an API
      // change. The new effect must refresh after it, rather than wait for the first interval.
      if (refreshInFlight.current && !initialRefresh) return;
      initialRefresh = false;
      const revision = errorRevision.current;
      void refresh(true, () => active).then((recovered) => {
        if (!active || !recovered) return;
        setError((previous) => revision === errorRevision.current &&
          (previous?.source === "poll" || previous?.source === "refresh")
          ? null : previous);
      }).catch((cause) => {
        if (!active) return;
        setError((previous) => revision === errorRevision.current && previous?.source !== "mutation"
          ? { source: "poll", message: (cause as Error).message } : previous);
      });
    };
    const stopPolling = startVisiblePolling(load, 5_000);
    return () => {
      active = false;
      refreshGeneration.current += 1;
      errorRevision.current += 1;
      stopPolling();
    };
  }, [refresh]);

  const openNewAutomation = () => navigate({ name: "automations", editor: { kind: "new" } });

  const mutate = async (work: () => Promise<unknown>) => {
    setBusy(true);
    const revision = beginMutation();
    try {
      await work();
      await refreshAfterMutation(revision);
    } catch (cause) {
      mutationFailed(revision, cause);
    } finally {
      setBusy(false);
    }
  };

  const openTriggerCreator = (automation: AutomationSchedule, kind: AutomationTriggerKind) => {
    setTriggerDraft({
      automationId: automation.automationId,
      kind,
      name: `${automation.name} ${kind === "chatops" ? "chat-ops" : "webhook"}`.slice(0, 80),
      configurable: false,
      allowPrompt: false,
      parameterNames: "",
      missingReferences: "reject",
      sessionSelectors: [],
    });
  };

  const createTrigger = async () => {
    if (!triggerDraft) return;
    setBusy(true);
    const revision = beginMutation();
    try {
      const parameterNames = [...new Set(triggerDraft.parameterNames.split(",")
        .map((name) => name.trim()).filter(Boolean))];
      const created = await api.createAutomationTrigger(triggerDraft.automationId, {
        kind: triggerDraft.kind,
        name: triggerDraft.name,
        ...(triggerDraft.configurable ? { deliveryPolicy: {
          allowPrompt: triggerDraft.allowPrompt,
          parameterNames,
          missingReferences: triggerDraft.missingReferences,
          ...(triggerDraft.sessionSelectors.length ? { sessionSelectors: triggerDraft.sessionSelectors } : {}),
        } } : {}),
      });
      setCredential(created);
      setTriggerDraft(null);
      await refreshAfterMutation(revision);
    } catch (cause) {
      mutationFailed(revision, cause);
    } finally {
      setBusy(false);
    }
  };

  const rotateTrigger = async (automationId: string, triggerId: string) => {
    setBusy(true);
    const revision = beginMutation();
    try {
      const rotated = await api.rotateAutomationTrigger(automationId, triggerId);
      setCredential(rotated);
      await refreshAfterMutation(revision);
    } catch (cause) {
      mutationFailed(revision, cause);
    } finally {
      setBusy(false);
    }
  };

  const revokeTrigger = async (automationId: string, triggerId: string) => {
    setBusy(true);
    const revision = beginMutation();
    try {
      await api.deleteAutomationTrigger(automationId, triggerId);
      if (credential?.trigger.triggerId === triggerId) setCredential(null);
      await refreshAfterMutation(revision);
    } catch (cause) {
      mutationFailed(revision, cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="page">
      <PageHeader
        title={destination("automations").name}
        description={destination("automations").description}
        primary={{ label: "New Automation", onClick: openNewAutomation }}
      />
      {error && <div className="automation-error" role="alert">{error.message}</div>}

      <OutboundEventSubscriptions projects={[...projects.values()]} automations={items} />

      <div className="automation-list">
        {items.length === 0 && (listLoaded ? (
          <State
            icon={<AutomationsIcon />}
            title={`No ${destination("automations").name} Yet`}
            // This screen exposed an `h3` before the conversion, and heading navigation is how a
            // screen-reader user finds a section. Losing it is not a styling change.
            headingLevel={3}
            actions={
              <button type="button" className="btn primary" onClick={openNewAutomation}>
                New Automation
              </button>
            }
          >
            Create a finite, auditable schedule that runs while this control plane stays online.
          </State>
        ) : !error && <State variant="loading">Loading automations…</State>)}
        {items.map((item) => {
          const executions = details[item.automationId] ?? [];
          const triggerItems = triggers[item.automationId] ?? [];
          const latest = executions[0];
          const actionRunner = item.action.kind === "prompt_session" ? undefined : runners.get(item.action.request.runnerId);
          const savedBindings = item.action.kind === "prompt_session" ? undefined : item.action.installationBindings;
          const unavailableInstallation = savedBindings && Object.values(savedBindings)
            .some((binding) => !bindingAvailable(actionRunner, binding));
          const unboundInstallation = item.action.kind === "create_session" && !savedBindings?.agent &&
            unboundInstallationUnavailable(actionRunner, item.action.request.agentId, savedBindings === undefined);
          const workflowAction = item.action.kind === "workflow_run" ? item.action : null;
          const unboundWorkflow = workflowAction !== null && (() => {
            const workflow = workflows.find((definition) =>
              definition.workflowId === workflowAction.request.workflowId &&
              (workflowAction.request.workflowVersion === undefined ||
                definition.version === workflowAction.request.workflowVersion));
            return workflow?.nodes.some((node) => {
              if (node.kind !== "agent") return false;
              const role = node.agentId!;
              if (savedBindings?.[`role:${role}`]) return false;
              const id = workflowAction.request.agentBindings?.[role] ?? role;
              return !actionRunner?.agents.some((agent) => agent.id === id && !agent.installation);
            }) ?? false;
          })();
          const unboundOrchestrator = workflowAction?.request.orchestratorAgentId &&
            !savedBindings?.orchestrator && !actionRunner?.agents.some((agent) =>
              agent.id === workflowAction.request.orchestratorAgentId && !agent.installation);
          const unavailableAlternate = item.runnerPolicy.kind === "alternate" &&
            item.runnerPolicy.targets.some((target) => {
              const runner = runners.get(target.runnerId);
              const bindings = target.installationBindings;
              if (Object.values(bindings ?? {}).some((binding) => !bindingAvailable(runner, binding))) return true;
              if (item.action.kind === "create_session") {
                return !bindings?.agent &&
                  unboundInstallationUnavailable(runner, target.agentId!, bindings === undefined);
              }
              if (!workflowAction) return false;
              const workflow = workflows.find((definition) =>
                definition.workflowId === workflowAction.request.workflowId &&
                (workflowAction.request.workflowVersion === undefined ||
                  definition.version === workflowAction.request.workflowVersion));
              const unboundRole = workflow?.nodes.some((node) => {
                if (node.kind !== "agent") return false;
                const role = node.agentId!;
                if (bindings?.[`role:${role}`]) return false;
                const id = target.agentBindings?.[role] ?? workflowAction.request.agentBindings?.[role] ?? role;
                return !runner?.agents.some((agent) => agent.id === id && !agent.installation);
              }) ?? false;
              const orchestrator = target.orchestratorAgentId ?? workflowAction.request.orchestratorAgentId;
              return unboundRole || Boolean(orchestrator && !bindings?.orchestrator &&
                !runner?.agents.some((agent) => agent.id === orchestrator && !agent.installation));
            });
          return <AutomationCard key={item.automationId} id={item.automationId} name={item.name} action={actionSummary(item.action)} enabled={item.enabled} unhealthy={Boolean(item.targetHealth)}>
            {(unavailableInstallation || unboundInstallation || unboundWorkflow || unboundOrchestrator || unavailableAlternate) && <p className="automation-execution-error" role="alert">
              {AUTOMATION_INSTALLATION_UNAVAILABLE}
            </p>}
            {item.targetHealth && <p className="automation-execution-error" role="alert">
              Waiting for target: {item.targetHealth.error}
            </p>}
            <dl className="automation-facts"><div><dt>Schedule</dt><dd><code>{item.cron}</code> · {item.timezone}</dd></div><div><dt>Next Fire</dt><dd>{formatTime(item.nextFireAt)}</dd></div><div><dt>Last Result</dt><dd>{latest ? `${titleCaseLabel(latest.status)} · ${formatTime(latest.completedAt ?? latest.startedAt ?? latest.createdAt)}` : "Never"}</dd></div><div><dt>Policies</dt><dd>{titleCaseLabel(item.misfirePolicy.kind)} · {titleCaseLabel(item.runnerPolicy.kind)} · {titleCaseLabel(item.concurrencyPolicy)}</dd></div><div><dt>Ceilings</dt><dd>${item.limits.maxCostUsd} · {item.limits.maxToolCalls} Tools</dd></div></dl>
            {latest?.error && <p className="automation-execution-error">{latest.error}</p>}
            <div className="automation-card-actions automation-trigger-create"><button className="btn ghost sm" disabled={busy} onClick={() => openTriggerCreator(item, "webhook")}>Add Webhook</button><button className="btn ghost sm" disabled={busy} onClick={() => openTriggerCreator(item, "chatops")}>Add Chat-Ops</button><small>Pausing blocks cron and signed triggers, but credentials can be configured while paused.</small></div>
            {triggerDraft?.automationId === item.automationId && <div className="automation-trigger-editor" aria-label="New Signed Trigger">
              <h4>New Signed Trigger</h4>
              <div className="automation-form-grid">
                <label>Name<input value={triggerDraft.name} maxLength={80} onChange={(event) => setTriggerDraft((current) => current ? { ...current, name: event.target.value } : current)} /></label>
                <label>Kind<input className="is-read-only" value={titleCaseLabel(triggerDraft.kind)} readOnly /></label>
                {item.action.kind !== "workflow_run" && <div className="automation-span"><Checkbox checked={triggerDraft.configurable} label="Accept Delivery Fields" onChange={(checked) => setTriggerDraft((current) => current ? { ...current, configurable: checked } : current)} /></div>}
                {item.action.kind !== "workflow_run" && triggerDraft.configurable && <>
                  <div><Checkbox checked={triggerDraft.allowPrompt} label="Delivered Prompt" onChange={(checked) => setTriggerDraft((current) => current ? { ...current, allowPrompt: checked } : current)} /></div>
                  <div className="automation-field"><span className="field-label">Missing References</span><Select label="Missing References" value={triggerDraft.missingReferences} onChange={(missingReferences) => setTriggerDraft((current) => current ? { ...current, missingReferences } : current)} options={[
                    { value: "reject", label: "Reject Delivery" },
                    { value: "use_stored", label: "Use Stored Text" },
                  ]} /></div>
                  <label className="automation-span">Parameter Names<input value={triggerDraft.parameterNames} placeholder="issue, run_id" onInput={(event) => {
                    const parameterNames = event.currentTarget.value;
                    setTriggerDraft((current) => current ? { ...current, parameterNames } : current);
                  }} /><small>Comma-separated names. Reference them as <code>{"{{delivery.parameters.issue}}"}</code>.</small></label>
                  {item.action.kind === "prompt_session" && <fieldset className="automation-span"><legend>Session Selectors</legend><div className="automation-checks">{([
                    ["session_id", "Session ID"], ["branch", "Branch"], ["pull_request", "Pull Request"],
                  ] as const).map(([selector, label]) => <Checkbox key={selector} checked={triggerDraft.sessionSelectors.includes(selector)} label={label} onChange={(checked) => setTriggerDraft((current) => current ? { ...current, sessionSelectors: toggleSelector(current.sessionSelectors, selector, checked) } : current)} />)}</div></fieldset>}
                  <p className="automation-hint automation-span">Use <code>{"{{delivery.prompt}}"}</code> to place delivered text. Allowed parameters are also included in the signed-delivery context preamble.</p>
                </>}
              </div>
              <div className="automation-editor-actions"><button className="btn ghost sm" type="button" onClick={() => setTriggerDraft(null)}>Cancel</button><button className="btn primary sm" type="button" disabled={busy} onClick={() => void createTrigger()}>{busy ? "Creating…" : "Create Trigger"}</button></div>
            </div>}
            {triggerItems.length > 0 && <div className="automation-triggers" aria-label="Signed Out-of-Band Triggers"><h4>Signed Triggers</h4>{triggerItems.map((trigger) => {
              const endpoint = publicOrigin
                ? `${publicOrigin}/hooks/v1/automation-triggers/${trigger.triggerId}`
                : "Unavailable until This Machine has a reachable dashboard address";
              const revealed = credential?.trigger.triggerId === trigger.triggerId ? credential : null;
              const policy = trigger.deliveryPolicy;
              return <div className="automation-trigger" key={trigger.triggerId}><div><strong>{trigger.name}</strong><span>{titleCaseLabel(trigger.kind)} · Key Generation {trigger.generation} · {trigger.invocationCount === 1 ? "1 Delivery" : `${trigger.invocationCount} Deliveries`}</span>{policy && <small>Accepts {[
                ...(policy.allowPrompt ? ["Prompt"] : []),
                ...(policy.parameterNames.length ? [`Parameters ${policy.parameterNames.join(", ")}`] : []),
                ...(policy.sessionSelectors?.length ? [`Selectors ${policy.sessionSelectors.map(titleCaseLabel).join(", ")}`] : []),
              ].join(" · ")}</small>}{trigger.lastInvokedAt && <small>Last Signed Delivery {formatTime(trigger.lastInvokedAt)}</small>}</div><code>{endpoint}</code>{revealed && <div className="automation-trigger-secret" role="status"><strong>Copy this signing secret now. It will not be shown again.</strong><code>{revealed.secret}</code><button className="btn ghost sm" type="button" onClick={() => void navigator.clipboard.writeText(revealed.secret)}>Copy Secret</button><button className="btn ghost sm" type="button" onClick={() => setCredential(null)}>Hide</button></div>}<p>{policy
                ? `Signed body may add: ${[policy.allowPrompt ? "prompt" : "", policy.parameterNames.length ? "parameters" : "", policy.sessionSelectors?.length ? "target" : ""].filter(Boolean).join(", ")}.`
                : trigger.kind === "chatops" ? 'Signed body: {"eventId":"...","command":"run","sender":"opaque actor"}' : 'Signed body: {"eventId":"..."}'}</p><div className="automation-trigger-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Rotate Signing Secret", message: `The previous signing secret for “${item.name}” stops working immediately. This cannot be undone.`, confirmLabel: "Rotate Secret", tone: "danger" })) await rotateTrigger(item.automationId, trigger.triggerId); })()}>Rotate Secret</button><button className="btn ghost danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Revoke Signed Trigger", message: `The signed trigger for “${item.name}” is revoked, and its pending unclaimed deliveries are rejected.`, confirmLabel: "Revoke Trigger", tone: "danger" })) await revokeTrigger(item.automationId, trigger.triggerId); })()}>Revoke</button></div></div>;
            })}<p className="automation-hint">Send <code>application/vnd.wollipog.automation-trigger+json</code> with X-Wollipog-Timestamp, X-Wollipog-Nonce, and X-Wollipog-Signature. Every optional field must be explicitly allowed by this fixed automation trigger; deliveries cannot change agents, runners, policies, or ceilings.</p></div>}
            <div className="automation-card-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void mutate(() => api.updateAutomation(item.automationId, { ...specOf(item), enabled: !item.enabled }))}>{item.enabled ? "Pause" : "Enable"}</button><button className="btn ghost sm" onClick={() => navigate({
              name: "automations", editor: { kind: "edit", automationId: item.automationId },
            })}>Edit</button><button className="btn ghost danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Delete Automation", message: `“${item.name}” is removed permanently. Its execution history stays in the audit log.`, confirmLabel: "Delete Automation", tone: "danger" })) await mutate(() => api.deleteAutomation(item.automationId)); })()}>Delete</button></div>
            {executions.length > 0 && <details className="automation-history"><summary>Execution History ({executions.length})</summary><div className="automation-history-list">{executions.map((execution) => <div className="automation-execution" key={execution.executionId}><div><strong>{titleCaseLabel(execution.status)}</strong><span>{formatTime(execution.scheduledFor)}</span></div><code>{execution.idempotencyKey}</code>{execution.triggerDelivery && <small>Delivered Fields: {deliverySummary(execution.triggerDelivery)}{execution.triggerDelivery.promptSha256 ? ` · Prompt Digest ${execution.triggerDelivery.promptSha256.slice(0, 12)}…` : ""}</small>}{execution.commands?.length ? <ul className="automation-command-list" aria-label="Durable Runner Command Receipts">{execution.commands.map((command) => <li key={command.commandId}><span>{titleCaseLabel(command.kind.replace("_", " "))} · {titleCaseLabel(command.state)}</span><small>{command.attemptCount} delivery attempt{command.attemptCount === 1 ? "" : "s"}</small>{command.lastError && <em>{command.lastError}</em>}</li>)}</ul> : execution.deliveryMode === "legacy_at_most_once" ? <small className="automation-legacy-delivery">Legacy At-Most-Once Delivery</small> : null}{execution.error && <p>{execution.error}</p>}{execution.sessionId && <button className="link-button" type="button" onClick={() => navigate({ name: "session", id: execution.sessionId! })}>Open Session</button>}</div>)}</div></details>}
          </AutomationCard>;
        })}
      </div>
    </section>
  );
}
