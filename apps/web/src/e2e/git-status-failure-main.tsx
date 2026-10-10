import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { createBrowserApiTransport } from "../api-transport.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { PanelActionSlotContext } from "../components/RightPanel.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import { useGitStatus } from "../components/useGitStatus.js";
import "../styles.css";

// Synthetic session only. Playwright controls HTTP replies; API parsing, the shared status reader,
// and the Review panel are production code, including the foreground refresh and retry path.
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const session: SessionView = {
  id: "git-status-failure-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Example",
  projectId: null, agentId: "codex", agentName: "Codex", title: "Review Git Changes", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/example",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "codex-app-server", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};
const client = createApiClient(createBrowserApiTransport({
  instanceId: "git-status-failure-e2e", origin: window.location.origin,
}));

function Panel() {
  const git = useGitStatus(session, true, true);
  return <ReviewPanel session={session} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION}
    git={git} onOpenSourceLocation={() => {}} />;
}

/** The side panel's frame around Review: its header holds Review's Refresh (#2846). */
function Frame() {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <section className="rpanel" style={{ width: "100%", maxWidth: 820, height: "calc(100vh - 32px)", margin: "0 auto" }}>
      <div className="rpanel-head">
        <h2 className="rpanel-title">Review</h2>
        <div className="rpanel-actions" ref={setSlot} />
      </div>
      <PanelActionSlotContext.Provider value={slot}>
        <div className="rpanel-body"><Panel /></div>
      </PanelActionSlotContext.Provider>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <FeedbackProvider>
      <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 16 }}>
        <Frame />
      </main>
    </FeedbackProvider>
  </ApiProvider>,
);
