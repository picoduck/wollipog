import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
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
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { actionSentence, actionText, describeSchedule, policyCopy, specOf } from "../automation-form.js";
import { automationInstallationUnavailable } from "../automation-installations.js";
import { writeClipboardText } from "../clipboard.js";
import { detailPlaceholder } from "../detail-placeholder.js";
import { useReportEntityTitle } from "../entity-title.js";
import { formatCalendarTime, titleCaseLabel } from "../format.js";
import { absoluteViewUrl, backLabel, viewTitle } from "../navigation.js";
import { timeZoneDisplayName } from "../reminder-schedule.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { machineOptionLabels } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { EditIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { DetailBar, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";
import { useAutomationPolling } from "./useAutomationPolling.js";
import { useIsMobile } from "./useIsMobile.js";

/**
 * The automation page's notices, in one table (#2968, docs/design-system.md §13.2): one shows, the
 * most severe and then the lowest rank, and the rest wait behind its "+N More". A failed action is
 * what the person just did, so it leads the danger notices.
 */
export const AUTOMATION_NOTICE_RANK = {
  actionFailed: 1,
  lastRunFailed: 2,
  agentUnavailable: 3,
  waitingForMachine: 4,
  refreshFailed: 5,
} as const;

const BACK_TO_MORE_ACTIONS = "Back to More Actions";
const NO_LINK_REASON = "Open Wollipog in a browser to copy a link.";

interface TriggerDraft {
  kind: AutomationTriggerKind;
  name: string;
  configurable: boolean;
  allowPrompt: boolean;
  parameterNames: string;
  missingReferences: "reject" | "use_stored";
  sessionSelectors: AutomationTriggerSessionSelector[];
}

type Stored =
  | { state: "loading" }
  | { state: "loaded"; automation: AutomationSchedule; executions: AutomationExecution[] }
  | { state: "missing" };

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

/** "Today, 2:00 AM", or a dash when there is no time. */
function when(value: number | undefined, now: number): string {
  return value === undefined ? "—" : formatCalendarTime(value, now);
}

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One automation's page, `/automations/~<id>` (#2968): the detail bar with Pause or Resume, Edit
 * and ⋯; the one notice that needs the person; three facts at a glance; what it does; its rules and
 * limits; then its triggers and run history. It reads this automation alone: its detail and its
 * triggers, and the workflow definitions only for a workflow action.
 */
export function AutomationDetail({ automationId }: { automationId: string }) {
  const api = useApi();
  const publicOrigin = useDashboardPublicOrigin();
  const { confirm, showToast } = useFeedback();
  const { navigate } = useStoreActions();
  const runners = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const sessions = useStoreSelector((state) => state.sessions);
  const conn = useStoreSelector((state) => state.conn);
  const phone = useIsMobile();
  const [stored, setStored] = useState<Stored>({ state: "loading" });
  const [triggers, setTriggers] = useState<AutomationTriggerView[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [credential, setCredential] = useState<AutomationTriggerCredential | null>(null);
  const [triggerDraft, setTriggerDraft] = useState<TriggerDraft | null>(null);
  const draftNameRef = useRef<HTMLInputElement>(null);
  const focusDraft = useRef(false);
  const historyRef = useRef<HTMLDetailsElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // One complete read. The automation commits as soon as it arrives, independently of its triggers
  // and workflows, but the read stays busy until every request settles, even when one fails.
  const load = useCallback(async (current: () => boolean) => {
    const triggersLoaded = api.automationTriggers(automationId)
      .then((result) => { if (current()) setTriggers(result.triggers); });
    // Handled below once the automation settles; until then, a failure is not unhandled.
    triggersLoaded.catch(() => {});
    let detail: Awaited<ReturnType<typeof api.automation>>;
    try {
      detail = await api.automation(automationId);
    } catch (cause) {
      await triggersLoaded.catch(() => {});
      // Deleted, here or elsewhere: the page says so rather than keep showing what is gone.
      if (cause instanceof ApiError && cause.status === 404) {
        if (current()) setStored({ state: "missing" });
        return;
      }
      throw cause;
    }
    if (current()) setStored({ state: "loaded", automation: detail.automation, executions: detail.executions });
    // A workflow action's roles resolve against its definition (Agent Unavailable); nothing else
    // needs the workflows.
    const workflowsLoaded = detail.automation.action.kind === "workflow_run"
      ? api.workflowDefinitions().then((result) => { if (current()) setWorkflows(result); })
      : Promise.resolve();
    const results = await Promise.allSettled([triggersLoaded, workflowsLoaded]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }, [api, automationId]);

  const { busy, error, mutate, retry } = useAutomationPolling(load);

  const automation = stored.state === "loaded" ? stored.automation : null;
  useReportEntityTitle({ name: "automation", id: automationId }, automation?.name);

  useEffect(() => {
    if (!triggerDraft || !focusDraft.current) return;
    focusDraft.current = false;
    draftNameRef.current?.focus();
    draftNameRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [triggerDraft]);

  const machineLabels = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return machineOptionLabels([...runners.values()], (id) => boxByRunner.get(id));
  }, [boxes, runners]);
  const machineLabel = (runnerId: string) => machineLabels.get(runnerId);

  const toList = () => navigate({ name: "automations" });
  const pageView = { name: "automation", id: automationId } as const;

  if (!automation) {
    const placeholder = stored.state === "missing"
      ? detailPlaceholder("Automation", { authoritative: true, conn })
      : detailPlaceholder("Automation", {
        authoritative: false,
        conn,
        error: error?.source === "poll" ? error.message : null,
      });
    return (
      <div className="run-detail automation-detail">
        <DetailBar title={viewTitle(pageView)} backLabel={backLabel("automations")} onBack={toList} />
        {placeholder.variant === "loading" ? (
          <div className="skeleton automation-glance-skeleton" role="status" aria-live="polite">
            <span className="sr-only">Loading automation…</span>
            {[0, 1, 2].map((index) => <span key={index} aria-hidden="true" className="skeleton-bar title" />)}
          </div>
        ) : (
          <State
            variant={placeholder.variant}
            title={placeholder.title}
            details={placeholder.details}
            actions={placeholder.actions.includes("back") ? (
              <button type="button" className="btn primary" onClick={toList}>{backLabel("automations")}</button>
            ) : placeholder.actions.includes("retry") ? (
              <button type="button" className="btn sm" onClick={retry}>Try Again</button>
            ) : undefined}
          >
            {placeholder.hint}
          </State>
        )}
      </div>
    );
  }

  const executions = stored.state === "loaded" ? stored.executions : [];
  const latest = executions[0];
  const lastRunFailed = latest?.status === "failed";
  const now = Date.now();
  const viewerZone = viewerTimeZone();
  const schedule = describeSchedule(automation.cron, automation.timezone, now, { viewerTimeZone: viewerZone });
  const showZone = viewerZone !== automation.timezone;
  const statusBadge = <StatusBadge meta={statusMeta("automation",
    lastRunFailed ? "last_run_failed" : automation.enabled ? "enabled" : "paused")} />;
  const primaryRunnerId = automation.action.kind === "prompt_session"
    ? sessions.get(automation.action.sessionId)?.runnerId
    : automation.action.request.runnerId;
  const primaryMachine = primaryRunnerId === undefined ? undefined : machineLabel(primaryRunnerId);
  const nextRunWords = automation.nextFireAt !== undefined ? when(automation.nextFireAt, now) : schedule.nextLabel;
  const installationUnavailable = automationInstallationUnavailable(automation, runners, workflows);

  const edit = () => navigate({ name: "automations", editor: { kind: "edit", automationId } });
  const openSession = (sessionId: string) => navigate({ name: "session", id: sessionId });
  const openRunHistory = () => {
    const history = historyRef.current;
    if (!history) return;
    history.open = true;
    history.scrollIntoView?.({ block: "start" });
    history.querySelector<HTMLElement>("summary")?.focus();
  };

  const togglePause = () => void mutate(
    () => api.updateAutomation(automationId, { ...specOf(automation), enabled: !automation.enabled }),
    automation.enabled ? "Automation Not Paused" : "Automation Not Resumed",
  );

  const openTriggerCreator = (kind: AutomationTriggerKind) => {
    focusDraft.current = true;
    setTriggerDraft({
      kind,
      name: `${automation.name} ${kind === "chatops" ? "chat-ops" : "webhook"}`.slice(0, 80),
      configurable: false,
      allowPrompt: false,
      parameterNames: "",
      missingReferences: "reject",
      sessionSelectors: [],
    });
  };

  const createTrigger = () => {
    if (!triggerDraft) return;
    void mutate(async () => {
      const parameterNames = [...new Set(triggerDraft.parameterNames.split(",")
        .map((name) => name.trim()).filter(Boolean))];
      const created = await api.createAutomationTrigger(automationId, {
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
    }, "Trigger Not Created");
  };

  const rotateTrigger = (triggerId: string) => void mutate(async () => {
    const rotated = await api.rotateAutomationTrigger(automationId, triggerId);
    setCredential(rotated);
  }, "Secret Not Rotated");

  const revokeTrigger = (triggerId: string) => void mutate(async () => {
    await api.deleteAutomationTrigger(automationId, triggerId);
    setCredential((current) => current?.trigger.triggerId === triggerId ? null : current);
  }, "Trigger Not Revoked");

  const remove = async (back?: ConfirmationOptions["back"]) => {
    const count = triggers.length;
    const withTriggers = count === 0 ? "" : `, with its ${count} ${count === 1 ? "trigger" : "triggers"}`;
    const name = automation.name;
    if (!await confirm({
      title: "Delete Automation",
      message: `“${name}” stops running and is removed${withTriggers}. Its run history is kept.`,
      confirmLabel: "Delete Automation",
      tone: "danger",
      ...(back ? { back } : {}),
    })) return;
    const deleted = await mutate(() => api.deleteAutomation(automationId), "Automation Not Deleted", { refresh: false });
    if (!deleted) return;
    showToast(`“${name}” deleted.`, { tone: "success" });
    // Left while the delete ran: the toast says it happened, and where they went is theirs.
    if (mounted.current) navigate({ name: "automations" }, { replace: true });
  };

  const linkUrl = publicOrigin ? absoluteViewUrl(publicOrigin, pageView) : null;
  const copyLink = async () => {
    if (!linkUrl) return;
    const copied = await writeClipboardText(linkUrl, () => mounted.current);
    if (copied === null) return;
    if (copied) showToast("Link copied.", { tone: "success" });
    else showToast("Couldn't copy the link.", { tone: "error" });
  };

  const backTo = (choice: ActionsMenuChoice) => ({ label: BACK_TO_MORE_ACTIONS, run: choice.reopen });
  const pauseLabel = automation.enabled ? "Pause" : "Resume";
  const menu: PageMenuAction[] = [
    // On a phone the bar holds only the pencil and ⋯, so Pause and Resume move here (§15.1).
    ...(phone ? [{ label: pauseLabel, disabled: busy, onClick: togglePause }] : []),
    { label: "Add Webhook Trigger…", disabled: busy, onClick: () => openTriggerCreator("webhook") },
    { label: "Add Chat-Ops Trigger…", disabled: busy, onClick: () => openTriggerCreator("chatops") },
    {
      label: "Copy Link",
      disabled: !linkUrl,
      ...(linkUrl ? {} : { description: NO_LINK_REASON }),
      onClick: () => void copyLink(),
    },
    { label: "Delete Automation…", danger: true, disabled: busy, onClick: (choice) => void remove(backTo(choice)) },
  ];

  const notices: SessionNoticeEntry[] = [];
  if (error?.source === "mutation") {
    notices.push({
      key: "action-failed", severity: "danger", rank: AUTOMATION_NOTICE_RANK.actionFailed,
      title: error.action ?? "Action Failed",
      render: ({ trailing }) => (
        <Notice tone="danger" role="alert" title={error.action ?? "Action Failed"} trailing={trailing}>{error.message}</Notice>
      ),
    });
  }
  if (lastRunFailed && latest) {
    const failedSessionId = latest.sessionId;
    notices.push({
      key: "last-run-failed", severity: "danger", rank: AUTOMATION_NOTICE_RANK.lastRunFailed, title: "Last Run Failed",
      render: ({ trailing }) => (
        <Notice
          tone="danger"
          role="alert"
          title="Last Run Failed"
          trailing={trailing}
          actions={<>
            {failedSessionId && (
              <button type="button" className="btn sm" onClick={() => openSession(failedSessionId)}>Open Session</button>
            )}
            <button type="button" className="btn sm ghost" onClick={openRunHistory}>Run Details</button>
          </>}
        >
          {latest.error ?? "The last run didn't finish."}
        </Notice>
      ),
    });
  }
  if (installationUnavailable) {
    notices.push({
      key: "agent-unavailable", severity: "warning", rank: AUTOMATION_NOTICE_RANK.agentUnavailable, title: "Agent Unavailable",
      render: ({ trailing }) => (
        <Notice
          tone="warning"
          title="Agent Unavailable"
          trailing={trailing}
          actions={<button type="button" className="btn sm" onClick={edit}>Edit Automation</button>}
        >
          {AUTOMATION_INSTALLATION_UNAVAILABLE}
        </Notice>
      ),
    });
  }
  if (automation.targetHealth) {
    const waitingTitle = automation.action.kind === "prompt_session"
      ? "Waiting for the Session"
      : `Waiting for ${primaryMachine ?? "Its Machine"}`;
    const healthError = automation.targetHealth.error;
    notices.push({
      key: "waiting-for-machine", severity: "warning", rank: AUTOMATION_NOTICE_RANK.waitingForMachine, title: waitingTitle,
      render: ({ trailing }) => (
        <Notice tone="warning" title={waitingTitle} trailing={trailing}>{healthError}</Notice>
      ),
    });
  }
  if (error && error.source !== "mutation") {
    notices.push({
      key: "refresh-failed", severity: "warning", rank: AUTOMATION_NOTICE_RANK.refreshFailed, title: "Couldn't Refresh",
      render: ({ trailing }) => (
        <Notice tone="warning" title="Couldn't Refresh" trailing={trailing}>{error.message}</Notice>
      ),
    });
  }

  const actionNames = {
    runners,
    machineLabel,
    sessionTitle: (sessionId: string) => sessions.get(sessionId)?.title || undefined,
    workflowName: (workflowId: string) => workflows.find((workflow) => workflow.workflowId === workflowId)?.name,
  };
  const text = actionText(automation.action);
  const offlineLabel = automation.action.kind === "prompt_session"
    ? "If the Session Is Busy or Offline"
    : `If ${primaryMachine ?? "Its Machine"} Is Offline`;
  const offlineAnswer = automation.action.kind === "prompt_session" && automation.runnerPolicy.kind === "wait"
    ? "Wait until it's ready"
    : policyCopy.offline(automation.runnerPolicy, machineLabel);

  return (
    <div className="run-detail automation-detail">
      <DetailBar
        title={viewTitle(pageView, automation.name)}
        backLabel={backLabel("automations")}
        onBack={toList}
        status={phone ? undefined : statusBadge}
        secondary={phone ? undefined : { label: pauseLabel, disabled: busy, onClick: togglePause }}
        primary={{ label: "Edit", icon: <EditIcon />, iconOnPhone: true, onClick: edit }}
        menu={menu}
      />
      {/* On a phone the bar is the app bar, so the badge sits under it (§15.1). */}
      {phone && <div className="automation-status">{statusBadge}</div>}
      <SessionNoticeSlot
        sessionId={`automation:${automationId}`}
        entries={notices}
        label="Automation Notices"
        className="automation-notice-slot"
      />

      <dl className="glance">
        <div>
          <dt>Next Run</dt>
          <dd>{automation.enabled ? (nextRunWords ?? "Not scheduled") : "Paused"}</dd>
        </div>
        <div>
          <dt>Last Run</dt>
          <dd>
            {latest ? (
              <>
                <StatusBadge meta={statusMeta("automation_run", latest.status)} inline />
                <span>{when(latest.completedAt ?? latest.startedAt ?? latest.createdAt, now)}</span>
                {latest.sessionId && (
                  <button type="button" className="btn sm ghost" onClick={() => openSession(latest.sessionId!)}>Open Session</button>
                )}
              </>
            ) : automation.enabled && nextRunWords ? `Not yet; first run ${nextRunWords}` : "Not yet"}
          </dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>
            <span>{schedule.label}</span>
            <code>{automation.cron}</code>
            {showZone && <span className="glance-zone">{timeZoneDisplayName(automation.timezone, now)}</span>}
          </dd>
        </div>
      </dl>

      <div className="automation-sections">
        <section className="section" aria-labelledby="automation-does">
          <div className="section-head"><h2 className="section-title" id="automation-does">What It Does</h2></div>
          <p className="automation-sentence">{actionSentence(automation.action, actionNames)}</p>
          {text && <p className="automation-prompt">{text}</p>}
        </section>

        <section className="section" aria-labelledby="automation-rules">
          <div className="section-head"><h2 className="section-title" id="automation-rules">Rules and Limits</h2></div>
          <dl className="facts">
            <div><dt>If a Run Is Missed</dt><dd>{policyCopy.missed(automation.misfirePolicy)}</dd></div>
            <div><dt>{offlineLabel}</dt><dd>{offlineAnswer}</dd></div>
            <div><dt>If the Last Run Is Still Going</dt><dd>{policyCopy.concurrency(automation.concurrencyPolicy)}</dd></div>
            <div><dt>Cost Limit</dt><dd>{policyCopy.cost(automation.limits)}</dd></div>
            <div><dt>Tool Call Limit</dt><dd>{policyCopy.toolCalls(automation.limits)}</dd></div>
            <div><dt>Notifications</dt><dd>{policyCopy.notifications(automation.notifications)}</dd></div>
          </dl>
        </section>

        <section className="section" aria-labelledby="automation-triggers">
          <div className="section-head"><h2 className="section-title" id="automation-triggers">Triggers</h2></div>
          <p className="section-note">Pausing blocks cron and signed triggers, but credentials can be configured while paused.</p>
          {triggerDraft && <div className="automation-trigger-editor" aria-label="New Signed Trigger">
            <h3>New Signed Trigger</h3>
            <div className="automation-form-grid">
              <label>Name<input ref={draftNameRef} value={triggerDraft.name} maxLength={80} onChange={(event) => setTriggerDraft((current) => current ? { ...current, name: event.target.value } : current)} /></label>
              <label>Kind<input className="is-read-only" value={titleCaseLabel(triggerDraft.kind)} readOnly /></label>
              {automation.action.kind !== "workflow_run" && <div className="automation-span"><Checkbox checked={triggerDraft.configurable} label="Accept Delivery Fields" onChange={(checked) => setTriggerDraft((current) => current ? { ...current, configurable: checked } : current)} /></div>}
              {automation.action.kind !== "workflow_run" && triggerDraft.configurable && <>
                <div><Checkbox checked={triggerDraft.allowPrompt} label="Delivered Prompt" onChange={(checked) => setTriggerDraft((current) => current ? { ...current, allowPrompt: checked } : current)} /></div>
                <div className="automation-field"><span className="field-label">Missing References</span><Select label="Missing References" value={triggerDraft.missingReferences} onChange={(missingReferences) => setTriggerDraft((current) => current ? { ...current, missingReferences } : current)} options={[
                  { value: "reject", label: "Reject Delivery" },
                  { value: "use_stored", label: "Use Stored Text" },
                ]} /></div>
                <label className="automation-span">Parameter Names<input value={triggerDraft.parameterNames} placeholder="issue, run_id" onInput={(event) => {
                  const parameterNames = event.currentTarget.value;
                  setTriggerDraft((current) => current ? { ...current, parameterNames } : current);
                }} /><small>Comma-separated names. Reference them as <code>{"{{delivery.parameters.issue}}"}</code>.</small></label>
                {automation.action.kind === "prompt_session" && <fieldset className="automation-span"><legend>Session Selectors</legend><div className="automation-checks">{([
                  ["session_id", "Session ID"], ["branch", "Branch"], ["pull_request", "Pull Request"],
                ] as const).map(([selector, label]) => <Checkbox key={selector} checked={triggerDraft.sessionSelectors.includes(selector)} label={label} onChange={(checked) => setTriggerDraft((current) => current ? { ...current, sessionSelectors: toggleSelector(current.sessionSelectors, selector, checked) } : current)} />)}</div></fieldset>}
                <p className="automation-hint automation-span">Use <code>{"{{delivery.prompt}}"}</code> to place delivered text. Allowed parameters are also included in the signed-delivery context preamble.</p>
              </>}
            </div>
            <div className="automation-editor-actions"><button className="btn ghost sm" type="button" onClick={() => setTriggerDraft(null)}>Cancel</button><button className="btn primary sm" type="button" disabled={busy} onClick={createTrigger}>{busy ? "Creating…" : "Create Trigger"}</button></div>
          </div>}
          {triggers.length === 0 && !triggerDraft && <p className="automation-empty">No signed triggers yet.</p>}
          {triggers.length > 0 && <div className="automation-triggers" aria-label="Signed Out-of-Band Triggers">{triggers.map((trigger) => {
            const endpoint = publicOrigin
              ? `${publicOrigin}/hooks/v1/automation-triggers/${trigger.triggerId}`
              : "Unavailable until This Machine has a reachable dashboard address";
            const revealed = credential?.trigger.triggerId === trigger.triggerId ? credential : null;
            const policy = trigger.deliveryPolicy;
            return <div className="automation-trigger" key={trigger.triggerId}><div><strong>{trigger.name}</strong><span>{titleCaseLabel(trigger.kind)} · Key Generation {trigger.generation} · {trigger.invocationCount === 1 ? "1 Delivery" : `${trigger.invocationCount} Deliveries`}</span>{policy && <small>Accepts {[
              ...(policy.allowPrompt ? ["Prompt"] : []),
              ...(policy.parameterNames.length ? [`Parameters ${policy.parameterNames.join(", ")}`] : []),
              ...(policy.sessionSelectors?.length ? [`Selectors ${policy.sessionSelectors.map(titleCaseLabel).join(", ")}`] : []),
            ].join(" · ")}</small>}{trigger.lastInvokedAt && <small>Last Signed Delivery {when(trigger.lastInvokedAt, now)}</small>}</div><code>{endpoint}</code>{revealed && <div className="automation-trigger-secret" role="status"><strong>Copy this signing secret now. It will not be shown again.</strong><code>{revealed.secret}</code><button className="btn ghost sm" type="button" onClick={() => void navigator.clipboard.writeText(revealed.secret)}>Copy Secret</button><button className="btn ghost sm" type="button" onClick={() => setCredential(null)}>Hide</button></div>}<p>{policy
              ? `Signed body may add: ${[policy.allowPrompt ? "prompt" : "", policy.parameterNames.length ? "parameters" : "", policy.sessionSelectors?.length ? "target" : ""].filter(Boolean).join(", ")}.`
              : trigger.kind === "chatops" ? 'Signed body: {"eventId":"...","command":"run","sender":"opaque actor"}' : 'Signed body: {"eventId":"..."}'}</p><div className="automation-trigger-actions"><button className="btn ghost sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Rotate Signing Secret", message: `The previous signing secret for “${automation.name}” stops working immediately. This cannot be undone.`, confirmLabel: "Rotate Secret", tone: "danger" })) rotateTrigger(trigger.triggerId); })()}>Rotate Secret</button><button className="btn ghost danger sm" disabled={busy} onClick={() => void (async () => { if (await confirm({ title: "Revoke Signed Trigger", message: `The signed trigger for “${automation.name}” is revoked, and its pending unclaimed deliveries are rejected.`, confirmLabel: "Revoke Trigger", tone: "danger" })) revokeTrigger(trigger.triggerId); })()}>Revoke</button></div></div>;
          })}<p className="automation-hint">Send <code>application/vnd.wollipog.automation-trigger+json</code> with X-Wollipog-Timestamp, X-Wollipog-Nonce, and X-Wollipog-Signature. Every optional field must be explicitly allowed by this fixed automation trigger; deliveries cannot change agents, runners, policies, or ceilings.</p></div>}
        </section>

        <section className="section" aria-labelledby="automation-history">
          <div className="section-head"><h2 className="section-title" id="automation-history">Run History</h2></div>
          {executions.length === 0 ? <p className="automation-empty">No runs yet.</p> : (
            <details className="automation-history" ref={historyRef}><summary>{executions.length === 1 ? "Show 1 Run" : `Show ${executions.length} Runs`}</summary><div className="automation-history-list">{executions.map((execution) => <div className="automation-execution" key={execution.executionId}><div><strong>{titleCaseLabel(execution.status)}</strong><span>{when(execution.scheduledFor, now)}</span></div><code>{execution.idempotencyKey}</code>{execution.triggerDelivery && <small>Delivered Fields: {deliverySummary(execution.triggerDelivery)}{execution.triggerDelivery.promptSha256 ? ` · Prompt Digest ${execution.triggerDelivery.promptSha256.slice(0, 12)}…` : ""}</small>}{execution.commands?.length ? <ul className="automation-command-list" aria-label="Durable Runner Command Receipts">{execution.commands.map((command) => <li key={command.commandId}><span>{titleCaseLabel(command.kind.replace("_", " "))} · {titleCaseLabel(command.state)}</span><small>{command.attemptCount} delivery attempt{command.attemptCount === 1 ? "" : "s"}</small>{command.lastError && <em>{command.lastError}</em>}</li>)}</ul> : execution.deliveryMode === "legacy_at_most_once" ? <small className="automation-legacy-delivery">Legacy At-Most-Once Delivery</small> : null}{execution.error && <p>{execution.error}</p>}{execution.sessionId && <button className="btn sm ghost" type="button" onClick={() => openSession(execution.sessionId!)}>Open Session</button>}</div>)}</div></details>
          )}
        </section>
      </div>
    </div>
  );
}
