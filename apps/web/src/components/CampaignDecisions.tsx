import React, { useEffect, useId, useState } from "react";
import type { CampaignDecisionsResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { effortLabel } from "../format.js";
import { decisionCostText, decisionOutcomeText, verdictLabel } from "./decision-model.js";

const SHOWN = 10;
const REFRESH_MS = 60_000;

/**
 * Campaign Status › Decision Model (#4101): the campaign's Decision calls, each with its verdict and
 * reason, and their usage, which is kept apart from the campaign's worker cost. Hidden until the
 * campaign has a decision; a read that fails leaves the rest of Campaign Status as it is.
 */
export function CampaignDecisions({ campaignId }: { campaignId: string }) {
  const api = useApi();
  const headingId = useId();
  const [data, setData] = useState<CampaignDecisionsResponse | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      void Promise.resolve().then(() => api.campaignDecisions(campaignId)).then((next) => {
        if (live) setData(next);
      }).catch(() => { /* Decisions are supplementary: keep the last answer, or none. */ });
    };
    setData(null);
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api, campaignId]);

  if (!data || !data.decisions.length) return null;
  const hidden = data.decisions.length - SHOWN;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Decision Model</h3>
      <p className="section-note">
        {data.usage.calls} {data.usage.calls === 1 ? "call" : "calls"}, {decisionCostText(data.usage)}. Not counted in the
        campaign's cost. Decision inputs go to the selected agent's provider.
      </p>
      <ul className="campaign-detail-list">
        {data.decisions.slice(0, SHOWN).map((decision) => (
          <li key={decision.occurrenceId}>
            <dl className="facts">
              <div><dt>Decision</dt><dd>{verdictLabel(decision.kind)}</dd></div>
              <div>
                <dt>Outcome</dt>
                <dd>
                  {decisionOutcomeText(decision)}
                  {decision.reason && <span className="campaign-status-meta">{decision.reason}</span>}
                </dd>
              </div>
              {decision.target && (
                <div>
                  <dt>Model</dt>
                  <dd>
                    {decision.target.model}, {effortLabel(decision.target.effort)} effort
                    <span className="campaign-status-meta">
                      {decision.target.harnessName} on {decision.target.machineName}
                      {decision.target.source === "automatic" ? " (Automatic)" : ""}
                    </span>
                  </dd>
                </div>
              )}
              <div>
                <dt>Usage</dt>
                <dd>
                  {decisionCostText(decision.usage)}
                  <span className="campaign-status-meta">
                    {decision.attempts.length} {decision.attempts.length === 1 ? "attempt" : "attempts"}
                  </span>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="section-note">{hidden} earlier {hidden === 1 ? "decision is" : "decisions are"} not shown.</p>}
    </section>
  );
}
