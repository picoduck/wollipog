import React from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type ControlPlaneToUi,
  type RunnerView,
  type SessionView,
  type ShellView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ShellDock } from "../components/ShellDock.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The bottom terminal dock (#2864) under a stand-in session column, on a fixed shell registry: Shell 1
 * with output that holds "test" five times, Shell 2, and an exited Shell 3. Query parameters:
 * `?theme=light`; `?tui=` `available` (the default), `open` (an Agent TUI tab is open), `guardrail`
 * (a cost budget blocks it), `unsupported` (the agent has no TUI) or `offline` (the machine is
 * offline); `?shells=0` starts with no shell and `?shells=many` with twelve; `?listDelay=` holds the
 * registry reads that many milliseconds after load. New Shell takes a moment, so its busy state can be seen.
 * For #2865: `?pipe=1` makes every shell a Windows-native pipe shell; `?reconnecting=1` has Shell 1
 * reconnecting; `?long=1` gives Shell 1 two hundred lines to scroll; `?expired=1` says retention removed
 * Shell 1's oldest output; `?status=completed` ends the session, so an empty dock opens no shell itself.
 */
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.setAttribute("data-theme", theme);
const tui = params.get("tui") ?? "available";
const pipe = params.get("pipe") === "1";

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Box",
  os: pipe ? "windows" : "linux",
  version: "1",
  status: tui === "offline" ? "offline" : "online",
  agents: [{
    id: "claude",
    name: "Claude Code",
    command: "claude",
    args: [],
    env: {},
    driver: tui === "unsupported" ? "acp" : "claude-code",
    context: { kind: "native" },
    available: true,
  }],
  workspaces: [{ id: "workspace-1", name: "Acme Storefront", path: "/home/dev/acme-storefront" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
};

const session: SessionView = {
  id: "shell-dock-e2e", runnerId: runner.runnerId, workspaceId: "workspace-1", workspaceName: "Acme Storefront",
  projectId: null, agentId: "claude", agentName: "Claude Code", title: "Fix the Checkout Total",
  status: params.get("status") === "completed" ? "completed" : "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/home/dev/worktrees/acme-storefront",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: tui === "unsupported" ? "acp" : "claude-code", model: null,
  effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  ...(tui === "guardrail" ? { costBudgetUsd: 5 } : {}),
};

const shell = (index: number, overrides: Partial<ShellView> = {}): ShellView => ({
  shellId: `shell-${index}`, sessionId: session.id, name: `Shell ${index}`, createdAt: index, pty: !pipe,
  kind: "shell", status: "running", outputStartSeq: 0, outputEndSeq: 1, outputTruncated: false, ...overrides,
});

const shells: ShellView[] = params.get("shells") === "0" ? [] : params.get("shells") === "many"
  ? Array.from({ length: 12 }, (_, index) => shell(index + 1))
  : [
  shell(1, params.get("reconnecting") === "1" ? { status: "reconnecting" } : {}),
  shell(2),
  shell(3, { status: "exited", exitCode: 0 }),
  ...(tui === "open" ? [shell(4, { shellId: "agent-tui", name: "Agent TUI", kind: "agent_tui" })] : []),
];

const output: Record<string, string> = {
  "shell-1": [
    ...(params.get("long") === "1" ? Array.from({ length: 200 }, (_, index) => `build step ${index + 1} of 200 done`) : []),
    "dev@build-box:~/worktrees/acme-storefront$ pnpm test",
    "> acme-storefront@1.4.0 test",
    "",
    " ✓ src/cart/total.test.ts (12 checks) 41ms",
    " ✓ src/checkout/tax.test.ts (8 checks) 18ms",
    " ✓ src/checkout/discount.test.ts (5 checks) 9ms",
    "",
    " 3 files passed, 25 checks",
    "dev@build-box:~/worktrees/acme-storefront$ ",
  ].join("\r\n"),
  "shell-2": "dev@build-box:~/worktrees/acme-storefront$ pnpm dev\r\n  VITE ready in 412 ms\r\n  ➜  Local: http://localhost:5173/\r\n",
  "shell-3": "dev@build-box:~/worktrees/acme-storefront$ git status --short\r\n M src/checkout/total.ts\r\ndev@build-box:~/worktrees/acme-storefront$ exit\r\n",
};

let opened = shells.length;
let openRequests = 0;
/** Every registry read before this moment waits for it (the dock reads once on mount and again online). */
const listReadyAt = Date.now() + Number(params.get("listDelay") ?? 0);
const client: ApiClient = {
  ...api,
  listShells: async () => {
    const wait = listReadyAt - Date.now();
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    return { shells: structuredClone(shells) };
  },
  shellHistory: async (_sessionId, shellId) => ({
    shellId,
    chunks: output[shellId] ? [{ seq: 1, stream: "stdout" as const, data: output[shellId]! }] : [],
    nextAfter: 1,
    hasMore: false,
    truncatedBefore: shellId === "shell-1" && params.get("expired") === "1",
  }),
  openShell: async (_sessionId, request) => {
    openRequests += 1;
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    opened += 1;
    const created = shell(opened, request?.kind === "agent_tui"
      ? { shellId: `agent-tui-${opened}`, name: "Agent TUI", kind: "agent_tui", outputEndSeq: 0 }
      : { outputEndSeq: 0 });
    shells.push(created);
    return { shell: structuredClone(created) };
  },
  closeShell: async (_sessionId, shellId) => {
    const index = shells.findIndex((candidate) => candidate.shellId === shellId);
    if (index >= 0) shells.splice(index, 1);
  },
  resizeShell: async () => undefined,
  shellInput: async () => undefined,
};

/** The store only has to hold the machine and the session the dock reads. */
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
        runners: [runner], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
      };
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "shell-dock-e2e",
  runtimeKey: "shell-dock-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

let hideCount = 0;
declare global {
  interface Window {
    __WOLLIPOG_SHELL_DOCK_E2E__: { hideCount(): number; openRequests(): number };
  }
}
window.__WOLLIPOG_SHELL_DOCK_E2E__ = { hideCount: () => hideCount, openRequests: () => openRequests };

function Fixture() {
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          <main className="main" style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
            <div className="main-body" tabIndex={-1} style={{ flex: 1, padding: 24, color: "var(--text-dim)" }}>
              Session Transcript
            </div>
            <ShellDock
              sessionId={session.id}
              onClose={() => { hideCount += 1; }}
              theme={theme}
              scheme="wollipog"
            />
          </main>
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
