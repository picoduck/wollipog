import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageDailyBudgetPolicy,
  UsageRetentionPolicy,
  UserCostWindows,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useHasStore, useStoreSelector } from "../store.js";
import {
  DRIVER_PRESENTATION,
  seriesClass,
  activeDrivers,
  buildColumns,
  bucketLabel,
  coverageMessages,
  driverLabel,
  driverRows,
  formatCompactTokens,
  formatMetric,
  formatMoney,
  formatShare,
  metricValue,
  processedTokens,
  usageWindowCaption,
  type UsageBreakdownMode,
  type UsageMetric,
} from "../usage-view-model.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { SegmentedControl, type SegmentedOption } from "./ui/ChoiceControls.js";
import { UsageChart } from "./UsageChart.js";
import { useFeedback } from "./FeedbackProvider.js";
import { PageHeader } from "./PageHeader.js";
import { destination, type UsageTab } from "../navigation.js";
import { safeExternalHref } from "../external-href.js";
import { CountBadge } from "./CountBadge.js";
import { Spinner } from "./common.js";
import { ChevronDownIcon, RefreshIcon } from "./Icons.js";
import { SubscriptionsTab, useSubscriptionUsage } from "./SubscriptionsTab.js";
import { InfoPopover } from "./InfoPopover.js";
import { handleRovingChoiceKeyDown, useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuNote, MenuSurface } from "./Menu.js";
import { TabList } from "./Tabs.js";
import { useIsMobile } from "./useIsMobile.js";

const RANGES = [7, 30, 90, 365] as const;
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

/** A range in the Range menu and the phone's Range and Group By sheet: "Last 30 Days". */
interface RangeChoice {
  range: number;
  /** Set on a range that allows Hour: "Hour grouping is available for ranges up to 14 days." */
  description?: string;
}

/**
 * The toolbar's menu buttons (§4.7, §9.1): Range on desktop, and on phones the one button that
 * opens Range and Group By as a sheet. Its items are radio rows; a choice applies at once.
 */
function UsageMenuButton({ label, ariaLabel, menuLabel, disabled, title, keepOpen = false, children }: {
  label: string;
  ariaLabel: string;
  menuLabel: string;
  disabled?: boolean;
  title?: string;
  /** The phone sheet stays open after a choice, so its other section can be set too and the
   * button behind it answers both (§15.1, as the Board's Filters sheet does). */
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

/** Reports the offline Machines the viewer can see. Mounted only under a store; a standalone
 * render (tests, harness pages) has no fleet and shows no machine notice. */
function OfflineMachineWatcher({ onNames }: { onNames: (names: string[]) => void }) {
  const runners = useStoreSelector((state) => state.runners);
  const names = useMemo(
    () => [...runners.values()].filter((runner) => runner.status === "offline").map((runner) => runner.hostname).sort(),
    [runners],
  );
  useEffect(() => onNames(names), [names, onNames]);
  return null;
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
  const { confirm } = useFeedback();
  const api = useApi();
  const hasStore = useHasStore();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [granularity, setGranularity] = useState<UsageAggregationGranularity>("day");
  const [breakdown, setBreakdown] = useState<UsageBreakdownMode>("day");
  const [supportedGranularities, setSupportedGranularities] = useState<readonly UsageAggregationGranularity[] | null>(null);
  const [capabilityCheckFailed, setCapabilityCheckFailed] = useState(false);
  const granularityRef = useRef(granularity);
  const breakdownRef = useRef(breakdown);
  granularityRef.current = granularity;
  breakdownRef.current = breakdown;
  const [data, setData] = useState<UsageAggregationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hourlyDays, setHourlyDays] = useState("30");
  const [dailyDays, setDailyDays] = useState("365");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const requestGeneration = useRef(0);
  const daysRef = useRef(days);
  const [knownRetention, setKnownRetention] = useState<UsageRetentionPolicy | null>(null);
  const [hourlyAvailability, setHourlyAvailability] = useState<{
    range: number;
    available: boolean;
  } | undefined>(undefined);
  const [offlineMachines, setOfflineMachines] = useState<string[]>([]);
  const [users, setUsers] = useState<UserCostWindows[] | null>(null);
  const [dailyBudget, setDailyBudget] = useState<UsageDailyBudgetPolicy | null>(null);
  const [dailyBudgetDraft, setDailyBudgetDraft] = useState("");
  const [dailyBudgetStatus, setDailyBudgetStatus] = useState<string | null>(null);
  const [dailyBudgetFailed, setDailyBudgetFailed] = useState(false);
  const [dailyBudgetSaving, setDailyBudgetSaving] = useState(false);
  const subscriptions = useSubscriptionUsage();
  // Which operation is actually in flight. `saving` spans the PUT and the refresh that follows it,
  // and the ranges are unavailable throughout — but the REASON differs, and a version that said
  // "saving retention" during the refresh described work that had already completed.
  const [savingPhase, setSavingPhase] = useState<"write" | "refresh">("write");
  const savingReason = savingPhase === "write"
    ? "Unavailable while saving retention"
    : "Unavailable while usage reloads";

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
      setData(next);
      setKnownRetention(next.retention);
      setSupportedGranularities(next.supportedGranularities ?? LEGACY_USAGE_GRANULARITIES);
      if (next.hourlyDataAvailable !== undefined) {
        setHourlyAvailability({ range, available: next.hourlyDataAvailable });
      }
      setHourlyDays(String(next.retention.hourlyDays));
      setDailyDays(String(next.retention.dailyDays));
      if (legacyHourlyFallback) {
        setHourlyAvailability({ range, available: false });
        setGranularity((current) => current === "hour" ? "day" : current);
        setBreakdown((current) => current === "hour" ? "day" : current);
      }
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      if (requestedGranularity === "hour" && cause instanceof ApiError &&
          cause.code === "USAGE_HOURLY_DATA_UNAVAILABLE") {
        handingOffToDay = true;
        setHourlyAvailability({ range, available: false });
        setGranularity((current) => current === "hour" ? "day" : current);
        setBreakdown((current) => current === "hour" ? "day" : current);
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

  const loadUsers = useCallback(async () => {
    try {
      const [budget, list] = await Promise.all([api.usageDailyBudget(), api.usageUsers()]);
      setDailyBudget(budget.dailyBudget);
      setDailyBudgetDraft(budget.dailyBudget.perUserUsd == null ? "" : String(budget.dailyBudget.perUserUsd));
      setUsers(list.users);
    } catch (cause) {
      setDailyBudgetFailed(true);
      setDailyBudgetStatus(cause instanceof Error ? cause.message : "Unable to load per-user usage");
    }
  }, [api]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const saveDailyBudget = async () => {
    const trimmed = dailyBudgetDraft.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      setDailyBudgetFailed(true);
      setDailyBudgetStatus("Enter a positive dollar amount, or leave it empty to remove the budget.");
      return;
    }
    setDailyBudgetSaving(true);
    setDailyBudgetStatus(null);
    setDailyBudgetFailed(false);
    try {
      const result = await api.updateUsageDailyBudget(value);
      setDailyBudget(result.dailyBudget);
      setDailyBudgetStatus(result.dailyBudget.perUserUsd == null ? "Daily budget removed." : "Daily budget saved.");
      await loadUsers();
    } catch (cause) {
      setDailyBudgetFailed(true);
      setDailyBudgetStatus(cause instanceof Error ? cause.message : "Unable to save the daily budget");
    } finally {
      setDailyBudgetSaving(false);
    }
  };

  const saveRetention = async () => {
    if (!data) return;
    const nextHourly = Number(hourlyDays);
    const nextDaily = Number(dailyDays);
    if ((nextHourly < data.retention.hourlyDays || nextDaily < data.retention.dailyDays) && !await confirm({
      title: "Shorten Usage Retention",
      message: "Usage totals older than the new retention periods are permanently removed. This cannot be undone.",
      confirmLabel: "Shorten Retention",
      tone: "danger",
    })) return;
    setSaving(true);
    setSavingPhase("write");
    setSaveStatus(null);
    setSaveFailed(false);
    try {
      const result = await api.updateUsageRetention({ hourlyDays: nextHourly, dailyDays: nextDaily });
      setKnownRetention(result.retention);
      const currentDays = daysRef.current;
      const nextRange = [...RANGES].reverse().find((range) => range <= Math.min(currentDays, result.retention.dailyDays)) ?? RANGES[0];
      const currentGranularity = granularityRef.current;
      const nextGranularity = currentGranularity === "hour" && nextRange > result.retention.hourlyDays
        ? "day"
        : currentGranularity;
      daysRef.current = nextRange;
      setDays(nextRange);
      setGranularity(nextGranularity);
      if (breakdownRef.current !== "model") setBreakdown(nextGranularity);
      setSaveStatus("Usage aggregate retention saved.");
      if (nextRange === currentDays && nextGranularity === currentGranularity) {
        // The write is done; what follows is a refresh, and saying otherwise describes finished
        // work as still in progress.
        setSavingPhase("refresh");
        await load(nextRange, nextGranularity);
      }
    } catch (cause) {
      setSaveFailed(true);
      setSaveStatus(cause instanceof Error ? cause.message : "Unable to save retention");
    } finally {
      setSaving(false);
    }
  };

  const drivers = useMemo(() => (data ? activeDrivers(data.byDriver) : []), [data]);
  const rows = useMemo(() => (data ? driverRows(data, metric) : []), [data, metric]);
  const columns = useMemo(
    () => (data ? buildColumns(data.series, data.seriesByDriver ?? [], drivers, metric) : []),
    [data, drivers, metric],
  );
  const models = useMemo(() => {
    if (!data) return [];
    const total = metricValue(data.totals, metric);
    return [...(data.byModel ?? [])]
      .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
      .map((row) => ({ ...row, share: total > 0 ? metricValue(row, metric) / total : 0 }));
  }, [data, metric]);
  const perDriverByBucket = useMemo(() => {
    const map = new Map<number, Map<string, UsageAggregationResponse["seriesByDriver"][number]>>();
    for (const row of data?.seriesByDriver ?? []) {
      const bucket = map.get(row.bucketTs) ?? new Map<string, UsageAggregationResponse["seriesByDriver"][number]>();
      bucket.set(row.driver, row);
      map.set(row.bucketTs, bucket);
    }
    return map;
  }, [data]);
  const notices = data
    ? coverageMessages({ offlineMachines, legacyClaudeCostRecords: data.legacyClaudeCostRecords, unpricedRecords: data.totals.unpricedRecords ?? 0, pricing: data.pricing })
    : [];
  const includesCodexAppServer = Boolean(data && (
    data.byDriver.some((row) => row.key === "codex-app-server") ||
    (data.seriesByDriver ?? []).some((row) => row.driver === "codex-app-server")
  ));
  const periodNoun = data ? GRANULARITY_LABEL[data.granularity].noun : GRANULARITY_LABEL[granularity].noun;
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
  const selectGranularity = (next: UsageAggregationGranularity) => {
    setGranularity(next);
    setBreakdown((current) => current === "model" ? current : next);
  };
  const selectRange = (next: string) => {
    const range = Number(next);
    daysRef.current = range;
    const nextGranularity = granularity === "hour" && knownRetention && range > knownRetention.hourlyDays
      ? "day"
      : granularity;
    // Re-selecting the current range is a REFRESH, which is why this is not a no-op — and
    // it is deliberate rather than incidental, so it does not wait for the debounce.
    if (nextGranularity !== granularity) {
      setGranularity(nextGranularity);
      if (breakdown !== "model") setBreakdown(nextGranularity);
    }
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
    <div className="toolbar usage-toolbar">
      <SegmentedControl<UsageMetric>
        label="Metric"
        value={metric}
        options={[
          { value: "cost", label: "Cost", title: "Show API-equivalent cost" },
          { value: "tokens", label: "Tokens", title: "Show processed tokens" },
        ]}
        onChange={setMetric}
      />
      {phone ? (
        <UsageMenuButton
          label={`${days} Days, ${GRANULARITY_LABEL[granularity].adjective}`}
          ariaLabel={`Range and Group By: ${days} Days, ${GRANULARITY_LABEL[granularity].adjective}`}
          menuLabel="Range and Group By"
          disabled={saving}
          title={saving ? savingReason : undefined}
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
            disabled={saving}
            title={saving ? savingReason : undefined}
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
        labelled
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

  return (
    <section className="page wide" aria-labelledby="page-title">
      {hasStore && <OfflineMachineWatcher onNames={onOfflineNames} />}
      <PageHeader
        title={destination("usage").name}
        description={destination("usage").description}
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
          {loading && !data && <div className="usage-state" role="status">Loading usage…</div>}
          {error && <div className="usage-state error" role="alert">{error}</div>}
          {data && (
            /* Refetches keep the previous render in place instead of flashing a skeleton: the frame
               holds and the numbers update where they stand. */
            <div aria-busy={loading}>
              {notices.length > 0 && (
                <div className="usage-notice" role="note" aria-label="Coverage">
                  {notices.map((notice) => <p key={notice}>{notice}</p>)}
                </div>
              )}

              <section className="usage-overview" aria-label="Overview">
                <div className="usage-headline">
                  <span className="usage-headline-value">{formatMetric(metricValue(data.totals, metric), metric)}</span>
                  <span className="usage-headline-note">{usageWindowCaption(metric, data)}</span>
                  {/* The chart's only legend: each driver's swatch, name, share and amount. */}
                  <ul className="usage-driver-list" aria-label="By Driver">
                    {rows.length === 0 && <li className="usage-headline-note">No driver has usage in this period.</li>}
                    {rows.map((row) => (
                      <li className="usage-driver-row" key={row.driver}>
                        <span className={`usage-series-swatch ${seriesClass(row.driver)}`} aria-hidden="true" />
                        <span className="usage-driver-name">{DRIVER_PRESENTATION[row.driver].label}</span>
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
                    tableHint={breakdown === data.granularity
                      ? `the ${periodNoun} table below lists every value.`
                      : `select ${periodNoun} under Breakdown for a table of every value.`}
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

              <section className="usage-breakdown-section" aria-labelledby="usage-breakdown-heading">
                <div className="usage-breakdown-heading">
                  <h3 id="usage-breakdown-heading">Breakdown</h3>
                  <SegmentedControl
                    label="Usage Breakdown"
                    value={breakdown}
                    options={[
                      { value: "model", label: "Model" },
                      ...granularityOptions,
                    ]}
                    onChange={(next) => {
                      setBreakdown(next);
                      if (next !== "model") setGranularity(next);
                    }}
                  />
                </div>
                {breakdown === "model" ? (
                  <div className="table-wrap usage-table-wrap" tabIndex={0} role="region" aria-labelledby="usage-model-caption">
                    <table className="table usage-table">
                      <caption id="usage-model-caption">Usage by Model</caption>
                      <thead><tr>
                        <th scope="col" className="col-name">Model</th>
                        <th scope="col" className="num">Cost</th>
                        <th scope="col" className="num">Share</th>
                        <th scope="col" className="num">Tokens</th>
                      </tr></thead>
                      <tbody>
                        {models.length === 0 ? (
                          <tr><td colSpan={4} className="usage-empty">No usage was observed in this period.</td></tr>
                        ) : models.map((row) => (
                          <tr key={row.key}>
                            <th scope="row">{row.key}{row.costSource === "unpriced" ? " · unpriced" : ""}</th>
                            <td className="num cell-status">{formatMoney(row.costUsd)}</td>
                            <td className="num cell-meta cell-dim"><span className="cell-label" aria-hidden="true">Share: </span>{formatShare(row.share)}</td>
                            <td className="num cell-meta cell-dim"><span className="cell-label" aria-hidden="true">Tokens: </span>{formatCompactTokens(processedTokens(row))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div
                    className="table-wrap usage-table-wrap"
                    // A scroll region needs to be REACHABLE. The max-height that makes the sticky header
                    // work also gives this its own scrollbar, and a plain overflow div is not in the
                    // sequential focus order in WebKit — so a keyboard user tabbed past it.
                    tabIndex={0}
                    role="region"
                    aria-labelledby="usage-table-caption"
                  >
                    <table className="table usage-table">
                      <caption id="usage-table-caption">{GRANULARITY_LABEL[data.granularity].adjective} Usage in UTC</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="col-name">{periodNoun}</th>
                          {drivers.map((driver) => <th scope="col" className="num" key={driver}>{driverLabel(driver)}</th>)}
                          <th scope="col" className="num">Total</th>
                          <th scope="col" className="num">{metric === "cost" ? "Tokens" : "Cost"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.series.length === 0 ? (
                          <tr><td colSpan={drivers.length + 3} className="usage-empty">No usage was observed in this period.</td></tr>
                        ) : data.series.map((bucket) => (
                          <tr key={bucket.bucketTs}>
                            <th scope="row">{bucketLabel(bucket.bucketTs, data.granularity, data)}</th>
                            {drivers.map((driver) => {
                              const split = perDriverByBucket.get(bucket.bucketTs);
                              const cell = split?.get(driver);
                              // No split for the bucket at all means the plane never sent one; a
                              // missing driver inside a split means that driver had nothing.
                              // In the narrow two-line layout the drivers join line 2, each named,
                              // since there is no detail view to find them in.
                              return (
                                <td className="num cell-meta cell-dim" data-driver={driver} key={driver}>
                                  <span className="cell-label" aria-hidden="true">{driverLabel(driver)}: </span>
                                  {!split ? "—" : formatMetric(cell ? metricValue(cell, metric) : 0, metric)}
                                </td>
                              );
                            })}
                            <td className="num cell-status">{formatMetric(metricValue(bucket, metric), metric)}</td>
                            <td className="num cell-meta cell-dim">
                              <span className="cell-label" aria-hidden="true">{metric === "cost" ? "Tokens" : "Cost"}: </span>
                              {metric === "cost" ? formatCompactTokens(processedTokens(bucket)) : formatMoney(bucket.costUsd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <div className="usage-breakdowns">
                {(["Agent", "Runner"] as const).map((label) => {
                  const list = label === "Agent" ? data.byAgent : data.byRunner;
                  return (
                    <section className="runner-card usage-breakdown" key={label}>
                      <h3>By {label}</h3>
                      {list.length === 0 ? <p>No usage.</p> : (
                        <ul>{list.slice(0, 20).map((row) => (
                          <li key={row.key}><span>{row.key}</span><strong>{formatMetric(metricValue(row, metric), metric)}</strong></li>
                        ))}</ul>
                      )}
                    </section>
                  );
                })}
              </div>

              {users && (
                <section className="usage-users-section" aria-labelledby="usage-users-heading">
                  <div className="usage-breakdown-heading">
                    <div>
                      <h3 id="usage-users-heading">By User</h3>
                      <p className="usage-headline-note">
                        {dailyBudget?.perUserUsd != null
                          ? `Each user may spend ${formatMoney(dailyBudget.perUserUsd)} per UTC day across their sessions; new turns pause past it.`
                          : "No per-user daily budget is set."}
                      </p>
                    </div>
                    {data.canManageRetention && (
                      <form
                        className="usage-daily-budget"
                        onSubmit={(event) => { event.preventDefault(); void saveDailyBudget(); }}
                      >
                        <label>
                          Daily Budget per User ($)
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="none"
                            value={dailyBudgetDraft}
                            onChange={(event) => setDailyBudgetDraft(event.target.value)}
                          />
                        </label>
                        <button type="submit" className="btn primary" disabled={dailyBudgetSaving}>
                          {dailyBudgetSaving ? "Saving…" : "Save Daily Budget"}
                        </button>
                      </form>
                    )}
                  </div>
                  {dailyBudgetStatus && (
                    <div className="usage-save-status" role={dailyBudgetFailed ? "alert" : "status"}>{dailyBudgetStatus}</div>
                  )}
                  <div className="table-wrap usage-table-wrap" tabIndex={0} role="region" aria-labelledby="usage-users-caption">
                    <table className="table usage-table">
                      <caption id="usage-users-caption">Cost by User in UTC Days</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="col-name">User</th>
                          <th scope="col" className="num">Today</th>
                          <th scope="col" className="num">Last 7 Days</th>
                          <th scope="col" className="num">Last 30 Days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.length === 0 ? (
                          <tr><td colSpan={4} className="usage-empty">No user-owned usage in the last 30 days.</td></tr>
                        ) : users.map((row) => {
                          const over = row.dailyBudgetUsd != null && row.todayUsd >= row.dailyBudgetUsd;
                          return (
                            <tr key={row.userId}>
                              <th scope="row"><PersonalIdentifier value={row.userName} label="User Name" />{over ? " · paused by daily budget" : ""}</th>
                              <td className="num cell-status">
                                <span className="cell-label" aria-hidden="true">Today: </span>
                                {formatMoney(row.todayUsd)}
                                {row.dailyBudgetUsd != null && (
                                  <span className="cell-dim"> of {formatMoney(row.dailyBudgetUsd)}</span>
                                )}
                              </td>
                              <td className="num cell-meta cell-dim"><span className="cell-label" aria-hidden="true">Last 7 Days: </span>{formatMoney(row.last7DaysUsd)}</td>
                              <td className="num cell-meta cell-dim"><span className="cell-label" aria-hidden="true">Last 30 Days: </span>{formatMoney(row.last30DaysUsd)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {data.canManageRetention && (
                <section className="runner-card usage-retention" aria-labelledby="usage-retention-heading">
                  <div><h3 id="usage-retention-heading">Usage Aggregate Retention</h3><p>This affects usage buckets only—not transcripts, audit logs, provider state, or session budget totals.</p></div>
                  <label>Hourly Buckets (Days)<input type="number" min="1" max="90" value={hourlyDays} onChange={(event) => setHourlyDays(event.target.value)} /></label>
                  <label>Daily Buckets (Days)<input type="number" min="30" max="3650" value={dailyDays} onChange={(event) => setDailyDays(event.target.value)} /></label>
                  <button type="button" className="btn primary" disabled={saving} onClick={() => void saveRetention()}>{saving ? "Saving…" : "Save Retention"}</button>
                  {saveStatus && <div className="usage-save-status" role={saveFailed ? "alert" : "status"}>{saveStatus}</div>}
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
