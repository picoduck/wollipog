import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageAggregationResponse, UsageRetentionPolicy } from "@wollipog/protocol";
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
