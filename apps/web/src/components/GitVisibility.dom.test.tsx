import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitStatusInfo, GitSummaryInfo } from "@wollipog/protocol";
import { deriveGitPresentation } from "../pinned-summary.js";
import { GitPinnedSection } from "./GitVisibility.js";

const domWindow = new Window({ url: "http://localhost/" });
const globals: Record<string, unknown> = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = Object.fromEntries(
  Object.keys(globals).map((name) => [name, (globalThis as Record<string, unknown>)[name]]),
);

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

after(() => {
  for (const [name, value] of Object.entries(prior)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  domWindow.close();
});

const branch = "feature/a-very-long-branch-name-that-needs-a-complete-accessible-name";
const status: GitStatusInfo = {
  branch,
  files: [],
  hasChanges: true,
  ahead: 0,
  remoteUrl: null,
  headSha: "abcdef123456",
  detached: false,
  upstreamBranch: `origin/${branch}`,
  aheadUpstream: 0,
  behindUpstream: 0,
  baseRef: "origin/main",
  worktreeKind: "linked",
  stagedCount: 1,
  modifiedCount: 1,
  untrackedCount: 0,
  conflictedCount: 1,
  operation: "rebase",
  remoteRefsAt: 1_700_000_000_000,
};
const summary: GitSummaryInfo = {
  ...status,
  behind: 231,
  addedLines: 4,
  deletedLines: 2,
  pr: null,
  checks: null,
};

function model(over: {
  online?: boolean;
  status?: GitStatusInfo | null;
  summary?: GitSummaryInfo | null;
  busy?: boolean;
  error?: string | null;
} = {}) {
  return deriveGitPresentation({
    runnerOnline: over.online ?? true,
    worktreePath: "/repo/.agent-worktrees/session-a",
    status: {
      value: over.status === undefined ? status : over.status,
      observation: 2,
      settled: true,
      busy: over.busy ?? false,
      error: over.error ?? null,
      errorCode: null,
    },
    summary: {
      value: over.summary === undefined ? summary : over.summary,
      observation: 1,
      settled: true,
      busy: over.busy ?? false,
      error: null,
      errorCode: null,
    },
  });
}

function refreshButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => /Git Status/.test(button.textContent ?? ""));
}

test("the collapsed section keeps a scannable accessible headline; details stay behind the toggle", async () => {
  domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  let refreshes = 0;
  try {
    await act(async () => root.render(
      <GitPinnedSection model={model()} onRefresh={async () => { refreshes += 1; }} />,
    ));
    const section = container.querySelector<HTMLElement>(".ps-git-section")!;
    const headingId = section.getAttribute("aria-labelledby")!;
    assert.equal(domWindow.document.getElementById(headingId)?.textContent, "Git");

    // Collapsed by default: headline facts and warnings, no detail rows, no refresh yet.
    const toggle = [...section.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Show Git Details")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(refreshButton(section), undefined);
    const headline = section.querySelector<HTMLElement>(".ps-git-headline")!;
    assert.match(headline.textContent ?? "", new RegExp(branch));
    assert.match(headline.textContent ?? "", /Linked Worktree/);
    assert.match(headline.textContent ?? "", /Dirty/);
    assert.match(headline.textContent ?? "", /Conflicts/);
    assert.match(headline.textContent ?? "", /Rebase in Progress/);
    assert.match(headline.textContent ?? "", /Main -231/);
    // The compact divergence arithmetic keeps its expanded accessible phrasing.
    assert.match(headline.textContent ?? "", /Behind Main 231/);
    assert.doesNotMatch(headline.textContent ?? "", /Remote Status May Be Stale/);
    assert.doesNotMatch(section.textContent ?? "", /1 Staged/);

    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.textContent, "Hide Git Details");
    assert.equal(section.querySelector(".ps-git-headline"), null);
    assert.match(section.textContent ?? "", /Linked Worktree/);
    assert.match(section.textContent ?? "", /1 Conflicted.*1 Staged.*1 Modified/);
    assert.match(section.textContent ?? "", /Remote Status May Be Stale/);
    assert.doesNotMatch(section.textContent ?? "", /Fetched/i);

    const refresh = refreshButton(section)!;
    assert.equal(refresh.textContent, "Refresh Git Status");
    assert.equal(refresh.hasAttribute("aria-label"), false);
    await act(async () => refresh.click());
    assert.equal(refreshes, 1);

    // Disclosure persists app-wide.
    assert.equal(domWindow.localStorage.getItem("wollipog.pinned.git.open"), "1");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  }
});

test("updating, failed, offline, and not-repository states are explicit without live-looking leakage", async () => {
  domWindow.localStorage.setItem("wollipog.pinned.git.open", "1");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <GitPinnedSection
        model={model({ status: null, summary: null, busy: true })}
        onRefresh={async () => {}}
      />,
    ));
    assert.equal(container.querySelector(".ps-git-section")?.getAttribute("aria-busy"), "true");
    assert.equal(refreshButton(container)?.disabled, true);
    assert.equal(refreshButton(container)?.textContent, "Updating Git Status");
    assert.equal(container.querySelector(".ps-git-state")?.hasAttribute("aria-live"), false);

    await act(async () => root.render(<GitPinnedSection model={model({ busy: true })} onRefresh={async () => {}} />));
    assert.equal(container.querySelector(".ps-git-section")?.getAttribute("aria-busy"), "true");
    assert.equal(refreshButton(container)?.disabled, true);
    assert.equal(refreshButton(container)?.hasAttribute("aria-label"), false);
    assert.match(container.textContent ?? "", /Updating Git Status/);
    assert.match(container.textContent ?? "", new RegExp(branch), "last-confirmed facts remain while updating");
    assert.equal(container.querySelector(".ps-git-state")?.hasAttribute("aria-live"), false);

    await act(async () => root.render(
      <GitPinnedSection model={model({ error: "transport failed" })} onRefresh={async () => {}} />,
    ));
    assert.match(container.textContent ?? "", /Refresh Failed/);
    assert.match(container.textContent ?? "", new RegExp(branch), "last-confirmed facts remain after failure");
    assert.equal(container.querySelector(".ps-git-state")?.getAttribute("aria-live"), "polite");

    await act(async () => root.render(
      <GitPinnedSection model={model({ online: false })} onRefresh={async () => {}} />,
    ));
    assert.match(container.textContent ?? "", /Git Unavailable While Disconnected/);
    assert.doesNotMatch(container.textContent ?? "", new RegExp(branch), "offline state hides old facts");

    await act(async () => root.render(
      <GitPinnedSection
        model={model({ status: null, summary: null, error: "not a git repository" })}
        onRefresh={async () => {}}
      />,
    ));
    assert.match(container.textContent ?? "", /Not a Git Repository/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  }
});

test("collapsed non-ready states keep the explicit state row without headline leakage", async () => {
  domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <GitPinnedSection model={model({ online: false })} onRefresh={async () => {}} />,
    ));
    assert.match(container.textContent ?? "", /Git Unavailable While Disconnected/);
    assert.equal(container.querySelector(".ps-git-headline"), null);
    assert.doesNotMatch(container.textContent ?? "", new RegExp(branch));

    // A failed refresh with confirmed facts keeps both the warning and the collapsed headline.
    await act(async () => root.render(
      <GitPinnedSection model={model({ error: "transport failed" })} onRefresh={async () => {}} />,
    ));
    assert.match(container.textContent ?? "", /Refresh Failed/);
    assert.match(container.querySelector(".ps-git-headline")?.textContent ?? "", new RegExp(branch));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
