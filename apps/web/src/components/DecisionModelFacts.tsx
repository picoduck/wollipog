import type { DecisionOccurrenceView } from "@wollipog/protocol";
import { effortLabel } from "../format.js";
import { decisionAnsweredBy, decisionModelName } from "./decision-model.js";

/**
 * A Decision record's two model facts, as rows of its `dl.facts` (#4367): the target the setting
 * chose, and the exact model the provider reported answering. A record with neither has no rows.
 */
export function DecisionModelFacts({ decision }: { decision: Pick<DecisionOccurrenceView, "target" | "attempts"> }) {
  const { target } = decision;
  const answeredBy = decisionAnsweredBy(decision);
  return (
    <>
      {target && (
        <div>
          <dt>Target Model</dt>
          <dd>
            {decisionModelName(target)}, {effortLabel(target.effort)} effort
            <span className="campaign-status-meta">
              {target.harnessName} on {target.machineName}
              {target.source === "automatic" ? " (Automatic)" : ""}
            </span>
          </dd>
        </div>
      )}
      {answeredBy && <div><dt>Answered By</dt><dd>{answeredBy}</dd></div>}
    </>
  );
}
