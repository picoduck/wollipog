import { useCallback, useEffect, useState } from "react";
import type { AssistantThreadHistoryEntry, SessionEvent } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { assistantThreadHarnessLabel } from "../assistant-threads.js";
import { formatCalendarTime } from "../format.js";
import { deriveTimeline, type TimelineItem } from "../timeline.js";
import { Markdown } from "./Markdown.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

export function AssistantThreadHistory({ entries }: { entries: AssistantThreadHistoryEntry[] }) {
  const [open, setOpen] = useState<AssistantThreadHistoryEntry | null>(null);
  return <>
    <div className="form" role="region" aria-label="Earlier Conversations">
      <h3 className="group-label">Earlier Conversations</h3>
      {entries.map((entry) => <div className="assistant-history-row" key={entry.sessionId}>
        <p className="muted">
          Switched from {assistantThreadHarnessLabel(entry.harness)} to {assistantThreadHarnessLabel(entry.nextHarness)}
          {" · "}{formatCalendarTime(entry.switchedAt)}
        </p>
        <button type="button" className="btn sm" onClick={() => setOpen(entry)}
          aria-label={`Open Earlier Conversation (${assistantThreadHarnessLabel(entry.harness)})`}>
          Open
        </button>
      </div>)}
    </div>
    {open && <EarlierConversation key={open.sessionId} entry={open} onClose={() => setOpen(null)} />}
  </>;
}

type HistoryPage = { before?: number; epoch: number; complete?: boolean };

function EarlierConversation({ entry, onClose }: { entry: AssistantThreadHistoryEntry; onClose: () => void }) {
  const api = useApi();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (more?: HistoryPage) => {
    setBusy(true);
    setError(null);
    try {
      const epoch = more?.epoch ?? (await api.session(entry.sessionId)).session.eventEpoch ?? 0;
      const next = await api.getSessionEventTailPage(entry.sessionId, more?.before, epoch);
      setEvents((current) => more ? [...next.events, ...current] : next.events);
      setPage({ before: next.hasMoreOlder ? next.nextBefore : undefined, epoch, complete: next.cacheComplete });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the earlier conversation.");
    } finally {
      setBusy(false);
    }
  }, [api, entry.sessionId]);

  useEffect(() => { void load(); }, [load]);

  const messages = deriveTimeline(events).filter((item): item is Extract<TimelineItem, { kind: "user_message" | "agent_message" }> =>
    item.kind === "user_message" || item.kind === "agent_message" && !item.parentToolUseId);
  return <Modal title={`Earlier Conversation (${assistantThreadHarnessLabel(entry.harness)})`} phoneSheet="full"
    onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
    <div className="form">
      {page?.before !== undefined && <BusyButton className="btn" busy={busy} progress="Loading earlier messages…"
        onClick={() => void load(page)}>Load Earlier Messages</BusyButton>}
      {busy && !page && <p role="status">Loading the earlier conversation…</p>}
      {error && <Notice tone="danger" role="alert">{error}
        <button type="button" className="btn sm" onClick={() => void load()}>Retry</button></Notice>}
      {page?.complete === false && !busy &&
        <Notice tone="warning">Some events are still loading from the Machine.
          <button type="button" className="btn sm" onClick={() => void load()}>Refresh History</button>
        </Notice>}
      {page && !messages.length && <p>No messages in this part of the conversation.</p>}
      {messages.map((message) => <div className="bubble-text" key={message.id}>
        <strong>{message.kind === "user_message" ? "You" : "Assistant"}</strong>
        <Markdown>{message.text}</Markdown>
      </div>)}
    </div>
  </Modal>;
}
