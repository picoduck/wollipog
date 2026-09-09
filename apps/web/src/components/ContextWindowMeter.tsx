import { useId } from "react";
import type { SessionView } from "@wollipog/protocol";
import { compactionNote, computeContextFill } from "../context-meter.js";
import { resolveCaps } from "../caps.js";
import { advertisedContextWindow, contextWindowDiscrepancy, formatContextWindow } from "../context-window-options.js";
import { formatTokens } from "../format.js";
import { useStoreSelector } from "../store.js";
import { useAnchoredPopover } from "./anchored-popover.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Context-fill meter for the session status strip: a small ring that fills as the model's window
 * is consumed, and a click-to-open popover with the occupancy figures behind it — percent, used,
 * capacity and where that capacity came from, what is left, and how the driver compacts.
 *
 * It answers one question only: how full is the model's CURRENT working context. Cumulative
 * session usage and cost are a different question and live in the neighbouring Session Usage
 * control (#781); current occupancy must never be presented as cumulative token usage.
 *
 * Capacity is the window the provider reports serving (the runner's live gauge) and, until the
 * first turn reports one, the provider-stated window on the agent's catalog entry (protocol v11).
 * Renders nothing when neither is known; nothing is inferred from a model name. When the served
 * window differs from what the selected model advertises, the popover says so instead of
 * silently metering against the wrong size.
 */
export function ContextWindowMeter({ session }: { session: SessionView }) {
  const runners = useStoreSelector((s) => s.runners);
  const models = resolveCaps(runners.get(session.runnerId), session)?.models ?? [];
  // With no explicit selection the provider launches its default entry, so that entry (not a family
  // substitute) is what the session advertises.
  const model = models.find((m) => m.id === session.model) ?? models.find((m) => m.default);
  const served = session.contextWindow && session.contextWindow > 0 ? session.contextWindow : undefined;
  const contextWindow = served ?? model?.contextWindow;
  const discrepancy = contextWindowDiscrepancy(advertisedContextWindow(models, session.model ?? model?.id), served);
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow,
  });
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 280, height: 220 });
  const panelId = useId();

  if (!fill.known) return null;

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  const remaining = Math.max(0, contextWindow! - used);
  const dash = (fill.fillPct / 100) * RING_CIRCUMFERENCE;
  const summary = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;

  return (
    <span
      className={`context-meter${fill.isFull ? " is-full" : ""}${popover.open ? " is-open" : ""}`}
      ref={popover.rootRef}
    >
      <button
        ref={popover.anchorRef}
        type="button"
        className="context-ring-button"
        aria-expanded={popover.open}
        aria-controls={panelId}
        aria-label={`Context Window ${fill.formatPct} Used`}
        title={summary}
        // Click or keyboard only: the ring sits in a dense header, and a hover-opened panel was
        // getting in the way of pointer travel to neighbouring controls. Escape or an outside
        // pointer closes it as well.
        onClick={popover.toggle}
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
      {popover.open && (
        <div
          className="context-popover"
          id={panelId}
          role="group"
          aria-label="Context Window"
          style={popover.style}
        >
          <div className="context-popover-head">
            <strong>Context Window</strong>
            <span>{fill.formatPct}</span>
          </div>
          <div className="context-popover-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill.fillPct)} aria-label="Context Window Usage">
            <span style={{ width: `${fill.fillPct}%` }} />
          </div>
          <dl className="context-popover-facts">
            <div><dt>Used</dt><dd>{formatTokens(used)}</dd></div>
            {/* #806's capacity provenance stays: which window the meter is measuring against is an
                occupancy fact, unlike the session billing #781 moved out of this panel. */}
            <div><dt>Capacity</dt><dd>{formatContextWindow(contextWindow!)} · {served ? "Provider Reported" : "Model Catalog"}</dd></div>
            <div><dt>Remaining</dt><dd>{formatTokens(remaining)}</dd></div>
          </dl>
          {discrepancy && (
            <p className="context-popover-note context-popover-discrepancy" role="status">
              {discrepancy.kind === "smaller"
                ? `The provider is serving a ${formatContextWindow(discrepancy.served)} context window, not the ${formatContextWindow(discrepancy.advertised)} the selected model advertises. The meter uses the served size.`
                : `The provider is serving a ${formatContextWindow(discrepancy.served)} context window; the selected model advertises ${formatContextWindow(discrepancy.advertised)}. The meter uses the served size.`}
            </p>
          )}
          <p className="context-popover-note">{compactionNote(session.driver)}</p>
        </div>
      )}
    </span>
  );
}
