import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SessionUsageResponse, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { compactionNote, computeContextFill } from "../context-meter.js";
import { resolveCaps } from "../caps.js";
import { formatCost, formatTokens } from "../format.js";
import { useStoreSelector } from "../store.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Context-fill meter for the session header: a small ring that fills as the model's window is
 * consumed, and a popover with the figures behind it — percent, used over capacity, the session's
 * total processed tokens, the compaction note, and the usage split by the model that produced it.
 * Reads the per-model `contextWindow` off the agent's advertised capabilities (protocol v11), or
 * the provider gauge when the runner publishes one. Renders nothing when the window is unknown.
 */
export function ContextWindowMeter({ session }: { session: SessionView }) {
  const api = useApi();
  const runners = useStoreSelector((s) => s.runners);
  const models = resolveCaps(runners.get(session.runnerId), session)?.models ?? [];
  const model = models.find((m) => m.id === session.model) ?? models.find((m) => m.default);
  const contextWindow = session.contextWindow ?? model?.contextWindow;
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow,
  });
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<SessionUsageResponse | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
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

  // Escape and an outside pointer close the popover, so a hover-opened panel never traps focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!fill.known) return null;

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  const processed = session.tokensIn + session.tokensOut;
  const dash = (fill.fillPct / 100) * RING_CIRCUMFERENCE;
  const summary = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;
  const byModel = breakdown?.byModel ?? [];

  return (
    <span
      className={`context-meter${fill.isFull ? " is-full" : ""}${open ? " is-open" : ""}`}
      ref={rootRef}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="context-ring-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Context Window ${fill.formatPct} Used`}
        title={summary}
        // Opens, never toggles: a pointer click always arrives after the hover that already opened
        // the panel, so a toggle would close it on the very click meant to pin it. Escape, an
        // outside pointer, or leaving the meter closes it.
        onClick={() => setOpen(true)}
      >
        <svg className="context-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle className="context-ring-track" cx="8" cy="8" r={RING_RADIUS} />
          {dash > 0 && (
            <circle
              className="context-ring-fill"
              cx="8"
              cy="8"
              r={RING_RADIUS}
              strokeDasharray={`${dash} ${RING_CIRCUMFERENCE}`}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
        <span className="meter-label">{fill.formatPct}</span>
      </button>
      {open && (
        <div className="context-popover" id={panelId} role="group" aria-label="Context Window">
          <div className="context-popover-head">
            <strong>Context Window</strong>
            <span>{fill.formatPct} · {formatTokens(used)} / {formatTokens(contextWindow!)}</span>
          </div>
          <div className="context-popover-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill.fillPct)} aria-label="Context Window Usage">
            <span style={{ width: `${fill.fillPct}%` }} />
          </div>
          <dl className="context-popover-facts">
            <div><dt>Total Processed</dt><dd>{formatTokens(processed)}</dd></div>
            {session.costUsd > 0 && <div><dt>Session Cost</dt><dd>{formatCost(session.costUsd)}</dd></div>}
          </dl>
          <p className="context-popover-note">{compactionNote(session.driver)}</p>
          {breakdownError && <p className="context-popover-note" role="alert">{breakdownError}</p>}
          {byModel.length > 0 && (
            <div className="context-popover-models">
              <span className="context-popover-label">By Model</span>
              {byModel.map((row) => (
                <div className="context-popover-model" key={row.model}>
                  <span className="context-popover-model-name" title={row.model}>{row.model}</span>
                  <dl>
                    <div><dt>Input</dt><dd>{formatTokens(row.uncachedInputTokens || row.inputTokens)}</dd></div>
                    <div><dt>Output</dt><dd>{formatTokens(row.outputTokens)}</dd></div>
                    {row.cachedInputTokens > 0 && <div><dt>Cache Read</dt><dd>{formatTokens(row.cachedInputTokens)}</dd></div>}
                    {row.cacheCreationTokens > 0 && <div><dt>Cache Write</dt><dd>{formatTokens(row.cacheCreationTokens)}</dd></div>}
                    <div><dt>Total</dt><dd>{formatTokens(row.processedTokens)}</dd></div>
                    {/* Omitted when the model was never priced, rather than a misleading $0.00. */}
                    {row.costSource !== "unpriced" && row.costUsd > 0 && <div><dt>Cost</dt><dd>{formatCost(row.costUsd)}</dd></div>}
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
