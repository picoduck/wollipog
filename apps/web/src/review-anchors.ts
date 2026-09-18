/**
 * Diff identity for the review pane: which rendered content a file card is showing, and whether a
 * review finding is still attached to the line it was written against.
 *
 * The runner's `diffHash` is a whole-change-set identity — staging a hunk in one file, discarding
 * another, or the agent touching anything at all produces a new hash for every file. Comparing a
 * finding's `diffHash` to the current one therefore detaches findings whose own lines never moved,
 * and keying the rendered cards on it throws away collapse state and unsent drafts across an
 * unrelated refresh (#1203). These helpers answer both questions per hunk and per anchor instead.
 *
 * A finding also carries the text of the line it was written against, so that answer survives a
 * page reload, a second tab, and a sync to another device — none of which hold this client's
 * anchor history (#1286).
 *
 * {@link changeSetSignature} answers the third identity question in the same pane: whether the
 * shared status reader has observed a change set the loaded diff does not describe yet (#1204).
 *
 * Pure + framework-free so it unit-tests with `node:test`.
 */

import type {
  GitDiffInfo,
  GitHunk,
  GitStatusInfo,
  ReviewFinding,
  ReviewFindingSide,
} from "@wollipog/protocol";
import { buildDiffHunkRows } from "./diff-view.js";

/** Where a review comment attaches: the file, the diff side, and that side's line number. */
export interface DiffAnchor {
  filePath: string;
  side: ReviewFindingSide;
  line: number;
}

/**
 * NUL, not a printable separator: a path may contain any byte except NUL and `/`, so `a\nb:1` and
 * `a:1\nb` cannot collide into one key.
 */
const SEP = "\u0000";

/** Stable string identity for one anchor, safe to use as a Map key or a React key fragment. */
export function diffAnchorKey(anchor: DiffAnchor): string {
  return `${anchor.side}${SEP}${anchor.line}${SEP}${anchor.filePath}`;
}

/**
 * An identity for the change set the status reader last observed, or null when it has not reported.
 *
 * Everything the Review header and file list project, plus the working-tree line totals and HEAD,
 * so that a status observation which changed nothing visible costs no diff request while one that
 * moved the change set does trigger a re-read (#1204). `filesTruncated` is included because the
 * file list is capped for transport: two different truncated sets share a length, and the counts
 * around them are what distinguish them.
 *
 * Every one of those facts describes the change set's SHAPE, so together they still could not see
 * an in-place edit that rewrites a line without adding, removing, or staging anything (#1285).
 * `contentSignature` is the runner's content identity for the same uncommitted diff and closes
 * that gap. A pre-v165 runner omits it and a v165 runner reports null when it declined to hash a
 * very large change set; both fold to a constant here, leaving the shape-only comparison the
 * signature has always made rather than a wrong answer.
 */
export function changeSetSignature(status: GitStatusInfo | null | undefined): string | null {
  if (!status) return null;
  return [
    status.branch,
    status.headSha ?? "",
    status.ahead,
    status.hasChanges ? "1" : "0",
    status.stagedCount ?? "",
    status.addedLines ?? "",
    status.deletedLines ?? "",
    status.contentSignature ?? "",
    status.filesTruncated ? "1" : "0",
    status.files.length,
    ...status.files.map((file) => `${file.status}${SEP}${file.path}`),
  ].join("\u0001");
}

/** Anchor key → the exact text of the line that anchor points at, for one rendered diff. */
export type DiffAnchorIndex = ReadonlyMap<string, string>;

/**
 * Every anchor the viewer can attach a comment to in `diff`, mapped to its line's text.
 *
 * Both layouts are covered, because both can author a finding. Unified rows anchor deletions left
 * and additions/context right ({@link buildDiffHunkRows}); the split layout additionally offers a
 * left-side anchor on every context row, numbered from the old gutter — so context lines get both
 * entries here, exactly as `buildSplitDiffRows` presents them.
 */
export function buildDiffAnchorIndex(diff: GitDiffInfo): DiffAnchorIndex {
  const index = new Map<string, string>();
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const row of buildDiffHunkRows(hunk)) {
        index.set(diffAnchorKey({ filePath: file.path, ...row.anchor }), row.text);
        if (row.status === " ") {
          index.set(diffAnchorKey({ filePath: file.path, side: "left", line: Number(row.oldNo) }), row.text);
        }
      }
    }
  }
  return index;
}

/** FNV-1a over one field, NUL-terminated so field boundaries cannot be re-cut ("ab"+"c" ≠ "a"+"bc"). */
function foldField(hash: number, field: string): number {
  let next = hash;
  for (let i = 0; i <= field.length; i++) {
    next ^= i === field.length ? 0 : field.charCodeAt(i);
    next = Math.imul(next, 0x01000193);
  }
  return next >>> 0;
}

/**
 * A digest of one hunk's rendered content — its `@@` header and every patch line.
 *
 * Used as the hunk's React key, which is the level the reset actually belongs at. The state that
 * *must* die when content moves is per-hunk: `selectedLines` indexes into `hunk.lines`, and
 * `selectedReferenceLines` holds line numbers from this hunk's gutters. Keying a whole file card on
 * a file-wide digest would throw that away correctly but would also rebuild every other hunk of the
 * file, including an open draft editor — which then loses focus and caret every time the agent
 * touches any other part of the same file. Per-hunk keys reset exactly what moved.
 *
 * Two hunks of one file can never collide: `header` carries `@@ -a,b +c,d @@`, so distinct hunks
 * differ in it by construction, and React keys only need to be unique among siblings.
 *
 * `staged` is deliberately excluded: staging a hunk flips that flag without changing a single line
 * of the combined diff, and it must not rebuild the hunk the user is working in. The canonical
 * staged/unstaged panes carry real content movement, which this digest does see.
 */
export function diffHunkContentKey(hunk: GitHunk): string {
  let hash = foldField(0x811c9dc5, hunk.header);
  let lines = 0;
  for (const line of hunk.lines) {
    hash = foldField(hash, line.status);
    hash = foldField(hash, line.text);
    lines += 1;
  }
  // A length field alongside the digest: a 32-bit hash is ample for picking React keys apart, and
  // the count makes the common shape-changing edits collision-proof rather than merely unlikely.
  return `${hash.toString(16)}.${lines}`;
}

/**
 * Which findings are still attached to the diff on screen, carried forward across refreshes.
 *
 * `lineage` identifies the change-set the anchors belong to — the diff scope plus the index pane.
 * Anchors are never carried between lineages: pane-local anchor identities exist precisely so a
 * finding authored against the staged pane is not re-attached to the same numeric line of the
 * unstaged one.
 */
export interface FindingAnchorState {
  lineage: string;
  /** `diffHash` of the diff this state was computed against. */
  hash: string;
  index: DiffAnchorIndex;
  /** `findingId`s whose anchored line is unchanged, and which therefore render inline. */
  anchored: ReadonlySet<string>;
}

/**
 * Re-anchor `findings` against `diff`, carrying `previous`'s conclusions where the line did not move.
 *
 * A finding is anchored when any of three things holds:
 *
 * 1. it was authored against this exact diff;
 * 2. it stored the text of the line it was written against, and the diff on screen still has that
 *    exact text at that file, side and line (#1286);
 * 3. failing both — it has no stored text — it was anchored a moment ago and the text at its anchor
 *    is byte-identical in the previous diff and this one (#1203).
 *
 * Together those make "Stale Diff Anchor" mean what it says — the anchored content actually changed
 * — instead of firing on every unrelated hash change.
 *
 * Rule 2 is what survives a reload. The carried chain of rule 3 proves the same thing by induction
 * (each step demands byte-equality with the step before, which began at the authoring text), but it
 * lives only in this client's memory: a reload, a second tab, or another device starts with no
 * `previous` at all and used to fall back to hash equality, marking untouched lines stale (#1286).
 * A finding that stored its text therefore ignores the chain entirely and asks the diff directly,
 * which also makes the verdict identical with and without client-side history — and lets a line
 * that was edited and then restored re-anchor, because its content is once again what was reviewed.
 *
 * Idempotent in `previous`: re-running it on its own output returns the same set. That is what lets
 * the caller derive it during render — avoiding an effect that would paint one frame of
 * wrongly-stale findings first — while {@link reanchorFindingStore} keeps the result in React state
 * so an interrupted render cannot leave a conclusion behind.
 */
export function reanchorFindings(
  previous: FindingAnchorState | null,
  diff: GitDiffInfo,
  lineage: string,
  findings: readonly ReviewFinding[],
): FindingAnchorState {
  const carry = previous && previous.lineage === lineage ? previous : null;
  // Rebuilding the index is the only O(diff) step here; an unchanged hash reuses it so that
  // re-renders driven by unrelated panel state stay cheap.
  const index = carry && carry.hash === diff.diffHash ? carry.index : buildDiffAnchorIndex(diff);
  const anchored = new Set<string>();
  for (const finding of findings) {
    if (finding.diffHash === diff.diffHash) {
      anchored.add(finding.findingId);
      continue;
    }
    const key = diffAnchorKey(finding);
    const now = index.get(key);
    // `undefined` is "this anchor is not in the diff on screen" — never a match, and the reason a
    // stored empty line (a real, anchorable value) must be compared with `!==`, not truthiness.
    if (now === undefined) continue;
    if (finding.anchorText !== undefined) {
      // Scope is tested explicitly here and nowhere else in this loop: the other two rules carry it
      // implicitly — a matching `diffHash` is one scope's snapshot, and the carry belongs to one
      // lineage — while stored text is compared against whatever diff is on screen. Without this, a
      // branch-scoped finding would render inline in the uncommitted pane whenever the two happened
      // to show the same line.
      if (finding.scope === diff.scope && finding.anchorText === now) anchored.add(finding.findingId);
      continue;
    }
    if (!carry?.anchored.has(finding.findingId)) continue;
    const before = carry.index.get(key);
    if (before !== undefined && before === now) anchored.add(finding.findingId);
  }
  return { lineage, hash: diff.diffHash, index, anchored };
}

/**
 * Every lineage's anchor state, retained side by side.
 *
 * One slot per lineage rather than one slot overall, because a lineage the user leaves and comes
 * back to must still know what it had carried. With a single slot, `combined@H1 → combined@H2 →
 * staged → combined@H2` loses the carry when the staged pane overwrites it, and a finding authored
 * against `H1` is reported stale on returning to an unchanged `H2`. Bounded by construction: three
 * scopes times three panes.
 */
export type FindingAnchorStore = ReadonlyMap<string, FindingAnchorState>;

export const EMPTY_FINDING_ANCHOR_STORE: FindingAnchorStore = new Map<string, FindingAnchorState>();

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const member of left) if (!right.has(member)) return false;
  return true;
}

/**
 * Re-anchor one lineage inside `store`, returning `store` itself when nothing observable moved.
 *
 * Referential stability is the contract: the caller derives this during render and commits it with
 * `setState`, so returning a fresh Map for an unchanged result would loop forever. Keeping this in
 * React state rather than a ref is also what makes it safe under an interrupted render — an
 * abandoned render's conclusions are abandoned with it, instead of persisting in a ref and being
 * read as the starting point for a render of a diff that was never replaced.
 */
export function reanchorFindingStore(
  store: FindingAnchorStore,
  diff: GitDiffInfo,
  lineage: string,
  findings: readonly ReviewFinding[],
): FindingAnchorStore {
  const previous = store.get(lineage) ?? null;
  const next = reanchorFindings(previous, diff, lineage, findings);
  if (previous && previous.hash === next.hash && previous.index === next.index &&
    sameMembers(previous.anchored, next.anchored)) return store;
  const updated = new Map(store);
  updated.set(lineage, next);
  return updated;
}
