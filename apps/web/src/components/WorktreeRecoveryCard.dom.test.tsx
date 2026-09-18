import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionView } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { WorktreeRecoveryCard } from "./WorktreeRecoveryCard.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function recoverySession(): SessionView {
  return {
    id: "recovery-session", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Demo",
    projectId: null, agentId: "codex", agentName: "Codex", title: "Recovery", status: "input_required",
    column: "input_required", runId: null, useWorktree: true, worktreePath: "/repo/missing",
    archived: false, createdAt: 1, updatedAt: 2, lastEventAt: 2, messageCount: 1, eventEpoch: 0,
    preview: null, pendingApproval: null, driver: "codex-app-server", model: null, effort: null,
    permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    worktreeRecovery: {
      recoveryId: "worktree-recovery:test", detectedAt: 2, selectedPath: "/repo/missing",
      expectedBranch: "fix/missing", detail: "The selected worktree is no longer registered.",
    },
    worktrees: [
      { id: "missing", path: "/repo/missing", branch: "fix/missing", baseRef: "origin/main", source: "created" },
      { id: "existing", path: "/repo/existing", branch: "fix/existing", baseRef: "origin/main", source: "created" },
    ],
  };
}

async function renderCard(overrides: {
  onCreate?: (input: { branch: string; baseRef?: string }) => Promise<void>;
  onSelect?: (path: string) => Promise<void>;
  runnerOnline?: boolean;
} = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <WorktreeRecoveryCard
      session={recoverySession()}
      runnerOnline={overrides.runnerOnline ?? true}
      onCreate={overrides.onCreate ?? (async () => {})}
      onSelect={overrides.onSelect ?? (async () => {})}
    />,
  ));
  return { container, root };
}

test("worktree recovery exposes a managed replacement action with the allowed base", async () => {
  const creates: Array<{ branch: string; baseRef?: string }> = [];
  const { container, root } = await renderCard({ onCreate: async (input) => { creates.push(input); } });
  try {
    const card = container.querySelector('[aria-label="Worktree Recovery Required"]') as HTMLElement;
    assert.ok(card);
    assert.match(card.textContent, /Not Sent/u);
    const button = [...card.querySelectorAll("button")].find((item) => item.textContent === "Create Replacement")!;
    await act(async () => { button.click(); await Promise.resolve(); });
    assert.deepEqual(creates, [{ branch: "fix/missing-recovery", baseRef: "origin/main" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("worktree recovery selects only another worktree linked to this session", async () => {
  const selections: string[] = [];
  const { container, root } = await renderCard({ onSelect: async (path) => { selections.push(path); } });
  try {
    assert.equal(
      container.querySelector('button[aria-label="Worktree: fix/existing"]')?.textContent?.trim(),
      "fix/existing",
    );
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Select Worktree")!;
    await act(async () => { button.click(); await Promise.resolve(); });
    assert.deepEqual(selections, ["/repo/existing"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("worktree recovery actions remain visible but disabled while the runner is offline", async () => {
  const { container, root } = await renderCard({ runnerOnline: false });
  try {
    const actions = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent === "Create Replacement" || button.textContent === "Select Worktree");
    assert.equal(actions.length, 2);
    assert.ok(actions.every((button) => button.disabled));
    assert.equal(container.querySelector('button[aria-label="Worktree: fix/existing"]')?.getAttribute("aria-disabled"), "true");
    assert.match(container.textContent, /runner is offline/u);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
