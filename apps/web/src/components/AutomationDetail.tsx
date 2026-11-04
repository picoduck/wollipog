import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationExecution,
  AutomationSchedule,
  AutomationTriggerKind,
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
import { formatCalendarTime } from "../format.js";
import { absoluteViewUrl, backLabel, viewTitle, type View } from "../navigation.js";
import { timeZoneDisplayName } from "../reminder-schedule.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import { machineOptionLabels } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { AutomationRunHistory, RunDetailsDialog } from "./AutomationRunHistory.js";
import { AutomationTriggers } from "./AutomationTriggers.js";
import { useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { EditIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { DetailBar, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { useAutomationPolling } from "./useAutomationPolling.js";
import { useIsMobile } from "./useIsMobile.js";
import { useRemovedFocus } from "./useRemovedFocus.js";

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

type Stored =
  | { state: "loading" }
  | { state: "loaded"; automation: AutomationSchedule; executions: AutomationExecution[] }
  | { state: "missing" };

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
  /** The kind New Trigger is open for: Add Trigger and the bar's ⋯ both open it. */
  const [newTriggerKind, setNewTriggerKind] = useState<AutomationTriggerKind | null>(null);
  /** The run whose Run Details is open, by id, so the dialog follows that run through each poll. */
  const [detailsRunId, setDetailsRunId] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Focus after an action (§16.1). An action names where focus goes once it settles; it moves there
  // only while focus is still on the control that started it, or was lost (that control left the
  // page, or the clipboard fallback took it). Anywhere else, the person has moved on and keeps it.
  // A commit that removes the focused control without such an action (Retry's placeholder giving way
  // to the page) hands focus to the page title. The menu and confirmation portals count as the page.
  const pageRef = useRef<HTMLDivElement>(null);
  const removedFocus = useRemovedFocus(pageRef, '[role="menu"], .feedback-confirmation');
  const pendingFocus = useRef<{ invoker: Element | null; target: () => HTMLElement | null } | null>(null);
  /** Actions that will still settle focus: a control their own commit removes is theirs to place. */
  const actionsInFlight = useRef(0);
  const [, setFocusRevision] = useState(0);
  const inPage = (selector: string) => pageRef.current?.querySelector<HTMLElement>(selector) ?? null;
  const pageTitleElement = () => inPage("#page-title");
  const moreTrigger = () => inPage('.detail-bar button[aria-label="More Actions"]');
  /** Starts an action that settles focus later; answers the control that started it. */
  const beginAction = (): Element | null => {
    actionsInFlight.current += 1;
    return document.activeElement;
  };
  const settleFocus = (invoker: Element | null, target: () => HTMLElement | null) => {
    actionsInFlight.current = Math.max(0, actionsInFlight.current - 1);
    if (!mounted.current) return;
    pendingFocus.current = { invoker, target };
    setFocusRevision((revision) => revision + 1);
  };
  useLayoutEffect(() => {
    const removed = removedFocus();
    const doc = pageRef.current?.ownerDocument ?? document;
    const active = doc.activeElement;
    const lost = !active || active === doc.body || !active.isConnected;
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    if (pending) {
      // The page title is the rescue anchor (§16.1): a confirmation that closes while its opener is
      // busy-disabled parks focus there. That was not the person's move, so the action still places it.
      if (!lost && active !== pending.invoker && active !== pageTitleElement()) return;
      const invoker = pending.invoker instanceof HTMLElement && pending.invoker.isConnected ? pending.invoker : null;
      (pending.target() ?? invoker ?? pageTitleElement())?.focus();
      return;
    }
    if (removed && actionsInFlight.current === 0) pageTitleElement()?.focus();
  });

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

  const { busy, error, mutate, retry, reread } = useAutomationPolling(load);

  const automation = stored.state === "loaded" ? stored.automation : null;
  useReportEntityTitle({ name: "automation", id: automationId }, automation?.name);

  // A run that leaves the history (deleted with its automation, or past the listed fifty) closes its
  // Run Details for good, rather than reopening should it come back.
  useEffect(() => {
    if (detailsRunId === null || stored.state === "loading") return;
    if (stored.state === "missing" || !stored.executions.some((execution) => execution.executionId === detailsRunId)) {
      setDetailsRunId(null);
    }
  }, [stored, detailsRunId]);

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
      <div className="run-detail automation-detail" ref={pageRef}>
        <DetailBar title={viewTitle(pageView)} backLabel={backLabel("automations")} onBack={toList} />
        {placeholder.variant === "loading" ? (
          <div className="skeleton automation-glance-skeleton" role="status" aria-live="polite">
            <span className="sr-only">Loading automation…</span>
            {[0, 1, 2].map((index) => <span key={index} aria-hidden="true" className="skeleton-bar title" />)}
          </div>
        ) : (
          <State
            variant={placeholder.variant}
            pageLevel
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
    latest?.status === "ceiling_paused" ? "last_run_ceiling_paused" : lastRunFailed ? "last_run_failed" : automation.enabled ? "enabled" : "paused")} />;
  const primaryRunnerId = automation.action.kind === "prompt_session"
    ? sessions.get(automation.action.sessionId)?.runnerId
    : automation.action.request.runnerId;
  const primaryMachine = primaryRunnerId === undefined ? undefined : machineLabel(primaryRunnerId);
  const nextRunWords = automation.nextFireAt !== undefined ? when(automation.nextFireAt, now) : schedule.nextLabel;
  const installationUnavailable = automationInstallationUnavailable(automation, runners, workflows);

  const edit = () => navigate({ name: "automations", editor: { kind: "edit", automationId } });
  const openSession = (sessionId: string) => navigate({ name: "session", id: sessionId });
  const openView = (view: View) => navigate(view);
  const detailsRun = detailsRunId === null ? undefined
    : executions.find((execution) => execution.executionId === detailsRunId);

  // Where focus lands once a revoked trigger's row, and the ⋯ it was revoked from, are gone.
  const triggersHeading = () => inPage("#automation-triggers");
  /** The bar's Pause or Resume, or ⋯ where it lives on a phone. */
  const pauseControl = () => inPage(".detail-bar .detail-bar-action:not(.primary)") ?? moreTrigger();

  const togglePause = () => {
    const invoker = beginAction();
    void mutate(
      () => api.updateAutomation(automationId, { ...specOf(automation), enabled: !automation.enabled }),
      automation.enabled ? "Automation Not Paused" : "Automation Not Resumed",
    ).finally(() => settleFocus(invoker, pauseControl));
  };

  // A revoked trigger's row goes at once, with the ⋯ focus came back to, and the page reads its
  // triggers again; focus moves to the Triggers heading.
  const triggerRevoked = (triggerId: string) => {
    const invoker = beginAction();
    setTriggers((current) => current.filter((trigger) => trigger.triggerId !== triggerId));
    void reread();
    settleFocus(invoker, triggersHeading);
  };

  const remove = async (back?: ConfirmationOptions["back"]) => {
    // ⋯ has handed focus back to its trigger before calling this.
    const invoker = beginAction();
    const count = triggers.length;
    const withTriggers = count === 0 ? "" : `, with its ${count} ${count === 1 ? "trigger" : "triggers"}`;
    const name = automation.name;
    if (!await confirm({
      title: "Delete Automation",
      message: `“${name}” stops running and is removed${withTriggers}. Its run history is kept.`,
      confirmLabel: "Delete Automation",
      tone: "danger",
      ...(back ? { back } : {}),
    })) {
      // Cancel returns to ⋯; on a phone Back has reopened its sheet, and focus is there already.
      settleFocus(invoker, moreTrigger);
      return;
    }
    const deleted = await mutate(() => api.deleteAutomation(automationId), "Automation Not Deleted", { refresh: false });
    if (!deleted) {
      settleFocus(invoker, moreTrigger);
      return;
    }
    actionsInFlight.current = Math.max(0, actionsInFlight.current - 1);
    showToast(`“${name}” deleted.`, { tone: "success" });
    // Left while the delete ran: the toast says it happened, and where they went is theirs. The
    // list's route takes focus to its title.
    if (mounted.current) navigate({ name: "automations" }, { replace: true });
  };

  const linkUrl = publicOrigin ? absoluteViewUrl(publicOrigin, pageView) : null;
  const copyLink = async () => {
    if (!linkUrl) return;
    // ⋯ has handed focus back to its trigger. A refused write falls back to a selected field only
    // while the copy still owns the interaction: the page is mounted and focus is on that trigger or
    // nowhere. Anything opened or focused since (another action, the trigger form) keeps focus.
    const invoker = beginAction();
    const doc = document;
    const owns = () => mounted.current &&
      (doc.activeElement === null || doc.activeElement === doc.body || doc.activeElement === invoker);
    const copied = await writeClipboardText(linkUrl, owns);
    // The fallback's selection dropped focus; it goes back to ⋯ unless the person moved on.
    settleFocus(invoker, moreTrigger);
    if (copied === null) return;
    if (copied) showToast("Link copied.", { tone: "success" });
    else showToast("Couldn't copy the link.", { tone: "error" });
  };

  const backTo = (choice: ActionsMenuChoice) => ({ label: BACK_TO_MORE_ACTIONS, run: choice.reopen });
  const pauseLabel = automation.enabled ? "Pause" : "Resume";
  const menu: PageMenuAction[] = [
    // On a phone the bar holds only the pencil and ⋯, so Pause and Resume move here (§15.1).
    ...(phone ? [{ label: pauseLabel, disabled: busy, onClick: togglePause }] : []),
    { label: "Add Webhook Trigger…", disabled: busy, onClick: () => setNewTriggerKind("webhook") },
    { label: "Add Chat-Ops Trigger…", disabled: busy, onClick: () => setNewTriggerKind("chatops") },
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
            <button type="button" className="btn sm ghost" onClick={() => setDetailsRunId(latest.executionId)}>Run Details</button>
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
    <div className="run-detail automation-detail" ref={pageRef}>
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

        <AutomationTriggers
          automation={automation}
          triggers={triggers}
          publicOrigin={publicOrigin}
          now={now}
          disabled={busy}
          adding={newTriggerKind}
          onAddingChange={setNewTriggerKind}
          onChanged={() => void reread()}
          onRevoked={triggerRevoked}
        />

        <section className="section" aria-labelledby="automation-history">
          <div className="section-head"><h2 className="section-title" id="automation-history">Run History</h2></div>
          <AutomationRunHistory
            executions={executions}
            now={now}
            nextRun={automation.enabled ? nextRunWords : null}
            policy={automation.runnerPolicy}
            onOpen={openView}
            onDetails={setDetailsRunId}
          />
        </section>
      </div>
      {detailsRun && (
        <RunDetailsDialog
          execution={detailsRun}
          now={now}
          policy={automation.runnerPolicy}
          machineLabel={machineLabel}
          onOpen={openView}
          onClose={() => setDetailsRunId(null)}
        />
      )}
    </div>
  );
}
