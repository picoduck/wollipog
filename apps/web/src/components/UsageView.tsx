import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SubscriptionUsageBucket,
  SubscriptionUsageResponse,
  SubscriptionUsageSourceView,
  UsageAggregationResponse,
  UsageRetentionPolicy,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatTokens } from "../format.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

const RANGES = [7, 30, 90, 365] as const;

function money(value: number): string {
  if (value === 0) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

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

export function UsageView() {
  const api = useApi();
  const [days, setDays] = useState(30);
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
    setData(null);
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
  // walks the group, and before this each step queued another aggregation — the button row this
  // replaced ignored arrows entirely, so the amplification arrived with the migration. Short
  // enough that a deliberate change still feels instant, long enough that a key repeat coalesces.
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

  const maxCost = useMemo(() => Math.max(0, ...(data?.series.map((bucket) => bucket.costUsd) ?? [])), [data]);
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

  return (
    <section className="usage-view" aria-labelledby="usage-heading">
      <div className="view-toolbar usage-toolbar">
        <div>
          <h2 id="usage-heading">Usage &amp; Cost</h2>
          <p>Scoped, content-free accounting across the sessions you can access.</p>
        </div>
        {/* A SegmentedControl, not `aria-pressed` buttons. `aria-pressed` announces "toggle button,
            pressed" and says nothing about the other ranges being alternatives, so a screen-reader
            user could not tell this from a row of independent switches — §11.1's finding. The
            primary/ghost split also made the selected range read as the page's main action. */}
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
              // What is ACTUALLY happening. "Loading usage…" described the wrong request: the
              // ranges are unavailable while the RETENTION setting is being saved, and usage
              // itself is still on screen throughout.
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
                    {control.reached ? "⛔ " : ""}{control.label}: {control.used ?? "Usage reported"}{control.limit ? ` of ${control.limit}` : ""}
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
        <>
          <p className="usage-coverage" role="note">
            Coverage begins {new Date(data.retention.coverageStartedAt).toLocaleString()}. Existing lifetime totals before that cutover are not backdated into buckets.
          </p>
          <dl className="usage-summary">
            <div><dt>Cost</dt><dd>{money(data.totals.costUsd)}</dd></div>
            <div><dt>Input Tokens</dt><dd>{formatTokens(data.totals.inputTokens)}</dd></div>
            <div><dt>Output Tokens</dt><dd>{formatTokens(data.totals.outputTokens)}</dd></div>
            <div><dt>Period</dt><dd>{days} Days</dd></div>
          </dl>

          <div
          className="usage-table-wrap"
          // A scroll region needs to be REACHABLE. The max-height that makes the sticky header work
          // also gives this its own scrollbar, and a plain overflow div is not in the sequential
          // focus order in WebKit — so a keyboard user tabbed past the table and could not reach
          // the rows inside it.
          tabIndex={0}
          role="region"
          // Named BY the caption, not with a copy of it. A fixed "Usage by Day" announced daily
          // buckets while the caption beside it said "Hourly Usage in UTC" — and hourly is what the
          // default 30-day range actually returns, so the contradiction was the common case.
          aria-labelledby="usage-table-caption"
        >
            <table className="usage-table">
              <caption id="usage-table-caption">{data.granularity === "hour" ? "Hourly" : "Daily"} Usage in UTC</caption>
              <thead><tr><th scope="col">Bucket</th><th scope="col">Cost</th><th scope="col">Input</th><th scope="col">Output</th></tr></thead>
              <tbody>
                {data.series.length === 0 ? (
                  <tr><td colSpan={4} className="usage-empty">No usage was observed in this period.</td></tr>
                ) : data.series.map((bucket) => (
                  <tr key={bucket.bucketTs}>
                    <th scope="row">{bucketLabel(bucket.bucketTs, data.granularity)}</th>
                    <td>
                      <span>{money(bucket.costUsd)}</span>
                      <span className="usage-cost-bar" aria-hidden="true" style={{ width: `${maxCost ? Math.max(2, bucket.costUsd / maxCost * 100) : 0}%` }} />
                    </td>
                    <td>{formatTokens(bucket.inputTokens)}</td>
                    <td>{formatTokens(bucket.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="usage-breakdowns">
            {(["Driver", "Agent", "Runner"] as const).map((label) => {
              const rows = label === "Driver" ? data.byDriver : label === "Agent" ? data.byAgent : data.byRunner;
              return (
                <section className="runner-card usage-breakdown" key={label}>
                  <h3>By {label}</h3>
                  {rows.length === 0 ? <p>No usage.</p> : (
                    <ul>{rows.slice(0, 20).map((row) => <li key={row.key}><span>{row.key}</span><strong>{money(row.costUsd)} · {formatTokens(row.inputTokens + row.outputTokens)}</strong></li>)}</ul>
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
        </>
      )}
    </section>
  );
}
