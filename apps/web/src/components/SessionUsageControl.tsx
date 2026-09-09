import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionUsageResponse, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatCost, formatTokens } from "../format.js";
import { costProvenanceNote, sessionCostLabel, sessionUsageTotals } from "../session-cost.js";
import { useAnchoredPopover } from "./anchored-popover.js";

/**
 * The session's cumulative cost, and the usage behind it (#781).
 *
 * The strip shows one figure — what this session has cost — because that is the only usage number
 * worth a permanent seat. Everything else (input and output tokens, the cache and reasoning
 * buckets, where the price came from, and the per-model split) lives in the popover the cost
 * opens. This is deliberately NOT the context meter: that answers "how full is the model's window
 * right now", this answers "what has this session accumulated", and neither repeats the other.
 *
 * Renders nothing for a session that has processed nothing.
 */
export function SessionUsageControl({ session, className }: { session: SessionView; className?: string }) {
  const api = useApi();
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 280, height: 340 });
  const [breakdown, setBreakdown] = useState<SessionUsageResponse | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const panelId = useId();
  const loadedFor = useRef<string | null>(null);
  const { open } = popover;

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

  const label = sessionCostLabel(session);
  if (!label) return null;

  const loaded = breakdown && loadedFor.current === session.id ? breakdown : null;
  const totals = sessionUsageTotals(session, loaded);
  const provenance = costProvenanceNote(loaded);
  const byModel = loaded?.byModel ?? [];
  const headCost = formatCost(totals.costUsd) || "Not Priced";

  return (
    <span className={`session-usage${popover.open ? " is-open" : ""}${className ? ` ${className}` : ""}`} ref={popover.rootRef}>
      <button
        ref={popover.anchorRef}
        type="button"
        className={`session-cost-button${label.priced ? "" : " is-unpriced"}`}
        aria-expanded={popover.open}
        aria-controls={panelId}
        aria-label={label.ariaLabel}
        title={label.priced ? `Session usage — ${label.text} so far` : "Session usage — cost unavailable for this session"}
        onClick={popover.toggle}
      >
        {label.text}
      </button>
      {popover.open && (
        <div
          className="session-usage-popover"
          id={panelId}
          role="group"
          aria-label="Session Usage"
          style={popover.style}
        >
          <div className="session-usage-head">
            <strong>Session Usage</strong>
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
          {provenance && <p className="session-usage-note">{provenance}</p>}
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
                        a misleading $0.00; a priced row that genuinely cost nothing stays silent. */}
                    {row.costSource === "unpriced"
                      ? <div><dt>Cost</dt><dd>Not Priced</dd></div>
                      : row.costUsd > 0 && <div><dt>Cost</dt><dd>{formatCost(row.costUsd)}</dd></div>}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
