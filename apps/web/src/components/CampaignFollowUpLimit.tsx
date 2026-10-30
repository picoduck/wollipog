import React, { useId, useState } from "react";
import type { CampaignBudgetView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { followUpLimitText } from "../follow-up-limit.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox } from "./ui/ChoiceControls.js";

/** The largest limit the server accepts. */
const MAX_FOLLOW_UP_LIMIT = 1000;


/**
 * A Full Control campaign's follow-up approval limit (#2940): how many follow-ups the Orchestrator
 * starts on its own, the ones past it waiting for the person, and, on the campaign's own session,
 * the control that raises, lowers or clears it. The limit is a threshold, not a cap: past it each
 * follow-up is a request for the person, and lowering it never withdraws accepted work.
 */
export function CampaignFollowUpLimit({ campaignId, budget, policyRevision, canEdit, findRequest, onOpenRequest }: {
  campaignId: string;
  budget: CampaignBudgetView;
  policyRevision: number;
  /** Only the campaign's own session offers the edit control; the server checks the person. */
  canEdit: boolean;
  /** The Requests key of a pending approval when this session lists it, else null. */
  findRequest: (occurrenceId: string) => string | null;
  onOpenRequest: (requestKey: string) => void;
}) {
  const api = useApi();
  const headingId = useId();
  const limit = budget.authority.acceptedFollowUps;
  const approvals = budget.followUpApprovals ?? { pending: [], approved: 0 };
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(limit ?? ""));
  const [noLimit, setNoLimit] = useState(limit === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const atLimit = limit !== undefined && budget.acceptedFollowUps >= limit;

  const startEditing = () => {
    setValue(String(limit ?? Math.max(budget.acceptedFollowUps, 1)));
    setNoLimit(limit === undefined);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    if (busy) return;
    const next = noLimit ? null : Number(value.trim());
    if (next !== null && (!/^[0-9]+$/u.test(value.trim()) || next > MAX_FOLLOW_UP_LIMIT)) {
      setError(`Enter a whole number from 0 to ${MAX_FOLLOW_UP_LIMIT}, or choose No Limit.`);
      return;
    }
    setBusy(true); setError(null);
    try {
      await api.setCampaignFollowUpLimit(campaignId, next, policyRevision);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the follow-up limit.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Follow-Ups</h3>
    <dl className="facts">
      <div>
        <dt>Follow-Up Limit</dt>
        <dd>
          {followUpLimitText(budget.acceptedFollowUps, limit)}
          {atLimit && <span className="campaign-status-meta">The next follow-up needs your approval.</span>}
          {approvals.approved > 0 && <span className="campaign-status-meta">
            You approved {approvals.approved} follow-up{approvals.approved === 1 ? "" : "s"} past the limit.
          </span>}
        </dd>
      </div>
      <div>
        <dt>Awaiting Your Approval</dt>
        <dd>
          {approvals.pending.length === 0 ? "None" : <ul className="campaign-detail-list">
            {approvals.pending.map((pending) => {
              const requestKey = findRequest(pending.occurrenceId);
              return <li key={pending.occurrenceId}>
                {pending.title}
                {requestKey && <div><button className="btn sm" type="button" onClick={() => onOpenRequest(requestKey)}
                  aria-label={`Open Request: ${pending.title}`}>Open Request</button></div>}
              </li>;
            })}
          </ul>}
        </dd>
      </div>
    </dl>
    {canEdit && (editing ? <fieldset className="field">
      <legend>Change Follow-Up Limit</legend>
      <label className="field">
        <span>Follow-Ups Without Approval</span>
        <input type="text" inputMode="numeric" value={value} disabled={noLimit || busy}
          onChange={(event) => setValue(event.target.value)} />
      </label>
      <Checkbox checked={noLimit} disabled={busy} label="No Limit"
        helper="The Orchestrator starts every follow-up it accepts without asking."
        onChange={(checked) => setNoLimit(checked)} />
      <p>Past the limit, each follow-up waits for your approval. Lowering it keeps follow-ups already accepted.
        Saving re-authorizes Full Control. Any request or approval the Orchestrator hasn't used yet is withdrawn, and it asks again.</p>
      {error && <Notice tone="danger" role="alert" title="Couldn't Change the Follow-Up Limit">{error}</Notice>}
      <div>
        <BusyButton className="btn sm" busy={busy} progress="Saving limit…" onClick={() => void save()}>Save Limit</BusyButton>{" "}
        <button className="btn ghost sm" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </fieldset> : <div><button className="btn sm" type="button" onClick={startEditing}>Change Limit</button></div>)}
  </section>;
}
