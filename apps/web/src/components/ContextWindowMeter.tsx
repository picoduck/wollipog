import React, { useId } from "react";
import type { SessionView } from "@wollipog/protocol";
import { agentHarnessDriverLabel } from "../agent-presentation.js";
import { compactionNote, compactionNotice, computeContextFill, type ContextFillTone } from "../context-meter.js";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { contextWindowDiscrepancy } from "../context-window-options.js";
import { formatTokens } from "../format.js";
import { useLiveSession } from "../store.js";
import { useAnchoredPopover } from "./anchored-popover.js";
import { ComposerButton } from "./ComposerControls.js";
import { Notice } from "./Notice.js";

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The fill ring itself, shared by the trigger and the Session Usage group. */
export function ContextRing({ fillPct, size = 14 }: { fillPct: number; size?: number }) {
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
 * Context-fill meter: the composer bar's trailing trigger (#2166), a borderless small ghost button
 * with a 14px ring that fills as the model's window is consumed, and a click-to-open popover with
 * the occupancy figures behind it — percent, used, what is left, the window and where its size came
 * from, and how the driver compacts.
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
export function ContextWindowMeter({ session: rendered, resolution }: {
  session: SessionView;
  resolution: ContextWindowCapacity;
}) {
  // Usage moves with every streamed event; the session view does not render for that (#2872).
  const session = useLiveSession(rendered);
  const contextWindow = resolution.capacity;
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow,
  });
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 280, height: 260 });
  const panelId = useId();

  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  // The composer bar seats live usage only: a session that has processed nothing yet shows no ring
  // and leaves no gap (#2166).
  if (!fill.known || used <= 0) return null;

  const summary = `${used.toLocaleString()} / ${contextWindow!.toLocaleString()} context tokens (${fill.formatPct})`;

  return (
    <span
      className={`context-control${contextToneClass(fill.tone)}${popover.open ? " is-open" : ""}`}
      ref={popover.rootRef}
    >
      <ComposerButton
        ref={popover.anchorRef}
        className="cbar-usage"
        aria-expanded={popover.open}
        aria-controls={panelId}
        aria-label={`Context Window ${fill.formatPct} Used`}
        title={summary}
        // Click or keyboard only: the ring sits among dense controls, and a hover-opened panel was
        // getting in the way of pointer travel to neighbouring controls. Escape or an outside
        // pointer closes it as well. ComposerButton keeps the composer focused through the press,
        // so the trigger takes focus once the click lands: Escape then closes the panel and the
        // next one leaves the composer, one layer each (#1796).
        onClick={(event) => {
          event.currentTarget.focus();
          popover.toggle();
        }}
      >
        <ContextRing fillPct={fill.fillPct} />
        <span className="context-ring-label">{fill.formatPct}</span>
      </ComposerButton>
      {popover.open && (
        <div
          className="usage-popover context-popover"
          id={panelId}
          role="group"
          aria-label="Context Window"
          style={popover.style}
        >
          <ContextWindowFigures session={session} resolution={resolution} fill={fill} used={used} />
        </div>
      )}
    </span>
  );
}

/** The Context Window panel's contents, the same in the popover and in Model Settings. */
function ContextWindowFigures({ session, resolution, fill, used }: {
  session: SessionView;
  resolution: ContextWindowCapacity;
  fill: ReturnType<typeof computeContextFill>;
  used: number;
}) {
  const contextWindow = resolution.capacity!;
  const discrepancy = contextWindowDiscrepancy(resolution.advertised, resolution.served);
  const remaining = Math.max(0, contextWindow - used);
  const compaction = session.driver ? compactionNotice(session.driver, fill.tone, agentHarnessDriverLabel(session.driver)) : null;
  return (
    <>
      <div className="usage-popover-head">
        <strong className="usage-popover-title">Context Window</strong>
        <span className="usage-popover-figure">{fill.formatPct}</span>
      </div>
      <div className={`meter${contextToneClass(fill.tone)}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill.fillPct)} aria-label="Context Window Usage">
        <span style={{ width: `${fill.fillPct}%` }} />
      </div>
      <div className="usage-popover-section">
        <dl className="facts usage-facts">
          <div><dt>Used</dt><dd>{formatTokens(used)}</dd></div>
          <div><dt>Remaining</dt><dd>{formatTokens(remaining)}</dd></div>
          <div><dt>Window</dt><dd>{formatTokens(contextWindow)}</dd></div>
        </dl>
        {/* #806's capacity provenance stays: which window the meter is measuring against is an
            occupancy fact, unlike the session billing #781 moved out of this panel. */}
        <p className="usage-popover-note">
          {resolution.source === "served" ? "Window size reported by the provider." : "Window size from the model catalog."}
        </p>
      </div>
      {discrepancy && (
        <Notice tone="warning" compact role="status">
          {discrepancy.kind === "smaller"
            ? `The provider is serving a ${formatTokens(discrepancy.served)} context window, not the ${formatTokens(discrepancy.advertised)} the selected model advertises. The meter uses the served size.`
            : `The provider is serving a ${formatTokens(discrepancy.served)} context window; the selected model advertises ${formatTokens(discrepancy.advertised)}. The meter uses the served size.`}
        </Notice>
      )}
      {compaction
        ? <Notice tone={compaction.tone} compact>{compaction.text}</Notice>
        : <p className="usage-popover-note">{compactionNote(session.driver)}</p>}
    </>
  );
}

/**
 * The Context Window panel shown in Model Settings' place when its Context Window row is opened
 * (#2447), so the phone reaches the window's source, what is left and how the driver compacts,
 * as the bar's ring does. Renders nothing while the window is unknown or nothing is used yet.
 */
export function ContextWindowBreakdown({ session, resolution }: { session: SessionView; resolution: ContextWindowCapacity }) {
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow: resolution.capacity,
  });
  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  if (!fill.known || used <= 0) return null;
  return (
    <div className="usage-figures" role="group" aria-label="Context Window">
      <ContextWindowFigures session={session} resolution={resolution} fill={fill} used={used} />
    </div>
  );
}
