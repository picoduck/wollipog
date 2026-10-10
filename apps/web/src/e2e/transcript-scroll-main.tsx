import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { EventTimeline } from "../components/EventTimeline.js";
import * as MarkdownModule from "../components/Markdown.js";
import { deriveTimeline } from "../timeline.js";
import { transcriptScrollEvents } from "./transcript-scroll-fixture.js";
import "../styles.css";

const events = transcriptScrollEvents();
const items = deriveTimeline(events);
declare global {
  interface Window { __transcriptScrollCache: () => { entries: number; sourceCharacters: number; parses: number; hits: number } }
}
// The same fixture can be overlaid on the baseline revision, which has no content cache export.
const cache = Reflect.get(MarkdownModule, "markdownContentCache") as { snapshot(): ReturnType<Window["__transcriptScrollCache"]> } | undefined;
window.__transcriptScrollCache = () => cache?.snapshot() ?? { entries: 0, sourceCharacters: 0, parses: 0, hits: 0 };
function ScrollFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <main style={{ display: "flex", height: "100vh", background: "var(--bg)" }}>
      <div className="detail-scroll measured-virtual-scroll" ref={scrollRef}
        data-testid="reader" data-event-count={events.length} style={{ flex: 1, minWidth: 0 }}>
        <EventTimeline items={items} scrollRef={scrollRef} historyKey="synthetic-scroll:1" />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<ScrollFixture />);
