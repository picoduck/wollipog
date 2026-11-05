import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { OrchestratorCampaignProjection } from "@wollipog/protocol";
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
    reason: "The worktree has uncommitted changes.", action: { kind: "command", command: "git -C '/worktrees/child-3' status",
      then: "Commit and push the changes you want to keep, or discard them yourself. Then ask the Orchestrator to retire the worktree through Wollipog." } },
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
    assert.ok(codes.includes("git -C '/worktrees/child-3' status"), "a dirty worktree is inspected, never removed");
    assert.match(container.textContent ?? "", /Commit and push the changes you want to keep, or discard them yourself\./u);
    assert.doesNotMatch(container.textContent ?? "", /worktree remove|--force|reset --hard|git clean/u);
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
