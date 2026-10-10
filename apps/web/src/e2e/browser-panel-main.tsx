import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, SessionView, WorkflowArtifactKind, WorkflowArtifactPage, WorkflowArtifactView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { SESSION_TOOL_ICONS } from "../components/RightPanel.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Browser tool (#2854) in a side panel column: 400px on a desktop and the whole width on a
 * phone, under a stand-in for the panel's 48px header. `?theme=light` switches the theme;
 * `?artifacts=list|loading|empty|error` chooses what the artifact list answers (a list by default).
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const session: SessionView = {
  id: "browser-panel-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Preview the Dashboard", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const now = Date.now();
const minute = 60_000;
function artifact(id: string, kind: WorkflowArtifactKind, name: string, sizeBytes: number, ageMs: number, mimeType = "text/plain"): WorkflowArtifactView {
  return {
    artifactId: id, sessionId: session.id, kind, name, mimeType, encoding: "utf8", sizeBytes,
    sha256: "0".repeat(64), createdBy: { kind: "system" }, createdAt: now - ageMs,
  };
}

const artifacts: WorkflowArtifactView[] = [
  artifact("a1", "review_report", "Review of the Browser panel rebuild", 6_212, 4 * minute, "text/markdown"),
  artifact("a2", "html_preview", "Dashboard preview", 1_741, 12 * minute, "text/html"),
  artifact("a3", "test_log", "web unit suite.log", 284_311, 38 * minute),
  artifact("a4", "verdict", "verdict.json", 912, 2 * 60 * minute, "application/json"),
  artifact("a5", "screenshot", "Settings at 390px, dark theme.png", 211_004, 3 * 60 * minute, "image/png"),
  artifact("a6", "video", "Checkout flow.webm", 3_811_220, 26 * 60 * minute, "video/webm"),
  artifact("a7", "patch", "fix-address-row.patch", 4_420, 3 * 24 * 60 * minute),
];

const scenario = params.get("artifacts") ?? "list";
const listArtifacts = async (_sessionId: string, cursor?: string): Promise<WorkflowArtifactPage> => {
  if (scenario === "loading") return new Promise(() => undefined);
  if (scenario === "empty") return { artifacts: [] };
  if (scenario === "error") throw new Error("GET /api/sessions/browser-panel-e2e/artifacts failed: 503 Service Unavailable");
  return cursor ? { artifacts: artifacts.slice(5) } : { artifacts: artifacts.slice(0, 5), nextCursor: "page-2" };
};

const client: ApiClient = { ...api, sessionWorkflowArtifacts: listArtifacts };

/** The store only has to connect: nothing here reads a runner. */
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      const snapshot: ControlPlaneToUi = {
        type: "snapshot",
        capabilities: {
          sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false,
          projects: true, createProjectLocations: true,
        },
        runners: [], boxes: [], projects: [], sessions: [], runs: [], pods: [],
      };
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "browser-panel-e2e",
  runtimeKey: "browser-panel-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

const BrowserIcon = SESSION_TOOL_ICONS.browser;

function Fixture() {
  const phone = window.innerWidth <= 760;
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="app" style={{ height: "100vh", display: "flex", justifyContent: "flex-end", background: "var(--bg)" }}>
            <aside id="right-panel" className="rpanel" aria-label="Side Panel" style={{ width: phone ? "100%" : 400, height: "100vh" }}>
              <div className="rpanel-head">
                <span className="rpanel-switcher">
                  <span className="rpanel-switcher-icon" aria-hidden="true"><BrowserIcon /></span>
                  <span className="rpanel-switcher-name">Browser</span>
                </span>
              </div>
              <div className="rpanel-body">
                <BrowserPanel session={session} />
              </div>
            </aside>
          </main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
