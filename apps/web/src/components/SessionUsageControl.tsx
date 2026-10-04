import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionUsageResponse, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatCost, formatTokens } from "../format.js";
import { costProvenanceNote, estimatedCostSourceUrl, sessionCostLabel, sessionUsageTotals } from "../session-cost.js";
import { useAnchoredPopover } from "./anchored-popover.js";
import { ComposerButton } from "./ComposerControls.js";
import { InfoIcon } from "./Icons.js";

function ProtocolUsageInfo({ detailId }: { detailId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className={`session-usage-info${open ? " is-open" : ""}`}>
      <button
        type="button"
        aria-label="About Codex App Server Usage"
        aria-controls={detailId}
        aria-expanded={open}
        title="About Codex App Server Usage"
        onClick={() => setOpen((current) => !current)}
      >
        <InfoIcon size={14} />
      </button>
      <span className="session-usage-info-detail" id={detailId} role="note">
        Codex App Server usage recorded before the machine's Wollipog update includes only the final response of each turn, so it is incomplete. Usage recorded since then counts every response.
      </span>
    </span>
  );
}

/**
 * The usage behind a session's cost: its ledger, fetched each time `open` turns true, and the
 * label and totals that the trigger and the panel share.
 */
function useSessionUsageDetail(session: SessionView, open: boolean) {
  const api = useApi();
  const [breakdown, setBreakdown] = useState<SessionUsageResponse | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const loadBreakdown = useCallback(async () => {
    // Refetch per open: usage moves while a session runs, and the panel is where it is read.
    try {
      const next = await api.sessionUsage(session.id);
      loadedFor.current = session.id;
      setBreakdown(next);
      setBreakdownError(null);
    } catch (cause) {
      setBreakdownError(cause instanceof Error ? cause.message : "Unable to load usage by model");
    }
  }, [api, session.id]);

  useEffect(() => {
    if (open) void loadBreakdown();
  }, [open, loadBreakdown]);

  const fetched = breakdown && loadedFor.current === session.id ? breakdown : null;
  const totals = sessionUsageTotals(session, fetched);
  // One decision for the whole panel. `sessionUsageTotals` rejects a ledger that trails the
  // runner's live counters, and everything else derived from that response — the cost label, the
  // provenance sentence, the per-model rows — has to be rejected with it. Otherwise a stale
  // provider-priced zero would label newer, not-yet-ledgered tokens "$0.00", and the model rows
  // would disagree with the totals printed above them.
  const loaded = totals.detailed ? fetched : null;
  return { totals, loaded, breakdownError, label: sessionCostLabel(session, loaded) };
}

type SessionUsageDetail = ReturnType<typeof useSessionUsageDetail>;
type PricedDetail = SessionUsageDetail & { label: NonNullable<SessionUsageDetail["label"]> };

/** The Session Usage panel's contents, the same in the popover and in Model Settings. */
function SessionUsageFigures({ session, panelId, detail }: { session: SessionView; panelId: string; detail: PricedDetail }) {
  const { totals, loaded, breakdownError, label } = detail;
  const provenance = costProvenanceNote(loaded);
  const provenanceUrl = estimatedCostSourceUrl(loaded);
  const byModel = loaded?.byModel ?? [];
  // A priced zero is an amount, not a gap. The shared label has already chosen between the
  // current session snapshot and a caught-up ledger, so use that same provenance decision while
  // detail is pending, failed, or stale instead of making the heading disagree with the control.
  const headCost = formatCost(totals.costUsd)
    || (label.priced ? "$0.00" : "Not Priced");

  return (
    <>
      <div className="session-usage-head">
        <div className="session-usage-title">
          <strong>Session Usage</strong>
          {session.driver === "codex-app-server" && (
            <ProtocolUsageInfo detailId={`${panelId}-protocol-info`} />
          )}
        </div>
        <span>{headCost}</span>
      </div>
      <dl className="session-usage-facts">
        <div><dt>Input</dt><dd>{formatTokens(totals.inputTokens)}</dd></div>
        <div><dt>Output</dt><dd>{formatTokens(totals.outputTokens)}</dd></div>
        {/* Progressive disclosure: a bucket appears only when the runner reported it, so an
            older runner's records never grow rows of invented zeroes. */}
        {totals.cachedInputTokens > 0 && <div><dt>Cache Read</dt><dd>{formatTokens(totals.cachedInputTokens)}</dd></div>}
        {totals.cacheCreationTokens > 0 && <div><dt>Cache Write</dt><dd>{formatTokens(totals.cacheCreationTokens)}</dd></div>}
        {totals.reasoningTokens > 0 && <div><dt>Reasoning</dt><dd>{formatTokens(totals.reasoningTokens)}</dd></div>}
        <div><dt>Total Processed</dt><dd>{formatTokens(totals.processedTokens)}</dd></div>
        {totals.cacheSavingsUsd > 0 && <div><dt>Cache Savings</dt><dd>{formatCost(totals.cacheSavingsUsd)}</dd></div>}
      </dl>
      {(provenance || provenanceUrl) && (
        <p className="session-usage-note">
          {provenanceUrl ? (
            <>
              <a className="link" href={provenanceUrl} target="_blank" rel="noreferrer">Estimated API Costs</a>
              {loaded?.pricing?.status === "cached" && " (Cached Rates)"}
            </>
          ) : provenance}
        </p>
      )}
      {breakdownError && <p className="session-usage-note" role="alert">{breakdownError}</p>}
      {byModel.length > 0 && (
        <div className="session-usage-models">
          <span className="session-usage-label">By Model</span>
          {byModel.map((row) => (
            <div className="session-usage-model" key={row.model}>
              <span className="session-usage-model-name" title={row.model}>{row.model}</span>
              <dl>
                {/* A row with a cache split reports the uncached part as Input (zero is a real
                    value for a fully cached Codex turn); a legacy row without one reports what
                    the provider called input. */}
                <div><dt>Input</dt><dd>{formatTokens(row.cachedInputTokens + row.cacheCreationTokens > 0 ? row.uncachedInputTokens : row.inputTokens)}</dd></div>
                <div><dt>Output</dt><dd>{formatTokens(row.outputTokens)}</dd></div>
                {row.cachedInputTokens > 0 && <div><dt>Cache Read</dt><dd>{formatTokens(row.cachedInputTokens)}</dd></div>}
                {row.cacheCreationTokens > 0 && <div><dt>Cache Write</dt><dd>{formatTokens(row.cacheCreationTokens)}</dd></div>}
                <div><dt>Total</dt><dd>{formatTokens(row.processedTokens)}</dd></div>
                {/* Named as unpriced when the rate table could not price the model, rather than
                    a misleading $0.00. A row that WAS priced states its amount even when that
                    amount is zero, because a free model costing nothing is a fact. */}
                <div>
                  <dt>Cost</dt>
                  <dd>{row.costSource === "unpriced" ? "Not Priced" : formatCost(row.costUsd) || "$0.00"}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The Session Usage panel shown in Model Settings' place when its Session Cost row is opened
 * (#2447): the way to the per-model split, the pricing source and the Codex App Server note while
 * the composer bar has no room for the cost trigger. It fetches the ledger as it opens, as the
 * popover does, and renders nothing for a session that has processed nothing.
 */
export function SessionUsageBreakdown({ session }: { session: SessionView }) {
  const detail = useSessionUsageDetail(session, true);
  const panelId = useId();
  const { label } = detail;
  if (!label) return null;
  return (
    <div id={panelId} role="group" aria-label="Session Usage">
      <SessionUsageFigures session={session} panelId={panelId} detail={{ ...detail, label }} />
    </div>
  );
}

/**
 * The session's cumulative cost, and the usage behind it (#781).
 *
 * The trigger shows one figure — what this session has cost — because that is the only usage number
 * worth a permanent seat. `placement="bar"` is the composer bar's trailing trigger (#2166), a
 * borderless small ghost button; without it the control keeps the Sessions preview header's look. Everything else (input and output tokens, the cache and reasoning
 * buckets, where the price came from, and the per-model split) lives in the popover the cost
 * opens. This is deliberately NOT the context meter: that answers "how full is the model's window
 * right now", this answers "what has this session accumulated", and neither repeats the other.
 *
 * Renders nothing for a session that has processed nothing.
 */
export function SessionUsageControl({ session, placement }: { session: SessionView; placement?: "bar" }) {
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 280, height: 340 });
  const panelId = useId();
  const detail = useSessionUsageDetail(session, popover.open);
  const { label } = detail;
  if (!label) return null;

  const unpriced = label.priced ? "" : " is-unpriced";
  const trigger = {
    ref: popover.anchorRef,
    "aria-expanded": popover.open,
    "aria-controls": panelId,
    "aria-label": label.ariaLabel,
    title: label.priced ? `Session usage — ${label.text} so far` : "Session usage — cost unavailable for this session",
    // The bar's ComposerButton keeps the composer focused through the press; the trigger takes focus
    // once the click lands, so Escape closes the panel and returns here (#1796).
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.currentTarget.focus();
      popover.toggle();
    },
    children: label.text,
  };

  return (
    <span className={`session-usage${popover.open ? " is-open" : ""}`} ref={popover.rootRef}>
      {placement === "bar"
        ? <ComposerButton {...trigger} className={`cbar-usage${unpriced}`} />
        : <button type="button" {...trigger} className={`session-cost-button${unpriced}`} />}
      {popover.open && (
        <div
          className="session-usage-popover"
          id={panelId}
          role="group"
          aria-label="Session Usage"
          style={popover.style}
        >
          <SessionUsageFigures session={session} panelId={panelId} detail={{ ...detail, label }} />
        </div>
      )}
    </span>
  );
}
