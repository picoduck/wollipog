import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  BoxView,
  RunnerView,
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageAmount,
  UsageDailyBudgetPolicy,
  UsageRetentionPolicy,
  UserCostWindows,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { agentDisplayName } from "../agent-presentation.js";
import { runnerDisplay } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { StatusBadge } from "./StatusBadge.js";
import { useHasStore, useOptionalNavigate, useOptionalStoreSelector, useStoreSelector } from "../store.js";
import {
  PERIOD_ROWS_SHOWN,
  activeDrivers,
  agentBreakdown,
  breakdownRows,
  buildColumns,
  coverageMessages,
  coverageNeedsRates,
  coverageSentence,
  coverageTitle,
  dailyBudgetReached,
  driverRows,
  formatCompactTokens,
  formatMetric,
  formatMoney,
  formatShare,
  metricValue,
  periodLabel,
  processedTokens,
  ratesRefreshProblem,
  todaySpendUsd,
  usageDriverLabels,
  usageIsEmpty,
  usageWindowCaption,
  type BreakdownRow,
  type RatesRefreshProblem,
  type UsageAgentCandidate,
  type UsageBreakdownTab,
  type UsageMetric,
} from "../usage-view-model.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { SegmentedControl, type SegmentedOption } from "./ui/ChoiceControls.js";
import { SeriesSwatch, UsageChart } from "./UsageChart.js";
import { PageHeader } from "./PageHeader.js";
import { destination, type UsageTab } from "../navigation.js";
import { safeExternalHref } from "../external-href.js";
import { CountBadge } from "./CountBadge.js";
import { Spinner } from "./common.js";
import { ChevronDownIcon, RefreshIcon, UsageIcon } from "./Icons.js";
import { SubscriptionsTab, useSubscriptionUsage } from "./SubscriptionsTab.js";
import { InfoPopover } from "./InfoPopover.js";
import { ListFoot } from "./ListFoot.js";
import { handleRovingChoiceKeyDown, useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuNote, MenuSurface } from "./Menu.js";
import { TabList } from "./Tabs.js";
import { MOBILE_BREAKPOINT_PX, useIsMobile } from "./useIsMobile.js";
import { useColumnAtLeast } from "./usePanelWidth.js";
import { BudgetHistoryDialog } from "./BudgetHistoryDialog.js";
import { Notice } from "./Notice.js";
import { StaleContent } from "./StaleContent.js";
import { State, useSnapshotState } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";

const RANGES = [7, 30, 90, 365] as const;
/** §12.3: a first load shows nothing for 300ms, so a quick answer never flashes a skeleton. */
export const USAGE_SKELETON_DELAY_MS = 300;
/** The skeleton's chart columns: one per day of the default range. */
const SKELETON_COLUMNS = 30;
const LEGACY_USAGE_GRANULARITIES: readonly UsageAggregationGranularity[] = ["hour", "day"];
const WEEK_CHECKING_REASON = "Checking whether this version of Wollipog supports weekly aggregation.";
const WEEK_CHECK_FAILED_REASON = "Weekly availability could not be checked. Retry by choosing a range.";
const WEEK_UPGRADE_NOTE = "Week grouping needs a newer version of Wollipog.";
const GRANULARITY_LABEL: Record<UsageAggregationGranularity, { noun: string; adjective: string }> = {
  hour: { noun: "Hour", adjective: "Hourly" },
  day: { noun: "Day", adjective: "Daily" },
  week: { noun: "Week", adjective: "Weekly" },
};

/** "Mon D, YYYY" in UTC, the zone every bucket on the page is cut in. */
function coverageDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The desktop toolbar wants about 710px of main column (about 745px in CI's DejaVu Sans at "Last 365
 * Days"). A column no wider than a phone gets the phone's toolbar, so a desktop column a docked panel
 * narrows keeps every control on one row (#4029).
 */
const USAGE_TOOLBAR_MIN_COLUMN_PX = MOBILE_BREAKPOINT_PX + 1;

/** A range in the Range menu and the compact toolbar's Range and Group By menu: "Last 30 Days". */
interface RangeChoice {
  range: number;
  /** Set on a range that allows Hour: "Hour grouping is available for ranges up to 14 days." */
  description?: string;
}

/**
 * The toolbar's menu buttons (§4.7, §9.1): Range on desktop, and in a main column no wider than a
 * phone the one button that opens Range and Group By, as a sheet on phones. Its items are radio
 * rows; a choice applies at once.
 */
function UsageMenuButton({ label, ariaLabel, menuLabel, disabled, title, keepOpen = false, children }: {
  label: string;
  ariaLabel: string;
  menuLabel: string;
  disabled?: boolean;
  title?: string;
  /** The Range and Group By menu stays open after a choice, so its other section can be set too
   * and the button behind it answers both (§15.1, as the Board's Filters sheet does). */
  keepOpen?: boolean;
  children: (choose: (apply: () => void) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "usage-menu", "item", { reachUnavailable: true });
  const choose = (apply: () => void) => {
    if (!keepOpen) {
      menu.close(false);
      menu.triggerRef.current?.focus();
    }
    apply();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <span>{label}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={menuLabel}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {children(choose)}
        </MenuSurface>
      )}
    </>
  );
}

/**
 * The first load's placeholder (§12.3, #3016): the overview's own layout, a headline figure and
 * three legend lines beside the chart's columns, under the one status line that says what is coming.
 */
function UsageSkeleton() {
  return (
    <>
      <p className="usage-status-line" role="status">Loading usage…</p>
      <div className="usage-overview" aria-hidden="true">
        <div className="usage-headline">
          <span className="skeleton-bar usage-skeleton-figure" />
          <span className="skeleton-bar usage-skeleton-caption" />
          <div className="usage-skeleton-legend">
            {Array.from({ length: 3 }, (_, index) => <span className="skeleton-bar" key={index} />)}
          </div>
        </div>
        <div className="usage-skeleton-chart">
          {Array.from({ length: SKELETON_COLUMNS }, (_, index) => <span className="skeleton-bar" key={index} />)}
        </div>
      </div>
    </>
  );
}

/** Reports the offline Machines the viewer can see, by the names people gave them. Mounted only
 * under a store; a standalone render (tests, harness pages) has no fleet and shows no machine notice. */
function OfflineMachineWatcher({ onNames }: { onNames: (names: string[]) => void }) {
  const runners = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const names = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return [...runners.values()]
      .filter((runner) => runner.status === "offline")
      .map((runner) => runnerDisplay(runner, boxByRunner.get(runner.runnerId), runner.runnerId).name)
      .sort((left, right) => left.localeCompare(right));
  }, [runners, boxes]);
  useEffect(() => onNames(names), [names, onNames]);
  return null;
}

interface UsageNames {
  model: (id: string) => string;
  agent: (id: string) => string;
  machine: (id: string) => string;
}

/**
 * The names people gave what the plane reports by id (#3013): a model's catalog display name, an
 * agent's name from the runners that list it, and a machine's name. Without a store (a harness
 * page) or for an id no runner lists, the id itself.
 */
function usageNames(runners: ReadonlyMap<string, RunnerView> | undefined, boxes: ReadonlyMap<string, BoxView> | undefined): UsageNames {
  const fleet = [...(runners?.values() ?? [])];
  const boxByRunner = new Map([...(boxes?.values() ?? [])].map((box) => [box.runnerId, box]));
  const models = new Map<string, string>();
  for (const runner of fleet) {
    for (const agent of runner.agents) {
      for (const model of agent.capabilities?.models ?? []) {
        if (model.displayName && !models.has(model.id)) models.set(model.id, model.displayName);
      }
    }
  }
  return {
    model: (id) => id === "unknown" ? "Unknown Model" : models.get(id) ?? id,
    agent: (id) => {
      if (id === "unassigned") return "Unassigned";
      for (const runner of fleet) {
        const agent = runner.agents.find((candidate) => candidate.id === id);
        if (agent) return agentDisplayName(agent, runner.agents);
      }
      return id;
    },
    machine: (id) => runnerDisplay(runners?.get(id), boxByRunner.get(id), id).name,
  };
}

function useUsageNames(): UsageNames {
  const runners = useOptionalStoreSelector((state) => state.runners);
  const boxes = useOptionalStoreSelector((state) => state.boxes);
  return useMemo(() => usageNames(runners, boxes), [runners, boxes]);
}

/** The agents the viewer's Machines advertise, so ACP usage can be named by its agent. None
 * without a store (a harness page). */
function useUsageAgents(): UsageAgentCandidate[] {
  const runners = useOptionalStoreSelector((state) => state.runners);
  return useMemo(() => [...(runners?.values() ?? [])].flatMap((runner) => runner.agents.map((agent): UsageAgentCandidate => ({
    id: agent.id,
    ...(agent.driver ? { driver: agent.driver } : {}),
    name: agentDisplayName(agent, undefined, { identifiers: false }),
  }))), [runners]);
}

/** Tokens or cost in a breakdown row. The active metric's figure is the row's total, beside the name
 * on a phone; the other is line 2's figure, which says its unit there ("3.25M tokens"). */
function FigureCell({ amount, figure, lead }: { amount: UsageAmount; figure: UsageMetric; lead: boolean }) {
  // The plane marks a row unpriced when ANY of its records was; only a row with no priced cost at
  // all says so instead of a figure, and a partly priced one keeps its figure with the reason.
  const unpriced = figure === "cost" && amount.costSource === "unpriced" && amount.costUsd === 0;
  const partial = figure === "cost" && !unpriced && amount.unpricedRecords > 0;
  return (
    <td
      className={`num ${lead ? "cell-status" : "cell-meta cell-dim"}`}
      title={partial ? "Some of this usage could not be priced; its cost is excluded." : undefined}
    >
      {unpriced ? "Unpriced" : figure === "cost" ? formatMoney(amount.costUsd) : formatCompactTokens(processedTokens(amount))}
      {!lead && !unpriced && <span className="usage-cell-unit">{figure === "cost" ? " estimated" : " tokens"}</span>}
    </td>
  );
}

/** By Model, By Agent and By Machine: one comparison of the same shape, named by its tab. */
function DimensionTable({ labelledBy, nameLabel, rows, metric }: {
  labelledBy: string;
  nameLabel: string;
  rows: readonly BreakdownRow[];
  metric: UsageMetric;
}) {
  return (
    <div className="table-wrap usage-table-wrap">
      <table className="table usage-table" aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col" className="col-name">{nameLabel}</th>
            <th scope="col" className="num">Share</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {/* An empty window shows the page's one empty state instead of these tables (#3016). */}
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" title={row.name}>{row.name}</th>
              <td className="num cell-meta cell-dim usage-share">
                <span className="cell-label" aria-hidden="true">Share: </span>{formatShare(row.share)}
              </td>
              <FigureCell amount={row.amount} figure="tokens" lead={metric === "tokens"} />
              <FigureCell amount={row.amount} figure="cost" lead={metric === "cost"} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** By Person: spend over the standard windows, and today's against the daily budget. */
function PersonTable({ users }: { users: readonly UserCostWindows[] }) {
  const reachedMeta = statusMeta("usageBudget", "reached");
  const estimated = users.some((row) => (row.todayEstimateUsd ?? 0) > 0);
  return (
    <>
      <div className="table-wrap usage-table-wrap">
        <table className="table usage-table" aria-labelledby="usage-breakdown-person-tab">
          <thead>
            <tr>
              <th scope="col" className="col-name">Person</th>
              <th scope="col" className="num">Today</th>
              <th scope="col" className="num">Last 7 Days</th>
              <th scope="col" className="num">Last 30 Days</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr><td colSpan={4} className="usage-empty">No one has usage in the last 30 days.</td></tr>
            ) : users.map((row) => {
              const budget = row.dailyBudgetUsd != null && row.dailyBudgetUsd > 0 ? row.dailyBudgetUsd : null;
              const spent = todaySpendUsd(row);
              const reached = dailyBudgetReached(row);
              const includesEstimate = (row.todayEstimateUsd ?? 0) > 0;
              return (
                <tr key={row.userId}>
                  <th scope="row">
                    <span className="usage-person">
                      <PersonalIdentifier value={row.userName} label="User Name" />
                      {reached && <StatusBadge meta={reachedMeta} />}
                    </span>
                  </th>
                  <td
                    className="num cell-meta usage-person-today"
                    title={includesEstimate ? "Includes an estimate for running turns." : undefined}
                  >
                    {formatMoney(spent)}
                    {budget != null && <span className="cell-dim"> of {formatMoney(budget)}</span>}
                    <span className="usage-cell-unit"> today</span>
                    {budget != null && (
                      <span
                        className={reached ? "meter t-warning" : "meter"}
                        role="progressbar"
                        aria-label="Daily Budget Used"
                        aria-valuemin={0}
                        aria-valuemax={budget}
                        aria-valuenow={Math.min(spent, budget)}
                        aria-valuetext={`${formatMoney(spent)} of ${formatMoney(budget)}`}
                      >
                        <span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
                      </span>
                    )}
                  </td>
                  <td className="num cell-meta cell-dim">
                    <span className="cell-label" aria-hidden="true">Last 7 Days: </span>{formatMoney(row.last7DaysUsd)}
                  </td>
                  <td className="num cell-status">
                    <span className="cell-label" aria-hidden="true">Last 30 Days: </span>{formatMoney(row.last30DaysUsd)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {estimated && <p className="usage-headline-note usage-tables-note">Today includes an estimate for running turns.</p>}
    </>
  );
}

/**
 * Usage and Cost (#3010): API Usage at `/usage`, Subscriptions at `/usage/subscriptions`. In the
 * shell the tab is the route and `onSelectTab` navigates; a standalone render keeps it locally.
 */
export function UsageView({ tab: routeTab, onSelectTab, onOpenConnections }: {
  tab?: UsageTab;
  onSelectTab?: (tab: UsageTab | undefined) => void;
  /** The empty Subscriptions tab's Open Connections; without it the link navigates by its href. */
  onOpenConnections?: () => void;
} = {}) {
  const [localTab, setLocalTab] = useState<UsageTab | undefined>(routeTab);
  const tab = onSelectTab ? routeTab : localTab;
  const selectTab = (next: UsageTab | undefined) => {
    if (next === tab) return;
    if (onSelectTab) onSelectTab(next);
    else setLocalTab(next);
  };
  const phone = useIsMobile();
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(null);
  const compactToolbar = !useColumnAtLeast(toolbarElement, USAGE_TOOLBAR_MIN_COLUMN_PX) || phone;
  const api = useApi();
  const hasStore = useHasStore();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [granularity, setGranularity] = useState<UsageAggregationGranularity>("day");
  // The Breakdown tab chooses only the dimension; Group By is the one aggregation control (#3013).
  const [breakdownTab, setBreakdownTab] = useState<UsageBreakdownTab>("time");
  // The range and grouping whose time table shows every row; any other one shows the newest 7.
  const [allPeriodsFor, setAllPeriodsFor] = useState<string | null>(null);
  const [supportedGranularities, setSupportedGranularities] = useState<readonly UsageAggregationGranularity[] | null>(null);
  const [capabilityCheckFailed, setCapabilityCheckFailed] = useState(false);
  const granularityRef = useRef(granularity);
  granularityRef.current = granularity;
  const [data, setData] = useState<UsageAggregationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const daysRef = useRef(days);
  const [knownRetention, setKnownRetention] = useState<UsageRetentionPolicy | null>(null);
  const [hourlyAvailability, setHourlyAvailability] = useState<{
    range: number;
    available: boolean;
  } | undefined>(undefined);
  const [offlineMachines, setOfflineMachines] = useState<string[]>([]);
  // The range the shown response answers, which can trail `days` while the next one loads: the
  // chart spans this range, and the buckets of it before recording started are its Not Recorded band.
  const [dataRange, setDataRange] = useState<number | null>(null);
  const [users, setUsers] = useState<UserCostWindows[] | null>(null);
  const [dailyBudget, setDailyBudget] = useState<UsageDailyBudgetPolicy | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  // Budget and History (#3015): open, and whether Change Budget… opened it at the budget field.
  const [budgetHistory, setBudgetHistory] = useState<{ focusBudget: boolean } | null>(null);
  const subscriptions = useSubscriptionUsage();
  // §12.5: while the control plane is unreachable the last figures stay, dimmed, under Reconnecting…
  const { offline } = useSnapshotState();
  const navigate = useOptionalNavigate();
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [ratesRefreshing, setRatesRefreshing] = useState(false);
  const [ratesProblem, setRatesProblem] = useState<RatesRefreshProblem | null>(null);

  const load = useCallback(async (range: number, requestedGranularity: UsageAggregationGranularity) => {
    const generation = ++requestGeneration.current;
    let handingOffToDay = false;
    setLoading(true);
    setError(null);
    setCapabilityCheckFailed(false);
    setData((current) => current?.granularity === requestedGranularity ? current : null);
    try {
      const next = await api.usage({ days: range, granularity: requestedGranularity });
      if (generation !== requestGeneration.current) return;
      const legacyHourlyFallback = requestedGranularity === "hour" &&
        next.granularity === "day" && next.hourlyDataAvailable === undefined;
      if (next.granularity !== requestedGranularity && !legacyHourlyFallback) {
        throw new Error(`The control plane returned ${next.granularity} usage instead of the requested ${requestedGranularity} aggregation.`);
      }
      setDataRange(range);
      setData(next);
      setKnownRetention(next.retention);
      setSupportedGranularities(next.supportedGranularities ?? LEGACY_USAGE_GRANULARITIES);
      if (next.hourlyDataAvailable !== undefined) {
        setHourlyAvailability({ range, available: next.hourlyDataAvailable });
      }
      if (legacyHourlyFallback) {
        setHourlyAvailability({ range, available: false });
        setGranularity((current) => current === "hour" ? "day" : current);
      }
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      if (requestedGranularity === "hour" && cause instanceof ApiError &&
          cause.code === "USAGE_HOURLY_DATA_UNAVAILABLE") {
        handingOffToDay = true;
        setHourlyAvailability({ range, available: false });
        setGranularity((current) => current === "hour" ? "day" : current);
        return;
      }
      setCapabilityCheckFailed(true);
      setError(cause instanceof Error ? cause.message : "Unable to load usage");
    } finally {
      if (generation === requestGeneration.current && !handingOffToDay) setLoading(false);
    }
  }, [api]);

  // The RANGE changes immediately; the request that follows it does not. Holding an arrow key
  // walks the group, and before this each step queued another aggregation — short enough that a
  // deliberate change still feels instant, long enough that a key repeat coalesces.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(days, granularity), 120);
    return () => window.clearTimeout(timer);
  }, [days, granularity, load]);

  // A first load (nothing to keep on screen) shows its skeleton only after 300ms; a refetch keeps
  // the previous render instead.
  const firstLoad = loading && !data;
  useEffect(() => {
    setShowSkeleton(false);
    if (!firstLoad || offline) return;
    const timer = window.setTimeout(() => setShowSkeleton(true), USAGE_SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [firstLoad, offline]);

  // Back online, the figures kept while disconnected are reloaded: they may be out of date, and a
  // request that failed while the plane was unreachable never said so.
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) void load(daysRef.current, granularityRef.current);
    wasOffline.current = offline;
  }, [offline, load]);

  // Refresh Rates loads a newer rate table so models released since the last fetch are priced from
  // now on, then reloads the window. Nothing already recorded is re-priced.
  const refreshRates = async () => {
    setRatesRefreshing(true);
    setRatesProblem(null);
    try {
      // The plane answers a failed fetch with the rates it still has, not an error: anything but a
      // fresh table means the refresh didn't take.
      const { pricing } = await api.refreshUsagePricing();
      setRatesProblem(ratesRefreshProblem(pricing));
    } catch (cause) {
      setRatesProblem({
        summary: "Rates couldn't be refreshed.",
        details: [cause instanceof Error ? cause.message : "Unable to refresh rates"],
      });
      setRatesRefreshing(false);
      return;
    }
    try {
      await load(daysRef.current, granularityRef.current);
    } finally {
      setRatesRefreshing(false);
    }
  };

  const loadUsers = useCallback(async () => {
    // Settled apart, so a people list that fails never withholds the budget Budget and History needs.
    const [budget, list] = await Promise.allSettled([api.usageDailyBudget(), api.usageUsers()]);
    if (budget.status === "fulfilled") setDailyBudget(budget.value.dailyBudget);
    if (list.status === "fulfilled") setUsers(list.value.users);
    const failure = budget.status === "rejected" ? budget : list.status === "rejected" ? list : null;
    setUsersError(failure
      ? failure.reason instanceof Error ? failure.reason.message : "Unable to load per-user usage"
      : null);
  }, [api]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  /** A saved budget shows in By Person's sentence at once, and its rows reload with the new limit. */
  const budgetSaved = (budget: UsageDailyBudgetPolicy) => {
    setDailyBudget(budget);
    void loadUsers();
  };

  /** Saved history narrows the range and Group By to what is still kept, then reloads the usage. */
  const retentionSaved = (retention: UsageRetentionPolicy) => {
    setKnownRetention(retention);
    const currentDays = daysRef.current;
    const nextRange = [...RANGES].reverse().find((range) => range <= Math.min(currentDays, retention.dailyDays)) ?? RANGES[0];
    const currentGranularity = granularityRef.current;
    const nextGranularity = currentGranularity === "hour" && nextRange > retention.hourlyDays ? "day" : currentGranularity;
    daysRef.current = nextRange;
    setDays(nextRange);
    setGranularity(nextGranularity);
    if (nextRange === currentDays && nextGranularity === currentGranularity) void load(nextRange, nextGranularity);
  };

  const drivers = useMemo(() => (data ? activeDrivers(data.byDriver) : []), [data]);
  const rows = useMemo(() => (data ? driverRows(data, metric) : []), [data, metric]);
  const columns = useMemo(
    () => (data ? buildColumns(data.series, data.seriesByDriver ?? [], drivers, metric, {
      granularity: data.granularity,
      since: data.since,
      through: data.through,
      coverageStartedAt: data.retention.coverageStartedAt,
      ...(dataRange === null ? {} : { rangeDays: dataRange }),
    }) : []),
    [data, dataRange, drivers, metric],
  );
  const names = useUsageNames();
  const usageAgents = useUsageAgents();
  const driverLabels = useMemo(
    () => usageDriverLabels(data ?? { byDriver: [], byAgent: [] }, usageAgents),
    [data, usageAgents],
  );
  const dimensionRows = useMemo(() => data ? {
    model: breakdownRows(data.byModel ?? [], names.model, metric, data.totals),
    agent: breakdownRows(agentBreakdown(data.byAgent), names.agent, metric, data.totals),
    machine: breakdownRows(data.byRunner, names.machine, metric, data.totals),
  } : null, [data, metric, names]);
  const perDriverByBucket = useMemo(() => {
    const map = new Map<number, Map<string, UsageAggregationResponse["seriesByDriver"][number]>>();
    for (const row of data?.seriesByDriver ?? []) {
      const bucket = map.get(row.bucketTs) ?? new Map<string, UsageAggregationResponse["seriesByDriver"][number]>();
      bucket.set(row.driver, row);
      map.set(row.bucketTs, bucket);
    }
    return map;
  }, [data]);
  const coverage = data
    ? coverageMessages({ offlineMachines, legacyClaudeCostRecords: data.legacyClaudeCostRecords,
      runningTotalClaudeRecords: data.runningTotalClaudeRecords, unpricedRecords: data.totals.unpricedRecords ?? 0, pricing: data.pricing })
    : [];
  const empty = data ? usageIsEmpty(data.totals) : false;
  const includesCodexAppServer = Boolean(data && (
    data.byDriver.some((row) => row.key === "codex-app-server") ||
    (data.seriesByDriver ?? []).some((row) => row.driver === "codex-app-server")
  ));
  const periodNoun = data ? GRANULARITY_LABEL[data.granularity].noun : GRANULARITY_LABEL[granularity].noun;
  const breakdownTabs: ReadonlyArray<{ id: UsageBreakdownTab; label: string }> = [
    { id: "time", label: `By ${periodNoun}` },
    { id: "model", label: "By Model" },
    { id: "agent", label: "By Agent" },
    { id: "machine", label: "By Machine" },
    { id: "person", label: "By Person" },
  ];
  // The time table shows the newest 7 periods until Show All; a new range or grouping starts there
  // again, while a refresh of the same one keeps what was shown.
  const periodsKey = `${days}:${data?.granularity ?? granularity}`;
  const showAllPeriods = allPeriodsFor === periodsKey;
  const periodRows = data ? (showAllPeriods ? data.series : data.series.slice(0, PERIOD_ROWS_SHOWN)) : [];
  const hiddenPeriods = data ? data.series.length - periodRows.length : 0;
  const revealedPeriodRef = useRef<HTMLTableCellElement>(null);
  const focusRevealedPeriod = useRef(false);
  useEffect(() => {
    if (!showAllPeriods || !focusRevealedPeriod.current) return;
    focusRevealedPeriod.current = false;
    revealedPeriodRef.current?.focus();
  }, [showAllPeriods]);
  // Hour is OMITTED, never disabled, when the range is longer than hourly retention or the plane
  // reports this range already rolled into days; the Range menu says which ranges allow it.
  const hourlyUnavailableByRange = Boolean(knownRetention && days > knownRetention.hourlyDays);
  const hourlyDataAvailable = hourlyAvailability?.range === days ? hourlyAvailability.available : undefined;
  const hourlyUnavailable = hourlyUnavailableByRange || hourlyDataAvailable === false;
  // Week is omitted once the plane is known not to support it, and the Range menu ends with why.
  // Until the first response says, it shows disabled with the reason.
  const weekUnsupported = supportedGranularities !== null && !supportedGranularities.includes("week");
  const weekPendingReason = supportedGranularities !== null
    ? undefined
    : capabilityCheckFailed ? WEEK_CHECK_FAILED_REASON : WEEK_CHECKING_REASON;
  const granularityOptions: SegmentedOption<UsageAggregationGranularity>[] = (["hour", "day", "week"] as const)
    .filter((value) => !(value === "hour" && hourlyUnavailable) && !(value === "week" && weekUnsupported))
    .map((value) => value === "week" && weekPendingReason
      ? { value, label: GRANULARITY_LABEL[value].noun, disabled: true, disabledReason: weekPendingReason, description: weekPendingReason }
      : { value, label: GRANULARITY_LABEL[value].noun });
  const hourDescription = knownRetention
    ? `Hour grouping is available for ranges up to ${knownRetention.hourlyDays} days.`
    : undefined;
  const rangeChoices: RangeChoice[] = RANGES
    .filter((range) => !knownRetention || range <= knownRetention.dailyDays)
    .map((range) => ({
      range,
      description: knownRetention && range <= knownRetention.hourlyDays &&
        !(hourlyAvailability?.range === range && !hourlyAvailability.available)
        ? hourDescription
        : undefined,
    }));
  const rangeItems = (choose: (apply: () => void) => void) => rangeChoices.map((choice) => (
    <MenuItem
      key={choice.range}
      role="menuitemradio"
      checked={days === choice.range}
      description={choice.description}
      onClick={() => choose(() => selectRange(String(choice.range)))}
    >
      Last {choice.range} Days
    </MenuItem>
  ));
  const weekNote = weekUnsupported ? <MenuNote>{WEEK_UPGRADE_NOTE}</MenuNote> : null;
  const selectGranularity = (next: UsageAggregationGranularity) => setGranularity(next);
  const selectRange = (next: string) => {
    const range = Number(next);
    daysRef.current = range;
    const nextGranularity = granularity === "hour" && knownRetention && range > knownRetention.hourlyDays
      ? "day"
      : granularity;
    // Re-selecting the current range is a REFRESH, which is why this is not a no-op — and
    // it is deliberate rather than incidental, so it does not wait for the debounce.
    if (nextGranularity !== granularity) setGranularity(nextGranularity);
    if (days === range && nextGranularity === granularity) void load(range, granularity);
    else setDays(range);
  };
  const onOfflineNames = useCallback((names: string[]) => setOfflineMachines(names), []);

  const attention = subscriptions.attention;
  const attentionTone = attention.includes("exhausted") ? "danger" : "warning";
  const rateSource = safeExternalHref(data?.pricing?.source);
  const coverageStartedAt = data?.retention.coverageStartedAt ?? knownRetention?.coverageStartedAt;
  const tabs = [
    { id: undefined, key: "api", label: "API Usage", count: 0 },
    { id: "subscriptions", key: "subscriptions", label: "Subscriptions", count: attention.length },
  ] as const;

  const toolbar = (
    <div ref={setToolbarElement} className="toolbar usage-toolbar">
      <SegmentedControl<UsageMetric>
        label="Metric"
        value={metric}
        options={[
          { value: "cost", label: "Cost", title: "Show API-equivalent cost" },
          { value: "tokens", label: "Tokens", title: "Show processed tokens" },
        ]}
        onChange={setMetric}
      />
      {compactToolbar ? (
        <UsageMenuButton
          label={`${days} Days, ${GRANULARITY_LABEL[granularity].adjective}`}
          ariaLabel={`Range and Group By: ${days} Days, ${GRANULARITY_LABEL[granularity].adjective}`}
          menuLabel="Range and Group By"
          keepOpen
        >
          {(choose) => (
            <>
              <div role="group" aria-label="Range">
                <MenuLabel>Range</MenuLabel>
                {rangeItems(choose)}
              </div>
              <div role="group" aria-label="Group By">
                <MenuLabel>Group By</MenuLabel>
                {granularityOptions.map((option) => (
                  <MenuItem
                    key={option.value}
                    role="menuitemradio"
                    checked={granularity === option.value}
                    aria-disabled={option.disabled || undefined}
                    description={option.disabledReason}
                    onClick={() => { if (!option.disabled) choose(() => selectGranularity(option.value)); }}
                  >
                    {option.label}
                  </MenuItem>
                ))}
              </div>
              {weekNote}
            </>
          )}
        </UsageMenuButton>
      ) : (
        <>
          <UsageMenuButton
            label={`Last ${days} Days`}
            ariaLabel={`Range: Last ${days} Days`}
            menuLabel="Range"
          >
            {(choose) => <>{rangeItems(choose)}{weekNote}</>}
          </UsageMenuButton>
          <SegmentedControl
            label="Group By"
            value={granularity}
            options={granularityOptions}
            onChange={selectGranularity}
          />
        </>
      )}
      <InfoPopover
        tool="These Numbers"
        labelled={!compactToolbar}
        facts={rateSource ? [{
          term: "Rate Source",
          value: <a href={rateSource} target="_blank" rel="noreferrer">{new URL(rateSource).host}</a>,
        }] : undefined}
      >
        <p>These are estimates at published API rates, not a bill. Subscription plans are not billed this way.</p>
        {coverageStartedAt !== undefined && (
          <p>Recording started {coverageDate(coverageStartedAt)}. Earlier usage isn't in these charts.</p>
        )}
        {includesCodexAppServer && (
          <p>
            Codex App Server usage recorded before a machine's Wollipog update includes only the final response of each
            turn, so it is incomplete. Usage recorded since then counts every response.
          </p>
        )}
        <p>Only totals are stored: no prompts, file paths, tool inputs or session content.</p>
      </InfoPopover>
    </div>
  );

  // What the totals leave out, said once above them (§13.2), each gap with the action that helps.
  const machinesOffline = coverage.some((item) => item.kind === "offline-machines");
  const coverageNotice = coverage.length > 0 && (
    <Notice
      tone="warning"
      title={coverageTitle(coverage)}
      className="usage-coverage"
      details={ratesProblem ? ratesProblem.details.map((line) => <p key={line}>{line}</p>) : undefined}
      actions={(machinesOffline && navigate) || coverageNeedsRates(coverage) ? (
        <>
          {machinesOffline && navigate && (
            <button type="button" className="btn sm" onClick={() => navigate({ name: "runners", section: "machines" })}>
              View Machines
            </button>
          )}
          {coverageNeedsRates(coverage) && (
            <BusyButton className="btn sm" busy={ratesRefreshing} progress="Refreshing rates…" onClick={() => void refreshRates()}>
              Refresh Rates
            </BusyButton>
          )}
        </>
      ) : undefined}
    >
      {coverage.map((item) => <p key={item.kind}>{coverageSentence(item)}</p>)}
      {ratesProblem && <p>{ratesProblem.summary}</p>}
    </Notice>
  );

  // An empty window is said once, in place of the overview, the facts and the breakdown (§12.1).
  const shownRange = dataRange ?? days;
  const longestRange = rangeChoices.at(-1)?.range;
  const offerLongest = longestRange !== undefined && longestRange > shownRange;
  const emptyState = (
    <State
      pageLevel
      icon={<UsageIcon />}
      title={`No Usage in the Last ${shownRange} Days`}
      actions={offerLongest || navigate ? (
        <>
          {offerLongest && (
            <button type="button" className="btn primary" onClick={() => selectRange(String(longestRange))}>
              Show Last {longestRange} Days
            </button>
          )}
          {navigate && <button type="button" className="btn ghost" onClick={() => navigate({ name: "inbox" })}>Go to Sessions</button>}
        </>
      ) : undefined}
    >
      Usage is recorded each time an agent finishes a turn on a connected machine.{" "}
      {offerLongest ? "Try a longer range, or start a session." : "Start a session to record some."}
    </State>
  );

  return (
    <section className="page wide" aria-labelledby="page-title">
      {hasStore && <OfflineMachineWatcher onNames={onOfflineNames} />}
      <PageHeader
        title={destination("usage").name}
        description={destination("usage").description}
        // On a phone the secondary is in the app bar's More Actions (§3.3).
        secondary={tab !== "subscriptions" && data?.canManageRetention ? [{
          label: "Budget and History…",
          onClick: () => setBudgetHistory({ focusBudget: false }),
          disabled: !dailyBudget || !knownRetention,
          ...(!dailyBudget ? { title: usersError ? "The daily budget couldn't be loaded." : "Loading the daily budget…" } : {}),
        }] : undefined}
        // On phones Refresh All leaves the tab's head for the app bar's More Actions (#3014).
        menu={phone && tab === "subscriptions" && (subscriptions.data?.sources.length ?? 0) > 0 ? [{
          label: "Refresh Subscriptions",
          icon: subscriptions.refreshing ? <Spinner decorative /> : <RefreshIcon size={16} />,
          onClick: () => void subscriptions.refresh(),
        }] : []}
        tabs={(
          <TabList label={destination("usage").name} onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
            {tabs.map(({ id, key, label, count }) => (
              <button
                key={key}
                id={`usage-${key}-tab`}
                type="button"
                role="tab"
                aria-selected={tab === id}
                aria-controls={`usage-${key}-panel`}
                // The badge is aria-hidden, so the count joins the name in words.
                aria-label={count > 0 ? `${label}, ${count} Need Attention` : undefined}
                tabIndex={tab === id ? 0 : -1}
                className="tab"
                onClick={() => selectTab(id)}
              >
                {label}
                <CountBadge count={count} tone={attentionTone} />
              </button>
            ))}
          </TabList>
        )}
      />

      {tab === "subscriptions" ? (
        <section id="usage-subscriptions-panel" role="tabpanel" aria-labelledby="usage-subscriptions-tab" className="subscriptions">
          <SubscriptionsTab usage={subscriptions} phone={phone} onOpenConnections={onOpenConnections} />
        </section>
      ) : (
        <div id="usage-api-panel" role="tabpanel" aria-labelledby="usage-api-tab">
          {toolbar}
          {/* One state at a time (§12): offline, loading, error, empty, then the content. */}
          {offline && (!data || empty) ? (
            <State variant="offline" pageLevel>Reconnecting…</State>
          ) : firstLoad ? (
            showSkeleton && <UsageSkeleton />
          ) : error && !offline ? (
            <State
              variant="error"
              pageLevel
              title="Couldn't Load Usage"
              details={error}
              actions={<button type="button" className="btn sm" onClick={() => void load(days, granularity)}>Retry</button>}
            >
              Wollipog didn't answer. Recording continues, and nothing is lost.
            </State>
          ) : data && (
            <>
            {offline && <Notice compact tone="neutral" role="status" className="list-reconnecting">Reconnecting…</Notice>}
            <StaleContent stale={offline}>
            {/* Refetches keep the previous render in place instead of flashing a skeleton: the frame
               holds and the numbers update where they stand. */}
            <div aria-busy={loading}>
              {coverageNotice}

              {empty ? emptyState : (<>
              <section className="usage-overview" aria-label="Overview">
                <div className="usage-headline">
                  <span className="usage-headline-value">{formatMetric(metricValue(data.totals, metric), metric)}</span>
                  <span className="usage-headline-note">{usageWindowCaption(metric, data)}</span>
                  {/* The chart's only legend: each driver's swatch, name, share and amount. */}
                  <ul className="usage-driver-list" aria-label="By Driver">
                    {rows.map((row) => (
                      <li className="usage-driver-row" key={row.driver}>
                        <SeriesSwatch driver={row.driver} />
                        <span className="usage-driver-name">{driverLabels[row.driver]}</span>
                        <span className="usage-driver-share">{formatShare(row.share)}</span>
                        <strong>{formatMetric(metricValue(row.amount, metric), metric)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="usage-chart-section">
                  <UsageChart
                    columns={columns}
                    metric={metric}
                    granularity={data.granularity}
                    bounds={{ since: data.since, through: data.through }}
                    driverLabels={driverLabels}
                    tableHint={breakdownTab === "time"
                      ? `the By ${periodNoun} table below lists every value.`
                      : `choose By ${periodNoun} under Breakdown for a table of every value.`}
                  />
                </div>
              </section>

              {/* Tokens mode carries a sixth fact, which a compact column wraps to three by two. */}
              <dl className={`facts strip usage-facts${metric === "tokens" ? " usage-facts-six" : ""}`}>
                <div><dt>Processed Tokens</dt><dd>{formatCompactTokens(processedTokens(data.totals))}</dd></div>
                <div><dt>Cached Input</dt><dd>{formatCompactTokens(data.totals.cachedInputTokens)}</dd></div>
                <div><dt>Uncached Input</dt><dd>{formatCompactTokens(data.totals.uncachedInputTokens)}</dd></div>
                <div><dt>Output</dt><dd>{formatCompactTokens(data.totals.outputTokens)}</dd></div>
                <div><dt>Cache Savings</dt><dd>{formatMoney(data.totals.cacheSavingsUsd)}</dd></div>
                {/* The Tokens headline drops the dollar figure, so the strip keeps it. */}
                {metric === "tokens" && (
                  <div><dt>Estimated Cost</dt><dd>{formatMetric(metricValue(data.totals, "cost"), "cost")}</dd></div>
                )}
              </dl>

              <section className="usage-tables-section" aria-labelledby="usage-breakdown-heading">
                <h3 id="usage-breakdown-heading">Breakdown</h3>
                <TabList label="Breakdown" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
                  {breakdownTabs.map(({ id, label }) => (
                    <button
                      key={id}
                      id={`usage-breakdown-${id}-tab`}
                      type="button"
                      role="tab"
                      aria-selected={breakdownTab === id}
                      aria-controls="usage-breakdown-panel"
                      tabIndex={breakdownTab === id ? 0 : -1}
                      className="tab"
                      onClick={() => setBreakdownTab(id)}
                    >
                      {label}
                    </button>
                  ))}
                </TabList>
                <div id="usage-breakdown-panel" role="tabpanel" aria-labelledby={`usage-breakdown-${breakdownTab}-tab`}>
                  {breakdownTab === "time" && (
                    <>
                      <div className="table-wrap usage-table-wrap">
                        <table className="table usage-table usage-period-table" aria-labelledby="usage-breakdown-time-tab">
                          <thead>
                            <tr>
                              <th scope="col" className="col-name">{periodNoun} (UTC)</th>
                              {drivers.map((driver) => <th scope="col" className="num cell-extra" key={driver}>{driverLabels[driver]}</th>)}
                              <th scope="col" className="num">Total</th>
                              <th scope="col" className="num usage-period-trailing">{metric === "cost" ? "Tokens" : "Cost"}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {periodRows.map((bucket, index) => {
                              const trailing = metric === "cost"
                                ? `${formatCompactTokens(processedTokens(bucket))} tokens`
                                : `${formatMoney(bucket.costUsd)} estimated`;
                              return (
                                <tr key={bucket.bucketTs}>
                                  <th
                                    scope="row"
                                    // The first row Show All reveals takes focus, so the reader
                                    // continues where the table grew.
                                    ref={index === PERIOD_ROWS_SHOWN ? revealedPeriodRef : undefined}
                                    tabIndex={index === PERIOD_ROWS_SHOWN ? -1 : undefined}
                                  >
                                    <span className="usage-period">{periodLabel(bucket.bucketTs, data.granularity, data)}</span>
                                    {/* In the compact tier the trailing column folds under the date,
                                        so the agent headers keep their names (§14). */}
                                    <span className="usage-period-meta">{trailing}</span>
                                  </th>
                                  {drivers.map((driver) => {
                                    const split = perDriverByBucket.get(bucket.bucketTs);
                                    const cell = split?.get(driver);
                                    // No split for the bucket at all means the plane never sent one; a
                                    // missing driver inside a split means that driver had nothing.
                                    return (
                                      <td className="num cell-extra cell-dim" data-driver={driver} key={driver}>
                                        {!split ? "—" : formatMetric(cell ? metricValue(cell, metric) : 0, metric)}
                                      </td>
                                    );
                                  })}
                                  <td className="num cell-status">{formatMetric(metricValue(bucket, metric), metric)}</td>
                                  <td className="num cell-meta cell-dim usage-period-trailing">
                                    {metric === "cost" ? formatCompactTokens(processedTokens(bucket)) : formatMoney(bucket.costUsd)}
                                    <span className="usage-cell-unit">{metric === "cost" ? " tokens" : " estimated"}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {hiddenPeriods > 0 && (
                        <ListFoot>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => {
                              focusRevealedPeriod.current = true;
                              setAllPeriodsFor(periodsKey);
                            }}
                          >
                            {`Show All ${data.series.length} ${periodNoun}s`}
                          </button>
                        </ListFoot>
                      )}
                    </>
                  )}
                  {dimensionRows && breakdownTab === "model" && (
                    <DimensionTable labelledBy="usage-breakdown-model-tab" nameLabel="Model" rows={dimensionRows.model} metric={metric} />
                  )}
                  {dimensionRows && breakdownTab === "agent" && (
                    <DimensionTable labelledBy="usage-breakdown-agent-tab" nameLabel="Agent" rows={dimensionRows.agent} metric={metric} />
                  )}
                  {dimensionRows && breakdownTab === "machine" && (
                    <DimensionTable labelledBy="usage-breakdown-machine-tab" nameLabel="Machine" rows={dimensionRows.machine} metric={metric} />
                  )}
                  {breakdownTab === "person" && (
                    <>
                      <div className="usage-person-head">
                        <p className="usage-headline-note">
                          {dailyBudget?.perUserUsd != null
                            ? `Each person can spend ${formatMoney(dailyBudget.perUserUsd)} per UTC day. When they reach it, their new turns pause until midnight UTC.`
                            : "No daily budget is set."}
                        </p>
                        {data.canManageRetention && dailyBudget && knownRetention && (
                          <button type="button" className="btn sm" onClick={() => setBudgetHistory({ focusBudget: true })}>
                            Change Budget…
                          </button>
                        )}
                      </div>
                      {usersError && (
                        <Notice tone="danger" compact role="alert">{usersError}</Notice>
                      )}
                      {users ? <PersonTable users={users} /> : !usersError && (
                        <State variant="loading" compact>Loading people…</State>
                      )}
                    </>
                  )}
                </div>
              </section>
              </>)}

            </div>
            </StaleContent>
            </>
          )}
        </div>
      )}
      {budgetHistory && dailyBudget && knownRetention && (
        <BudgetHistoryDialog
          budget={dailyBudget}
          retention={knownRetention}
          focusBudget={budgetHistory.focusBudget}
          onBudgetSaved={budgetSaved}
          onRetentionSaved={retentionSaved}
          onClose={() => setBudgetHistory(null)}
        />
      )}
    </section>
  );
}
