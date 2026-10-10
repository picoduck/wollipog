import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ChildSessionRegistryPage, DescendantRequestView, GitStatusInfo, ReviewFindingSummary, SessionView } from "@wollipog/protocol";
import type { TimelineItem } from "../timeline.js";
import { RightPanel, useRightPanelState, type RightPanelState } from "./RightPanel.js";
import type { GitStatus } from "./useGitStatus.js";
import { HistoryIcon, MessageSquareIcon } from "./Icons.js";
import { StoreProvider } from "../store.js";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { clearPanelScratch } from "../right-panel-scratch.js";

/**
 * Session Tools (#2844): the side panel's landing list, as the panel renders it, with a stub API
 * whose findings summary and artifacts a test can change while the list stays open.
 */

const connection: UiConnectionRuntime = {
  instanceId: "session-tools-test", runtimeKey: "session-tools-test",
  createSocket: () => ({ readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null,
    onclose: null, onerror: null, send() {}, close() {} }),
  close() {},
};

let required = 0;
/** The durable child-session registry the Agents panel reads; null is a control plane without one. */
let registry: ChildSessionRegistryPage | null = null;
let findingReads = 0;
const summary = (): ReviewFindingSummary => ({
  total: required, unresolved: required, requiredUnresolved: required, sent: 0, resolved: 0, dismissed: 0,
  completion: required > 0 ? "blocked" : "complete",
});
const notHere = () => Promise.reject(new ApiError("This fixture has no control plane.", 404));
const client = {
  ...api,
  childSessions: () => registry ? Promise.resolve(registry) : notHere(),
  workflowInstances: notHere,
  reviewFindings: async () => {
    findingReads += 1;
    return { findings: [], summary: summary() };
  },
  sessionWorkflowArtifacts: async () => ({ artifacts: [] }),
} as ApiClient;

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
let coarsePointer = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    get matches() { return query === "(pointer: coarse)" ? coarsePointer : false; },
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
});
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  localStorage: domWindow.localStorage,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  ResizeObserver: domWindow.ResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]));

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

beforeEach(() => {
  domWindow.localStorage.clear();
  clearPanelScratch();
  coarsePointer = false;
  required = 0;
  findingReads = 0;
  registry = null;
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const session = {
  id: "session-tools-1",
  runnerId: "runner-1",
  driver: "claude-code",
  status: "running",
  adopted: false,
  eventEpoch: 1,
  worktreePath: "/home/me/.agent-worktrees/wollipog-fix",
} as SessionView;

/** A runner new enough for every panel capability. */
const CURRENT_RUNNER = 100_000;

const runningAgent: TimelineItem[] = [
  { kind: "tool_call", id: 1, toolCallId: "agent", title: "Audit Agent", text: "", toolKind: "agent", status: "in_progress", startedAt: 10 },
];

function gitWith(files: number, staged = 0, observation = 1): GitStatus {
  return {
    status: {
      branch: "fix", hasChanges: files > 0, ahead: 0, remoteUrl: null, stagedCount: staged,
      files: Array.from({ length: files }, (_, index) => ({ path: `src/file-${index}.ts`, status: "M" })),
    } as unknown as GitStatusInfo,
    observation,
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
}

function childRequest(id: string, title: string): DescendantRequestView {
  return {
    sessionId: `child-${id}`, sessionTitle: title, runnerId: "runner-1", runnerOnline: true, eventEpoch: 1,
    createdAt: 1, responseOwner: "human", occurrenceId: `occ-${id}`,
    request: { requestId: `req-${id}`, title: "Run deploy", kind: "permission" },
  } as DescendantRequestView;
}

interface HarnessProps {
  git: GitStatus;
  runnerProtocolVersion?: number | null;
  descendantRequests?: readonly DescendantRequestView[];
  items?: TimelineItem[];
  session?: SessionView;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function mount(initial: HarnessProps) {
  const happy = domWindow.document.createElement("div");
  domWindow.document.body.append(happy);
  const container = happy as unknown as HTMLDivElement;
  const root = createRoot(container);
  let state!: RightPanelState;
  let update!: (next: Partial<HarnessProps>) => void;
  function Harness() {
    const panel = useRightPanelState();
    const [props, setProps] = useState(initial);
    state = panel;
    update = (next) => setProps((current) => ({ ...current, ...next }));
    useEffect(() => { panel.show("launcher"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <ApiProvider client={client}><StoreProvider connection={connection}><RightPanel
        state={panel}
        session={props.session ?? session}
        runnerOnline
        runnerProtocolVersion={props.runnerProtocolVersion === undefined ? CURRENT_RUNNER : props.runnerProtocolVersion}
        git={props.git}
        items={props.items ?? []}
        descendantRequests={props.descendantRequests ?? []}
        descendantRequestStatus="ready"
        onOpenSourceLocation={() => {}}
        onClearSourceLocation={() => {}}
        onOpenTerminal={() => {}}
        onInsertSideChatDraft={() => {}}
      /></StoreProvider></ApiProvider>
    );
  }
  await act(async () => root.render(<Harness />));
  await settle();
  return {
    container,
    get state() { return state; },
    setProps: async (next: Partial<HarnessProps>) => {
      await act(async () => update(next));
      await settle();
    },
    dispose: async () => {
      await act(async () => root.unmount());
      happy.remove();
    },
  };
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`.session-tools [data-tool="${id}"]`);
const fact = (container: HTMLElement, id: string) => row(container, id)?.querySelector(".row-sub")?.textContent;
const description = (container: HTMLElement, button: HTMLElement) => (button.getAttribute("aria-describedby") ?? "")
  .split(" ").map((id) => container.querySelector(`[id="${id}"]`)?.textContent ?? "").join(" ").trim();

test("Session Tools lists the tools top to bottom under Code, Work and Decisions (#2844)", async () => {
  const panel = await mount({ git: gitWith(0) });
  try {
    const list = panel.container.querySelector<HTMLElement>(".session-tools")!;
    assert.ok(list, "the launcher renders the Session Tools list");
    assert.equal(list.firstElementChild?.querySelector(".group-label")?.textContent, "Code",
      "the list starts with its first group, with nothing above it on a current runner");
    assert.deepEqual([...list.querySelectorAll(".group-label")].map((label) => label.textContent), ["Code", "Work", "Decisions"]);
    assert.deepEqual([...list.querySelectorAll(".session-tool .row-title")].map((title) => title.textContent), [
      "Review", "Files", "Browser", "Terminal", "Agents", "Side Chat", "Background Work", "Requests", "Decision History",
    ]);
    // Every row is a two-line row with a fact, and the fact is its description.
    for (const button of list.querySelectorAll<HTMLElement>(".session-tool")) {
      assert.ok(button.classList.contains("row") && button.classList.contains("row-2"));
      const text = button.querySelector(".row-sub")?.textContent ?? "";
      assert.match(text, /^[A-Z]/, `${button.dataset.tool} has a sentence-case fact`);
      assert.equal(description(panel.container, button), text);
    }
    assert.equal(fact(panel.container, "review"), "No changes yet");
    assert.equal(fact(panel.container, "files"), "Browse wollipog-fix");
    assert.equal(fact(panel.container, "browser"), "Preview a web page");
    assert.equal(fact(panel.container, "terminal"), "Opens in the dock below the conversation");
    assert.equal(fact(panel.container, "sidechat"), "Ask a question without interrupting the agent");
    assert.equal(fact(panel.container, "decisions"), "No decisions recorded yet");
    await act(async () => row(panel.container, "review")!.click());
    assert.equal(panel.state.mode, "review");
  } finally {
    await panel.dispose();
  }
});

test("Review counts changes and required findings, and follows staging and a resolved finding while open (#2844)", async () => {
  required = 1;
  const panel = await mount({ git: gitWith(9) });
  try {
    assert.equal(fact(panel.container, "review"), "9 uncommitted changes, 1 required finding");
    const reads = findingReads;
    // Staging a file is a new status read; the finding resolved elsewhere shows on that read.
    required = 0;
    await panel.setProps({ git: gitWith(9, 1, 2) });
    assert.equal(fact(panel.container, "review"), "1 of 9 changes staged");
    assert.ok(findingReads > reads, "the findings summary is read again after the status read");
    assert.ok(row(panel.container, "review"), "the list stayed open throughout");
  } finally {
    await panel.dispose();
  }
});

test("Requests shows a count badge for what waits for you, and says when nothing does (#2844)", async () => {
  const panel = await mount({
    git: gitWith(0),
    descendantRequests: [childRequest("a", "Deploy"), childRequest("b", "Docs")],
  });
  try {
    const requests = row(panel.container, "requests")!;
    assert.equal(requests.querySelector(".count-badge")?.textContent, "2");
    assert.equal(fact(panel.container, "requests"), "An approval from Deploy, and an approval from Docs");
    await panel.setProps({ descendantRequests: [] });
    assertNoDomNode(requests.querySelector(".count-badge"), "no badge with nothing waiting");
    assert.equal(fact(panel.container, "requests"), "No requests are waiting for you");
  } finally {
    await panel.dispose();
  }
});

test("Agents shows one status badge for the most urgent worker state and counts the subagents (#2844)", async () => {
  const panel = await mount({ git: gitWith(0), items: runningAgent });
  try {
    const agents = row(panel.container, "subagents")!;
    assert.equal(fact(panel.container, "subagents"), "1 subagent in this session");
    assert.equal(agents.querySelectorAll(".status").length, 1, "one status badge");
    assert.match(agents.querySelector(".status")?.textContent ?? "", /^1 Working$/);
    assert.match(description(panel.container, agents), /1 Working 1 subagent in this session/);
  } finally {
    await panel.dispose();
  }
});

test("on an older runner Files and Terminal stay focusable with visible reasons, under one neutral notice (#2844)", async () => {
  const panel = await mount({ git: gitWith(0), runnerProtocolVersion: null });
  try {
    const list = panel.container.querySelector<HTMLElement>(".session-tools")!;
    const notices = list.querySelectorAll(".notice");
    assert.equal(notices.length, 1, "one notice explains the update");
    assert.equal(list.firstElementChild, notices[0], "the notice sits above the list");
    assert.ok(notices[0]!.classList.contains("t-neutral") || /neutral/.test(notices[0]!.className), "the notice is neutral");
    assert.match(notices[0]!.textContent ?? "", /runner-1 runs an older Wollipog\. Update it to browse files and open a terminal\./);
    for (const id of ["files", "terminal"]) {
      const button = row(panel.container, id)!;
      assert.equal(button.disabled, false, `${id} is not a disabled button`);
      assert.equal(button.getAttribute("aria-disabled"), "true");
      button.focus();
      assert.ok(domWindow.document.activeElement === (button as unknown as typeof domWindow.document.activeElement), `${id} takes focus`);
      const reason = button.querySelector(".row-sub")?.textContent ?? "";
      assert.equal(reason, id === "files" ? "Needs a newer runner to browse files" : "Needs a newer runner to open a terminal",
        `${id}'s reason is visible text`);
      assert.equal(description(panel.container, button), reason, `${id}'s reason is its accessible description`);
      assertNoDomNode(button.querySelector("kbd"), "an unavailable tool shows no keycap");
      await act(async () => button.click());
      assert.equal(panel.state.mode, "launcher", `${id} does not open`);
    }
    assert.deepEqual([...list.querySelectorAll("[title]")].map((node) => node.outerHTML), [],
      "nothing in the list relies on a tooltip for its reason");
    assertNoDomNode(panel.container.querySelector(".hint.warn"), "the old warning box is gone");
  } finally {
    await panel.dispose();
  }
});

test("keycaps show for a mouse and are absent on a coarse pointer (#2844)", async () => {
  const fine = await mount({ git: gitWith(0) });
  try {
    const keyed = [...fine.container.querySelectorAll<HTMLElement>(".session-tools .session-tool")]
      .filter((button) => button.querySelector("kbd")).map((button) => button.dataset.tool);
    assert.deepEqual(keyed, ["review", "files", "terminal"]);
  } finally {
    await fine.dispose();
  }
  coarsePointer = true;
  const coarse = await mount({ git: gitWith(0) });
  try {
    assertNoDomNode(coarse.container.querySelector(".session-tools kbd"), "no keycaps on a touch screen");
  } finally {
    await coarse.dispose();
  }
});

/** The `d` of every path an icon draws, which identifies its glyph. */
function glyph(node: Element | null | undefined): string {
  return [...(node?.querySelectorAll("path, circle, rect, line, polyline") ?? [])].map((shape) => shape.outerHTML.replace(/ (class|style)="[^"]*"/g, "")).join("");
}

async function reference(Icon: (props: { size?: number }) => React.ReactNode): Promise<string> {
  const happy = domWindow.document.createElement("div");
  const root = createRoot(happy as unknown as HTMLDivElement);
  await act(async () => root.render(<>{Icon({ size: 16 })}</>));
  const drawn = glyph(happy as unknown as Element);
  await act(async () => root.unmount());
  return drawn;
}

test("Side Chat and Decision History use their new icons in the list and the switcher (#2844)", async () => {
  const panel = await mount({ git: gitWith(0) });
  try {
    const messageSquare = await reference(MessageSquareIcon);
    const history = await reference(HistoryIcon);
    assert.ok(messageSquare && history && messageSquare !== history);
    assert.equal(glyph(row(panel.container, "sidechat")?.querySelector(".session-tool-tile svg")), messageSquare);
    assert.equal(glyph(row(panel.container, "decisions")?.querySelector(".session-tool-tile svg")), history);
    await act(async () => panel.container.querySelector<HTMLButtonElement>(".rpanel-switcher")!.click());
    const item = (name: string) => [...domWindow.document.querySelectorAll('[role="menuitemradio"]')]
      .find((candidate) => candidate.textContent?.includes(name)) as unknown as Element | undefined;
    assert.equal(glyph(item("Side Chat")?.querySelector("svg")), messageSquare);
    assert.equal(glyph(item("Decision History")?.querySelector("svg")), history);
  } finally {
    await panel.dispose();
  }
});

test("Agents counts the durable registry's subagents, as the Agents panel does, beyond the loaded transcript (#2844)", async () => {
  registry = {
    children: [{
      toolCallId: "durable-agent", name: "Audit Agent", status: "in_progress", lifecycle: "running",
      sourceSeq: 1, startedAt: 1, lastActivityAt: 2, toolCount: 3,
    }],
    attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 1, nextAfter: null, truncated: false,
  };
  // The transcript window holds no launch at all.
  const panel = await mount({ git: gitWith(0), items: [] });
  try {
    assert.equal(fact(panel.container, "subagents"), "1 subagent in this session");
    assert.match(row(panel.container, "subagents")?.querySelector(".status")?.textContent ?? "", /^1 Working$/);
    // A subagent launched after the registry was read, mid-turn, with no new git status read: the
    // transcript has it, and the list counts it at once.
    await panel.setProps({ items: runningAgent });
    assert.equal(fact(panel.container, "subagents"), "2 subagents in this session");
    assert.match(row(panel.container, "subagents")?.querySelector(".status")?.textContent ?? "", /^2 Working$/);
  } finally {
    await panel.dispose();
  }
});

test("Agents counts a subagent launched after an empty registry read (#2844)", async () => {
  registry = { children: [], attentionOwners: [], unidentifiedChildren: 0, eventEpoch: 1, nextAfter: null, truncated: false };
  const panel = await mount({ git: gitWith(0), items: [] });
  try {
    assert.equal(fact(panel.container, "subagents"), "No subagents in this session");
    await panel.setProps({ items: runningAgent });
    assert.equal(fact(panel.container, "subagents"), "1 subagent in this session");
    assert.match(row(panel.container, "subagents")?.querySelector(".status")?.textContent ?? "", /^1 Working$/);
  } finally {
    await panel.dispose();
  }
});

test("Background Work counts only jobs the Background Work panel shows as running (#2844)", async () => {
  const job = { id: "job-1", parentTurnId: "turn-1", launchType: "shell" as const, registeredAt: Date.now(), lastObservedAt: Date.now(), sourcePresent: true };
  const done = { ...job, id: "job-2", terminalStatus: "completed" as const };
  const panel = await mount({ git: gitWith(0), session: { ...session, backgroundJobs: [job, done], backgroundWorkState: "running" } });
  try {
    assert.equal(fact(panel.container, "background"), "1 of 2 jobs running");
    // Without the runner's aggregate running state the job is unverified, never running.
    await panel.setProps({ session: { ...session, backgroundJobs: [job, done], backgroundWorkState: undefined } });
    assert.equal(fact(panel.container, "background"), "0 of 2 jobs running, 1 unverified");
    await panel.setProps({ session: { ...session, backgroundJobs: [job, done], backgroundWorkState: "orphaned" } });
    assert.equal(fact(panel.container, "background"), "0 of 2 jobs running, 1 lost");
  } finally {
    await panel.dispose();
  }
});

test("Background Work never reads as empty history when a server omits the inventory (#2844)", async () => {
  // An older control plane sends neither the jobs nor whether any exist, only the runner's state.
  const panel = await mount({ git: gitWith(0), session: { ...session, backgroundWorkState: "running" } });
  try {
    assert.equal(fact(panel.container, "background"), "The runner reports background work");
    await panel.setProps({ session: { ...session, backgroundWorkState: "orphaned" } });
    assert.equal(fact(panel.container, "background"), "Background work was lost");
    await panel.setProps({ session: { ...session, backgroundWorkTracking: "managed" } });
    assert.equal(fact(panel.container, "background"), "This server doesn't say whether jobs have run");
    // A provider whose detached work the runner cannot observe proves nothing by an empty list.
    await panel.setProps({ session: { ...session, backgroundWorkTracking: "untracked", backgroundJobs: [], backgroundJobsAvailable: false } });
    assert.equal(fact(panel.container, "background"), "This agent's background work isn't tracked");
    // Known empty history is the one case that says nothing has run.
    await panel.setProps({
      session: { ...session, backgroundWorkTracking: "managed", backgroundJobsAvailable: false, backgroundJobs: [] },
    });
    assert.equal(fact(panel.container, "background"), "Nothing has run in the background");
    // Retained delivery receipts are history the Background Work panel lists, with no job listed.
    const delivery = { parentTurnId: "turn-1" } as NonNullable<SessionView["backgroundDeliveries"]>[number];
    await panel.setProps({
      session: { ...session, backgroundWorkTracking: "managed", backgroundJobsAvailable: false, backgroundJobs: [], backgroundDeliveries: [delivery] },
    });
    assert.equal(fact(panel.container, "background"), "No jobs listed; earlier results are recorded");
  } finally {
    await panel.dispose();
  }
});
