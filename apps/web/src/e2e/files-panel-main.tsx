import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type GitStatusInfo,
  type SessionFileEntry,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { FilesBrowser } from "../components/FilesPanel.js";
import { PanelActionSlotContext, SESSION_TOOL_ICONS } from "../components/RightPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Files tool (#2852) in a side panel column: 400px on a desktop and the whole width on a phone,
 * under a stand-in for the panel's 48px header whose action slot is real, over a fixed listing with
 * changed files. Go to File searches a fixed set of paths. `?theme=light` switches the theme;
 * `?listing=loading` holds every listing; `?offline=1` takes the machine offline once the first
 * listing has landed; `?truncated=1` makes every search report more matches than it returned.
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

const tree: Record<string, SessionFileEntry[]> = {
  "": [
    { name: "apps", path: "apps", isDir: true },
    { name: "docs", path: "docs", isDir: true },
    { name: "packages", path: "packages", isDir: true },
    { name: "AGENTS.md", path: "AGENTS.md", isDir: false, size: 4_812 },
    { name: "README.md", path: "README.md", isDir: false, size: 12_406 },
    { name: "package.json", path: "package.json", isDir: false, size: 2_210 },
    { name: "pnpm-lock.yaml", path: "pnpm-lock.yaml", isDir: false, size: 612_004 },
  ],
  docs: [
    { name: "archive", path: "docs/archive", isDir: true },
    { name: "design-system.md", path: "docs/design-system.md", isDir: false, size: 188_221 },
    { name: "logo.png", path: "docs/logo.png", isDir: false, size: 24_015 },
  ],
  "docs/archive": [],
};

/** What Go to File can find: breadth-first, as the runner walks the tree. */
const searchable = [
  "apps", "docs", "packages", "AGENTS.md", "README.md", "package.json", "pnpm-lock.yaml",
  "apps/web", "apps/runner", "docs/design-system.md", "docs/logo.png", "packages/protocol",
  "apps/web/src", "apps/runner/src/session-checks.ts", "apps/runner/src/checkout.ts",
  "apps/web/src/checklist.tsx", "apps/web/src/components", "apps/web/src/components/CheckBadge.tsx",
  "packages/protocol/src/health-check.ts",
];
const directories = new Set(["apps", "docs", "packages", "apps/web", "apps/runner", "packages/protocol", "apps/web/src", "apps/web/src/components"]);

const changed: GitStatusInfo["files"] = [
  { status: "M", path: "README.md" },
  { status: "??", path: "AGENTS.md" },
  { status: "A", path: "docs/logo.png" },
  { status: "M", path: "apps/web/src/components/CheckBadge.tsx" },
];

const git: GitStatus = {
  status: { branch: "agent/files", files: changed, hasChanges: true, ahead: 0, remoteUrl: null } as GitStatusInfo,
  observation: 1, observedAt: 1, settled: true, busy: false, error: null, errorCode: null,
  refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
};

const client: ApiClient = {
  ...api,
  listSessionFiles: async (_sessionId, path) => {
    if (params.get("listing") === "loading") return new Promise(() => undefined);
    return { path, entries: tree[path] ?? [] };
  },
  // A Markdown file opens with the panel's Markdown View control.
  readSessionFile: async (_sessionId, path) => ({
    path,
    content: "# Wollipog\n\nRun coding agents on your machines and review what they did.\n\n- Sessions\n- Projects\n",
    size: 96,
  }),
  searchWorkspaceReferences: async (_sessionId, query) => {
    const needle = query.toLocaleLowerCase();
    return {
      results: searchable
        .filter((path) => path.toLocaleLowerCase().includes(needle))
        .map((path) => ({ path, isDirectory: directories.has(path) })),
      truncated: params.get("truncated") === "1",
    };
  },
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

const FilesIcon = SESSION_TOOL_ICONS.files;

/** Opening a file hands its location back to the host, as the right panel does. */
function FilesHost() {
  const [location, setLocation] = useState<SourceLocation | undefined>(undefined);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (params.get("offline") !== "1") return;
    const timer = window.setTimeout(() => setOnline(false), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <FilesBrowser
      session={session}
      runnerOnline={online}
      runnerProtocolVersion={PROTOCOL_VERSION}
      location={location}
      git={git}
      onOpenLocation={setLocation}
      onClearLocation={() => setLocation(undefined)}
    />
  );
}

function Fixture() {
  const phone = window.innerWidth <= 760;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="app" style={{ height: "100vh", display: "flex", justifyContent: "flex-end", background: "var(--bg)" }}>
            <aside id="right-panel" className="rpanel" aria-label="Side Panel" style={{ width: phone ? "100%" : 400, height: "100vh" }}>
              <div className="rpanel-head">
                <h2 className="rpanel-title">
                  <span className="rpanel-switcher">
                    <span className="rpanel-switcher-icon" aria-hidden="true"><FilesIcon /></span>
                    <span className="rpanel-switcher-name">Files</span>
                  </span>
                </h2>
                <div className="rpanel-actions" ref={setSlot} />
              </div>
              <PanelActionSlotContext.Provider value={slot}>
                <div className="rpanel-body">
                  <FilesHost />
                </div>
              </PanelActionSlotContext.Provider>
            </aside>
          </main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
