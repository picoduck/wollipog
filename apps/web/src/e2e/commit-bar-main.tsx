/**
 * Commit bar harness (#2847): the real side panel in Review mode over fixture Git reads, with the
 * runner's commit and pull request replies chosen by the URL.
 *
 * `scenario` picks the working folder:
 * - `staged` (default): three uncommitted files, one of them staged;
 * - `unstaged`: the same files with nothing staged;
 * - `clean`: nothing to commit, two commits ahead (Review opens on Branch);
 * - `pr`: staged work on a branch whose pull request is open;
 * - `gitlab`: staged work on a GitLab remote;
 * - `offline`: the staged review, with the machine offline;
 * - `older`: a runner that predates rich diffs, so no diff loads.
 * `outcome` picks what the runner answers: `ok` (default), `rejected` (the push is rejected),
 * `auth` (Git can't sign in) or `fallback` (only a prefilled link). `theme=light` switches the
 * palette; `width` sets the docked panel's width (default 400).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type GitActionRequest,
  type GitDiffFile,
  type GitDiffInfo,
  type GitDiffScope,
  type GitStatusInfo,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
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
    __COMMIT_BAR_E2E__: {
      /** Every Git action the panel sent. */
      sent(): GitActionRequest[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "staged";
const outcome = params.get("outcome") ?? "ok";
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
const panelWidth = Number(params.get("width") ?? 400);

const NOW = Date.now();

function hunk(start: number, removed: string[], added: string[]): GitDiffFile["hunks"][number] {
  const context = ["  return result;"];
  return {
    header: `@@ -${start},${removed.length + 1} +${start},${added.length + 1} @@`,
    oldStart: start,
    oldCount: removed.length + 1,
    newStart: start,
    newCount: added.length + 1,
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
const spec: GitDiffFile = {
  path: "apps/shop/src/checkout/CheckoutPage.test.tsx",
  status: "added",
  binary: false,
  hunks: [hunk(1, [], ["import { render } from \"@testing-library/react\";", "", "test(\"totals use quantity\", () => {"])],
};

function diffOf(scope: GitDiffScope, files: GitDiffFile[], staged: GitDiffFile[] = []): GitDiffInfo {
  const added = (list: GitDiffFile[]) => list.reduce((sum, file) => sum + file.hunks.reduce((lines, h) =>
    lines + h.lines.filter((line) => line.status === "+").length, 0), 0);
  const removed = (list: GitDiffFile[]) => list.reduce((sum, file) => sum + file.hunks.reduce((lines, h) =>
    lines + h.lines.filter((line) => line.status === "-").length, 0), 0);
  const stats = (list: GitDiffFile[]) => ({ filesChanged: list.length, insertions: added(list), deletions: removed(list) });
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

const clean = scenario === "clean";
const staged = !clean && scenario !== "unstaged";
const gitlab = scenario === "gitlab";
const status: GitStatusInfo = {
  branch: "agent/speed-up-checkout-totals",
  files: clean ? [] : [
    { status: "M", path: checkout.path },
    { status: "M", path: cart.path },
    { status: "??", path: spec.path },
  ],
  hasChanges: !clean,
  ahead: 2,
  remoteUrl: gitlab ? "https://gitlab.com/acme/shop.git" : "https://github.com/acme/shop.git",
  baseRef: "origin/main",
  stagedCount: staged ? 1 : 0,
  addedLines: 7,
  deletedLines: 2,
};

const diffs: Record<GitDiffScope, GitDiffInfo> = {
  uncommitted: clean ? diffOf("uncommitted", []) : diffOf("uncommitted", [checkout, cart, spec], staged ? [cart] : []),
  all_branch: diffOf("all_branch", [checkout, cart, spec]),
  last_turn: diffOf("last_turn", [checkout]),
};

const session: SessionView = {
  id: "commit-bar", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Shop",
  projectId: null, agentId: "claude-native", agentName: "Claude", driver: "claude-code",
  title: "Speed Up Checkout Totals", status: "idle", column: "review", runId: null,
  useWorktree: true, worktreePath: "/work/shop/.worktrees/commit-bar",
  archived: false, createdAt: NOW - 3_600_000, updatedAt: NOW, lastEventAt: NOW, messageCount: 4, eventEpoch: 1,
  preview: null, pendingApproval: null, model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;

const runner = {
  runnerId: "runner-1", hostname: "studio.local", displayName: "Studio Mac", status: "online",
  protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
} as unknown as RunnerView;

const REJECTED = `Command failed: git push -u origin agent/speed-up-checkout-totals
To github.com:acme/shop.git
 ! [rejected]        agent/speed-up-checkout-totals -> agent/speed-up-checkout-totals (fetch first)
error: failed to push some refs to 'github.com:acme/shop.git'
hint: Updates were rejected because the remote contains work that you do not have
hint: locally. Integrate the remote changes (e.g. 'git pull ...') before pushing again.`;
const AUTH = `Command failed: git push -u origin agent/speed-up-checkout-totals
remote: Invalid username or password.
fatal: Authentication failed for 'https://github.com/acme/shop.git/'`;

const sent: GitActionRequest[] = [];
const client = {
  ...api,
  gitDiff: async (_id: string, scope: GitDiffScope) => ({ diff: diffs[scope] }),
  reviewFindings: async () => ({
    findings: [],
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" as const },
  }),
  git: async (_id: string, request: GitActionRequest) => {
    sent.push(request);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (request.action === "commit") {
      return { commit: { sha: "9d2a7da", message: request.message, filesChanged: request.all ? 3 : 1, stagedOnly: !request.all && staged } };
    }
    if (request.action !== "open_pr") return {};
    if (outcome === "rejected") throw new ApiError(REJECTED, 500);
    if (outcome === "auth") throw new ApiError(AUTH, 500);
    const provider = gitlab ? "gitlab" as const : "github" as const;
    const kind = gitlab ? "merge_request" as const : "pull_request" as const;
    if (outcome === "fallback") {
      return { pr: {
        url: gitlab
          ? "https://gitlab.com/acme/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=agent%2Fspeed-up-checkout-totals"
          : "https://github.com/acme/shop/compare/main...agent/speed-up-checkout-totals?expand=1",
        branch: status.branch, pushed: true, createdWithGh: false, created: false, provider, kind,
        notice: "Only the branch was pushed. Authenticate the GitHub CLI to create the pull request here.",
      } };
    }
    return { pr: {
      url: gitlab ? "https://gitlab.com/acme/shop/-/merge_requests/19" : "https://github.com/acme/shop/pull/412",
      branch: status.branch, pushed: true, createdWithGh: !gitlab, created: true, provider, kind,
    } };
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
  instanceId: "commit-bar-e2e",
  runtimeKey: "commit-bar-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};
const navigation: ViewNavigation = {
  current: () => ({ name: "session", id: session.id }),
  push() {},
  listen: () => () => {},
};

function Fixture() {
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
    expanded: false,
    setExpanded: () => {},
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  const git: GitStatus = {
    status,
    observation: 1, observedAt: NOW - 120_000, settled: true, busy: false, error: null, errorCode: null,
    refresh: async () => {},
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
            runnerOnline={scenario !== "offline"}
            runnerProtocolVersion={scenario === "older" ? 11 : PROTOCOL_VERSION}
            onOpenSourceLocation={() => {}}
            onClearSourceLocation={() => {}}
            git={git}
            forge={gitlab
              ? { provider: "gitlab", host: "gitlab.com", project: "acme/shop", authenticated: true }
              : { provider: "github", host: "github.com", project: "acme/shop", authenticated: true }}
            forgeFacts={scenario === "pr" ? {
              pr: {
                number: 412, title: "Speed up checkout totals", url: "https://github.com/acme/shop/pull/412",
                state: "OPEN", provider: "github", kind: "pull_request",
              },
              checks: { failing: 0, pending: 0, passing: 9, failingNames: [], url: "https://github.com/acme/shop/pull/412/checks" },
            } : null}
            onOpenTerminal={() => {}}
            onInsertSideChatDraft={() => {}}
            items={[]}
          />
        </div>
      </section>
      {/* On a phone the app's tab bar fills the band below the panel sheet (--bottom-bar-h). */}
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

window.__COMMIT_BAR_E2E__ = { sent: () => [...sent] };

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <FeedbackProvider>
        <Fixture />
      </FeedbackProvider>
    </StoreProvider>
  </ApiProvider>,
);
