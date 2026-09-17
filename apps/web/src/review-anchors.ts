/**
 * Diff identity for the review pane: which rendered content a file card is showing, and whether a
 * review finding is still attached to the line it was written against.
 *
 * The runner's `diffHash` is a whole-change-set identity — staging a hunk in one file, discarding
 * another, or the agent touching anything at all produces a new hash for every file. Comparing a
 * finding's `diffHash` to the current one therefore detaches findings whose own lines never moved,
 * and keying file cards on it throws away collapse state and unsent drafts across an unrelated
 * refresh (#1203). These helpers give both questions a per-anchor answer instead.
 *
 * {@link changeSetSignature} answers the third identity question in the same pane: whether the
 * shared status reader has observed a change set the loaded diff does not describe yet (#1204).
 *
 * Pure + framework-free so it unit-tests with `node:test`.
 */

import type {
  GitDiffFile,
  GitDiffInfo,
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
 * Best-effort by construction: an in-place edit that keeps a file's path, status, and line totals
 * identical is invisible here, exactly as it is invisible in the header this keeps the diff
 * agreeing with.
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
 * A digest of everything a file card renders from its own content — its change kind, rename source,
 * and every hunk header and patch line.
 *
 * Used as the file card's React key so that a refresh which did not touch this file reuses the same
 * card, preserving its collapse state, "show all hunks" toggle, and per-hunk line selections, while
 * a file whose content really did change still gets a fresh card (its hunks were renumbered, so a
 * carried-over line selection would point at different text).
 *
 * `staged` is deliberately excluded: staging a hunk flips that flag without changing a single line
 * of the combined diff, and it must not collapse the card the user is working in. The canonical
 * staged/unstaged panes carry the same movement as an actual content change, which this digest does
 * see, so nothing is lost by ignoring the flag.
 */
export function diffFileContentKey(file: GitDiffFile): string {
  let hash = foldField(0x811c9dc5, file.status);
  hash = foldField(hash, file.oldPath ?? "");
  hash = foldField(hash, file.binary ? "binary" : "text");
  let lines = 0;
  for (const hunk of file.hunks) {
    hash = foldField(hash, hunk.header);
    for (const line of hunk.lines) {
      hash = foldField(hash, line.status);
      hash = foldField(hash, line.text);
      lines += 1;
    }
  }
  // Length fields alongside the digest: a 32-bit hash is ample for picking React keys apart, and
  // the counts make the common shape-changing edits collision-proof rather than merely unlikely.
  return `${hash.toString(16)}.${file.hunks.length}.${lines}`;
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
 * A finding is anchored when either it was authored against this exact diff, or it was anchored a
 * moment ago and the text at its anchor is byte-identical in the previous diff and this one. That
 * makes "Stale Diff Anchor" mean what it says — the anchored content actually changed — instead of
 * firing on every unrelated hash change (#1203).
 *
 * Idempotent in `previous`: re-running it on its own output returns the same set, so it is safe to
 * call during render (where React may invoke the render twice) rather than in an effect that would
 * paint one frame of wrongly-stale findings first.
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
    if (!carry?.anchored.has(finding.findingId)) continue;
    const key = diffAnchorKey(finding);
    const before = carry.index.get(key);
    if (before !== undefined && before === index.get(key)) anchored.add(finding.findingId);
  }
  return { lineage, hash: diff.diffHash, index, anchored };
}
