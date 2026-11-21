import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { fitStatusLine, STATUS_LINE_BRANCH_MIN_PX } from "./status-line-fit.js";

/**
 * The give-way order of a phone card's status line (#4791), with the geometry stubbed: happy-dom lays
 * nothing out, so each case says how wide the line is and what each item needs, and the stub answers
 * the measurements `fitStatusLine()` takes from what `data-fit` currently hides. The real layout is
 * covered by `inbox-row-layout.spec.ts`.
 */
const domWindow = new Window({ url: "http://localhost/" });
const GAP = 8;

interface Widths {
  line: number;
  lifecycle: number;
  secondary?: number;
  collapsed?: number;
  strip?: number;
  /** The branch's whole width and the least it shrinks to before its group clips it. */
  branch?: { natural: number; minimum: number };
  /** A pull request that needs the person (#604): its whole width and its ellipsized floor. */
  pr?: { natural: number; minimum: number };
}

function statusLine(widths: Widths) {
  const document = domWindow.document;
  const line = document.createElement("span") as unknown as HTMLElement;
  line.className = "inbox-row-line inbox-row-status-line";
  const status = document.createElement("span");
  status.className = "row-status";
  status.innerHTML = `<span class="status">Running</span>${widths.secondary ? `<span class="status">Result Missing</span><span class="row-status-collapsed">+1</span>` : ""}`;
  line.append(status as never);
  if (widths.strip) {
    const strip = document.createElement("span");
    strip.className = "inbox-row-activity";
    line.append(strip as never);
  }
  const drops = () => (line.dataset.fit ?? "").split(" ");
  const branchShown = () => widths.branch !== undefined && !drops().includes("branch");
  const prGap = () => (widths.pr ? GAP + widths.pr.natural : 0);
  /** What the items before the Git group take. */
  const fixed = () => {
    const parts = [widths.lifecycle];
    if (widths.secondary) parts.push(drops().includes("badge") ? widths.collapsed! : widths.secondary);
    if (widths.strip && !drops().includes("strip")) parts.push(widths.strip);
    return parts.reduce((sum, part) => sum + part, 0) + GAP * (parts.length - 1);
  };
  const room = () => widths.line - fixed() - GAP;
  /** The Git group: it shrinks to nothing while it holds the branch, and to the pull request's floor
      once the `pr` step lets that end in an ellipsis; otherwise it is as wide as what it holds. */
  const gitWidth = () => {
    if (branchShown()) return Math.max(0, Math.min(widths.branch!.natural + prGap(), room()));
    if (!widths.pr) return 0;
    return drops().includes("pr") ? Math.max(widths.pr.minimum, Math.min(widths.pr.natural, room())) : widths.pr.natural;
  };
  const gitContent = () => (branchShown() ? widths.branch!.minimum + prGap() : gitWidth());
  const branchWidth = () => (branchShown() ? Math.max(widths.branch!.minimum, gitWidth() - prGap()) : 0);
  const gitShown = () => branchShown() || widths.pr !== undefined;
  const content = () => fixed() + (gitShown() ? GAP + Math.max(gitWidth(), branchShown() ? 0 : gitContent()) : 0);
  Object.defineProperty(line, "clientWidth", { get: () => widths.line });
  Object.defineProperty(line, "scrollWidth", { get: () => Math.max(widths.line, content()) });
  if (widths.branch) {
    const git = document.createElement("span") as unknown as HTMLElement;
    git.className = "inbox-row-git";
    git.innerHTML = `<span class="inbox-row-branch"><span class="inbox-row-branch-name">feat/issue-12</span></span>${
      widths.pr ? `<span class="inbox-row-pr"><span class="status">Dequeued: Failed Checks</span></span>` : ""}`;
    line.append(git as never);
    const branch = git.querySelector<HTMLElement>(".inbox-row-branch")!;
    const name = git.querySelector<HTMLElement>(".inbox-row-branch-name")!;
    git.getBoundingClientRect = () => ({ width: gitWidth() }) as DOMRect;
    Object.defineProperty(git, "clientWidth", { get: () => gitWidth() });
    Object.defineProperty(git, "scrollWidth", { get: () => Math.max(gitWidth(), gitContent()) });
    branch.getBoundingClientRect = () => ({ width: branchWidth() }) as DOMRect;
    Object.defineProperty(name, "clientWidth", { get: () => branchWidth() });
    Object.defineProperty(name, "scrollWidth", { get: () => widths.branch!.natural });
  }
  return line;
}

const BRANCH = { natural: 190, minimum: 0 };

test("a line that fits keeps everything and records no fit", () => {
  const line = statusLine({ line: 400, lifecycle: 70, secondary: 110, strip: 48, branch: BRANCH });
  assert.deepEqual(fitStatusLine(line), []);
  assert.equal(line.hasAttribute("data-fit"), false);
});

test("the branch ellipsizes first, and leaves only once it would be cut below the minimum", () => {
  const roomy = statusLine({ line: 340, lifecycle: 70, secondary: 110, strip: 48, branch: BRANCH });
  assert.deepEqual(fitStatusLine(roomy), [], "a cut branch wider than the minimum stays, ellipsized");
  const tight = statusLine({ line: 300, lifecycle: 70, secondary: 110, strip: 48, branch: BRANCH });
  assert.ok(300 - (70 + 110 + 48 + GAP * 3) < STATUS_LINE_BRANCH_MIN_PX);
  assert.deepEqual(fitStatusLine(tight), ["branch"]);
  assert.equal(tight.dataset.fit, "branch");
});

test("the cutoff measures the branch itself, not the group a pull request label widens", () => {
  // The group is 62 + 8 + 40 = 110px, well over the cutoff, while the cut branch in it is only 62px.
  const line = statusLine({ line: 244, lifecycle: 70, strip: 48, branch: { natural: 190, minimum: 0 },
    pr: { natural: 40, minimum: 40 } });
  assert.deepEqual(fitStatusLine(line), ["branch"]);
});

test("a short branch that fits whole stays, however narrow it is", () => {
  const line = statusLine({ line: 300, lifecycle: 70, secondary: 110, strip: 48, branch: { natural: 36, minimum: 0 } });
  assert.deepEqual(fitStatusLine(line), []);
});

test("then the strip hides, then the secondary folds into its count; the lifecycle always stays", () => {
  assert.deepEqual(fitStatusLine(statusLine({ line: 230, lifecycle: 70, secondary: 110, strip: 48, branch: BRANCH })),
    ["branch", "strip"]);
  const narrow = statusLine({ line: 150, lifecycle: 70, secondary: 110, collapsed: 18, strip: 48, branch: BRANCH });
  assert.deepEqual(fitStatusLine(narrow), ["branch", "strip", "badge"]);
  assert.equal(narrow.dataset.fit, "branch strip badge");
});

test("a pull request that needs the person outlives its branch, and ends in an ellipsis only last", () => {
  const roomy = statusLine({ line: 350, lifecycle: 70, secondary: 110, collapsed: 18, strip: 48, branch: BRANCH,
    pr: { natural: 150, minimum: 50 } });
  assert.deepEqual(fitStatusLine(roomy), ["branch", "strip"], "the whole warning fits once the strip goes");
  const narrow = statusLine({ line: 230, lifecycle: 100, secondary: 140, collapsed: 18, strip: 48, branch: BRANCH,
    pr: { natural: 150, minimum: 50 } });
  assert.deepEqual(fitStatusLine(narrow), ["branch", "strip", "badge", "pr"]);
});

test("a line without a branch or a strip goes straight to folding the badge", () => {
  assert.deepEqual(fitStatusLine(statusLine({ line: 150, lifecycle: 70, secondary: 110, collapsed: 18 })), ["badge"]);
});

test("re-fitting starts from scratch, so a wider line gets everything back", () => {
  const widths: Widths = { line: 150, lifecycle: 70, secondary: 110, collapsed: 18, strip: 48, branch: BRANCH };
  const line = statusLine(widths);
  assert.equal(fitStatusLine(line).length, 3);
  widths.line = 420;
  assert.deepEqual(fitStatusLine(line), []);
  assert.equal(line.hasAttribute("data-fit"), false);
});
