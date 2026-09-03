import { createRoot } from "react-dom/client";
import { EventTimeline } from "../components/EventTimeline.js";
import "../styles.css";

function Fixture() {
  return (
    <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 32 }}>
      <section style={{ maxWidth: 760, margin: "0 auto" }}>
        <EventTimeline
          items={[
            { kind: "user_message", id: 1, text: "Inspect the checkpoint controls." },
            { kind: "checkpoint", id: 2, turn: 4 },
            { kind: "agent_message", id: 3, text: "The checkpoint is ready." },
          ]}
          onRewind={() => {}}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
