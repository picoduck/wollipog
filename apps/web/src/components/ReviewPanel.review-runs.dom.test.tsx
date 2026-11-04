import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type GitDiffScope,
  type ReviewSessionView,
  type SessionView,
  type SourceLocation,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { ReviewPanel } from "./ReviewPanel.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * Review's Cross-Model Reviews (#3369): the reviews a session requested, read when its own view says
 * it has any and again when that summary changes; each named for its reviewer with its round and one
 * state badge, Stale once a newer review covers another head, a valid report's findings opening their
 * files, and Open Transcript going to the review session.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});
beforeEach(() => clearPanelScratch());

const HEAD = "c".repeat(40);
const OLD_HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const baseSession: SessionView = {
  id: "session-reviews",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  driver: "claude-code",
  title: "Review Runs Fixture",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  useWorktree: true,
  worktreePath: "/tmp/review-runs-fixture",
} as SessionView;

function run(over: Partial<ReviewSessionView> & Pick<ReviewSessionView, "reviewSessionId">): ReviewSessionView {
  return {
    requesterSessionId: baseSession.id,
    pullRequest: { repository: "acme/shop", number: 42 },
    headSha: HEAD,
    reviewer: "codex",
    state: "completed",
    terminal: true,
    round: { epoch: 1, round: 2, attempt: 1, mode: "delta", baseSha: BASE, scopeFiles: ["src/cart.ts"], since: OLD_HEAD },
    validated: true,
    verdict: { valid: true, consumed: true, effectiveVote: "DOWNVOTE", failureClass: null, validationErrors: [] },
    findings: [{
      severity: "high", blocking: true, file: "src/cart.ts", line: 12, title: "Guard the empty cart",
      scenario: "An empty cart is charged.", evidence: "No length check.", verify: "Check out with no items.",
    }],
    stale: false,
    output: "{}",
    outputTruncated: false,
    reason: null,
    cancelRequested: false,
    createdAt: Date.now() - 5 * 60_000,
    updatedAt: Date.now(),
    ...over,
  };
}

const latest = run({ reviewSessionId: "s_review_2" });
const earlier = run({
  reviewSessionId: "s_review_1", headSha: OLD_HEAD, stale: true, findings: [],
  round: { epoch: 1, round: 1, attempt: 1, mode: "full", baseSha: BASE, scopeFiles: ["src/cart.ts"] },
  verdict: { valid: false, consumed: true, effectiveVote: "INVALID", failureClass: "evidence_contract",
    validationErrors: ["changed file src/cart.ts is not classified exactly once"] },
});

async function mount(session: SessionView, runs: ReviewSessionView[]) {
  const host = domWindow.document.createElement("div");
  const head = domWindow.document.createElement("div");
  const body = domWindow.document.createElement("div");
  host.append(head, body);
  domWindow.document.body.appendChild(host);
  const root = createRoot(body as unknown as Element);
  const reads: string[] = [];
  const opened: SourceLocation[] = [];
  const openedSessions: string[] = [];
  let shown = runs;
  let failing = false;
  /** The cursor of the newest page, and the pages after it by cursor. */
  let next: string | null = null;
  let older: Record<string, { reviews: ReviewSessionView[]; next: string | null }> = {};
  /** While set, newest-page reads wait on it. */
  let newestGate: Promise<void> | null = null;
  const client = {
    ...api,
    gitDiff: async (_id: string, scope: GitDiffScope) => ({
      diff: {
        scope, files: [], diffHash: "d".repeat(64), fineDiffHash: "e".repeat(64),
        stats: { filesChanged: 0, insertions: 0, deletions: 0 }, stagedFiles: [], unstagedFiles: [],
        stagedDiffHash: "f".repeat(64), unstagedDiffHash: "0".repeat(64),
        stagedStats: { filesChanged: 0, insertions: 0, deletions: 0 }, unstagedStats: { filesChanged: 0, insertions: 0, deletions: 0 },
      },
    }),
    reviewFindings: async () => ({
      findings: [],
      summary: { total: 0, unresolved: 0, requiredUnresolved: 0, sent: 0, resolved: 0, dismissed: 0, completion: "complete" as const },
    }),
    reviewSessions: async (sessionId: string, page: { afterReviewSessionId?: string } = {}) => {
      reads.push(page.afterReviewSessionId ? `${sessionId} after ${page.afterReviewSessionId}` : sessionId);
      if (!page.afterReviewSessionId && newestGate) await newestGate;
      if (failing) throw new Error("The control plane could not be reached.");
      if (page.afterReviewSessionId) {
        const found = older[page.afterReviewSessionId]!;
        return { reviews: found.reviews, nextAfterReviewSessionId: found.next };
      }
      return { reviews: shown, nextAfterReviewSessionId: next };
    },
  } as unknown as ApiClient;
  const git: GitStatus = {
    status: { branch: "agent/review-runs", files: [], hasChanges: false, ahead: 1, remoteUrl: null, baseRef: "origin/main", stagedCount: 0 },
    observation: 1, observedAt: Date.now(), settled: true, busy: false, error: null, errorCode: null,
    refresh: async () => {}, refreshStatusOnly: async () => {}, install: () => {}, mutationRevision: 0,
  };
  const tree = (current: SessionView) => (
    <ApiProvider client={client}>
      <PanelActionSlotContext.Provider value={head as unknown as HTMLElement}>
        <ReviewPanel
          session={current}
          runnerOnline
          runnerProtocolVersion={PROTOCOL_VERSION}
          git={git}
          onOpenSourceLocation={(location) => { opened.push(location); }}
          onOpenSession={(id) => { openedSessions.push(id); }}
        />
      </PanelActionSlotContext.Provider>
    </ApiProvider>
  );
  await act(async () => { root.render(tree(session)); });
  return {
    container: host as unknown as HTMLElement,
    reads,
    opened,
    openedSessions,
    rerender: async (nextSession: SessionView, nextRuns = shown) => {
      shown = nextRuns;
      await act(async () => { root.render(tree(nextSession)); });
    },
    fail: (value: boolean) => { failing = value; },
    pages: (newestNext: string | null, pages: typeof older) => { next = newestNext; older = pages; },
    /** Hold newest-page reads until the returned function releases them. */
    holdNewest: () => {
      let release!: () => void;
      newestGate = new Promise<void>((resolve) => { release = resolve; });
      return async () => {
        newestGate = null;
        await act(async () => { release(); });
      };
    },
    refresh: async () => {
      const button = (head as unknown as HTMLElement).querySelector<HTMLButtonElement>('button[aria-label="Refresh Review"]');
      assert.ok(button, "the header Refresh is rendered");
      await act(async () => { fireDomEvent.click(button); });
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

function reviews(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('section[aria-label="Cross-Model Reviews"]');
}

test("a session that requested no review neither reads reviews nor shows the section", async () => {
  const h = await mount(baseSession, [latest]);
  try {
    assert.deepEqual(h.reads, []);
    assertNoDomNode(reviews(h.container), "the Cross-Model Reviews section");
  } finally { await h.unmount(); }
});

test("each review shows its reviewer, round, state and staleness, and a valid report's findings", async () => {
  const session = { ...baseSession, reviewRuns: { count: 2, active: 0, updatedAt: 10 } };
  const h = await mount(session, [latest, earlier]);
  try {
    assert.deepEqual(h.reads, [session.id]);
    const section = reviews(h.container);
    assert.ok(section, "the section is rendered");
    const head = section.querySelector(".review-findings-head")!;
    assert.match(head.textContent ?? "", /Cross-Model Reviews\s*2/u);
    assert.match(head.textContent ?? "", /Fixing/u, "a delivered downvote leaves the run with its requester, fixing");
    const runRows = [...section.querySelectorAll<HTMLElement>("article[aria-label]")];
    assert.deepEqual(runRows.map((row) => row.getAttribute("aria-label")), [
      "Codex Review, Round 2 · Epoch 1 · Changes Since Last Round",
      "Codex Review, Round 1 · Epoch 1 · Full Review",
    ]);
    assert.match(runRows[0]!.textContent ?? "", /Codex Review\s*Downvote/u);
    assert.doesNotMatch(runRows[0]!.textContent ?? "", /Stale/u);
    assert.match(runRows[1]!.textContent ?? "", /Invalid\s*Stale/u);
    assert.match(runRows[1]!.textContent ?? "", /not classified exactly once/u, "an invalid review says why");
    assert.match(runRows[1]!.textContent ?? "", new RegExp(`Head ${OLD_HEAD.slice(0, 7)}`, "u"));

    const finding = section.querySelector<HTMLElement>(".review-run-finding");
    assert.ok(finding, "the valid report's finding follows its review");
    assert.match(finding.textContent ?? "", /High\s*Blocking\s*cart\.ts:12/u);
    assert.match(finding.textContent ?? "", /Guard the empty cart/u);
    assert.equal(section.querySelectorAll(".review-run-finding").length, 1, "an invalid report has no findings");
    await act(async () => { fireDomEvent.click(finding.querySelector<HTMLButtonElement>("button.review-finding-location")!); });
    assert.deepEqual(h.opened, [{ path: "src/cart.ts", line: 12 }]);

    const transcript = [...runRows[0]!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Open Transcript"));
    assert.ok(transcript, "Open Transcript is offered");
    await act(async () => { fireDomEvent.click(transcript); });
    assert.deepEqual(h.openedSessions, ["s_review_2"]);
  } finally { await h.unmount(); }
});

test("a change to the session's review summary reads its reviews again; an unchanged one does not", async () => {
  const running = run({ reviewSessionId: "s_review_3", state: "running", terminal: false, verdict: null, validated: false, findings: [], output: null, round: null });
  const session = { ...baseSession, reviewRuns: { count: 1, active: 1, updatedAt: 10 } };
  const h = await mount(session, [running]);
  try {
    assert.match(reviews(h.container)!.textContent ?? "", /Reviewing/u);
    await h.rerender({ ...session, updatedAt: 2 });
    assert.equal(h.reads.length, 1, "an unrelated session change reads nothing");
    await h.rerender({ ...session, reviewRuns: { count: 1, active: 0, updatedAt: 20 } }, [{ ...latest, reviewSessionId: "s_review_3" }]);
    assert.equal(h.reads.length, 2);
    assert.match(reviews(h.container)!.querySelector(".review-findings-head")!.textContent ?? "", /Fixing/u);
  } finally { await h.unmount(); }
});

test("a read that fails says so and keeps what was shown, and Refresh reads the reviews again", async () => {
  const running = run({ reviewSessionId: "s_review_3", state: "running", terminal: false, verdict: null, validated: false, findings: [], output: null, round: null });
  const session = { ...baseSession, reviewRuns: { count: 1, active: 1, updatedAt: 10 } };
  const h = await mount(session, [running]);
  try {
    // The read that the review's completion triggers fails: Reviewing stays, with the reason beside it.
    h.fail(true);
    await h.rerender({ ...session, reviewRuns: { count: 1, active: 0, updatedAt: 20 } }, [{ ...latest, reviewSessionId: "s_review_3" }]);
    const section = reviews(h.container)!;
    assert.match(section.querySelector(".review-findings-head")!.textContent ?? "", /Reviewing/u);
    assert.match(section.textContent ?? "", /Cross-model reviews: The control plane could not be reached\./u);
    // No summary change follows, so the header's Refresh is what reads them again.
    h.fail(false);
    await h.refresh();
    assert.equal(h.reads.length, 3);
    assert.match(reviews(h.container)!.querySelector(".review-findings-head")!.textContent ?? "", /Fixing/u);
    assert.doesNotMatch(reviews(h.container)!.textContent ?? "", /could not be reached/u);
  } finally { await h.unmount(); }
});

test("a first read that fails still shows the section with the reason", async () => {
  const session = { ...baseSession, reviewRuns: { count: 2, active: 0, updatedAt: 10 } };
  const h = await mount({ ...baseSession }, [latest]);
  try {
    h.fail(true);
    await h.rerender(session);
    const section = reviews(h.container);
    assert.ok(section, "the section shows though nothing could be read");
    assert.match(section.textContent ?? "", /Cross-Model Reviews\s*2/u);
    assert.match(section.textContent ?? "", /could not be reached/u);
  } finally { await h.unmount(); }
});

test("Load Older Reviews waits for a newest-page read in flight, so no review is skipped", async () => {
  const numbered = (n: number) => run({ reviewSessionId: `s_r${n}`, findings: [] });
  const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => numbered(from - i));
  // 26 reviews: the newest page shows 26 to 2, and the cursor continues after 2.
  const session = { ...baseSession, reviewRuns: { count: 26, active: 0, updatedAt: 10 } };
  const h = await mount({ ...baseSession }, range(26, 2));
  try {
    h.pages("s_r2", { s_r2: { reviews: [numbered(1)], next: null } });
    await h.rerender(session);
    const ids = () => [...reviews(h.container)!.querySelectorAll("article[aria-label]")].length;
    const loadOlder = () => [...reviews(h.container)!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Load Older Reviews"));
    assert.equal(ids(), 25);
    // Review 27 arrives; its newest-page read is held while Load Older Reviews is clicked.
    const release = h.holdNewest();
    h.pages("s_r3", { s_r3: { reviews: [numbered(2), numbered(1)], next: null } });
    await h.rerender({ ...session, reviewRuns: { count: 27, active: 0, updatedAt: 20 } }, range(27, 3));
    await act(async () => { fireDomEvent.click(loadOlder()!); });
    assert.ok(!h.reads.some((read) => read.endsWith("after s_r2")), "the old cursor is not followed while the list is being replaced");
    await release();
    assert.equal(ids(), 25, "the replaced newest page: 27 to 3");
    await act(async () => { fireDomEvent.click(loadOlder()!); });
    assert.ok(h.reads.at(-1)?.endsWith("after s_r3"), "the new list's own cursor is followed");
    assert.equal(ids(), 27, "every review is reachable, with no gap");
    assert.equal(loadOlder(), undefined);
  } finally { await h.unmount(); }
});

test("older reviews beyond the first page load on request, and the count is the session's total", async () => {
  const session = { ...baseSession, reviewRuns: { count: 3, active: 0, updatedAt: 10 } };
  const h = await mount({ ...baseSession }, [latest]);
  try {
    h.pages("s_review_2", { s_review_2: { reviews: [earlier, latest], next: null } });
    await h.rerender(session);
    const section = reviews(h.container)!;
    assert.match(section.querySelector(".review-findings-head")!.textContent ?? "", /Cross-Model Reviews\s*3/u);
    assert.equal(section.querySelectorAll("article[aria-label]").length, 1);
    const loadOlder = [...section.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Load Older Reviews"));
    assert.ok(loadOlder, "Load Older Reviews is offered while a cursor remains");
    await act(async () => { fireDomEvent.click(loadOlder); });
    assert.deepEqual(h.reads, [session.id, `${session.id} after s_review_2`]);
    // The older page's review is added once; one already shown is not repeated.
    assert.equal(reviews(h.container)!.querySelectorAll("article[aria-label]").length, 2);
    assert.ok(![...reviews(h.container)!.querySelectorAll("button")].some((button) => button.textContent?.includes("Load Older Reviews")),
      "no more pages, so no Load Older Reviews");
  } finally { await h.unmount(); }
});


test("a continuation delivery refreshes a completed review from Delivering Findings to Fixing", async () => {
  const pending = { ...latest, continuation: "pending" as const };
  const session = { ...baseSession, reviewRuns: { count: 1, active: 0, updatedAt: 20 } };
  const h = await mount(session, [pending]);
  try {
    const phase = () => reviews(h.container)!.querySelector(".review-findings-head .status")!.textContent;
    assert.equal(phase(), "Delivering Findings");
    await h.rerender({ ...session, reviewRuns: { ...session.reviewRuns, updatedAt: 21 } },
      [{ ...pending, continuation: "delivered" }]);
    assert.equal(h.reads.length, 2, "the continuation-only summary change fetches the settled review again");
    assert.equal(phase(), "Fixing");
  } finally { await h.unmount(); }
});
