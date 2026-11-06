import React, { useEffect, useId, useState } from "react";
import type { CampaignDecisionsResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { effortLabel } from "../format.js";
import { DecisionAnswerChecklist } from "./DecisionAnswerChecklist.js";
import { decisionCostText, decisionModelName, decisionOutcomeText, isDecisionModelCheck, verdictLabel } from "./decision-model.js";

const SHOWN = 10;
const REFRESH_MS = 60_000;

/**
 * Campaign Status › Decision Model (#4101): the campaign's Decision calls, each as its own group
 * with its outcome and reason, the model it ran on and its usage, which is kept apart from the
 * campaign's worker cost. Decisions Decision Model Checks lists beside their request
 * (`isDecisionModelCheck`) are not listed here a second time (#4265). Hidden until the campaign has
 * another decision; a read that fails leaves the rest of Campaign Status as it is.
 */
export function CampaignDecisions({ campaignId }: { campaignId: string }) {
  const api = useApi();
  const headingId = useId();
  const [data, setData] = useState<CampaignDecisionsResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void Promise.resolve().then(() => api.campaignDecisions(campaignId, controller.signal)).then((next) => {
        if (!controller.signal.aborted) setData(next);
      }).catch(() => { /* Decisions are supplementary: keep the last answer, or none. */ });
    };
    setData(null);
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, campaignId]);

  const decisions = data?.decisions.filter((decision) => !isDecisionModelCheck(decision)) ?? [];
  if (!data || !decisions.length) return null;
  const hidden = decisions.length - SHOWN;
  return (
    <section className="campaign-status-handoffs" aria-labelledby={headingId}>
      <h3 id={headingId} className="section-title">Decision Model</h3>
      <p className="section-note">
        {data.usage.calls} {data.usage.calls === 1 ? "call" : "calls"}, {decisionCostText(data.usage)}. Not counted in the
        campaign's cost. Decision inputs go to the selected agent's provider.
      </p>
      <ul className="campaign-decision-list" aria-label="Decisions">
        {decisions.slice(0, SHOWN).map((decision) => (
          <li key={decision.occurrenceId} className="campaign-decision-item">
            <dl className="facts">
              <div><dt>Decision</dt><dd>{verdictLabel(decision.kind)}</dd></div>
              <div>
                <dt>Outcome</dt>
                <dd>
                  {decisionOutcomeText(decision)}
                  {decision.reason && <span className="campaign-status-meta">{decision.reason}</span>}
                </dd>
              </div>
              {decision.typedAnswers && (
                <div>
                  <dt>Answers</dt>
                  <dd><DecisionAnswerChecklist typed={decision.typedAnswers} /></dd>
                </div>
              )}
              {decision.target && (
                <div>
                  <dt>Model</dt>
                  <dd>
                    {decisionModelName(decision.target)}, {effortLabel(decision.target.effort)} effort
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
