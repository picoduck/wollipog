import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssistantOwnerConfirmation, AssistantOwnerConfirmationResponse, AssistantThread } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import {
  assistantConfirmationOutcome,
  assistantThreadPendingKey,
  onAssistantThreadUpsert,
  pendingAssistantConfirmationsByThread,
} from "../assistant-confirmations.js";
import { assistantThreadTitle } from "../assistant-threads.js";
import { formatClock } from "../format.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useFeedback } from "./FeedbackProvider.js";
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
        ? await api.approveAssistantConfirmation(confirmation.threadId, confirmation.id)
        : await api.denyAssistantConfirmation(confirmation.threadId, confirmation.id);
      const outcome = assistantConfirmationOutcome(response.confirmation);
      showToast(outcome.message, { tone: outcome.tone });
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
  return (
    <>
      <p className="assistant-confirmation-summary">{confirmation.summary}</p>
      <dl className="facts" aria-label="Impact">
        <div><dt>Target</dt><dd>{target.label === target.id ? target.id : `${target.label} (${target.id})`}</dd></div>
        {confirmation.impact.map((line, index) => <div key={`${line.label}-${index}`}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}
      </dl>
      {confirmation.arguments.length > 0 && (
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

function ConfirmationActions({ busy, answer }: {
  busy: "approve" | "deny" | null;
  answer: (intent: "approve" | "deny") => Promise<void>;
}) {
  return (
    <>
      <BusyButton className="btn sm" busy={busy === "deny"} progress="Denying…" disabled={busy !== null}
        onClick={() => void answer("deny")}>
        Deny
      </BusyButton>
      <BusyButton className="btn sm primary" busy={busy === "approve"} progress="Approving…" disabled={busy !== null}
        onClick={() => void answer("approve")}>
        Approve Once
      </BusyButton>
    </>
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
  const { busy, answer } = useConfirmationAnswer(confirmation, onAnswered);
  const headingId = `assistant-confirmation-${confirmation.id}`;
  return (
    <li className="request-card" aria-labelledby={headingId}>
      <div className="request-card-head">
        <span className="request-card-kind">Approval Needed</span>
        <span className="request-card-meta"><span>Expires {formatClock(confirmation.expiresAt)}</span></span>
      </div>
      <p className="request-card-title" id={headingId}>{confirmation.title}</p>
      <div className="request-card-body"><ConfirmationFacts confirmation={confirmation} /></div>
      <div className="request-card-foot">
        <OpenTarget confirmation={confirmation} disabled={busy !== null} />
        <ConfirmationActions busy={busy} answer={answer} />
      </div>
    </li>
  );
}

/** How many threads the Inbox names; the rest wait behind "+N More", in the Assistants section. */
const NOTICE_THREADS = 3;

/**
 * Every Assistant thread's pending owner confirmations, summed up at the top of the Inbox (#4665):
 * one line for each of at most three threads, with how many requests it has waiting, when the first
 * expires, and Review, which opens the thread, where each request is drawn whole to be answered.
 * However many requests wait, the block keeps the same small bound, so the sessions keep their room.
 *
 * The Thread API's list is the only source of what is shown, and only the answer to the most
 * recently started read is applied. A read starts whenever what is shown may have fallen behind:
 * the connection comes (back) online, or a thread event changes that thread's pending requests (an
 * answer in the thread view publishes one). Each such change therefore has a read that started
 * after it, and an older read's late answer is discarded, so stale state can never replace newer
 * state. A control plane without the Thread API shows nothing.
 */
export function AssistantConfirmationsNotice() {
  const api = useApi();
  const { navigate } = useStoreActions();
  const online = useStoreSelector((state) => state.conn === "online");
  const [threads, setThreads] = useState<readonly AssistantThread[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const latestRead = useRef(0);
  const retry = useRef<number | null>(null);
  const cancelRetry = () => {
    if (retry.current !== null) window.clearTimeout(retry.current);
    retry.current = null;
  };
  const refresh = useCallback(() => {
    cancelRetry();
    const read = ++latestRead.current;
    // The invariant: only the most recently started read (`latestRead`) may change what is shown or
    // schedule more work. A newer read or unmounting advances `latestRead`, which retires every
    // older answer, failure and retry, whatever order they arrive in.
    // The latest read is retried, backing off to 30 seconds, until it succeeds or is superseded: a
    // request whose read failed must not stay hidden until it expires. A control plane without the
    // Thread API answers 404, 405 or 501, and then the Inbox stays as it was.
    const current = () => read === latestRead.current;
    const attempt = (delay: number) => void api.assistantConfirmationThreads().then(
      ({ threads: listed }) => { if (current()) setThreads(listed); },
      (error: unknown) => {
        if (!current()) return;
        if (error instanceof ApiError && [404, 405, 501].includes(error.status)) return;
        retry.current = window.setTimeout(() => {
          retry.current = null;
          if (current()) attempt(Math.min(delay * 2, 30_000));
        }, delay);
      },
    );
    attempt(2_000);
  }, [api]);
  // Unmounting supersedes any read still in flight, so its late answer or failure does nothing.
  useEffect(() => () => { latestRead.current += 1; cancelRetry(); }, []);
  // Events are not replayed after a disconnect, so the list is read whenever the connection is up.
  useEffect(() => { if (online) refresh(); }, [online, refresh]);
  // Thread events arrive in order, so a thread's latest event names its pending requests as of
  // then. Activity that leaves them unchanged needs no read.
  const pendingByThread = useRef(new Map<string, string>());
  useEffect(() => onAssistantThreadUpsert((thread) => {
    const key = assistantThreadPendingKey(thread);
    if (pendingByThread.current.get(thread.id) === key) return;
    pendingByThread.current.set(thread.id, key);
    refresh();
  }), [refresh]);
  useEffect(() => {
    // An unanswered request leaves the list when it expires, even without another event.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const waiting = useMemo(() => pendingAssistantConfirmationsByThread(threads, now), [threads, now]);
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
                  onClick={() => navigate({ name: "assistants", threadId: thread.threadId })}>
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
    </section>
  );
}
