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
        runnerOnline
        descendants={[child]}
        selectedKey={sessionRequestPanelKey(child.sessionId, child.occurrenceId)}
        onSelectedKeyChange={() => {}}
        onSessionUpdate={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>
  );
}

const footButtons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")];

test("the session's own request is not listed in the panel: the dock above the composer answers it", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={api as ApiClient}>
        <SessionRequestPanel
          session={standaloneApprovalSession()}
          runnerOnline
          descendants={[]}
          selectedKey={null}
          onSelectedKeyChange={() => {}}
          onSessionUpdate={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.match(container.textContent ?? "", /No Pending Requests/);
    assertNoDomNode(container.querySelector(".request-card"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

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
    assert.equal(container.querySelectorAll(".evidence-review-item").length, 8);
    assert.equal(container.querySelectorAll(".evidence-review-list").length, 1);
    assert.doesNotMatch(container.textContent ?? "", /signature=secret|https:\/\/evidence/);
    assert.equal(container.querySelector("details")?.hasAttribute("open"), false);
    const approve = footButtons(container).find((button) => button.textContent === "Approve")!;
    const deny = footButtons(container).find((button) => button.textContent === "Deny")!;
    assert.equal(approve.disabled, true);
    assert.equal(deny.disabled, false);
    // Approve's reason is the visible sentence above the evidence.
    assert.equal(domWindow.document.getElementById(approve.getAttribute("aria-describedby")!)?.textContent,
      "Review every artifact before approving this request.");
    const checks = [...container.querySelectorAll<HTMLInputElement>('.evidence-review-item input[type="checkbox"]')];
    await act(async () => {
      checks[0]!.click();
      checks[1]!.click();
      checks[2]!.click();
    });
    assert.match(container.querySelector(".evidence-review-summary [role=\"status\"]")?.textContent ?? "", /3 of 8 Reviewed/);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<ChildPanel child={child} client={client} />));
    const restored = [...container.querySelectorAll<HTMLInputElement>('.evidence-review-item input[type="checkbox"]')];
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
    assert.match(container.querySelector(".evidence-review")?.textContent ?? "",
      /assigned to the Orchestrator, but this request needs a human\. Evidence "clip" is video/);
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
    // An allow_always option waits in the ⋯ menu; the reject is the visible secondary.
    assert.deepEqual(footButtons(container).map((button) => button.textContent || button.getAttribute("aria-label")),
      ["Create Without Setup", "More Choices"]);
    await act(async () => { footButtons(container)[1]!.click(); });
    const trust = [...(domWindow.document.body as unknown as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === "Trust This Configuration")!;
    await act(async () => { trust.click(); });
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

test("empty descendant inbox distinguishes loading, unavailable, and authoritative empty states", async () => {
  const session = { ...evidenceSession(), pendingApproval: null } as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (descendantStatus: "loading" | "unavailable" | "ready") => root.render(
    <ApiProvider client={api}>
      <SessionRequestPanel
        session={session}
        runnerOnline
        descendants={[]}
        descendantStatus={descendantStatus}
        selectedKey={null}
        onSelectedKeyChange={() => {}}
        onSessionUpdate={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>,
  );
  try {
    await act(async () => render("loading"));
    assert.match(container.textContent ?? "", /Loading Requests/);
    assert.doesNotMatch(container.textContent ?? "", /No Pending Requests/);

    await act(async () => render("unavailable"));
    assert.match(container.textContent ?? "", /Requests Unavailable/);
    assert.match(container.textContent ?? "", /retry automatically/);
    assertNoDomNode(container.querySelector("button"), "unverified request controls fail closed");

    await act(async () => render("ready"));
    assert.match(container.textContent ?? "", /No Pending Requests/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("descendant inbox exposes count, ownership, keyboard selection, and canonical child links", async () => {
  const session = { ...evidenceSession(), pendingApproval: null } as SessionView;
  const human: DescendantRequestView = {
    sessionId: "child-human",
    sessionTitle: "Human Child",
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: 8,
    createdAt: Date.now() - 60_000,
    responseOwner: "human",
    occurrenceId: "human-occurrence",
    request: {
      requestId: "human-question",
      occurrenceId: "human-occurrence",
      kind: "question",
      title: "Question",
      options: [],
      questions: [{ id: "target", question: "Choose a target", options: [{ label: "Staging" }] }],
    },
  };
  const orchestrator: DescendantRequestView = {
    sessionId: "child-orchestrator",
    sessionTitle: "Orchestrator Child",
    runnerId: "runner",
    runnerOnline: true,
    eventEpoch: 9,
    createdAt: Date.now() - 120_000,
    responseOwner: "orchestrator",
    occurrenceId: "orchestrator-occurrence",
    request: {
      requestId: "orchestrator-decision",
      occurrenceId: "orchestrator-occurrence",
      kind: "workflow_decision",
      title: "PR Merge Approval Required",
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      workflowDecision: {
        requestId: "merge-1",
        occurrenceId: "orchestrator-occurrence",
        sessionId: "child-orchestrator",
        controllingSessionId: "session-evidence-panel",
        category: "pr_merge",
        resourceKey: "pr-44",
        resourceSnapshot: {
          category: "pr_merge",
          repository: "picoduck/wollipog",
          pullRequest: 44,
          headSha: "b".repeat(40),
          reviewResult: "merge",
          requiredChecks: { headSha: "b".repeat(40), status: "passed", checkedAt: 1, checks: [] },
        },
        resourceDigest: "c".repeat(64),
        policyRevision: 3,
        authority: "orchestrator",
        status: "pending",
        createdAt: Date.now() - 120_000,
      },
    },
  };
  const opened: DescendantRequestView[] = [];
  let selected = sessionRequestPanelKey(human.sessionId, human.occurrenceId);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = () => root.render(
    <ApiProvider client={api}>
      <SessionRequestPanel
        session={session}
        runnerOnline
        descendants={[human, orchestrator]}
        selectedKey={selected}
        onSelectedKeyChange={(key) => { selected = key ?? selected; render(); }}
        onSessionUpdate={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={(request) => opened.push(request)}
      />
    </ApiProvider>,
  );
  try {
    await act(async () => render());
    assert.match(container.querySelector(".request-panel-count")?.textContent ?? "", /Needs Your Input 1/);
    assert.match(container.querySelector(".request-panel-count")?.textContent ?? "", /Orchestrator Action 1/);
    const list = container.querySelector<HTMLElement>('.request-panel-list')!;
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.request-panel-row')];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent ?? "", /Human/);
    await act(async () => {
      rows[0]!.focus();
      list.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
    });
    assert.equal(rows[1]!.getAttribute("aria-current"), "true");
    assert.match(container.querySelector(".request-owner")?.textContent ?? "", /Assigned to Orchestrator/);
    assertNoDomNode(container.querySelector(".request-readonly button, .request-card"),
      "the human dashboard does not expose controls for an Orchestrator-owned decision");
    assert.match(container.querySelector(".request-structured-summary")?.textContent ?? "", /Pull Request#44/);
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Open Child Session")!;
    await act(async () => open.click());
    assert.deepEqual(opened, [orchestrator]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
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
        runnerOnline
        descendants={requests}
        selectedKey={selected}
        onSelectedKeyChange={(key) => { selected = key ?? selected; render(); }}
        onSessionUpdate={() => {}}
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
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".request-panel-row")];
    await act(async () => rows()[1]!.click());
    await act(async () => rows()[0]!.click());
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
          runnerOnline
          descendants={[child]}
          selectedKey={sessionRequestPanelKey(child.sessionId, child.occurrenceId)}
          onSelectedKeyChange={() => {}}
          onSessionUpdate={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelector(".question-availability")?.textContent, reason,
      "the requester's own verdict stands in for the missing child view");
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".question-actions button")];
    assert.ok(actions.length > 0);
    assert.ok(actions.every((button) => button.disabled));
    await act(async () => { for (const button of actions) button.click(); });
    assert.deepEqual(answered, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
