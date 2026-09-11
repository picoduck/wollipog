import { createRoot } from "react-dom/client";
import { useState } from "react";
import { EventTimeline } from "../components/EventTimeline.js";
import "../styles.css";

function Fixture() {
  const [rewoundTurn, setRewoundTurn] = useState<number | null>(null);
  return (
    <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 32 }}>
      <section style={{ maxWidth: 760, margin: "0 auto" }}>
        <EventTimeline
          items={[
            { kind: "user_message", id: 1, text: "Inspect the checkpoint controls." },
            { kind: "checkpoint", id: 2, turn: 4 },
            { kind: "agent_message", id: 3, text: "The checkpoint is ready." },
          ]}
          onRewind={setRewoundTurn}
        />
        {rewoundTurn != null && <p role="status">Rewind requested for turn {rewoundTurn}.</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
