import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AddPodMemberRequest,
  PodOrchestrationState,
  PodView,
  RunnerView,
  SessionEvent,
  SessionEventsResponse,
  SessionView,
  UiSnapshotMessage,
  UpdatePodMemberRequest,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PodDetail } from "./PodsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { ViewerIdentityContext, type ViewerIdentity } from "../resolver-identity.js";

/**
 * A pod member's menu and dialogs (#2983): the one-line head, ⋯ with Open Session, Share Latest
 * Answer, Member Settings… and Remove from Pod…, Member Settings, the removal confirmation, Add
 * Member… with #2982's eligible-session list, and the same actions from a phone's member bar.
 */
const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node, Event: domWindow.Event, InputEvent: domWindow.InputEvent, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, FocusEvent: domWindow.FocusEvent, MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-pods", hostname: "runner-host", displayName: "Studio Mac", os: "linux", version: "1", status: "online",
  agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as RunnerView;

function session(id: string, title: string, agentName: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: runner.runnerId, workspaceId: "workspace", workspaceName: "Wollipog", projectId: null,
    agentId: agentName.toLowerCase(), agentName, title, status: "idle", column: "review",
    runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "claude-code", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...patch,
  } as SessionView;
}

const MEMBERS = [
  session("lead", "Lead: plan the migration", "Claude"),
  session("worker", "Worker: migrate call sites", "Codex"),
  session("reviewer", "Reviewer: check the sites", "Gemini"),
  session("worker-2", "Worker: update the tests", "OpenCode"),
];

/** Sessions outside the pod: two that can join, and one of each kind that cannot. */
const OUTSIDERS = [
  session("free-1", "Draft the release notes", "Claude", { updatedAt: 5 }),
  session("free-2", "Fix the flaky upload test", "Codex", { updatedAt: 4 }),
  session("shared", "Edit in the main checkout", "Codex", { useWorktree: false, worktreePath: null }),
  session("ended", "An ended session", "Codex", { status: "failed" }),
  session("elsewhere", "In another pod", "Codex"),
];

const ROLES = ["lead", "worker", "reviewer", "worker"] as const;

function pod(memberIds: readonly string[] = MEMBERS.map((member) => member.id), state: Partial<PodOrchestrationState> = {}): PodView {
  return {
    id: "pod-1", title: "Migration Pod", objective: "Migrate call sites", status: "active", createdAt: 1, updatedAt: 1,
    members: memberIds.map((sessionId, index) => ({
      sessionId, joinedAt: 1, role: ROLES[index] ?? "worker", contextTokenBudget: index === 1 ? 8_192 : null, lastContextSeq: 0,
    })),
    orchestration: {
      policy: { mode: "manual", contextTokenBudget: 4_096, summaryTokenBudget: 512, maxTurns: 12, maxRepeatedOutputs: 2 },
      state: { status: "idle", turnsUsed: 0, updatedAt: 1, ...state },
    },
    reconciliations: [],
  };
}

const otherPod: PodView = {
  ...pod(["elsewhere", "free-9"]), id: "pod-2", title: "Other Pod",
};

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

const pending = () => new Promise<never>(() => {});
const soloViewer: ViewerIdentity = { userId: "local", shared: false, names: new Map() };
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
const body = () => domWindow.document.body as unknown as HTMLElement;

/** A member's history: one final answer, so its latest answer can be shared. */
const answered = (sessionId: string): SessionEventsResponse => {
  const events = [
    { id: 1, sessionId, seq: 1, ts: 1, payload: { kind: "user_message", text: "Go." } },
    { id: 2, sessionId, seq: 2, ts: 2, payload: { kind: "agent_message", text: "Done: 14 call sites migrated.", final: true } },
  ] as SessionEvent[];
  return { events, eventEpoch: 0, nextAfter: 2, cacheComplete: true } as SessionEventsResponse;
};

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

let sequence = 0;
async function mount({ pods = [pod()], sessions = [...MEMBERS, ...OUTSIDERS], client: overrides = {}, opening = { name: "pod", id: "pod-1" } }: {
  pods?: PodView[];
  sessions?: SessionView[];
  client?: Partial<ApiClient>;
  opening?: View;
} = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `pod-members-${sequence}`, runtimeKey: `pod-members-${sequence}:1`, createSocket: () => (socket = new FakeSocket()), close() {},
  };
  const client = {
    ...api,
    getSessionEventPage: pending,
    podContext: async () => ({ entries: [] }),
    ...overrides,
  } as unknown as ApiClient;
  const pushed: View[] = [];
  const newSessions: number[] = [];
  let current = opening;
  const navigation: ViewNavigation = {
    current: () => current,
    push(view) { current = view; pushed.push(view); },
    replace(view) { current = view; },
    listen: () => () => {},
  };
  function Route() {
    const view = useStoreSelector((state) => state.view);
    return view.name === "pod" ? <PodDetail podId={view.id} member={view.member} onNewSession={() => newSessions.push(1)} /> : null;
  }
  await act(async () => root.render(
    <React.StrictMode>
      <ApiProvider client={client}>
        <FeedbackProvider>
          <ViewerIdentityContext.Provider value={soloViewer}>
            <StoreProvider connection={connection} navigation={navigation}>
              <Route />
            </StoreProvider>
          </ViewerIdentityContext.Provider>
        </FeedbackProvider>
      </ApiProvider>
    </React.StrictMode>,
  ));
  const snapshot = (nextPods: PodView[]) => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], runs: [], pods: nextPods, sessions,
  });
  await act(async () => snapshot(pods));
  await settle();
  return {
    container,
    pushed,
    newSessions,
    snapshot: async (nextPods: PodView[]) => {
      await act(async () => snapshot(nextPods));
      await settle();
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const click = async (element: HTMLElement | null | undefined) => {
  assert.ok(element, "the control is rendered");
  await act(async () => element.click());
  await settle();
};
const buttonNamed = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;
const head = (agent: string) => {
  const found = [...body().querySelectorAll<HTMLElement>(".compare-member-head")]
    .find((candidate) => candidate.querySelector(".compare-member-agent")?.textContent === agent);
  assert.ok(found, `${agent}'s head`);
  return found;
};
async function openMemberMenu(agent: string) {
  await click(head(agent).querySelector<HTMLButtonElement>(`button[aria-label="${agent} Actions"]`));
  const menu = body().querySelector<HTMLElement>(`[role="menu"][aria-label="${agent} Actions"]`);
  assert.ok(menu, `${agent}'s ⋯ opens`);
  return menu;
}
async function openBarMenu() {
  await click(body().querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]'));
  const menu = body().querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]');
  assert.ok(menu, "the bar's ⋯ opens");
  return menu;
}
const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const itemNamed = (menu: HTMLElement, label: string) => {
  const found = menuItems(menu).find((item) => item.querySelector(".menu-text")?.textContent === label);
  assert.ok(found, `⋯ lists ${label}`);
  return found;
};
const reasonOf = (item: HTMLElement) => item.querySelector(".menu-desc")?.textContent ?? null;
const dialogNamed = (title: string) => [...body().querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
  .find((candidate) => candidate.querySelector("h2")?.textContent?.trim() === title) ?? null;
const closeMenu = (menu: HTMLElement) => act(async () => { fireDomEvent.keyDown(menu as never, { key: "Escape" }); });

test("each member head is one row: the agent over Role · task, its status and ⋯, with no select, checkbox or text button", async () => {
  const view = await mount();
  try {
    const heads = [...view.container.querySelectorAll<HTMLElement>(".compare-member-head")];
    assert.equal(heads.length, 4);
    assert.deepEqual(heads.map((candidate) => [
      candidate.querySelector(".compare-member-agent")?.textContent,
      candidate.querySelector(".compare-member-sub")?.textContent,
    ]), [
      ["Claude", "Lead · plan the migration"],
      ["Codex", "Worker · migrate call sites"],
      ["Gemini", "Reviewer · check the sites"],
      ["OpenCode", "Worker · update the tests"],
    ]);
    for (const candidate of heads) {
      assert.equal(candidate.querySelectorAll("select, input, textarea").length, 0, "no select, checkbox or field in a head");
      const buttons = [...candidate.querySelectorAll<HTMLButtonElement>("button")];
      assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label")), [`${candidate.querySelector(".compare-member-agent")?.textContent} Actions`],
        "⋯ is the head's only button");
      assert.ok(candidate.querySelector(".session-status-indicators"), "the status");
    }
    assertNoDomNode(view.container.querySelector(".pod-member-tools, .pod-member-setting, .pod-member-open"), "the old inline settings are gone");
  } finally {
    await view.unmount();
  }
});

test("⋯ lists Open Session, Share Latest Answer, Member Settings… and, after a separator, Remove from Pod…", async () => {
  const view = await mount();
  try {
    const menu = await openMemberMenu("Codex");
    assert.deepEqual(menuItems(menu).map((item) => item.querySelector(".menu-text")?.textContent),
      ["Open Session", "Share Latest Answer", "Member Settings…", "Remove from Pod…"]);
    const separator = menu.querySelector(".menu-sep");
    assert.ok(separator, "a separator");
    assert.ok(separator.nextElementSibling === itemNamed(menu, "Remove from Pod…"), "before the destructive item");
    assert.ok(itemNamed(menu, "Remove from Pod…").classList.contains("danger"));
    await click(itemNamed(menu, "Open Session"));
    assert.deepEqual(view.pushed.at(-1), { name: "session", id: "worker" });
  } finally {
    await view.unmount();
  }
});

test("Share Latest Answer is disabled with its reason while the member runs or has no answer, and shares the answer once it has one", async () => {
  const shared: unknown[] = [];
  const view = await mount({
    sessions: [MEMBERS[0]!, { ...MEMBERS[1]!, status: "running" }, MEMBERS[2]!, MEMBERS[3]!],
    client: {
      getSessionEventPage: (async (sessionId: string) => sessionId === "reviewer" ? answered(sessionId) : pending()) as never,
      appendPodContext: async (_id, request) => {
        shared.push(request);
        return { entry: { id: "entry-9", podId: "pod-1", seq: 9, ts: Date.now(), source: { kind: "human", actorId: "local" }, content: "Done." }, created: true, pod: pod() };
      },
    },
  });
  try {
    let menu = await openMemberMenu("Codex");
    let share = itemNamed(menu, "Share Latest Answer");
    assert.equal(share.disabled, true);
    assert.equal(reasonOf(share), "Available when Codex finishes its turn.");
    await closeMenu(menu);

    menu = await openMemberMenu("Claude");
    share = itemNamed(menu, "Share Latest Answer");
    assert.equal(share.disabled, true);
    assert.equal(reasonOf(share), "No answer yet.");
    await closeMenu(menu);

    menu = await openMemberMenu("Gemini");
    share = itemNamed(menu, "Share Latest Answer");
    assert.equal(share.disabled, false);
    await click(share);
    assert.deepEqual(shared, [{ kind: "member_output", sessionId: "reviewer" }]);
    assert.match([...body().querySelectorAll(".toast")].map((toast) => toast.textContent).join(" "), /Shared to the huddle\./u);
  } finally {
    await view.unmount();
  }
});

test("Member Settings saves the chosen role and budget with updatePodMember, and Same as Pod sends null", async () => {
  const updates: { sessionId: string; request: UpdatePodMemberRequest }[] = [];
  const view = await mount({
    client: {
      updatePodMember: async (_id, sessionId, request) => {
        updates.push({ sessionId, request });
        return { pod: pod(), sessions: [] };
      },
    },
  });
  try {
    await click(itemNamed(await openMemberMenu("Codex"), "Member Settings…"));
    let dialog = dialogNamed("Member Settings");
    assert.ok(dialog, "Member Settings opens");
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Codex · migrate call sites");
    const roles = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Role"] [role="radio"]')];
    assert.deepEqual(roles.map((role) => [role.textContent, role.getAttribute("aria-checked")]),
      [["Lead", "false"], ["Worker", "true"], ["Reviewer", "false"]]);
    const budget = dialog.querySelector<HTMLButtonElement>('[aria-label^="Context Budget:"]');
    assert.ok(budget, "Context Budget is a Select");
    assert.match(budget.getAttribute("aria-label") ?? "", /8,192 tokens/u, "it shows the member's own budget");
    await click(budget);
    assert.deepEqual([...body().querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent),
      ["Same as Pod", "4,096 tokens", "8,192 tokens", "16,384 tokens", "32,768 tokens"]);
    await click([...body().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "Same as Pod"));
    await click(roles[2]);
    await click(buttonNamed(dialog, "Save"));
    assert.deepEqual(updates, [{ sessionId: "worker", request: { role: "reviewer", contextTokenBudget: null } }]);
    assertNoDomNode(dialogNamed("Member Settings"), "Save closes it");

    await click(itemNamed(await openMemberMenu("Claude"), "Member Settings…"));
    dialog = dialogNamed("Member Settings")!;
    await click(dialog.querySelector<HTMLButtonElement>('[aria-label^="Context Budget:"]'));
    await click([...body().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "16,384 tokens"));
    await click(buttonNamed(dialog, "Save"));
    assert.deepEqual(updates[1], { sessionId: "lead", request: { role: "lead", contextTokenBudget: 16_384 } });
  } finally {
    await view.unmount();
  }
});

test("a refused save keeps Member Settings open with the reason above the footer", async () => {
  const view = await mount({ client: { updatePodMember: async () => { throw new Error("stop pod orchestration before changing roles or budgets"); } } });
  try {
    await click(itemNamed(await openMemberMenu("Codex"), "Member Settings…"));
    const dialog = dialogNamed("Member Settings")!;
    await click([...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((role) => role.textContent === "Lead"));
    await click(buttonNamed(dialog, "Save"));
    assert.ok(dialogNamed("Member Settings"), "it stays open");
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? "", /The member's settings weren't saved\./u);
  } finally {
    await view.unmount();
  }
});

test("a member that leaves closes its Member Settings, and rejoining does not reopen them", async () => {
  const view = await mount();
  try {
    await click(itemNamed(await openMemberMenu("Codex"), "Member Settings…"));
    assert.ok(dialogNamed("Member Settings"), "Member Settings opens");
    await view.snapshot([pod(["lead", "reviewer", "worker-2"])]);
    assertNoDomNode(dialogNamed("Member Settings"), "it closes with the member");
    await view.snapshot([pod()]);
    assertNoDomNode(dialogNamed("Member Settings"), "rejoining does not reopen it");
  } finally {
    await view.unmount();
  }
});

test("while automatic turns or a merge run, Member Settings…, Remove from Pod… and Add Member… are disabled with the reason", async () => {
  const view = await mount({ pods: [pod(undefined, { status: "running", runId: "run-1", turnsUsed: 1 })] });
  try {
    const menu = await openMemberMenu("Codex");
    for (const label of ["Member Settings…", "Remove from Pod…"]) {
      assert.equal(itemNamed(menu, label).disabled, true, label);
      assert.equal(reasonOf(itemNamed(menu, label)), "Stop automatic turns to change members.", label);
    }
    await closeMenu(menu);
    const add = buttonNamed(body().querySelector(".detail-bar")!, "Add Member…");
    assert.equal(add?.disabled, true);
    assert.equal(add?.title, "Stop automatic turns to change members.");

    await view.snapshot([{ ...pod(), reconciliations: [{
      reconciliationId: "merge-1", podId: "pod-1", sourceSessionId: "worker", targetSessionId: "lead", actorId: "local",
      status: "running", sourceHead: "a", targetHead: "b", createdAt: 1,
    }] }]);
    const merging = await openMemberMenu("Codex");
    assert.equal(reasonOf(itemNamed(merging, "Member Settings…")), "Available when the merge finishes.");
  } finally {
    await view.unmount();
  }
});

test("Remove from Pod confirms, naming the agent and the pod, then removes the member", async () => {
  const removed: string[] = [];
  const view = await mount({
    client: {
      removePodMember: async (_id, sessionId) => {
        removed.push(sessionId);
        return { pod: pod(), sessions: [] };
      },
    },
  });
  try {
    await click(itemNamed(await openMemberMenu("Codex"), "Remove from Pod…"));
    const confirmation = dialogNamed("Remove from Pod");
    assert.ok(confirmation, "the confirmation opens");
    assert.match(confirmation.textContent ?? "", /Codex leaves “Migration Pod”\. Its session keeps running, and the huddle keeps its notes\./u);
    assertNoDomNode(confirmation.querySelector('button[aria-label="Back to More Actions"]'), "desktop stacks, with no Back");
    assert.deepEqual(removed, [], "nothing happens before confirming");
    await click(buttonNamed(confirmation, "Remove from Pod"));
    assert.deepEqual(removed, ["worker"]);
  } finally {
    await view.unmount();
  }
});

test("at two members Remove from Pod… is disabled with its reason", async () => {
  const view = await mount({ pods: [pod(["lead", "worker"])] });
  try {
    const item = itemNamed(await openMemberMenu("Codex"), "Remove from Pod…");
    assert.equal(item.disabled, true);
    assert.equal(reasonOf(item), "A pod needs at least two members.");
  } finally {
    await view.unmount();
  }
});

describe("Add Member… (#2983, reusing #2982's list)", () => {
  const rows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>(".choice-row")];
  const describeRows = (dialog: HTMLElement) => rows(dialog).map((row) => [
    row.querySelector(".choice-row-title")?.textContent,
    row.querySelector(".choice-row-desc")?.textContent,
  ]);
  const filter = (dialog: HTMLElement, value: string) =>
    act(async () => fireDomEvent.change(dialog.querySelector('input[aria-label="Filter Sessions"]')!, { target: { value } }));
  const check = (dialog: HTMLElement, title: string) =>
    click(rows(dialog).find((row) => row.querySelector(".choice-row-title")?.textContent === title)?.querySelector("input"));

  test("lists only eligible sessions by display name, filters by title and agent, and adds each one chosen", async () => {
    const added: AddPodMemberRequest[] = [];
    const view = await mount({
      pods: [pod(), otherPod],
      client: {
        addPodMember: async (_id, request) => {
          added.push(request);
          return { pod: pod(), sessions: [] };
        },
      },
    });
    try {
      await click(buttonNamed(body().querySelector(".detail-bar")!, "Add Member…"));
      const dialog = dialogNamed("Add Member");
      assert.ok(dialog, "Add Member opens");
      assert.deepEqual(describeRows(dialog), [
        ["Draft the release notes", "Claude · Wollipog · Studio Mac"],
        ["Fix the flaky upload test", "Codex · Wollipog · Studio Mac"],
      ], "members, shared checkouts, ended sessions and another pod's members are left out");
      assert.doesNotMatch(dialog.textContent ?? "", /runner-pods/u, "never a runner id");
      const primary = () => dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!;
      assert.equal(primary().textContent, "Add Members");
      assert.equal(primary().disabled, true);
      assert.equal(dialog.querySelector(".pod-member-reason")?.textContent, "Choose a session to add.");

      await filter(dialog, "flaky");
      assert.deepEqual(describeRows(dialog).map(([title]) => title), ["Fix the flaky upload test"], "by title");
      await filter(dialog, "claude");
      assert.deepEqual(describeRows(dialog).map(([title]) => title), ["Draft the release notes"], "by agent");
      await filter(dialog, "");

      await check(dialog, "Draft the release notes");
      assert.equal(primary().textContent, "Add 1 Member");
      await check(dialog, "Fix the flaky upload test");
      assert.equal(primary().textContent, "Add 2 Members");
      await click(primary());
      assert.deepEqual(added, [{ sessionId: "free-1" }, { sessionId: "free-2" }]);
      assertNoDomNode(dialogNamed("Add Member"), "it closes once every member is added");
      assert.match([...body().querySelectorAll(".toast")].map((toast) => toast.textContent).join(" "), /Added 2 members\./u);
    } finally {
      await view.unmount();
    }
  });

  test("a session that could not join stays chosen, with the reason", async () => {
    const view = await mount({
      client: {
        addPodMember: async (_id, request) => {
          if (request.sessionId === "free-2") throw new Error("session already belongs to pod 'p_x'");
          return { pod: pod(), sessions: [] };
        },
      },
    });
    try {
      await click(buttonNamed(body().querySelector(".detail-bar")!, "Add Member…"));
      const dialog = dialogNamed("Add Member")!;
      await check(dialog, "Draft the release notes");
      await check(dialog, "Fix the flaky upload test");
      await click(dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary"));
      assert.ok(dialogNamed("Add Member"), "it stays open");
      assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? "", /“Fix the flaky upload test” wasn't added\./u);
      const chosen = rows(dialog).filter((row) => row.querySelector<HTMLInputElement>("input")?.checked)
        .map((row) => row.querySelector(".choice-row-title")?.textContent);
      assert.deepEqual(chosen, ["Fix the flaky upload test"]);
    } finally {
      await view.unmount();
    }
  });

  test("with none eligible it says No Sessions Can Join and offers New Session…", async () => {
    const view = await mount({ sessions: MEMBERS });
    try {
      await click(buttonNamed(body().querySelector(".detail-bar")!, "Add Member…"));
      const dialog = dialogNamed("Add Member")!;
      assert.equal(dialog.querySelector(".state-title, h3")?.textContent, "No Sessions Can Join");
      assert.match(dialog.textContent ?? "", /Start a session with its own worktree to add it here\./u);
      assertNoDomNode(dialog.querySelector(".choice-row"), "no list");
      await click(buttonNamed(dialog, "New Session…"));
      assert.deepEqual(view.newSessions, [1]);
      assertNoDomNode(dialogNamed("Add Member"), "New Session takes its place");
    } finally {
      await view.unmount();
    }
  });
});

describe("a pod member on a phone (#2983)", () => {
  test("every member action is in the member bar's ⋯, Add Member… is in the bar's ⋯, and Remove from Pod replaces the sheet with Back", async () => {
    await setViewport(390, 844);
    const removed: string[] = [];
    const view = await mount({
      opening: { name: "pod", id: "pod-1", member: "worker" },
      client: { removePodMember: async (_id, sessionId) => { removed.push(sessionId); return { pod: pod(), sessions: [] }; } },
    });
    try {
      const bar = view.container.querySelector<HTMLElement>(".pod-phone .compare-member-head");
      assert.ok(bar, "the member bar");
      assert.equal(bar.lastElementChild?.classList.contains("overflow-menu"), true, "⋯ ends the member bar");
      assertNoDomNode(buttonNamed(body().querySelector(".detail-bar")!, "Add Member…"), "no Add Member… button in the app bar");
      const barMenu = await openBarMenu();
      assert.equal(menuItems(barMenu)[0]?.querySelector(".menu-text")?.textContent, "Add Member…");
      await closeMenu(barMenu);

      const menu = await openMemberMenu("Codex");
      assert.deepEqual(menuItems(menu).map((item) => item.querySelector(".menu-text")?.textContent),
        ["Open Session", "Share Latest Answer", "Member Settings…", "Remove from Pod…"]);
      await click(itemNamed(menu, "Remove from Pod…"));
      const confirmation = dialogNamed("Remove from Pod");
      assert.ok(confirmation, "the confirmation opens");
      assertNoDomNode(body().querySelector('[role="menu"][aria-label="Codex Actions"]'), "it replaced the sheet");
      const back = confirmation.querySelector<HTMLButtonElement>('button[aria-label="Back to More Actions"]');
      assert.ok(back, "with Back to More Actions");
      await click(back);
      assert.ok(body().querySelector('[role="menu"][aria-label="Codex Actions"]'), "Back brings the member's ⋯ back");
      assert.deepEqual(removed, [], "Back removes nothing");
    } finally {
      await view.unmount();
      await setViewport(1440, 900);
    }
  });
});
