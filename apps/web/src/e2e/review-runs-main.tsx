import React from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION, type GitStatusInfo, type ReviewSessionView, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ReviewPanel } from "../components/ReviewPanel.js";
import type { GitStatus } from "../components/useGitStatus.js";
import "../styles.css";

/**
 * Review's Cross-Model Reviews (#3369): a Claude Code session's three reviews of its pull request —
 * an invalid first attempt on an older head, a Downvote with two findings, and one still reviewing
 * the newest head. `?theme=light` switches the theme; `?state=settled` ends the newest one.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
const settled = params.get("state") === "settled";

const HEAD = "4f1c2e9a7b3d5c6e8f0a1b2c3d4e5f60718293a4";
const MIDDLE = "9b8a7c6d5e4f30211a2b3c4d5e6f708192a3b4c5";
const FIRST = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const BASE = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

const session: SessionView = {
  id: "review-runs-e2e", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Wollipog",
  projectId: null, agentId: "claude", agentName: "Claude", title: "Guard Empty Carts at Checkout", status: "idle",
  column: "review", runId: null, useWorktree: true, worktreePath: "/workspace/wollipog-checkout",
  archived: false, createdAt: 1, updatedAt: 1, lastEventAt: 1, messageCount: 1, eventEpoch: 0,
  preview: null, pendingApproval: null, driver: "claude-code", model: null, effort: null,
  permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
  reviewRuns: { count: 3, active: settled ? 0 : 1, updatedAt: 1 },
};

const common = {
  requesterSessionId: session.id, pullRequest: { repository: "acme/shop", number: 42 }, reviewer: "codex" as const,
  outputTruncated: false, cancelRequested: false,
};

const runs: ReviewSessionView[] = [
  {
    ...common, reviewSessionId: "s_review_3", headSha: HEAD,
    state: settled ? "completed" : "running", terminal: settled,
    round: { epoch: 1, round: 2, attempt: 1, mode: "delta", baseSha: BASE, scopeFiles: ["src/checkout/cart.ts"], since: MIDDLE },
    validated: settled,
    verdict: settled ? { valid: true, consumed: true, effectiveVote: "UPVOTE", failureClass: null, validationErrors: [] } : null,
    findings: [], stale: false, output: settled ? "{}" : null, reason: null,
    createdAt: minutesAgo(3), updatedAt: minutesAgo(1),
  },
  {
    ...common, reviewSessionId: "s_review_2", headSha: MIDDLE, state: "completed", terminal: true,
    round: { epoch: 1, round: 1, attempt: 2, mode: "full", baseSha: BASE, scopeFiles: ["src/checkout/cart.ts", "src/checkout/charge.ts"] },
    validated: true,
    verdict: { valid: true, consumed: true, effectiveVote: "DOWNVOTE", failureClass: null, validationErrors: [] },
    findings: [
      {
        severity: "high", blocking: true, file: "src/checkout/charge.ts", line: 48, title: "Charge runs before the empty-cart guard",
        scenario: "A cart emptied in another tab is still charged its stale total.",
        evidence: "chargeCart() is awaited before assertCartNotEmpty() in submitOrder().",
        verify: "Empty the cart in a second tab, then submit the first.",
      },
      {
        severity: "low", blocking: false, file: "src/checkout/cart.ts", line: null, title: "Name the guard's error code",
        scenario: "Support cannot tell an empty-cart refusal from a payment failure.",
        evidence: "Both throw CheckoutError without a code.",
        verify: "Read the thrown error's code in the checkout test.",
      },
    ],
    stale: true, output: "{}", reason: null, createdAt: minutesAgo(48), updatedAt: minutesAgo(41),
  },
  {
    ...common, reviewSessionId: "s_review_1", headSha: FIRST, state: "completed", terminal: true,
    round: { epoch: 1, round: 1, attempt: 1, mode: "full", baseSha: BASE, scopeFiles: ["src/checkout/cart.ts", "src/checkout/charge.ts"] },
    validated: true,
    verdict: {
      valid: false, consumed: true, effectiveVote: "INVALID", failureClass: "evidence_contract",
      validationErrors: ["changed file src/checkout/charge.ts is not classified exactly once"],
    },
    findings: [], stale: true, output: "{}", reason: null, createdAt: minutesAgo(75), updatedAt: minutesAgo(70),
  },
];

const status: GitStatusInfo = {
  branch: "agent/guard-empty-carts", files: [], hasChanges: false, ahead: 3,
  remoteUrl: "git@github.com:acme/shop.git", baseRef: "origin/main",
};

const git: GitStatus = {
  status: { ...status }, observation: 1, observedAt: Date.now(), settled: true, busy: false,
  error: null, errorCode: null, refresh: async () => {}, refreshStatusOnly: async () => {},
  install: () => {}, mutationRevision: 0,
};

const client: ApiClient = {
  ...api,
  reviewFindings: async () => ({
    findings: [],
    summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" },
  }),
  reviewSessions: async () => ({ reviews: runs, nextAfterReviewSessionId: null }),
  gitDiff: async () => ({
    diff: {
      scope: "uncommitted", baseRef: "origin/main", headRef: "HEAD", raw: "", files: [],
      diffHash: "e".repeat(64), fineDiffHash: "f".repeat(64), stats: { filesChanged: 0, insertions: 0, deletions: 0 },
    },
  }),
};

function Fixture() {
  const [opened, setOpened] = React.useState<string | null>(null);
  return (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <main className="app" style={{ minHeight: "100vh", background: "var(--bg)", padding: 24 }}>
          <section className="rpanel" style={{ width: "100%", maxWidth: 820, margin: "0 auto" }}>
            <ReviewPanel
              session={session}
              runnerOnline
              runnerProtocolVersion={PROTOCOL_VERSION}
              git={git}
              onOpenSourceLocation={() => {}}
              onOpenSession={setOpened}
            />
            {opened && <p role="status" data-testid="opened-session">Opened {opened}</p>}
          </section>
        </main>
      </FeedbackProvider>
    </ApiProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
