import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  prioritizedPendingRequests,
  removePendingRequest,
  type ControlPlaneToUi,
  type DescendantRequestView,
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
import { decideDockedRequest, revealDockedRequest } from "./request-reveal.js";
import type { FollowTailState } from "../../useFollowTail.js";
import { SessionNoticeSlot } from "../SessionNoticeSlot.js";
import { SessionRequestPanel, sessionRequestPanelKey } from "../SessionRequestPanel.js";
import { useIsMobile } from "../useIsMobile.js";

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
    /** For a caller's own `act`, so the render batches with whatever else it does there. */
    rerenderSync: (next: React.ReactElement) => { root.render(<ApiProvider client={fullClient}>{next}</ApiProvider>); },
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
      "Only a machine owner or organization admin can sign in on this machine.");
    const dismiss = [...mountPoint.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Dismiss Recovery")!;
    assert.equal(dismiss.disabled, false, "the other choices stay available");
  } finally {
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});

/** A Request Card with the session's runner in the store, as the dock renders it. */
async function renderWithRunner(element: React.ReactElement, runner: Partial<RunnerView>, client: Partial<ApiClient> = {}) {
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
    instanceId: "request-card-runner",
    runtimeKey: "request-card-runner:1",
    createSocket: () => socket,
    onCredentialChange: () => () => {},
    close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push: () => {}, listen: () => () => {} };
  const fullClient = {
    ...api,
    listAllSessions: async () => ({ sessions: [] }),
    authenticationCurrentIdentity: async () => ({
      identity: { status: "authenticated", emailSupported: true, email: "person@example.test", observedAt: Date.now() },
    }),
    authenticationAccounts: async () => ({ accounts: [] }),
    ...client,
  } as unknown as ApiClient;
  const draw = (next: React.ReactElement) => (
    <ApiProvider client={fullClient}>
      <StoreProvider connection={connection} navigation={navigation}>{next}</StoreProvider>
    </ApiProvider>
  );
  await act(async () => { root.render(draw(element)); await Promise.resolve(); });
  const snapshot = {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [{
      runnerId: "runner-1", hostname: "studio", displayName: "Studio", os: "linux", status: "online", agents: [],
      workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 999, canManage: true, providerLogins: [], ...runner,
    }],
    boxes: [], sessions: [], runs: [], pods: [],
  } as unknown as UiSnapshotMessage;
  await act(async () => { socket.push(snapshot); await tick(); await tick(); });
  return {
    container: mountPoint as unknown as HTMLElement,
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

/** The runner's sign-in options (session-manager.ts `providerAuthenticationOptions`, acp.ts `chooseAuthMethod`). */
const AUTH = {
  acceptCurrent: { optionId: "auth:accept-current", name: "Use Current Account", kind: "allow_once" },
  login: { optionId: "auth:login", name: "Start Sign-In", kind: "allow_once" },
  revalidate: { optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" },
  dismiss: { optionId: "auth:dismiss", name: "Dismiss Recovery", kind: "reject_once" },
  cancel: { optionId: "auth:cancel", name: "Cancel Sign-In", kind: "reject_once" },
} as const;
const recovery = (options: PendingApproval["options"], title = "Authentication Required — Claude Code"): PendingApproval => ({
  requestId: "provider-auth:card", kind: "authentication", title, options,
  context: { toolName: "Claude Code", input: "Provider: Claude Code\nRun `claude auth login` in that exact context." },
});
const signInSession = (request: PendingApproval, overrides: Partial<SessionView> = {}) =>
  sessionWith(request, { providerAccountId: "claude-work", providerAccountLabel: "Claude Work", ...overrides });
const chooseDialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
const dialogButton = (name: string) => [...(chooseDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
  .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name);
const CHOICES = [
  { id: "claude-work", label: "Claude Work", authStatus: "authenticated", availability: "current" },
  { id: "claude-personal", label: "Claude Personal", authStatus: "authenticated", availability: "available" },
] as const;

test("each sign-in state has exactly one primary, or only Cancel Sign-In while a sign-in runs (#2198)", async () => {
  const methods = recovery([
    { optionId: "auth_1_method_1", name: "OpenCode Zen", kind: "allow_once", description: "Sign in at opencode.ai." },
    { optionId: "auth_1_method_2", name: "API key", kind: "allow_once", description: "Read the key from this machine." },
    { optionId: "auth_1_cancel", name: "Cancel sign-in", kind: "reject_once" },
  ], "Sign in to OpenCode");
  const cases: Array<[string, PendingApproval, Partial<SessionView>, string[], boolean]> = [
    ["signed in as a different account", recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]), {},
      ["Dismiss Recovery", "Choose Another Account…", "Use Current Account (primary)"], true],
    ["a different account, where the runner can also sign in", recovery([AUTH.acceptCurrent, AUTH.login, AUTH.revalidate,
      AUTH.dismiss]), {}, ["Dismiss Recovery", "Start Sign-In", "Choose Another Account…", "Use Current Account (primary)"], true],
    ["signed out", recovery([AUTH.login, AUTH.revalidate, AUTH.dismiss]), {},
      ["Dismiss Recovery", "Choose Another Account…", "Start Sign-In (primary)"], true],
    ["signed out on the machine's default sign-in", recovery([AUTH.login, AUTH.revalidate, AUTH.dismiss]),
      { providerAccountId: undefined, providerAccountLabel: undefined },
      ["Dismiss Recovery", "Start Sign-In (primary)"], true],
    ["read-only", recovery([AUTH.revalidate, AUTH.dismiss]), {},
      ["Dismiss Recovery", "Choose Another Account…", "Recheck Authentication (primary)"], false],
    ["sign-in methods", methods, { driver: "acp" }, ["Cancel Sign-In", "Start Sign-In (primary)"], false],
    ["sign-in running", recovery([AUTH.cancel], "Signing In — Claude Code"), {}, ["Cancel Sign-In"], false],
  ];
  for (const [state, request, overrides, expected, checkAgain] of cases) {
    const view = await renderWithRunner(
      <RequestCard session={signInSession(request, overrides)} request={request} runnerOnline presentation="dock" />, {});
    try {
      assert.deepEqual(footer(view.container), expected, state);
      assert.equal(view.container.querySelectorAll(".request-card .primary").length, expected.some((name) =>
        name.endsWith("(primary)")) ? 1 : 0, `${state}: one primary in the whole card`);
      const check = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Check Again");
      assert.equal(Boolean(check), checkAgain, `${state}: Check Again`);
      assert.equal(view.container.querySelector(".request-card button[title]")?.outerHTML ?? null, null, `${state}: no button has a title`);
      assert.equal(view.container.querySelector(".request-card-head svg.lucide-key-round") !== null, true, `${state}: KeyRound`);
    } finally {
      await view.unmount();
    }
  }
});

test("without the recovery body, Recheck Authentication stays a footer secondary", async () => {
  // A harness without the recovery body (an ACP agent's sign-in), or a child's sign-in whose account
  // an older server did not send (#2714): its Check Again does not render.
  const decisions: unknown[] = [];
  const request = recovery([AUTH.login, AUTH.revalidate, AUTH.dismiss]);
  const view = await renderWithRunner(
    <RequestCard session={signInSession(request, { driver: "acp" })} request={request} runnerOnline presentation="panel" />, {},
    { approve: async (_id, body) => { decisions.push(body); return signInSession(request); } },
  );
  try {
    assert.deepEqual(footer(view.container), ["Dismiss Recovery", "Recheck Authentication", "Start Sign-In (primary)"]);
    assert.equal(view.container.querySelectorAll(".request-card .primary").length, 1);
    const recheck = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")]
      .find((button) => button.textContent === "Recheck Authentication")!;
    await act(async () => { recheck.click(); await tick(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "provider-auth:card", optionId: "auth:revalidate" }]);
  } finally {
    await view.unmount();
  }
});

/** A child's sign-in in its parent's Requests panel, open on its card. */
function childSignIn(
  parent: Partial<SessionView>,
  child: Pick<DescendantRequestView, "driver" | "providerAccountId" | "providerAccountLabel">,
  client: Partial<ApiClient> = {},
) {
  const request = { ...recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]), occurrenceId: "child-auth-occurrence" };
  const descendant: DescendantRequestView = {
    sessionId: "session-child",
    sessionTitle: "Child",
    runnerId: "runner-1",
    runnerOnline: true,
    eventEpoch: 0,
    createdAt: Date.now() - 30_000,
    responseOwner: "human",
    occurrenceId: "child-auth-occurrence",
    request,
    ...child,
  };
  return renderWithRunner(
    <SessionRequestPanel
      session={sessionWith(null, { id: "session-parent", title: "Parent", ...parent })}
      descendants={[descendant]}
      selectedKey={sessionRequestPanelKey("session-child", "child-auth-occurrence")}
      onSelectedKeyChange={() => {}}
      onDescendantsUpdate={() => {}}
      onOpenChild={() => {}}
    />,
    {},
    { authenticationAccounts: async () => ({ accounts: [...CHOICES] }), ...client },
  );
}
const factTerms = (container: HTMLElement) => [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
const factValue = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("dt")].find((dt) => dt.textContent === label)?.nextElementSibling?.textContent ?? null;

test("a child's sign-in in the Requests panel reads the child's harness and account, never the parent's (#2714)", async () => {
  const cases: Array<[string, Partial<SessionView>]> = [
    ["an ACP parent", { driver: "acp", providerAccountId: undefined, providerAccountLabel: undefined }],
    ["a parent on another account", { driver: "claude-code", providerAccountId: "claude-parent", providerAccountLabel: "Claude Parent" }],
  ];
  for (const [name, parent] of cases) {
    const selections: Array<{ sessionId: string; input: unknown }> = [];
    const identities: string[] = [];
    const view = await childSignIn(parent, { driver: "claude-code", providerAccountId: "claude-work", providerAccountLabel: "Claude Work" }, {
      authenticationCurrentIdentity: async (sessionId: string) => {
        identities.push(sessionId);
        return { identity: { status: "authenticated", emailSupported: true, email: "person@example.test", observedAt: Date.now() } };
      },
      selectAuthenticationAccount: async (sessionId: string, input: unknown) => {
        selections.push({ sessionId, input });
        return { accepted: true as const };
      },
    });
    try {
      assert.deepEqual(factTerms(view.container), ["This Session Uses", "Signed In Now", "Last Checked"], name);
      assert.match(factValue(view.container, "This Session Uses") ?? "", /^Claude Work/, name);
      assert.doesNotMatch(view.container.textContent ?? "", /Claude Parent/, name);
      assert.equal(factValue(view.container, "Last Checked")?.includes("Check Again"), true, name);
      assert.ok(identities.length > 0 && identities.every((id) => id === "session-child"), `${name}: the child's identity is read`);
      const choose = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
        .find((button) => button.textContent === "Choose Another Account…");
      assert.ok(choose, name);
      await act(async () => { choose.click(); await tick(); await tick(); });
      await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
      assert.deepEqual(selections, [{
        sessionId: "session-child",
        input: { requestId: "provider-auth:card", providerAccountId: "claude-personal", expectedProviderAccountId: "claude-work" },
      }], `${name}: the child's account is the expected one`);
    } finally {
      await view.unmount();
    }
  }
});

test("a child on the machine default reads Machine Default Sign-In under a parent bound to an account (#2714)", async () => {
  const view = await childSignIn(
    { driver: "claude-code", providerAccountId: "claude-parent", providerAccountLabel: "Claude Parent" },
    { driver: "claude-code" },
  );
  try {
    assert.match(factValue(view.container, "This Session Uses") ?? "", /^Machine Default Sign-In/);
    assert.doesNotMatch(view.container.textContent ?? "", /Claude Parent/);
    assert.equal([...view.container.querySelectorAll(".request-card-foot button")]
      .some((button) => button.textContent === "Choose Another Account…"), false, "an unbound child has no account to switch from");
  } finally {
    await view.unmount();
  }
});

test("a child's sign-in from an older server, without the child's account, shows no account facts (#2714)", async () => {
  const view = await childSignIn(
    { driver: "claude-code", providerAccountId: "claude-parent", providerAccountLabel: "Claude Parent" },
    {},
  );
  try {
    assert.deepEqual(factTerms(view.container).filter((term) =>
      term === "This Session Uses" || term === "Signed In Now" || term === "Last Checked"), []);
    assert.doesNotMatch(view.container.textContent ?? "", /Claude Parent|Machine Default Sign-In/);
    assert.deepEqual(footer(view.container), ["Dismiss Recovery", "Recheck Authentication", "Use Current Account (primary)"]);
  } finally {
    await view.unmount();
  }
});

test("Check Again on the Last Checked fact runs the runner's recheck; Dismiss Recovery sits at the far left", async () => {
  const decisions: unknown[] = [];
  const request = recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]);
  const view = await renderWithRunner(
    <RequestCard session={signInSession(request)} request={request} runnerOnline presentation="dock" />, {},
    { approve: async (_id, body) => { decisions.push(body); return signInSession(request); } },
  );
  try {
    const lastChecked = [...view.container.querySelectorAll("dt")].find((dt) => dt.textContent === "Last Checked")!;
    const check = lastChecked.nextElementSibling!.querySelector<HTMLButtonElement>("button")!;
    assert.equal(check.textContent, "Check Again");
    await act(async () => { check.click(); await tick(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "provider-auth:card", optionId: "auth:revalidate" }]);
    const dismiss = view.container.querySelector(".request-card-foot > button")!;
    assert.equal(dismiss.textContent, "Dismiss Recovery");
    assert.ok(dismiss.classList.contains("request-card-tertiary") && dismiss.classList.contains("ghost"));
    // The runner's guidance waits behind Request Details; the facts lead.
    assert.equal(view.container.querySelector(".request-card-body > .code-well")?.outerHTML ?? null, null);
    assert.ok(view.container.querySelector(".request-card-body > details.disclosure .code-well"));
    assert.equal(view.container.querySelector('.request-card-body dl[aria-label="Policy Match Context"]')?.outerHTML ?? null, null);
  } finally {
    await view.unmount();
  }
});

test("on a phone, Dismiss Recovery and Choose Another Account… overflow into ⋯, and focus follows a crossing", async () => {
  const decisions: unknown[] = [];
  let settle: () => void = () => undefined;
  const request = recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]);
  const setViewport = async (width: number) => {
    await act(async () => { domWindow.happyDOM.setViewport({ width, height: 844 }); await tick(); });
  };
  await setViewport(390);
  const view = await renderWithRunner(
    <RequestCard session={signInSession(request)} request={request} runnerOnline presentation="dock" />, {},
    {
      approve: async (_id, body) => {
        decisions.push(body);
        if ((body as { optionId: string }).optionId === "auth:accept-current") await new Promise<void>((done) => { settle = done; });
        return signInSession(request);
      },
    },
  );
  const items = () => [...(domWindow.document.querySelectorAll('[data-request-card-menu] [role="menuitem"]') as unknown as NodeListOf<HTMLElement>)];
  const button = (name: string) => [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name);
  try {
    assert.deepEqual(footer(view.container), ["More Choices", "Use Current Account (primary)"], "one phone row");
    const more = button("More Choices")!;
    assert.equal(more.hasAttribute("title"), false, "no button in the sign-in card has a title");
    await act(async () => { more.click(); await tick(); });
    assert.deepEqual(items().map((item) => item.querySelector(".menu-label")?.textContent ?? item.textContent),
      ["Choose Another Account…", "Dismiss Recovery"]);
    await act(async () => { items()[0]!.click(); await tick(); await tick(); });
    assert.equal(chooseDialog()?.getAttribute("aria-labelledby") &&
      domWindow.document.getElementById(chooseDialog()!.getAttribute("aria-labelledby")!)?.textContent,
    "Choose Another Account", "the menu item opens the dialog");
    // This Machine has no other account, so the dialog's dismiss reads Done.
    await act(async () => { dialogButton("Done")!.click(); await tick(); await tick(); });
    assertNoDomNode(chooseDialog(), "Done closes it");

    // While a decision is sent, the menu's Choose Another Account… is unavailable, as the button is.
    await act(async () => { button("Use Current Account")!.click(); await tick(); });
    await act(async () => { more.click(); await tick(); });
    if (items().length === 0) {
      // The trigger refuses clicks while busy; a keyboard can still open the menu.
      await act(async () => {
        more.focus();
        more.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event);
        await tick();
      });
    }
    const choose = items().find((item) => item.textContent?.startsWith("Choose Another Account…"));
    assert.equal(choose?.getAttribute("aria-disabled"), "true");
    await act(async () => { choose?.click(); await tick(); });
    assertNoDomNode(chooseDialog(), "the click did nothing while a decision is sent");
    await act(async () => { settle(); await tick(); await tick(); });
    await act(async () => { body().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); });

    // Widening with focus in the open phone menu closes it and hands focus to Choose Another Account….
    await act(async () => { more.click(); await tick(); });
    if (items().length > 0) await act(async () => { items()[0]!.focus(); await tick(); });
    await setViewport(1440);
    assert.equal(items().length, 0, "the menu went with its trigger");
    assert.deepEqual(footer(view.container), ["Dismiss Recovery", "Choose Another Account…", "Use Current Account (primary)"]);
    assert.equal(domWindow.document.activeElement?.textContent, "Choose Another Account…");

    // Narrowing with focus on a swapped control hands it to the ⋯.
    await setViewport(390);
    assert.equal(domWindow.document.activeElement?.getAttribute("aria-label"), "More Choices");
    assert.deepEqual(decisions, [{ requestId: "provider-auth:card", optionId: "auth:accept-current" }]);
  } finally {
    await view.unmount();
    await setViewport(1024);
  }
});

test("crossing the phone breakpoint keeps focus in the card that held it, even while a decision is sent", async () => {
  const setViewport = async (width: number) => {
    await act(async () => { domWindow.happyDOM.setViewport({ width, height: 844 }); await tick(); });
  };
  const first = recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]);
  const second = { ...recovery([AUTH.login, AUTH.revalidate, AUTH.dismiss]), requestId: "provider-auth:second" };
  let settle: () => void = () => undefined;
  await setViewport(390);
  // The dock as SessionDetail renders it, beside a Requests panel card, under a parent that re-renders
  // at the breakpoint (as SessionDetail does): each owns focus in its own menu.
  function Page() {
    const phone = useIsMobile();
    return (
      <div data-phone={phone}>
        <RequestDock session={signInSession(first)} requests={[first]} runnerOnline />
        <RequestCard session={signInSession(second, { id: "session-second" })} request={second} runnerOnline presentation="panel" />
      </div>
    );
  }
  const view = await renderWithRunner(<Page />, {},
    { approve: async () => { await new Promise<void>((done) => { settle = done; }); return signInSession(first); } },
  );
  const cards = () => [...view.container.querySelectorAll<HTMLElement>(".request-card")];
  const items = () => [...(domWindow.document.querySelectorAll('[data-request-card-menu] [role="menuitem"]') as unknown as NodeListOf<HTMLElement>)];
  const more = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('.request-card-foot > button[aria-label="More Choices"]')!;
  try {
    // Two sign-in cards: focus in the second card's menu stays with the second card when widening.
    await act(async () => { more(cards()[1]!).click(); await tick(); });
    await act(async () => { items()[0]!.focus(); await tick(); });
    await setViewport(1440);
    assert.ok(cards()[1]!.contains(domWindow.document.activeElement as unknown as Node),
      "the other card does not take focus from this one's menu");
    assert.equal(domWindow.document.activeElement?.textContent, "Choose Another Account…");

    // Dismiss Recovery from the phone menu, still being sent: widening finds Choose Another Account…
    // disabled, so the card's heading takes focus.
    await setViewport(390);
    await act(async () => { more(cards()[0]!).click(); await tick(); });
    const dismiss = items().find((item) => item.textContent?.startsWith("Dismiss Recovery"))!;
    await act(async () => { dismiss.click(); await tick(); });
    await act(async () => { more(cards()[0]!).focus(); await tick(); });
    await setViewport(1440);
    assert.equal(domWindow.document.activeElement?.classList.contains("request-card-title"), true);
    assert.ok(cards()[0]!.contains(domWindow.document.activeElement as unknown as Node));
  } finally {
    await act(async () => { settle(); await tick(); });
    await view.unmount();
    await setViewport(1024);
  }
});

/** The card with Choose Another Account… opened, and a selection that the runner answers with `code`. */
async function openChooser(code: string | null) {
  const request = recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]);
  let identity = 0;
  const view = await renderWithRunner(
    <RequestCard session={signInSession(request)} request={request} runnerOnline presentation="dock" />, {},
    {
      authenticationAccounts: async () => ({ accounts: [...CHOICES] }),
      authenticationCurrentIdentity: async () => {
        identity += 1;
        return { identity: { status: "authenticated", emailSupported: true, email: "person@example.test", observedAt: Date.now() } };
      },
      selectAuthenticationAccount: async () => {
        if (code) throw new ApiError(`runner says ${code}: provider account 'claude-personal' is not configured`, 409, code);
        return { accepted: true as const };
      },
    },
  );
  const choose = () => [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
    .find((button) => button.textContent === "Choose Another Account…") ?? null;
  await act(async () => { choose()!.click(); await tick(); await tick(); });
  return { view, choose, identity: () => identity };
}

test("Choose Another Account… opens its dialog, and a chosen account closes it", async () => {
  const { view, choose } = await openChooser(null);
  try {
    assert.equal(choose()!.getAttribute("aria-haspopup"), "dialog");
    assert.equal(choose()!.hasAttribute("aria-expanded"), false, "it opens a dialog, not a region of the card");
    assertNoDomNode(view.container.querySelector(".auth-recovery-accounts"), "the card no longer lists accounts");
    const dialog = chooseDialog()!;
    assert.match(dialog.textContent ?? "", /Continue this session with another Claude Code account on Studio\./);
    assert.ok(dialog.querySelector('[role="radiogroup"][aria-label="Accounts"]'));
    await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
    assertNoDomNode(chooseDialog(), "a selection closes the dialog");
    assertNoDomNode(view.container.querySelector(".request-card-body > .notice"), "and leaves no notice");
  } finally {
    await view.unmount();
  }
});

test("a not_resumable refusal closes the dialog, shows the can't-switch notice and removes Choose Another Account…", async () => {
  const { view, choose } = await openChooser("not_resumable");
  try {
    await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
    assertNoDomNode(chooseDialog());
    const notice = view.container.querySelector<HTMLElement>(".request-card-body > .notice");
    assert.equal(notice?.textContent?.trim(),
      "This conversation can't continue under another account. Sign in again with the current account, or start a new session.");
    assert.ok(notice?.classList.contains("compact"));
    assert.equal(notice?.getAttribute("role"), "alert");
    assertNoDomNode(choose(), "Choose Another Account… leaves the footer for this request");
    assert.ok(view.container.querySelector(".request-card-body")!.firstElementChild === notice,
      "the notice heads the scrolling body, so the card's frame does not take the facts' room");
    assert.deepEqual(footer(view.container), ["Dismiss Recovery", "Use Current Account (primary)"]);
  } finally {
    await view.unmount();
  }
});

test("a notice left by Choose Another Account is scrolled into view in a Requests panel, whose detail scrolls", async () => {
  const request = recovery([AUTH.acceptCurrent, AUTH.revalidate, AUTH.dismiss]);
  const revealed: string[] = [];
  const original = domWindow.HTMLElement.prototype.scrollIntoView;
  domWindow.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    revealed.push(this.className);
  } as typeof original;
  const view = await renderWithRunner(
    <RequestCard session={signInSession(request)} request={request} runnerOnline presentation="panel" />, {},
    {
      authenticationAccounts: async () => ({ accounts: [...CHOICES] }),
      selectAuthenticationAccount: async () => { throw new ApiError("runner words", 409, "operation_in_progress"); },
    },
  );
  try {
    const choose = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Choose Another Account…")!;
    await act(async () => { choose.click(); await tick(); await tick(); });
    await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
    revealed.length = 0;
    await act(async () => { dialogButton("Cancel")!.click(); await tick(); await tick(); });
    assert.ok(view.container.querySelector(".request-card-body > .notice"));
    assert.ok(revealed.some((name) => name.split(" ").includes("notice")),
      "the notice asks its own scroller to show it, rather than resetting a body that does not scroll");
  } finally {
    domWindow.HTMLElement.prototype.scrollIntoView = original;
    await view.unmount();
  }
});

test("an account_changed refusal closes the dialog and the card reads its facts again; nothing switches", async () => {
  const { view, identity } = await openChooser("account_changed");
  try {
    const before = identity();
    await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
    assertNoDomNode(chooseDialog());
    assert.equal(identity(), before + 1, "the facts are read again for the new configured account");
    assert.equal(view.container.querySelector(".request-card-body > .notice")?.textContent?.trim(),
      "This session's account changed while you were choosing, so nothing was switched.");
  } finally {
    await view.unmount();
  }
});

test("a refusal, then Cancel, leaves the refusal as a one-line notice on the card, never the runner's words", async () => {
  const { view, choose } = await openChooser("operation_in_progress");
  try {
    await act(async () => { dialogButton("Use Account")!.click(); await tick(); await tick(); });
    assert.match(chooseDialog()!.querySelector(".field-error")?.textContent ?? "", /Try again in a moment\./);
    await act(async () => { dialogButton("Cancel")!.click(); await tick(); await tick(); });
    const notice = view.container.querySelector<HTMLElement>(".request-card-body > .notice");
    assert.equal(notice?.textContent?.trim(), "Another sign-in or check is running for this session. Try again in a moment.");
    assert.doesNotMatch(view.container.textContent ?? "", /not configured|runner says/);
    // Opening the dialog again clears the old notice.
    await act(async () => { choose()!.click(); await tick(); await tick(); });
    assertNoDomNode(view.container.querySelector(".request-card-body > .notice"));
  } finally {
    await act(async () => { dialogButton("Cancel")?.click(); await tick(); });
    await view.unmount();
  }
});

test("a sign-in agent's methods are choice rows with visible descriptions and one Start Sign-In", async () => {
  const decisions: unknown[] = [];
  const request = recovery([
    { optionId: "auth_1_method_1", name: "OpenCode Zen", kind: "allow_once", description: "Sign in at opencode.ai." },
    { optionId: "auth_1_method_2", name: "API key", kind: "allow_once", description: "Read the key from this machine." },
    { optionId: "auth_1_cancel", name: "Cancel sign-in", kind: "reject_once" },
  ], "Sign in to OpenCode");
  const view = await render(
    <RequestCard session={sessionWith(request, { driver: "acp" })} request={request} runnerOnline presentation="dock" />,
    { approve: async (_id, body) => { decisions.push(body); return sessionWith(request); } },
  );
  try {
    const group = view.container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Sign-In Methods"]')!;
    assert.ok(group);
    assert.deepEqual([...group.querySelectorAll(".choice-row-title")].map((title) => title.textContent),
      ["OpenCode Zen", "API Key"], "names in Title Case, acronyms kept");
    assert.deepEqual([...group.querySelectorAll(".choice-row-desc")].map((desc) => desc.textContent),
      ["Sign in at opencode.ai.", "Read the key from this machine."]);
    assert.equal(group.querySelector("[title]")?.outerHTML ?? null, null, "descriptions are visible, not tooltips");
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    assert.equal(radios[0]!.checked, true, "the first method is chosen until another is");
    await act(async () => { radios[1]!.click(); await tick(); });
    const start = view.container.querySelector<HTMLButtonElement>(".request-card-foot .primary")!;
    assert.equal(start.textContent, "Start Sign-In");
    await act(async () => { start.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "provider-auth:card", optionId: "auth_1_method_2" }]);
  } finally {
    await view.unmount();
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
    // A, from whichever keyboard owner reads it (the reading keys, or the Sessions list over its
    // preview), decides the expanded request, not the top one.
    await act(async () => { assert.equal(decideDockedRequest("session-dock", "approve"), true); await tick(); });
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
    // The evidence body's own Show Details holds the key and digest, never the request's input.
    const disclosures = [...view.container.querySelectorAll("details.disclosure")];
    assert.deepEqual(disclosures.map((details) => details.querySelector("summary")?.textContent), ["Show Details"]);
    assert.doesNotMatch(disclosures[0]!.innerHTML, /signature=secret|evidence\.example/u);
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

test("revealing the request already expanded leaves no focus behind to take back from the composer later", async () => {
  const pending: PendingApproval = { ...permission(), additionalRequests: [signIn()] };
  function Harness({ tick: renderTick }: { tick: number }) {
    return (
      <>
        <RequestDock session={sessionWith(pending)} requests={dockRequests(prioritizedPendingRequests(pending))} runnerOnline
          owner={`Claude Code ${renderTick}`} />
        <textarea aria-label="Composer" />
      </>
    );
  }
  const view = await render(<Harness tick={0} />);
  try {
    await act(async () => { revealDockedRequest("session-dock", "permission-deploy"); });
    await act(async () => { revealDockedRequest("session-dock", "permission-deploy"); });
    const heading = view.container.querySelector(".request-card h3");
    assert.equal(heading?.textContent, "Run pnpm deploy?");
    assert.equal(domWindow.document.activeElement, heading);
    const composer = view.container.querySelector("textarea")!;
    await act(async () => { composer.focus(); });
    await view.rerender(<Harness tick={1} />);
    assert.equal(domWindow.document.activeElement, composer, "an unrelated render does not move focus to the card");
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

/** A dock beside a composer, under the transcript's follow-tail state (#2195). */
function ReadingBackHarness({ pending, state }: { pending: PendingApproval | null; state: FollowTailState }) {
  return (
    <>
      <RequestDock session={sessionWith(pending)} requests={dockRequests(prioritizedPendingRequests(pending))} runnerOnline
        followTailState={state} />
      <textarea aria-label="Composer" />
    </>
  );
}

/** Whether the dock shows its card: behind the strip it stays mounted, hidden. */
const cardShown = (view: { container: HTMLElement }) => {
  const card = view.container.querySelector<HTMLElement>(".request-dock-card");
  return card !== null && !card.hidden && card.querySelector(".request-card") !== null;
};

test("reading back shrinks the dock to a strip with the title, its position and Expand; the tail restores it without moving focus", async () => {
  const pending = permission();
  const view = await render(<ReadingBackHarness pending={pending} state="following" />);
  const strip = () => view.container.querySelector<HTMLElement>(".dock-strip");
  try {
    assert.ok(cardShown(view), "the card while following");
    assertNoDomNode(strip());
    const composer = view.container.querySelector("textarea")!;
    await act(async () => { composer.focus(); });
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assert.equal(cardShown(view), false, "the strip takes the card's place");
    assert.equal(view.container.querySelectorAll("[data-session-request-id]").length, 1, "the strip is the request's one region");
    assert.ok(strip()?.hasAttribute("data-session-request-id"));
    assert.equal(strip()?.querySelector(".dock-strip-title")?.textContent, "Run pnpm deploy?");
    assert.equal(strip()?.querySelector(".dock-strip-position")?.textContent, "1 of 1");
    const expand = strip()!.querySelector<HTMLButtonElement>("button")!;
    assert.equal(expand.getAttribute("aria-label"), "Expand Request");
    assert.equal(expand.textContent, "Expand");
    assert.equal(view.container.querySelector(".request-dock")?.getAttribute("aria-label"), "Pending Requests");
    // Inbox paging's programmatic scroll is not reading back.
    await view.rerender(<ReadingBackHarness pending={pending} state="previewing" />);
    assert.ok(cardShown(view));
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assert.ok(strip());
    await view.rerender(<ReadingBackHarness pending={pending} state="following" />);
    assert.equal(view.container.querySelector(".request-card h3")?.textContent, "Run pnpm deploy?");
    assertNoDomNode(strip());
    assert.equal(domWindow.document.activeElement, composer, "returning to the tail leaves focus where it was");
  } finally {
    await view.unmount();
  }
});

test("activating the strip restores the card and focuses its heading; it stays expanded until the tail", async () => {
  const pending = permission();
  const view = await render(<ReadingBackHarness pending={pending} state="paused" />);
  try {
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".dock-strip-expand")!.click(); });
    const heading = view.container.querySelector(".request-card h3");
    assert.equal(heading?.textContent, "Run pnpm deploy?");
    assert.equal(domWindow.document.activeElement, heading);
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assert.ok(cardShown(view), "still reading back, the expanded card stays");
    await view.rerender(<ReadingBackHarness pending={pending} state="following" />);
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assert.ok(view.container.querySelector(".dock-strip"), "the next reading back shrinks it again");
    // The strip's whole row is the pointer target, not only Expand.
    await act(async () => { view.container.querySelector<HTMLElement>(".dock-strip-title")!.click(); });
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".request-card h3"));
  } finally {
    await view.unmount();
  }
});

test("A and D do nothing while the strip shows, and decide the request once it is expanded", async () => {
  const decisions: unknown[] = [];
  const pending = permission();
  const view = await render(<ReadingBackHarness pending={pending} state="paused" />, {
    approve: async (_id, body) => { decisions.push(body); return sessionWith(null); },
  });
  try {
    await act(async () => {
      assert.equal(decideDockedRequest("session-dock", "approve"), true, "the strip takes A, so no other request gets it");
      assert.equal(decideDockedRequest("session-dock", "deny"), true);
      await tick();
    });
    assert.deepEqual(decisions, [], "nothing is decided while the request cannot be read");
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".dock-strip-expand")!.click(); });
    await act(async () => { assert.equal(decideDockedRequest("session-dock", "approve"), true); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "permission-deploy", optionId: "allow" }]);
  } finally {
    await view.unmount();
  }
});

test("a request arriving while collapsed updates the strip's count, or its title when it outranks, and is announced once", async () => {
  const announcement = (view: { container: HTMLElement }) =>
    view.container.querySelector("[data-request-dock-announcement]")?.textContent;
  const lower = await render(<ReadingBackHarness pending={signIn()} state="paused" />);
  try {
    assert.equal(lower.container.querySelector("[data-request-dock-announcement]")?.getAttribute("role"), "status");
    assert.equal(announcement(lower), "", "nothing to announce for the request already there");
    await lower.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [permission()] }} state="paused" />);
    assert.equal(lower.container.querySelector(".dock-strip-title")?.textContent, "Sign In to Claude Code");
    assert.equal(lower.container.querySelector(".dock-strip-position")?.textContent, "1 of 2");
    assert.equal(announcement(lower), "Approval Required: Run pnpm deploy?");
    const region = lower.container.querySelector("[data-request-dock-announcement]")!;
    let changes = 0;
    const observer = new domWindow.MutationObserver(() => { changes += 1; });
    observer.observe(region as never, { childList: true, characterData: true, subtree: true });
    await lower.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [permission()] }} state="paused" />);
    observer.disconnect();
    assert.equal(changes, 0, "a later render does not announce it again");
    await lower.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [permission()] }} state="following" />);
    assert.equal(announcement(lower), "", "the expanded card speaks for itself");
  } finally {
    await lower.unmount();
  }
  const higher = await render(<ReadingBackHarness pending={permission()} state="paused" />);
  try {
    await higher.rerender(<ReadingBackHarness pending={{ ...permission(), additionalRequests: [signIn()] }} state="paused" />);
    assert.ok(higher.container.querySelector(".dock-strip"), "the strip never hides");
    assert.equal(higher.container.querySelector(".dock-strip-title")?.textContent, "Sign In to Claude Code");
    assert.equal(higher.container.querySelector(".dock-strip-position")?.textContent, "1 of 2");
    assert.equal(announcement(higher), "Authentication Required: Sign In to Claude Code");
  } finally {
    await higher.unmount();
  }
});

test("a repeated announcement is spoken again, and a new occurrence under the same request id is an arrival", async () => {
  const region = (view: { container: HTMLElement }) => view.container.querySelector("[data-request-dock-announcement]")!;
  const watch = (view: { container: HTMLElement }) => {
    const changes: number[] = [];
    const observer = new domWindow.MutationObserver((records) => { changes.push(records.length); });
    observer.observe(region(view) as never, { childList: true, characterData: true, subtree: true });
    return { changes, stop: () => observer.disconnect() };
  };
  // Two permissions with the same words: the first arrives and goes, the second arrives.
  const twin = (requestId: string): PendingApproval => ({ ...permission(), requestId });
  const view = await render(<ReadingBackHarness pending={signIn()} state="paused" />);
  try {
    await view.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [twin("first")] }} state="paused" />);
    assert.equal(region(view).textContent, "Approval Required: Run pnpm deploy?");
    await view.rerender(<ReadingBackHarness pending={signIn()} state="paused" />);
    const watched = watch(view);
    await view.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [twin("second")] }} state="paused" />);
    watched.stop();
    assert.equal(region(view).textContent, "Approval Required: Run pnpm deploy?");
    assert.ok(watched.changes.length > 0, "the same words for a different request still change the live region");
  } finally {
    await view.unmount();
  }

  // The provider asks again under the same request id: a new occurrence, with new words.
  const asked = (occurrenceId: string, title: string): PendingApproval => ({ ...permission(), occurrenceId, title });
  const again = await render(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [asked("one", "Run pnpm deploy?")] }}
    state="paused" />);
  try {
    assert.equal(region(again).textContent, "");
    await again.rerender(<ReadingBackHarness pending={{ ...signIn(), additionalRequests: [asked("two", "Run pnpm deploy --force?")] }}
      state="paused" />);
    assert.equal(region(again).textContent, "Approval Required: Run pnpm deploy --force?");
  } finally {
    await again.unmount();
  }
});

test("a card that shrinks under focus hands it to Expand, and a control elsewhere asking for the request restores it", async () => {
  const pending = { ...permission(), additionalRequests: [signIn()] };
  const view = await render(<ReadingBackHarness pending={pending} state="following" />);
  try {
    const reject = [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot button")]
      .find((button) => button.textContent === "Dismiss Recovery")!;
    await act(async () => { reject.focus(); });
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".dock-strip-expand"),
      "focus stays in the dock rather than falling to the page");
    await act(async () => { assert.equal(revealDockedRequest("session-dock", "permission-deploy"), true); });
    const heading = view.container.querySelector(".request-card h3");
    assert.equal(heading?.textContent, "Run pnpm deploy?");
    assert.equal(domWindow.document.activeElement, heading);
  } finally {
    await view.unmount();
  }
});

test("the notice slot's +N More menu in the card's head closes as the strip takes the card's place, with focus on Expand", async () => {
  const pending = permission();
  const entry = (key: string, title: string) =>
    ({ key, severity: "info" as const, rank: 8, title, render: ({ trailing }: { trailing: React.ReactNode }) => <div>{trailing}</div> });
  const skills = entry("skills", "Skills Unavailable");
  const setup = entry("setup", "Set Up This Project");
  // A transcript scroller whose room below the reading position the test sets: no room holds the strip
  // back while paused, and a scroll into room lets it take over.
  const scroller = domWindow.document.createElement("div") as unknown as HTMLElement;
  let room = -1_000;
  const metrics: Record<string, () => number> = { scrollHeight: () => room, scrollTop: () => 0, clientHeight: () => 0 };
  for (const [name, value] of Object.entries(metrics)) {
    Object.defineProperty(scroller, name, { configurable: true, get: value });
  }
  const readerRef = { current: scroller };
  function SlotHarness({ state, entries = [skills], reader }: {
    state: FollowTailState;
    entries?: ReturnType<typeof entry>[];
    reader?: typeof readerRef;
  }) {
    const session = sessionWith(pending);
    const requests = dockRequests(prioritizedPendingRequests(pending));
    return (
      <SessionNoticeSlot
        sessionId={session.id}
        entries={entries}
        lead={{
          key: "request-dock",
          title: "Pending Request",
          icon: null,
          requestIds: requests.map((request) => request.requestId),
          render: ({ trailing, concealTrailing }) => (
            <RequestDock session={session} requests={requests} runnerOnline headTrailing={trailing}
              followTailState={state} onConceal={concealTrailing} readerRef={reader} />
          ),
        }}
      />
    );
  }
  const view = await render(<SlotHarness state="following" />);
  try {
    const more = view.container.querySelector<HTMLButtonElement>(".request-card .session-notice-more")!;
    assert.equal(more.textContent, "+1 More");
    await act(async () => { more.focus(); more.click(); });
    const item = body().querySelector<HTMLElement>('[role="menuitem"]')!;
    assert.equal(item.textContent, "Skills Unavailable");
    await act(async () => { item.focus(); });
    await view.rerender(<SlotHarness state="paused" />);
    assert.ok(view.container.querySelector(".dock-strip"));
    assertNoDomNode(body().querySelector('[role="menu"]'), "no notice menu is left open over the strip");
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".dock-strip-expand"));
  } finally {
    await view.unmount();
  }

  // The focused notice resolves in the same update a scroll lets the strip take over: its item is gone
  // before the dock looks, and focus still lands on Expand rather than on the page.
  const both = await render(<SlotHarness state="paused" entries={[skills, setup]} reader={readerRef} />);
  try {
    assert.ok(cardShown(both), "paused with no room below: the card stays");
    const more = both.container.querySelector<HTMLButtonElement>(".request-card .session-notice-more")!;
    await act(async () => { more.focus(); more.click(); });
    const item = [...body().querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) =>
      candidate.textContent === "Skills Unavailable")!;
    await act(async () => { item.focus(); });
    await both.rerender(<SlotHarness state="paused" entries={[skills, setup]} reader={readerRef} />);
    await act(async () => {
      room = 1_000;
      scroller.dispatchEvent(new domWindow.Event("scroll") as unknown as Event);
      both.rerenderSync(<SlotHarness state="paused" entries={[setup]} reader={readerRef} />);
    });
    assert.ok(both.container.querySelector(".dock-strip"));
    assertNoDomNode(body().querySelector('[role="menu"]'));
    assert.equal(domWindow.document.activeElement, both.container.querySelector(".dock-strip-expand"));
  } finally {
    await both.unmount();
  }
});

test("the card behind the strip is the same card when it comes back, and its open menu closes with focus on Expand", async () => {
  const pending = permission();
  const view = await render(<ReadingBackHarness pending={pending} state="following" />);
  try {
    const card = view.container.querySelector(".request-card");
    const more = view.container.querySelector<HTMLButtonElement>('[aria-label="More Choices"]')!;
    await act(async () => { more.focus(); more.click(); });
    const item = body().querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => { item.focus(); });
    await view.rerender(<ReadingBackHarness pending={pending} state="paused" />);
    assertNoDomNode(body().querySelector('[role="menuitem"]'), "no menu is left open over the strip");
    assert.equal(domWindow.document.activeElement, view.container.querySelector(".dock-strip-expand"));
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".dock-strip-expand")!.click(); });
    assert.equal(view.container.querySelector(".request-card"), card,
      "not remounted, so what was in progress on it (a sign-in code, an evidence review) is kept");
  } finally {
    await view.unmount();
  }
});
