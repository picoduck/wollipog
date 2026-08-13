import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { InboxShortcutRail, type InboxShortcutRailProps } from "./InboxShortcutRail.js";

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
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function session(pendingApproval: SessionView["pendingApproval"] = null): SessionView {
  return {
    id: "session-1",
    title: "Selected Session",
    pendingApproval,
  } as SessionView;
}

test("the Inbox footer rail keeps standard shortcuts global and approval shortcuts contextual", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const invoked: string[] = [];
  const props: Omit<InboxShortcutRailProps, "session" | "pinned" | "busy"> = {
    onApprove: () => invoked.push("approve"),
    onDeny: () => invoked.push("deny"),
    onReply: () => invoked.push("reply"),
    onExpand: () => invoked.push("expand"),
    onTogglePin: () => invoked.push("pin"),
    onMarkUnread: () => invoked.push("unread"),
    onArchive: () => invoked.push("archive"),
  };

  await act(async () => {
    root.render(<InboxShortcutRail {...props} session={session()} pinned={false} busy={false} />);
  });
  const toolbar = container.querySelector<HTMLElement>('[aria-label="Shortcuts for Selected Session"]')!;
  assert.deepEqual(
    [...toolbar.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
    ["Reply", "Expand", "Pin", "Unread", "Archive"],
  );
  assert.equal(toolbar.querySelector('[aria-label="Approve"]'), null);
  assert.equal(toolbar.querySelector('[aria-label="Deny"]'), null);
  assert.equal(toolbar.querySelector('[aria-label="Expand"] kbd')?.textContent, "Enter");

  await act(async () => {
    root.render(
      <InboxShortcutRail
        {...props}
        session={session({ requestId: "approval-1", title: "Allow Command?", options: [] })}
        pinned
        busy={false}
      />,
    );
  });
  assert.deepEqual(
    [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
    ["Approve", "Deny", "Reply", "Expand", "Unpin", "Unread", "Archive"],
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Approve"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Reply"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Archive"]')!.click();
  });
  assert.deepEqual(invoked, ["approve", "reply", "archive"]);

  await act(async () => {
    root.render(<InboxShortcutRail {...props} session={session()} pinned={false} busy />);
  });
  assert.equal([...container.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled), true);

  await act(async () => { root.unmount(); });
  container.remove();
});
