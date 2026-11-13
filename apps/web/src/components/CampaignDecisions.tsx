import { CampaignSection, useCampaignEntries } from "./CampaignSections.js";
import React, { useEffect, useState } from "react";
import type { CampaignDecisionsResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { DecisionAnswerChecklist } from "./DecisionAnswerChecklist.js";
import { DecisionModelFacts } from "./DecisionModelFacts.js";
import { decisionCostText, decisionOutcomeText, isDecisionModelCheck, verdictLabel } from "./decision-model.js";

const REFRESH_MS = 60_000;

/**
 * Campaign Status › Decision Model (#4101): the campaign's Decision calls, each as its own group
 * with its outcome and reason, the model it targeted and the one that answered, and its usage, kept apart from the
 * campaign's worker cost. Decisions Decision Model Checks lists beside their request
 * (`isDecisionModelCheck`) are not listed here a second time (#4265). Hidden until the campaign has
 * another decision; a read that fails leaves the rest of Campaign Status as it is.
 */
export function CampaignDecisions({ campaignId }: { campaignId: string }) {
  const api = useApi();
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
  const entries = useCampaignEntries(decisions);
  if (!data || !decisions.length) return null;
  return (
    <CampaignSection title="Decisions" count={decisions.length} className="campaign-status-handoffs">
      <p className="section-note">
        {data.usage.calls} {data.usage.calls === 1 ? "call" : "calls"}, {decisionCostText(data.usage)}. Not counted in the
        campaign's cost. Decision inputs go to the selected agent's provider.
      </p>
      <ul className="campaign-decision-list" aria-label="Decisions">
        {entries.visible.map((decision) => (
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
              <DecisionModelFacts decision={decision} />
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
      </ul>{entries.more}

    </CampaignSection>
  );
}
