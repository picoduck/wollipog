import React, { useEffect, useId, useState } from "react";
import type { CampaignIssueScopeSnapshot, CampaignIssueScopeView, SessionView } from "@wollipog/protocol";
import { browserRandomUUID } from "../browser-crypto.js";
import { Checkbox } from "./ui/ChoiceControls.js";
import { useApi } from "../api-context.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

export function CampaignIssueScopeSummary({ snapshot }: { snapshot: CampaignIssueScopeSnapshot }) {
  const refs = (numbers: number[]) => numbers.length ? numbers.map((n) => `${snapshot.repository}#${n}`).join(", ") : "None";
  return <>
    <p>{snapshot.explanation}</p>
    <dl className="facts">
      <div><dt>Scope Revision</dt><dd>{snapshot.expectedRevision} to {snapshot.expectedRevision + 1}</dd></div>
      <div><dt>Additions</dt><dd>{refs(snapshot.additions)}</dd></div>
      <div><dt>Removals</dt><dd>{refs(snapshot.removals)}</dd></div>
      <div><dt>Affected Assignments</dt><dd>{snapshot.affectedAssignments.length ? snapshot.affectedAssignments.map((a) => `${snapshot.repository}#${a.issue}: ${a.sessionId}`).join(", ") : "None"}</dd></div>
      <div><dt>Active Child Work</dt><dd>{snapshot.activeChildren.length ? snapshot.activeChildren.map((child) => `${child.title}: ${child.sessionId}`).join(", ") : "None"}</dd></div>
      <div><dt>Decisions to Revoke</dt><dd>{snapshot.affectedDecisions.length ? snapshot.affectedDecisions.join(", ") : "None"}</dd></div>
    </dl>
    <p>Approval changes campaign authority. Active children may hold issue work even when no ledger assignment is recorded. Existing assignments keep their history; work outside the new scope needs a separate scope approval. Outstanding decisions listed above are revoked. Issue closure still requires its own human approval.</p>
  </>;
}

export function CampaignIssueScopePanel({ session, campaignId }: { session: SessionView; campaignId: string }) {
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
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api.campaignIssueScope(campaignId, undefined, controller.signal).then((next) => {
      if (!controller.signal.aborted) { setView(next); setPending(false); setSelected([]); }
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load campaign issue scope."); });
    return () => controller.abort();
  }, [api, campaignId, revision, reload]);

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
  return <section className="campaign-detail-section" aria-labelledby={headingId}>
    <h3 id={headingId} className="section-title">Authorized Issue Scope</h3>
    {error && <Notice tone="danger" role="alert" title="Couldn't Load or Update Issue Scope"
      actions={<button className="btn sm" type="button" onClick={() => setReload((n) => n + 1)}>Refresh Scope</button>}>{error}</Notice>}
    {view ? <>
      <dl className="facts">
        <div><dt>Repository</dt><dd>{view.repository || "Not Verified"}</dd></div>
        <div><dt>Scope Revision</dt><dd>{view.revision}</dd></div>
        <div><dt>Authorized Issues</dt><dd>{view.issueNumbers.length ? view.issueNumbers.map((n) => `${view.repository}#${n}`).join(", ") : "None"}</dd></div>
      </dl>
      {view.candidateMessage && <Notice tone="warning" title="Epic Members Need Review">{view.candidateMessage}</Notice>}
      {!view.issueNumbers.length && <Notice tone="info" title="Issue Scope Needs Confirmation">Confirm the umbrella issue and intended members before delegating issue work. Recorded work and issue mentions do not grant authority.</Notice>}
      {view.outsideScope.length > 0 && <Notice tone="warning" title="Work Outside Authorized Scope">
        <ul className="campaign-detail-list">{view.outsideScope.map((item) => <li key={item.workItemId}>{item.issue.repository}#{item.issue.number}: {item.title}</li>)}</ul>
        Add the intended issues through a scope approval to enable their closure requests.
      </Notice>}
      {!view.supported ? <Notice tone="neutral" title="Scope Changes Unavailable">{view.compatibilityMessage}</Notice> : view.canPropose ? <>
        {view.candidates && view.candidates.length > 0 && <fieldset className="field"><legend>Proposed Epic Members</legend>
          <p>Choose the umbrella issue and intended members. Dependencies and incidental references are excluded.</p>
          <ul className="campaign-detail-list">{view.candidates.map((candidate) => <li key={candidate.issue.number}><Checkbox
            checked={selected.includes(candidate.issue.number)} disabled={view.issueNumbers.includes(candidate.issue.number) || busy}
            label={`${candidate.issue.repository}#${candidate.issue.number}`} helper={candidate.title}
            onChange={(checked) => setSelected((current) => checked ? [...current, candidate.issue.number] : current.filter((n) => n !== candidate.issue.number))}
          /></li>)}</ul>
        </fieldset>}
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
  </section>;
}
