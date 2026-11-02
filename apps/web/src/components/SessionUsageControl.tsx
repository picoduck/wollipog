import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentModel, SessionUsageResponse, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatCost, formatTokens, resolvedModelLabel } from "../format.js";
import { costProvenanceNote, estimatedCostSourceUrl, inputTokenBasis, RUNNING_COUNTERS_BASIS_NOTE, sessionCostLabel,
  sessionUsageTotals } from "../session-cost.js";
import { useLiveSession, useOptionalNavigate } from "../store.js";
import { useAnchoredPopover } from "./anchored-popover.js";
import { ComposerButton } from "./ComposerControls.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";

/**
 * The usage behind a session's cost: its ledger, fetched each time `open` turns true and again on
 * Retry, and the label and totals that the trigger and the panel share.
 */
function useSessionUsageDetail(session: SessionView, open: boolean) {
  const api = useApi();
  const [breakdown, setBreakdown] = useState<SessionUsageResponse | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedFor = useRef<string | null>(null);

  const loadBreakdown = useCallback(async () => {
    // Refetch per open: usage moves while a session runs, and the panel is where it is read.
    setLoading(true);
    try {
      const next = await api.sessionUsage(session.id);
      loadedFor.current = session.id;
      setBreakdown(next);
      setBreakdownError(null);
    } catch (cause) {
      setBreakdownError(cause instanceof Error ? cause.message : "Unable to load usage by model");
    } finally {
      setLoading(false);
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
  return {
    totals,
    loaded,
    breakdownError,
    loading,
    retry: loadBreakdown,
    label: sessionCostLabel(session, loaded),
  };
}

type SessionUsageDetail = ReturnType<typeof useSessionUsageDetail>;
type LabelledDetail = SessionUsageDetail & { label: NonNullable<SessionUsageDetail["label"]> };

/** A ledger row's model by the name the agent's catalog gives it; the exact id is its tooltip. */
function modelName(id: string, models: readonly AgentModel[] | undefined): string {
  return models?.find((model) => model.id === id)?.displayName ?? resolvedModelLabel(id);
}

const UNPRICED = "Unpriced";

/**
 * The Session Cost panel's contents, the same in the popover and in Model Settings (#3017): the
 * figure, one table by model with a Total row, the token buckets behind a closed Token Breakdown,
 * and a footer naming the rates with the way to Usage and Cost.
 */
function SessionCostFigures({ session, models, detail }: {
  session: SessionView;
  models: readonly AgentModel[] | undefined;
  detail: LabelledDetail;
}) {
  const { totals, loaded, breakdownError, loading, retry, label } = detail;
  const navigate = useOptionalNavigate();
  const priced = label.priced;
  const provenanceUrl = priced ? estimatedCostSourceUrl(loaded) : null;
  const provenance = priced && !provenanceUrl ? costProvenanceNote(loaded) : null;
  const byModel = loaded?.byModel ?? [];
  // A priced zero is an amount, not a gap. The shared label has already chosen between the
  // current session snapshot and a caught-up ledger, so use that same provenance decision while
  // detail is pending, failed, or stale instead of making the heading disagree with the control.
  const headCost = formatCost(totals.costUsd) || "$0.00";
  // A cost the provider reported without any token counts has nothing to break down: no table of
  // zeroes under a model named "unknown".
  const tokensReported = totals.processedTokens > 0;
  const basis = !totals.detailed ? inputTokenBasis(session.driver) : undefined;
  const live = session.liveUsage && session.liveUsage.tokensIn + session.liveUsage.tokensOut > 0 ? session.liveUsage : null;

  return (
    <>
      <div className="usage-popover-head">
        <strong className="usage-popover-title">Session Cost</strong>
        {priced
          ? <span className="usage-popover-figure">{headCost}</span>
          : <StatusBadge tone="neutral" noDot label={UNPRICED} />}
      </div>
      {!priced && (
        <p className="usage-popover-note">No rate is known for these models, so the cost isn't estimated. Token counts are exact.</p>
      )}
      {!tokensReported ? (
        <p className="usage-popover-note">The provider reported this cost but no token counts, so there is no breakdown by model.</p>
      ) : byModel.length > 0 ? (
        <table className="table compact usage-table">
          <colgroup>
            <col />
            <col className="usage-table-tokens" />
            <col className="usage-table-cost" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" className="num">Tokens</th>
              <th scope="col" className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {byModel.map((row) => (
              <tr key={row.model}>
                <th scope="row" title={row.model}>{modelName(row.model, models)}</th>
                <td className="num">{formatTokens(row.processedTokens)}</td>
                {/* Named as unpriced when the rate table could not price the model, rather than
                    a misleading $0.00. A row that WAS priced states its amount even when that
                    amount is zero, because a free model costing nothing is a fact. */}
                <td className="num">{!priced || row.costSource === "unpriced" ? UNPRICED : formatCost(row.costUsd) || "$0.00"}</td>
              </tr>
            ))}
            {/* A running Claude turn's completed requests are in the totals but in no ledger row
                yet (#3086), so they get their own row and the rows still add up to the Total. */}
            {live && (
              <tr>
                <th scope="row" className="cell-dim">Running Turn</th>
                <td className="num cell-dim">{formatTokens(live.tokensIn + live.tokensOut)}</td>
                {/* A live estimate of zero means the turn's model has no rate yet, not that it is free. */}
                <td className="num cell-dim">{!priced || live.costUsd <= 0 ? UNPRICED : formatCost(live.costUsd)}</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="num">{formatTokens(totals.processedTokens)}</td>
              <td className="num">{priced ? headCost : UNPRICED}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        // Until the breakdown answers, or when it cannot, the processed total stays in view.
        <dl className="facts usage-facts">
          <div><dt>Tokens</dt><dd>{formatTokens(totals.processedTokens)}</dd></div>
        </dl>
      )}
      {breakdownError && (
        <Notice
          tone="danger"
          compact
          role="alert"
          actions={<button type="button" className="btn sm" disabled={loading} onClick={() => void retry()}>Retry</button>}
          details={<p>{breakdownError}</p>}
        >
          Couldn't load the breakdown by model.
        </Notice>
      )}
      {tokensReported && (
        <details className="disclosure usage-disclosure">
          <summary><ChevronRightIcon size={14} className="disclosure-chevron" />Token Breakdown</summary>
          <div className="disclosure-body">
            <dl className="facts usage-facts">
              <div><dt>Input</dt><dd>{formatTokens(totals.inputTokens)}</dd></div>
              <div><dt>Output</dt><dd>{formatTokens(totals.outputTokens)}</dd></div>
              {/* Progressive disclosure: a bucket appears only when the runner reported it, so an
                  older runner's records never grow rows of invented zeroes. */}
              {totals.cachedInputTokens > 0 && <div><dt>Cache Read</dt><dd>{formatTokens(totals.cachedInputTokens)}</dd></div>}
              {totals.cacheCreationTokens > 0 && <div><dt>Cache Write</dt><dd>{formatTokens(totals.cacheCreationTokens)}</dd></div>}
              {totals.reasoningTokens > 0 && <div><dt>Reasoning</dt><dd>{formatTokens(totals.reasoningTokens)}</dd></div>}
              {totals.cacheSavingsUsd > 0 && <div><dt>Cache Savings</dt><dd>{formatCost(totals.cacheSavingsUsd)}</dd></div>}
            </dl>
            {/* The running counters keep the provider's meaning of input until the breakdown
                separates cached input for every driver (#3086). */}
            {basis && <p className="usage-popover-note">{RUNNING_COUNTERS_BASIS_NOTE[basis]}</p>}
            {session.driver === "codex-app-server" && (
              <p className="usage-popover-note">Codex App Server usage recorded before the machine's Wollipog update counts only the final response of each turn, so older figures are incomplete.</p>
            )}
          </div>
        </details>
      )}
      <div className="usage-popover-foot">
        {provenanceUrl ? (
          <p className="usage-popover-note">
            Estimated API cost at <a className="link" href={provenanceUrl} target="_blank" rel="noreferrer">published rates</a>.
            {loaded?.pricing?.status === "cached" && " Cached rates."}
          </p>
        ) : provenance && <p className="usage-popover-note">{provenance}</p>}
        {navigate && <button type="button" className="btn sm ghost" onClick={() => navigate({ name: "usage" })}>Usage and Cost</button>}
      </div>
    </>
  );
}

/**
 * The Session Cost panel shown in Model Settings' place when its Session Cost row is opened
 * (#2447): the way to the per-model split, the pricing source and the Codex App Server note while
 * the composer bar has no room for the cost trigger. It fetches the ledger as it opens, as the
 * popover does, and renders nothing for a session that has processed nothing.
 */
export function SessionUsageBreakdown({ session, models }: { session: SessionView; models?: readonly AgentModel[] }) {
  const detail = useSessionUsageDetail(session, true);
  const { label } = detail;
  if (!label) return null;
  return (
    <div className="usage-figures" role="group" aria-label="Session Cost">
      <SessionCostFigures session={session} models={models} detail={{ ...detail, label }} />
    </div>
  );
}

/**
 * The session's cumulative cost, and the usage behind it (#781): the composer bar's trailing
 * trigger (#2166), a borderless small ghost button.
 *
 * The trigger shows one figure — what this session has cost, or for usage nobody could price its
 * token count — because that is the only usage number worth a permanent seat. Everything else (the
 * split by model, the token buckets, where the price came from) lives in the popover the trigger
 * opens. This is deliberately NOT the context meter: that answers "how full is the model's window
 * right now", this answers "what has this session accumulated", and neither repeats the other.
 *
 * Renders nothing for a session that has processed nothing.
 */
export function SessionUsageControl({ session: rendered, models }: { session: SessionView; models?: readonly AgentModel[] }) {
  // Usage and cost move with every streamed event; the session view does not render for that (#2872).
  const session = useLiveSession(rendered);
  const popover = useAnchoredPopover<HTMLSpanElement, HTMLButtonElement>({ width: 340, height: 360 });
  const panelId = useId();
  const detail = useSessionUsageDetail(session, popover.open);
  const { label } = detail;
  if (!label) return null;

  return (
    <span className={`session-usage${popover.open ? " is-open" : ""}`} ref={popover.rootRef}>
      <ComposerButton
        ref={popover.anchorRef}
        className="cbar-usage"
        aria-expanded={popover.open}
        aria-controls={panelId}
        aria-label={label.ariaLabel}
        title={label.priced ? `Session usage — ${label.text} so far` : `Session usage — ${label.text} so far, unpriced`}
        // ComposerButton keeps the composer focused through the press; the trigger takes focus
        // once the click lands, so Escape closes the panel and returns here (#1796).
        onClick={(event) => {
          event.currentTarget.focus();
          popover.toggle();
        }}
      >
        {label.text}
      </ComposerButton>
      {popover.open && (
        <div
          className="usage-popover session-usage-popover"
          id={panelId}
          role="group"
          aria-label="Session Cost"
          style={popover.style}
        >
          <SessionCostFigures session={session} models={models} detail={{ ...detail, label }} />
        </div>
      )}
    </span>
  );
}
