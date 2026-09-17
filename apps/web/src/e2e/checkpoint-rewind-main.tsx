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
            { kind: "conversation_checkpoint", id: 4, turn: 4 },
            { kind: "checkpoint_restored", id: 5, turn: 4 },
            { kind: "conversation_forked", id: 6, sourceSessionId: "source", turn: 4 },
            {
              kind: "conversation_forked", id: 7, sourceSessionId: "source", turn: 4,
              handoff: {
                sourceAgent: "Claude Code",
                destinationAgent: "Codex",
                disclosure: "Tool output and reasoning were omitted.",
              },
            },
          ]}
          onRewind={setRewoundTurn}
        />
        {rewoundTurn != null && <p role="status">Rewind requested for turn {rewoundTurn}.</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
