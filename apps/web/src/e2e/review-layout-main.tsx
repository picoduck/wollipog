/**
 * Review layout harness (#2846): the real side panel in Review mode over fixture Git reads.
 *
 * `scenario` picks what the session's working folder holds:
 * - `uncommitted` (default): three uncommitted files, one of them staged, two commits ahead;
 * - `branch`: only committed branch work, so Review opens on Branch;
 * - `pr`: uncommitted work on a branch whose open pull request has failing checks;
 * - `noworktree`: a session with no working folder;
 * - `offline`: the uncommitted review, then the machine goes offline (`setOnline(false)`);
 * - `older`: a runner that predates hunk staging.
 * `theme=light` switches the palette. `width` sets the docked panel's width (default 400).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type GitDiffFile,
  type GitDiffInfo,
  type GitDiffScope,
  type GitStatusInfo,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { RightPanel, type RightPanelState } from "../components/RightPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import type { RightPanelMode } from "../right-panel.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

declare global {
  interface Window {
    __REVIEW_LAYOUT_E2E__: {
      /** Every Git read the panel sent, as `status`, `diff:<scope>` or `findings`. */
      reads(): string[];
      /** Takes the machine offline or brings it back. */
      setOnline(online: boolean): void;
      /** Prompts the panel sent to the agent. */
      prompts(): string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "uncommitted";
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
const panelWidth = Number(params.get("width") ?? 400);

const NOW = Date.now();

function hunk(start: number, removed: string[], added: string[], context = ["  return result;"]): GitDiffFile["hunks"][number] {
  return {
    header: `@@ -${start},${removed.length + context.length} +${start},${added.length + context.length} @@`,
    oldStart: start,
    oldCount: removed.length + context.length,
    newStart: start,
    newCount: added.length + context.length,
    lines: [
      ...removed.map((text) => ({ status: "-" as const, text })),
      ...added.map((text) => ({ status: "+" as const, text })),
      ...context.map((text) => ({ status: " " as const, text })),
    ],
  };
}

const checkout: GitDiffFile = {
  path: "apps/shop/src/checkout/CheckoutPage.tsx",
  status: "modified",
  binary: false,
  hunks: [hunk(18, ["  const total = items.reduce((sum, item) => sum + item.price, 0);"], [
    "  const total = useMemo(",
    "    () => items.reduce((sum, item) => sum + item.price * item.quantity, 0),",
    "    [items],",
    "  );",
  ])],
};
const cart: GitDiffFile = {
  path: "apps/shop/src/cart/cart-store.ts",
  status: "modified",
  binary: false,
  hunks: [hunk(42, ["export function clearCart() {"], ["export function clearCart(reason: ClearReason) {", "  log.info(\"cart cleared\", { reason });"])],
};
const test: GitDiffFile = {
  path: "apps/shop/src/checkout/CheckoutPage.test.tsx",
  status: "added",
  binary: false,
  hunks: [hunk(1, [], ["import { render } from \"@testing-library/react\";", "", "test(\"totals use quantity\", () => {"], [])],
};

function diffOf(scope: GitDiffScope, files: GitDiffFile[], staged: GitDiffFile[] = []): GitDiffInfo {
  const count = (list: GitDiffFile[]) => list.reduce((sum, file) => sum + file.hunks.reduce((lines, h) =>
    lines + h.lines.filter((line) => line.status === "+").length, 0), 0);
  const removed = (list: GitDiffFile[]) => list.reduce((sum, file) => sum + file.hunks.reduce((lines, h) =>
    lines + h.lines.filter((line) => line.status === "-").length, 0), 0);
  const stats = (list: GitDiffFile[]) => ({ filesChanged: list.length, insertions: count(list), deletions: removed(list) });
  const unstaged = files.filter((file) => !staged.includes(file));
  return {
    scope, files,
    diffHash: `${scope}`.padEnd(64, "0").slice(0, 64), fineDiffHash: "f".repeat(64),
    stats: stats(files),
    stagedFiles: staged, unstagedFiles: unstaged,
    stagedDiffHash: "1".repeat(64), unstagedDiffHash: "2".repeat(64),
    stagedStats: stats(staged), unstagedStats: stats(unstaged),
  };
}

const branchOnly = scenario === "branch";
const status: GitStatusInfo = {
  branch: "agent/speed-up-checkout-totals-and-clear-cart-reasons",
  files: branchOnly ? [] : [
    { status: "M", path: checkout.path },
    { status: "M", path: cart.path },
    { status: "??", path: test.path },
  ],
  hasChanges: !branchOnly,
  ahead: branchOnly ? 1 : 2,
  remoteUrl: "https://github.com/acme/shop.git",
  baseRef: "origin/main",
  stagedCount: branchOnly ? 0 : 1,
  addedLines: 7,
  deletedLines: 2,
};

const diffs: Record<GitDiffScope, GitDiffInfo> = {
  uncommitted: branchOnly ? diffOf("uncommitted", []) : diffOf("uncommitted", [checkout, cart, test], [cart]),
  all_branch: diffOf("all_branch", [checkout, cart, test]),
  last_turn: diffOf("last_turn", [checkout]),
};

const session: SessionView = {
  id: "review-layout", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Shop",
  projectId: null, agentId: "claude-native", agentName: "Claude", driver: "claude-code",
  title: "Speed Up Checkout Totals", status: "idle", column: "review", runId: null,
  useWorktree: scenario !== "noworktree",
  worktreePath: scenario === "noworktree" ? null : "/work/shop/.worktrees/review-layout",
  archived: false, createdAt: NOW - 3_600_000, updatedAt: NOW, lastEventAt: NOW, messageCount: 4, eventEpoch: 1,
  preview: null, pendingApproval: null, model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;

const runner = {
  runnerId: "runner-1", hostname: "studio.local", displayName: "Studio Mac", status: "online",
  protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
} as unknown as RunnerView;

const reads: string[] = [];
const prompts: string[] = [];
const client = {
  ...api,
  gitDiff: async (_id: string, scope: GitDiffScope) => {
    reads.push(`diff:${scope}`);
    return { diff: diffs[scope] };
  },
  reviewFindings: async () => {
    reads.push("findings");
    return {
      findings: [],
      summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" as const },
    };
  },
  prompt: async (_id: string, text: string) => {
    prompts.push(text);
    return {};
  },
} as unknown as ApiClient;

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
        runners: [runner], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
      }) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "review-layout-e2e",
  runtimeKey: "review-layout-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

let setOnlineFromTest: ((online: boolean) => void) | null = null;

function Fixture() {
  const [online, setOnline] = useState(true);
  setOnlineFromTest = setOnline;
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<RightPanelMode>("review");
  const [width, setWidth] = useState(panelWidth);
  const state: RightPanelState = {
    open, mode, width, dragging: false, subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => { setMode(next); setOpen((value) => !(value && mode === next)); },
    show: (next) => { setMode(next); setOpen(true); },
    setMode,
    setWidth: (update) => setWidth(update),
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  const git: GitStatus = {
    status: scenario === "noworktree" ? null : status,
    observation: 1, observedAt: NOW - 120_000, settled: true, busy: false, error: null, errorCode: null,
    refresh: async () => { reads.push("status"); },
    refreshStatusOnly: async () => {},
    install: () => {},
    mutationRevision: 0,
  };
  return (
    <main className="app" style={{ display: "block", height: "100dvh" }}>
      <section className="session-detail expanded" style={{ height: "100%" }}>
        <header className="detail-bar session-bar">
          <h1 className="detail-bar-title session-bar-title">{session.title}</h1>
        </header>
        <div className="detail-columns">
          <div className="detail-chat">
            <div className="detail-main">
              <div className="detail-reader">
                <div className="detail-scroll" role="region" aria-label="Session Activity">
                  {Array.from({ length: 8 }, (_, index) => (
                    <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                      <div className="tl-bubble">Transcript message {index + 1}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <RightPanel
            state={state}
            session={session}
            runnerOnline={online}
            runnerProtocolVersion={scenario === "older" ? 12 : PROTOCOL_VERSION}
            onOpenSourceLocation={() => {}}
            onClearSourceLocation={() => {}}
            git={git}
            forgeFacts={scenario === "pr" ? {
              pr: {
                number: 412, title: "Speed up checkout totals and log cart clears", url: "https://github.com/acme/shop/pull/412",
                state: "OPEN", provider: "github", kind: "pull_request",
              },
              checks: { failing: 2, pending: 0, passing: 9, failingNames: ["unit-tests", "typecheck"], url: "https://github.com/acme/shop/pull/412/checks" },
            } : null}
            onOpenTerminal={() => {}}
            onInsertSideChatDraft={() => {}}
            items={[]}
          />
        </div>
      </section>
      {/* On a phone the app's tab bar fills the band below the panel sheet (--bottom-bar-h); this
          stand-in shows that band for what it is in the captures. */}
      {window.innerWidth <= 760 && (
        <nav aria-label="App Navigation" style={{
          position: "fixed", left: 0, right: 0, bottom: 0, height: "var(--bottom-bar-h)",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderTop: "1px solid var(--border)", background: "var(--bg-elev)", color: "var(--text-dim)",
          font: "var(--type-small)",
        }}>
          App Tab Bar
        </nav>
      )}
    </main>
  );
}

window.__REVIEW_LAYOUT_E2E__ = {
  reads: () => [...reads],
  setOnline: (online) => setOnlineFromTest?.(online),
  prompts: () => [...prompts],
};

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <FeedbackProvider>
        <Fixture />
      </FeedbackProvider>
    </StoreProvider>
  </ApiProvider>,
);
