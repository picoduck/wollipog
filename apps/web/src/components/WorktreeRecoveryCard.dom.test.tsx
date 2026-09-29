import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { SessionCommandPermission, SessionView } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { RecoveryWorktreeCreation } from "../recovery-worktree-creation.js";
import { WorktreeRecoveryCard } from "./WorktreeRecoveryCard.js";

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
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
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** Each fixture is its own session, since the typed draft (path included) outlives a card per incident. */
let sessionCount = 0;

function recoverySession(expectedBranch = "fix/missing"): SessionView {
  return {
    id: `recovery-session-${++sessionCount}`, runnerId: "runner-1", workspaceId: "workspace-1", workspaceName: "Demo",
    projectId: null, agentId: "codex", agentName: "Codex", title: "Recovery", status: "input_required",
    column: "input_required", runId: null, useWorktree: true, worktreePath: "/repo/missing",
    archived: false, createdAt: 1, updatedAt: 2, lastEventAt: 2, messageCount: 1, eventEpoch: 0,
    preview: null, pendingApproval: null, driver: "codex-app-server", model: null, effort: null,
    permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    worktreeRecovery: {
      recoveryId: "worktree-recovery:test", detectedAt: 2, selectedPath: "/repo/missing",
      expectedBranch, detail: "The selected worktree is no longer registered.",
    },
    worktrees: [
      { id: "missing", path: "/repo/missing", branch: "fix/missing", baseRef: "origin/main", source: "created" },
      { id: "existing", path: "/repo/existing", branch: "fix/existing", baseRef: "origin/main", source: "created" },
    ],
  };
}

type CardProps = Partial<React.ComponentProps<typeof WorktreeRecoveryCard>>;

async function renderCard(overrides: CardProps = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const element = (props: CardProps) => (
    <WorktreeRecoveryCard
      session={recoverySession()}
      runnerOnline
      onCreate={async () => {}}
      onSelect={async () => {}}
      {...overrides}
      {...props}
    />
  );
  await act(async () => root.render(element({})));
  return {
    container,
    root,
    rerender: async (props: CardProps) => act(async () => root.render(element(props))),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const buttons = (scope: ParentNode) => [...scope.querySelectorAll("button")] as HTMLButtonElement[];
const button = (scope: ParentNode, label: string) => {
  const found = buttons(scope).find((item) => item.textContent === label);
  assert.ok(found, `${label} is rendered`);
  return found;
};
/** Unavailable either way a button can be: `disabled`, or busy and refusing clicks (#1949). */
const unavailable = (item: HTMLButtonElement) => item.disabled || item.getAttribute("aria-disabled") === "true";
const card = (container: HTMLElement) => container.querySelector('[aria-label="Worktree Missing"]') as HTMLElement;

async function choosePath(scope: ParentNode, label: "Create New" | "Use Existing") {
  const radio = [...scope.querySelectorAll('[role="radio"]')].find((item) => item.textContent === label) as HTMLElement;
  assert.ok(radio, `the ${label} segment is rendered`);
  await act(async () => radio.click());
}

const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
/** React's change plugin watches the focused input through keyup here, so type as a person would. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    setValue.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: "x" }) as never);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: "k" }) as never);
  });
}
const field = (scope: ParentNode, label: string) => {
  const found = [...scope.querySelectorAll("label.field")].find((item) => item.querySelector("span")?.textContent === label);
  assert.ok(found, `the ${label} field is rendered`);
  return found.querySelector("input") as HTMLInputElement;
};

function describedText(control: Element): string[] {
  const ids = control.getAttribute("aria-describedby")?.split(/\s+/u).filter(Boolean) ?? [];
  return ids.map((id) => {
    const target = control.ownerDocument.getElementById(id);
    assert.ok(target, `aria-describedby target ${id} is rendered`);
    return target.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  });
}

const SENTENCE = "The worktree for fix/missing is gone, so messages marked Not Sent wait until this session has a worktree.";

test("the notice is titled Worktree Missing with one sentence and one question, not two fieldsets", async () => {
  const view = await renderCard();
  try {
    const notice = card(view.container);
    assert.ok(notice);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Worktree Missing");
    assert.equal(notice.querySelector(".notice-body > p")?.textContent, SENTENCE);
    assertNoDomNode(notice.querySelector("fieldset, legend"), "no Create Replacement Worktree or Select Existing Worktree legend");
    assert.doesNotMatch(notice.textContent, /Create Replacement Worktree|Select Existing Worktree|Worktree Recovery Required/u);
    const group = notice.querySelector('[role="radiogroup"]')!;
    assert.equal(group.getAttribute("aria-label"), "Recovery Method");
    assert.deepEqual([...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent), ["Create New", "Use Existing"]);
    assert.equal(notice.querySelector('[role="radio"][aria-checked="true"]')?.textContent, "Create New");
    assert.doesNotMatch(notice.textContent, /The selected worktree is no longer registered/u,
      "the runner's raw detail waits behind Show Details");
    await act(async () => button(notice, "Show Details").click());
    assert.match(notice.textContent, /The selected worktree is no longer registered\./u);
  } finally {
    await view.unmount();
  }
});

test("Create New proposes a replacement branch on the broken worktree's base", async () => {
  const creates: Array<{ branch: string; baseRef?: string }> = [];
  const view = await renderCard({ onCreate: async (input) => { creates.push(input); } });
  try {
    const row = view.container.querySelector(".worktree-missing-row")!;
    assert.deepEqual([...row.querySelectorAll("label.field > span")].map((label) => label.textContent), ["Base Ref", "Branch"]);
    await act(async () => { button(row, "Create Replacement").click(); await Promise.resolve(); });
    assert.deepEqual(creates, [{ branch: "fix/missing-recovery", baseRef: "origin/main" }]);
  } finally {
    await view.unmount();
  }
});

test("Use Existing offers only this session's other worktrees, restore-selected last", async () => {
  const selections: string[] = [];
  const view = await renderCard({ onSelect: async (path) => { selections.push(path); } });
  try {
    await choosePath(view.container, "Use Existing");
    const trigger = view.container.querySelector<HTMLButtonElement>('button[aria-label="Worktree: fix/existing"]');
    assert.equal(trigger?.textContent?.trim(), "fix/existing");
    await act(async () => trigger!.click());
    assert.deepEqual(
      [...view.container.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim()),
      ["fix/existing", "fix/missing (Restore Selected)"],
    );
    await act(async () => view.container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!.click());
    assert.equal(view.container.querySelector(".worktree-missing-row")?.textContent?.includes("Create Replacement"), false);
    await act(async () => { button(view.container, "Use Worktree").click(); await Promise.resolve(); });
    assert.deepEqual(selections, ["/repo/existing"]);
  } finally {
    await view.unmount();
  }
});

test("switching between Create New and Use Existing keeps the typed Base Ref and Branch", async () => {
  const creates: Array<{ branch: string; baseRef?: string }> = [];
  const view = await renderCard({ session: { ...recoverySession(), id: "switch-session" }, onCreate: async (input) => { creates.push(input); } });
  try {
    await type(field(view.container, "Base Ref"), "origin/release");
    await type(field(view.container, "Branch"), "fix/typed-branch");
    await choosePath(view.container, "Use Existing");
    assertNoDomNode(view.container.querySelector("label.field input"), "Use Existing shows the picker instead");
    await choosePath(view.container, "Create New");
    assert.equal(field(view.container, "Base Ref").value, "origin/release");
    assert.equal(field(view.container, "Branch").value, "fix/typed-branch");
    await act(async () => { button(view.container, "Create Replacement").click(); await Promise.resolve(); });
    assert.deepEqual(creates, [{ branch: "fix/typed-branch", baseRef: "origin/release" }]);
  } finally {
    await view.unmount();
  }
});

test("session broadcasts preserve the in-flight action guard", async () => {
  let finishCreate!: () => void;
  const pendingCreate = new Promise<void>((resolve) => { finishCreate = resolve; });
  const view = await renderCard({ onCreate: () => pendingCreate });
  try {
    const create = button(view.container, "Create Replacement");
    await act(async () => { create.click(); await Promise.resolve(); });
    assert.equal(create.getAttribute("aria-busy"), "true", "the busy button keeps its label and shows a spinner");
    assert.equal(create.querySelector(".spinner")?.getAttribute("aria-hidden"), "true");

    const updated = recoverySession();
    updated.updatedAt = 3;
    updated.worktrees = updated.worktrees?.map((worktree) => ({ ...worktree }));
    await view.rerender({ session: updated });
    assert.equal(unavailable(button(view.container, "Create Replacement")), true);
    await choosePath(view.container, "Use Existing");
    assert.equal(unavailable(button(view.container, "Use Worktree")), true, "no selection starts while a create runs");

    await act(async () => { finishCreate(); await pendingCreate; });
  } finally {
    await view.unmount();
  }
});

test("a typed draft survives the card unmounting while another session notice shows (#1966)", async () => {
  const session = { ...recoverySession(), id: "draft-session" };
  const first = await renderCard({ session });
  await type(field(first.container, "Branch"), "fix/my-restored-work");
  await first.unmount();

  const creates: string[] = [];
  const again = await renderCard({ session, onCreate: async ({ branch }) => { creates.push(branch); } });
  await act(async () => { button(again.container, "Create Replacement").click(); });
  assert.deepEqual(creates, ["fix/my-restored-work"], "the remounted form creates the typed branch");
  const fresh = await renderCard({
    session: { ...session, worktreeRecovery: { ...session.worktreeRecovery!, recoveryId: "worktree-recovery:next" } },
  });
  try {
    assert.equal(field(again.container, "Branch").value, "fix/my-restored-work", "the same incident keeps the draft");
    assert.equal(field(fresh.container, "Branch").value, "fix/missing-recovery", "a new incident starts fresh");
  } finally {
    await again.unmount();
    await fresh.unmount();
  }
});

test("a selection still running from an earlier mount keeps both actions refused (#1966)", async () => {
  const view = await renderCard({ selecting: true, session: { ...recoverySession(), id: "selecting-session" } });
  try {
    assert.equal(unavailable(button(view.container, "Create Replacement")), true, "no create starts during a selection");
    await choosePath(view.container, "Use Existing");
    const use = button(view.container, "Use Worktree");
    assert.equal(use.getAttribute("aria-busy"), "true", "the running selection shows on its own button");
    assert.equal(unavailable(use), true, "and no second selection starts");
  } finally {
    await view.unmount();
  }
});

test("a repeated recovery proposes a fresh replacement branch", async () => {
  const view = await renderCard({ session: recoverySession("fix/missing-recovery") });
  try {
    assert.equal(field(view.container, "Branch").value, "fix/missing-recovery-2");
  } finally {
    await view.unmount();
  }
});

test("offline, the reason names the machine and both actions are disabled and described by it", async () => {
  const view = await renderCard({ runnerOnline: false, machineName: "Build Box", session: { ...recoverySession(), id: "offline-session" } });
  try {
    const reason = "Build Box is offline, so the worktree can't be recovered until it reconnects.";
    assert.match(card(view.container).textContent, new RegExp(reason.replace(/\./gu, "\\.")));
    const create = button(view.container, "Create Replacement");
    assert.equal(create.disabled, true);
    assert.equal(describedText(create).at(-1), reason);
    await choosePath(view.container, "Use Existing");
    const use = button(view.container, "Use Worktree");
    assert.equal(use.disabled, true);
    assert.equal(describedText(use).at(-1), reason);
    assert.equal(view.container.querySelector('button[aria-label="Worktree: fix/existing"]')?.getAttribute("aria-disabled"), "true");
  } finally {
    await view.unmount();
  }
});

test("without a machine name the offline reason still says what to wait for", async () => {
  const view = await renderCard({ runnerOnline: false });
  try {
    assert.match(card(view.container).textContent,
      /This machine is offline, so the worktree can't be recovered until it reconnects\./u);
  } finally {
    await view.unmount();
  }
});

test("both actions are described by the notice's sentence, with their visible names", async () => {
  const view = await renderCard({ session: { ...recoverySession(), id: "described-session" } });
  try {
    for (const label of ["Create Replacement", "Use Worktree"] as const) {
      if (label === "Use Worktree") await choosePath(view.container, "Use Existing");
      const action = button(view.container, label);
      assert.equal(action.getAttribute("aria-label"), null, "the accessible name stays the visible Title Case label");
      assert.deepEqual(describedText(action), [SENTENCE]);
    }
  } finally {
    await view.unmount();
  }
});

test("a failed create shows the phase sentence, keeps the output behind Show Output, and offers Try Again", async () => {
  const creation: RecoveryWorktreeCreation = {
    status: "failed", phase: "running_setup", error: "Setup step \"pnpm install\" exited with code 1.",
  };
  const creates: string[] = [];
  const view = await renderCard({ creation, onCreate: async ({ branch }) => { creates.push(branch); } });
  try {
    const failure = view.container.querySelector('[id^="worktree-recovery-create-failed-"]')!;
    assert.equal(failure.textContent, "Creating the worktree stopped at step 3, Running Setup.");
    assert.equal(failure.getAttribute("role"), "alert");
    assert.doesNotMatch(card(view.container).textContent, /exited with code 1/u, "the raw error is not shown until asked for");
    const toggle = button(view.container, "Show Output");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(async () => toggle.click());
    const output = view.container.querySelector(".worktree-missing-output")!;
    assert.equal(output.classList.contains("code-well"), true, "the output is a mono well");
    assert.equal(output.textContent, "Setup step \"pnpm install\" exited with code 1.");
    assert.equal(toggle.getAttribute("aria-controls"), output.id);
    assert.equal(toggle.textContent, "Hide Output");

    const retry = button(view.container, "Try Again");
    assert.equal(retry.classList.contains("primary"), true);
    assert.deepEqual(describedText(retry).at(-1), "Creating the worktree stopped at step 3, Running Setup.");
    await act(async () => { retry.click(); await Promise.resolve(); });
    assert.deepEqual(creates, ["fix/missing-recovery"]);
  } finally {
    await view.unmount();
  }
});

const VIEWER = "Your Viewer role is read-only.";

function withManageWorktrees(verdict: SessionCommandPermission | undefined): SessionView {
  const session = recoverySession();
  if (verdict) {
    session.commandPermissions = {
      stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
      manageWorktrees: verdict,
    };
  }
  return session;
}

test("a refused person sees both recovery actions disabled with the reason, and nothing is sent (#1864)", async () => {
  const calls: string[] = [];
  const view = await renderCard({
    session: withManageWorktrees({ allowed: false, reason: VIEWER }),
    onCreate: async (input) => { calls.push(`create:${input.branch}`); },
    onSelect: async (path) => { calls.push(`select:${path}`); },
  });
  try {
    assert.match(view.container.textContent, /Your Viewer role is read-only\./u, "the reason is visible on the notice");
    for (const label of ["Create Replacement", "Use Worktree"]) {
      if (label === "Use Worktree") await choosePath(view.container, "Use Existing");
      const action = button(view.container, label);
      assert.equal(action.disabled, true, `${label} is disabled`);
      assert.ok(describedText(action).includes(VIEWER), `${label} is described by the refusal`);
      await act(async () => { action.click(); await Promise.resolve(); });
    }
    assert.equal(view.container.querySelector('button[aria-label="Worktree: fix/existing"]')?.getAttribute("aria-disabled"), "true",
      "the worktree picker is disabled with its action");
    assert.deepEqual(calls, []);
  } finally {
    await view.unmount();
  }
});

test("an allowed or absent worktree verdict leaves the recovery actions as they were (#1864)", async () => {
  for (const verdict of [{ allowed: true } as const, undefined]) {
    const calls: string[] = [];
    const view = await renderCard({
      session: withManageWorktrees(verdict),
      onCreate: async (input) => { calls.push(`create:${input.branch}`); },
      onSelect: async (path) => { calls.push(`select:${path}`); },
    });
    try {
      assert.doesNotMatch(view.container.textContent, /Viewer role/u);
      await act(async () => { button(view.container, "Create Replacement").click(); await Promise.resolve(); });
      await choosePath(view.container, "Use Existing");
      await act(async () => { button(view.container, "Use Worktree").click(); await Promise.resolve(); });
      assert.deepEqual(calls, ["create:fix/missing-recovery", "select:/repo/existing"]);
    } finally {
      await view.unmount();
    }
  }
});

async function onPhone(run: () => Promise<void>) {
  await act(async () => { domWindow.happyDOM.setViewport({ width: 390, height: 844 }); });
  try {
    await run();
  } finally {
    await act(async () => { domWindow.happyDOM.setViewport({ width: 1440, height: 900 }); });
  }
}
const sheet = () => domWindow.document.querySelector('[role="dialog"]') as HTMLElement | null;

test("on a phone the notice keeps one Recover Worktree… button and the form opens as a sheet", async () => {
  await onPhone(async () => {
    const selections: string[] = [];
    const view = await renderCard({
      session: { ...recoverySession(), id: "phone-session" },
      onSelect: async (path) => { selections.push(path); },
    });
    try {
      const notice = card(view.container);
      assertNoDomNode(notice.querySelector(".worktree-missing-form, input, [role=\"radiogroup\"]"),
        "the form is not drawn over the transcript");
      assert.deepEqual(buttons(notice.querySelector(".notice-actions")!).map((item) => item.textContent),
        ["Recover Worktree…", "Show Details"]);
      await act(async () => button(notice, "Recover Worktree…").click());
      const dialog = sheet()!;
      assert.equal(dialog.getAttribute("aria-label") ?? dialog.querySelector("h2, .modal-title")?.textContent, "Recover Worktree");
      assert.equal(dialog.querySelector('.seg.block[role="radiogroup"]')?.getAttribute("aria-label"), "Recovery Method");
      assert.deepEqual(buttons(dialog.querySelector(".modal-foot")!).map((item) => item.textContent), ["Cancel", "Create Replacement"]);

      await choosePath(dialog, "Use Existing");
      const list = dialog.querySelector('.choice-list[role="radiogroup"]')!;
      assert.equal(list.getAttribute("aria-label"), "Worktree", "the worktree choice is a ChoiceList, not a Select");
      assert.deepEqual([...list.querySelectorAll(".choice-row-title")].map((title) => title.textContent),
        ["fix/existing", "fix/missing (Restore Selected)"]);
      await act(async () => (list.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click());
      await act(async () => { button(dialog.querySelector(".modal-foot")!, "Use Worktree").click(); await Promise.resolve(); });
      assert.deepEqual(selections, ["/repo/missing"]);
    } finally {
      await view.unmount();
    }
  });
});

test("on a phone Cancel closes the sheet, and after a failure the button reads Try Again…", async () => {
  await onPhone(async () => {
    const view = await renderCard({
      session: { ...recoverySession(), id: "phone-failed-session" },
      creation: { status: "failed", phase: "fetching_remote", error: "could not read from remote" },
    });
    try {
      const notice = card(view.container);
      assert.match(notice.textContent, /Creating the worktree stopped at step 1, Fetching Remote\./u);
      assert.equal(buttons(notice).some((item) => item.textContent === "Show Output"), false,
        "the output waits in the sheet, keeping the notice short");
      await act(async () => button(notice, "Try Again…").click());
      const dialog = sheet()!;
      await act(async () => button(dialog, "Show Output").click());
      assert.match(dialog.textContent, /could not read from remote/u);
      assert.ok(button(dialog.querySelector(".modal-foot")!, "Try Again"));
      await act(async () => button(dialog, "Cancel").click());
      assertNoDomNode(sheet());
    } finally {
      await view.unmount();
    }
  });
});

test("on a phone, offline keeps Recover Worktree… disabled and described by the named machine", async () => {
  await onPhone(async () => {
    const view = await renderCard({ runnerOnline: false, machineName: "Build Box" });
    try {
      const recover = button(card(view.container), "Recover Worktree…");
      assert.equal(recover.disabled, true);
      assert.equal(describedText(recover).at(-1), "Build Box is offline, so the worktree can't be recovered until it reconnects.");
    } finally {
      await view.unmount();
    }
  });
});
