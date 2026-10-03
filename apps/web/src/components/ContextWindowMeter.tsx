import { useId } from "react";
import type { SessionView } from "@wollipog/protocol";
import { compactionNote, computeContextFill, type ContextFillTone } from "../context-meter.js";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { contextWindowDiscrepancy, formatContextWindow } from "../context-window-options.js";
import { formatTokens } from "../format.js";
import { useAnchoredPopover } from "./anchored-popover.js";
import { ComposerButton } from "./ComposerControls.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The fill ring itself, shared by the trigger and the read-only Session Usage group. */
export function ContextRing({ fillPct, size = 16 }: { fillPct: number; size?: number }) {
  const dash = (fillPct / 100) * RING_CIRCUMFERENCE;
  return (
    <svg className="context-ring" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
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
  );
}

/** The tone class the ring and its bar share (§11.6). */
export function contextToneClass(tone: ContextFillTone): string {
  return tone === "neutral" ? "" : ` t-${tone}`;
}

/**
 * Context-fill meter: a small ring that fills as the model's window is consumed, and a
 * click-to-open popover with the occupancy figures behind it — percent, used, capacity and where
 * that capacity came from, what is left, and how the driver compacts.
 *
 * `placement="bar"` is the composer bar's trailing trigger (#2166): a borderless small ghost button
 * with a 14px ring. Without it the meter keeps the Sessions preview header's compact look.
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
export function ContextWindowMeter({ session, resolution, placement }: {
  session: SessionView;
  resolution: ContextWindowCapacity;
  placement?: "bar";
}) {
  const contextWindow = resolution.capacity;
  const discrepancy = contextWindowDiscrepancy(resolution.advertised, resolution.served);
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow,
  });
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 280, height: 220 });
  const panelId = useId();

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  // The composer bar seats live usage only: a session that has processed nothing yet shows no ring
  // and leaves no gap (#2166).
  if (!fill.known || (placement === "bar" && used <= 0)) return null;

  const remaining = Math.max(0, contextWindow! - used);
  const summary = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;
  const trigger = {
    ref: popover.anchorRef,
    "aria-expanded": popover.open,
    "aria-controls": panelId,
    "aria-label": `Context Window ${fill.formatPct} Used`,
    title: summary,
    // Click or keyboard only: the ring sits among dense controls, and a hover-opened panel was
    // getting in the way of pointer travel to neighbouring controls. Escape or an outside
    // pointer closes it as well.
    onClick: popover.toggle,
    children: <>
      <ContextRing fillPct={fill.fillPct} size={placement === "bar" ? 14 : 16} />
      <span className="context-ring-label">{fill.formatPct}</span>
    </>,
  };

  return (
    <span
      className={`context-control${contextToneClass(fill.tone)}${popover.open ? " is-open" : ""}`}
      ref={popover.rootRef}
    >
      {placement === "bar"
        ? <ComposerButton {...trigger} className="cbar-usage" />
        : <button type="button" {...trigger} className="context-ring-button" />}
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
          <div className={`meter${contextToneClass(fill.tone)}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill.fillPct)} aria-label="Context Window Usage">
            <span style={{ width: `${fill.fillPct}%` }} />
          </div>
          <dl className="context-popover-facts">
            <div><dt>Used</dt><dd>{formatTokens(used)}</dd></div>
            {/* #806's capacity provenance stays: which window the meter is measuring against is an
                occupancy fact, unlike the session billing #781 moved out of this panel. */}
            <div><dt>Capacity</dt><dd>{formatContextWindow(contextWindow!)} · {resolution.source === "served" ? "Provider Reported" : "Model Catalog"}</dd></div>
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
