import { useEffect, useMemo, useState } from "react";
import type { AssistantThread } from "@wollipog/protocol";
import { useApi } from "./api-context.js";
import { assistantThreadPendingKey, onAssistantThreadUpsert, pendingAssistantConfirmationsByThread } from "./assistant-confirmations.js";
import { assistantThreadsOwnerOnly, assistantThreadsUnavailable } from "./assistant-threads.js";
import { useStoreSelector } from "./store.js";

function attentionKey(thread: AssistantThread): string {
  return `${thread.status === "needs_you"}:${assistantThreadPendingKey(thread)}`;
}

/** One owner-only list read feeds both the Assistants badge and the Inbox approvals notice. */
export function useAssistantAttention() {
  const api = useApi();
  const online = useStoreSelector((state) => state.conn === "online");
  const [threads, setThreads] = useState<readonly AssistantThread[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hasConfirmations = threads.some((thread) => thread.confirmations?.length);

  useEffect(() => {
    if (!online) return;
    let latestRead = 0;
    let retry: number | undefined;
    let keys = new Map<string, string>();
    const refresh = () => {
      window.clearTimeout(retry);
      const read = ++latestRead;
      const attempt = (delay: number) => void api.assistantConfirmationThreads().then(
        ({ threads: listed }) => {
          if (read !== latestRead) return;
          keys = new Map(listed.map((thread) => [thread.id, attentionKey(thread)]));
          setNow(Date.now());
          setThreads(listed);
        },
        (error: unknown) => {
          if (read !== latestRead) return;
          if (assistantThreadsUnavailable(error) || assistantThreadsOwnerOnly(error)) {
            setThreads([]);
            return;
          }
          retry = window.setTimeout(() => attempt(Math.min(delay * 2, 30_000)), delay);
        },
      );
      attempt(2_000);
    };
    const unsubscribe = onAssistantThreadUpsert((thread) => {
      const key = attentionKey(thread);
      if (keys.get(thread.id) === key) return;
      keys.set(thread.id, key);
      refresh();
    });
    // Reconnects may have missed events. A newer read or disconnect retires older answers and retries.
    refresh();
    return () => {
      latestRead += 1;
      window.clearTimeout(retry);
      unsubscribe();
    };
  }, [api, online]);

  useEffect(() => {
    // The Inbox hides an expired confirmation even if the connection has missed its expiry event.
    if (!hasConfirmations) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasConfirmations]);

  return useMemo(() => ({
    // The server combines confirmations and backing-session questions into the same row status.
    count: threads.filter((thread) => thread.status === "needs_you").length,
    confirmations: pendingAssistantConfirmationsByThread(threads, now),
  }), [threads, now]);
}
