import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { DescendantRequestView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { loadEvidenceReviewDraft, saveEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { clearQuestionDrafts, storedQuestionDrafts } from "../question-response.js";
import { SessionApprovalRegion } from "./SessionApproval.js";
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

test("eight-item evidence review stays bounded, persists acknowledgement drafts, and submits exact ids", async () => {
  domWindow.localStorage.clear();
  const session = evidenceSession();
  const approvals: unknown[] = [];
  const client = {
    ...api,
    approve: async (_sessionId: string, body: unknown) => {
      approvals.push(structuredClone(body));
      return { ...session, status: "running", pendingApproval: null } as SessionView;
    },
  } as ApiClient;
  const selected = sessionRequestPanelKey(session.id, session.pendingApproval!.occurrenceId!);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  let root = createRoot(container);
  const render = () => root.render(
    <ApiProvider client={client}>
      <SessionRequestPanel
        session={session}
        runnerOnline
        descendants={[]}
        selectedKey={selected}
        onSelectedKeyChange={() => {}}
        onSessionUpdate={() => {}}
        onDescendantsUpdate={() => {}}
        onOpenChild={() => {}}
      />
    </ApiProvider>,
  );
  try {
    await act(async () => render());
    assert.equal(container.querySelectorAll(".evidence-review-item").length, 8);
    assert.equal(container.querySelectorAll(".evidence-review-list").length, 1);
    assert.equal(container.querySelector(".request-panel-list"), null,
      "a direct evidence review has one natural scrolling surface");
    assert.doesNotMatch(container.textContent ?? "", /signature=secret|https:\/\/evidence/);
    assert.equal(container.querySelector("details")?.hasAttribute("open"), false);
    const approve = [...container.querySelectorAll<HTMLButtonElement>(".evidence-review-actions button")]
      .find((button) => button.textContent === "Approve")!;
    const deny = [...container.querySelectorAll<HTMLButtonElement>(".evidence-review-actions button")]
      .find((button) => button.textContent === "Deny")!;
    assert.equal(approve.disabled, true);
    assert.equal(deny.disabled, false);
    const checks = [...container.querySelectorAll<HTMLInputElement>('.evidence-review-item input[type="checkbox"]')];
    await act(async () => {
      checks[0]!.click();
      checks[1]!.click();
      checks[2]!.click();
    });
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /3 of 8 Reviewed/);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    const restored = [...container.querySelectorAll<HTMLInputElement>('.evidence-review-item input[type="checkbox"]')];
    assert.deepEqual(restored.map((checkbox) => checkbox.checked), [
      true, true, true, false, false, false, false, false,
    ]);
    await act(async () => {
      for (const checkbox of restored.slice(3)) checkbox.click();
    });
    const restoredApprove = [...container.querySelectorAll<HTMLButtonElement>(".evidence-review-actions button")]
      .find((button) => button.textContent === "Approve")!;
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

test("standalone approval review keeps request context collapsed and submits through the existing API", async () => {
  const session = standaloneApprovalSession();
  const approvals: unknown[] = [];
  const client = {
    ...api,
    approve: async (_sessionId: string, body: unknown) => {
      approvals.push(structuredClone(body));
      return { ...session, status: "running", pendingApproval: null } as SessionView;
    },
  } as ApiClient;
  const selected = sessionRequestPanelKey(session.id, session.pendingApproval!.occurrenceId!);
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <SessionRequestPanel
          session={session}
          runnerOnline
          descendants={[]}
          selectedKey={selected}
          onSelectedKeyChange={() => {}}
          onSessionUpdate={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelector(".approval-bar"), null);
    assert.ok(container.querySelector(".approval-review-surface"));
    assert.match(container.querySelector(".approval-selector-context")?.textContent ?? "", /wollipog\.worktree_setup/);
    assert.match(container.querySelector(".approval-selector-context")?.textContent ?? "", /fix\/example/);
    const details = container.querySelector<HTMLDetailsElement>(".approval-review-details")!;
    assert.equal(details.open, false);
    assert.match(details.textContent ?? "", /pnpm install/);
    const trust = [...container.querySelectorAll<HTMLButtonElement>(".approval-review-actions button")]
      .find((button) => button.textContent === "Trust This Configuration")!;
    await act(async () => trust.click());
    assert.deepEqual(approvals, [{ requestId: "worktree-setup:one:hash", optionId: "trust" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("cost checkpoints retain their Continue and Stop actions in the responsive review surface", async () => {
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
    await act(async () => root.render(
      <ApiProvider client={api}>
        <SessionRequestPanel
          session={session}
          runnerOnline
          descendants={[]}
          selectedKey={sessionRequestPanelKey(session.id, session.pendingApproval!.occurrenceId!)}
          onSelectedKeyChange={() => {}}
          onSessionUpdate={() => {}}
          onDescendantsUpdate={() => {}}
          onOpenChild={() => {}}
        />
      </ApiProvider>,
    ));
    assert.match(container.querySelector(".approval-review-surface")?.textContent ?? "", /Cost checkpoint/);
    assert.deepEqual(
      [...container.querySelectorAll<HTMLButtonElement>(".approval-review-actions button")]
        .map((button) => button.textContent),
      ["Continue", "Stop"],
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("worker-owned approval stays in its canonical worker request surface", async () => {
  const session = standaloneApprovalSession();
  session.pendingApproval = { ...session.pendingApproval!, ownerToolUseId: "worker-tool" };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={api}>
        <SessionApprovalRegion
          session={session}
          runnerOnline
          fallbackFocusRef={{ current: null }}
          standaloneInReviewSurface
        />
      </ApiProvider>,
    ));
    assert.equal(container.querySelector(".approval-bar"), null);
    assert.equal(container.querySelector(".approval-review-surface"), null);
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
    assert.equal(container.querySelector(".request-readonly .approval-actions"), null,
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
  const focusRef = React.createRef<HTMLElement>();
  try {
    await act(async () => root.render(
      <ApiProvider client={api}>
        <SessionApprovalRegion
          session={pending}
          runnerOnline
          fallbackFocusRef={focusRef}
          standaloneInReviewSurface
        />
      </ApiProvider>,
    ));
    await act(async () => root.render(
      <ApiProvider client={api}>
        <SessionApprovalRegion
          session={{ ...pending, status: "running", pendingApproval: null } as SessionView}
          runnerOnline
          fallbackFocusRef={focusRef}
          standaloneInReviewSurface
        />
      </ApiProvider>,
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
