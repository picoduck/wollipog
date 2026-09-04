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
 * consumed, and a click-to-open popover with the figures behind it — percent, used over capacity,
 * the session's total processed tokens, the compaction note, and the usage split by the model
 * that produced it.
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
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
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

  // The meter lives inside clipped strips (preview meta, the transcript status strip), so the
  // panel is positioned against the viewport from the button's rectangle rather than flowing
  // inside an ancestor that would cut it off. Placed below when there is room, else above.
  useEffect(() => {
    if (!open) { setPlacement(null); return; }
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 280;
      const height = 320;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 6 + height <= window.innerHeight;
      setPlacement({ top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height), left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Escape and an outside pointer close the popover, so a hover-opened panel never traps focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    // Capture phase, so a view-level Escape handler that stops propagation (the composer's, the
    // menus') cannot swallow the key while this panel is the thing the user is trying to close.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  if (!fill.known) return null;

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  // The ledger's figure counts every cache bucket; the runner totals are the floor until it loads.
  const processed = breakdown && loadedFor.current === session.id
    ? Math.max(breakdown.totals.processedTokens, session.tokensIn + session.tokensOut)
    : session.tokensIn + session.tokensOut;
  const dash = (fill.fillPct / 100) * RING_CIRCUMFERENCE;
  const summary = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;
  const byModel = breakdown?.byModel ?? [];

  return (
    <span
      className={`context-meter${fill.isFull ? " is-full" : ""}${open ? " is-open" : ""}`}
      ref={rootRef}
    >
      <button
        ref={buttonRef}
        type="button"
        className="context-ring-button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Context Window ${fill.formatPct} Used`}
        title={summary}
        // Click or keyboard only: the ring sits in a dense header, and a hover-opened panel was
        // getting in the way of pointer travel to neighbouring controls. Escape or an outside
        // pointer closes it as well.
        onClick={() => setOpen((current) => !current)}
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
        <div
          className="context-popover"
          id={panelId}
          role="group"
          aria-label="Context Window"
          style={placement ? { position: "fixed", top: placement.top, left: placement.left } : undefined}
        >
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
                    {/* A row with a cache split reports the uncached part as Input (zero is a real
                        value for a fully cached Codex turn); a legacy row without one reports what
                        the provider called input. */}
                    <div><dt>Input</dt><dd>{formatTokens(row.cachedInputTokens + row.cacheCreationTokens > 0 ? row.uncachedInputTokens : row.inputTokens)}</dd></div>
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
