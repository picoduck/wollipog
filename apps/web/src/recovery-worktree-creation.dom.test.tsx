import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  SessionView,
  SessionWorktreeCreateOperationSummary,
  SessionWorktreeCreateOperationView,
} from "@wollipog/protocol";
import { ApiError } from "./api.js";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { WorktreeRecoveryCard } from "./components/WorktreeRecoveryCard.js";
import { useRecoveryWorktreeCreation } from "./recovery-worktree-creation.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const RECOVERY_ID = "worktree-recovery:test";

function recoverySession(): SessionView {
  return {
    id: "recovery-session", runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Demo",
    projectId: null, agentId: "codex", agentName: "Codex", title: "Recovery", status: "input_required",
    column: "input_required", runId: null, useWorktree: true, worktreePath: "/repo/missing",
    archived: false, createdAt: 1, updatedAt: 2, lastEventAt: 2, messageCount: 1, eventEpoch: 0,
    preview: null, pendingApproval: null, driver: "codex-app-server", model: null, effort: null,
    permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    worktreeRecovery: {
      recoveryId: RECOVERY_ID, detectedAt: 2, selectedPath: "/repo/missing",
      expectedBranch: "fix/missing", detail: "The selected worktree is no longer registered.",
    },
    worktrees: [
      { id: "missing", path: "/repo/missing", branch: "fix/missing", baseRef: "origin/main", source: "created" },
    ],
  };
}

function recoveredSession(): SessionView {
  const { worktreeRecovery: _cleared, ...rest } = recoverySession();
  return { ...rest, status: "idle", worktreePath: "/repo/fix/missing-recovery" };
}

type PostReply = { operation?: SessionWorktreeCreateOperationView; session?: SessionView } | Error;
type ReadReply = SessionWorktreeCreateOperationSummary[] | Error;

/** Scripted control plane. Each call consumes the next reply; an exhausted script fails loudly. */
function fakeApi(script: { posts?: PostReply[]; reads?: ReadReply[]; session?: () => SessionView }) {
  const posts = [...(script.posts ?? [])];
  const reads = [...(script.reads ?? [])];
  const calls = { posts: [] as Array<{ branch: string; baseRef?: string }>, reads: 0, sessions: 0 };
  return {
    calls,
    api: {
      createSessionWorktreeWithProgress: async (_id: string, input: { branch: string; baseRef?: string }) => {
        calls.posts.push(input);
        const reply = posts.shift();
        if (!reply) throw new Error("unexpected create request");
        if (reply instanceof Error) throw reply;
        return reply;
      },
      sessionWorktreeOperations: async () => {
        calls.reads += 1;
        const reply = reads.shift();
        if (!reply) throw new Error("unexpected operations read");
        if (reply instanceof Error) throw reply;
        return { operations: reply };
      },
      session: async () => {
        calls.sessions += 1;
        return { session: (script.session ?? recoveredSession)() };
      },
    },
  };
}

/** Poll sleeps park here until the test advances them one at a time. */
function manualClock() {
  const waiting: Array<() => void> = [];
  return {
    sleep: () => new Promise<void>((resolve) => { waiting.push(resolve); }),
    async tick() {
      await act(async () => {
        waiting.shift()?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

async function render(api: ReturnType<typeof fakeApi>["api"], sleep: () => Promise<void>) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  function Harness() {
    const [session, setSession] = useState(recoverySession);
    const { creation, create } = useRecoveryWorktreeCreation({ api: api as never, session, onSession: setSession, sleep });
    return (
      <>
        <span data-testid="status">{session.status}</span>
        <WorktreeRecoveryCard session={session} runnerOnline creation={creation} onCreate={create} onSelect={async () => {}} />
      </>
    );
  }
  await act(async () => {
    root.render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
  return {
    container,
    root,
    progress: () => q('[aria-label="Replacement Worktree Progress"]')?.textContent ?? null,
    createButton: () => [...container.querySelectorAll("button")]
      .find((button) => /Creat/u.test(button.textContent ?? "")) as HTMLButtonElement,
    alert: () => q('[id^="worktree-recovery-create-failed-"]')?.textContent ?? null,
    status: () => q('[data-testid="status"]')?.textContent,
    card: () => q('[aria-label="Worktree Recovery Required"]'),
    async clickCreate() {
      await act(async () => {
        this.createButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

test("a progress-aware create reports each phase, then settles the recovered session", async () => {
  const clock = manualClock();
  const { api, calls } = fakeApi({
    reads: [
      [],
      [{ id: "op1", status: "in_progress", phase: "fetching_remote", branch: "fix/missing-recovery" }],
      [{ id: "op1", status: "in_progress", phase: "running_setup", branch: "fix/missing-recovery" }],
      [{ id: "op1", status: "completed", branch: "fix/missing-recovery" }],
    ],
    posts: [{ operation: { id: "op1", status: "in_progress" } }],
  });
  const view = await render(api, clock.sleep);
  try {
    await view.clickCreate();
    assert.equal(view.createButton().textContent, "Creating…");
    assert.equal(view.createButton().disabled, true);
    assert.equal(view.progress(), null, "no phase is claimed before the runner reports one");

    await clock.tick();
    assert.equal(view.progress(), "Fetching RemoteStep 1 of 4");
    await clock.tick();
    assert.equal(view.progress(), "Running SetupStep 3 of 4");
    assert.equal(view.createButton().disabled, true);

    await clock.tick();
    assert.equal(view.status(), "idle", "completion loads the session the control plane settled");
    assert.equal(view.card(), null, "a confirmed recovery removes the card");
    assert.deepEqual(calls.posts, [{ branch: "fix/missing-recovery", baseRef: "origin/main" }],
      "observation never repeats the create");
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("a failed create names the failing phase and leaves the retained prompt Not Sent", async () => {
  const clock = manualClock();
  const { api, calls } = fakeApi({
    reads: [
      [],
      [{ id: "op1", status: "in_progress", phase: "running_setup", branch: "fix/missing-recovery", baseRef: "origin/main" }],
      [{
        id: "op1", status: "failed", phase: "running_setup", error: "runner request timed out",
        branch: "fix/missing-recovery", baseRef: "origin/main",
      }],
    ],
    posts: [
      { operation: { id: "op1", status: "in_progress" } },
      // Retrying the same coordinates first consumes the already-shown failure, then starts anew.
      new ApiError("runner request timed out", 409, undefined, {
        operation: { id: "op1", status: "failed", phase: "running_setup", error: "runner request timed out" },
      }),
      { operation: { id: "op2", status: "in_progress" } },
    ],
  });
  const view = await render(api, clock.sleep);
  try {
    await view.clickCreate();
    await clock.tick();
    await clock.tick();
    assert.equal(view.alert(), "Creation Failed: Running Setup runner request timed out");
    assert.match(view.card()?.textContent ?? "", /retained as Not Sent/u);
    assert.equal(view.progress(), null);
    assert.equal(view.createButton().disabled, false, "the failure stays actionable");
    assert.equal(view.createButton().textContent, "Create Replacement");
    assert.match(view.createButton().getAttribute("aria-describedby") ?? "", /worktree-recovery-create-failed-/u);

    await view.clickCreate();
    assert.equal(calls.posts.length, 3, "a retry is not answered by the stale failure");
    assert.equal(view.alert(), null);
    assert.equal(view.createButton().textContent, "Creating…");
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("a reloaded page rejoins a running create and keeps it non-actionable", async () => {
  const clock = manualClock();
  const { api, calls } = fakeApi({
    reads: [
      [{ id: "op1", status: "in_progress", phase: "materializing", branch: "fix/other", baseRef: "origin/release" }],
      [{ id: "op1", status: "in_progress", phase: "activating", branch: "fix/other", baseRef: "origin/release" }],
      [{ id: "op1", status: "completed", branch: "fix/other", baseRef: "origin/release" }],
    ],
  });
  const view = await render(api, clock.sleep);
  try {
    assert.equal(view.progress(), "Creating WorktreeStep 2 of 4");
    assert.equal(view.createButton().textContent, "Creating…");
    assert.equal(view.createButton().disabled, true);
    await clock.tick();
    assert.equal(view.progress(), "Activating WorktreeStep 4 of 4");
    await clock.tick();
    assert.equal(view.card(), null);
    assert.equal(calls.posts.length, 0, "rejoining never issues a create");
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("a reloaded page shows an unconsumed failure with its phase", async () => {
  const { api } = fakeApi({
    reads: [[{
      id: "op1", status: "failed", phase: "fetching_remote", error: "could not read from remote",
      branch: "fix/missing-recovery",
    }]],
  });
  const view = await render(api, manualClock().sleep);
  try {
    assert.equal(view.alert(), "Creation Failed: Fetching Remote could not read from remote");
    assert.equal(view.createButton().disabled, false);
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("an older control plane without progress keeps the plain Creating… state", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const legacyRoute = new ApiError("Route GET:/api/sessions/recovery-session/worktrees/operations not found", 404);
  const { calls, api } = fakeApi({ reads: [legacyRoute] });
  const legacy = {
    ...api,
    createSessionWorktreeWithProgress: async (_id: string, input: { branch: string; baseRef?: string }) => {
      calls.posts.push(input);
      await gate;
      return { session: recoveredSession() };
    },
  };
  const view = await render(legacy, manualClock().sleep);
  try {
    assert.equal(view.alert(), null, "a missing operations route is not an error");
    await view.clickCreate();
    assert.equal(view.createButton().textContent, "Creating…");
    assert.equal(view.progress(), null);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(view.card(), null);
    assert.equal(calls.posts.length, 1);
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("a progress-aware control plane without the operations route is followed by joining", async () => {
  const clock = manualClock();
  const missing = () => new ApiError("Route GET:/api/sessions/recovery-session/worktrees/operations not found", 404);
  const { api, calls } = fakeApi({
    reads: [missing(), missing()],
    posts: [
      { operation: { id: "op1", status: "in_progress" } },
      { operation: { id: "op1", status: "in_progress", phase: "fetching_remote" } },
      { operation: { id: "op1", status: "completed" }, session: recoveredSession() },
    ],
  });
  const view = await render(api, clock.sleep);
  try {
    await view.clickCreate();
    await clock.tick();
    assert.equal(calls.reads, 2, "the missing route is detected once, then no longer read");
    await clock.tick();
    assert.equal(view.progress(), "Fetching RemoteStep 1 of 4");
    await clock.tick();
    assert.equal(view.card(), null);
    assert.equal(calls.posts.length, 3);
    assert.ok(calls.posts.every((input) => input.branch === "fix/missing-recovery"), "joins repeat exact coordinates");
  } finally {
    await act(async () => view.root.unmount());
  }
});

test("a create that vanishes while the incident remains is reported, not silently dropped", async () => {
  const clock = manualClock();
  const { api } = fakeApi({
    reads: [[], []],
    posts: [{ operation: { id: "op1", status: "in_progress", phase: "fetching_remote" } }],
    session: recoverySession,
  });
  const view = await render(api, clock.sleep);
  try {
    await view.clickCreate();
    await clock.tick();
    assert.match(view.alert() ?? "", /^Creation Failed: Fetching Remote Replacement worktree creation ended without a result/u);
    assert.match(view.card()?.textContent ?? "", /retained as Not Sent/u);
  } finally {
    await act(async () => view.root.unmount());
  }
});
