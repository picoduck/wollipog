import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { Board } from "./Board.js";
import { sessionAgentLabel } from "./agent-options.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * One Board card anatomy (#2222): one status, "Agent · Project", a two-line title, a plain one-line
 * preview that gives way to a request, Approve and Deny by option kind, one Sign In menu button, and
 * the family chip named by its whole rollup.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// happy-dom lays nothing out; each column's virtual list needs a viewport to mount its cards into.
const VIEWPORT_HEIGHT = 2_000;
const CARD_HEIGHT = 120;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: Element) {
    const height = this.classList?.contains("column-body") ? VIEWPORT_HEIGHT : CARD_HEIGHT;
    return { x: 0, y: 0, top: 0, left: 0, right: 280, bottom: height, width: 280, height, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", CARD_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}

const runner =(runnerId: string, displayName: string): RunnerView => ({
  runnerId,
  hostname: runnerId,
  displayName,
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true }],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repo" }],
  connectedAt: 1,
  lastSeen: 1,
});

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    driver: "codex-app-server",
    title: `Session ${id}`,
    status: "idle",
    column: "review",
    archived: false,
    createdAt: 1,
    updatedAt: 10,
    lastEventAt: 10,
    messageCount: 1,
    preview: `Preview for ${id}`,
    pendingApproval: null,
    ...overrides,
  } as SessionView;
}

/** The kinds of card the Board draws, each with the markdown a raw preview would carry. */
const SESSIONS: SessionView[] = [
  session("idle", {
    title: "Idle session whose title is long enough that it would run onto a third line in a narrow column",
    preview: "(27/27)\n- [ ] Visual review… [design tokens doc](https://example.com/tokens) **done**",
  }),
  session("running", { status: "running", column: "running", preview: "## Summary\n\n- Ran `npm test`\n- 3 files changed" }),
  session("approval", {
    status: "input_required",
    column: "input_required",
    pendingApproval: {
      requestId: "req-approval",
      kind: "permission",
      title: "Run **npm test**",
      context: { toolName: "Bash", input: "\nnpm test -- --watch=false\nsecond line" },
      options: [
        { optionId: "always", name: "Always Allow", kind: "allow_always" },
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "other", name: "Explain" },
      ],
    },
  }),
  session("deny-only", {
    status: "input_required",
    column: "input_required",
    pendingApproval: {
      requestId: "req-deny-only",
      kind: "permission",
      title: "Stop the run?",
      options: [{ optionId: "stop", name: "Stop", kind: "deny" }],
    },
  }),
  session("question", {
    status: "input_required",
    column: "input_required",
    pendingApproval: {
      requestId: "req-question",
      kind: "question",
      title: "Which approach should I take?",
      options: [],
      questions: [],
    },
  }),
  session("sign-in", {
    status: "input_required",
    column: "input_required",
    agentName: "OpenCode",
    pendingApproval: {
      requestId: "req-sign-in",
      kind: "authentication",
      title: "OpenCode needs you to sign in.",
      options: [
        { optionId: "auth_1_method_1", name: "OpenCode Zen", description: "Sign in at opencode.ai in a browser.", kind: "allow_once" },
        { optionId: "auth_1_method_2", name: "GitHub Copilot", description: "Use a GitHub Copilot subscription.", kind: "allow_once" },
        { optionId: "auth_1_cancel", name: "Cancel sign-in", kind: "reject_once" },
      ],
    },
  }),
  session("parent", { status: "running", column: "running", title: "Ship the usage and cost overhaul" }),
  session("child-a", { parentSessionId: "parent", status: "running", column: "running" }),
  // In a column of its own: the stub layout mounts at most four cards per column.
  session("child-b", { parentSessionId: "parent", status: "input_required", column: "done" }),
];

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "board" }), push() {}, listen: () => () => {} };

function Harness({ onSessionMenu }: { onSessionMenu: (sessionId: string) => void }) {
  const all = useStoreSelector((s) => s.sessions);
  const scoped = React.useMemo(() => [...all.values()], [all]);
  return <Board sessions={scoped} searchActive={false} onShowAll={() => {}} onNewSession={() => {}} onSessionMenu={onSessionMenu} />;
}

let sequence = 0;
async function mount({ runners = [runner("runner-1", "Studio")], sessions = SESSIONS } = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const approvals: Array<{ sessionId: string; requestId: string; optionId: string | null }> = [];
  const menus: string[] = [];
  const opened: string[] = [];
  const client = {
    ...api,
    approve: async (sessionId: string, body: { requestId: string; optionId: string | null }) => {
      approvals.push({ sessionId, ...body });
      return sessions.find((candidate) => candidate.id === sessionId)!;
    },
  } as unknown as ApiClient;
  const connection: UiConnectionRuntime = {
    instanceId: `board-cards-${sequence}`,
    runtimeKey: `board-cards-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={{ ...navigation, push: (view) => {
          if (view.name === "session") opened.push(view.id);
        } }}>
          <Harness onSessionMenu={(sessionId) => menus.push(sessionId)} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
      runners, boxes: [], sessions, runs: [], pods: [],
    });
  });
  const card = (id: string) => {
    const found = domWindow.document.querySelector(`.board .card[data-session-id="${id}"]`) as unknown as HTMLElement | null;
    assert.ok(found, `the ${id} card renders`);
    return found;
  };
  return {
    approvals,
    menus,
    opened,
    card,
    cards: () => [...domWindow.document.querySelectorAll(".board .card")] as unknown as HTMLElement[],
    unmount: () => act(async () => { root.unmount(); mountPoint.remove(); }),
  };
}

const EMOJI = /\p{Extended_Pictographic}/u;
const MARKDOWN = /\]\(|\[ \]|\*\*|`|^#|\n#|- \[/u;

test("no card renders markdown, a tag, an emoji or more than one status badge", async () => {
  const board = await mount();
  try {
    const cards = board.cards();
    assert.deepEqual(cards.map((card) => card.dataset["sessionId"]).sort(), SESSIONS.map((candidate) => candidate.id).sort());
    for (const card of cards) {
      const id = card.dataset["sessionId"];
      const text = card.textContent ?? "";
      assert.doesNotMatch(text, MARKDOWN, `${id} renders no markdown syntax`);
      assert.doesNotMatch(text, EMOJI, `${id} renders no emoji`);
      assertNoDomNode(card.querySelector(".tag, .tag-machine, .tag-agent, .tag-wt, .tag-run"), `${id} renders no tag`);
      assert.ok(card.querySelectorAll(".status").length <= 1, `${id} renders at most one status badge`);
      assert.equal(card.tagName, "ARTICLE");
    }
    assert.equal(board.card("idle").querySelector(".card-preview")?.textContent,
      "(27/27) Visual review… design tokens doc done", "the preview is plain text");
    assertNoDomNode(board.card("idle").querySelector(".status"), "an idle card shows no badge");
    assert.equal(board.card("running").querySelectorAll(".status").length, 1);
  } finally {
    await board.unmount();
  }
});

test("a returned result keeps one review badge and meaningful time despite newer chatter", async () => {
  const meaningfulAt = Date.now() - 15 * 60_000;
  const board = await mount({ sessions: [session("result", {
    lastEventAt: Date.now(),
    attention: { version: 1, meaningfulAt, humanActions: [],
      result: { revision: "returned-result", at: meaningfulAt, owner: "human" }, acknowledgedRevision: null },
  })] });
  try {
    const card = board.card("result");
    assert.deepEqual([...card.querySelectorAll(".status")].map((badge) => badge.textContent), ["Ready for Review"]);
    assert.equal(card.querySelector("time.card-time")?.getAttribute("datetime"), new Date(meaningfulAt).toISOString());
    assert.equal(card.querySelector("time.card-time")?.textContent, "15m ago");
    assert.equal(card.querySelector(".card-sender-text")?.textContent, "Codex App Server · Wollipog");
    assert.equal(card.querySelector(".card-preview")?.textContent, "Preview for result");
  } finally {
    await board.unmount();
  }
});

test("every card says Agent · Project, and a request replaces the preview", async () => {
  const board = await mount();
  try {
    for (const card of board.cards()) {
      const source = SESSIONS.find((candidate) => candidate.id === card.dataset["sessionId"])!;
      const agent = sessionAgentLabel(source.agentName, source.driver, source.agentId);
      assert.equal(card.querySelector(".card-sender-text")?.textContent, `${agent} · Wollipog`);
      const request = card.querySelector(".card-request");
      assert.equal(Boolean(card.querySelector(".card-preview")), !request,
        `${card.dataset["sessionId"]} shows the preview exactly when no request shows`);
      assert.equal(card.querySelectorAll(".card-open").length, 1, "one stretched open button");
    }
    // One machine: it is not repeated on every card.
    assertNoDomNode(domWindow.document.querySelector(".board .card-machine"));
  } finally {
    await board.unmount();
  }
});

test("with more than one machine, the machine follows the project as quiet meta", async () => {
  const board = await mount({ runners: [runner("runner-1", "Studio"), runner("runner-2", "Build Box")] });
  try {
    const machine = board.card("idle").querySelector(".card-machine");
    assert.equal(machine?.textContent, "Machine: Studio");
    assert.ok(machine?.querySelector("svg"), "after its 14px icon");
  } finally {
    await board.unmount();
  }
});

test("a permission request shows exactly Approve and Deny, which send the first allow and reject options", async () => {
  const board = await mount();
  try {
    const card = board.card("approval");
    assert.equal(card.querySelector(".card-request-text")?.textContent, "Run npm test");
    assert.equal(card.querySelector(".card-request-code")?.textContent, "npm test -- --watch=false", "the code line");
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".card-request button")];
    assert.deepEqual(buttons.map((button) => button.textContent), ["Approve", "Deny"]);
    // Focus follows what is on screen: the title, line 1's ⋯, then the request's buttons.
    assert.deepEqual([...card.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent),
      ["Session approval", "More Actions", "Approve", "Deny"]);
    assert.ok(card.querySelector(".card-request-notice.decision-pair.t-warning"), "a warning inset notice holding the equal pair");
    await act(async () => { buttons[0]!.click(); });
    await act(async () => { buttons[1]!.click(); });
    // The one-time allow, even though the agent listed Always Allow first.
    assert.deepEqual(board.approvals, [
      { sessionId: "approval", requestId: "req-approval", optionId: "once" },
      { sessionId: "approval", requestId: "req-approval", optionId: "reject" },
    ]);

    const denyOnly = [...board.card("deny-only").querySelectorAll<HTMLButtonElement>(".card-request button")];
    assert.deepEqual(denyOnly.map((button) => button.textContent), ["Deny"], "only the options it has, labeled by kind");
  } finally {
    await board.unmount();
  }
});

test("persistent-only permission requests explain their scope and open the session without approving", async () => {
  const persistent = session("persistent", {
    status: "input_required",
    column: "input_required",
    pendingApproval: {
      requestId: "req-persistent",
      kind: "permission",
      title: "Allow future test runs?",
      options: [
        { optionId: "always", name: "Always Allow", kind: "allow_always" },
        { optionId: "never", name: "Always Reject", kind: "reject_always" },
      ],
    },
  });
  const viewerReason = "Viewers cannot respond to requests.";
  for (const state of ["online", "offline", "viewer"] as const) {
    const board = await mount({
      sessions: [{ ...persistent, ...(state === "viewer" ? {
        commandPermissions: { respond: { allowed: false, reason: viewerReason } } as SessionView["commandPermissions"],
      } : {}) }],
      runners: [{ ...runner("runner-1", "Studio"), status: state === "offline" ? "offline" : "online" }],
    });
    try {
      const card = board.card("persistent");
      const buttons = [...card.querySelectorAll<HTMLButtonElement>(".card-request button")];
      assert.deepEqual(buttons.map((button) => button.textContent), ["Answer in Session"], state);
      assert.match(card.querySelector(".card-request")!.textContent!, /These choices apply to future requests\./u);
      assert.equal(buttons[0]!.disabled, false, "opening the session is available without response authority or an online runner");
      if (state === "viewer") assert.equal(card.querySelector(".approval-refusal")?.textContent, viewerReason);
      await act(async () => { buttons[0]!.click(); });
      assert.deepEqual(board.opened, ["persistent"], "the explicit answer action opens the correct session once");
      assert.deepEqual(board.approvals, [], "navigation never sends a persistent permission response");
    } finally {
      await board.unmount();
    }
  }
});

test("one-time decisions remain disabled offline and for viewers", async () => {
  const permission = SESSIONS.find((candidate) => candidate.id === "approval")!;
  const reason = "Viewers cannot respond to requests.";
  for (const viewer of [false, true]) {
    const board = await mount({
      sessions: [{ ...permission, ...(viewer ? {
        commandPermissions: { respond: { allowed: false, reason } } as SessionView["commandPermissions"],
      } : {}) }],
      runners: [{ ...runner("runner-1", "Studio"), status: viewer ? "online" : "offline" }],
    });
    try {
      const card = board.card("approval");
      const buttons = [...card.querySelectorAll<HTMLButtonElement>(".card-request button")];
      assert.deepEqual(buttons.map((button) => button.textContent), ["Approve", "Deny"]);
      assert.ok(buttons.every((button) => button.disabled));
      if (viewer) {
        const refusal = card.querySelector(".approval-refusal")!;
        assert.equal(refusal.textContent, reason);
        assert.ok(buttons.every((button) => button.getAttribute("aria-describedby") === refusal.id));
      }
      await act(async () => { for (const button of buttons) button.click(); });
      assert.deepEqual(board.approvals, []);
      assert.deepEqual(board.opened, []);
    } finally {
      await board.unmount();
    }
  }
});

test("a question offers Answer in Session and no decisions", async () => {
  const board = await mount();
  try {
    const card = board.card("question");
    assert.equal(card.querySelector(".card-request-text")?.textContent, "Which approach should I take?");
    assert.deepEqual([...card.querySelectorAll(".card-request button")].map((button) => button.textContent), ["Answer in Session"]);
  } finally {
    await board.unmount();
  }
});

test("a sign-in card has one Sign In menu button: methods with descriptions, then Cancel Sign-In last", async () => {
  const board = await mount();
  try {
    const card = board.card("sign-in");
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".card-request button")];
    assert.deepEqual(buttons.map((button) => button.textContent), ["Sign In"]);
    assert.equal(buttons[0]!.getAttribute("aria-haspopup"), "menu");
    await act(async () => { buttons[0]!.click(); });
    const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
    assert.ok(menu, "the Sign In menu opens");
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.querySelector(".menu-text")?.textContent),
      ["OpenCode Zen", "GitHub Copilot", "Cancel Sign-In"]);
    assert.deepEqual(items.map((item) => item.querySelector(".menu-desc")?.textContent ?? null),
      ["Sign in at opencode.ai in a browser.", "Use a GitHub Copilot subscription.", null]);
    assert.ok(items.at(-1)!.classList.contains("danger"), "Cancel Sign-In is in the danger style");
    await act(async () => { items[1]!.click(); });
    assert.deepEqual(board.approvals, [{ sessionId: "sign-in", requestId: "req-sign-in", optionId: "auth_1_method_2" }]);
    assertNoDomNode(domWindow.document.querySelector('[role="menu"]'), "choosing a method closes the menu");
  } finally {
    await board.unmount();
  }
});

test("the family chip after the badge is an image named by the whole rollup at every width", async () => {
  const board = await mount();
  try {
    const status = board.card("parent").querySelector(".card-status")!;
    const chip = status.querySelector(".inbox-thread-family")!;
    assert.ok(chip, "the parent shows its family chip");
    assert.equal(chip.getAttribute("role"), "img");
    assert.equal(chip.getAttribute("aria-label"), "2 Children · 1 Awaiting Input");
    assert.equal(chip.querySelector(".inbox-thread-family-text")?.getAttribute("aria-hidden"), "true",
      "the visible rollup, which a narrow list hides, stays out of the accessible tree");
    const order = [...status.children].map((child) => child.className);
    assert.ok(order.indexOf("row-status") < order.findIndex((name) => name.includes("inbox-thread-family")),
      "the chip follows the badge");
    // A running parent shows the chip in place of the strip; a running card without children keeps its strip.
    assertNoDomNode(status.querySelector(".activity-strip"), "a parent card shows the chip, not the strip");
    assert.ok(board.card("running").querySelector(".card-status .activity-strip"), "a running card shows its strip");
    assert.equal(chip.getAttribute("title"), "2 Children · 1 Awaiting Input", "and a tooltip with the whole rollup");
  } finally {
    await board.unmount();
  }
});

test("a card's ⋯ opens the session's shared context menu", async () => {
  const board = await mount();
  try {
    const more = board.card("idle").querySelector<HTMLButtonElement>(".card-more")!;
    assert.equal(more.getAttribute("aria-label"), "More Actions");
    assert.equal(more.getAttribute("aria-haspopup"), "menu");
    await act(async () => { more.click(); });
    assert.deepEqual(board.menus, ["idle"]);
  } finally {
    await board.unmount();
  }
});
