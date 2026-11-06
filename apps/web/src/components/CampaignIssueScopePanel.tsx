import React, { useEffect, useId, useRef, useState } from "react";
import type { CampaignIssueScopeSnapshot, CampaignIssueScopeView, SessionView } from "@wollipog/protocol";
import { browserRandomUUID } from "../browser-crypto.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { useApi } from "../api-context.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { CampaignScopeGrantSection, ScopeGrantReviewFacts } from "./CampaignScopeGrant.js";
import { CampaignScopeProposalSection, ScopeProposalFacts } from "./CampaignScopeProposal.js";

const issueCount = (count: number) => `${count} issue${count === 1 ? "" : "s"}`;

/** Why an Orchestrator's proposal waits for the owner (#4267), and what approving or denying does to
 * the scope and its Maximum Issues. */
function ScopeOwnerReviewFacts({ review }: { review: NonNullable<CampaignIssueScopeSnapshot["ownerReview"]> }) {
  const raise = review.maxIssuesIncrease;
  return <p>
    The Orchestrator proposed this change. No authorized epic, published follow-up or issue selection admits it, so it needs your approval.
    {raise
      ? ` It needs ${issueCount(raise.increase)} more than Maximum Issues allows. Approving adds the issues and raises Maximum Issues from ${raise.from} to ${raise.from + raise.increase}; denying leaves both unchanged.`
      : " Denying leaves the scope unchanged."}
  </p>;
}

export function CampaignIssueScopeSummary({ snapshot }: { snapshot: CampaignIssueScopeSnapshot }) {
  const refs = (numbers: number[]) => numbers.length ? numbers.map((n) => `${snapshot.repository}#${n}`).join(", ") : "None";
  const raise = snapshot.ownerReview?.maxIssuesIncrease;
  return <>
    {snapshot.grantReview && <ScopeGrantReviewFacts review={snapshot.grantReview} />}
    {snapshot.ownerReview && <ScopeOwnerReviewFacts review={snapshot.ownerReview} />}
    {snapshot.scopeProposal ? <ScopeProposalFacts repository={snapshot.repository} proposal={snapshot.scopeProposal} explanation={snapshot.explanation} />
      : <p>{snapshot.explanation}</p>}
    <dl className="facts">
      <div><dt>Scope Revision</dt><dd>{snapshot.expectedRevision} to {snapshot.expectedRevision + 1}</dd></div>
      {raise && <div><dt>Maximum Issues</dt><dd>{raise.from} to {raise.from + raise.increase}</dd></div>}
      <div><dt>Additions</dt><dd>{refs(snapshot.additions)}</dd></div>
      <div><dt>Removals</dt><dd>{refs(snapshot.removals)}</dd></div>
      <div><dt>Affected Assignments</dt><dd>{snapshot.affectedAssignments.length ? snapshot.affectedAssignments.map((a) => `${snapshot.repository}#${a.issue}: ${a.sessionId}`).join(", ") : "None"}</dd></div>
      <div><dt>Active Child Work</dt><dd>{snapshot.activeChildren.length ? snapshot.activeChildren.map((child) => `${child.title}: ${child.sessionId}`).join(", ") : "None"}</dd></div>
      <div><dt>Decisions to Revoke</dt><dd>{snapshot.affectedDecisions.length ? snapshot.affectedDecisions.join(", ") : "None"}</dd></div>
    </dl>
    <p>Approval changes campaign authority. Active children may hold issue work even when no ledger assignment is recorded. Existing assignments keep their history; work outside the new scope needs a separate scope approval. Outstanding decisions listed above are revoked. Issue closure still requires its own human approval.</p>
  </>;
}

/** How often a panel showing a disconnected runner's saved scope checks for reconnection. */
export const SCOPE_RECONNECT_POLL_MS = 10_000;

export function CampaignIssueScopePanel({ session, campaignId, policyRevision }: {
  session: SessionView;
  campaignId: string;
  /** The campaign's policy revision, given only on the campaign's own session: the owner can then
   * change the scope grant's selection count there (#4102), and a new revision reloads the scope. */
  policyRevision?: number;
}) {
  const api = useApi();
  const headingId = useId();
  const [view, setView] = useState<CampaignIssueScopeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [additions, setAdditions] = useState("");
  const [removals, setRemovals] = useState("");
  const [epic, setEpic] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const revision = session.orchestratorPolicy?.issueScope?.revision ?? 0;
  const context = view?.contextIssueNumbers ?? [];
  // The owner selects context references in a group below; anyone else reads them as a fact row.
  const selectable = context.length > 0 && Boolean(view?.supported && view.canPropose);
  const contextLabelId = useId();
  const contextHelpId = useId();
  const reading = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    reading.current = true;
    void api.campaignIssueScope(campaignId, undefined, controller.signal).then((next) => {
      if (!controller.signal.aborted) { reading.current = false; setView(next); setPending(false); setSelected([]); }
    }).catch((e: unknown) => { if (!controller.signal.aborted) { reading.current = false; setError(e instanceof Error ? e.message : "Could not load campaign issue scope."); } });
    return () => controller.abort();
    // A change to the campaign's authority (such as another tab's selection count) reloads it too.
  }, [api, campaignId, revision, policyRevision, reload]);
  // A disconnected runner leaves the revision unchanged when it returns, so poll the saved scope
  // (no runner call) until the view verifies again (#2664). A returning tab refreshes at once. A
  // poll never replaces a read still in flight: a reconnected runner's inspection can outlast it.
  const disconnected = Boolean(view?.runnerDisconnected);
  useEffect(() => {
    if (!disconnected) return;
    const poll = () => { if (document.visibilityState !== "hidden" && !reading.current) setReload((n) => n + 1); };
    const timer = window.setInterval(poll, SCOPE_RECONNECT_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [disconnected]);
  const refreshButton = <button className="btn sm" type="button" onClick={() => setReload((n) => n + 1)}>Refresh Scope</button>;
  const unverified = view?.unverifiedWork ?? [];

  const parse = (text: string) => {
    const result = text.split(/[\s,]+/u).filter(Boolean).map((ref) => {
      const match = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/u.exec(ref);
      if (!match || !Number.isSafeInteger(Number(match[2])) || match[1]!.toLowerCase() !== view?.repository.toLowerCase()) {
        throw new Error(`Use repository-qualified issues from ${view?.repository}, such as ${view?.repository}#123.`);
      }
      return Number(match[2]);
    });
    return [...new Set(result)];
  };
  const propose = async () => {
    if (!view || busy) return;
    setBusy(true); setError(null);
    try {
      const add = [...new Set([...selected, ...parse(additions)])].filter((n) => !view.issueNumbers.includes(n));
      const remove = parse(removals);
      if (!add.length && !remove.length) throw new Error("Select at least one issue addition or removal.");
      await api.proposeCampaignIssueScope(campaignId, { requestId: browserRandomUUID(), expectedRevision: view.revision,
        additions: add.map((number) => ({ repository: view.repository, number })), removals: remove.map((number) => ({ repository: view.repository, number })),
        explanation: "Update the campaign's authorized issue scope with the exact additions and removals shown in this request." });
      setPending(true); setSelected([]); setAdditions(""); setRemovals("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not request scope approval."); }
    finally { setBusy(false); }
  };
  const resolveEpic = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (!/^[1-9][0-9]*$/u.test(epic) || !Number.isSafeInteger(Number(epic))) throw new Error("Enter a positive epic issue number.");
      const next = await api.campaignIssueScope(campaignId, Number(epic));
      setView(next); setSelected([]);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not resolve epic members."); }
    finally { setBusy(false); }
  };
  // Only the owner, who can propose scope here, can change the count; the server checks again.
  // The change is compare-and-set against the revision this view was read at, never a newer one, so
  // a change made from a stale view is refused instead of overwriting another one.
  const grantEdit = view?.canPropose && policyRevision !== undefined && view.policyRevision !== undefined
    ? { campaignId, policyRevision: view.policyRevision, onSaved: () => setReload((n) => n + 1) } : undefined;
  // A new revision remounts the section, closing an editor opened on the older one.
  // Under the propose-then-check flow (#4282) the Orchestrator's proposals replace the Scope Grant.
  return <>{view?.scopeGrant && (view.scopeGrant.status === "proposal"
    ? <CampaignScopeProposalSection grant={view.scopeGrant} proposals={view.scopeProposals ?? []} />
    : <CampaignScopeGrantSection key={view.policyRevision} grant={view.scopeGrant} edit={grantEdit} />)}
  <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Authorized Issue Scope</h3>
    {error && <Notice tone="danger" role="alert" title="Couldn't Load or Update Issue Scope"
      actions={refreshButton}>{error}</Notice>}
    {view ? <>
      <dl className="facts">
        <div><dt>Repository</dt><dd>{view.repository || "Not Verified"}</dd></div>
        <div><dt>Scope Revision</dt><dd>{view.revision}</dd></div>
        <div><dt>Authorized Issues</dt><dd>{view.issueNumbers.length ? view.issueNumbers.map((n) => `${view.repository}#${n}`).join(", ") : "None"}</dd></div>
        {context.length > 0 && !selectable && <div><dt>Context-Only References</dt><dd>{context.map((n) => `${view.repository}#${n}`).join(", ")}</dd></div>}
      </dl>
      {view.candidateMessage && <Notice tone="warning" title="Epic Members Need Review">{view.candidateMessage}</Notice>}
      {!view.repository && view.issueNumbers.length > 0 && <Notice tone="info" title="Repository Not Verified">
        The saved issue numbers are shown without a repository because this campaign never recorded one. They are not confirmed to belong to any repository until the campaign runner verifies it.
      </Notice>}
      {unverified.length > 0 && <Notice tone="neutral" title="Work Awaiting Repository Verification">
        <ul className="campaign-detail-list">{unverified.map((item) => <li key={item.workItemId}>{item.issue.repository}#{item.issue.number}: {item.title}</li>)}</ul>
        Their issue numbers are in the saved scope, but the campaign repository is not verified, so this work is neither confirmed in scope nor outside it.
      </Notice>}
      {!view.issueNumbers.length && <Notice tone="info" title="Issue Scope Needs Confirmation">Confirm the umbrella issue and intended members before delegating issue work. Recorded work and issue mentions do not grant authority.</Notice>}
      {view.outsideScope.length > 0 && <Notice tone="warning" title="Work Outside Authorized Scope">
        <ul className="campaign-detail-list">{view.outsideScope.map((item) => <li key={item.workItemId}>{item.issue.repository}#{item.issue.number}: {item.title}</li>)}</ul>
        Add the intended issues through a scope approval to enable their closure requests.
      </Notice>}
      {!view.supported ? <Notice tone="neutral" title="Scope Changes Unavailable" actions={error ? undefined : refreshButton}>{view.compatibilityMessage}</Notice> : view.canPropose ? <>
        {view.candidates && view.candidates.length > 0 && <fieldset className="field"><legend>Proposed Epic Members</legend>
          <p>Choose the umbrella issue and intended members. Dependencies and incidental references are excluded.</p>
          <ul className="campaign-detail-list">{view.candidates.map((candidate) => <li key={candidate.issue.number}><Checkbox
            checked={selected.includes(candidate.issue.number)} disabled={view.issueNumbers.includes(candidate.issue.number) || busy}
            label={`${candidate.issue.repository}#${candidate.issue.number}`} helper={candidate.title}
            onChange={(checked) => setSelected((current) => checked ? [...current, candidate.issue.number] : current.filter((n) => n !== candidate.issue.number))}
          /></li>)}</ul>
        </fieldset>}
        {selectable && <div className="field" role="group" aria-labelledby={contextLabelId} aria-describedby={contextHelpId}>
          <span id={contextLabelId}>Context-Only References</span>
          <p className="field-helper" id={contextHelpId}>The first message mentioned these issues without asking the campaign to work on them, so they grant no authority. Select any to add them through scope approval.</p>
          <ul className="campaign-detail-list">{context.map((n) => <li key={n}><Checkbox
            checked={selected.includes(n)} disabled={busy} label={`${view.repository}#${n}`}
            onChange={(checked) => setSelected((current) => checked ? [...current, n] : current.filter((value) => value !== n))}
          /></li>)}</ul>
        </div>}
        <label className="field"><span>Epic Issue Number</span><input type="text" inputMode="numeric" value={epic} onChange={(e) => setEpic(e.target.value)} disabled={busy} /></label>
        <BusyButton className="btn ghost sm" busy={busy} progress="Resolving epic members…" onClick={() => void resolveEpic()}>Resolve Epic Members</BusyButton>
        <label className="field"><span>Issue Additions</span><input type="text" value={additions} onChange={(e) => setAdditions(e.target.value)} disabled={busy} /></label>
        <label className="field"><span>Issue Removals</span><input type="text" value={removals} onChange={(e) => setRemovals(e.target.value)} disabled={busy} /></label>
        <p>Enter repository-qualified issues separated by commas, such as {view.repository}#123. Review the exact change and affected assignments in the approval request.</p>
        <BusyButton className="btn sm" busy={busy} progress="Requesting scope approval…" onClick={() => void propose()}>Request Scope Approval</BusyButton>
        <button className="btn ghost sm" type="button" onClick={() => setReload((n) => n + 1)}>Refresh Scope</button>
        {pending && <p role="status">Scope is unchanged. Review the exact additions and removals in the campaign's approval request.</p>}
      </> : <p>Only the campaign owner can request issue scope changes here.</p>}
    </> : !error && <p role="status">Loading authorized issue scope…</p>}
  </section></>;
}
