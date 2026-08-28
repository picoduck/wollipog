import { useRef } from "react";
import { createRoot } from "react-dom/client";
import type { TimelineItem } from "../timeline.js";
import { EventTimeline } from "../components/EventTimeline.js";
import "../styles.css";

const imageUrl = "https://evidence.example/session-review.png?X-Amz-Signature=redacted";
const videoUrl = "https://evidence.example/session-walkthrough.webm?X-Amz-Signature=redacted";

const items: TimelineItem[] = [
  { kind: "user_message", id: 1, text: "Can you show me the responsive result before I approve the merge?" },
  {
    kind: "agent_message",
    id: 2,
    text: `The responsive session view is ready for review.\n\n${imageUrl}\n\nInteraction recording:\n${videoUrl}`,
  },
  { kind: "user_message", id: 3, text: "The screenshot is clear on mobile. What happens if an evidence link expires?" },
  {
    kind: "agent_message",
    id: 4,
    text: "Expired media falls back to its original link without leaving a broken placeholder in the transcript.",
  },
];

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <main style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      <header style={{ borderBottom: "1px solid var(--border)", padding: "14px 20px", background: "var(--surface)" }}>
        <div style={{ color: "var(--text-faint)", fontSize: 12 }}>Wollipog / Session</div>
        <h1 style={{ fontSize: 18, margin: "3px 0 0" }}>Review Inline Evidence</h1>
      </header>
      <div className="detail-scroll" ref={scrollRef} data-testid="reader" style={{ flex: 1, padding: "20px" }}>
        <EventTimeline items={items} scrollRef={scrollRef} historyKey="inline-media-e2e" />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
