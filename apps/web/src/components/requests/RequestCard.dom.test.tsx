import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  prioritizedPendingRequests,
  removePendingRequest,
  type ControlPlaneToUi,
  type PendingApproval,
  type RunnerView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../../api.js";
import { ApiProvider } from "../../api-context.js";
import { StoreProvider } from "../../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../../ui-transport.js";
import type { ViewNavigation } from "../../navigation.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { assertNoDomNode } from "../../dom-test-assertions.js";
import { RequestCard, type RequestIntentHandler } from "./RequestCard.js";
import { RequestDock, dockRequests } from "./RequestDock.js";
import { revealDockedRequest } from "./request-reveal.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));
const body = () => domWindow.document.body as unknown as HTMLElement;

const permission = (): PendingApproval => ({
  requestId: "permission-deploy",
  kind: "permission",
  title: "Run pnpm deploy?",
  context: { toolName: "Bash", path: "/workspace/project", branch: "fix/request-dock", input: "pnpm deploy --target production" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always Allow in This Session", kind: "allow_always",
      description: "Allows pnpm deploy without asking until the session ends." },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ],
});
const pause = (kind: "cost_budget" | "max_tool_calls"): PendingApproval => ({
  requestId: `${kind}:session:1`,
  kind,
  title: kind === "cost_budget" ? "Cost budget reached — $5.02 of $5.00. Continue?" : "Tool-call limit reached — 200 of 200 tool calls. Continue?",
  options: [
    { optionId: "continue", name: "Continue", kind: "allow_once" },
    { optionId: "cancel", name: "Stop", kind: "reject_once" },
  ],
});
const signIn = (): PendingApproval => ({
  requestId: "auth:claude",
  kind: "authentication",
  title: "Sign In to Claude Code",
  options: [
    { optionId: "auth:login", name: "Start Sign-In", kind: "allow_once" },
    { optionId: "auth:dismiss", name: "Dismiss Recovery", kind: "reject_once" },
  ],
});

function sessionWith(request: PendingApproval | null, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session-dock",
    runnerId: "runner-1",
    title: "Request Dock",
    status: request ? "input_required" : "running",
    agentName: "Claude Code",
    driver: "claude-code",
    pendingApproval: request,
    ...overrides,
  } as SessionView;
}

async function render(element: React.ReactElement, client: Partial<ApiClient> = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const fullClient = { ...api, governancePolicies: async () => ({ policies: [] }), ...client } as ApiClient;
  await act(async () => { root.render(<ApiProvider client={fullClient}>{element}</ApiProvider>); await tick(); });
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => { root.render(<ApiProvider client={fullClient}>{next}</ApiProvider>); await tick(); });
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

/** The footer as a person reads it: each control's name, in order, and which is the primary. */
function footer(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")].map((button) =>
    `${button.getAttribute("aria-label") ?? button.textContent}${button.classList.contains("primary") ? " (primary)" : ""}`);
}

test("the footer is the secondary options, the ⋯ menu when there are extra options, then the one primary, last", async () => {
  const cases: Array<[PendingApproval, string[]]> = [
    [permission(), ["Reject", "More Choices", "Allow (primary)"]],
    [pause("cost_budget"), ["Stop", "Continue (primary)"]],
    [pause("max_tool_calls"), ["Stop", "Continue (primary)"]],
  ];
  for (const [request, expected] of cases) {
    const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />);
    try {
      assert.deepEqual(footer(view.container), expected, String(request.kind));
      assert.equal(view.container.querySelectorAll(".request-card-foot .primary").length, 1, "exactly one primary");
    } finally {
      await view.unmount();
    }
  }
});

test("an allow_always option is only in the menu, with its description visible as its second line", async () => {
  const decisions: unknown[] = [];
  const request = permission();
  const view = await render(
    <RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />,
    { approve: async (_id, body) => { decisions.push(body); return sessionWith(null); } },
  );
  try {
    assert.doesNotMatch(view.container.querySelector(".request-card-foot")?.textContent ?? "", /Always Allow/);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="More Choices"]')!.click(); });
    const item = [...body().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(item.map((entry) => entry.querySelector(".menu-text")?.textContent), ["Always Allow in This Session"]);
    assert.equal(item[0]!.querySelector(".menu-desc")?.textContent, "Allows pnpm deploy without asking until the session ends.");
    await act(async () => { item[0]!.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "permission-deploy", optionId: "always" }]);
  } finally {
    await view.unmount();
  }
});

test("the card's body is the command in a code well and the match context as facts, and no emoji", async () => {
  const request = permission();
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock"
    owner="Claude Code" createdAt={Date.now() - 2 * 60_000} />);
  try {
    const card = view.container.querySelector<HTMLElement>(".request-card")!;
    assert.equal(card.dataset.requestKind, "permission");
    assert.match(card.querySelector(".request-card-head")?.textContent ?? "", /^Permission.*Claude Code.*2m ago/u);
    assert.equal(card.querySelector("h3")?.textContent, "Run pnpm deploy?");
    assert.equal(card.querySelector(".code-well pre")?.textContent, "pnpm deploy --target production");
    assert.deepEqual([...card.querySelectorAll(".facts dt")].map((term) => term.textContent), ["Tool", "Path", "Branch"]);
    assert.doesNotMatch(card.textContent ?? "", /\p{Extended_Pictographic}/u);
    assert.ok(card.querySelector(".request-card-head svg.app-icon"), "the kind is a Lucide icon");
  } finally {
    await view.unmount();
  }
});

test("with the runner offline, Allow and Reject are disabled and their description is the visible reason", async () => {
  const request = permission();
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline={false} presentation="dock" />);
  try {
    for (const name of ["Allow", "Reject"]) {
      const button = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
        .find((candidate) => candidate.textContent === name)!;
      assert.equal(button.disabled, true, name);
      assert.equal(domWindow.document.getElementById(button.getAttribute("aria-describedby")!)?.textContent,
        "Decisions are unavailable until the runner reconnects.");
    }
    assert.equal(view.container.querySelector(".request-card-reasons")?.textContent,
      "Decisions are unavailable until the runner reconnects.");
    assertNoDomNode(view.container.querySelector(".request-card-foot [title]:not([aria-label])"),
      "no tooltip carries the reason");
  } finally {
    await view.unmount();
  }
});

test("a Viewer reads the request with every option disabled, the refusal visible, and no decision sent (#1857)", async () => {
  const reason = "Your Viewer role is read-only.";
  const decisions: unknown[] = [];
  const request = permission();
  const session = sessionWith(request, { commandPermissions: {
    stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
    respond: { allowed: false, reason },
  } } as Partial<SessionView>);
  const view = await render(<RequestCard session={session} request={request} runnerOnline presentation="dock" />,
    { approve: async (_id, body) => { decisions.push(body); return session; } });
  try {
    const allow = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Allow")!;
    assert.equal(allow.disabled, true);
    assert.equal(domWindow.document.getElementById(allow.getAttribute("aria-describedby")!)?.textContent, reason);
    await act(async () => { allow.click(); await tick(); });
    assert.deepEqual(decisions, []);
  } finally {
    await view.unmount();
  }
});

test("a policy ask names its policy and counts down to its automatic rejection", async () => {
  const request: PendingApproval = {
    requestId: "policy-ask",
    kind: "policy_hook",
    title: "Bash requires approval.",
    governancePolicyId: "deploy-guard",
    expiresAt: Date.now() + (9 * 60 + 42) * 1000 + 500,
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline={false} presentation="dock" />, {
    governancePolicies: async () => ({ policies: [{ policyId: "deploy-guard", name: "Deploy Guard" }] }) as never,
  });
  try {
    await act(async () => { await tick(); });
    assert.equal(view.container.querySelector(".request-card-policy")?.textContent,
      "Asked by Deploy Guard · Rejects automatically in 9:43");
    assert.equal(view.container.querySelector(".request-card")?.getAttribute("data-request-kind"), "permission");
    // A policy ask is the control plane's: an offline runner does not stop its decision.
    assert.ok([...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")].every((button) => !button.disabled));
  } finally {
    await view.unmount();
  }
});

test("a policy added after the list was read is named, not shown by its id", async () => {
  const policies = [{ policyId: "deploy-guard", name: "Deploy Guard" }];
  let reads = 0;
  const client = {
    ...api,
    governancePolicies: async () => { reads += 1; return { policies: [...policies] }; },
  } as unknown as ApiClient;
  const ask = (policyId: string): PendingApproval => ({
    requestId: `ask-${policyId}`, kind: "policy_hook", title: "Bash requires approval.", governancePolicyId: policyId,
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
  });
  const first = await render(<RequestCard session={sessionWith(ask("deploy-guard"))} request={ask("deploy-guard")} runnerOnline presentation="dock" />, client);
  try {
    await act(async () => { await tick(); });
    assert.equal(first.container.querySelector(".request-card-policy")?.textContent, "Asked by Deploy Guard");
  } finally {
    await first.unmount();
  }
  policies.push({ policyId: "release-freeze", name: "Release Freeze" });
  const second = await render(<RequestCard session={sessionWith(ask("release-freeze"))} request={ask("release-freeze")} runnerOnline presentation="dock" />, client);
  try {
    await act(async () => { await tick(); await tick(); });
    assert.equal(second.container.querySelector(".request-card-policy")?.textContent, "Asked by Release Freeze");
    assert.equal(reads, 2, "the list is read again for a policy it did not know");
  } finally {
    await second.unmount();
  }
});

test("the chosen option keeps its label while busy, and a failed decision is a danger notice that can be retried", async () => {
  let fail = true;
  let release!: () => void;
  const request = permission();
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />, {
    approve: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      if (fail) throw new ApiError("The runner did not accept the decision.", 503);
      return sessionWith(null);
    },
  });
  try {
    const allow = () => [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Allow")!;
    await act(async () => { allow().click(); });
    assert.equal(allow().getAttribute("aria-busy"), "true");
    assert.equal(allow().textContent, "Allow", "no Submitting… label swap");
    assert.match(view.container.textContent ?? "", /Sending your decision…/);
    await act(async () => { release(); await tick(); });
    const notice = view.container.querySelector(".notice.t-danger[role=\"alert\"]");
    assert.match(notice?.textContent ?? "", /Your decision wasn't sent\. The runner did not accept the decision\./);
    assert.ok(notice!.compareDocumentPosition(view.container.querySelector(".request-card-foot")!) &
      domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "the notice is above the footer");
    assert.equal(allow().disabled, false, "the choice stays available to retry");
    fail = false;
    await act(async () => { allow().click(); });
    await act(async () => { release(); await tick(); });
    assertNoDomNode(view.container.querySelector(".notice.t-danger"));
  } finally {
    await view.unmount();
  }
});

test("A and D act on the card and its keycaps show only where they would", async () => {
  const decisions: unknown[] = [];
  const request = permission();
  function Harness({ hints }: { hints: boolean }) {
    const intentRef = useRef<RequestIntentHandler | null>(null);
    return (
      <>
        <RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock"
          showKeyHints={hints} intentRef={intentRef} />
        <button type="button" onClick={() => intentRef.current?.("deny")}>Press D</button>
      </>
    );
  }
  const view = await render(<Harness hints />, { approve: async (_id, body) => { decisions.push(body); return sessionWith(null); } });
  try {
    const keycaps = [...view.container.querySelectorAll(".request-card-foot kbd")].map((key) => [key.parentElement?.textContent, key.textContent]);
    assert.deepEqual(keycaps, [["RejectD", "D"], ["AllowA", "A"]]);
    await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>("button")].at(-1)!.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "permission-deploy", optionId: "deny" }]);
    await view.rerender(<Harness hints={false} />);
    assertNoDomNode(view.container.querySelector("kbd"), "no keycaps where the keys do not apply");
  } finally {
    await view.unmount();
  }
});

test("a machine-owner-only sign-in shows its reason as text and the button refers to it", async () => {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  class FakeSocket implements UiSocket {
    readonly readyState = UI_SOCKET_OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    send() {}
    close() {}
    push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "request-card-sign-in",
    runtimeKey: "request-card-sign-in:1",
    createSocket: () => socket,
    onCredentialChange: () => () => {},
    close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push: () => {}, listen: () => () => {} };
  const request = signIn();
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={{ ...api, listAllSessions: async () => ({ sessions: [] }) } as unknown as ApiClient}>
          <StoreProvider connection={connection} navigation={navigation}>
            <RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />
          </StoreProvider>
        </ApiProvider>,
      );
      await Promise.resolve();
    });
    const runner = {
      runnerId: "runner-1", hostname: "studio", displayName: "Studio", os: "linux", status: "online", agents: [],
      workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 999, canManage: false,
    } as unknown as RunnerView;
    const snapshot = {
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [],
    } as unknown as UiSnapshotMessage;
    await act(async () => { socket.push(snapshot); await tick(); });
    const start = [...mountPoint.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Start Sign-In")!;
    assert.equal(start.disabled, true);
    assert.equal(domWindow.document.getElementById(start.getAttribute("aria-describedby")!)?.textContent,
      "Only the machine owner or an organization admin can start sign-in.");
    const dismiss = [...mountPoint.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Dismiss Recovery")!;
    assert.equal(dismiss.disabled, false, "the other choices stay available");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});

test("several requests: the top priority is expanded, the rest wait as rows, a row expands, a decision brings the next", async () => {
  const decisions: unknown[] = [];
  function Harness() {
    // Arrival order: the permission came first, the sign-in last.
    const [pending, setPending] = useState<PendingApproval | null>({
      ...permission(), additionalRequests: [pause("cost_budget"), signIn()],
    });
    const session = sessionWith(pending);
    return (
      <RequestDock session={session} requests={dockRequests(prioritizedPendingRequests(pending))} runnerOnline owner="Claude Code"
        onSessionUpdate={(next) => setPending(next.pendingApproval)} />
    );
  }
  let current: PendingApproval | null = { ...permission(), additionalRequests: [pause("cost_budget"), signIn()] };
  const view = await render(<Harness />, {
    approve: async (_id, body) => {
      decisions.push(body);
      current = removePendingRequest(current, (body as { requestId: string }).requestId);
      return sessionWith(current);
    },
  });
  try {
    const title = () => view.container.querySelector(".request-card h3")?.textContent;
    assert.equal(title(), "Sign In to Claude Code");
    const more = view.container.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!;
    assert.match(more.textContent ?? "", /^\+2 More Requests.*Budget, Permission$/u);
    assert.equal(more.getAttribute("aria-expanded"), "false", "closed by default");
    await act(async () => { more.click(); });
    const rows = [...view.container.querySelectorAll<HTMLButtonElement>(".request-dock-row")];
    assert.deepEqual(rows.map((row) => row.querySelector(".request-dock-row-title")?.textContent),
      ["Cost budget reached — $5.02 of $5.00. Continue?", "Run pnpm deploy?"]);
    await act(async () => { rows[1]!.click(); });
    assert.equal(title(), "Run pnpm deploy?");
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".request-card h3"), "focus moves to the card");
    // The order is unchanged: the waiting rows are still the others in priority order.
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!.click(); });
    assert.deepEqual([...view.container.querySelectorAll(".request-dock-row-title")].map((row) => row.textContent),
      ["Sign In to Claude Code", "Cost budget reached — $5.02 of $5.00. Continue?"]);
    const allow = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Allow")!;
    await act(async () => { allow.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "permission-deploy", optionId: "allow" }]);
    assert.equal(title(), "Sign In to Claude Code", "the next request in priority order comes up");
    assert.match(view.container.querySelector(".request-dock-more")?.textContent ?? "", /\+1 More Request/u);
    // A control elsewhere brings a waiting request up the same way.
    await act(async () => { assert.equal(revealDockedRequest("session-dock", "cost_budget:session:1"), true); });
    assert.equal(title(), "Cost budget reached — $5.02 of $5.00. Continue?");
    assert.equal(revealDockedRequest("session-dock", "nothing-pending"), false);
  } finally {
    await view.unmount();
  }
});

test("a workflow decision shows everything it approves: the exact issue body, and the full request behind Request Details", async () => {
  const snapshot = {
    category: "follow_up_issue_publication" as const,
    repository: "picoduck/wollipog",
    sanitizedTitle: "Shrink the Request Dock While Reading Back",
    sanitizedBody: "## Problem\n\nThe dock stays full height while the reader scrolls back.",
    labels: ["enhancement"],
  };
  const request: PendingApproval = {
    requestId: "publication",
    kind: "workflow_decision",
    title: "Follow-Up Issue Publication Approval Required",
    context: { input: JSON.stringify(snapshot) },
    options: [
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    workflowDecision: {
      requestId: "publication", occurrenceId: "publication", sessionId: "session-dock", controllingSessionId: "parent",
      category: "follow_up_issue_publication", resourceKey: "issue", resourceSnapshot: snapshot,
      resourceDigest: "d".repeat(64), policyRevision: 1, authority: "human", status: "pending", createdAt: 1,
    },
  } as PendingApproval;
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />);
  try {
    const facts = view.container.querySelector(".request-card-body .facts")!;
    assert.match(facts.textContent ?? "", /Issue Body/u);
    assert.equal(facts.querySelector(".code-well pre")?.textContent, snapshot.sanitizedBody);
    const details = view.container.querySelector<HTMLDetailsElement>(".request-card-body details.disclosure")!;
    assert.match(details.querySelector("summary")?.textContent ?? "", /^Request Details$/u);
    assert.equal(details.querySelector("pre")?.textContent, JSON.stringify(snapshot));
  } finally {
    await view.unmount();
  }
});

test("UI evidence keeps its signed links out of the card: no Request Details", async () => {
  const evidence = [{ evidenceId: "after", uri: "https://evidence.example/after.png?signature=secret", sha256: "a".repeat(64) }];
  const request = {
    requestId: "evidence", kind: "workflow_decision", title: "UI Evidence Approval Required",
    context: { input: JSON.stringify({ evidence }) },
    options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    workflowDecision: {
      requestId: "evidence", occurrenceId: "evidence", sessionId: "session-dock", controllingSessionId: "parent",
      category: "ui_evidence_approval", resourceKey: "ui", resourceSnapshot: { category: "ui_evidence_approval", evidence },
      resourceDigest: "e".repeat(64), policyRevision: 1, authority: "human", status: "pending", createdAt: 1,
    },
  } as PendingApproval;
  const view = await render(<RequestCard session={sessionWith(request)} request={request} runnerOnline presentation="dock" />);
  try {
    assertNoDomNode(view.container.querySelector("details.disclosure"));
    assert.doesNotMatch(view.container.textContent ?? "", /signature=secret/u);
  } finally {
    await view.unmount();
  }
});

/** A dock over a permission and a sign-in whose decisions answer when the test says. */
async function delayedDock() {
  const sent: unknown[] = [];
  const settle: Array<(failure?: string) => void> = [];
  function Harness() {
    const [pending, setPending] = useState<PendingApproval | null>({ ...permission(), additionalRequests: [signIn()] });
    return (
      <RequestDock session={sessionWith(pending)} requests={dockRequests(prioritizedPendingRequests(pending))} runnerOnline
        onSessionUpdate={(next) => setPending(next.pendingApproval)} />
    );
  }
  let current: PendingApproval | null = { ...permission(), additionalRequests: [signIn()] };
  const view = await render(<Harness />, {
    approve: async (_id, body) => {
      sent.push(body);
      const failure = await new Promise<string | undefined>((resolve) => { settle.push(resolve); });
      if (failure) throw new ApiError(failure, 503);
      current = removePendingRequest(current, (body as { requestId: string }).requestId);
      return sessionWith(current);
    },
  });
  const expand = async (title: RegExp) => {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!.click(); });
    const row = [...view.container.querySelectorAll<HTMLButtonElement>(".request-dock-row")]
      .find((candidate) => title.test(candidate.textContent ?? ""))!;
    await act(async () => { row.click(); });
  };
  return { view, sent, settle, expand };
}

test("a choice from the ⋯ menu keeps focus in the card while it is sent, then hands it to the next request", async () => {
  const { view, sent, settle, expand } = await delayedDock();
  try {
    await expand(/Run pnpm deploy/u);
    const more = view.container.querySelector<HTMLButtonElement>('[aria-label="More Choices"]')!;
    await act(async () => { more.focus(); more.click(); });
    const always = [...body().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.startsWith("Always Allow"))!;
    await act(async () => { always.focus(); always.click(); });
    assert.equal(sent.length, 1);
    assert.equal(domWindow.document.activeElement, view.container.querySelector('[aria-label="More Choices"]'),
      "focus waits on the ⋯ button, not on the document body");
    await act(async () => { settle[0]!(); await tick(); });
    assert.equal(view.container.querySelector(".request-card h3")?.textContent, "Sign In to Claude Code");
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".request-card h3"),
      "the next request's heading takes focus");
  } finally {
    await view.unmount();
  }
});

test("a decision that fails after its card was remounted still shows the failure and can be retried", async () => {
  const { view, sent, settle, expand } = await delayedDock();
  const allow = () => [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
    .find((button) => button.textContent === "Allow")!;
  try {
    await expand(/Run pnpm deploy/u);
    await act(async () => { allow().click(); });
    await expand(/Sign In/u);
    await expand(/Run pnpm deploy/u);
    await act(async () => { settle[0]!("The runner did not accept the decision."); await tick(); });
    assert.match(view.container.querySelector('.notice.t-danger[role="alert"]')?.textContent ?? "",
      /Your decision wasn't sent\. The runner did not accept the decision\./u);
    assert.equal(allow().disabled, false);
    await act(async () => { allow().click(); });
    assert.equal(sent.length, 2, "the retry is sent");
    assertNoDomNode(view.container.querySelector(".notice.t-danger"), "the old failure clears with the retry");
    await act(async () => { settle[1]!(); await tick(); });
  } finally {
    await view.unmount();
  }
});

test("a decision in flight survives expanding another request and coming back: no second decision is sent", async () => {
  const sent: unknown[] = [];
  let answer!: () => void;
  const pending: PendingApproval = { ...permission(), additionalRequests: [signIn()] };
  const view = await render(
    <RequestDock session={sessionWith(pending)} requests={dockRequests(prioritizedPendingRequests(pending))} runnerOnline />,
    { approve: async (_id, body) => {
      sent.push(body);
      await new Promise<void>((resolve) => { answer = resolve; });
      return sessionWith(null);
    } },
  );
  const expand = async (title: RegExp) => {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".request-dock-more .disclosure-trigger")!.click(); });
    const row = [...view.container.querySelectorAll<HTMLButtonElement>(".request-dock-row")]
      .find((candidate) => title.test(candidate.textContent ?? ""))!;
    await act(async () => { row.click(); });
  };
  const allow = () => [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
    .find((button) => button.textContent === "Allow")!;
  try {
    await expand(/Run pnpm deploy/u);
    await act(async () => { allow().click(); });
    assert.equal(sent.length, 1);
    await expand(/Sign In/u);
    await expand(/Run pnpm deploy/u);
    assert.equal(allow().getAttribute("aria-busy"), "true", "the remounted card still shows the decision in flight");
    await act(async () => { allow().click(); await tick(); });
    assert.equal(sent.length, 1, "no second decision for the same occurrence");
    await act(async () => { answer(); await tick(); });
    assert.equal(allow().getAttribute("aria-busy"), null);
  } finally {
    await view.unmount();
  }
});
