import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { createBrowserApiTransport } from "../api-transport.js";
import { SessionApprovalBanner } from "../components/SessionApproval.js";
import "../styles.css";

const params = new URLSearchParams(window.location.hash.slice(1));
const origin = params.get("origin") ?? "";
const token = params.get("token") ?? "";
const sessionId = params.get("sessionId") ?? "";

function LiveQuestionFixture() {
  const client = useMemo(() => createApiClient(createBrowserApiTransport({
    instanceId: "agent-question-live-e2e",
    origin,
    token: () => token,
  })), []);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void client.session(sessionId).then(({ session: loaded }) => {
      if (active) setSession(loaded);
    }).catch((cause) => {
      if (active) setError((cause as Error).message);
    });
    return () => { active = false; };
  }, [client]);

  return (
    <ApiProvider client={client}>
      <main id="question-frame">
        {error ? (
          <p role="alert">{error}</p>
        ) : !session ? (
          <p role="status">Loading Agent Questions…</p>
        ) : session.pendingApproval?.kind === "question" ? (
          <SessionApprovalBanner
            session={session}
            runnerOnline
            onSessionUpdate={setSession}
            showKeyHints={false}
          />
        ) : (
          <p role="status">Question Answered</p>
        )}
      </main>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<LiveQuestionFixture />);
