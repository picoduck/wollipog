import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act } from "react";
import { fireDomEvent } from "./test-dom-events.js";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  GitDiffFile,
  GitDiffInfo,
  GitStatusInfo,
  ReviewFinding,
  ReviewFindingsResponse,
  SessionCommandPermission,
  SessionView,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import type { GitStatus } from "./useGitStatus.js";

/**
 * A person the server refuses review-finding changes to (#1864) sees every finding control in the
 * Review pane — the list's Send Selected, Resolve and Dismiss, and the diff's per-line comment, Add
 * Finding, and inline Resolve, Dismiss and Reopen — disabled and described by the one visible
 * refusal, and none of them reaches the API. An allowed or absent verdict leaves them as before.
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
  domWindow.close();
});

// Panel scratch survives unmount on purpose (#1202), and these cases share one session id.
beforeEach(() => clearPanelScratch());

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const VIEWER = "Your Viewer role is read-only.";
const REFUSAL_ID = "review-findings-refusal";
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

function fileA(): GitDiffFile {
  return {
    path: "src/a.ts",
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 2,
      lines: [
        { status: " ", text: "alpha" },
        { status: "-", text: "old-a" },
        { status: "+", text: "new-a" },
      ],
    }],
  };
}

function fileB(): GitDiffFile {
  return {
    path: "src/b.ts",
    status: "modified",
    binary: false,
    hunks: [{
      header: "@@ -10,3 +10,3 @@",
      oldStart: 10,
      oldCount: 3,
      newStart: 10,
      newCount: 3,
      lines: [
        { status: " ", text: "keep" },
        { status: "-", text: "old-b" },
        { status: "+", text: "new-b" },
      ],
    }],
  };
}

const diff: GitDiffInfo = {
  scope: "uncommitted",
  diffHash: hash("1"),
  fineDiffHash: hash("9"),
  stats: { filesChanged: 2, insertions: 2, deletions: 2 },
  files: [fileA(), fileB()],
};

const status: GitStatusInfo = {
  branch: "agent/session-1",
  files: [{ status: "M", path: "src/a.ts" }, { status: "M", path: "src/b.ts" }],
  hasChanges: true,
  ahead: 0,
  remoteUrl: null,
  headSha: "abc1234",
  stagedCount: 0,
  addedLines: 2,
  deletedLines: 2,
};

const baseSession: SessionView = {
  id: "session-1",
  runnerId: "runner-1",
  workspaceId: null,
  workspaceName: null,
  projectId: null,
  agentId: "claude",
  agentName: "Claude",
  title: "Review Permissions Fixture",
  status: "idle",
  column: "review",
  runId: null,
  useWorktree: true,
  worktreePath: "/repo/.agent-worktrees/session-1",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  lastEventAt: null,
  messageCount: 0,
  eventEpoch: 0,
  preview: null,
  pendingApproval: null,
  driver: "claude-code",
  model: null,
  effort: null,
  permissionMode: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  adopted: false,
};

function sessionWith(manageReviewFindings: SessionCommandPermission | undefined): SessionView {
  if (!manageReviewFindings) return baseSession;
  return {
    ...baseSession,
    commandPermissions: {
      stop: { allowed: true },
      restart: { allowed: true },
      stopBackgroundJob: { allowed: true },
      manageReviewFindings,
    },
  };
}

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return {
    findingId: "finding-open",
    sessionId: baseSession.id,
    scope: "uncommitted",
    diffHash: hash("1"),
    filePath: "src/b.ts",
    side: "right",
    line: 10,
    body: "this guard is missing",
    severity: "major",
    required: true,
    status: "open",
    source: "local",
    author: { kind: "human", id: "reviewer" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** One open finding (Resolve/Dismiss in the list and inline) and one resolved one (inline Reopen). */
const findings: ReviewFinding[] = [
  finding({}),
  finding({ findingId: "finding-resolved", filePath: "src/a.ts", line: 1, body: "already handled", status: "resolved" }),
];

function findingsResponse(list: ReviewFinding[]): ReviewFindingsResponse {
  const unresolved = list.filter((f) => f.status === "open" || f.status === "sent").length;
  return {
    findings: list,
    summary: {
      total: list.length,
      unresolved,
      requiredUnresolved: list.filter((f) => f.required && f.status === "open").length,
      sent: 0,
      resolved: list.filter((f) => f.status === "resolved").length,
      dismissed: 0,
      completion: unresolved ? "in_review" : "complete",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

async function mountPanel(initial: SessionView) {
  const host = domWindow.document.createElement("div");
  domWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const calls: string[] = [];
  const client = {
    ...api,
    gitDiff: async () => ({ diff }),
    reviewFindings: async () => findingsResponse(findings),
    createReviewFinding: async () => { calls.push("create"); return findingsResponse(findings); },
    updateReviewFinding: async (_id: string, findingId: string, body: { status: string }) => {
      calls.push(`update:${findingId}:${body.status}`);
      return findingsResponse(findings);
    },
    bundleReviewFindings: async () => { calls.push("bundle"); return findingsResponse(findings); },
  } as unknown as ApiClient;
  const git: GitStatus = {
    status,
    observation: 1,
    observedAt: 1,
    settled: true,
    busy: false,
    error: null,
    errorCode: null,
    refresh: async () => {},
    refreshStatusOnly: async () => {},
    install: () => {},
    mutationRevision: 0,
  };
  const tree = (session: SessionView) => (
    <ApiProvider client={client}>
      <ReviewPanel
        session={session}
        runnerOnline
        runnerProtocolVersion={157}
        git={git}
        onOpenSourceLocation={() => {}}
      />
    </ApiProvider>
  );
  await act(async () => { root.render(tree(initial)); });
  const container = host as unknown as HTMLElement;
  assert.ok(container.querySelector(".dfile"), "the diff has loaded");
  return {
    container,
    calls,
    render: async (session: SessionView) => { await act(async () => { root.render(tree(session)); }); },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      host.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function buttonsIn(scope: Element, label: string): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => (button.textContent ?? "").trim() === label);
}

function onlyButton(scope: Element, label: string): HTMLButtonElement {
  const found = buttonsIn(scope, label);
  assert.equal(found.length, 1, `exactly one ${label} control`);
  return found[0]!;
}

function findingsList(container: HTMLElement): HTMLElement {
  const list = container.querySelector<HTMLElement>(".review-findings-list");
  assert.ok(list, "the findings list is rendered");
  return list;
}

/** Select the list's open finding, which hands the panel's foot to the selection bar (#2850). */
async function selectOpenFinding(container: HTMLElement) {
  const box = findingsList(container).querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(box, "the open finding can be selected");
  await act(async () => { fireDomEvent.click(box); });
}

function sendSelected(container: HTMLElement): HTMLButtonElement {
  const bar = container.querySelector<HTMLElement>(".finding-selection-bar");
  assert.ok(bar, "the selection bar is rendered");
  return onlyButton(bar, "Send to Agent");
}

function inlineFinding(container: HTMLElement, body: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".dfinding")]
    // A resolved or dismissed one is a single line until opened (#2851): its body is the line's words.
    .find((node) => node.querySelector(".dfinding-body")?.textContent === body
      || node.querySelector(".dfinding-summary")?.textContent?.endsWith(`: ${body}`));
  assert.ok(found, `the inline finding "${body}" is rendered`);
  return found;
}

/** The gutter's Add Finding "+" on each line (#2849). */
function commentButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
    .filter((button) => button.getAttribute("aria-label")!.startsWith("Add Finding on "));
}

/** src/b.ts's "+" on line 11. */
function commentOnB11(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('.dfile[data-path="src/b.ts"] button[aria-label="Add Finding on Line 11"]');
  assert.ok(found, "line 11 offers Add Finding");
  return found;
}

function editor(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(".dedit");
  assert.ok(found, "a draft editor is open");
  return found;
}

/** Every control a refused person must not be able to use, keyed by a readable name. */
function findingControls(container: HTMLElement): Array<[string, HTMLButtonElement]> {
  const list = findingsList(container);
  const open = inlineFinding(container, "this guard is missing");
  const resolved = inlineFinding(container, "already handled");
  return [
    ["Send to Agent", sendSelected(container)],
    ["list Resolve", onlyButton(list, "Resolve")],
    ["list Dismiss", onlyButton(list, "Dismiss")],
    ["inline Resolve", onlyButton(open, "Resolve")],
    ["inline Dismiss", onlyButton(open, "Dismiss")],
    ["inline Reopen", onlyButton(resolved, "Reopen")],
  ];
}

function assertRefused(container: HTMLElement, name: string, button: HTMLButtonElement) {
  assert.equal(button.disabled, true, `${name} is disabled`);
  assert.equal(button.getAttribute("title"), VIEWER, `${name} carries the reason as its title`);
  const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);
  assert.ok(ids.includes(REFUSAL_ID), `${name} is described by the refusal`);
  const reason = domWindow.document.getElementById(REFUSAL_ID);
  assert.ok(reason && container.contains(reason as never), "the refusal is rendered in the panel");
  assert.equal(reason.textContent, VIEWER);
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                      */
/* -------------------------------------------------------------------------- */

test("a refused person sees every finding control disabled with the reason, and nothing is sent (#1864)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: false, reason: VIEWER }));
  try {
    await selectOpenFinding(harness.container);
    const controls = findingControls(harness.container);
    assert.match(harness.container.querySelector(".finding-selection-count")?.textContent ?? "", /^1 finding selected$/u,
      "the open finding is selected, so only the refusal disables Send to Agent");
    for (const [name, button] of controls) assertRefused(harness.container, name, button);

    for (const [, button] of controls) {
      await act(async () => { fireDomEvent.click(button); await Promise.resolve(); });
    }
    assertNoDomNode(harness.container.querySelector(".dedit"), "no draft editor opened");
    assert.deepEqual(harness.calls, []);
  } finally {
    await harness.unmount();
  }
});

test("a draft left open when the refusal arrives cannot be submitted (#1864)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: true }));
  try {
    await act(async () => { fireDomEvent.click(commentOnB11(harness.container)); });
    await act(async () => {
      const body = editor(harness.container).querySelector<HTMLTextAreaElement>("textarea")!;
      body.value = "a finding written before the role changed";
      fireDomEvent.change(body);
    });
    assert.equal(onlyButton(editor(harness.container), "Add Finding").disabled, false, "allowed: Add Finding is live");

    await harness.render(sessionWith({ allowed: false, reason: VIEWER }));
    const add = onlyButton(editor(harness.container), "Add Finding");
    assertRefused(harness.container, "Add Finding", add);
    await act(async () => { fireDomEvent.click(add); await Promise.resolve(); });
    assert.equal(onlyButton(editor(harness.container), "Cancel").disabled, false, "the draft can still be put away");
    assert.deepEqual(harness.calls, []);
  } finally {
    await harness.unmount();
  }
});

test("an allowed or absent verdict leaves every finding control as it was (#1864)", async () => {
  for (const verdict of [{ allowed: true } as const, undefined]) {
    const harness = await mountPanel(sessionWith(verdict));
    try {
      assertNoDomNode(harness.container.querySelector(`#${REFUSAL_ID}`), "no refusal is shown");
      await selectOpenFinding(harness.container);
      for (const [name, button] of findingControls(harness.container)) {
        assert.equal(button.disabled, false, `${name} is enabled`);
        assert.equal(button.getAttribute("aria-describedby"), null, `${name} has no refusal description`);
      }

      await act(async () => { fireDomEvent.click(sendSelected(harness.container)); });
      await act(async () => { fireDomEvent.click(onlyButton(findingsList(harness.container), "Resolve")); });
      await act(async () => { fireDomEvent.click(onlyButton(inlineFinding(harness.container, "already handled"), "Reopen")); });
      assert.ok(commentButtons(harness.container).length > 0, "every line offers Add Finding");
      await act(async () => { fireDomEvent.click(commentOnB11(harness.container)); });
      await act(async () => {
        const body = editor(harness.container).querySelector<HTMLTextAreaElement>("textarea")!;
        body.value = "new finding";
        fireDomEvent.change(body);
      });
      await act(async () => { fireDomEvent.click(onlyButton(editor(harness.container), "Add Finding")); });
      assert.deepEqual(harness.calls, [
        "bundle",
        "update:finding-open:resolved",
        "update:finding-resolved:open",
        "create",
      ]);
    } finally {
      await harness.unmount();
    }
  }
});

test("a refused person gets no +, and the line menu lists Add Finding… unavailable with the reason (#2849)", async () => {
  const harness = await mountPanel(sessionWith({ allowed: false, reason: VIEWER }));
  try {
    assert.deepEqual(commentButtons(harness.container), [], "no line offers the + to a refused person");
    const number = harness.container.querySelector<HTMLButtonElement>('.dfile[data-path="src/b.ts"] button[aria-label="Line 11 Actions"]');
    assert.ok(number, "line 11's number opens its menu");
    await act(async () => { fireDomEvent.click(number); });
    const item = [...(domWindow.document as unknown as Document).querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.getAttribute("data-menu-label") === "Add Finding…");
    assert.ok(item, "the line menu lists Add Finding…");
    assert.equal(item.getAttribute("aria-disabled"), "true", "Add Finding… is unavailable");
    assert.equal(item.querySelector(".menu-desc")?.textContent, VIEWER, "and says why");
    await act(async () => { fireDomEvent.click(item); await Promise.resolve(); });
    assertNoDomNode(harness.container.querySelector(".diff-comment-editor"), "no draft editor opened");
    assert.deepEqual(harness.calls, []);
  } finally {
    await harness.unmount();
  }
});
