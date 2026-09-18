import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isTerminal, type SessionEvent, type SessionStatus, type SessionView, type SideChatView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useHasStore, useStoreActions } from "../store.js";
import { EventTimeline } from "./EventTimeline.js";
import { useTimeline } from "./useTimeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";
import {
  clearPanelScratchIf,
  panelScratchRevision,
  usePanelScratchDraft,
  usePanelScratchScope,
} from "../right-panel-scratch.js";

const POLL_MS = 1_500;
const SIDE_CHAT_DRAFT_KEY = "sidechat.draft";
const PAGE_SIZE = 200;

/** Prose, so sentence case: these complete the sentence "This side chat's session …". */
const ENDED_PHRASE: Partial<Record<SessionStatus, string>> = {
  completed: "has finished",
  failed: "failed",
  stopped: "was stopped",
};

/**
 * Why the composer is unavailable, or null when it is usable. An ended child and an offline runner
 * are different problems with different remedies, so they never share one message (#1206).
 */
export function sideChatComposerUnavailable(
  status: SessionStatus,
  runnerOnline: boolean,
): string | null {
  if (isTerminal(status)) {
    return `This side chat's session ${ENDED_PHRASE[status] ?? "ended"}, so it can no longer receive ` +
      "messages. Start a new side chat to continue; the ended transcript stays open at the link above.";
  }
  if (!runnerOnline) return "The runner is offline, so this side chat cannot send messages until it reconnects.";
  return null;
}

/**
 * Harness pages render `RightPanel` under an `ApiProvider` with no store (see
 * `src/e2e/request-surfaces-main.tsx`), and `useStoreActions` throws there. Keeping the one
 * store-backed control in its own component means adding this link cannot make the whole panel
 * un-renderable on those pages.
 */
function OpenSideChatSession({ childSessionId }: { childSessionId: string }) {
  const { navigate } = useStoreActions();
  return (
    <button type="button" className="btn sidechat-open-child"
      onClick={() => navigate({ name: "session", id: childSessionId })}>
      Open Side Chat Session
    </button>
  );
}

export function SideChatPanel({
  session,
  runnerOnline,
  onInsertDraft,
}: {
  session: SessionView;
  runnerOnline: boolean;
  /** Explicit composer preparation only. This callback must never submit the primary prompt. */
  onInsertDraft: (text: string) => void;
}) {
  const api = useApi();
  const hasStore = useHasStore();
  const [sideChat, setSideChat] = useState<SideChatView | null>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // The unsent message belongs to the person typing it, not to the child: it survives the panel
  // being switched away and closed (#1202), the transcript resets around it, and no tour of other
  // sessions can evict the scope while it still holds one (#1283).
  const panelScratch = usePanelScratchScope(session.id);
  const [text, setText] = usePanelScratchDraft(panelScratch, SIDE_CHAT_DRAFT_KEY);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const cursorRef = useRef(0);
  const epochRef = useRef(0);
  /**
   * The child the transcript state currently belongs to, tracked synchronously. A poll iteration
   * for the outgoing child can resolve after the switch but before React commits — and therefore
   * before the effect cleanup sets its `current` flag — so `current` alone cannot keep it from
   * writing the retired child's events back over the incoming one's.
   */
  const transcriptChildRef = useRef<string | undefined>(undefined);
  const childId = sideChat?.session.id;

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    let current = true;
    setSideChat(undefined);
    setEvents([]);
    setError(null);
    void api.sideChat(session.id)
      .then(({ sideChat: loaded }) => {
        if (current) setSideChat(loaded);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setSideChat(null);
        setError((cause as Error).message);
      });
    return () => { current = false; };
  }, [api, session.id]);

  /**
   * Drop the transcript belonging to whichever child we are leaving. Call this in the SAME commit as
   * the switch: React batches the two updates, so the incoming child never renders for a frame with
   * the retired child's events beneath it — which would also, briefly, offer that child's text to
   * "Insert Latest Response into Primary Draft", the one action that crosses back into the primary
   * composer.
   */
  const resetTranscript = (next: SideChatView | null) => {
    transcriptChildRef.current = next?.session.id;
    cursorRef.current = 0;
    epochRef.current = next?.session.eventEpoch ?? 0;
    setEvents([]);
  };

  // Backstop for any path that changes the child without going through `resetTranscript`. It runs
  // after paint, so it settles state rather than preventing a mismatched frame.
  useEffect(() => {
    transcriptChildRef.current = childId;
    cursorRef.current = 0;
    epochRef.current = sideChat?.session.eventEpoch ?? 0;
    setEvents([]);
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
        setError(null);
      } catch (cause) {
        if (!current || transcriptChildRef.current !== childId) return;
        if (readingEvents && cause instanceof ApiError && cause.status === 409) {
          // The CP replaced this history generation. The next poll reloads the authoritative
          // session epoch and starts again from zero; never merge across generations. A 409 from
          // the relationship lookup is a different, reportable condition and must not land here.
          cursorRef.current = 0;
          setEvents([]);
        } else {
          setError((cause as Error).message);
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

  const items = useTimeline(childId ?? "side-chat", events);
  const latestResponse = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "agent_message" && !item.parentToolUseId && item.text.trim()) return item.text;
    }
    return null;
  }, [items]);

  const create = async (replaceEnded = false) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createSideChat(session.id, replaceEnded);
      if (!mountedRef.current) return;
      if (created.session.id !== childId) resetTranscript(created);
      setSideChat(created);
    } catch (cause) {
      if (mountedRef.current) setError((cause as Error).message);
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  const send = async () => {
    const outgoing = text.trim();
    if (!sideChat || !outgoing || sending || !runnerOnline || isTerminal(sideChat.session.status)) return;
    const sent = text;
    const sentRevision = panelScratchRevision(panelScratch, SIDE_CHAT_DRAFT_KEY);
    setSending(true);
    setError(null);
    try {
      const updated = await api.prompt(sideChat.session.id, outgoing);
      // The send landed, so the draft it consumed must not come back — switching modes mid-flight
      // unmounts this panel before `setText("")` runs, and a restored copy of an already-sent
      // message invites sending it twice. Guarded on the revision as well as the text: a draft that
      // a remounted panel has since written — including a retry of the very same message — is a
      // different draft, and deleting it would take text the user can no longer see out from under
      // a live composer.
      clearPanelScratchIf(panelScratch, SIDE_CHAT_DRAFT_KEY, sent, sentRevision);
      if (!mountedRef.current) return;
      setSideChat((prior) => prior ? { ...prior, session: updated } : prior);
      setText("");
    } catch (cause) {
      if (mountedRef.current) setError((cause as Error).message);
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  };

  if (sideChat === undefined) return <div className="hint" role="status">Loading side chat…</div>;
  if (!sideChat) {
    const unavailable = !session.agentId
      ? "This session has no reusable agent."
      : !runnerOnline ? "The runner must be online to start a side chat." : null;
    return (
      <div className="sidechat-empty">
        <p>Start a separate conversation using this session&apos;s agent in an isolated worktree.</p>
        <p className="hint">No prompt, transcript, attachments, artifacts, or budget are copied. Only text you explicitly insert returns to the primary composer.</p>
        {unavailable && <div className="hint warn" role="status">{unavailable}</div>}
        {error && <div className="error-box" role="alert">{error}</div>}
        <button type="button" className="btn primary" disabled={creating || Boolean(unavailable)} onClick={() => void create()}>
        {creating ? "Starting…" : "Start Side Chat"}
        </button>
      </div>
    );
  }

  const childEnded = isTerminal(sideChat.session.status);
  const unavailable = sideChatComposerUnavailable(sideChat.session.status, runnerOnline);
  // Starting the replacement launches a child on the runner, so it needs the runner even though the
  // ended child is the reason the composer is closed.
  const replacementBlocked = childEnded && !runnerOnline
    ? "The runner must be online to start a new side chat." : null;
  const canSend = !unavailable && Boolean(text.trim()) && !sending;
  return (
    <div className="sidechat-panel">
      <div className="sidechat-boundary" role="note">
        <strong>Isolated Side Chat</strong>
        <span>{sideChat.session.status} · separate worktree and transcript</span>
        {hasStore && <OpenSideChatSession childSessionId={sideChat.session.id} />}
      </div>
      <div className="sidechat-timeline" aria-label="Side Chat Transcript">
        {items.length ? (
          <EventTimeline
            items={items}
            driver={sideChat.session.driver}
            sessionActive={isTimelineSessionActive(sideChat.session.status)}
            historyKey={`${sideChat.session.id}:${sideChat.session.eventEpoch ?? 0}`}
          />
        ) : (
          <div className="hint">No messages yet. Ask a question below; primary-session context is not included.</div>
        )}
      </div>
      {latestResponse && (
        <button type="button" className="btn sidechat-insert" onClick={() => onInsertDraft(latestResponse)}>
          Insert Latest Response into Primary Draft
        </button>
      )}
      {unavailable && <div className="hint warn" role="status">{unavailable}</div>}
      {replacementBlocked && <div className="hint warn" role="status">{replacementBlocked}</div>}
      {childEnded && (
        <button type="button" className="btn primary sidechat-restart"
          disabled={creating || Boolean(replacementBlocked)} onClick={() => void create(true)}>
          {creating ? "Starting…" : "Start a New Side Chat"}
        </button>
      )}
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="sidechat-composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask without sharing the primary transcript…"
          aria-label="Side Chat Message"
          rows={3}
          disabled={Boolean(unavailable)}
        />
        <button type="button" className="btn primary" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="hint sidechat-shortcut">Ctrl/⌘+Enter to send</div>
    </div>
  );
}
