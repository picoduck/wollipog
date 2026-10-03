import { useCallback, useEffect, useState } from "react";
import type { OperationalTranscriptMessage, PublicTranscriptShare } from "@wollipog/protocol";
import { CONTROL_PLANE_HTTP } from "../config.js";
import { transcriptShareRequest } from "../transcript-share-client.js";
import { sharePageExpiryLabel } from "../transcript-share-time.js";
import { LinkIcon } from "./Icons.js";
import { Markdown } from "./Markdown.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { TranscriptSkeleton } from "./TranscriptSkeleton.js";

/** The line the projection writes where a turn was interrupted (share-projection.ts). */
const INTERRUPTED_MARKER = "[Turn interrupted]";

type ShareState =
  | { kind: "loading" }
  | { kind: "ready"; value: PublicTranscriptShare }
  | { kind: "unavailable" }
  | { kind: "network"; message: string };

const isInterruption = (message: OperationalTranscriptMessage) =>
  message.role === "assistant" && message.text === INTERRUPTED_MARKER;

/** "12 messages": what people said, not the interruption lines between them. */
export function sharedMessageCount(messages: readonly OperationalTranscriptMessage[]): string {
  const count = messages.filter((message) => !isInterruption(message)).length;
  return `${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}`;
}

/**
 * One projected message in the transcript's own recipes (#2151, #2152): a person's message is a
 * right-aligned bubble with the inline profile, a reply is unframed document markdown, and an
 * interruption is a quiet Stopped line. No media is embedded: an anonymous viewer gets plain links,
 * and raw HTML stays disabled in both profiles.
 */
function SharedMessage({ message }: { message: OperationalTranscriptMessage }) {
  if (isInterruption(message)) {
    return <div className="tl-interrupted"><span>Stopped</span></div>;
  }
  if (message.role === "user") {
    return (
      <div className="tl-row user">
        <div className="tl-message-stack user">
          <div className="tl-bubble">
            <div className="bubble-text"><Markdown profile="inline">{message.text}</Markdown></div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="tl-agent-msg">
      <Markdown compactUrls>{message.text}</Markdown>
    </div>
  );
}

/**
 * The page a transcript share link opens (#2173, docs/design-system.md §4.4, §12, §13.2): a 48px bar
 * with the product mark, the page title with the message count and expiry, one warning notice, and
 * the messages. It runs outside the authenticated shell, so it reads nothing but the public share.
 */
export function SharedTranscript({ token }: { token: string | null }) {
  const [state, setState] = useState<ShareState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!token) {
      setState({ kind: "unavailable" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const request = transcriptShareRequest(CONTROL_PLANE_HTTP, token);
    void fetch(request.url, request.init)
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setState({ kind: "unavailable" });
          return;
        }
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const value = await response.json() as PublicTranscriptShare;
        if (!cancelled) setState({ kind: "ready", value });
      })
      .catch((error) => {
        if (!cancelled) setState({ kind: "network", message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [attempt, token]);

  const messages = state.kind === "ready" ? state.value.transcript.messages : [];
  return (
    <div className="share-page">
      <header className="share-bar">
        <img className="brand-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
        <span className="share-bar-title">Shared Transcript</span>
      </header>
      <main className="share-main" aria-labelledby="shared-transcript-title">
        <div className="share-head">
          <h1 className="share-title" id="shared-transcript-title">Shared Transcript</h1>
          {state.kind === "ready" && (
            <>
              <p className="share-meta">
                {sharedMessageCount(messages)} · {sharePageExpiryLabel(state.value.expiresAt, Date.now())}
              </p>
              <Notice tone="warning" compact role="note">
                Secrets were removed automatically, but this may still contain code or personal information.
              </Notice>
            </>
          )}
        </div>
        {state.kind === "loading" && <TranscriptSkeleton label="Loading Shared Transcript" />}
        {state.kind === "unavailable" && (
          <State compact icon={<LinkIcon />} title="This Link Isn't Available" headingLevel={2}>
            Ask the person who shared it for a new link.
          </State>
        )}
        {state.kind === "network" && (
          <State
            variant="error"
            title="Couldn't Load This Transcript"
            headingLevel={2}
            actions={<button className="btn sm" type="button" onClick={retry}>Retry</button>}
            details={<div className="code-well"><pre>{state.message}</pre></div>}
          >
            Check your connection, then try again.
          </State>
        )}
        {state.kind === "ready" && messages.length === 0 && (
          <State compact>This transcript has no messages yet.</State>
        )}
        {state.kind === "ready" && messages.length > 0 && (
          <div className="timeline" role="list" aria-label="Messages">
            {messages.map((message, index) => (
              <div
                key={index}
                role="listitem"
                className={index > 0 && message.role === "user" ? "tl-turn-start" : undefined}
              >
                <SharedMessage message={message} />
              </div>
            ))}
          </div>
        )}
      </main>
      <footer className="share-foot">
        Shared from Wollipog.
        {state.kind === "ready" && " Only messages are included, and older ones may be missing."}
      </footer>
    </div>
  );
}
