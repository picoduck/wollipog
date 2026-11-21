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

interface Widths {
  line: number;
  lifecycle: number;
  secondary?: number;
  collapsed?: number;
  strip?: number;
  /** The branch's whole width and the least it shrinks to before it clips itself. */
  branch?: { natural: number; minimum: number };
}

function statusLine(widths: Widths) {
  const document = domWindow.document;
  const line = document.createElement("span");
  line.className = "inbox-row-line inbox-row-status-line";
  const status = document.createElement("span");
  status.className = "row-status";
  status.innerHTML = `<span class="status">Running</span>${widths.secondary ? `<span class="status">Result Missing</span><span class="row-status-collapsed">+1</span>` : ""}`;
  line.append(status);
  if (widths.strip) {
    const strip = document.createElement("span");
    strip.className = "inbox-row-activity";
    line.append(strip);
  }
  let git: HTMLElement | null = null;
  let name: HTMLElement | null = null;
  if (widths.branch) {
    git = document.createElement("span") as unknown as HTMLElement;
    git.className = "inbox-row-git";
    git.innerHTML = `<span class="inbox-row-branch"><span class="inbox-row-branch-name">feat/issue-12</span></span>`;
    name = git.querySelector<HTMLElement>(".inbox-row-branch-name");
    line.append(git as never);
  }
  const fit = () => (line.dataset.fit ?? "").split(" ");
  const GAP = 8;
  /** What the fixed items take, then whatever is left over for the branch. */
  const fixed = () => {
    const drops = fit();
    const parts = [widths.lifecycle];
    if (widths.secondary) parts.push(drops.includes("badge") ? widths.collapsed! : widths.secondary);
    if (widths.strip && !drops.includes("strip")) parts.push(widths.strip);
    return parts.reduce((sum, part) => sum + part, 0) + GAP * (parts.length - 1);
  };
  const branchShown = () => widths.branch !== undefined && !fit().includes("branch");
  const branchWidth = () => {
    if (!branchShown()) return 0;
    const room = widths.line - fixed() - GAP;
    return Math.max(widths.branch!.minimum, Math.min(widths.branch!.natural, room));
  };
  const content = () => fixed() + (branchShown() ? GAP + branchWidth() : 0);
  Object.defineProperty(line, "clientWidth", { get: () => widths.line });
  Object.defineProperty(line, "scrollWidth", { get: () => Math.max(widths.line, content()) });
  if (git && name) {
    git.getBoundingClientRect = () => ({ width: branchWidth() }) as DOMRect;
    Object.defineProperty(git, "clientWidth", { get: () => branchWidth() });
    Object.defineProperty(git, "scrollWidth", { get: () => branchWidth() });
    Object.defineProperty(name, "clientWidth", { get: () => branchWidth() });
    Object.defineProperty(name, "scrollWidth", { get: () => widths.branch!.natural });
  }
  return line as unknown as HTMLElement;
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
  assert.ok(300 - (70 + 110 + 48 + 8 * 3) < STATUS_LINE_BRANCH_MIN_PX);
  assert.deepEqual(fitStatusLine(tight), ["branch"]);
  assert.equal(tight.dataset.fit, "branch");
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
