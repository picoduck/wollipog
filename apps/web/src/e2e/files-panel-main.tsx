import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type ControlPlaneToUi, type SessionFileEntry, type SessionView, type SourceLocation } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { FilesBrowser } from "../components/FilesPanel.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Files panel's dense rows (docs/design-system.md §5.2) over a fixed listing, at whatever
 * viewport and pointer the spec sets. `?theme=light` switches the theme; `?panel=browser` shows the
 * Browser panel instead, for its segmented control (§10.2).
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

const session: SessionView = {
  id: "files-panel-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Browse the Worktree", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
};

const entries: SessionFileEntry[] = [
  { name: "apps", path: "apps", isDir: true },
  { name: "docs", path: "docs", isDir: true },
  { name: "packages", path: "packages", isDir: true },
  { name: "AGENTS.md", path: "AGENTS.md", isDir: false, size: 4_812 },
  { name: "README.md", path: "README.md", isDir: false, size: 12_406 },
  { name: "package.json", path: "package.json", isDir: false, size: 2_210 },
  { name: "pnpm-lock.yaml", path: "pnpm-lock.yaml", isDir: false, size: 612_004 },
];

const client: ApiClient = {
  ...api,
  listSessionFiles: async (_sessionId, path) => ({ path, entries: path === "" ? entries : [] }),
  // A Markdown file opens with the panel's Markdown View control.
  readSessionFile: async (_sessionId, path) => ({
    path,
    content: "# Wollipog\n\nRun coding agents on your machines and review what they did.\n\n- Sessions\n- Projects\n",
    size: 96,
  }),
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
};

/** The store only has to connect: the panel reads its runner from it, and none is needed here. */
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
  instanceId: "files-panel-e2e",
  runtimeKey: "files-panel-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

/** Opening a file hands its location back to the host, as the right panel does. */
function FilesHost() {
  const [location, setLocation] = useState<SourceLocation | undefined>(undefined);
  return (
    <FilesBrowser
      session={session}
      runnerOnline
      runnerProtocolVersion={PROTOCOL_VERSION}
      location={location}
      onOpenLocation={setLocation}
      onClearLocation={() => setLocation(undefined)}
    />
  );
}

function Fixture() {
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
        <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
          <section className="rpanel" style={{ width: "100%", maxWidth: 480, margin: "0 auto" }}>
            {params.get("panel") === "browser" ? <BrowserPanel session={session} /> : <FilesHost />}
          </section>
        </main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
