import { createRoot } from "react-dom/client";
import { useState } from "react";
import { EventTimeline } from "../components/EventTimeline.js";
import { CheckpointRewindSession } from "./checkpoint-rewind-session.js";
import "../styles.css";

// `?unavailable` shows every per-turn action that applies but cannot be used now, each with its
// reason, as a runner that went offline after the turn would. `?surface=session` renders a whole
// session instead, whose turn actions open their real composer flow and confirmations (#2185);
// `?theme=light|dark` picks the theme.
const params = new URLSearchParams(window.location.search);
const unavailable = params.has("unavailable");
if (params.has("theme")) {
  document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
}

function Fixture() {
  const [requested, setRequested] = useState<string | null>(null);
  return (
    <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 32 }}>
      <section style={{ width: "100%", maxWidth: 760, margin: "0 auto" }}>
        <EventTimeline
          items={[
            { kind: "user_message", id: 1, text: "Inspect the checkpoint controls." },
            { kind: "checkpoint", id: 2, turn: 4 },
            { kind: "agent_message", id: 3, text: "The checkpoint is **ready**." },
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
          onRewind={(turn) => setRequested(`Rewind requested for turn ${turn}.`)}
          rewindUnavailableReason={unavailable ? "Reconnect the runner before restoring files." : undefined}
          onFork={(turn) => setRequested(`Fork requested after turn ${turn}.`)}
          forkAvailabilityByTurn={new Map([[4, unavailable
            ? { available: false, offered: true, reason: "Reconnect the runner before creating a fork." }
            : { available: true, forkTurn: 4 }]])}
          handoff={{
            open: (turn) => setRequested(`Hand off requested after turn ${turn}.`),
            reason: unavailable ? "Reconnect the runner before creating a handoff." : undefined,
          }}
          onEditAndResend={() => setRequested("Edit requested.")}
          editAndResendUnavailableReason={unavailable ? "Runner is offline." : undefined}
        />
        {requested != null && <p role="status">{requested}</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(params.get("surface") === "session" ? <CheckpointRewindSession /> : <Fixture />);
