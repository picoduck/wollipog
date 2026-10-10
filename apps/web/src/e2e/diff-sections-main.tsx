/**
 * Diff file sections harness (#2848): the real side panel in Review mode over the file-section
 * fixture (`diff-sections-fixture.ts`).
 *
 * - `width` sets the docked panel's width (default 400); Expand Panel works as in the app.
 * - `expanded=1` opens the panel expanded.
 * - `theme=light` switches the palette.
 * - `stale=1` makes every stage, unstage and discard fail with `GIT_STALE`, as a race would.
 * - `findings=1` holds findings in memory, seeded with an open and a resolved one (#2851).
 * - `rewrite=1` makes a Stage Hunk reply rewrite the checkout file's new line 21, as the agent
 *   editing a line under an open draft would (#2851's Line Changed notice).
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PROTOCOL_VERSION,
  type CreateWorkspaceReferenceRequest,
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
import { DIFF_SECTIONS_STATUS_FILES, diffSectionsDiff } from "./diff-sections-fixture.js";
import { checkoutFindings, inMemoryReviewFindings } from "./review-findings-fixture.js";
import "../styles.css";

declare global {
  interface Window {
    __DIFF_SECTIONS_E2E__: {
      /** Every Git request the panel sent, as `diff:<scope>`, `stage:<path>#<hunk>` or `discard:<path>`. */
      calls(): string[];
      /** Files the panel attached to the prompt, and files it opened in Files. */
      attached(): CreateWorkspaceReferenceRequest[];
      opened(): string[];
    };
  }
}

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
const panelWidth = Number(params.get("width") ?? 400);
const stale = params.get("stale") === "1";
const NOW = Date.now();

const status: GitStatusInfo = {
  branch: "agent/speed-up-checkout-totals",
  files: DIFF_SECTIONS_STATUS_FILES,
  hasChanges: true,
  ahead: 1,
  remoteUrl: "https://github.com/acme/shop.git",
  baseRef: "origin/main",
  stagedCount: 1,
  addedLines: 14,
  deletedLines: 5,
};

const session: SessionView = {
  id: "diff-sections", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Shop",
  projectId: null, agentId: "claude-native", agentName: "Claude", driver: "claude-code",
  title: "Speed Up Checkout Totals", status: "idle", column: "review", runId: null,
  useWorktree: true, worktreePath: "/work/shop/.worktrees/diff-sections",
  archived: false, createdAt: NOW - 3_600_000, updatedAt: NOW, lastEventAt: NOW, messageCount: 4, eventEpoch: 1,
  preview: null, pendingApproval: null, model: null, effort: null, permissionMode: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;

const runner = {
  runnerId: "runner-1", hostname: "studio.local", displayName: "Studio Mac", status: "online",
  protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [],
} as unknown as RunnerView;

const calls: string[] = [];
const attached: CreateWorkspaceReferenceRequest[] = [];
const opened: string[] = [];
const race = () => new ApiError("the diff is out of date — the index or worktree changed since it was loaded", 409, "GIT_STALE");
const rewrite = params.get("rewrite") === "1";
let rewritten = false;
/** The fixture diff, with line 21 rewritten once a `rewrite=1` stage has run. */
function currentDiff() {
  const diff = diffSectionsDiff();
  if (!rewritten) return diff;
  const file = diff.files[0]!;
  const hunk = file.hunks[0]!;
  const lines = hunk.lines.map((line) => line.text === "    [items, discounts]," ? { ...line, text: "    [items, discountIds]," } : line);
  return { ...diff, diffHash: "e".repeat(64), files: [{ ...file, hunks: [{ ...hunk, lines }, ...file.hunks.slice(1)] }, ...diff.files.slice(1)] };
}
const client = {
  ...api,
  gitDiff: async (_id: string, scope: GitDiffScope) => {
    calls.push(`diff:${scope}`);
    return { diff: { ...currentDiff(), scope } };
  },
  gitStageHunk: async (_id: string, body: { filePath: string; hunkIndex: number }) => {
    calls.push(`stage:${body.filePath}#${body.hunkIndex}`);
    if (stale) throw race();
    if (rewrite) rewritten = true;
    return { status, diff: currentDiff() };
  },
  gitStageLines: async (_id: string, body: { filePath: string; hunkIndex: number }) => {
    calls.push(`lines:${body.filePath}#${body.hunkIndex}`);
    if (stale) throw race();
    return { status, diff: diffSectionsDiff() };
  },
  gitDiscardFile: async (_id: string, body: { filePath: string }) => {
    calls.push(`discard:${body.filePath}`);
    if (stale) throw race();
    return { status, diff: diffSectionsDiff() };
  },
  reviewFindings: async () => ({
    findings: [],
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" as const },
  }),
  ...(params.get("findings") === "1" ? inMemoryReviewFindings(checkoutFindings(session.id, diffSectionsDiff().diffHash)) : {}),
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
  instanceId: "diff-sections-e2e",
  runtimeKey: "diff-sections-e2e:1",
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
  const [expanded, setExpanded] = useState(params.get("expanded") === "1");
  const state: RightPanelState = {
    open, mode, width, dragging: false, subagentTarget: null,
    toggle: () => setOpen((value) => !value),
    openMode: (next) => { setMode(next); setOpen((value) => !(value && mode === next)); },
    show: (next) => { setMode(next); setOpen(true); },
    setMode,
    setWidth: (update) => setWidth(update),
    expanded,
    setExpanded,
    setDragging: () => {},
    close: () => setOpen(false),
    selectSubagent: () => {},
    showSubagent: () => {},
    consumeSubagentFocusRequest: () => {},
  };
  const git: GitStatus = {
    status, observation: 1, observedAt: NOW - 60_000, settled: true, busy: false, error: null, errorCode: null,
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
          <div className="detail-body">
            <div className="detail-main">
              <div className="detail-scroll" role="region" aria-label="Session Activity">
                {Array.from({ length: 6 }, (_, index) => (
                  <div className={`tl-row ${index % 2 ? "agent" : "user"}`} key={index}>
                    <div className="tl-bubble">Transcript message {index + 1}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <RightPanel
            state={state}
            session={session}
            runnerOnline
            runnerProtocolVersion={PROTOCOL_VERSION}
            onOpenSourceLocation={(location) => { opened.push(location.path); }}
            onClearSourceLocation={() => {}}
            onAttachWorkspaceReference={async (target) => { attached.push(target); }}
            git={git}
            forgeFacts={null}
            onOpenTerminal={() => {}}
            onInsertSideChatDraft={() => {}}
            items={[]}
          />
        </div>
      </section>
    </main>
  );
}

window.__DIFF_SECTIONS_E2E__ = {
  calls: () => [...calls],
  attached: () => [...attached],
  opened: () => [...opened],
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
