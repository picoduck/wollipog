import { useRef, useState } from "react";
import { validOrchestratorCampaignBudgetDefault, type AssistantOwnerConfirmation, type AssistantOwnerConfirmationResponse } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  assistantConfirmationOutcome,
  announceAssistantThread,
  type AssistantThreadConfirmations,
} from "../assistant-confirmations.js";
import { assistantThreadTitle } from "../assistant-threads.js";
import { formatClock } from "../format.js";
import { useStoreActions } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

type Answered = (response: AssistantOwnerConfirmationResponse) => void;
type ConfirmationIntent = "approve" | "deny";
type ConfirmationAnswer = (response: AssistantOwnerConfirmationResponse, intent: ConfirmationIntent) => void;

/** Approve Once and Deny for one request, with the toast that reports how it ended. */
function useConfirmationAnswer(confirmation: AssistantOwnerConfirmation, onAnswered: ConfirmationAnswer) {
  const api = useApi();
  const { showToast } = useFeedback();
  const [busy, setBusy] = useState<ConfirmationIntent | null>(null);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<{ message: string; detail: string }>();
  const answer = async (intent: ConfirmationIntent, button: HTMLButtonElement) => {
    if (inFlight.current) return;
    inFlight.current = true;
    button.focus();
    setBusy(intent);
    try {
      const response = await answerAssistantConfirmation(api, confirmation, intent);
      const outcome = assistantConfirmationOutcome(response.confirmation);
      showToast(outcome.message, { tone: outcome.tone });
      if (confirmation.campaign) announceAssistantThread(response.thread);
      onAnswered(response, intent);
    } catch (cause) {
      setFailure({
        message: intent === "approve" ? "Couldn't approve the request." : "Couldn't deny the request.",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      button.focus({ preventScroll: true });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  return { busy, answer, failure };
}

export function answerAssistantConfirmation(api: ReturnType<typeof useApi>, confirmation: AssistantOwnerConfirmation, intent: "approve" | "deny") {
  const { threadId, id, campaign } = confirmation;
  if (intent === "deny") return api.denyAssistantConfirmation(threadId, id);
  return campaign
    ? api.approveAssistantCampaign(threadId, id, campaign.digest)
    : api.approveAssistantConfirmation(threadId, id);
}

function ConfirmationActions({ busy, answer, approveDisabled = false }: {
  busy: ConfirmationIntent | null;
  answer: (intent: ConfirmationIntent, button: HTMLButtonElement) => Promise<void>;
  approveDisabled?: boolean;
}) {
  return (
    <>
      <BusyButton className="btn sm" busy={busy === "deny"} progress="Denying the request…" aria-disabled={busy !== null || undefined}
        onClick={event => void answer("deny", event.currentTarget)}>
        Deny
      </BusyButton>
      <BusyButton className="btn sm primary" busy={busy === "approve"} progress="Approving the request…"
        aria-disabled={busy !== null || approveDisabled || undefined}
        onClick={event => { if (!approveDisabled) void answer("approve", event.currentTarget); }}>
        Approve Once
      </BusyButton>
    </>
  );
}

function CampaignBudgetEditor({ confirmation, onSaved, onCancel }: {
  confirmation: AssistantOwnerConfirmation & { campaign: NonNullable<AssistantOwnerConfirmation["campaign"]> };
  onSaved: Answered;
  onCancel: () => void;
}) {
  const api = useApi();
  const [cost, setCost] = useState(confirmation.campaign.budget?.costUsd.toString() ?? "");
  const [calls, setCalls] = useState(confirmation.campaign.budget?.toolCalls.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const budget = { costUsd: Number(cost), toolCalls: Number(calls) };
  const save = async () => {
    if (saving || !validOrchestratorCampaignBudgetDefault(budget)) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api.reviseAssistantCampaignBudget(confirmation.threadId, confirmation.id, confirmation.campaign.digest, budget);
      announceAssistantThread(response.thread);
      onSaved(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't update the campaign budget.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="form">
      <label className="field">Cost Budget (USD)
        <span className="input-affix">
          <span className="input-affix-text" aria-hidden="true">$</span>
          <input type="number" min="0.01" step="any" value={cost} onChange={event => setCost(event.target.value)} disabled={saving} />
        </span>
      </label>
      <label className="field">Tool Call Limit
        <input type="number" min="1" step="1" value={calls} onChange={event => setCalls(event.target.value)} disabled={saving} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="request-card-foot">
        <button type="button" className="btn sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <BusyButton className="btn sm primary" busy={saving} progress="Updating…" disabled={saving || !validOrchestratorCampaignBudgetDefault(budget)}
          onClick={() => void save()}>Update Preview</BusyButton>
      </div>
    </div>
  );
}

export function CampaignReviewDialog({ confirmation, onClose, onAnswered }: {
  confirmation: AssistantOwnerConfirmation;
  onClose: () => void;
  onAnswered?: ConfirmationAnswer;
}) {
  const [editingBudget, setEditingBudget] = useState(false);
  const [changed, setChanged] = useState<{ previousDigest: string; confirmation: AssistantOwnerConfirmation } | null>(null);
  const shown = changed && changed.previousDigest === confirmation.campaign?.digest ? changed.confirmation : confirmation;
  const campaign = shown.campaign;
  const { busy, answer, failure } = useConfirmationAnswer(shown, (response, intent) => { onClose(); onAnswered?.(response, intent); });
  if (!campaign) return null;
  return (
    <Modal title={editingBudget ? "Campaign Budget" : shown.title}
      onClose={() => { if (!busy) onClose(); }}
      size="lg" phoneSheet="full"
      headerActions={!editingBudget && <button type="button" className="btn sm ghost"
        aria-disabled={busy !== null || undefined} onClick={() => { if (!busy) setEditingBudget(true); }}>
        {campaign.budget ? "Change Budget" : "Set Budget"}
      </button>}
      footer={!editingBudget && <ConfirmationActions busy={busy} answer={answer} approveDisabled={!campaign.budget} />}>
      {editingBudget ? (
        <CampaignBudgetEditor confirmation={{ ...shown, campaign }} onCancel={() => setEditingBudget(false)} onSaved={response => {
          setChanged({ previousDigest: confirmation.campaign?.digest ?? campaign.digest, confirmation: response.confirmation });
          setEditingBudget(false);
        }} />
      ) : (
        <div className="assistant-campaign-review">
          {failure && <Notice tone="danger" role="alert" details={<div className="code-well"><pre>{failure.detail}</pre></div>}>
            {failure.message}
          </Notice>}
          <dl className="facts" aria-label="Campaign Details">
            <div><dt>Location</dt><dd>{shown.target.label} ({shown.target.id})</dd></div>
            {shown.impact.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {shown.arguments.map(({ label, value }) => (
            <section className="assistant-campaign-message" key={label} aria-label={label}>
              <h3>{label}</h3>
              <p>{value}</p>
            </section>
          ))}
          <p className="request-card-reasons">{shown.summary} It runs once if you approve it.</p>
        </div>
      )}
    </Modal>
  );
}

function CampaignApprovalCard({ confirmation }: { confirmation: AssistantOwnerConfirmation }) {
  const [review, setReview] = useState(false);
  const headingId = `assistant-confirmation-${confirmation.id}`;
  return (
    <li className="request-card" aria-labelledby={headingId}>
      <div className="request-card-head">
        <span className="request-card-kind">Approval Needed</span>
        <span className="request-card-meta">Expires {formatClock(confirmation.expiresAt)}</span>
      </div>
      <p className="request-card-title" id={headingId}>{confirmation.title}</p>
      <p className="assistant-confirmation-summary">{confirmation.target.label}</p>
      <div className="request-card-foot">
        <button type="button" className="btn sm primary" onClick={() => setReview(true)}>Review Campaign</button>
      </div>
      {review && <CampaignReviewDialog confirmation={confirmation} onClose={() => setReview(false)} />}
    </li>
  );
}

/** How many threads the Inbox names; the rest wait behind "+N More", in the Assistants section. */
const NOTICE_THREADS = 3;

/** A bounded preview of the owner's pending Assistant confirmations. */
export function AssistantConfirmationsNotice({ waiting }: { waiting: readonly AssistantThreadConfirmations[] }) {
  const { navigate } = useStoreActions();
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const reviewThread = waiting.find(thread => thread.threadId === reviewThreadId);
  const campaigns = reviewThread?.confirmations.filter(confirmation => confirmation.campaign) ?? [];
  if (!waiting.length) return null;
  const more = waiting.length - NOTICE_THREADS;
  return (
    <section className="request-card assistant-approvals" aria-label="Assistant Approvals">
      <ul className="assistant-approvals-list">
        {waiting.slice(0, NOTICE_THREADS).map((thread) => {
          const title = assistantThreadTitle({ title: thread.threadTitle });
          const titleId = `assistant-approvals-${thread.threadId}`;
          return (
            <li key={thread.threadId} className="assistant-approvals-row" aria-labelledby={titleId}>
              <span className="assistant-approvals-title" id={titleId} title={title}>{title}</span>
              <span className="assistant-approvals-meta">
                <span className="request-card-kind">{thread.confirmations.length} {thread.confirmations.length === 1 ? "Approval" : "Approvals"}</span>
                <span className="assistant-approvals-expiry">Expires {formatClock(thread.expiresAt)}</span>
                <button type="button" className="btn sm primary" aria-describedby={titleId}
                  onClick={() => thread.confirmations.some(confirmation => confirmation.campaign)
                    ? setReviewThreadId(thread.threadId)
                    : navigate({ name: "assistants", threadId: thread.threadId })}>
                  Review
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button type="button" className="btn sm ghost assistant-approvals-more" onClick={() => navigate({ name: "assistants" })}>
          +{more} More
        </button>
      )}
      {reviewThread && campaigns.length > 0 && (
        <Modal title="Campaign Approvals" onClose={() => setReviewThreadId(null)}
          footer={<button type="button" className="btn" onClick={() => {
            setReviewThreadId(null);
            navigate({ name: "assistants", threadId: reviewThread.threadId });
          }}>Open Thread</button>}>
          <ul className="assistant-inbox-campaigns" aria-label="Campaign Approvals">
            {campaigns.map(confirmation => <CampaignApprovalCard key={confirmation.id} confirmation={confirmation} />)}
          </ul>
        </Modal>
      )}
    </section>
  );
}
