import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { pendingRequests, type DescendantRequestView, type SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { viewPath } from "../navigation.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { loadEvidenceReviewDraft, saveEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { clearQuestionDrafts, storedQuestionDrafts } from "../question-response.js";
import { useEvidenceDraftRetirement } from "./SessionApproval.js";
import { dockRequests } from "./requests/RequestDock.js";
import { SessionRequestPanel, sessionRequestPanelKey } from "./SessionRequestPanel.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function evidenceSession(): SessionView {
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    evidenceId: `viewport-${index + 1}`,
    uri: `https://evidence.example/item-${index + 1}.png?signature=secret-${index + 1}`,
    sha256: String(index).padStart(64, "0"),
  }));
  return {
    id: "session-evidence-panel",
    runnerId: "runner",
    title: "Evidence Session",
    status: "input_required",
    eventEpoch: 4,
    pendingApproval: {
      requestId: "evidence-occurrence",
      occurrenceId: "evidence-occurrence",
      kind: "workflow_decision",
      title: "UI Evidence Approval Required",
      context: { input: JSON.stringify({ evidence }) },
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "request-evidence",
        occurrenceId: "evidence-occurrence",
        sessionId: "session-evidence-panel",
        controllingSessionId: "session-parent",
        category: "ui_evidence_approval",
        resourceKey: "pr-1107-ui",
        resourceSnapshot: { category: "ui_evidence_approval", evidence },
        resourceDigest: "a".repeat(64),
        policyRevision: 2,
        authority: "human",
        status: "pending",
        createdAt: Date.now() - 30_000,
      },
    },
  } as SessionView;
}

function standaloneApprovalSession(): SessionView {
  return {
    ...evidenceSession(),
    id: "session-worktree-trust",
    title: "Worktree Setup",
    updatedAt: Date.now(),
    pendingApproval: {
      requestId: "worktree-setup:one:hash",
      occurrenceId: "worktree-setup-occurrence",
      kind: "permission",
      title: "Trust Worktree Setup Configuration?",
      context: {
        toolName: "wollipog.worktree_setup",
        path: "/workspace/project",
        branch: "fix/example",
        input: "Copy .env.example to .env\nRun pnpm install\nEnvironment: API_BASE_URL",
      },
      options: [
        { optionId: "trust", name: "Trust This Configuration", kind: "allow_always" },
        { optionId: "skip", name: "Create Without Setup", kind: "reject_once" },
      ],
    },
  } as SessionView;
}

/** A child's request in this session's Requests panel: the panel lists descendants only (#2179). */
function asDescendant(child: SessionView): DescendantRequestView {
  const request = child.pendingApproval!;
  return {
    sessionId: child.id,
    sessionTitle: child.title,
    runnerId: child.runnerId,
    runnerOnline: true,
    eventEpoch: child.eventEpoch ?? 0,
    createdAt: Date.now() - 30_000,
    responseOwner: "human",
    occurrenceId: request.occurrenceId ?? request.requestId,
    request,
  };
}

const parentSession = (): SessionView => ({ ...evidenceSession(), id: "session-parent", title: "Parent", pendingApproval: null }) as SessionView;

function ChildPanel({ child, client }: { child: DescendantRequestView; client: ApiClient }) {
  return (
    <ApiProvider client={client}>
      <SessionRequestPanel
        session={parentSession()}
        descendants={[child]}
        selectedKey={sessionRequestPanelKey(child.sessionId, child.occurrenceId)}
        onSelectedKeyChange={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>
  );
}

const footButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")];

test("a child's eight-item evidence review persists acknowledgement drafts and submits exact ids", async () => {
  domWindow.localStorage.clear();
  const child = asDescendant(evidenceSession());
  const approvals: unknown[] = [];
  const client = {
    ...api,
    approve: async (_sessionId: string, body: unknown) => {
      approvals.push(structuredClone(body));
      return parentSession();
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  let root = createRoot(container);
  try {
    await act(async () => root.render(<ChildPanel child={child} client={client} />));
    assert.equal(container.querySelectorAll(".ev-tile").length, 8);
    assert.equal(container.querySelectorAll(".ev-grid").length, 1);
    assert.doesNotMatch(container.textContent ?? "", /signature=secret|https:\/\/evidence/);
    assert.equal(container.querySelector("details")?.hasAttribute("open"), false);
    const approve = footButtons(container).find((button) => button.textContent === "Approve")!;
    const deny = footButtons(container).find((button) => button.textContent === "Deny")!;
    assert.equal(approve.disabled, true);
    assert.equal(deny.disabled, false);
    // Approve's reason is the foot-note above the footer.
    assert.equal(domWindow.document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent,
      "Review 8 more to approve.");
    // Each link-only item can be marked only once its link was opened (#2197).
    const links = [...container.querySelectorAll<HTMLAnchorElement>(".ev-tile a.btn")];
    assert.equal(links.length, 8);
    await act(async () => { for (const link of links) link.click(); });
    const checks = [...container.querySelectorAll<HTMLInputElement>('.ev-tile input[type="checkbox"]')];
    await act(async () => {
      checks[0]!.click();
      checks[1]!.click();
      checks[2]!.click();
    });
    assert.equal(container.querySelector(".ev-progress")?.textContent, "3 of 8 reviewed");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<ChildPanel child={child} client={client} />));
    const restored = [...container.querySelectorAll<HTMLInputElement>('.ev-tile input[type="checkbox"]')];
    assert.ok(restored.every((checkbox) => !checkbox.disabled), "the opened links are restored with the marks");
    assert.deepEqual(restored.map((checkbox) => checkbox.checked), [
      true, true, true, false, false, false, false, false,
    ]);
    await act(async () => {
      for (const checkbox of restored.slice(3)) checkbox.click();
    });
    const restoredApprove = footButtons(container).find((button) => button.textContent === "Approve")!;
    assert.equal(restoredApprove.disabled, false);
    await act(async () => { restoredApprove.click(); });
    assert.deepEqual(approvals, [{
      requestId: "evidence-occurrence",
      optionId: "approve",
      evidenceReviewed: Array.from({ length: 8 }, (_, index) => `viewport-${index + 1}`),
    }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a human fallback explains why the assigned Orchestrator could not review the evidence", async () => {
  domWindow.localStorage.clear();
  const session = evidenceSession();
  session.pendingApproval!.workflowDecision!.humanFallback = {
    code: "media_video_unsupported",
    reason: "Evidence \"clip\" is video, which no Orchestrator client can review yet.",
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChildPanel child={asDescendant(session)} client={api as ApiClient} />));
    assert.match(container.querySelector(".ev-review details")?.textContent ?? "",
      /assigned to the Orchestrator, but this request needs a person\. Evidence "clip" is video/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a child's permission opens on the Request Card with its command, facts and menu choice", async () => {
  const child = asDescendant(standaloneApprovalSession());
  const approvals: unknown[] = [];
  const client = {
    ...api,
    approve: async (_sessionId: string, body: unknown) => {
      approvals.push(structuredClone(body));
      return parentSession();
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChildPanel child={child} client={client} />));
    assertNoDomNode(container.querySelector(".approval-bar"));
    assertNoDomNode(container.querySelector(".approval-review-surface"));
    const card = container.querySelector<HTMLElement>(".request-card")!;
    assert.equal(card.dataset.presentation, "panel");
    assert.match(card.querySelector(".code-well")?.textContent ?? "", /pnpm install/);
    const facts = card.querySelector(".facts")?.textContent ?? "";
    assert.match(facts, /wollipog\.worktree_setup/);
    assert.match(facts, /fix\/example/);
    // With no allow_once, the allow_always trust option is the primary, last; the reject is the
    // visible secondary before it (#2641).
    assert.deepEqual(footButtons(container).map((button) => button.textContent || button.getAttribute("aria-label")),
      ["Create Without Setup", "Trust This Configuration"]);
    assert.ok(footButtons(container)[1]!.classList.contains("primary"));
    await act(async () => { footButtons(container)[1]!.click(); });
    assert.deepEqual(approvals, [{ requestId: "worktree-setup:one:hash", optionId: "trust" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a child's cost checkpoint keeps Stop before the one primary Continue", async () => {
  const session = standaloneApprovalSession();
  session.pendingApproval = {
    requestId: "cost-checkpoint:session:1",
    occurrenceId: "cost-checkpoint-occurrence",
    kind: "cost_checkpoint",
    title: "Cost checkpoint — $2.61 of $2.50. Continue?",
    options: [
      { optionId: "continue", name: "Continue", kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ],
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ChildPanel child={asDescendant(session)} client={api as ApiClient} />));
    assert.match(container.querySelector(".request-card-title")?.textContent ?? "", /Cost checkpoint/);
    assert.equal((container.querySelector(".request-card") as HTMLElement | null)?.dataset.requestKind, "budget");
    assert.deepEqual(footButtons(container).map((button) => [button.textContent, button.className]),
      [["Stop", "btn"], ["Continue", "btn primary"]]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the session's own request is not listed in the panel: the dock above the composer answers it", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={api as ApiClient}>
        <SessionRequestPanel
          session={standaloneApprovalSession()}
          descendants={[]}
          selectedKey={null}
          onSelectedKeyChange={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.match(container.textContent ?? "", /Nothing Waiting/);
    assertNoDomNode(container.querySelector(".request-card"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

/** A child's question or, for the Orchestrator, a merge decision: the Requests panel's two groups. */
function childRequest(index: number, owner: "human" | "orchestrator"): DescendantRequestView {
  const sessionId = `child-${index}`;
  const occurrenceId = `occurrence-${index}`;
  return {
    sessionId,
    sessionTitle: `Child Session ${index}`,
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: index,
    createdAt: Date.now() - index * 60_000,
    responseOwner: owner,
    occurrenceId,
    request: owner === "human" ? {
      requestId: `question-${index}`,
      occurrenceId,
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "target", question: `Choose a target for child ${index}`, options: [{ label: "Staging" }] }],
    } : {
      requestId: `merge-${index}`,
      occurrenceId,
      kind: "workflow_decision",
      title: "PR Merge Approval Required",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: `merge-request-${index}`,
        occurrenceId,
        sessionId,
        controllingSessionId: "session-parent",
        category: "pr_merge",
        resourceKey: `pr-${40 + index}`,
        resourceSnapshot: {
          category: "pr_merge",
          repository: "picoduck/wollipog",
          pullRequest: 40 + index,
          headSha: "b".repeat(40),
          reviewResult: "merge",
          requiredChecks: { headSha: "b".repeat(40), status: "passed", checkedAt: 1, checks: [] },
        },
        resourceDigest: "c".repeat(64),
        policyRevision: 3,
        authority: "orchestrator",
        status: "pending",
        createdAt: Date.now() - index * 60_000,
      },
    },
  };
}

/** Eight requests waiting for the person, then four the Orchestrator handles, interleaved as they arrive. */
const campaignRequests = () => Array.from({ length: 12 }, (_, index) =>
  childRequest(index + 1, index % 3 === 2 ? "orchestrator" : "human"));

let setNavigatorDescendants: (next: DescendantRequestView[]) => void = () => {};

/** The panel as the session page holds it: the open request is the page's state. */
function Navigator({ descendants: initial, initialKey = null, onOpenChild = () => {}, onRetry, onOpenDecisionHistory, status }: {
  descendants: DescendantRequestView[];
  initialKey?: string | null;
  onOpenChild?: (request: DescendantRequestView) => void;
  onRetry?: () => void;
  onOpenDecisionHistory?: () => void;
  status?: "loading" | "unavailable" | "ready";
}) {
  const [descendants, setDescendants] = React.useState(initial);
  const [selected, setSelected] = React.useState<string | null>(initialKey);
  setNavigatorDescendants = setDescendants;
  return (
    <ApiProvider client={api}>
      <SessionRequestPanel
        session={{ ...evidenceSession(), pendingApproval: null } as SessionView}
        descendants={descendants}
        descendantStatus={status}
        selectedKey={selected}
        onSelectedKeyChange={setSelected}
        onDescendantsUpdate={() => {}}
        onOpenChild={onOpenChild}
        onRetry={onRetry}
        onOpenDecisionHistory={onOpenDecisionHistory}
      />
    </ApiProvider>
  );
}

async function mountNavigator(props: Parameters<typeof Navigator>[0]) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<Navigator {...props} />));
  return {
    container,
    rows: () => [...container.querySelectorAll<HTMLButtonElement>(".request-panel-row")],
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name),
    position: () => container.querySelector(".request-panel-position")?.textContent,
    cleanUp: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const active = () => domWindow.document.activeElement as unknown as Element | null;

test("empty, loading and unavailable are a compact state, skeleton rows and a danger notice with Retry (#2206)", async () => {
  let retries = 0;
  let historyOpened = 0;
  let view = await mountNavigator({ descendants: [], status: "loading" });
  try {
    assert.doesNotMatch(view.container.textContent ?? "", /Nothing Waiting/, "a load is never empty");
    assertNoDomNode(view.container.querySelector(".request-panel-skeleton"), "nothing new under 300ms (§12.3)");
    await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 350)); });
    const skeleton = view.container.querySelector(".request-panel-skeleton");
    assert.equal(skeleton?.getAttribute("role"), "status");
    assert.equal(skeleton?.querySelectorAll(".row.row-2 .skeleton-bar.title").length, 4, "skeleton rows at the rows' anatomy");
    assert.equal(skeleton?.textContent, "Loading requests…");
  } finally {
    await view.cleanUp();
  }

  view = await mountNavigator({ descendants: [], status: "unavailable", onRetry: () => { retries += 1; } });
  try {
    const notice = view.container.querySelector(".notice");
    assert.match(notice?.className ?? "", /\bt-danger\b/u);
    assert.match(notice?.textContent ?? "", /Couldn't Load Requests/);
    assert.match(notice?.textContent ?? "", /can't be checked right now\./);
    assert.deepEqual([...view.container.querySelectorAll("button")].map((button) => button.textContent), ["Retry"],
      "unverified request controls fail closed: Retry is the only control");
    await act(async () => view.button("Retry")!.click());
    assert.equal(retries, 1);
  } finally {
    await view.cleanUp();
  }

  view = await mountNavigator({ descendants: [], status: "ready", onOpenDecisionHistory: () => { historyOpened += 1; } });
  try {
    assert.equal(view.container.querySelector(".state.compact .state-title")?.textContent, "Nothing Waiting");
    assert.equal(view.container.querySelector(".state-body")?.textContent,
      "Requests from this session and its child sessions appear here.");
    await act(async () => view.button("Decision History")!.click());
    assert.equal(historyOpened, 1);
  } finally {
    await view.cleanUp();
  }
});

test("the list has Waiting for You and Orchestrator Is Handling, with two-line rows that arrow keys move through (#2206)", async () => {
  const view = await mountNavigator({ descendants: campaignRequests() });
  try {
    const heads = [...view.container.querySelectorAll(".request-panel-group-head")];
    assert.deepEqual(heads.map((head) => head.textContent), ["Waiting for You8", "Orchestrator Is Handling4"]);
    assert.ok(heads[0]!.querySelector(".count-badge"), "what waits for the person carries a count badge");
    assertNoDomNode(view.container.querySelector(".request-panel-count, .request-panel-owner-group, .request-owner"),
      "the uppercase eyebrow, count row and owner pill are gone");
    const rows = view.rows();
    assert.equal(rows.length, 12);
    for (const row of rows) {
      assert.match(row.className, /\brow row-2\b/u);
      assert.equal(row.querySelectorAll(".row-title, .row-sub").length, 2, "two lines");
      assert.doesNotMatch(row.textContent ?? "", /Pending|Human/u);
      assertNoDomNode(row.querySelector(".is-selected, [aria-current]"));
    }
    assert.equal(rows[0]!.querySelector(".row-title")?.textContent, "Choose a target for child 1");
    assert.equal(rows[0]!.querySelector(".row-sub")?.textContent, "Question in Child Session 1");
    assert.equal(rows[8]!.querySelector(".row-sub")?.textContent, "PR Merge in Child Session 3");
    assert.equal(rows[0]!.dataset.responseOwner, "human");
    assert.equal(rows[8]!.dataset.responseOwner, "orchestrator");
    assert.deepEqual(rows.map((row) => row.tabIndex), rows.map((_, index) => index === 0 ? 0 : -1), "one Tab stop");

    const list = view.container.querySelector<HTMLElement>(".request-panel-list")!;
    const key = (name: string) => act(async () => {
      fireDomEvent.keyDown(active() as never, { key: name });
    });
    await act(async () => rows[0]!.focus());
    await key("ArrowDown");
    assert.equal(active(), rows[1]);
    await key("End");
    assert.equal(active(), rows[11], "the arrows cross from one group into the next");
    await key("Home");
    assert.equal(active(), rows[0]);
    assert.ok(list.contains(active() as never));
  } finally {
    await view.cleanUp();
  }
});

test("a row opens its request in the list's place; ‹ › step through its group and All Requests returns to its row (#2206)", async () => {
  const opened: DescendantRequestView[] = [];
  const view = await mountNavigator({ descendants: campaignRequests(), onOpenChild: (request) => opened.push(request) });
  try {
    await act(async () => view.rows()[1]!.click());
    assertNoDomNode(view.container.querySelector(".request-panel-list"), "the detail replaces the list");
    assert.equal(view.position(), "Request 2 of 8");
    const card = view.container.querySelector(".request-panel-detail .question-card");
    assert.equal(card?.getAttribute("data-presentation"), "panel");
    assert.equal(active(), card?.querySelector(".request-card-title"), "focus lands on the request it opened");
    assert.match(card?.querySelector(".request-card-title")?.textContent ?? "", /child 2/);

    await act(async () => view.button("Next Request")!.click());
    assert.equal(view.position(), "Request 3 of 8");
    assert.match(view.container.querySelector(".request-card-title")?.textContent ?? "", /child 4/,
      "the Orchestrator's request between them is in its own group");
    await act(async () => view.button("Previous Request")!.click());
    await act(async () => view.button("Previous Request")!.click());
    assert.equal(view.position(), "Request 1 of 8");
    assert.equal(view.button("Previous Request")!.getAttribute("aria-disabled"), "true");
    await act(async () => view.button("Previous Request")!.click());
    assert.equal(view.position(), "Request 1 of 8", "nothing before the first");

    // The child session's title links to it, in place of Open Child Session.
    const link = view.container.querySelector<HTMLAnchorElement>("a.request-panel-child")!;
    assert.equal(link.textContent, "Child Session 1");
    assert.equal(link.getAttribute("href"), viewPath({ name: "session", id: "child-1" }));
    assert.equal(view.button("Open Child Session"), undefined);
    await act(async () => { link.click(); });
    assert.deepEqual(opened.map((request) => request.sessionId), ["child-1"]);

    await act(async () => view.button("All Requests")!.click());
    assert.equal(view.rows().length, 12);
    assert.equal(active(), view.rows()[0], "focus returns to the row of the request it left");
    assert.equal(view.rows()[0]!.tabIndex, 0);
  } finally {
    await view.cleanUp();
  }
});

test("a request the Orchestrator handles is the same card, read-only, with a neutral notice and its facts (#2206)", async () => {
  const view = await mountNavigator({ descendants: campaignRequests() });
  try {
    await act(async () => view.rows()[8]!.click());
    assert.equal(view.position(), "Request 1 of 4");
    const card = view.container.querySelector<HTMLElement>(".request-panel-detail .request-card")!;
    assert.equal(card.dataset.presentation, "panel");
    assert.equal(card.dataset.readOnly, "");
    assert.equal(card.querySelector(".notice")?.textContent, "The Orchestrator is handling this request.");
    assert.match(card.querySelector(".notice")?.className ?? "", /\bt-neutral\b/u);
    assert.match(card.querySelector(".facts")?.textContent ?? "", /Pull Request#43/);
    assertNoDomNode(card.querySelector("button, .request-card-foot"),
      "the person has no control over a decision the Orchestrator owns");
  } finally {
    await view.cleanUp();
  }
});

test("an answered request gives way to the next in its group, and the last one to the list (#2206)", async () => {
  const requests = campaignRequests().filter((request) => request.responseOwner === "human").slice(0, 2)
    .concat(campaignRequests().filter((request) => request.responseOwner === "orchestrator").slice(0, 1));
  const view = await mountNavigator({ descendants: requests });
  try {
    await act(async () => view.rows()[0]!.click());
    assert.equal(view.position(), "Request 1 of 2");
    await act(async () => setNavigatorDescendants(requests.slice(1)));
    assert.equal(view.position(), "Request 1 of 1");
    assert.match(view.container.querySelector(".request-card-title")?.textContent ?? "", /child 2/);
    assert.equal(active(), view.container.querySelector(".request-card-title"), "focus stays with the requests");
    // With nothing left waiting for the person, the list comes back rather than the Orchestrator's.
    await act(async () => setNavigatorDescendants(requests.slice(2)));
    assert.equal(view.rows().length, 1);
    assertNoDomNode(view.container.querySelector(".request-panel-detail"));
  } finally {
    await view.cleanUp();
  }
});

test("focus on the last request's controls goes to Nothing Waiting when it is answered (#2206)", async () => {
  const view = await mountNavigator({ descendants: [childRequest(1, "human")] });
  try {
    await act(async () => view.rows()[0]!.click());
    const submit = view.container.querySelector<HTMLButtonElement>('[data-session-request-control="submit"]')!;
    await act(async () => submit.focus());
    assert.equal(active(), submit);
    await act(async () => setNavigatorDescendants([]));
    assert.equal(view.container.querySelector(".state-title")?.textContent, "Nothing Waiting");
    assert.equal(active(), view.container.querySelector(".state-title"), "focus stays in the panel, on what it now says");
  } finally {
    await view.cleanUp();
  }
});

test("the replacement keeps the request's place in its own group when the other group changes too (#2206)", async () => {
  const [h1, h2, o1, o2] = [childRequest(1, "human"), childRequest(2, "human"), childRequest(3, "orchestrator"),
    childRequest(6, "orchestrator")];
  const view = await mountNavigator({ descendants: [h1!, h2!, o1!, o2!] });
  try {
    await act(async () => view.rows()[2]!.click());
    assert.equal(view.position(), "Request 1 of 2");
    assert.equal(view.container.querySelector("a.request-panel-child")?.textContent, "Child Session 3");
    // One poll answers H1 and the Orchestrator's O1: O2 is now first in the Orchestrator's group.
    await act(async () => setNavigatorDescendants([h2!, o2!]));
    assert.equal(view.position(), "Request 1 of 1");
    assert.equal(view.container.querySelector("a.request-panel-child")?.textContent, "Child Session 6");
    // A request arriving in the other group moves nothing either.
    await act(async () => setNavigatorDescendants([childRequest(4, "human"), childRequest(5, "human"), h2!, o2!]));
    assert.equal(view.container.querySelector("a.request-panel-child")?.textContent, "Child Session 6");
  } finally {
    await view.cleanUp();
  }
});

test("switching between descendant questions preserves each request's draft", async () => {
  const session = { ...evidenceSession(), pendingApproval: null } as SessionView;
  const question = (suffix: string): DescendantRequestView => ({
    sessionId: `child-${suffix}`,
    sessionTitle: `Child ${suffix}`,
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: 1,
    createdAt: Date.now(),
    responseOwner: "human",
    occurrenceId: `occurrence-${suffix}`,
    request: {
      requestId: `question-${suffix}`,
      occurrenceId: `occurrence-${suffix}`,
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "response", question: `Answer ${suffix}`, options: [], allowOther: true }],
    },
  });
  const requests = [question("one"), question("two")];
  let selected = sessionRequestPanelKey(requests[0]!.sessionId, requests[0]!.occurrenceId);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => root.render(
    <ApiProvider client={api}>
      <SessionRequestPanel
        session={session}
        descendants={requests}
        selectedKey={selected}
        onSelectedKeyChange={(key) => { selected = key ?? selected; render(); }}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>,
  );
  try {
    await act(async () => render());
    const firstInput = container.querySelector<HTMLInputElement>(".question-input")!;
    await act(async () => {
      firstInput.value = "Keep this draft";
      fireDomEvent.change(firstInput, { target: { value: "Keep this draft" } } as never);
    });
    const storedDraft = storedQuestionDrafts("child-one", "question-one").response;
    assert.equal(storedDraft?.kind === "other" ? storedDraft.value : undefined, "Keep this draft");
    const step = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === name)!;
    await act(async () => step("Next Request").click());
    assert.match(container.querySelector(".request-card-title")?.textContent ?? "", /Answer two/);
    await act(async () => step("Previous Request").click());
    assert.equal(container.querySelector<HTMLInputElement>(".question-input")?.value, "Keep this draft");
  } finally {
    clearQuestionDrafts("child-one", "question-one");
    clearQuestionDrafts("child-two", "question-two");
    await act(async () => root.unmount());
    container.remove();
  }
});

function DraftRetirement({ session }: { session: SessionView }) {
  useEvidenceDraftRetirement(session.id, dockRequests(pendingRequests(session.pendingApproval)));
  return null;
}

test("remote evidence resolution clears the stale review draft", async () => {
  const pending = evidenceSession();
  const decision = pending.pendingApproval!.workflowDecision!;
  const evidenceIds = decision.resourceSnapshot.category === "ui_evidence_approval"
    ? decision.resourceSnapshot.evidence.map((item) => item.evidenceId) : [];
  saveEvidenceReviewDraft(
    "local",
    pending.id,
    pending.pendingApproval!.requestId,
    decision.resourceDigest,
    evidenceIds.slice(0, 2),
  );
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<DraftRetirement session={pending} />));
    assert.deepEqual(loadEvidenceReviewDraft("local", pending.id, pending.pendingApproval!.requestId,
      decision.resourceDigest, evidenceIds), evidenceIds.slice(0, 2), "a pending review keeps its draft");
    await act(async () => root.render(
      <DraftRetirement session={{ ...pending, status: "running", pendingApproval: null } as SessionView} />,
    ));
    assert.deepEqual(loadEvidenceReviewDraft(
      "local",
      pending.id,
      pending.pendingApproval!.requestId,
      decision.resourceDigest,
      evidenceIds,
    ), []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a Viewer cannot answer a descendant question whose child view has not reached the store (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const refused = { allowed: false as const, reason };
  const session = {
    ...evidenceSession(),
    pendingApproval: null,
    commandPermissions: { stop: refused, restart: refused, stopBackgroundJob: refused, respond: refused },
  } as SessionView;
  const child: DescendantRequestView = {
    sessionId: "child-not-in-store",
    sessionTitle: "Unloaded Child",
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: 8,
    createdAt: Date.now() - 60_000,
    responseOwner: "human",
    occurrenceId: "child-occurrence",
    request: {
      requestId: "child-question",
      occurrenceId: "child-occurrence",
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
    },
  };
  const answered: string[] = [];
  const client = {
    ...api,
    answerQuestion: async (sessionId: string) => { answered.push(sessionId); return session; },
  } as unknown as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <SessionRequestPanel
          session={session}
          descendants={[child]}
          selectedKey={sessionRequestPanelKey(child.sessionId, child.occurrenceId)}
          onSelectedKeyChange={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelector('.question-card [role="status"][aria-atomic="true"]')?.textContent, reason,
      "the requester's own verdict stands in for the missing child view");
    assert.equal(container.querySelector(".question-card .request-card-reasons")?.textContent, reason, "and the card shows it");
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".question-card .request-card-foot button")];
    assert.ok(actions.length > 0);
    assert.ok(actions.every((button) => button.disabled));
    await act(async () => { for (const button of actions) button.click(); });
    assert.deepEqual(answered, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
