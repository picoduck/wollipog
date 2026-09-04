import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SubscriptionUsageBucket,
  SubscriptionUsageResponse,
  SubscriptionUsageSourceView,
  UsageAggregationResponse,
  UsageRetentionPolicy,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useHasStore, useStoreSelector } from "../store.js";
import {
  DRIVER_PRESENTATION,
  seriesClass,
  activeDrivers,
  buildColumns,
  coverageMessages,
  driverLabel,
  driverRows,
  formatCompactTokens,
  formatMetric,
  formatMoney,
  formatShare,
  metricValue,
  processedTokens,
  windowDays,
  type UsageBreakdownMode,
  type UsageMetric,
} from "../usage-view-model.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";
import { UsageChart } from "./UsageChart.js";

const RANGES = [7, 30, 90, 365] as const;

export function bucketLabel(timestamp: number, granularity: "hour" | "day"): string {
  const date = new Date(timestamp);
  return granularity === "hour"
    ? date.toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
    : date.toLocaleDateString(undefined, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
}

export function subscriptionResetLabel(timestamp: number, now = Date.now()): string {
  const difference = timestamp - now;
  if (difference <= 0) return "Reset time has passed";
  const minutes = Math.ceil(difference / 60_000);
  if (minutes < 60) return `Resets in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `Resets in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(hours / 24);
  return `Resets in ${days} days`;
}

function sourceStateLabel(source: SubscriptionUsageSourceView): string {
  if (source.freshness === "stale" && source.state === "available") return "Last Known — Stale";
  return {
    available: "Available",
    unavailable: "Temporarily Unavailable",
    unsupported: "Unsupported",
    unauthenticated: "Sign-In Required",
    not_applicable: "Not Applicable",
  }[source.state];
}

function remainingFor(bucket: SubscriptionUsageBucket): number | undefined {
  return bucket.remainingPercent ?? (bucket.usedPercent === undefined ? undefined : Math.max(0, 100 - bucket.usedPercent));
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

export function UsageView() {
  const api = useApi();
  const hasStore = useHasStore();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<UsageMetric>("cost");
  const [breakdown, setBreakdown] = useState<UsageBreakdownMode>("time");
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
  const [offlineMachines, setOfflineMachines] = useState<string[]>([]);
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionUsageResponse | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(true);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [subscriptionRefreshing, setSubscriptionRefreshing] = useState(false);
  const [subscriptionRefreshStatus, setSubscriptionRefreshStatus] = useState<string | null>(null);
  const [subscriptionNow, setSubscriptionNow] = useState(Date.now());
  // Which operation is actually in flight. `saving` spans the PUT and the refresh that follows it,
  // and the ranges are unavailable throughout — but the REASON differs, and a version that said
  // "saving retention" during the refresh described work that had already completed.
  const [savingPhase, setSavingPhase] = useState<"write" | "refresh">("write");
  const savingReason = savingPhase === "write"
    ? "Unavailable while saving retention"
    : "Unavailable while usage reloads";

  const load = useCallback(async (range: number) => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.usage({ days: range });
      if (generation !== requestGeneration.current) return;
      setData(next);
      setKnownRetention(next.retention);
      setHourlyDays(String(next.retention.hourlyDays));
      setDailyDays(String(next.retention.dailyDays));
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "Unable to load usage");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [api]);

  // The RANGE changes immediately; the request that follows it does not. Holding an arrow key
  // walks the group, and before this each step queued another aggregation — short enough that a
  // deliberate change still feels instant, long enough that a key repeat coalesces.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(days), 120);
    return () => window.clearTimeout(timer);
  }, [days, load]);

  const loadSubscriptions = useCallback(async () => {
    setSubscriptionLoading(true);
    setSubscriptionError(null);
    try {
      setSubscriptionData(await api.subscriptionUsage());
    } catch (cause) {
      setSubscriptionError(cause instanceof Error ? cause.message : "Unable to load subscription usage");
    } finally {
      setSubscriptionLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadSubscriptions();
  }, [loadSubscriptions]);

  useEffect(() => {
    const timer = window.setInterval(() => setSubscriptionNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshSubscriptions = async () => {
    setSubscriptionRefreshing(true);
    setSubscriptionError(null);
    setSubscriptionRefreshStatus(null);
    try {
      const refreshed = await api.refreshSubscriptionUsage();
      setSubscriptionData(refreshed);
      setSubscriptionNow(Date.now());
      setSubscriptionRefreshStatus(
        refreshed.refresh?.attempted === 0
          ? "No online supported Machines were available to refresh. Last-known values are unchanged."
          : refreshed.refresh?.failed
            ? `${refreshed.refresh.failed} of ${refreshed.refresh.attempted} Machine refreshes failed. Last-known values remain visible.`
            : "Subscription usage refreshed.",
      );
    } catch (cause) {
      setSubscriptionError(cause instanceof Error ? cause.message : "Unable to refresh subscription usage");
    } finally {
      setSubscriptionRefreshing(false);
    }
  };

  const saveRetention = async () => {
    if (!data) return;
    const nextHourly = Number(hourlyDays);
    const nextDaily = Number(dailyDays);
    if ((nextHourly < data.retention.hourlyDays || nextDaily < data.retention.dailyDays) &&
        !window.confirm("Shortening usage retention permanently removes older aggregate buckets. Continue?")) return;
    setSaving(true);
    setSavingPhase("write");
    setSaveStatus(null);
    setSaveFailed(false);
    try {
      const result = await api.updateUsageRetention({ hourlyDays: nextHourly, dailyDays: nextDaily });
      setKnownRetention(result.retention);
      const currentDays = daysRef.current;
      const nextRange = [...RANGES].reverse().find((range) => range <= Math.min(currentDays, result.retention.dailyDays)) ?? RANGES[0];
      daysRef.current = nextRange;
      setDays(nextRange);
      setSaveStatus("Usage aggregate retention saved.");
      if (nextRange === currentDays) {
        // The write is done; what follows is a refresh, and saying otherwise describes finished
        // work as still in progress.
        setSavingPhase("refresh");
        await load(nextRange);
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
    ? coverageMessages({ offlineMachines, unpricedRecords: data.totals.unpricedRecords ?? 0, pricing: data.pricing })
    : [];
  const periodNoun = data?.granularity === "hour" ? "Hour" : "Day";
  const onOfflineNames = useCallback((names: string[]) => setOfflineMachines(names), []);

  return (
    <section className="usage-view" aria-labelledby="usage-heading">
      {hasStore && <OfflineMachineWatcher onNames={onOfflineNames} />}
      <div className="view-toolbar usage-toolbar">
        <div>
          <h2 id="usage-heading">Usage &amp; Cost</h2>
          <p>Scoped, content-free accounting across the sessions you can access.</p>
        </div>
        {/* One filter row scopes everything beneath it: the metric flips every figure on the page
            and the range picks the window. Both are radiogroups so a screen reader hears the
            alternatives, not a row of independent toggles. */}
        <div className="usage-toolbar-controls">
          <SegmentedControl
            label="Usage Metric"
            value={metric}
            options={[
              { value: "cost", label: "Cost", title: "Show API-equivalent cost" },
              { value: "tokens", label: "Tokens", title: "Show processed tokens" },
            ]}
            onChange={setMetric}
          />
          <SegmentedControl
            className="usage-range"
            label="Usage Range"
            value={String(days)}
            options={RANGES
              .filter((range) => !knownRetention || range <= knownRetention.dailyDays)
              .map((range) => ({
                value: String(range),
                label: `${range}d`,
                title: `Last ${range} Days`,
                disabled: saving,
                disabledReason: saving ? savingReason : undefined,
              }))}
            onChange={(next) => {
              const range = Number(next);
              daysRef.current = range;
              // Re-selecting the current range is a REFRESH, which is why this is not a no-op — and
              // it is deliberate rather than incidental, so it does not wait for the debounce.
              if (days === range) void load(range);
              else setDays(range);
            }}
          />
        </div>
      </div>

      <section className="subscription-usage" aria-labelledby="subscription-usage-heading">
        <div className="subscription-usage-heading">
          <div>
            <h3 id="subscription-usage-heading">Subscription Usage</h3>
            <p>Provider allowance windows for signed-in Codex and Claude subscriptions. This does not include API-key billing.</p>
          </div>
          <button
            type="button"
            className="btn ghost"
            disabled={subscriptionRefreshing}
            onClick={() => void refreshSubscriptions()}
          >
            {subscriptionRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {subscriptionLoading && !subscriptionData && <div className="usage-state" role="status">Loading subscription usage…</div>}
        {subscriptionError && <div className="usage-state error" role="alert">{subscriptionError}</div>}
        {subscriptionRefreshStatus && <div className="subscription-usage-status" role="status">{subscriptionRefreshStatus}</div>}
        {subscriptionData && subscriptionData.sources.length === 0 && (
          <div className="usage-state">No Codex or Claude subscription sources are configured on the Machines you can access.</div>
        )}
        {subscriptionData && subscriptionData.sources.length > 0 && (
          <div className="subscription-source-grid">
            {subscriptionData.sources.map((source) => (
              <article className="runner-card subscription-source" key={`${source.runnerId}:${source.sourceId}`}>
                <header>
                  <div>
                    <h4>{source.provider === "codex" ? "Codex" : "Claude"}{source.plan ? ` — ${source.plan}` : ""}</h4>
                    <p>{source.agentName} on {source.runnerName}</p>
                  </div>
                  <span
                    className="subscription-state"
                    data-state={source.state}
                    data-freshness={source.freshness}
                  >
                    {source.freshness === "stale" ? "⚠ " : ""}{sourceStateLabel(source)}
                  </span>
                </header>
                {source.detail && <p className="subscription-detail">{source.detail}</p>}
                {source.buckets.length > 0 && (
                  <dl className="subscription-buckets">
                    {source.buckets.map((bucket) => {
                      const remaining = remainingFor(bucket);
                      const warning = bucket.status === "warning";
                      const exhausted = bucket.status === "exhausted" || remaining === 0;
                      return (
                        <div className={`subscription-bucket ${exhausted ? "exhausted" : warning ? "warning" : ""}`} key={bucket.id}>
                          <dt>{bucket.label}</dt>
                          <dd>
                            {remaining === undefined ? (
                              <strong>Allowance Reported</strong>
                            ) : (
                              <><strong>{Math.round(remaining)}% Remaining</strong><span>{Math.round(bucket.usedPercent ?? 100 - remaining)}% Used</span></>
                            )}
                            {exhausted && <span className="subscription-warning">⛔ Exhausted</span>}
                            {!exhausted && warning && <span className="subscription-warning">⚠ Approaching Limit</span>}
                            {bucket.resetsAt && (
                              <span title={new Date(bucket.resetsAt).toLocaleString()}>
                                {subscriptionResetLabel(bucket.resetsAt, subscriptionNow)} · {new Date(bucket.resetsAt).toLocaleString()}
                              </span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
                {source.credits && (
                  <p className="subscription-detail">
                    Credits: {source.credits.unlimited ? "Unlimited" : source.credits.balance ?? (source.credits.hasCredits ? "Available" : "None")}
                  </p>
                )}
                {source.spendControls?.map((control) => (
                  <p className="subscription-detail" key={control.id}>
                    {control.reached ? "⛔ " : ""}{control.label}: {control.used ?? "Usage Reported"}{control.limit ? ` of ${control.limit}` : ""}
                    {control.resetsAt ? ` · ${subscriptionResetLabel(control.resetsAt, subscriptionNow)}` : ""}
                  </p>
                ))}
                <footer>
                  Last provider update: {new Date(source.fetchedAt).toLocaleString()}
                  {source.runnerStatus === "offline" ? " · Machine Offline" : ""}
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      {loading && !data && <div className="usage-state" role="status">Loading usage…</div>}
      {error && <div className="usage-state error" role="alert">{error}</div>}
      {data && (
        /* Refetches keep the previous render in place instead of flashing a skeleton: the frame
           holds and the numbers update where they stand. */
        <div aria-busy={loading}>
          <p className="usage-coverage" role="note">
            Coverage begins {new Date(data.retention.coverageStartedAt).toLocaleString()}. Existing lifetime totals before that cutover are not backdated into buckets.
          </p>
          {notices.length > 0 && (
            <div className="usage-notice" role="note" aria-label="Coverage">
              {notices.map((notice) => <p key={notice}>{notice}</p>)}
            </div>
          )}

          <section className="usage-overview" aria-label="Overview">
            <div className="usage-headline">
              <span className="usage-headline-value">{formatMetric(metricValue(data.totals, metric), metric)}</span>
              <span className="usage-headline-note">
                {metric === "cost" ? "API-equivalent estimate · " : "Processed tokens · "}last {windowDays(data)} days
              </span>
              <ul className="usage-driver-list" aria-label="By Driver">
                {rows.length === 0 && <li className="usage-headline-note">No driver has usage in this period.</li>}
                {rows.map((row) => (
                  <li className="usage-driver-row" key={row.driver}>
                    <div>
                      <span>
                        <span className={`usage-series-swatch ${seriesClass(row.driver)}`} aria-hidden="true" />
                        {DRIVER_PRESENTATION[row.driver].label}
                      </span>
                      <strong>{formatMetric(metricValue(row.amount, metric), metric)}</strong>
                    </div>
                    <small>
                      {formatShare(row.share)} of {metric === "cost" ? "cost" : "tokens"} · {
                        metric === "cost"
                          ? `${formatCompactTokens(processedTokens(row.amount))} tokens`
                          : formatMoney(row.amount.costUsd)
                      }
                    </small>
                  </li>
                ))}
              </ul>
            </div>
            <div className="usage-chart-section">
              <h3>{data.granularity === "hour" ? "Hourly" : "Daily"} {metric === "cost" ? "Cost" : "Processed Tokens"}</h3>
              <UsageChart
                columns={columns}
                drivers={drivers}
                metric={metric}
                granularity={data.granularity}
                tableHint={breakdown === "time"
                  ? `the ${periodNoun} table below lists every value.`
                  : `select ${periodNoun} under Breakdown for a table of every value.`}
              />
            </div>
          </section>

          <section className="usage-totals-section" aria-labelledby="usage-totals-heading">
            <h3 id="usage-totals-heading">Totals</h3>
            <dl className="usage-totals">
              <div><dt>Processed Tokens</dt><dd>{formatCompactTokens(processedTokens(data.totals))}</dd></div>
              <div><dt>Cached Input</dt><dd>{formatCompactTokens(data.totals.cachedInputTokens)}</dd></div>
              <div><dt>Uncached Input</dt><dd>{formatCompactTokens(data.totals.uncachedInputTokens)}</dd></div>
              <div><dt>Output</dt><dd>{formatCompactTokens(data.totals.outputTokens)}</dd></div>
              <div><dt>Cache Savings</dt><dd>{formatMoney(data.totals.cacheSavingsUsd)}</dd></div>
            </dl>
          </section>

          <section className="usage-breakdown-section" aria-labelledby="usage-breakdown-heading">
            <div className="usage-breakdown-heading">
              <h3 id="usage-breakdown-heading">Breakdown</h3>
              <SegmentedControl
                label="Usage Breakdown"
                value={breakdown}
                options={[
                  { value: "model", label: "Model" },
                  { value: "time", label: periodNoun },
                ]}
                onChange={setBreakdown}
              />
            </div>
            {breakdown === "model" ? (
              <div className="usage-table-wrap" tabIndex={0} role="region" aria-labelledby="usage-model-caption">
                <table className="usage-table">
                  <caption id="usage-model-caption">Usage by Model</caption>
                  <thead><tr><th scope="col">Model</th><th scope="col">Cost</th><th scope="col">Share</th><th scope="col">Tokens</th></tr></thead>
                  <tbody>
                    {models.length === 0 ? (
                      <tr><td colSpan={4} className="usage-empty">No usage was observed in this period.</td></tr>
                    ) : models.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.key}{row.costSource === "unpriced" ? " · unpriced" : ""}</th>
                        <td>{formatMoney(row.costUsd)}</td>
                        <td className="usage-cell-dim">{formatShare(row.share)}</td>
                        <td className="usage-cell-dim">{formatCompactTokens(processedTokens(row))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div
                className="usage-table-wrap"
                // A scroll region needs to be REACHABLE. The max-height that makes the sticky header
                // work also gives this its own scrollbar, and a plain overflow div is not in the
                // sequential focus order in WebKit — so a keyboard user tabbed past it.
                tabIndex={0}
                role="region"
                aria-labelledby="usage-table-caption"
              >
                <table className="usage-table">
                  <caption id="usage-table-caption">{data.granularity === "hour" ? "Hourly" : "Daily"} Usage in UTC</caption>
                  <thead>
                    <tr>
                      <th scope="col">{periodNoun}</th>
                      {drivers.map((driver) => <th scope="col" key={driver}>{driverLabel(driver)}</th>)}
                      <th scope="col">Total</th>
                      <th scope="col">{metric === "cost" ? "Tokens" : "Cost"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.series.length === 0 ? (
                      <tr><td colSpan={drivers.length + 3} className="usage-empty">No usage was observed in this period.</td></tr>
                    ) : data.series.map((bucket) => (
                      <tr key={bucket.bucketTs}>
                        <th scope="row">{bucketLabel(bucket.bucketTs, data.granularity)}</th>
                        {drivers.map((driver) => {
                          const split = perDriverByBucket.get(bucket.bucketTs);
                          const cell = split?.get(driver);
                          // No split for the bucket at all means the plane never sent one; a
                          // missing driver inside a split means that driver had nothing.
                          return (
                            <td className="usage-cell-dim" key={driver}>
                              {!split ? "—" : formatMetric(cell ? metricValue(cell, metric) : 0, metric)}
                            </td>
                          );
                        })}
                        <td>{formatMetric(metricValue(bucket, metric), metric)}</td>
                        <td className="usage-cell-dim">
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

          {data.canManageRetention && (
            <section className="runner-card usage-retention" aria-labelledby="usage-retention-heading">
              <div><h3 id="usage-retention-heading">Usage Aggregate Retention</h3><p>This affects usage buckets only—not transcripts, audit logs, provider state, or session budget totals.</p></div>
              <label>Hourly Buckets (Days)<input type="number" min="1" max="90" value={hourlyDays} onChange={(event) => setHourlyDays(event.target.value)} /></label>
              <label>Daily Buckets (Days)<input type="number" min="30" max="3650" value={dailyDays} onChange={(event) => setDailyDays(event.target.value)} /></label>
              <button type="button" className="btn primary" disabled={saving} onClick={() => void saveRetention()}>{saving ? "Saving…" : "Save Retention"}</button>
              {saveStatus && <div className="usage-save-status" role={saveFailed ? "alert" : "status"}>{saveStatus}</div>}
            </section>
          )}
          <p className="usage-privacy">{data.privacy}</p>
        </div>
      )}
    </section>
  );
}
