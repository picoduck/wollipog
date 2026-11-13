import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { worktreeRefusalAction, type OrchestratorCampaignProjection } from "@wollipog/protocol";
import { api } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignCleanup, CampaignStuck } from "./CampaignCleanup.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);

const cleanup: NonNullable<OrchestratorCampaignProjection["cleanup"]> = { total: 4, items: [
  { kind: "merged_branch", sessionId: "child-1", repository: "picoduck/wollipog", pullRequest: 4200, branch: "agent/child-1",
    state: "pending", reason: "The merged branch is still on the remote.",
    action: { kind: "command", command: "gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/child-1'" } },
  { kind: "merged_branch", sessionId: "child-2", repository: "picoduck/wollipog", pullRequest: 4201, branch: "agent/child-2",
    state: "pending", reason: "The last deletion was refused: the forge could not be reached.",
    action: { kind: "delete_merged_branches", occurrenceId: "workflow_delete" } },
  { kind: "worktree", sessionId: "child-3", path: "/worktrees/child-3", status: "refused",
    reason: "The worktree has uncommitted changes (2 paths): \"report.md\", \"notes.txt\".",
    action: worktreeRefusalAction("the worktree has uncommitted changes (2 paths): \"report.md\", \"notes.txt\"") },
  { kind: "handoff", workItemId: "item-1", title: "Rotate the signing key", issue: null, responsibleActor: "human",
    reason: "Only the owner can rotate it.", action: { kind: "person", text: "Rotate the key in the release settings." } },
] };

test("Cleanup lists each item with its reason and exact action, and Delete Merged Branches asks Wollipog to perform approved deletions (#4146)", async () => {
  const original = api.deleteCampaignMergedBranches;
  const calls: string[] = [];
  api.deleteCampaignMergedBranches = async (id) => { calls.push(id); return { performed: 1, refused: 0 }; };
  const view = await render(<CampaignCleanup campaignId="root-1" cleanup={cleanup} canAct
    onOpenSession={(id) => <a href={`/sessions/${id}`}>{id}</a>} />);
  try {
    const { container } = view;
    assert.equal(container.querySelector("h3")?.textContent, "Cleanup");
    const terms = [...container.querySelectorAll("dt")].map((node) => node.textContent);
    assert.deepEqual(terms, ["Merged Branch", "Reason", "Action", "Merged Branch", "Reason", "Action", "Worktree", "Reason", "Action"],
      "Title Case labels; handed-off items keep their own section");
    const codes = [...container.querySelectorAll("code")].map((node) => node.textContent);
    assert.ok(codes.includes("gh api -X DELETE 'repos/picoduck/wollipog/git/refs/heads/agent/child-1'"), "the exact command");
    assert.ok(codes.includes("/worktrees/child-3"), "the refused worktree's path");
    assert.ok(!codes.some((code) => /^git\b|git -C/u.test(code ?? "")), "no git command is suggested");
    const worktreeRow = [...container.querySelectorAll("li")].find((node) => node.textContent?.includes("/worktrees/child-3"));
    assert.ok(worktreeRow, "the worktree row");
    assert.match(worktreeRow.textContent ?? "", /The worktree has uncommitted changes \(2 paths\): "report\.md", "notes\.txt"\./u,
      "the refusal reason with the dirty paths the runner reported");
    assert.equal(worktreeRow.querySelector("a[href='/sessions/child-3']")?.textContent, "child-3", "the child's session opens from the row");
    assert.match(worktreeRow.textContent ?? "", /Retirement refuses uncommitted changes\. Choose Inspect Worktree/u);
    assert.deepEqual([...worktreeRow.querySelectorAll("code")].map((node) => node.textContent), ["/worktrees/child-3"],
      "the path is the only code in the worktree row");
    assert.equal(worktreeRow.querySelector("button")?.textContent?.trim(), "Inspect Worktree");
    assert.doesNotMatch(container.textContent ?? "", /worktree remove|--force|reset --hard|git clean|git -C/u);
    assert.ok(container.querySelector("button[aria-label='Copy Command for agent/child-1']"), "each command can be copied, named");
    assert.match(container.textContent ?? "", /1 handed-off item is listed under Handed Off\./u);
    assert.match(container.textContent ?? "", /Wollipog can delete it with its approved deletion/u);

    const remove = button(container, "Delete Merged Branches");
    assert.ok(remove, "offered where Wollipog holds an approved deletion");
    await act(async () => remove.click());
    assert.deepEqual(calls, ["root-1"]);
    assert.match(container.querySelector("[role=status]")?.textContent ?? "", /Deleted 1 merged branch\./u);
  } finally {
    view.unmount();
    api.deleteCampaignMergedBranches = original;
  }
});

test("a worktree item that still carries a command shows only its next step, never the command", async () => {
  const legacy: NonNullable<OrchestratorCampaignProjection["cleanup"]> = { total: 2, items: [
    { kind: "worktree", sessionId: "child-4", path: "/worktrees/child-4", status: "refused", reason: "The branch has unpushed commits.",
      action: { kind: "command", command: "git -C '/worktrees/child-4' log --oneline '@{upstream}..HEAD'",
        then: "Push the commits you want to keep, or confirm they are not needed. Then ask the Orchestrator to retire the worktree through Wollipog." } },
    { kind: "worktree", sessionId: "child-5", path: "/worktrees/child-5", status: "refused", reason: "The worktree has a detached HEAD.",
      action: { kind: "command", command: "git -C '/worktrees/child-5' status" } },
  ] };
  const view = await render(<CampaignCleanup campaignId="root-1" cleanup={legacy} canAct onOpenSession={(id) => <a href={`/sessions/${id}`}>{id}</a>} />);
  try {
    const { container } = view;
    assert.deepEqual([...container.querySelectorAll("code")].map((node) => node.textContent), ["/worktrees/child-4", "/worktrees/child-5"]);
    assert.doesNotMatch(container.textContent ?? "", /git -C|@\{upstream\}/u);
    assert.ok([...container.querySelectorAll("button")].every(node => node.textContent?.trim() === "Inspect Worktree"));
    assert.doesNotMatch(container.textContent ?? "", /Then ask the Orchestrator/u);
    assert.match(container.textContent ?? "", /Review the child's work from its session in Wollipog\./u);
  } finally { view.unmount(); }
});

test("person retirement requires inspection and explicit confirmation, sends exact state and resets after refusal", async () => {
  const originalInspect = api.inspectCampaignWorktreeRetirement, originalConfirm = api.confirmCampaignWorktreeRetirement;
  const state = { worktreeId: "tree", path: "/worktrees/child-3", registeredBranch: "fix/work", branch: "fix/work",
    headSha: "a".repeat(40), clean: true as const, pathIdentity: "1:2" };
  const calls: unknown[][] = [];
  let refuse = true;
  api.inspectCampaignWorktreeRetirement = async (...args) => { calls.push(args); return { state }; };
  api.confirmCampaignWorktreeRetirement = async (...args) => {
    calls.push(args);
    if (refuse) throw new Error("The tip changed; inspect again.");
    return { retirement: { status: "removed" } };
  };
  const view = await render(<CampaignCleanup campaignId="root-1" cleanup={{ total: 1, items: [cleanup.items[2]!] }} canAct onOpenSession={() => null} />);
  try {
    assert.equal(button(document.body, "Retire Worktree"), undefined);
    await act(async () => button(document.body, "Inspect Worktree")!.click());
    assert.deepEqual(calls[0], ["root-1", "child-3", state.path]);
    assert.equal(button(document.body, "Retire Worktree")?.disabled, true);
    assert.ok(document.body.textContent?.includes(state.headSha));
    await act(async () => document.body.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    assert.equal(button(document.body, "Retire Worktree")?.disabled, false);
    await act(async () => button(document.body, "Retire Worktree")!.click());
    assert.deepEqual(calls[1], ["root-1", "child-3", state]);
    assert.match(document.body.textContent ?? "", /The tip changed; inspect again/u);
    assert.equal(button(document.body, "Retire Worktree"), undefined);
    refuse = false;
    await act(async () => button(document.body, "Inspect Worktree")!.click());
    assert.equal(button(document.body, "Retire Worktree")?.disabled, true, "old confirmation never survives reinspection");
    await act(async () => document.body.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    await act(async () => button(document.body, "Retire Worktree")!.click());
    assert.match(document.body.textContent ?? "", /Local branch refs were kept/u);
  } finally {
    view.unmount(); api.inspectCampaignWorktreeRetirement = originalInspect; api.confirmCampaignWorktreeRetirement = originalConfirm;
  }
});

test("unproven runner ownership has a truthful next step and no unsupported inspection action", async () => {
  const view = await render(<CampaignCleanup campaignId="root-1" cleanup={{ total: 1, items: [
    { kind: "worktree", sessionId: "child-3", path: "/worktrees/child-3", status: "refused",
      reason: "Runner ownership could not be proven.", action: worktreeRefusalAction("runner ownership could not be proven") },
  ] }} canAct onOpenSession={() => <a href="/sessions/child-3">Review Child</a>} />);
  try {
    assertNoDomNode(view.container.querySelector("button"), "ownership cannot be waived by inspecting or confirming");
    assert.match(view.container.textContent ?? "", /retirement is unavailable and its contents are kept/u);
    assert.equal(view.container.querySelector("a")?.getAttribute("href"), "/sessions/child-3");
  } finally { view.unmount(); }
});

test("Delete Merged Branches is not offered without an approved deletion, or outside the campaign's own view (#4146)", async () => {
  const commandsOnly = { total: 1, items: [cleanup.items[0]!] };
  let view = await render(<CampaignCleanup campaignId="root-1" cleanup={commandsOnly} canAct onOpenSession={() => null} />);
  try {
    assertNoDomNode(button(view.container, "Delete Merged Branches") ?? null, "a branch without an approval keeps its command");
  } finally { view.unmount(); }
  view = await render(<CampaignCleanup campaignId="root-1" cleanup={cleanup} canAct={false} onOpenSession={() => null} />);
  try {
    assertNoDomNode(button(view.container, "Delete Merged Branches") ?? null, "a member's view reads only");
  } finally { view.unmount(); }
});

test("Campaign Stuck names each unfinished item and why nothing is moving (#4146)", async () => {
  const view = await render(<CampaignStuck
    stuck={{ total: 2, items: [
      { kind: "unverified_child", sessionId: "child-1", status: "idle", reason: "The child's latest report has not been verified." },
      { kind: "continuation", state: "failed", reason: "The campaign's last continuation failed." },
    ] }}
    repair={{ state: "attempted", startedAt: 1, finishedAt: 2, continuation: true }}
    onOpenSession={(id) => <a href={`/sessions/${id}`}>Fix the Merge Queue</a>} />);
  try {
    const { container } = view;
    assert.equal(container.querySelector("h3")?.textContent, "Campaign Stuck");
    assert.match(container.textContent ?? "", /Wollipog re-read the forge and woke the Orchestrator once; nothing changed\./u);
    assert.deepEqual([...container.querySelectorAll("dt")].map((node) => node.textContent), ["Unverified Child", "Continuation"]);
    assert.equal(container.querySelector("a")?.textContent, "Fix the Merge Queue");
    assert.match(container.textContent ?? "", /The child's latest report has not been verified\./u);
  } finally { view.unmount(); }
});
