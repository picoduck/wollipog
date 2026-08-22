import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { recordSessionActivity } from "../activity.js";
import { InboxList } from "./InboxList.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  PointerEvent: domWindow.PointerEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/**
 * happy-dom does no layout, so every element reports a zero-height rect — and a virtualized list
 * with a zero-height viewport correctly renders nothing. These tests are about the list's SEMANTICS
 * (roles, ids, selection, mouse paths), not its windowing, so the viewport is given a height and
 * rows a size, which is the minimum that makes the virtualizer produce a range at all.
 *
 * The windowing itself is not asserted here and should not be: it needs real layout, which is what
 * the Playwright harnesses are for.
 */
const VIEWPORT_HEIGHT = 2000;
const ROW_HEIGHT = 68;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value(this: Element) {
    const height = this.classList?.contains("inbox-list") ? VIEWPORT_HEIGHT : ROW_HEIGHT;
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: height, width: 800, height, toJSON: () => ({}) };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", ROW_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as never;
}

function session(id: string, title: string): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Wollipog",
    agentId: "codex",
    agentName: "Codex",
    title,
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    lastEventAt: 2,
    messageCount: 1,
    preview: "Implementation is ready for review.",
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
  };
}

test("inbox list exposes selection semantics and mouse select/expand paths", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const selected: string[] = [];
  const expanded: string[] = [];
  const first = session("session / one", "First Session");
  const second = session("session-two", "Second Session");

  await act(async () => {
    root.render(
      <InboxList
        entries={[
          { session: first, projectName: "Wollipog", unread: true },
          { session: second, projectName: "Wollipog", unread: false },
        ]}
        selectedSessionId={first.id}
        pinnedSessionIds={new Set([first.id])}
        activityBySession={new Map()}
        stalledSessionIds={new Set()}
        activityNow={60_000}
        runningCount={0}
        queuedCount={0}
        startingCount={0}
        filtered={false}
        onNewSession={() => undefined}
        onSelect={(id) => selected.push(id)}
        onExpand={(id) => expanded.push(id)}
        onScrollPosition={() => undefined}
      />,
    );
  });

  const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
  const rows = [...container.querySelectorAll<HTMLElement>('[role="row"]')];
  assert.equal(grid.getAttribute("aria-label"), "Sessions");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.getAttribute("aria-selected"), "true");
  assert.equal(rows[1]!.getAttribute("aria-selected"), "false");
  assert.equal(rows[0]!.classList.contains("unread"), true);
  assert.equal(rows[0]!.querySelector('[aria-label="Unread Activity"]')?.textContent, "1");
  assert.equal(rows[0]!.querySelector('[aria-label="Pinned Session"]')?.textContent, "●");
  assert.equal(rows[0]!.children.length, 1,
    "selection must not expand a session row with embedded shortcut actions");
  assert.equal(container.querySelector(".inbox-row-actions"), null);
  assert.equal(grid.getAttribute("aria-activedescendant"), rows[0]!.id,
    "the active descendant must reference the actual row");

  const primaryButtons = rows.map((row) => row.querySelector<HTMLButtonElement>(".inbox-row")!);
  await act(async () => { primaryButtons[1]!.click(); });
  assert.deepEqual(selected, [second.id]);
  await act(async () => {
    primaryButtons[1]!.dispatchEvent(new domWindow.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
  });
  assert.deepEqual(expanded, [second.id]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("inbox list keeps live row content and the visible touch target while interaction is owned", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const events: string[] = [];
  const selected: string[] = [];
  const renderList = (entry: SessionView) => (
    <InboxList
      entries={[{ session: entry, projectName: "Wollipog", unread: false }]}
      selectedSessionId="target"
      pinnedSessionIds={new Set()}
      activityBySession={new Map()}
      stalledSessionIds={new Set()}
      activityNow={60_000}
      runningCount={0}
      queuedCount={0}
      startingCount={0}
      filtered={false}
      onNewSession={() => undefined}
      onSelect={(sessionId) => selected.push(sessionId)}
      onExpand={() => undefined}
      onScrollPosition={() => undefined}
      onPointerTargetChange={(pointerId, targeting, pointerType) => events.push(`target:${pointerId}:${targeting}:${pointerType}`)}
      onPointerPressChange={(pointerId, active, pointerType) => events.push(`press:${pointerId}:${active}:${pointerType}`)}
    />
  );
  await act(async () => { root.render(renderList(session("target", "Target Session"))); });

  const grid = container.querySelector<HTMLElement>(".inbox-list")!;
  const pointer = (type: string, pointerId: number, pointerType: string) =>
    grid.dispatchEvent(new domWindow.PointerEvent(type, { bubbles: true, pointerId, pointerType }) as unknown as Event);
  await act(async () => {
    pointer("pointerover", 1, "mouse");
    pointer("pointerdown", 7, "touch");
  });
  await act(async () => {
    root.render(renderList({
      ...session("target", "Target Session"),
      preview: "Approval arrived while targeting.",
      status: "input_required",
    }));
  });
  assert.match(container.textContent ?? "", /Approval arrived while targeting/);
  assert.match(container.textContent ?? "", /Input Required/);

  await act(async () => {
    pointer("pointerup", 7, "touch");
    container.querySelector<HTMLButtonElement>(".inbox-row")!.click();
    pointer("pointerout", 1, "mouse");
  });
  assert.deepEqual(selected, ["target"]);
  assert.deepEqual(events, ["target:1:true:mouse", "press:7:true:touch", "press:7:false:touch", "target:1:false:mouse"]);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("inbox zero reports running work and keeps a mouse path to New Session", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  let created = 0;
  await act(async () => {
    root.render(
      <InboxList
        entries={[]}
        selectedSessionId={null}
        pinnedSessionIds={new Set()}
        activityBySession={new Map()}
        stalledSessionIds={new Set()}
        activityNow={60_000}
        runningCount={2}
        queuedCount={0}
        startingCount={0}
        filtered={false}
        onNewSession={() => { created += 1; }}
        onSelect={() => undefined}
        onExpand={() => undefined}
        onScrollPosition={() => undefined}
      />,
    );
  });
  assert.match(container.textContent ?? "", /All Agents Unblocked/);
  assert.match(container.textContent ?? "", /Running: 2. Queued: 0. Starting: 0./);
  await act(async () => { container.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.equal(created, 1);
  await act(async () => { root.unmount(); });
  container.remove();
});

test("inbox zero uses contextual Project copy and lets search-empty copy take precedence", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const props = {
    entries: [],
    selectedSessionId: null,
    pinnedSessionIds: new Set<string>(),
    activityBySession: new Map(),
    stalledSessionIds: new Set<string>(),
    activityNow: 60_000,
    runningCount: 0,
    queuedCount: 0,
    startingCount: 0,
    onNewSession: () => undefined,
    onSelect: () => undefined,
    onExpand: () => undefined,
    onScrollPosition: () => undefined,
  };
  await act(async () => {
    root.render(<InboxList {...props} filtered={false} emptyState={{
      title: "No Sessions Yet",
      description: "Start a session in Empty Project.",
      showNewSession: true,
    }} />);
  });
  assert.match(container.textContent ?? "", /No Sessions Yet/);
  assert.match(container.textContent ?? "", /Start a session in Empty Project/);
  assert.ok(container.querySelector("button"));

  await act(async () => {
    root.render(<InboxList {...props} filtered={false} emptyState={{
      title: "No Sessions Without a Project",
      description: "Sessions not assigned to a Project appear here.",
      showNewSession: false,
    }} />);
  });
  assert.match(container.textContent ?? "", /No Sessions Without a Project/);
  assert.equal(container.querySelector("button"), null);

  await act(async () => {
    root.render(<InboxList {...props} filtered emptyState={{
      title: "No Sessions Yet",
      description: "Start a session in Empty Project.",
      showNewSession: true,
    }} />);
  });
  assert.match(container.textContent ?? "", /No Matching Sessions/);
  assert.match(container.textContent ?? "", /Try a different search/);
  assert.doesNotMatch(container.textContent ?? "", /No Sessions Yet/);
  assert.equal(container.querySelector("button"), null);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("busy rows show activity while stalled approval remains distinct and accessible", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const now = 20 * 60_000;
  const running = { ...session("running", "Running Session"), status: "running" as const, column: "running" as const };
  const stalled = {
    ...session("stalled", "Stalled Approval"),
    status: "input_required" as const,
    column: "input_required" as const,
    pendingApproval: { requestId: "request-1", title: "Allow command?", options: [] },
  };
  const idle = session("idle", "Idle Session");
  const authentication = {
    ...session("authentication", "Authentication Block"),
    status: "input_required" as const,
    column: "input_required" as const,
    pendingApproval: {
      kind: "authentication" as const,
      requestId: "provider-auth:test",
      title: "Authentication Required — Claude Code",
      options: [],
    },
  };
  const activityBySession = new Map([
    [running.id, recordSessionActivity(undefined, now)],
    [stalled.id, recordSessionActivity(undefined, now - 11 * 60_000)],
  ]);

  await act(async () => {
    root.render(
      <InboxList
        entries={[running, stalled, idle, authentication].map((entry) => ({ session: entry, projectName: "Wollipog", unread: false }))}
        selectedSessionId={running.id}
        pinnedSessionIds={new Set()}
        activityBySession={activityBySession}
        stalledSessionIds={new Set([stalled.id])}
        activityNow={now}
        runningCount={1}
        queuedCount={0}
        startingCount={0}
        filtered={false}
        onNewSession={() => undefined}
        onSelect={() => undefined}
        onExpand={() => undefined}
        onScrollPosition={() => undefined}
      />,
    );
  });

  const rows = [...container.querySelectorAll<HTMLElement>('[role="row"]')];
  assert.equal(container.querySelectorAll(".activity-strip").length, 3, "idle sessions have no activity strip");
  assert.equal(rows[1]!.classList.contains("stalled"), true);
  assert.match(rows[0]!.textContent ?? "", /Running/);
  assert.match(rows[1]!.textContent ?? "", /Awaiting Input/);
  assert.match(rows[1]!.textContent ?? "", /Approval Required/);
  assert.match(rows[2]!.textContent ?? "", /Awaiting Prompt/);
  assert.doesNotMatch(rows[2]!.textContent ?? "", /Diff Ready|Ready for Review/);
  assert.match(rows[1]!.textContent ?? "", /Approval/);
  assert.match(rows[1]!.textContent ?? "", /Stalled/);
  assert.equal(
    rows[1]!.querySelector('[aria-label="Stalled: No Activity for at Least 10 Minutes"]')?.textContent?.trim(),
    "Stalled",
  );
  assert.match(rows[3]!.textContent ?? "", /Authentication Required/);
  assert.equal(rows[3]!.querySelector("[aria-label=\"Attention: Authentication Required\"]")?.textContent?.trim(),
    "Authentication Required");

  await act(async () => { root.unmount(); });
  container.remove();
});
