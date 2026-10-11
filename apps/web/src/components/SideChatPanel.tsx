import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { State } from "./State.js";
import { Notice } from "./Notice.js";
import {
  isPolicyApproval,
  isTerminal,
  type SessionEvent,
  type SessionStatus,
  type SessionView,
  type SideChatView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useHasStore, useOptionalStoreSelector, useStoreActions } from "../store.js";
import { viewPath } from "../navigation.js";
import { matchesShortcut, shortcutDisplay, shortcutLayerActive } from "../shortcuts.js";
import { enterKeystrokeSends, useEnterKeyBehavior } from "../enter-key.js";
import { EventTimeline, type AgentReplyItem } from "./EventTimeline.js";
import { ArrowUpIcon, ArrowUpRightIcon, MessageSquareIcon, StopTurnIcon } from "./Icons.js";
import { Spinner } from "./common.js";
import { InfoPopover } from "./InfoPopover.js";
import { PanelNoticeSlot } from "./PanelNoticeSlot.js";
import { PANEL_NOTICE_RANK, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { PanelHeaderActions } from "./RightPanel.js";
import { StatusBadge } from "./StatusBadge.js";
import { TranscriptSkeleton } from "./TranscriptSkeleton.js";
import { useIsCoarsePointer, useIsTouchPhone } from "./useIsMobile.js";
import { useTimeline } from "./useTimeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { canStopActiveTurn, composerPrimaryAction } from "../session-actions.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { composerAgentName } from "../composer-placeholder.js";
import { runnerDisplay } from "../runners.js";
import {
  clearPanelScratchIf,
  panelScratchRevision,
  usePanelScratchDraft,
  usePanelScratchScope,
} from "../right-panel-scratch.js";
import { subscribeSideChatFocus, takeSideChatFocusRequest } from "./side-chat-focus.js";
export { requestSideChatFocus } from "./side-chat-focus.js";

const POLL_MS = 1_500;
const SIDE_CHAT_DRAFT_KEY = "sidechat.draft";
const PAGE_SIZE = 200;
/** How long a Stop Turn waits for the turn to end before saying it is still running, as the main
 * composer's does. */
const STOP_TURN_WAIT_MS = 8_000;
/** The textarea grows from one line to this many, then scrolls (#2863). */
const COMPOSER_MAX_LINES = 8;

/**
 * Sends still awaiting the control plane, by panel scratch scope. A send outlives the panel that
 * started it — switching right panel mode unmounts it — and a panel mounted meanwhile restores the
 * very text on its way out; without this it would offer to send it again (#1284).
 */
const sendsInFlight = new Map<string, Promise<unknown>>();

/** One Stop Turn: the side chat and turn it was pressed for, which press it was, and when the panel
 * stops waiting for the turn to end. */
interface StopAttempt {
  childId: string;
  turn: string;
  attempt: number;
  deadline: number;
}

/**
 * Stop Turns still waiting for their turn to end, by panel scratch scope. Like a send, a stop
 * outlives the panel that pressed it, and a panel mounted meanwhile keeps the seat held rather than
 * offering Send over a turn that is being stopped (#2863).
 */
const stopsInFlight = new Map<string, StopAttempt>();
let stopAttempts = 0;
/** Every mounted panel hears a stop that failed, so one reopened while it waited lets go at once. */
const stopFailureListeners = new Set<(scope: string, attempt: number, cause: unknown) => void>();

/** Prose, so sentence case: these complete the sentence "This side chat …". */
const ENDED_PHRASE: Partial<Record<SessionStatus, string>> = {
  completed: "has finished",
  failed: "failed",
  stopped: "was stopped",
};

/**
 * The ended state's one sentence (#1206, #2863): what happened and where the transcript is. Its
 * remedy is the one button beside it, so the sentence does not repeat it.
 */
export function sideChatEndedSentence(status: SessionStatus): string {
  return `This side chat ${ENDED_PHRASE[status] ?? "ended"}. Its transcript stays here and in Sessions.`;
}

/** A child still being created on its machine: the composer takes a draft but cannot send it yet. */
function sideChatStarting(status: SessionStatus): boolean {
  return status === "starting" || status === "queued";
}

/**
 * The context line's one badge (#2863; §11.1, §11.2): the side chat's session word, Starting while
 * it is being created, and Unverified while its machine is offline, since then nobody can vouch for
 * a live status. An ended child stays ended whatever its machine is doing.
 */
export function sideChatStatusMeta(status: SessionStatus | "creating", runnerOnline: boolean): StatusMeta {
  if (status === "creating") return statusMeta("session", "starting");
  if (!runnerOnline && !isTerminal(status)) return statusMeta("job", "unverified");
  return statusMeta("session", status);
}

/** What a failed create was, kept for Retry and Show Details. */
interface StartFailure {
  replaceEnded: boolean;
  /** No response at all, or a gateway that gave up waiting for one. */
  noResponse: boolean;
  status?: number;
  message: string;
}

function startFailure(cause: unknown, replaceEnded: boolean): StartFailure {
  if (cause instanceof ApiError) {
    return { replaceEnded, noResponse: cause.status === 502 || cause.status === 503 || cause.status === 504,
      status: cause.status, message: cause.message };
  }
  return { replaceEnded, noResponse: true, message: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * Harness pages render `RightPanel` under an `ApiProvider` with no store (see
 * `src/e2e/request-surfaces-main.tsx`), and `useStoreActions` throws there. Keeping the one
 * store-backed control in its own component means adding this link cannot make the whole panel
 * un-renderable on those pages.
 *
 * A link, so a modified or middle click opens the child in a new tab; a plain click navigates in
 * place through the store (#2862).
 */
function OpenSideChatSession({ childSessionId }: { childSessionId: string }) {
  const { navigate } = useStoreActions();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate({ name: "session", id: childSessionId });
  };
  return (
    <a className="link sidechat-open-session" href={viewPath({ name: "session", id: childSessionId })} onClick={open}>
      Open Session
      <ArrowUpRightIcon size={14} aria-hidden="true" />
    </a>
  );
}

/**
 * About Side Chat (#2863; §4.9): what a side chat shares and what comes back, which used to sit as
 * two paragraphs above every first question. Open names the shortcut, which a touch-only device has
 * no keyboard for.
 */
function AboutSideChat() {
  const coarsePointer = useIsCoarsePointer();
  const facts = [
    { term: "Shared", value: "The agent and the project" },
    { term: "Not Shared", value: "This conversation, its attachments, artifacts and budget" },
    { term: "Comes Back", value: "Only a response you insert into your draft" },
    { term: "Send", value: "Enter works as in the main composer, following your Enter Key setting" },
    ...coarsePointer ? [] : [{ term: "Open", value: `${shortcutDisplay("open-side-chat")} from anywhere in the session` }],
  ];
  return (
    <PanelHeaderActions>
      <InfoPopover tool="Side Chat" facts={facts}>
        Ask this session&apos;s agent something without adding it to this conversation. The side chat
        runs in its own worktree.
      </InfoPopover>
    </PanelHeaderActions>
  );
}

/** The request and the response of a failed call, for Show Details. */
function FailureDetails({ request, failure }: { request: string; failure: { status?: number; message: string } }) {
  return (
    <div className="code-well">
      <pre>{`${request}\n${failure.status === undefined ? "No response" : `HTTP ${failure.status}`}: ${failure.message}`}</pre>
    </div>
  );
}

export function SideChatPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  onInsertDraft,
}: {
  session: SessionView;
  runnerOnline: boolean;
  /** The machine's protocol, which decides whether a turn can be interrupted. */
  runnerProtocolVersion?: number | null;
  /** Explicit composer preparation only. This callback must never submit the primary prompt. */
  onInsertDraft: (text: string) => void;
}) {
  const api = useApi();
  const hasStore = useHasStore();
  const runner = useOptionalStoreSelector((state) => state.runners.get(session.runnerId));
  const machine = runnerDisplay(runner, undefined, session.runnerId).name || "The machine";
  const agent = composerAgentName(session.driver, session.agentName, session.agentId);
  const [sideChat, setSideChat] = useState<SideChatView | null>();
  const [loadError, setLoadError] = useState<{ message: string; status?: number } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  /** The child and history generation whose first page has arrived; until then the transcript is
   * loading, never empty. */
  const [loadedTranscript, setLoadedTranscript] = useState<string | null>(null);
  // The unsent message belongs to the person typing it, not to the child: it survives the panel
  // being switched away and closed (#1202), the transcript resets around it, and no tour of other
  // sessions can evict the scope while it still holds one (#1283).
  const panelScratch = usePanelScratchScope(session.id);
  const [text, setText] = usePanelScratchDraft(panelScratch, SIDE_CHAT_DRAFT_KEY);
  const [creating, setCreating] = useState(false);
  const [startFailed, setStartFailed] = useState<StartFailure | null>(null);
  const [sending, setSending] = useState(false);
  // A remounted panel inherits a stop an earlier mount started, until that stop's deadline.
  const [stopping, setStopping] = useState<StopAttempt | null>(() => {
    const inherited = stopsInFlight.get(panelScratch);
    return inherited && inherited.deadline > Date.now() ? inherited : null;
  });
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const [actionError, setActionError] = useState<{ kind: "send" | "stop"; message: string; status?: number } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const enterKeySetting = useEnterKeyBehavior();
  const isTouchPhone = useIsTouchPhone();
  const mountedRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const restartRef = useRef<HTMLButtonElement | null>(null);
  const loadedRef = useRef(false);
  const focusPendingRef = useRef(false);
  const cursorRef = useRef(0);
  const epochRef = useRef(0);
  const reasonId = `sidechat-reason-${useId().replace(/:/g, "")}`;
  /**
   * The child the transcript state currently belongs to, tracked synchronously. A poll iteration
   * for the outgoing child can resolve after the switch but before React commits — and therefore
   * before the effect cleanup sets its `current` flag — so `current` alone cannot keep it from
   * writing the retired child's events back over the incoming one's.
   */
  const transcriptChildRef = useRef<string | undefined>(undefined);
  const childId = sideChat?.session.id;

  // Re-armed on every setup: StrictMode runs setup, cleanup and setup again, and a flag only ever
  // cleared left every create, send and stop in development unable to settle (#2863).
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  loadedRef.current = sideChat !== undefined;
  /** Settle a pending Ctrl/⌘+; once this panel has loaded: the first usable control takes focus. */
  const settleFocusRequest = useCallback(() => {
    if (!focusPendingRef.current || !loadedRef.current) return;
    focusPendingRef.current = false;
    // A dialog, menu or popover opened while the panel loaded owns the keyboard now; it keeps focus.
    if (shortcutLayerActive(document)) return;
    const target = [textareaRef.current, startRef.current, restartRef.current]
      .find((candidate) => candidate?.isConnected && !candidate.disabled);
    target?.focus();
  }, []);
  useEffect(() => {
    const listener = () => {
      focusPendingRef.current = true;
      settleFocusRequest();
    };
    if (takeSideChatFocusRequest()) listener();
    return subscribeSideChatFocus(listener);
  }, [settleFocusRequest]);
  // A request made while the panel was loading is settled by the render that loads it.
  useEffect(() => { settleFocusRequest(); }, [sideChat, settleFocusRequest]);

  // Inherit a send an earlier mount started, so its text is not offered for sending twice while it
  // is still in flight. The draft itself is cleared from under this composer when the send lands.
  useEffect(() => {
    const pending = sendsInFlight.get(panelScratch);
    if (!pending) return;
    let current = true;
    setSending(true);
    void pending.finally(() => { if (current) setSending(false); });
    return () => { current = false; };
  }, [panelScratch]);

  useEffect(() => {
    let current = true;
    setSideChat(undefined);
    setEvents([]);
    setLoadError(null);
    setStartFailed(null);
    void api.sideChat(session.id)
      .then(({ sideChat: loaded }) => {
        if (current) setSideChat(loaded);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setLoadError({ message: (cause as Error).message, status: cause instanceof ApiError ? cause.status : undefined });
      });
    return () => { current = false; };
  }, [api, session.id, loadAttempt]);

  /**
   * Drop the transcript belonging to whichever child we are leaving. Call this in the SAME commit as
   * the switch: React batches the two updates, so the incoming child never renders for a frame with
   * the retired child's events beneath it — which would also, briefly, offer that child's replies to
   * Insert into Draft, the one action that crosses back into the primary composer.
   */
  const resetTranscript = (next: SideChatView | null) => {
    transcriptChildRef.current = next?.session.id;
    cursorRef.current = 0;
    epochRef.current = next?.session.eventEpoch ?? 0;
    setEvents([]);
    setLoadedTranscript(null);
  };

  // Backstop for any path that changes the child without going through `resetTranscript`. It runs
  // after paint, so it settles state rather than preventing a mismatched frame.
  useEffect(() => {
    transcriptChildRef.current = childId;
    cursorRef.current = 0;
    epochRef.current = sideChat?.session.eventEpoch ?? 0;
    setEvents([]);
    setLoadedTranscript(null);
    // A start that "failed" while the replacement it asked for exists after all (the response was
    // lost) is over once polling adopts that child: its Retry would be refused as replacing a live
    // chat, and the failure would keep Send closed over a ready side chat.
    setStartFailed(null);
  }, [childId]);

  useEffect(() => {
    if (!childId) return;
    let current = true;
    let inFlight = false;
    const poll = async () => {
      if (!current || inFlight) return;
      inFlight = true;
      let readingEvents = false;
      try {
        // Poll the RELATIONSHIP, not just this child. Any other client can replace an ended side
        // chat, and a panel that watched only its own child stayed on the retired transcript for
        // good — its recovery action then failed with "the current side chat is still active"
        // forever, because it was still arguing about a child the parent had already let go.
        const { sideChat: latest } = await api.sideChat(session.id);
        if (!current || transcriptChildRef.current !== childId) return;
        // A different child means a new generation; this effect re-runs for it rather than merging
        // the two transcripts here.
        if (latest?.session.id !== childId) {
          resetTranscript(latest);
          setSideChat(latest);
          return;
        }
        setSideChat(latest);
        const epoch = latest.session.eventEpoch ?? 0;
        if (epochRef.current !== epoch) {
          epochRef.current = epoch;
          cursorRef.current = 0;
          setEvents([]);
          setLoadedTranscript(null);
        }
        readingEvents = true;
        const page = await api.getSessionEventPage(childId, cursorRef.current, epoch, PAGE_SIZE);
        if (!current || transcriptChildRef.current !== childId) return;
        if (page.events.length) {
          setEvents((prior) => {
            const bySeq = new Map(prior.map((event) => [event.seq, event]));
            for (const event of page.events) bySeq.set(event.seq, event);
            return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
          });
        }
        cursorRef.current = page.nextAfter ?? page.events.at(-1)?.seq ?? cursorRef.current;
        setLoadedTranscript(`${childId}:${epoch}`);
        setPollError(null);
      } catch (cause) {
        if (!current || transcriptChildRef.current !== childId) return;
        if (readingEvents && cause instanceof ApiError && cause.status === 409) {
          // The CP replaced this history generation. The next poll reloads the authoritative
          // session epoch and starts again from zero; never merge across generations. A 409 from
          // the relationship lookup is a different, reportable condition and must not land here.
          cursorRef.current = 0;
          setEvents([]);
          setLoadedTranscript(null);
        } else {
          setPollError((cause as Error).message);
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [api, childId, session.id]);

  const items = useTimeline(childId ?? "side-chat", events, sideChat?.session.eventEpoch ?? 0);
  // Identity-stable, so the transcript's row memo holds while the child streams (#2763).
  const insertReply = useCallback((item: AgentReplyItem) => onInsertDraft(item.text), [onInsertDraft]);

  const create = async (replaceEnded = false) => {
    if (creating) return;
    setCreating(true);
    setStartFailed(null);
    setActionError(null);
    const replacing = transcriptChildRef.current;
    try {
      const created = await api.createSideChat(session.id, replaceEnded);
      if (!mountedRef.current) return;
      if (created.session.id !== childId) resetTranscript(created);
      setSideChat(created);
    } catch (cause) {
      // Polling may have adopted the very child this request created before its answer was lost;
      // that start did not fail, and its Retry would be refused as replacing a live side chat.
      if (mountedRef.current && transcriptChildRef.current === replacing) {
        setStartFailed(startFailure(cause, replaceEnded));
      }
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };
  /** Start, then put the person in the composer, which takes a draft while the side chat starts. */
  const start = (replaceEnded: boolean) => {
    void create(replaceEnded);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const child = sideChat?.session;
  const childEnded = child !== undefined && isTerminal(child.status);
  const childStarting = creating || (child !== undefined && sideChatStarting(child.status));
  const canStopTurn = child !== undefined && canStopActiveTurn({
    runnerOnline,
    runnerProtocolVersion: runnerProtocolVersion ?? undefined,
    status: child.status,
    policyPaused: isPolicyApproval(child.pendingApproval),
    activeTurnId: child.activeTurnId,
  });
  const stopRefusal = child ? sessionCommandRefusal(child, "cancelTurn") : null;
  // The turn a Stop Turn was pressed for: once it is over, or another took its place, Send is back.
  const stoppingTurn = stopping !== null && canStopTurn && child?.id === stopping.childId &&
    child.activeTurnId === stopping.turn;
  /** Let go of a stop, here and in the registry, unless a newer press has replaced it there. */
  const releaseStop = useCallback((attempt: StopAttempt) => {
    if (stopsInFlight.get(panelScratch)?.attempt === attempt.attempt) stopsInFlight.delete(panelScratch);
    setStopping((current) => current?.attempt === attempt.attempt ? null : current);
  }, [panelScratch]);
  // Once the side chat has loaded, a stop whose turn is over is done. Before that nothing can say so:
  // a remounted panel keeps the seat held while it loads.
  useEffect(() => {
    if (stopping !== null && child !== undefined && !stoppingTurn) releaseStop(stopping);
  }, [child, releaseStop, stopping, stoppingTurn]);
  useEffect(() => {
    const listener = (scope: string, attempt: number, cause: unknown) => {
      if (scope !== panelScratch || stoppingRef.current?.attempt !== attempt) return;
      stoppingRef.current = null;
      setStopping(null);
      setActionError({ kind: "stop", message: (cause as Error).message,
        status: cause instanceof ApiError ? cause.status : undefined });
    };
    stopFailureListeners.add(listener);
    return () => { stopFailureListeners.delete(listener); };
  }, [panelScratch]);
  useEffect(() => {
    if (stopping === null) return;
    const timer = window.setTimeout(() => {
      releaseStop(stopping);
      setActionError({ kind: "stop", message: "The turn is still running." });
    }, Math.max(0, stopping.deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [releaseStop, stopping]);

  // Why Send is closed, as the visible reason beside it, or null when it is open. Send, Enter and
  // anything else that submits read this one answer, so a key never sends past a disabled button.
  const startingSentence = `Creating a worktree on ${machine}. You can type your question now and send it when the side chat is ready.`;
  const sendBlocked = childStarting ? startingSentence
    : startFailed ? "Start the side chat to send."
      : !runnerOnline ? `${machine} is offline.`
        : null;

  const send = async () => {
    const outgoing = text.trim();
    // A pending Stop Turn holds the seat, as the main composer's does: nothing sends until it settles.
    if (!child || !outgoing || sending || sendBlocked !== null || stoppingTurn || isTerminal(child.status)) return;
    const sent = text;
    const sentRevision = panelScratchRevision(panelScratch, SIDE_CHAT_DRAFT_KEY);
    setSending(true);
    setActionError(null);
    const prompted = api.prompt(child.id, outgoing);
    const settled = prompted.catch(() => undefined);
    sendsInFlight.set(panelScratch, settled);
    void settled.then(() => {
      if (sendsInFlight.get(panelScratch) === settled) sendsInFlight.delete(panelScratch);
    });
    try {
      await prompted;
      // Polling reports what the send started. The prompt's own answer is the stored session, with
      // no live turn coordinate, and adopting it would drop a pending Stop Turn's turn (#2863).
      // The send landed, so the draft it consumed must not come back — switching modes mid-flight
      // unmounts this panel before `setText("")` runs, and a restored copy of an already-sent
      // message invites sending it twice. Guarded on the revision as well as the text: a draft that
      // a remounted panel has since written — including a retry of the very same message — is a
      // different draft, and deleting it would take text the user can no longer see out from under
      // a live composer.
      clearPanelScratchIf(panelScratch, SIDE_CHAT_DRAFT_KEY, sent, sentRevision);
      if (!mountedRef.current) return;
      setText("");
    } catch (cause) {
      if (mountedRef.current) {
        setActionError({ kind: "send", message: (cause as Error).message,
          status: cause instanceof ApiError ? cause.status : undefined });
      }
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  /** Interrupt the side chat's own turn, as the main composer's Stop Turn does for the session's. */
  const stopTurn = async () => {
    if (!child?.activeTurnId || !canStopTurn || stopRefusal !== null || stoppingTurn) return;
    const attempt: StopAttempt = {
      childId: child.id, turn: child.activeTurnId, attempt: ++stopAttempts, deadline: Date.now() + STOP_TURN_WAIT_MS,
    };
    stopsInFlight.set(panelScratch, attempt);
    setStopping(attempt);
    setActionError(null);
    try {
      // Polling reports the turn's end. The stop's own answer is the stored session, which carries
      // no live turn coordinate, so adopting it would bring Send back while the turn still runs.
      await api.cancelTurn(child.id);
    } catch (cause) {
      // Only this press's own failure releases the seat: an earlier press failing late must not
      // reopen Send under a newer stop that is still waiting. Whichever panel holds it now hears it.
      if (stopsInFlight.get(panelScratch)?.attempt !== attempt.attempt) return;
      stopsInFlight.delete(panelScratch);
      for (const listener of stopFailureListeners) listener(panelScratch, attempt.attempt, cause);
    }
  };

  // The textarea grows from one line to eight. Where the browser sizes it to its content
  // (`field-sizing`), CSS does it; elsewhere this does, from the content's own height.
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field || field.ownerDocument.defaultView?.CSS?.supports?.("field-sizing", "content")) return;
    const lineHeight = Number.parseFloat(field.ownerDocument.defaultView?.getComputedStyle(field).lineHeight ?? "") || 22;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, lineHeight * COMPOSER_MAX_LINES)}px`;
  });

  // The main composer's Enter pair, read at keydown from the per-device setting: Enter sends and
  // Shift+Enter is a newline, or the reverse (#2862). Ctrl/⌘+Enter is the main composer's steering
  // key and does nothing here; an IME composition never sends.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
    if (!enterKeystrokeSends(event.shiftKey)) return;
    event.preventDefault();
    void send();
  };
  // Shift+Esc inside Side Chat is Side Chat's: it stops the side chat's turn, and never the session's
  // behind the panel, which the main composer's window-level shortcut would otherwise do.
  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !matchesShortcut(event, "stop-turn")) return;
    event.preventDefault();
    void stopTurn();
  };
  // Taps inside the composer keep focus in its textarea (§16.2), so on a phone Send works on the
  // first tap instead of first closing the keyboard and moving the card.
  const keepFocus = (event: PointerEvent<HTMLButtonElement>) => event.preventDefault();
  // The tooltip advertises whichever key sends under that setting, as the main composer's Send does;
  // a touch phone in newline mode has no Shift+Enter to advertise.
  const sendKeys = enterKeySetting === "send" ? "Enter" : isTouchPhone ? null : "Shift+Enter";

  const about = <AboutSideChat />;

  if (loadError && sideChat === undefined) {
    return (
      <>
        {about}
        <State variant="error" compact title="Couldn't Load Side Chat"
          actions={<button type="button" className="btn sm" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry</button>}
          details={<FailureDetails request={`GET /api/sessions/${session.id}/side-chat`} failure={loadError} />}>
          This session&apos;s side chat couldn&apos;t be loaded.
        </State>
      </>
    );
  }
  if (sideChat === undefined) {
    return <>{about}<TranscriptSkeleton label="Loading Side Chat" /></>;
  }

  const notStarted = !sideChat && !creating && !startFailed;
  if (notStarted) {
    const unavailable = !session.agentId
      ? "This session has no reusable agent."
      : !runnerOnline ? `${machine} is offline.` : null;
    return (
      <>
        {about}
        <State compact icon={<MessageSquareIcon />} title="Ask a Side Question" actions={(
          <>
            <button type="button" className="btn primary" ref={startRef} disabled={Boolean(unavailable)}
              aria-describedby={unavailable ? reasonId : undefined} onClick={() => start(false)}>
              Start Side Chat
            </button>
            {unavailable && <span className="sc-reason" id={reasonId}>{unavailable}</span>}
          </>
        )}>
          <p>Chat with this session&apos;s agent in a separate worktree. Nothing from this conversation is shared, and nothing comes back unless you insert it.</p>
          {session.agentId && <p className="sc-uses">Uses {agent} on {machine}.</p>}
        </State>
      </>
    );
  }

  const failure = startFailed;
  const failureNotice = failure && (
    <Notice tone="danger" role="alert" title="Couldn't Start Side Chat"
      actions={<button type="button" className="btn sm" ref={restartRef} onClick={() => start(failure.replaceEnded)}>Retry</button>}
      details={<FailureDetails request={`POST /api/sessions/${session.id}/side-chat`} failure={failure} />}>
      {failure.noResponse
        ? `${machine} didn't respond. Nothing was created, and your draft is kept.`
        : "The side chat couldn't be created. Your draft is kept."}
    </Notice>
  );

  // An ended child takes no message: its foot is one sentence and one way to start again, and while
  // a replacement is being created or failed to be, the composer it will take comes back.
  const showEnded = childEnded && !creating && !(failure?.replaceEnded);
  const primary = composerPrimaryAction({ canStopTurn, hasContent: Boolean(text.trim()), stopping: stoppingTurn });
  const canSend = sendBlocked === null && Boolean(text.trim()) && !sending;
  // A start that failed created nothing, so there is no status to show.
  const badge = creating ? sideChatStatusMeta("creating", runnerOnline)
    : child ? sideChatStatusMeta(child.status, runnerOnline) : null;

  const notices: SessionNoticeEntry[] = [];
  if (!runnerOnline && child && !childEnded) {
    notices.push({
      key: "sidechat-runner-offline",
      severity: "warning",
      rank: PANEL_NOTICE_RANK.runnerOffline,
      title: "Machine Offline",
      render: ({ trailing }) => (
        <Notice tone="warning" compact trailing={trailing}>
          {machine} is offline. You can send again when it reconnects.
        </Notice>
      ),
    });
  }
  if (pollError && child) {
    notices.push({
      key: "sidechat-load-error",
      severity: "danger",
      rank: PANEL_NOTICE_RANK.loadError,
      title: "Couldn't Refresh Side Chat",
      render: ({ trailing }) => (
        <Notice tone="danger" title="Couldn't Refresh Side Chat" trailing={trailing}
          details={<FailureDetails request={`GET /api/sessions/${child.id}/events`} failure={{ message: pollError }} />}>
          New messages aren&apos;t arriving. Wollipog keeps trying.
        </Notice>
      ),
    });
  }

  const transcriptLoaded = child !== undefined && loadedTranscript === `${child.id}:${child.eventEpoch ?? 0}`;
  const transcript = creating || !child ? null
    : !transcriptLoaded ? <TranscriptSkeleton label="Loading Side Chat Transcript" />
      : items.length ? (
        <EventTimeline
          items={items}
          driver={child.driver}
          sessionActive={isTimelineSessionActive(child.status)}
          historyKey={`${child.id}:${child.eventEpoch ?? 0}`}
          onInsertReply={insertReply}
        />
      ) : childEnded || childStarting ? null : <p className="sc-empty">No messages yet.</p>;

  return (
    <div className="sc-panel" onKeyDown={onPanelKeyDown}>
      {about}
      <PanelNoticeSlot sessionId={session.id} entries={notices} />
      <div className="sc-context">
        {badge && <StatusBadge meta={badge} role="status" />}
        <span className="sc-meta">Separate Worktree</span>
        {hasStore && child && !creating && <OpenSideChatSession childSessionId={child.id} />}
      </div>
      <div className="sc-transcript" role="region" aria-label="Side Chat Transcript">
        {transcript}
      </div>
      <div className="sc-foot">
        {showEnded ? (
          <div className="sc-ended">
            <p className="sc-ended-text">{sideChatEndedSentence(child!.status)}</p>
            <div className="sc-ended-action">
              <button type="button" className="btn primary" ref={restartRef} disabled={!runnerOnline}
                aria-describedby={!runnerOnline ? reasonId : undefined} onClick={() => start(true)}>
                Start New Side Chat
              </button>
              {!runnerOnline && <span className="sc-reason" id={reasonId}>{machine} is offline.</span>}
            </div>
          </div>
        ) : (
          <>
            {failureNotice}
            {!failure && childStarting && <p className="sc-reason" id={reasonId}>{startingSentence}</p>}
            {actionError && (
              <Notice tone="danger" compact role="alert"
                details={actionError.kind === "send" && child
                  ? <FailureDetails request={`POST /api/sessions/${child.id}/prompt`} failure={actionError} />
                  : undefined}>
                {actionError.kind === "send"
                  ? "Couldn't send your message. Your draft is kept."
                  : `Couldn't stop the side chat's turn. ${actionError.message}`}
              </Notice>
            )}
            <div className="sc-composer">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a side question…"
                aria-label="Side Chat Message"
                rows={1}
              />
              {primary === "send" ? (
                <button type="button" className="icon-btn primary" disabled={!canSend}
                  onPointerDown={keepFocus} onClick={() => void send()}
                  title={sendBlocked ?? (sendKeys ? `Send (${sendKeys})` : "Send")}
                  aria-label="Send" aria-keyshortcuts={sendKeys ?? undefined}
                  aria-describedby={childStarting && !failure ? reasonId : undefined}>
                  {sending ? <Spinner decorative /> : <ArrowUpIcon size={16} />}
                </button>
              ) : (
                <button type="button" className="icon-btn sc-stop"
                  disabled={primary === "stopping" || stopRefusal !== null}
                  onPointerDown={keepFocus} onClick={() => void stopTurn()}
                  title={primary === "stopping" ? "Stopping Turn" : stopRefusal ?? `Stop turn (${shortcutDisplay("stop-turn")})`}
                  aria-label={primary === "stopping" ? "Stopping Turn" : "Stop Turn"}
                  aria-keyshortcuts="Shift+Escape">
                  {primary === "stopping" ? <Spinner decorative /> : <StopTurnIcon size={16} />}
                </button>
              )}
            </div>
            {stopRefusal !== null && primary !== "send" && <p className="sc-reason">{stopRefusal}</p>}
          </>
        )}
      </div>
    </div>
  );
}
