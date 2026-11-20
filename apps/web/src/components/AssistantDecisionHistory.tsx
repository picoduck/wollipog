import { useEffect, useState } from "react";
import { ASSISTANT_DECISION_CATEGORIES, type AssistantDecisionHistoryPage } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { formatCalendarTime } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { CampaignSection } from "./CampaignSections.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";

type HistoryState = { kind: "loading" } | { kind: "ready"; page: AssistantDecisionHistoryPage } | { kind: "error" };

function DecisionHistory({ campaignId, threadId, onClose }: { campaignId?: string; threadId?: string; onClose?: () => void }) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const [cursors, setCursors] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const before = cursors.at(-1);
  const refreshRevision = useStoreSelector((store) => store.snapshotRevision);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void Promise.resolve().then(() => api.assistantDecisionHistory({
      ...(campaignId ? { campaignId } : {}), ...(threadId ? { threadId } : {}), ...(before ? { before } : {}),
    }, controller.signal)).then((page) => {
      if (!controller.signal.aborted) setState({ kind: "ready", page });
    }, () => {
      if (!controller.signal.aborted) setState({ kind: "error" });
    });
    return () => controller.abort();
  }, [api, before, campaignId, threadId, retry, refreshRevision]);

  const page = state.kind === "ready" ? state.page : null;
  const next = page?.nextBefore;
  if (campaignId && state.kind !== "error" && !before && !page?.entries.length) return null;

  const body = <>
    {state.kind === "loading" && <p role="status">Loading delegated decisions…</p>}
    {state.kind === "error" && <Notice tone="danger" role="alert">
      <p>Couldn't load delegated decisions.</p>
      <button className="btn sm" type="button" onClick={() => setRetry((current) => current + 1)}>Retry</button>
    </Notice>}
    {page?.entries.length === 0 && <p>No delegated decisions yet.</p>}
    {(before || next) && <div className="assistant-decision-pagination">
      {before && <button type="button" className="btn sm" disabled={state.kind === "loading"}
        onClick={() => setCursors((current) => current.slice(0, -1))}>Newer Decisions</button>}
      {next && <button type="button" className="btn sm" onClick={() => setCursors((current) => [...current, next])}>Older Decisions</button>}
    </div>}
    {!!page?.entries.length && <ul className="campaign-decision-list assistant-decision-history" aria-label="Delegated Decisions">
      {page.entries.map(({ occurrenceId, category, resourceKey, subject, delegation }) => {
        const title = delegation.threadTitle ?? "Assistant Thread";
        return <li key={occurrenceId} className="campaign-decision-item">
          <strong>{category === "ui_evidence_approval" ? "UI Evidence" : ASSISTANT_DECISION_CATEGORIES[category]}</strong>
          <p className="muted">{subject ?? (category === "ci_rerun" ? "GitHub Actions Run" : resourceKey)}</p>
          <p>{delegation.outcome === "approved" ? "Approved" : delegation.outcome === "denied" ? "Denied" : "Answered"} by Assistant thread{" "}
            {threadId ? <strong>{title}</strong> : <button className="btn sm" type="button" title={delegation.threadId} onClick={() => {
              onClose?.();
              navigate({ name: "assistants", threadId: delegation.threadId });
            }}>{title}</button>} under your delegation.</p>
          <p>{delegation.reason}</p>
          <p className="muted"><time dateTime={new Date(delegation.resolvedAt).toISOString()}>{formatCalendarTime(delegation.resolvedAt)}</time></p>
        </li>;
      })}
    </ul>}
  </>;

  return campaignId
    ? <CampaignSection title="Delegated Decisions" count={page?.entries.length ?? 0}>{body}</CampaignSection>
    : <Modal title="Delegated Decisions" onClose={onClose!}
      footer={<button className="btn" type="button" onClick={onClose}>Close</button>}>{body}</Modal>;
}

export function AssistantDecisionHistoryDialog({ threadId, onClose }: { threadId?: string; onClose: () => void }) {
  return <DecisionHistory threadId={threadId} onClose={onClose} />;
}

export function CampaignAssistantDecisions({ campaignId }: { campaignId: string }) {
  const supported = useStoreSelector((store) => store.assistantDecisionHistorySupported);
  return supported ? <DecisionHistory key={campaignId} campaignId={campaignId} /> : null;
}
