import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isTerminal, type SessionEvent, type SessionView, type SideChatView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { EventTimeline } from "./EventTimeline.js";
import { useTimeline } from "./useTimeline.js";
import { isTimelineSessionActive } from "../timeline-clock.js";

const POLL_MS = 1_500;
const PAGE_SIZE = 200;

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
  const [sideChat, setSideChat] = useState<SideChatView | null>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [text, setText] = useState("");
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const cursorRef = useRef(0);
  const epochRef = useRef(0);
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

  useEffect(() => {
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
      try {
        const { session: latest } = await api.session(childId);
        if (!current) return;
        setSideChat((prior) => prior?.session.id === childId ? { ...prior, session: latest } : prior);
        const epoch = latest.eventEpoch ?? 0;
        if (epochRef.current !== epoch) {
          epochRef.current = epoch;
          cursorRef.current = 0;
          setEvents([]);
        }
        const page = await api.getSessionEventPage(childId, cursorRef.current, epoch, PAGE_SIZE);
        if (!current) return;
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
        if (!current) return;
        if (cause instanceof ApiError && cause.status === 409) {
          // The CP replaced this history generation. The next poll reloads the authoritative
          // session epoch and starts again from zero; never merge across generations.
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
  }, [api, childId]);

  const items = useTimeline(childId ?? "side-chat", events);
  const latestResponse = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind === "agent_message" && !item.parentToolUseId && item.text.trim()) return item.text;
    }
    return null;
  }, [items]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createSideChat(session.id);
      if (mountedRef.current) setSideChat(created);
    } catch (cause) {
      if (mountedRef.current) setError((cause as Error).message);
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  };

  const send = async () => {
    const outgoing = text.trim();
    if (!sideChat || !outgoing || sending || !runnerOnline || isTerminal(sideChat.session.status)) return;
    setSending(true);
    setError(null);
    try {
      const updated = await api.prompt(sideChat.session.id, outgoing);
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

  const canSend = runnerOnline && !isTerminal(sideChat.session.status) && Boolean(text.trim()) && !sending;
  return (
    <div className="sidechat-panel">
      <div className="sidechat-boundary" role="note">
        <strong>Isolated Side Chat</strong>
        <span>{sideChat.session.status} · separate worktree and transcript</span>
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
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="sidechat-composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask without sharing the primary transcript…"
          aria-label="Side Chat Message"
          rows={3}
          disabled={!runnerOnline || isTerminal(sideChat.session.status)}
        />
        <button type="button" className="btn primary" disabled={!canSend} onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      <div className="hint sidechat-shortcut">Ctrl/⌘+Enter to send</div>
    </div>
  );
}
