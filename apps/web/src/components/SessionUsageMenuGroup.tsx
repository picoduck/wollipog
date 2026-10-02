import type { SessionView } from "@wollipog/protocol";
import { computeContextFill } from "../context-meter.js";
import type { ContextWindowCapacity } from "../context-window-capacity.js";
import { formatContextWindow } from "../context-window-options.js";
import { sessionCostLabel } from "../session-cost.js";
import { ContextRing, contextToneClass } from "./ContextWindowMeter.js";
import { MenuLabel, MenuSeparator } from "./Menu.js";

/**
 * The read-only Session Usage group at the top of Model Settings (#2166), shown only while the
 * composer bar has no room for the context and cost triggers. It states the same two figures the
 * triggers do — the context window's ring, percentage and "72K of 200K", then the session cost —
 * and nothing more: the breakdowns stay in the triggers' popovers. Renders nothing for a session
 * without usage yet, so Model Settings opens on its model choices as before.
 */
export function SessionUsageMenuGroup({ session, resolution }: {
  session: SessionView;
  resolution: ContextWindowCapacity;
}) {
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
  if (!context && !cost) return null;
  return (
    <>
      <div role="group" aria-label="Session Usage">
        <MenuLabel>Session Usage</MenuLabel>
        <dl className="session-usage-group-facts">
          {context && (
            <div>
              <dt>Context Window</dt>
              <dd className={`session-usage-group-context context-control${contextToneClass(fill.tone)}`}>
                <ContextRing fillPct={fill.fillPct} size={14} />
                <span>{fill.formatPct}</span>
                <span className="session-usage-group-capacity">
                  {formatContextWindow(used)} of {formatContextWindow(resolution.capacity!)}
                </span>
              </dd>
            </div>
          )}
          {cost && (
            <div>
              <dt>Session Cost</dt>
              {cost.priced ? <dd>{cost.text}</dd> : (
                // The placeholder glyph must not read as an amount, to the eye or to a screen reader.
                <dd className="is-unpriced">
                  <span aria-hidden="true">{cost.text}</span>
                  <span className="sr-only">Cost Unavailable</span>
                </dd>
              )}
            </div>
          )}
        </dl>
      </div>
      <MenuSeparator />
    </>
  );
}
