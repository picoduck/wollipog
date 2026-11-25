import { createContext, useContext } from "react";
import {
  assistantDecisionActionLabel, type AssistantThread, type AssistantTranscriptReceipt,
} from "@wollipog/protocol";
import { pendingAssistantConfirmations } from "../assistant-confirmations.js";
import type { AssistantMessageReceipt } from "../assistant-transcript-placement.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useOptionalNavigate, useOptionalStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { DecisionClosedIcon, SuccessIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";
import { useTimelineTargetSession, WollipogEventRow } from "./WollipogPromptRow.js";

export const AssistantTranscriptContext = createContext<{
  thread: AssistantThread;
  onShowWork: () => void;
  onFocusConfirmation: (id: string) => void;
} | null>(null);

export const AssistantReceiptPlacement = createContext<ReadonlyMap<number, readonly AssistantMessageReceipt[]> | undefined>(undefined);

export function AssistantMessageReceipts({ id }: { id: number }) {
  const receipts = useContext(AssistantReceiptPlacement)?.get(id);
  return receipts?.length ? <MessageReceipts receipts={receipts} /> : null;
}

export function AssistantReceiptItem({ receipt, open, onToggle }: {
  receipt: AssistantTranscriptReceipt;
  open: boolean;
  onToggle?: () => void;
}) {
  const assistant = useContext(AssistantTranscriptContext);
  if (!assistant) return null;
  return receipt.kind === "decision"
    ? <DelegatedDecision receipt={receipt} open={open} onToggle={onToggle} />
    : <MessageReceipts receipts={[receipt]} />;
}

function MessageReceipts({ receipts }: { receipts: readonly AssistantMessageReceipt[] }) {
  const assistant = useContext(AssistantTranscriptContext);
  const now = useTimelineClock(receipts.some(({ kind }) => kind === "request") && !!assistant?.thread.confirmations?.length);
  if (!assistant) return null;
  const { thread } = assistant;
  const launches: { id: string; campaign: boolean }[] = [];
  const requests = [];
  for (const receipt of receipts) {
    if (receipt.kind === "launch") {
      if (thread.launchedSessionIds.includes(receipt.sessionId)) launches.push({ id: receipt.sessionId, campaign: false });
    } else {
      requests.push(receipt);
      const campaign = thread.campaignReceiptLinks?.find(({ confirmationId }) => confirmationId === receipt.confirmationId);
      if (campaign && thread.launchedCampaignIds?.includes(campaign.sessionId)) {
        launches.push({ id: campaign.sessionId, campaign: true });
      }
    }
  }
  if (!launches.length && !requests.length) return null;
  const waiting = requests.length ? pendingAssistantConfirmations([thread], now) : [];
  const more = launches.length - 3;
  return <div className="assistant-transcript-receipts">
    {launches.slice(0, 3).map(({ id, campaign }) => <LaunchReceipt key={id} id={id} campaign={campaign} />)}
    {more > 0 && <button type="button" className="btn sm ghost assistant-transcript-receipt"
      onClick={assistant.onShowWork}>+{more} more</button>}
    {requests.map(({ confirmationId, title }) => {
      const pending = waiting.some(({ confirmation }) => confirmation.id === confirmationId);
      return pending
        ? <button key={confirmationId} type="button" className="btn sm ghost assistant-transcript-receipt"
            onClick={() => assistant.onFocusConfirmation(confirmationId)}>
            <span>Waiting for you: {title}</span>
          </button>
        : <p key={confirmationId} className="assistant-transcript-settled">Request Closed: {title}</p>;
    })}
  </div>;
}

function LaunchReceipt({ id, campaign }: { id: string; campaign: boolean }) {
  const navigate = useOptionalNavigate();
  const session = useTimelineTargetSession(id);
  const runnerOnline = useOptionalStoreSelector((state) => state.runners.get(session?.runnerId ?? "")?.status === "online");
  const title = (session && sessionDisplayTitle(session.title)) || (campaign ? "Launched Campaign" : "Launched Session");
  const status = session && sessionStatusSignal(session, { runnerOnline }).meta;
  return <button type="button" className="btn sm assistant-transcript-receipt assistant-transcript-launch"
    onClick={() => navigate?.({ name: "session", id })} title={title}>
    <span>{title}</span>
    {status && <StatusBadge inline size="md" meta={status} />}
  </button>;
}

function DelegatedDecision({ receipt, open, onToggle }: {
  receipt: Extract<AssistantTranscriptReceipt, { kind: "decision" }>;
  open: boolean;
  onToggle?: () => void;
}) {
  const { category, subject, outcome, reason, resolvedAt, selectionMode } = receipt;
  const action = assistantDecisionActionLabel(category, outcome);
  const verb = outcome === "answered" ? "answered" : outcome === "approved" ? "approved" : "denied";
  const heading = category === "pr_merge"
    ? <>This thread {verb} merging <strong>{subject}</strong> for you</>
    : <><strong>{action}</strong> · {verb === "answered" ? "Answered" : verb === "approved" ? "Approved" : "Denied"}</>;
  const grant = selectionMode === "all" ? "Under Delegate All"
    : selectionMode === "choose" ? "Under Selected Decisions" : "Under Delegation";
  const summary = reason.length > 96 ? reason.slice(0, 96).trimEnd() + "…" : reason;
  return <WollipogEventRow origin="delegated_decision"
    icon={outcome === "denied" ? <DecisionClosedIcon size={16} /> : <SuccessIcon size={16} />}
    tone={outcome === "denied" ? "t-neutral" : "t-success"}
    heading={<span>{heading}</span>}
    fact={grant + " · " + summary}
    at={resolvedAt}
    open={open}
    onToggle={onToggle}
    details={<>
      <strong>{category === "pr_merge" ? action : subject}</strong>
      <pre>{reason}</pre>
    </>}
  />;
}
