import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitStatusInfo, GitSummaryInfo } from "@wollipog/protocol";
import { deriveGitPresentation } from "../pinned-summary.js";
import { GitPinnedSection } from "./GitVisibility.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

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

function refreshButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Refresh Git Status"]');
}

function detailsTrigger(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>("button.disclosure-trigger")]
    .find((button) => button.textContent === "Git Details") ?? null;
}

/** Each row as "label | value", in order. */
function rowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".ps-row")].map((row) =>
    [...row.children].filter((part) => part.classList.contains("k") || part.classList.contains("v"))
      .map((part) => part.textContent).join(" | "));
}

async function render(node: React.ReactElement) {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    rerender: (next: React.ReactElement) => act(async () => root.render(next)),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the Git section states the branch with its folder kind, attention rows, then Git Details", async () => {
  domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  let refreshes = 0;
  const view = await render(
    <GitPinnedSection
      model={model()}
      onRefresh={async () => { refreshes += 1; }}
      folderPath="/repo/.agent-worktrees/session-a"
      remote={{ url: "git@github.com:picoduck/wollipog.git", href: "https://github.com/picoduck/wollipog" }}
      checkedAt={Date.now()}
    >
      <div className="child-row">Changes</div>
    </GitPinnedSection>,
  );
  try {
    const section = view.container.querySelector<HTMLElement>("section.ps-sec")!;
    const heading = domWindow.document.getElementById(section.getAttribute("aria-labelledby")!);
    assert.equal(heading?.tagName, "H3");
    assert.equal(heading?.textContent, "Git");

    // Refresh is a 28px icon button in the section head, named for what it does.
    const refresh = refreshButton(section)!;
    assert.ok(refresh.classList.contains("icon-btn") && refresh.classList.contains("sm"));
    assert.ok(refresh.parentElement?.classList.contains("ps-head"));
    assert.ok(refresh.querySelector("svg"));
    await act(async () => refresh.click());
    assert.equal(refreshes, 1);

    // The long branch is the label and truncates; the folder's kind is the short value. Each state
    // that needs attention has its own row. No dot-joined headline, no text toggles.
    assert.deepEqual(rowTexts(section), [
      `${branch} | Worktree`,
      "Rebase in Progress",
      "Conflicts | 1",
    ]);
    assert.ok(section.querySelector(".ps-row.long-k"), "the branch row truncates its label, not its value");
    assert.equal(section.querySelector(".child-row")?.textContent, "Changes", "the caller's rows follow");
    assertNoDomNode(section.querySelector(".ps-git-headline"));
    assertNoDomNode(section.querySelector(".ps-git-toggle"));
    assert.doesNotMatch(section.textContent ?? "", /[·▸▾]/u, "no separators or text glyphs");

    // Git Details: the shared disclosure, closed by default, its chevron an icon.
    const trigger = detailsTrigger(section)!;
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.ok(trigger.parentElement?.classList.contains("disclosure"));
    assert.ok(trigger.querySelector("svg.disclosure-chevron"));
    assertNoDomNode(section.querySelector("dl.facts"));

    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const facts = section.querySelector<HTMLElement>("dl.facts")!;
    const pairs = [...facts.children].map((pair) => [
      pair.querySelector("dt")?.textContent,
      pair.querySelector("dd")?.textContent,
    ]);
    assert.deepEqual(pairs, [
      ["Branch", branch],
      ["Commit", "abcdef123456"],
      ["Base", "origin/main"],
      ["Linked Worktree", "/repo/.agent-worktrees/session-a"],
      ["Upstream", `origin/${branch}`],
      ["Sync", "231 behind origin/mainIn sync with upstream"],
      ["Working Tree", "1 conflicted, 1 staged, 1 modified"],
      ["Remote", "https://github.com/picoduck/wollipog"],
      ["Remote Refs", "Updated 2023-11-14 22:13 UTC"],
      ["Checked", "just now"],
    ]);
    assert.equal(facts.querySelector("dd a")?.getAttribute("href"), "https://github.com/picoduck/wollipog",
      "the Sources section merges in as the remote's link");
    assert.doesNotMatch(facts.textContent ?? "", /Fetched/i);

    // Disclosure persists app-wide.
    assert.equal(domWindow.localStorage.getItem("wollipog.pinned.git.open"), "1");
  } finally {
    await view.unmount();
    domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  }
});

test("a primary checkout says so, and its folder is a Folder fact", async () => {
  domWindow.localStorage.setItem("wollipog.pinned.git.open", "1");
  const primary = { ...status, worktreeKind: "primary" as const, operation: null, conflictedCount: 0 };
  const view = await render(
    <GitPinnedSection
      model={model({ status: primary, summary: { ...summary, ...primary } })}
      onRefresh={async () => {}}
      folderPath="/repo"
    />,
  );
  try {
    assert.deepEqual(rowTexts(view.container), [`${branch} | Primary Checkout`]);
    const terms = [...view.container.querySelectorAll("dl.facts dt")].map((term) => term.textContent);
    assert.ok(terms.includes("Folder"));
    assert.ok(!terms.includes("Linked Worktree"));
  } finally {
    await view.unmount();
    domWindow.localStorage.removeItem("wollipog.pinned.git.open");
  }
});

test("updating, failed, offline, and not-repository states are explicit without live-looking leakage", async () => {
  const view = await render(
    <GitPinnedSection model={model({ status: null, summary: null, busy: true })} onRefresh={async () => {}} />,
  );
  const section = () => view.container.querySelector<HTMLElement>("section.ps-sec")!;
  try {
    assert.equal(section().getAttribute("aria-busy"), "true");
    assert.equal(refreshButton(view.container)?.disabled, true);
    assert.match(view.container.textContent ?? "", /Loading Git Status/);
    assert.equal(view.container.querySelector(".ps-git-state")?.hasAttribute("aria-live"), false);
    assertNoDomNode(detailsTrigger(view.container));

    await view.rerender(<GitPinnedSection model={model({ busy: true })} onRefresh={async () => {}} />);
    assert.equal(section().getAttribute("aria-busy"), "true");
    assert.equal(refreshButton(view.container)?.disabled, true);
    assert.match(view.container.textContent ?? "", /Updating Git Status/);
    assert.match(view.container.textContent ?? "", new RegExp(branch), "last-confirmed facts remain while updating");
    assert.equal(view.container.querySelector(".ps-git-state")?.hasAttribute("aria-live"), false);

    await view.rerender(<GitPinnedSection model={model({ error: "transport failed" })} onRefresh={async () => {}} />);
    assert.match(view.container.textContent ?? "", /Refresh Failed/);
    assert.match(view.container.textContent ?? "", new RegExp(branch), "last-confirmed facts remain after failure");
    assert.equal(view.container.querySelector(".ps-git-state")?.getAttribute("aria-live"), "polite");
    assert.equal(refreshButton(view.container)?.disabled, false);

    await view.rerender(<GitPinnedSection model={model({ online: false })} onRefresh={async () => {}} />);
    assert.match(view.container.textContent ?? "", /Git Unavailable While Disconnected/);
    assert.doesNotMatch(view.container.textContent ?? "", new RegExp(branch), "offline state hides old facts");
    assert.equal(refreshButton(view.container)?.disabled, true);
    assertNoDomNode(detailsTrigger(view.container));

    // The session record's worktree still names the branch while no Git read can.
    await view.rerender(
      <GitPinnedSection
        model={model({ online: false })}
        onRefresh={async () => {}}
        branchFallback={{ name: "fix/recorded", kind: "Worktree" }}
      />,
    );
    assert.deepEqual(rowTexts(view.container), ["fix/recorded | Worktree"]);

    await view.rerender(
      <GitPinnedSection
        model={model({ status: null, summary: null, error: "not a git repository" })}
        onRefresh={async () => {}}
      />,
    );
    assert.match(view.container.textContent ?? "", /Not a Git Repository/);
  } finally {
    await view.unmount();
  }
});

test("a legacy runner shows its branch and remote without repository facts it cannot report", async () => {
  const view = await render(
    <GitPinnedSection
      model={model()}
      rich={false}
      onRefresh={async () => {}}
      remote={{ url: "git@github.com:example/project.git", href: "https://github.com/example/project" }}
      branchFallback={{ name: "fix/legacy", kind: "Worktree" }}
    />,
  );
  try {
    assert.deepEqual(rowTexts(view.container), ["fix/legacy | Worktree", "Remote | github.com/example/project"]);
    const remote = [...view.container.querySelectorAll<HTMLAnchorElement>("a.ps-row")].find((row) => row.textContent?.includes("Remote"));
    assert.equal(remote?.getAttribute("href"), "https://github.com/example/project");
    assertNoDomNode(detailsTrigger(view.container));
    assert.doesNotMatch(view.container.textContent ?? "", /Rebase in Progress|Conflicts/);
  } finally {
    await view.unmount();
  }
});
