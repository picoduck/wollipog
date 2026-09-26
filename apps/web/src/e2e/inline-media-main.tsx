import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { TimelineBuilder } from "../timeline.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { useTimeline } from "../components/useTimeline.js";
import "../styles.css";

const finalImageUrl = "https://evidence.example/session-review.png?X-Amz-Signature=redacted";
const videoUrl = "https://evidence.example/session-walkthrough.webm?X-Amz-Signature=redacted";
const streamedImageUrls = [
  "https://evidence.example/session-review.png?X-Amz-Signature=r",
  "https://evidence.example/session-review.png?X-Amz-Signature=re",
  finalImageUrl,
];
const replayAttachment: SessionEvent = {
  id: 501, sessionId: "attachment-replay-e2e", seq: 1, ts: 2_000,
  payload: { kind: "artifact_attached", artifact: {
    artifactId: "replay-proof", sessionId: "attachment-replay-e2e", kind: "screenshot",
    name: "proof.png", mimeType: "image/png", encoding: "base64", sizeBytes: 70_182,
    sha256: "1f3a9c4feced44d27b2b68bb4027ce7fa3cd0b4594ff00d78c9d46e004bd9fb4",
    createdBy: { kind: "agent", id: "attachment-replay-e2e" },
    createdAt: 2_000,
  } },
};
const replayBefore: SessionEvent = {
  id: 502, sessionId: "attachment-replay-e2e", seq: 2, ts: 1_000,
  payload: { kind: "user_message", text: "The first message came before the attachment." },
};
const replayAfter: SessionEvent = {
  id: 503, sessionId: "attachment-replay-e2e", seq: 3, ts: 3_000,
  payload: { kind: "user_message", text: "The next message came after the attachment." },
};

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingScenario = new URLSearchParams(window.location.search).has("streaming");
  const replayScenario = new URLSearchParams(window.location.search).has("attachmentReplay");
  const freshTailScenario = new URLSearchParams(window.location.search).has("freshTail");
  const legacyReplayOrder = new URLSearchParams(window.location.search).has("legacyOrder");
  const [streamStep, setStreamStep] = useState(0);
  const [replayed, setReplayed] = useState(false);
  const replayItems = useTimeline("attachment-replay-e2e",
    freshTailScenario ? [replayBefore, replayAfter]
      : replayed ? [replayAttachment, replayBefore, replayAfter] : [replayAttachment], 1);
  const legacyReplayItems = useMemo(() => {
    const builder = new TimelineBuilder();
    for (const event of replayed
      ? [replayAttachment, replayBefore, replayAfter]
      : [replayAttachment]) builder.push(event);
    return builder.snapshot();
  }, [replayed]);
  const mediaSettled = !streamingScenario || streamStep === streamedImageUrls.length - 1;
  const imageUrl = streamingScenario ? streamedImageUrls[streamStep]! : finalImageUrl;
  const items = useMemo(() => {
    const builder = new TimelineBuilder();
    let seq = 0;
    const push = (payload: SessionEventPayload) => {
      seq += 1;
      builder.push({ id: seq, sessionId: "inline-media-e2e", seq, ts: seq * 1_000, payload } as SessionEvent);
    };
    push({ kind: "user_message", text: "Can you show me the responsive result before I approve the merge?" });
    push({
      kind: "agent_message",
      text: `The responsive session view is ready for review.\n\n${imageUrl}\n\nInteraction recording:\n${videoUrl}`,
      messageId: "review-response",
    });
    if (mediaSettled) {
      push({ kind: "agent_response_completed" });
      push({ kind: "user_message", text: "The screenshot is clear on mobile. What happens if an evidence link expires?" });
      push({
        kind: "agent_message",
        text: "Expired media falls back to its original link without leaving a broken placeholder in the transcript.",
        final: true,
      });
    }
    return builder.snapshot();
  }, [imageUrl, mediaSettled]);
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      {streamingScenario && (
        <button
          type="button"
          hidden
          data-testid="advance-media-stream"
          onClick={() => setStreamStep((step) => Math.min(step + 1, streamedImageUrls.length - 1))}
        >
          Advance Media Stream
        </button>
      )}
      {replayScenario && <button type="button" data-testid="replay-runner-history"
        onClick={() => setReplayed(true)}>Replay Runner History</button>}
      <header style={{ borderBottom: "1px solid var(--border)", padding: "14px 20px", background: "var(--surface)" }}>
        <div style={{ color: "var(--text-faint)", fontSize: 12 }}>Wollipog / Session</div>
        <h1 style={{ fontSize: 18, margin: "3px 0 0" }}>{replayScenario ? "Attachment Replay" : "Review Inline Evidence"}</h1>
      </header>
      <div className="detail-scroll" ref={scrollRef} data-testid="reader" style={{ flex: 1, padding: "20px" }}>
        <EventTimeline
          items={replayScenario ? (legacyReplayOrder ? legacyReplayItems : replayItems) : items}
          scrollRef={scrollRef}
          historyKey="inline-media-e2e"
          sessionActive={streamingScenario}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
