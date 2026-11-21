import {
  useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState,
  type MouseEvent, type ReactNode, type Ref,
} from "react";
import {
  prioritizedPendingRequests, validateQuestionAnswers, type AssistantOwnerConfirmation,
  type AssistantThread, type PendingApproval, type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { assistantConfirmationOutcome, pendingAssistantConfirmations } from "../assistant-confirmations.js";
import type { LaunchedWork } from "../assistant-launched-work.js";
import { assistantInlineQuestion, assistantToolOptions, assistantWorkRequestKey } from "../assistant-waiting-requests.js";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons.js";
import { claimQuestionResponseOperation } from "../question-response.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { sessionDisplayTitle } from "../session-title.js";
import { sessionStatusSignal } from "../status-meta.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { useTimelineClock } from "../timeline-clock.js";
import { answerAssistantConfirmation, CampaignReviewDialog } from "./AssistantConfirmationCard.js";
import { useLaunchedWorkGroups } from "./AssistantWorkCards.js";
import { useFeedback } from "./FeedbackProvider.js";
import { holdFieldFocus } from "./requests/hold-field-focus.js";
import { useClipEdges } from "./requests/clip-edges.js";
import { requestKindMeta } from "./requests/request-meta.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useToastChrome } from "./useToastChrome.js";

type Request =
  | { key: string; confirmation: AssistantOwnerConfirmation }
  | { key: string; session: SessionView; request: PendingApproval };

type Action = "open" | "review" | "deny" | "approve" | "submit";
type Response = Extract<Action, "deny" | "approve" | "submit">;
type Operation = { key: string; action: Response };

const responseCopy = {
  approve: { label: "Approve Once", progress: "Approving the request…", failure: "Couldn't approve the request." },
  deny: { label: "Deny", progress: "Denying the request…", failure: "Couldn't deny the request." },
  submit: { label: "Send Answer", progress: "Sending the answer…", failure: "Couldn't send the answer." },
};

export interface AssistantWaitingDockHandle {
  focusAssistantWorkRequest: (sessionId: string, request: PendingApproval) => void;
}

export function AssistantWaitingDock({ thread, work, onConfirmationAnswered, focusComposer, ref }: {
  thread: AssistantThread;
  work: LaunchedWork;
  onConfirmationAnswered: (thread: AssistantThread) => void;
  focusComposer: () => void;
  ref: Ref<AssistantWaitingDockHandle>;
}) {
  const { groups } = useLaunchedWorkGroups(work);
  const sessions = useStoreSelector(
    (state) => groups.needsYou.map(id => state.sessions.get(id)),
    (before, after) => before.length === after.length && before.every((session, index) => session === after[index]),
  );
  const now = useTimelineClock(Boolean(thread.confirmations?.length) || sessions.length > 0);
  const requests: Request[] = [
    ...pendingAssistantConfirmations([thread], now).map(({ confirmation }) => ({ key: confirmation.id, confirmation })),
    ...sessions.flatMap(session => !session || session.archived
      ? []
      : prioritizedPendingRequests(session.pendingApproval).map(request => ({
        key: assistantWorkRequestKey(session.id, request), session, request,
      }))),
  ];
  const [selected, setSelected] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<Operation | null>(null);
  const operation = useRef<Operation | null>(null);
  const [reviewTarget, setReviewTarget] = useState<string>();
  const lastIndex = useRef(0);
  const focused = useRef<{ key?: string; action?: string } | null>(null);
  const deferredFocus = useRef<{ key: string; action: string } | null>(null);
  const dock = useRef<HTMLElement>(null);
  const toastClearanceRef = useToastChrome<HTMLDivElement>();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useClipEdges(list);
  const headingId = useId();
  const listId = useId();
  const selectedIndex = requests.findIndex(item => item.key === selected);
  const index = selectedIndex >= 0 ? selectedIndex : Math.min(lastIndex.current, requests.length - 1);
  const current = requests[index];
  const visible = showAll ? requests : current ? [current] : [];
  const busy = pendingOperation && requests.some(item => item.key === pendingOperation.key) ? pendingOperation : null;

  const cardFor = (key: string) =>
    dock.current?.querySelector<HTMLElement>(`[data-assistant-dock-key="${CSS.escape(key)}"]`);
  const actionFor = (key: string, action: string) => cardFor(key)
    ?.querySelector<HTMLButtonElement>(`[data-dock-action="${CSS.escape(action)}"]:not([aria-disabled="true"])`);

  useImperativeHandle(ref, () => ({
    focusAssistantWorkRequest(sessionId, request) {
      if (operation.current) return;
      const key = assistantWorkRequestKey(sessionId, request);
      if (!requests.some(item => item.key === key)) return;
      setSelected(key);
      setReviewTarget(key);
    },
  }));

  useLayoutEffect(() => {
    lastIndex.current = Math.max(0, index);
    if (current?.key !== selected) setSelected(current?.key);
    if (reviewTarget) {
      cardFor(reviewTarget)?.focus();
      setReviewTarget(undefined);
      return;
    }
    const deferred = deferredFocus.current;
    if (deferred && (current?.key !== deferred.key || document.activeElement !== heading.current)) {
      deferredFocus.current = null;
    } else if (deferred) {
      const target = actionFor(deferred.key, deferred.action);
      if (target) {
        deferredFocus.current = null;
        target.focus();
      }
    }
    const previous = focused.current;
    if (!previous || document.activeElement !== document.body) return;
    if (previous.key && requests.some(item => item.key === previous.key)) return;
    focused.current = null;
    if (!current) {
      focusComposer();
      return;
    }
    const next = previous.action && actionFor(current.key, previous.action);
    // A summary request may only gain its action after the detail arrives. The heading keeps
    // focus in the meantime, and releasing focus there cancels the handoff.
    if (!next && previous.action) deferredFocus.current = { key: current.key, action: previous.action };
    (next || heading.current)?.focus();
  });

  const begin = (next: Operation) => {
    if (operation.current) return false;
    operation.current = next;
    setPendingOperation(next);
    return true;
  };
  const finish = () => {
    operation.current = null;
    setPendingOperation(null);
  };
  const page = (offset: number) => {
    if (operation.current || showAll) return;
    setSelected(requests[(index + offset + requests.length) % requests.length]?.key);
  };
  if (!current) return null;
  return (
    <div className="assistant-dock-slot" ref={toastClearanceRef}>
      <section className="assistant-dock" aria-labelledby={headingId} ref={dock}
        onFocus={event => {
          if (!(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target)) return;
          const key = event.target.closest<HTMLElement>("[data-assistant-dock-key]")?.dataset.assistantDockKey;
          if (key) setSelected(key);
          focused.current = { key, action: event.target.dataset.dockAction };
        }}
        onBlur={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focused.current = null;
        }}
        onMouseDown={holdFieldFocus}>
        <header className="assistant-dock-head">
          <h3 ref={heading} tabIndex={-1} id={headingId}>Waiting for You <span className="count">{requests.length}</span></h3>
          {requests.length > 1 && <div className="assistant-dock-pager">
            {!showAll && <>
              <button type="button" className="icon-btn sm" aria-label="Previous Request" aria-disabled={busy ? true : undefined} onClick={() => page(-1)}>
                <ChevronLeftIcon />
              </button>
              <span aria-live="polite">{index + 1} of {requests.length}</span>
              <button type="button" className="icon-btn sm" aria-label="Next Request" aria-disabled={busy ? true : undefined} onClick={() => page(1)}>
                <ChevronRightIcon />
              </button>
            </>}
            <button type="button" className="btn sm ghost" aria-expanded={showAll} aria-controls={listId}
              aria-disabled={busy ? true : undefined}
              onClick={() => { if (!operation.current) setShowAll(!showAll); }}>
              {showAll ? "Show One" : "Show All"}
            </button>
          </div>}
        </header>
        <ul id={listId} ref={list} className="assistant-dock-list" data-show-all={showAll || undefined} aria-label="Pending Requests">
          {visible.map(item => (
            <WaitingCard key={item.key} item={item} now={now} busy={busy} begin={begin} finish={finish}
              onConfirmationAnswered={onConfirmationAnswered}
              onCampaignAnswered={action => {
                if (document.activeElement === document.body || !dock.current?.contains(document.activeElement)) {
                  focused.current = { key: item.key, action };
                }
              }}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A summary may omit the command, options, or question. Hydrate only the selected occurrence,
 * using the store's detail fence so a late read cannot overwrite a newer request. */
function useWaitingRequest(session: SessionView | undefined, request: PendingApproval | undefined) {
  const api = useApi();
  const { beginSessionDetailLoad } = useStoreActions();
  const [hydrated, setHydrated] = useState<PendingApproval>();
  const sessionId = session?.id;
  const key = sessionId && request ? assistantWorkRequestKey(sessionId, request) : undefined;
  const needsDetail = Boolean(request && (request.kind === "question" ? !request.questions?.length : !request.options.length));
  useEffect(() => {
    if (!sessionId || !key || !needsDetail) return;
    const load = beginSessionDetailLoad(sessionId);
    let current = true;
    void api.session(sessionId).then(({ session: detail }) => {
      const match = prioritizedPendingRequests(detail.pendingApproval).find(candidate => assistantWorkRequestKey(sessionId, candidate) === key);
      // An unrelated live summary can supersede this read without replacing its request.
      // Keep the matched occurrence's options locally even if the store rejects the snapshot.
      if (current && match) setHydrated(match);
      load.apply(detail);
    }, () => { /* Open Session remains available. */ }).finally(() => load.cancel());
    return () => { current = false; load.cancel(); };
  }, [api, beginSessionDetailLoad, key, needsDetail, sessionId]);
  return needsDetail && hydrated && sessionId && assistantWorkRequestKey(sessionId, hydrated) === key ? hydrated : request;
}

function TargetChip({ id, label }: { id: string; label: string }) {
  const session = useStoreSelector(state => state.sessions.get(id));
  const online = useStoreSelector(state => state.runners.get(session?.runnerId ?? "")?.status === "online");
  const name = sessionDisplayTitle(session?.title ?? "") || label;
  return <div className="assistant-dock-target">
    <span className="chip" title={name}>{name}</span>
    {session && <StatusBadge inline meta={sessionStatusSignal(session, { runnerOnline: online }).meta} />}
  </div>;
}

function WaitingCard({ item, now, busy, begin, finish, onConfirmationAnswered, onCampaignAnswered }: {
  item: Request;
  now: number;
  busy: Operation | null;
  begin: (operation: Operation) => boolean;
  finish: () => void;
  onConfirmationAnswered: (thread: AssistantThread) => void;
  onCampaignAnswered: (action: "approve" | "deny") => void;
}) {
  const api = useApi();
  const { navigate, loadSession } = useStoreActions();
  const { showToast } = useFeedback();
  const confirmation = "confirmation" in item ? item.confirmation : undefined;
  const session = "session" in item ? item.session : undefined;
  const request = useWaitingRequest(session, "request" in item ? item.request : undefined);
  const runnerOnline = useStoreSelector(state => state.runners.get(session?.runnerId ?? "")?.status === "online");
  const question = request && assistantInlineQuestion(request);
  const options = request && assistantToolOptions(request);
  const command = request?.context?.operation?.kind === "command" ? request.context.operation.input : request?.context?.input;
  const [choice, setChoice] = useState<string>();
  const [review, setReview] = useState(false);
  const [failure, setFailure] = useState<{ action: Response; detail: string }>();
  const [details, setDetails] = useState(Boolean(confirmation &&
    confirmation.arguments.length + (confirmation.campaign ? confirmation.impact.length : 0) <= 2));
  const headingId = useId();
  const detailsId = useId();
  const body = useRef<HTMLDivElement>(null);
  useClipEdges(body);
  const failureDetails = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (failure) failureDetails.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [failure]);
  const target = confirmation?.target;
  const openSessionId = session?.id ?? (target?.kind === "session" ? target.id : undefined);
  const refusal = session ? sessionCommandRefusal(session, "respond") ?? (!runnerOnline && question ? "The machine is offline." : null) : null;
  const expiresAt = confirmation?.expiresAt ?? request?.expiresAt;
  const title = confirmation?.title ?? request?.title;
  const kind = confirmation?.campaign ? "Campaign Approval" : confirmation ? "Owner Confirmation"
    : options ? "Tool Approval" : request ? requestKindMeta(request).label : "Session Request";
  const summary = confirmation?.summary ?? question?.context
    ?? (question ? "Choose an option to answer this question." : options ? "This session needs permission to run a tool." : "Open the session to respond to this request.");
  const answers = question && choice !== undefined ? { [question.id]: choice } : undefined;
  const answerValid = Boolean(question && answers && validateQuestionAnswers([question], answers, "submit") === null);
  const detailCount = (confirmation?.impact.length ?? 0) + (confirmation?.arguments.length ?? 0) + Number(Boolean(failure));

  const respond = async (action: Response, event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    if (refusal || (action === "submit" && !answerValid) || !begin({ key: item.key, action })) return;
    button.focus({ preventScroll: true });
    try {
      if (confirmation && action !== "submit") {
        const response = await answerAssistantConfirmation(api, confirmation, action);
        const outcome = assistantConfirmationOutcome(response.confirmation);
        showToast(outcome.message, { tone: outcome.tone });
        onConfirmationAnswered(response.thread);
      } else if (session && request) {
        if (action === "submit" && answers) {
          const operationKey = request.async && request.occurrenceId ? `${request.requestId}:${request.occurrenceId}` : request.requestId;
          const release = claimQuestionResponseOperation(session.id, operationKey);
          if (!release) throw new Error("An answer is already being sent.");
          try {
            loadSession(await api.answerQuestion(session.id, {
              requestId: request.requestId, ...(request.occurrenceId ? { occurrenceId: request.occurrenceId } : {}),
              answers, action: "submit",
            }));
          } finally {
            release();
          }
        } else if (options && action !== "submit") {
          loadSession(await api.approve(session.id, { requestId: request.requestId, optionId: options[action].optionId }));
        }
        showToast(action === "submit" ? "Answer sent." : action === "approve" ? "Request approved once." : "Request denied.",
          { tone: "success" });
      }
    } catch (cause) {
      setFailure({ action, detail: cause instanceof Error ? cause.message : String(cause) });
      setDetails(false);
      button.focus({ preventScroll: true });
    } finally {
      finish();
    }
  };
  const button = (action: Response, disabled = false) => (
    <BusyButton className={action === "deny" ? "btn sm" : "btn sm primary"} data-dock-action={action}
      busy={busy?.key === item.key && busy.action === action} progress={responseCopy[action].progress}
      aria-disabled={busy !== null || refusal !== null || disabled || undefined}
      onClick={event => { if (!disabled) void respond(action, event); }}>
      {responseCopy[action].label}
    </BusyButton>
  );
  const otherAction = (action: Action, children: ReactNode, onClick: () => void, primary = false) => (
    <button type="button" className={primary ? "btn sm primary" : "btn sm ghost"} data-dock-action={action}
      aria-disabled={busy !== null || undefined} onClick={() => { if (!busy) onClick(); }}>{children}</button>
  );

  return (
    <li className="assistant-dock-card" aria-labelledby={headingId} tabIndex={-1} data-assistant-dock-key={item.key}
      data-assistant-work-request={request ? request.occurrenceId ?? request.requestId : undefined}>
      <div className="assistant-dock-card-head">
        <div className="request-card-head">
          <span className="request-card-kind">{kind}</span>
          {expiresAt != null && <time className="request-card-meta" title={new Date(expiresAt).toLocaleString()}
            dateTime={new Date(expiresAt).toISOString()}>
            {expiresAt > now ? `Expires in ${Math.ceil((expiresAt - now) / 60_000)} min` : "Expired"}
          </time>}
        </div>
        <h4 className="request-card-title" id={headingId} title={title}>{title}</h4>
      </div>
      <div className="assistant-dock-card-body" ref={body}>
        <p className="assistant-confirmation-summary">{summary}</p>
        <TargetChip id={session?.id ?? target?.id ?? ""} label={session ? "Launched Session" : target?.label ?? ""} />
        {options && command && <div className="code-well"><pre>{command}</pre></div>}
        {question && <fieldset className="assistant-dock-choices" aria-disabled={busy ? true : undefined}>
          <legend>{question.question === title ? <span className="sr-only">Answer Options</span> : question.question}</legend>
          {question.options.map(option => (
            <label key={option.label}>
              <input type="radio" name={headingId} checked={choice === option.label} aria-disabled={busy ? true : undefined}
                onChange={() => { if (!busy) setChoice(option.label); }} />
              <span>{option.label}{option.description && <small>{option.description}</small>}</span>
            </label>
          ))}
        </fieldset>}
        {refusal && <p className="request-card-reasons">{refusal}</p>}
        {failure && <p className="assistant-dock-failure" role="alert">{responseCopy[failure.action].failure}</p>}
        {detailCount > 0 && <>
          <button ref={failureDetails} type="button" className="btn sm ghost assistant-dock-details" aria-expanded={details} aria-controls={detailsId}
            aria-disabled={busy !== null || undefined} onClick={() => { if (!busy) setDetails(!details); }}>
            {details ? "Hide Details" : "Show Details"} <span className="count">{detailCount}</span>
          </button>
          {details && <div id={detailsId} className="assistant-dock-facts">
            {!!confirmation?.impact.length && <dl className="facts" aria-label="Impact">
              {confirmation.impact.map(({ label, value }, index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>}
            {!!confirmation?.arguments.length && <dl className="facts assistant-confirmation-arguments" aria-label="Arguments">
              {confirmation.arguments.map(({ label, value }) => <div key={label}><dt><code>{label}</code></dt><dd><code>{value}</code></dd></div>)}
            </dl>}
            {failure && <div className="code-well"><pre>{failure.detail}</pre></div>}
          </div>}
        </>}
      </div>
      <div className="assistant-dock-actions">
        {openSessionId && otherAction("open", "Open Session", () => navigate(session && request
          ? { name: "session", id: openSessionId, attention: { eventEpoch: session.eventEpoch ?? 0, requestId: request.requestId } }
          : { name: "session", id: openSessionId }))}
        {(confirmation || options || question) && <div className="assistant-dock-resolve">
          {(confirmation || options) && button("deny")}
          {confirmation?.campaign
            ? otherAction("review", "Review Campaign…", () => setReview(true), true)
            : confirmation || options ? button("approve")
            : question ? button("submit", !answerValid) : null}
        </div>}
      </div>
      {review && confirmation?.campaign && <CampaignReviewDialog confirmation={confirmation} onClose={() => setReview(false)}
        onAnswered={(response, action) => {
          onCampaignAnswered(action);
          onConfirmationAnswered(response.thread);
        }} />}
    </li>
  );
}
