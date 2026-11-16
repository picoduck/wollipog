import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  pullRequestMergeReadiness,
  type GitPrSummary,
  type PullRequestMergeFacts,
  type PullRequestMergeReadinessResponse,
  type PullRequestMergeRequest,
  type PullRequestMergeResponse,
  type PullRequestMergeSessionFacts,
  type SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { ConfirmationOptions } from "./FeedbackProvider.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { PullRequestMergeAction } from "./PullRequestMergeAction.js";

const domWindow = new Window({ url: "http://localhost/", width: 1200, height: 800 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node,
  Event: domWindow.Event, MouseEvent: domWindow.MouseEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const HEAD = "b".repeat(40);
const URL = "https://github.com/acme/shop/pull/42";
const session = { id: "s1", title: "Checkout" } as SessionView;
const pr: GitPrSummary = { number: 42, title: "Speed up checkout", url: URL, state: "OPEN", provider: "github", kind: "pull_request" };
const FACTS: PullRequestMergeFacts = {
  url: URL, repository: "acme/shop", number: 42, state: "open", headSha: HEAD, isDraft: false, baseRef: "main",
  mergeQueueEnabled: true, inMergeQueue: false, mergeStateStatus: "CLEAN",
  requiredChecks: { state: "passed", failing: [], pending: [] }, viewerPermission: "admin",
  mergeMethod: "squash", deleteBranchOnMerge: false, observedAt: 1,
};
const assertNoButton = (host: HTMLElement) => assert.ok(host.querySelector("button") === null, "no merge button");
const ALLOWED: PullRequestMergeSessionFacts = { roleRefusal: null, runnerSupported: true, requiredFindingsOpen: 0 };
const respond = (facts: PullRequestMergeFacts | null, session = ALLOWED, unavailable?: string): PullRequestMergeReadinessResponse =>
  ({ facts, ...(unavailable ? { unavailable } : {}), readiness: pullRequestMergeReadiness(facts, session, unavailable) });

async function mount(options: {
  readiness: PullRequestMergeReadinessResponse[];
  confirm?: boolean;
  merge?: PullRequestMergeResponse["result"];
  pr?: GitPrSummary;
}) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const reads: number[] = [];
  const merges: PullRequestMergeRequest[] = [];
  const confirmations: ConfirmationOptions[] = [];
  let merged = 0;
  const client = {
    ...api,
    pullRequestMergeReadiness: async () => {
      reads.push(1);
      return options.readiness[Math.min(reads.length - 1, options.readiness.length - 1)]!;
    },
    mergePullRequest: async (_id: string, body: PullRequestMergeRequest) => {
      merges.push(body);
      return { result: options.merge ?? { outcome: "enqueued", message: "Added to the merge queue at position 2.", mode: "enqueue", headSha: HEAD, state: "open", queuePosition: 2 } };
    },
  } as unknown as ApiClient;
  const feedback = {
    confirm: async (request: ConfirmationOptions) => { confirmations.push(request); return options.confirm ?? true; },
    notify: () => {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <PullRequestMergeAction session={session} pr={options.pr ?? pr} onMerged={() => { merged += 1; }} />
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  const button = () => host.querySelector("button") as unknown as HTMLButtonElement;
  return {
    host: host as unknown as HTMLElement, button, reads, merges, confirmations, merged: () => merged,
    click: async () => { await act(async () => { button().click(); }); },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("an open gate enqueues exactly the confirmed head after a confirmation naming it, then re-reads", async () => {
  const view = await mount({ readiness: [respond(FACTS)] });
  try {
    assert.equal(view.button().textContent, "Enqueue for Merge");
    assert.equal(view.button().disabled, false);
    assert.equal(view.host.querySelector('[role="group"]')?.getAttribute("aria-label"), "Enqueue for Merge");
    await view.click();
    assert.equal(view.confirmations.length, 1);
    const confirmation = view.confirmations[0]!;
    assert.equal(confirmation.title, "Enqueue for Merge");
    assert.equal(confirmation.confirmLabel, "Enqueue for Merge");
    assert.match(confirmation.message, /^GitHub adds pull request #42 to the main merge queue at this head.*The branch is not deleted\.$/u);
    assert.deepEqual(confirmation.detailRows?.map((row) => row.label), ["#42 Speed up checkout", HEAD]);
    assert.deepEqual(view.merges, [{ pullRequestUrl: URL, headSha: HEAD, mode: "enqueue" }]);
    assert.equal(view.host.querySelector('[role="status"]')?.textContent, "Added to the merge queue at position 2.");
    assert.equal(view.merged(), 1);
    assert.equal(view.reads.length, 2, "readiness is read again after the action");
  } finally {
    await view.unmount();
  }
});

test("without a queue the action is Merge Pull Request, and the repository's own branch deletion is disclosed", async () => {
  const view = await mount({
    readiness: [respond({ ...FACTS, mergeQueueEnabled: false, mergeMethod: "rebase", deleteBranchOnMerge: true })],
    merge: { outcome: "merged", message: "Merged with the repository's rebase method.", mode: "merge", headSha: HEAD, state: "merged" },
  });
  try {
    assert.equal(view.button().textContent, "Merge Pull Request");
    await view.click();
    assert.match(view.confirmations[0]!.message, /merges pull request #42 into main at this head with the repository's rebase method\./u);
    assert.match(view.confirmations[0]!.message, /This repository's own setting deletes the head branch after it merges\.$/u);
    assert.deepEqual(view.merges, [{ pullRequestUrl: URL, headSha: HEAD, mode: "merge" }]);
  } finally {
    await view.unmount();
  }
});

test("a disabled action explains every failing condition and sends nothing", async () => {
  const view = await mount({ readiness: [respond(
    { ...FACTS, requiredChecks: { state: "pending", failing: [], pending: ["Typecheck"] }, viewerPermission: "read" },
    { roleRefusal: "Merging requires an Admin or Owner role.", runnerSupported: true, requiredFindingsOpen: 1 },
  )] });
  try {
    assert.equal(view.button().disabled, true);
    const describedBy = view.button().getAttribute("aria-describedby");
    assert.ok(describedBy);
    const reasons = [...view.host.querySelectorAll(`[id="${describedBy}"] p`)].map((node) => node.textContent);
    assert.deepEqual(reasons, [
      "Merging requires an Admin or Owner role.",
      "Resolve the open Required finding first.",
      "This machine's GitHub account can't merge into acme/shop.",
      "Required checks haven't passed on the current head yet: Typecheck.",
    ]);
    await view.click();
    assert.deepEqual(view.confirmations, []);
    assert.deepEqual(view.merges, []);
  } finally {
    await view.unmount();
  }
});

test("a GitLab merge request, an unreadable gate, a declined confirmation, or a refusal never reports success", async () => {
  const gitlab = await mount({ readiness: [respond(FACTS)],
    pr: { ...pr, kind: "merge_request", provider: "gitlab", url: "https://gitlab.com/acme/shop/-/merge_requests/42" } });
  try {
    assertNoButton(gitlab.host);
    assert.equal(gitlab.host.textContent, "Merging from Wollipog supports GitHub pull requests only; merge this merge request on GitLab.");
    assert.equal(gitlab.reads.length, 0, "the runner is not asked about a merge request");
  } finally {
    await gitlab.unmount();
  }
  const unread = await mount({ readiness: [respond(null, ALLOWED, "This branch has no pull request GitHub could find.")] });
  try {
    assert.equal(unread.button().disabled, true);
    assert.match(unread.host.textContent ?? "", /This branch has no pull request GitHub could find\./u);
  } finally {
    await unread.unmount();
  }
  const declined = await mount({ readiness: [respond(FACTS)], confirm: false });
  try {
    await declined.click();
    assert.deepEqual(declined.merges, []);
    assert.equal(declined.merged(), 0);
  } finally {
    await declined.unmount();
  }
  const refused = await mount({ readiness: [respond(FACTS)],
    merge: { outcome: "refused", message: "The pull request's head changed since you confirmed; review the new head first.", mode: "enqueue", headSha: HEAD, state: "open" } });
  try {
    await refused.click();
    assert.equal(refused.host.querySelector('[role="status"]')?.textContent, "The pull request's head changed since you confirmed; review the new head first.");
    assert.equal(refused.merged(), 0);
  } finally {
    await refused.unmount();
  }
});

test("facts for another pull request never enable the action", async () => {
  const view = await mount({ readiness: [respond({ ...FACTS, url: "https://github.com/acme/shop/pull/41" })] });
  try {
    assert.equal(view.button().disabled, true);
    assert.match(view.host.textContent ?? "", /The pull request changed; reloading its merge state\./u);
  } finally {
    await view.unmount();
  }
});
