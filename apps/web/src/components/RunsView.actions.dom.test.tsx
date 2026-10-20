import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunView, type SessionEvent, type SessionEventsResponse, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { RunDetail } from "./RunsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * What a person does to a comparison run from its page (#2976): Follow Up… with some or all of its
 * agents from one dialog, Stop Agent… and Stop All Agents… behind confirmations, and Copy Final
 * Answer. Everything renders under StrictMode, so effects mount twice and async completions are
 * checked against the page that is current when they settle.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = Date.now();
const member = (id: string, agentName: string, driver: string, status: SessionView["status"], extra: Partial<SessionView> = {}) => ({
  id, runnerId: "runner-1", agentId: agentName.toLowerCase(), agentName, driver, title: agentName, status,
  pendingApproval: null, archived: false, eventEpoch: 0, messageCount: 0, workspaceName: "Alpha", ...extra,
}) as unknown as SessionView;
const claude = member("s_claude", "Claude Code", "claude-code", "idle");
const codex = member("s_codex", "Codex", "codex-app-server", "running", { activeTurnId: "turn-codex" });
const gemini = member("s_gemini", "Gemini CLI", "gemini", "idle");
const RUN_TITLE = "Refactor the Scheduler";

let seq = 0;
const event = (sessionId: string, payload: SessionEvent["payload"]): SessionEvent =>
  ({ id: ++seq, sessionId, seq, ts: NOW, payload }) as SessionEvent;
const page = (events: SessionEvent[]): SessionEventsResponse =>
  ({ events, eventEpoch: 0, nextAfter: events.at(-1)?.seq ?? 0, cacheComplete: true }) as SessionEventsResponse;
const pending = () => new Promise<never>(() => {});
const FINAL_ANSWER = "Misfires now run **once**.\n\n| Case | Runs |\n| --- | ---: |\n| DST fall back | 1 |";

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

function RunRoute() {
  const view = useStoreSelector((state) => state.view);
  return view.name === "run" ? <RunDetail runId={view.id} member={view.member} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
}

async function setViewport(width: number, height: number) {
  await act(async () => {
    domWindow.happyDOM.setViewport({ width, height });
    domWindow.dispatchEvent(new domWindow.Event("resize"));
  });
}

async function mount(client: Partial<ApiClient>, sessions: SessionView[] = [claude, codex, gemini]): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "runs-actions", runtimeKey: "runs-actions:1",
    createSocket: () => (socket = new FakeSocket()),
    close() {},
  };
  const run: RunView = {
    id: "run-cmp", title: RUN_TITLE, prompt: "Refactor the scheduler so a misfire never runs twice.", workspaceId: "ws-alpha",
    workspaceName: "Alpha", createdAt: NOW, updatedAt: NOW, sessionIds: sessions.map((session) => session.id),
  };
  let current: View = { name: "run", id: run.id };
  const navigation: ViewNavigation = {
    current: () => current,
    push(view) { current = view; },
    replace(view) { current = view; },
    listen: () => () => {},
  };
  const apiClient = {
    ...api, workflowInstances: async () => [], runWorkflowArtifacts: async () => ({ artifacts: [] }),
    getSessionEventPage: pending, ...client,
  } as unknown as ApiClient;
  await act(async () => root.render(
    <StrictMode>
      <ApiProvider client={apiClient}>
        <StoreProvider connection={connection} navigation={navigation}>
          <FeedbackProvider>
            <RunRoute />
          </FeedbackProvider>
        </StoreProvider>
      </ApiProvider>
    </StrictMode>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [{
      runnerId: "runner-1", hostname: "studio", displayName: "Studio", os: "macos", version: "1", status: "online",
      protocolVersion: PROTOCOL_VERSION, agents: [], workspaces: [], connectedAt: NOW, lastSeen: NOW,
    }],
    boxes: [], projects: [], sessions, runs: [run], pods: [],
  } as unknown as UiSnapshotMessage));
  await settle();
  return { container, root };
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function unmount(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

async function click(element: unknown) {
  assert.ok(element, "the element to click exists");
  await act(async () => { fireDomEvent.click(element as never); });
  await settle();
}

const doc = () => domWindow.document as unknown as Document;
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")]
  .find((button) => button.textContent === name || button.getAttribute("aria-label") === name) ?? null;
const menuItem = (label: string) => [...doc().querySelectorAll('[role="menuitem"]')]
  .find((item) => item.textContent?.startsWith(label)) ?? null;
const dialogTitled = (title: string) => [...doc().querySelectorAll('[role="dialog"]')]
  .find((dialog) => dialog.querySelector(".modal-title, h2")?.textContent === title) ?? null;
const toasts = () => [...doc().querySelectorAll(".toast")].map((toast) => toast.textContent ?? "");
const column = (container: Element, agent: string) => container.querySelector(`section.compare-member[aria-label="${agent}"]`);

async function openFollowUp(container: Element) {
  await click(buttonNamed(container.querySelector(".detail-bar")!, "Follow Up…"));
  const dialog = dialogTitled("Follow Up");
  assert.ok(dialog, "Follow Up… opens the dialog");
  return dialog;
}

async function type(dialog: Element, text: string) {
  const field = dialog.querySelector("textarea")!;
  await act(async () => { fireDomEvent.change(field as never, { target: { value: text } }); });
}

/** The Send To rows: each member's name, whether it is checked and unavailable, and its second line. */
function sendToRows(dialog: Element) {
  return [...dialog.querySelectorAll(".choice-row")].map((row) => {
    const input = row.querySelector("input")!;
    return {
      name: row.querySelector(".choice-row-title")?.textContent ?? "",
      checked: input.checked,
      unavailable: input.getAttribute("aria-disabled") === "true" || input.disabled,
      line: row.textContent ?? "",
    };
  });
}

function recordingPrompt(fail: ReadonlySet<string> = new Set()) {
  const calls: Array<{ id: string; text: string }> = [];
  const prompt = (async (id: string, text: string) => {
    calls.push({ id, text });
    if (fail.has(id)) throw new Error("The agent's machine went offline.");
    return {} as SessionView;
  }) as unknown as ApiClient["prompt"];
  return { calls, prompt };
}

describe("Follow Up… (#2976)", () => {
  test("two idle members start checked, the running one is unavailable as Running, and Send sends one prompt per checked member", async () => {
    await setViewport(1440, 900);
    const { calls, prompt } = recordingPrompt();
    const fixture = await mount({ prompt });
    try {
      const dialog = await openFollowUp(fixture.container);
      assert.ok(doc().activeElement === dialog.querySelector("textarea"), "Message is focused");
      const rows = sendToRows(dialog);
      assert.deepEqual(rows.map((row) => [row.name, row.checked, row.unavailable]), [
        ["Claude Code", true, false],
        ["Codex App Server", false, true],
        ["Gemini CLI", true, false],
      ]);
      assert.match(rows[1]!.line, /Running/u, "the running member says why");

      await type(dialog, "Also cover leap seconds.");
      const send = buttonNamed(dialog, "Send to 2 Agents");
      assert.ok(send && !send.disabled, "the primary counts the checked members");
      await click(send);
      assert.deepEqual(calls, [
        { id: claude.id, text: "Also cover leap seconds." },
        { id: gemini.id, text: "Also cover leap seconds." },
      ], "one prompt request per checked member");
      assertNoDomNode(dialogTitled("Follow Up"), "every send succeeded, so the dialog closes");
      assert.deepEqual(toasts(), ["Sent to 2 agents"]);
    } finally {
      await unmount(fixture);
    }
  });

  test("with an empty message Send is disabled and the footer says why", async () => {
    await setViewport(1440, 900);
    const { calls, prompt } = recordingPrompt();
    const fixture = await mount({ prompt });
    try {
      const dialog = await openFollowUp(fixture.container);
      const send = buttonNamed(dialog, "Send to 2 Agents")!;
      assert.equal(send.disabled, true);
      const reason = dialog.querySelector(".modal-foot > .run-follow-up-reason");
      assert.equal(reason?.textContent, "Write a message to send.");
      assert.equal(send.getAttribute("aria-describedby"), reason?.id, "the disabled primary is described by its reason");
      // Whitespace is still an empty message, and Ctrl+Enter does not send it.
      await type(dialog, "   ");
      await act(async () => { fireDomEvent.keyDown(dialog.querySelector("textarea") as never, { key: "Enter", ctrlKey: true }); });
      await settle();
      assert.deepEqual(calls, []);
      assert.equal(dialog.querySelector(".run-follow-up-reason")?.textContent, "Write a message to send.");

      // Unchecking every member names the other thing Send waits for.
      await type(dialog, "Go on.");
      for (const input of dialog.querySelectorAll<HTMLInputElement>('.choice-row input[type="checkbox"]')) {
        if (input.checked) await click(input);
      }
      assert.equal(dialog.querySelector(".run-follow-up-reason")?.textContent, "Choose an agent to send to.");
      assert.equal(buttonNamed(dialog, "Send to Agents")?.disabled, true);
    } finally {
      await unmount(fixture);
    }
  });

  test("Ctrl+Enter in Message sends", async () => {
    await setViewport(1440, 900);
    const { calls, prompt } = recordingPrompt();
    const fixture = await mount({ prompt });
    try {
      const dialog = await openFollowUp(fixture.container);
      await type(dialog, "Ship it.");
      await act(async () => { fireDomEvent.keyDown(dialog.querySelector("textarea") as never, { key: "Enter", ctrlKey: true }); });
      await settle();
      assert.deepEqual(calls.map((call) => call.id), [claude.id, gemini.id]);
    } finally {
      await unmount(fixture);
    }
  });

  test("when one of three sends fails the dialog stays with Delivered, Delivered and Failed, and Retry Failed sends one request", async () => {
    await setViewport(1440, 900);
    const third = member("s_opencode", "OpenCode", "acp", "idle");
    const failing = new Set([gemini.id]);
    const { calls, prompt } = recordingPrompt(failing);
    const fixture = await mount({ prompt }, [claude, gemini, third]);
    try {
      const dialog = await openFollowUp(fixture.container);
      await type(dialog, "Add a migration note.");
      await click(buttonNamed(dialog, "Send to 3 Agents"));
      assert.equal(calls.length, 3, "one request per member, all sent");
      assert.ok(dialogTitled("Follow Up"), "the dialog stays open");
      const notice = dialog.querySelector('.notice[role="alert"]');
      assert.match(notice?.textContent ?? "", /Couldn't Send to Every Agent/u);
      const results = [...dialog.querySelectorAll(".run-follow-up-results > li")].map((row) => [
        row.querySelector(".row-title")?.textContent,
        row.querySelector(".status")?.textContent,
        row.querySelector(".row-sub")?.textContent ?? null,
      ]);
      assert.deepEqual(results, [
        ["Claude Code", "Delivered", null],
        ["Gemini CLI", "Failed", "The agent's machine went offline."],
        ["OpenCode", "Delivered", null],
      ]);
      assertNoDomNode(dialog.querySelector(".modal-foot .notice"), "no error in the footer");

      failing.clear();
      await click(buttonNamed(dialog, "Retry Failed"));
      assert.deepEqual(calls.slice(3), [{ id: gemini.id, text: "Add a migration note." }], "Retry Failed resends only to the failed member");
      assertNoDomNode(dialogTitled("Follow Up"), "every member now has it, so the dialog closes");
      assert.deepEqual(toasts(), ["Sent to 3 agents"]);
    } finally {
      await unmount(fixture);
    }
  });

  test("Follow Up with This Agent… checks only that member", async () => {
    await setViewport(1440, 900);
    const fixture = await mount({});
    try {
      await click(column(fixture.container, "Gemini CLI")?.querySelector('button[aria-label="Gemini CLI Actions"]'));
      await click(menuItem("Follow Up with This Agent…"));
      const dialog = dialogTitled("Follow Up")!;
      assert.deepEqual(sendToRows(dialog).map((row) => row.checked), [false, false, true]);
      assert.ok(buttonNamed(dialog, "Send to 1 Agent"));

      await click(buttonNamed(dialog, "Cancel"));
      // A running member can't take one, and its ⋯ says why.
      await click(column(fixture.container, "Codex App Server")?.querySelector('button[aria-label="Codex App Server Actions"]'));
      const item = menuItem("Follow Up with This Agent…")!;
      assert.equal(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled, true);
      assert.match(item.textContent ?? "", /Running/u);
    } finally {
      await unmount(fixture);
    }
  });

  test("a send that settles after the run page is gone changes nothing and shows no toast", async () => {
    await setViewport(1440, 900);
    let release: () => void = () => {};
    const prompt = (() => new Promise<SessionView>((resolve) => { release = () => resolve({} as SessionView); })) as unknown as ApiClient["prompt"];
    const fixture = await mount({ prompt });
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const dialog = await openFollowUp(fixture.container);
      await type(dialog, "Keep going.");
      await click(buttonNamed(dialog, "Send to 2 Agents"));
      assert.equal(buttonNamed(dialog, "Send to 2 Agents")?.getAttribute("aria-busy"), "true", "Send is busy while it sends");
      await unmount(fixture);
      await act(async () => { release(); });
      await settle();
      assert.deepEqual(toasts(), []);
      assert.deepEqual(errors, [], "no update on an unmounted page");
    } finally {
      console.error = originalError;
    }
  });
});

describe("Stop Agent… and Stop All Agents… (#2976)", () => {
  const second = member("s_opencode", "OpenCode", "acp", "running", { activeTurnId: "turn-opencode" });

  test("Stop All Agents lists each running member with its status and stops only those", async () => {
    await setViewport(1440, 900);
    const stopped: string[] = [];
    const fixture = await mount({ cancelTurn: (async (id: string) => { stopped.push(id); return {} as SessionView; }) as unknown as ApiClient["cancelTurn"] },
      [claude, codex, second]);
    try {
      await click(fixture.container.querySelector('.detail-bar button[aria-label="More Actions"]'));
      await click(menuItem("Stop All Agents…"));
      const dialog = dialogTitled("Stop All Agents")!;
      assert.ok(dialog, "Stop All Agents confirms");
      assert.match(dialog.textContent ?? "", new RegExp(`stops its current turn in “${RUN_TITLE}”`, "u"));
      const rows = [...dialog.querySelectorAll(".confirmation-rows > li")].map((row) => [
        row.querySelector(".row-title")?.textContent, row.querySelector(".status")?.textContent,
      ]);
      assert.deepEqual(rows, [["Codex App Server", "Running"], ["OpenCode", "Running"]], "one row per running member, with its status");
      await click(buttonNamed(dialog, "Stop All Agents"));
      assert.deepEqual(stopped, [codex.id, second.id], "only the running members are stopped");
      assertNoDomNode(dialogTitled("Stop All Agents"));
    } finally {
      await unmount(fixture);
    }
  });

  test("a member that fails to stop keeps the dialog open naming it, and Try Again stops only that member", async () => {
    await setViewport(1440, 900);
    const stopped: string[] = [];
    let refuse = true;
    const cancelTurn = (async (id: string) => {
      stopped.push(id);
      if (id === second.id && refuse) throw new Error("runner unreachable");
      return {} as SessionView;
    }) as unknown as ApiClient["cancelTurn"];
    const fixture = await mount({ cancelTurn }, [claude, codex, second]);
    try {
      await click(fixture.container.querySelector('.detail-bar button[aria-label="More Actions"]'));
      await click(menuItem("Stop All Agents…"));
      const dialog = dialogTitled("Stop All Agents")!;
      await click(buttonNamed(dialog, "Stop All Agents"));
      assert.ok(dialogTitled("Stop All Agents"), "the dialog stays open");
      assert.match(dialog.querySelector('.notice[role="alert"]')?.textContent ?? "", /Couldn't stop OpenCode\./u);
      refuse = false;
      await click(buttonNamed(dialog, "Stop All Agents"));
      assert.deepEqual(stopped, [codex.id, second.id, second.id], "the second attempt stops only the member that failed");
      assertNoDomNode(dialogTitled("Stop All Agents"));
    } finally {
      await unmount(fixture);
    }
  });

  test("Stop All Agents is offered only while a member's turn runs", async () => {
    await setViewport(1440, 900);
    const fixture = await mount({}, [claude, gemini]);
    try {
      await click(fixture.container.querySelector('.detail-bar button[aria-label="More Actions"]'));
      assertNoDomNode(menuItem("Stop All Agents…"));
    } finally {
      await unmount(fixture);
    }
  });

  test("Stop Agent names the agent and the run and stops only its turn", async () => {
    await setViewport(1440, 900);
    const stopped: string[] = [];
    const fixture = await mount({ cancelTurn: (async (id: string) => { stopped.push(id); return {} as SessionView; }) as unknown as ApiClient["cancelTurn"] });
    try {
      await click(column(fixture.container, "Codex App Server")?.querySelector('button[aria-label="Codex App Server Actions"]'));
      await click(menuItem("Stop Agent…"));
      const dialog = dialogTitled("Stop Agent")!;
      assert.equal(dialog.querySelector(".confirmation-message")?.textContent,
        `Codex App Server stops its current turn in “${RUN_TITLE}”. Its work so far is kept.`);
      assert.ok(doc().activeElement === buttonNamed(dialog, "Cancel"), "a destructive confirmation opens on Cancel");
      await click(buttonNamed(dialog, "Stop Agent"));
      assert.deepEqual(stopped, [codex.id]);

      // An idle member has no turn to stop, and its ⋯ says so.
      await click(column(fixture.container, "Claude Code")?.querySelector('button[aria-label="Claude Code Actions"]'));
      const item = menuItem("Stop Agent…")!;
      assert.equal(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled, true);
      assert.match(item.textContent ?? "", /Not running/u);
    } finally {
      await unmount(fixture);
    }
  });
});

describe("Copy Final Answer (#2976)", () => {
  function stubClipboard() {
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
    Object.defineProperty(domWindow.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    return {
      written,
      restore: () => {
        if (original) Object.defineProperty(domWindow.navigator, "clipboard", original);
        else delete (domWindow.navigator as unknown as { clipboard?: unknown }).clipboard;
      },
    };
  }

  test("copies the member's last reply as Markdown, and is unavailable with its reason before one exists", async () => {
    await setViewport(1440, 900);
    const clipboard = stubClipboard();
    seq = 0;
    const timeline = [
      event(claude.id, { kind: "user_message", text: "Refactor the scheduler" }),
      event(claude.id, { kind: "agent_message", text: "I'll read the scheduler first.", final: true }),
      event(claude.id, { kind: "tool_call", toolCallId: "bash-1", title: "$ npm test", toolKind: "execute", status: "completed" }),
      event(claude.id, { kind: "agent_message", text: FINAL_ANSWER, final: true }),
    ] as SessionEvent[];
    const fixture = await mount({
      getSessionEventPage: (async (id: string) => page(id === claude.id ? timeline : [])) as ApiClient["getSessionEventPage"],
    });
    try {
      await click(column(fixture.container, "Gemini CLI")?.querySelector('button[aria-label="Gemini CLI Actions"]'));
      const unavailable = menuItem("Copy Final Answer")!;
      assert.equal(unavailable.getAttribute("aria-disabled") === "true" || (unavailable as HTMLButtonElement).disabled, true);
      assert.match(unavailable.textContent ?? "", /No answer yet/u);
      await act(async () => { fireDomEvent.keyDown(doc().activeElement as never, { key: "Escape" }); });
      await settle();

      const trigger = column(fixture.container, "Claude Code")?.querySelector('button[aria-label="Claude Code Actions"]');
      await click(trigger);
      await click(menuItem("Copy Final Answer"));
      assert.deepEqual(clipboard.written, [FINAL_ANSWER], "the last reply, as written");
      assert.deepEqual(toasts(), ["Final answer copied as Markdown."]);
      assert.ok(doc().activeElement === trigger, "focus stays on the member's ⋯");
    } finally {
      await unmount(fixture);
      clipboard.restore();
    }
  });
});

describe("on a phone (#2976)", () => {
  test("the bar's Follow Up… is an icon button, named and titled by its label, so the run's title keeps its room", async () => {
    await setViewport(390, 844);
    const fixture = await mount({});
    try {
      const followUp = fixture.container.querySelector<HTMLButtonElement>(".detail-bar .detail-bar-action.primary")!;
      assert.match(followUp.className, /\bicon-only\b/u);
      assert.equal(followUp.textContent, "Follow Up…", "its label stays its accessible name");
      assert.equal(followUp.title, "Follow Up…");
      await click(followUp);
      assert.ok(dialogTitled("Follow Up"), "it opens the dialog as a sheet");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });

  test("Stop Agent… from the member bar's ⋯ replaces the sheet with Back to More Actions, which brings the sheet back", async () => {
    await setViewport(390, 844);
    const fixture = await mount({}, [codex, claude]);
    try {
      const memberBar = fixture.container.querySelector(".compare-member .compare-member-head")!;
      await click(memberBar.querySelector('button[aria-label="Codex App Server Actions"]'));
      await click(menuItem("Stop Agent…"));
      const dialog = dialogTitled("Stop Agent")!;
      assert.ok(dialog, "the confirmation opens");
      assertNoDomNode(menuItem("Open Session"), "the ⋯ sheet is gone, not stacked under the confirmation");
      const back = dialog.querySelector('button[aria-label="Back to More Actions"]');
      assert.ok(back, "its header shows Back to More Actions");
      await click(back);
      assertNoDomNode(dialogTitled("Stop Agent"));
      assert.ok(menuItem("Stop Agent…"), "Back brings the member's ⋯ sheet back");
      assert.ok(doc().activeElement === menuItem("Stop Agent…"), "with focus on the item that was chosen");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });

  test("Stop All Agents… from the bar's ⋯ also replaces the sheet with Back", async () => {
    await setViewport(390, 844);
    const fixture = await mount({});
    try {
      await click(fixture.container.querySelector('.detail-bar button[aria-label="More Actions"]'));
      await click(menuItem("Stop All Agents…"));
      const back = dialogTitled("Stop All Agents")?.querySelector('button[aria-label="Back to More Actions"]');
      assert.ok(back);
      await click(back);
      assert.ok(menuItem("Stop All Agents…"), "Back reopens the bar's ⋯");
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });
});

describe("two members running the same agent (#2976)", () => {
  test("are numbered on the heads, the Follow Up rows and the Stop confirmation", async () => {
    await setViewport(1440, 900);
    const first = member("s_claude_1", "Claude Code", "claude-code", "idle");
    const other = member("s_claude_2", "Claude Code", "claude-code", "running", { activeTurnId: "turn-2" });
    const fixture = await mount({ cancelTurn: (async () => ({}) as SessionView) as unknown as ApiClient["cancelTurn"] }, [first, other, codex]);
    try {
      assert.deepEqual([...fixture.container.querySelectorAll(".compare-member-agent")].map((agent) => agent.textContent),
        ["Claude Code 1", "Claude Code 2", "Codex App Server"]);
      const dialog = await openFollowUp(fixture.container);
      assert.deepEqual(sendToRows(dialog).map((row) => row.name), ["Claude Code 1", "Claude Code 2", "Codex App Server"]);
      await click(buttonNamed(dialog, "Cancel"));

      await click(column(fixture.container, "Claude Code 2")?.querySelector('button[aria-label="Claude Code 2 Actions"]'));
      await click(menuItem("Stop Agent…"));
      assert.match(dialogTitled("Stop Agent")?.textContent ?? "", /Claude Code 2 stops its current turn/u);
    } finally {
      await unmount(fixture);
    }
  });

  test("are numbered on the phone's member tabs", async () => {
    await setViewport(390, 844);
    const first = member("s_claude_1", "Claude Code", "claude-code", "idle");
    const other = member("s_claude_2", "Claude Code", "claude-code", "idle");
    const fixture = await mount({}, [first, other]);
    try {
      assert.deepEqual([...fixture.container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
        ["Claude Code 1, Awaiting Prompt", "Claude Code 2, Awaiting Prompt"]);
    } finally {
      await unmount(fixture);
      await setViewport(1440, 900);
    }
  });
});
