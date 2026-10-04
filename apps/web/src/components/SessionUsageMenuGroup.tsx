import { useEffect, useId, type ReactNode } from "react";
import type { SessionView } from "@wollipog/protocol";
import { computeContextFill } from "../context-meter.js";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { formatContextWindow } from "../context-window-options.js";
import { sessionCostLabel } from "../session-cost.js";
import { ContextRing, ContextWindowBreakdown, contextToneClass } from "./ContextWindowMeter.js";
import { ChevronRightIcon } from "./Icons.js";
import { MenuLabel, MenuSeparator } from "./Menu.js";
import { useModelSettingsDetail, type ModelSettingsDetail } from "./model-settings-detail.js";
import { SessionUsageBreakdown } from "./SessionUsageControl.js";

/** One figure's row: named by its label, described by its value, and opening its breakdown. */
function SessionUsageRow({ detail, label, ringTone, unpriced = false, children }: {
  detail: ModelSettingsDetail;
  label: string;
  /** For the ring's row, its tone class (`contextToneClass`), which the ring's fill reads. */
  ringTone?: string;
  unpriced?: boolean;
  children: ReactNode;
}) {
  const controller = useModelSettingsDetail();
  const id = useId();
  return (
    <button
      type="button"
      className="menu-item"
      data-model-settings-detail={detail}
      aria-labelledby={`${id}-label`}
      aria-describedby={`${id}-value`}
      onClick={() => controller?.open(detail)}
    >
      <span className="menu-body">
        <span className="menu-text" id={`${id}-label`}>{label}</span>
      </span>
      <span
        className={`session-usage-group-value${ringTone === undefined ? "" : ` context-control${ringTone}`}${unpriced ? " is-unpriced" : ""}`}
        id={`${id}-value`}
      >
        {children}
      </span>
      <span className="menu-trail" aria-hidden="true"><ChevronRightIcon size={14} /></span>
    </button>
  );
}

/**
 * The Session Usage group at the top of Model Settings (#2166), shown only while the composer bar
 * has no room for the context and cost triggers. It states the same two figures the triggers do —
 * the context window's ring, percentage and "72K of 200K", then the session cost — and each row
 * opens the breakdown its trigger's popover holds in Model Settings' place (#2447), which this
 * component then renders. Renders nothing for a session without usage yet, so Model Settings
 * opens on its model choices as before.
 */
export function SessionUsageMenuGroup({ session, resolution }: {
  session: SessionView;
  resolution: ContextWindowCapacity;
}) {
  const controller = useModelSettingsDetail();
  const fill = computeContextFill({
    tokensIn: session.tokensIn,
    tokensOut: session.tokensOut,
    usedTokens: session.contextTokensUsed,
    contextWindow: resolution.capacity,
  });
  const cost = sessionCostLabel(session);
  const used = session.contextTokensUsed ?? (session.tokensIn + session.tokensOut);
  // The same rule as the bar's ring: no context row before the session has used any.
  const context = fill.known && used > 0;
  const detail = controller?.detail ?? null;
  // A breakdown whose figure has gone (the window became unknown) returns to the choices.
  const stale = (detail === "context-window" && !context) || (detail === "session-cost" && !cost);
  useEffect(() => {
    if (stale) controller?.back();
  }, [stale, controller]);
  if (detail === "context-window" && context) return <ContextWindowBreakdown session={session} resolution={resolution} />;
  if (detail === "session-cost" && cost) return <SessionUsageBreakdown session={session} />;
  if (!context && !cost) return null;
  return (
    <>
      <div role="group" aria-label="Session Usage">
        <MenuLabel>Session Usage</MenuLabel>
        {context && (
          <SessionUsageRow detail="context-window" label="Context Window" ringTone={contextToneClass(fill.tone)}>
            <ContextRing fillPct={fill.fillPct} size={14} />
            <span>{fill.formatPct}</span>
            <span className="session-usage-group-capacity">
              {formatContextWindow(used)} of {formatContextWindow(resolution.capacity!)}
            </span>
          </SessionUsageRow>
        )}
        {cost && (
          <SessionUsageRow detail="session-cost" label="Session Cost" unpriced={!cost.priced}>
            {cost.priced ? cost.text : (
              // The placeholder glyph must not read as an amount, to the eye or to a screen reader.
              <>
                <span aria-hidden="true">{cost.text}</span>
                <span className="sr-only">Cost Unavailable</span>
              </>
            )}
          </SessionUsageRow>
        )}
      </div>
      <MenuSeparator />
    </>
  );
}
