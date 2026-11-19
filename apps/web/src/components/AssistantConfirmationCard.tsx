import { useState } from "react";
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
import { BusyButton } from "./ui/BusyButton.js";

type Answered = (response: AssistantOwnerConfirmationResponse) => void;

/** Approve Once and Deny for one request, with the toast that reports how it ended. */
function useConfirmationAnswer(confirmation: AssistantOwnerConfirmation, onAnswered?: Answered) {
  const api = useApi();
  const { showToast } = useFeedback();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const answer = async (intent: "approve" | "deny") => {
    if (busy) return;
    setBusy(intent);
    try {
      const response = intent === "approve"
        ? confirmation.campaign
          ? await api.approveAssistantCampaign(confirmation.threadId, confirmation.id, confirmation.campaign.digest)
          : await api.approveAssistantConfirmation(confirmation.threadId, confirmation.id)
        : await api.denyAssistantConfirmation(confirmation.threadId, confirmation.id);
      const outcome = assistantConfirmationOutcome(response.confirmation);
      showToast(outcome.message, { tone: outcome.tone });
      if (confirmation.campaign) announceAssistantThread(response.thread);
      onAnswered?.(response);
    } catch (cause) {
      showToast(intent === "approve" ? "Couldn't approve the request." : "Couldn't deny the request.", {
        tone: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  };
  return { busy, answer };
}

/** The request's exact target, its previewed impact, and every argument the approved run uses. */
function ConfirmationFacts({ confirmation }: { confirmation: AssistantOwnerConfirmation }) {
  const { target } = confirmation;
  const lead = confirmation.campaign ? confirmation.impact.slice(0, 2) : [];
  const remaining = confirmation.campaign ? confirmation.impact.slice(2) : confirmation.impact;
  const facts = confirmation.campaign ? [...lead, ...confirmation.arguments, ...remaining] : remaining;
  return (
    <>
      <p className="assistant-confirmation-summary">{confirmation.summary}</p>
      <dl className="facts" aria-label="Impact">
        <div><dt>Target</dt><dd>{target.label === target.id ? target.id : `${target.label} (${target.id})`}</dd></div>
        {facts.map((line, index) => <div key={`${line.label}-${index}`}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}
      </dl>
      {!confirmation.campaign && confirmation.arguments.length > 0 && (
        // Exactly what runs: each argument by its own name, with its whole value.
        <dl className="facts assistant-confirmation-arguments" aria-label="Arguments">
          {confirmation.arguments.map((line) => <div key={line.label}><dt><code>{line.label}</code></dt><dd><code>{line.value}</code></dd></div>)}
        </dl>
      )}
      <p className="request-card-reasons">Your assistant asked to run this. It runs once, exactly as shown, only if you approve it.</p>
    </>
  );
}

/** Opens the target session, when the request has one. */
function OpenTarget({ confirmation, disabled }: { confirmation: AssistantOwnerConfirmation; disabled: boolean }) {
  const { navigate } = useStoreActions();
  if (confirmation.target.kind !== "session") return null;
  return (
    <button type="button" className="btn sm request-card-tertiary" disabled={disabled}
      onClick={() => navigate({ name: "session", id: confirmation.target.id })}>
      Open Session
    </button>
  );
}

function ConfirmationActions({ busy, answer, approveDisabled = false }: {
  busy: "approve" | "deny" | null;
  answer: (intent: "approve" | "deny") => Promise<void>;
  approveDisabled?: boolean;
}) {
  return (
    <>
      <BusyButton className="btn sm" busy={busy === "deny"} progress="Denying…" disabled={busy !== null}
        onClick={() => void answer("deny")}>
        Deny
      </BusyButton>
      <BusyButton className="btn sm primary" busy={busy === "approve"} progress="Approving…" disabled={busy !== null || approveDisabled}
        onClick={() => void answer("approve")}>
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
    <div className="assistant-campaign-budget">
      <label className="field">Cost Budget (USD)
        <input type="number" min="0.01" step="any" value={cost} onChange={event => setCost(event.target.value)} disabled={saving} />
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

/**
 * One owner confirmation of a Wollipog Assistant thread (#4665), drawn whole: the destructive
 * command its assistant asked to run, with its exact target, impact and arguments, and Approve
 * Once and Deny. Only the owner can answer, and the assistant hears the outcome in its thread.
 * A list item, for the thread's own work cards.
 */
export function AssistantConfirmationCard({ confirmation, onAnswered }: {
  confirmation: AssistantOwnerConfirmation;
  onAnswered?: Answered;
}) {
  const [editingBudget, setEditingBudget] = useState(false);
  const [changed, setChanged] = useState<{ previousDigest: string; confirmation: AssistantOwnerConfirmation } | null>(null);
  const shown = changed && changed.previousDigest === confirmation.campaign?.digest ? changed.confirmation : confirmation;
  const campaign = shown.campaign;
  const { busy, answer } = useConfirmationAnswer(shown, onAnswered);
  const headingId = `assistant-confirmation-${confirmation.id}`;
  return (
    <li className="request-card" aria-labelledby={headingId} data-assistant-campaign={campaign ? "" : undefined}>
      <div className="request-card-head">
        <span className="request-card-kind">Approval Needed</span>
        <span className="request-card-meta"><span>Expires {formatClock(confirmation.expiresAt)}</span></span>
      </div>
      <p className="request-card-title" id={headingId}>{confirmation.title}</p>
      <div className="request-card-body" tabIndex={campaign && !editingBudget ? 0 : undefined}
        aria-label={campaign && !editingBudget ? "Campaign Details" : undefined}
        role={campaign && !editingBudget ? "region" : undefined}>
        {editingBudget && campaign ? <CampaignBudgetEditor confirmation={{ ...shown, campaign }}
          onCancel={() => setEditingBudget(false)} onSaved={(response) => {
            setChanged({ previousDigest: campaign.digest, confirmation: response.confirmation });
            setEditingBudget(false);
          }} /> : <ConfirmationFacts confirmation={shown} />}
      </div>
      <div className="request-card-foot">
        <OpenTarget confirmation={confirmation} disabled={busy !== null} />
        {campaign && !editingBudget && <button type="button" className="btn sm request-card-tertiary"
          disabled={busy !== null} onClick={() => setEditingBudget(true)}>
          {campaign.budget ? "Change Budget" : "Set Budget"}
        </button>}
        {!editingBudget && <ConfirmationActions busy={busy} answer={answer}
          approveDisabled={Boolean(campaign && !campaign.budget)} />}
      </div>
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
            {campaigns.map(confirmation => <AssistantConfirmationCard key={confirmation.id} confirmation={confirmation} />)}
          </ul>
        </Modal>
      )}
    </section>
  );
}
