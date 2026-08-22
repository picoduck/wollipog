import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { InboxRow } from "./InboxRow.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("Inbox rows expose Stop Failed instead of Diff Ready", async () => {
  const session = {
    id: "session-stop-failed", runnerId: "runner-1", title: "Failed Stop",
    status: "stopped", column: "review", archived: false, archiveStatus: "stop_failed",
    pendingApproval: null, lastEventAt: null, preview: null,
    agentId: "codex", agentName: "Codex", driver: "codex-app-server",
  } as SessionView;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<InboxRow
    optionId="session-option" session={session} projectName="Project One"
    selected={false} unread={false} pinned={false} rowIndex={1}
    stalled={false} activityNow={2}
    onSelect={() => undefined} onExpand={() => undefined}
  />));
  assert.match(container.textContent ?? "", /Stop Failed/);
  assert.doesNotMatch(container.textContent ?? "", /Diff Ready/);
  await act(async () => root.unmount());
  container.remove();
});
