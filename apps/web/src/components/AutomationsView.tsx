import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AutomationAction, AutomationSchedule, RunnerView, WorkflowDefinition } from "@wollipog/protocol";
import { agentDisplayName } from "../agent-presentation.js";
import { useApi } from "../api-context.js";
import { describeSchedule, specOf } from "../automation-form.js";
import { automationInstallationUnavailable, resolvedInstallationAgentId } from "../automation-installations.js";
import { formatCalendarTime } from "../format.js";
import { destination, type AutomationsTab } from "../navigation.js";
import { sessionDisplayTitle } from "../session-title.js";
import { statusMeta } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { AutomationsIcon, BotIcon, InboxIcon, NextRunIcon, RunsIcon, ScheduleIcon } from "./Icons.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { Notice } from "./Notice.js";
import { OutboundEventSubscriptions } from "./OutboundEventSubscriptions.js";
import { PageHeader } from "./PageHeader.js";
import { StaleContent } from "./StaleContent.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { TabList } from "./Tabs.js";
import { Switch } from "./ui/SettingsRows.js";
import { useAutomationPolling } from "./useAutomationPolling.js";

/** What `actionTarget` names a target by. Each lookup answers undefined for what it doesn't know. */
export interface TargetNames {
  runners: ReadonlyMap<string, RunnerView>;
  sessionTitle: (sessionId: string) => string | undefined;
  workflowName: (workflowId: string) => string | undefined;
}

/**
 * What an automation runs, as its list row names it (#2969): the agent, the workflow or the session,
 * by display name with its icon, and never an id. A target the lookups can't name reads as its kind.
 */
export function actionTarget(action: AutomationAction, names: TargetNames): { icon: ReactNode; label: string } {
  if (action.kind === "prompt_session") {
    return { icon: <InboxIcon size={14} aria-hidden="true" />, label: names.sessionTitle(action.sessionId) ?? "Session" };
  }
  if (action.kind === "workflow_run") {
    return { icon: <RunsIcon size={14} aria-hidden="true" />, label: names.workflowName(action.request.workflowId) ?? "Workflow" };
  }
  // The agent the scheduler starts: a saved installation's agent wherever discovery now lists it,
  // else the stored agent (as `actionSentence` names it).
  const runner = names.runners.get(action.request.runnerId);
  const saved = action.installationBindings?.agent;
  const agentId = saved ? resolvedInstallationAgentId(runner, saved) : action.request.agentId;
  const agent = agentId === undefined ? undefined : runner?.agents.find((candidate) => candidate.id === agentId);
  return {
    icon: <BotIcon size={14} aria-hidden="true" />,
    // Namesakes are told apart by version or where they run, never by a path or an id.
    label: agent && runner ? agentDisplayName(agent, runner.agents, { identifiers: false }) : "Agent",
  };
}

/** Scheduled automations by their next run, soonest first; one without a next run goes last. */
function byNextRun(a: AutomationSchedule, b: AutomationSchedule): number {
  return (a.nextFireAt ?? Number.POSITIVE_INFINITY) - (b.nextFireAt ?? Number.POSITIVE_INFINITY);
}

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One automation (#2969, docs/design-system.md §5.2): a two-line row whose one open target is the
 * name, its one badge and its meta, and beside it an Enabled switch that saves at once. On a phone
 * line 2 keeps one whole fact: the next run while it is scheduled, the schedule while paused.
 */
function AutomationRow({ item, now, zone, names, workflows, toggling, onOpen, onToggle }: {
  item: AutomationSchedule;
  now: number;
  zone: string | undefined;
  names: TargetNames;
  workflows: readonly WorkflowDefinition[];
  toggling: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const titleId = `${useId().replace(/:/g, "")}-title`;
  const schedule = describeSchedule(item.cron, item.timezone, now, { viewerTimeZone: zone });
  const nextRun = item.nextFireAt !== undefined ? formatCalendarTime(item.nextFireAt, now, zone) : schedule.nextLabel;
  const next = item.enabled ? nextRun && `Next ${nextRun}` : "Paused";
  const target = actionTarget(item.action, names);
  const badge = item.latestExecution?.status === "failed" ? "last_run_failed"
    : item.targetHealth || automationInstallationUnavailable(item, names.runners, workflows) ? "target_unavailable"
      : null;
  return (
    <div className="row row-2 automation-row" data-automation-id={item.automationId}
      data-phone-fact={next && item.enabled ? "next" : "schedule"}>
      <button type="button" className="automation-row-open" onClick={onOpen}>
        <span className="row-body">
          <span className="row-line">
            <span className="row-title" id={titleId} title={item.name}>{item.name}</span>
            {badge && <StatusBadge meta={statusMeta("automation", badge)} />}
          </span>
          <span className="row-sub automation-row-meta">
            <span className="automation-row-schedule">
              <ScheduleIcon size={14} aria-hidden="true" /><span>{schedule.label}</span>
            </span>
            {next && (
              <span className="automation-row-next"><NextRunIcon size={14} aria-hidden="true" /><span>{next}</span></span>
            )}
            <span className="automation-row-target">{target.icon}<span>{target.label}</span></span>
          </span>
        </span>
      </button>
      <span className="automation-row-trail">
        <Switch
          label="Enabled"
          describedBy={titleId}
          checked={item.enabled}
          busy={toggling}
          className="ui-switch-standalone automation-row-switch"
          onChange={onToggle}
        />
      </span>
    </div>
  );
}

/**
 * The workflow definitions, for a workflow target's name and its roles' installations: loaded once
 * while the list holds a workflow action, and again only when it names a workflow not yet loaded, so
 * the list's poll stays one request. Until they arrive, and if they fail, a workflow reads as its kind.
 */
function useWorkflowNames(items: readonly AutomationSchedule[]): WorkflowDefinition[] {
  const api = useApi();
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const missing = useMemo(() => [...new Set(items.flatMap((item) => item.action.kind === "workflow_run"
    ? [item.action.request.workflowId] : []))]
    .filter((workflowId) => !workflows.some((workflow) => workflow.workflowId === workflowId))
    .sort().join("\n"), [items, workflows]);
  // A workflow the last load did not have is asked for once, not on every poll.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const wanted = missing ? missing.split("\n").filter((workflowId) => !asked.current.has(workflowId)) : [];
    if (!wanted.length) return;
    let current = true;
    void api.workflowDefinitions().then((result) => {
      if (!current) return;
      for (const workflowId of wanted) asked.current.add(workflowId);
      setWorkflows(result);
    }, () => {
      if (current) for (const workflowId of wanted) asked.current.add(workflowId);
    });
    return () => { current = false; };
  }, [api, missing]);
  return workflows;
}

function ListSkeleton() {
  return (
    <div className="surface automation-skeleton" role="status">
      <span className="sr-only">Loading automations…</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div className="row row-2" aria-hidden="true" key={index}>
          <span className="row-body">
            <span className="skeleton-bar title" />
            <span className="skeleton-bar" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function AutomationsView() {
  const api = useApi();
  const automationsDestination = destination("automations");
  const view = useStoreSelector((state) => state.view);
  const tab: AutomationsTab | undefined = view.name === "automations" ? view.tab : undefined;
  const projects = useStoreSelector((state) => state.projects);
  const runners = useStoreSelector((state) => state.runners);
  const sessions = useStoreSelector((state) => state.sessions);
  const conn = useStoreSelector((state) => state.conn);
  const snapshotLoaded = useStoreSelector((state) => state.snapshotLoaded);
  const { navigate } = useStoreActions();
  const [items, setItems] = useState<AutomationSchedule[]>([]);
  /** The list has been read once; before that an empty list proves nothing (§12). */
  const [listLoaded, setListLoaded] = useState(false);
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set());
  // Outbound Events' New Subscription, which this header's primary opens on that tab (#2973), and
  // whether the tab shows its empty state, which offers New Subscription itself.
  const [newSubscriptionOpen, setNewSubscriptionOpen] = useState(false);
  const [outboundEmpty, setOutboundEmpty] = useState(false);
  useEffect(() => { if (tab !== "outbound") setNewSubscriptionOpen(false); }, [tab]);

  // The list alone, one request per poll: each automation's history and triggers are read by its
  // own page, and its last run's outcome comes with the list (`latestExecution`).
  const load = useCallback(async (current: () => boolean) => {
    const result = await api.automations();
    if (!current()) return;
    setItems(result.automations);
    setListLoaded(true);
  }, [api]);
  const { error, mutate, retry } = useAutomationPolling(load);
  const workflows = useWorkflowNames(items);
  const now = useTimelineClock(items.length > 0);
  const zone = useMemo(viewerTimeZone, []);

  const names: TargetNames = useMemo(() => ({
    runners,
    sessionTitle: (sessionId) => {
      const title = sessions.get(sessionId)?.title;
      return title ? sessionDisplayTitle(title) || undefined : undefined;
    },
    workflowName: (workflowId) => workflows.find((workflow) => workflow.workflowId === workflowId)?.name,
  }), [runners, sessions, workflows]);

  const scheduled = useMemo(() => items.filter((item) => item.enabled).sort(byNextRun), [items]);
  const paused = useMemo(() => items.filter((item) => !item.enabled), [items]);

  // A toggled row moves to the other group, which mounts it again; the switch it was on keeps focus
  // once the list shows the row in its new state. Focus the person moved elsewhere is left alone.
  const listRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ automationId: string; enabled: boolean } | null>(null);
  useLayoutEffect(() => {
    const pending = refocus.current;
    const list = listRef.current;
    if (!pending || !list) return;
    if (items.find((item) => item.automationId === pending.automationId)?.enabled !== pending.enabled) return;
    refocus.current = null;
    const active = list.ownerDocument.activeElement;
    if (active && active !== list.ownerDocument.body) return;
    [...list.querySelectorAll<HTMLElement>(".automation-row")]
      .find((row) => row.dataset.automationId === pending.automationId)
      ?.querySelector<HTMLElement>(".automation-row-switch")?.focus();
  }, [items]);

  const toggle = (item: AutomationSchedule) => {
    const automationId = item.automationId;
    const active = listRef.current?.ownerDocument.activeElement;
    if (active?.closest(".automation-row")?.getAttribute("data-automation-id") === automationId) {
      refocus.current = { automationId, enabled: !item.enabled };
    }
    setToggling((previous) => new Set(previous).add(automationId));
    void mutate(
      () => api.updateAutomation(automationId, { ...specOf(item), enabled: !item.enabled }),
      item.enabled ? "Automation Not Paused" : "Automation Not Resumed",
    ).then((saved) => {
      // Nothing moves after a failed change, so nothing waits to take focus.
      if (!saved && refocus.current?.automationId === automationId) refocus.current = null;
      setToggling((previous) => {
        const next = new Set(previous);
        next.delete(automationId);
        return next;
      });
    });
  };

  const openNewAutomation = () => navigate({ name: "automations", editor: { kind: "new" } });
  const selectTab = (next: AutomationsTab | undefined) => {
    if (next !== tab) navigate(next ? { name: "automations", tab: next } : { name: "automations" });
  };

  // §12, in order: offline, loading, error, empty, content. Before the first snapshot a connection
  // that is still connecting is the first load, not a lost one.
  const reconnecting = conn === "offline" || (snapshotLoaded && conn !== "online");
  const loadFailed = error?.source === "poll" || error?.source === "refresh" ? error : null;
  const empty = !reconnecting && listLoaded && !loadFailed && items.length === 0;

  const group = (label: string, rows: readonly AutomationSchedule[]) => rows.length > 0 && (
    <section className="automation-group" aria-label={label}>
      <h2 className="group-label">{label}<span className="count">{rows.length}</span></h2>
      <div className="surface">
        {rows.map((item) => (
          <AutomationRow
            key={item.automationId}
            item={item}
            now={now}
            zone={zone}
            names={names}
            workflows={workflows}
            toggling={toggling.has(item.automationId)}
            onOpen={() => navigate({ name: "automation", id: item.automationId })}
            onToggle={() => toggle(item)}
          />
        ))}
      </div>
    </section>
  );

  // One wrapper for the groups whether or not they are stale, so they keep their spacing (§12.5).
  const groups = (stale: boolean) => (
    <StaleContent stale={stale} className="automation-groups">{group("Scheduled", scheduled)}{group("Paused", paused)}</StaleContent>
  );

  let body: ReactNode;
  if (reconnecting) {
    // The last-known rows stay, dimmed and still openable, under one line that says why (§12.5).
    // Never an empty state.
    body = (
      <>
        <Notice compact tone="neutral" role="status">Reconnecting…</Notice>
        {items.length > 0 && groups(true)}
      </>
    );
  } else if (!listLoaded && !loadFailed) {
    body = <ListSkeleton />;
  } else if (empty) {
    body = (
      <State
        icon={<AutomationsIcon />}
        title={`No ${destination("automations").name} Yet`}
        // This screen exposed an `h3` before the conversion, and heading navigation is how a
        // screen-reader user finds a section. Losing it is not a styling change.
        headingLevel={3}
        actions={<button type="button" className="btn primary" onClick={openNewAutomation}>New Automation</button>}
      >
        Run an agent every weekday morning, or whenever a webhook fires.
      </State>
    );
  } else {
    // A failed read says so above the rows it could not refresh; with nothing read yet it is the
    // whole content (§12.4).
    body = (
      <>
        {loadFailed && (
          <Notice
            tone="danger"
            title="Couldn't Load Automations"
            role="alert"
           
            actions={<button type="button" className="btn sm" onClick={retry}>Retry</button>}
            details={<pre className="code-well">{loadFailed.message}</pre>}
          >
            Retry to load the list again.
          </Notice>
        )}
        {items.length > 0 && groups(false)}
      </>
    );
  }

  return (
    <section className="page">
      {/* Each tab brings its own primary, and an empty tab's state owns its one create action, so
          the header offers none beside it (§4.2, §12.1). */}
      <PageHeader
        title={destination("automations").name}
        description={destination("automations").description}
        primary={tab === undefined
          ? (!empty ? { label: "New Automation", onClick: openNewAutomation } : undefined)
          : (!outboundEmpty ? { label: "New Subscription", onClick: () => setNewSubscriptionOpen(true) } : undefined)}
        tabs={(
          <TabList label={automationsDestination.name} onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
            {([[undefined, "Automations", "list"], ["outbound", "Outbound Events", "outbound"]] as const).map(([id, label, key]) => (
              <button
                key={key}
                id={`automations-${key}-tab`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`automations-${key}-panel`}
                tabIndex={tab === id ? 0 : -1}
                className="tab"
                onClick={() => selectTab(id)}
              >
                {label}
              </button>
            ))}
          </TabList>
        )}
      />
      {tab === "outbound" ? (
        <div id="automations-outbound-panel" role="tabpanel" aria-labelledby="automations-outbound-tab">
          <OutboundEventSubscriptions
            projects={[...projects.values()]}
            automations={items}
            creating={newSubscriptionOpen}
            onCreatingChange={setNewSubscriptionOpen}
            onEmptyChange={setOutboundEmpty}
          />
        </div>
      ) : (
        <div id="automations-list-panel" role="tabpanel" aria-labelledby="automations-list-tab"
          className="automation-list" ref={listRef}>
          {error?.source === "mutation" && (
            <Notice tone="danger" title={error.action} role="alert">{error.message}</Notice>
          )}
          {body}
        </div>
      )}
    </section>
  );
}
