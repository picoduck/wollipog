/**
 * Strict base-merge proof for review runs (#4075). A head whose only change since the last valid
 * round is one merge of the moved base branch is reviewed without using the epoch's round budget,
 * so the proof is deliberately narrow: anything it cannot establish is an ordinary commit.
 *
 * The head must be a two-parent merge whose first parent is the reviewed head and whose second is a
 * commit of the pull request's current base that the reviewed head did not already contain. Its tree
 * may differ from Git's own merge of those parents only inside the conflicted hunks Git left: a
 * clean merge must match exactly except for a proven protocol renumber (#4399). A resolution may
 * rewrite each conflict block of a regular file
 * but not the text around it, nor the file's mode or type. Octopus merges, a merged parent outside the base branch, a commit after the merge, a
 * path-level conflict (rename, delete, binary) or an unproven change outside a conflict block fail the proof.
 */
import type { ReviewBaseMerge } from "@wollipog/protocol";
import { generated, LEDGER, ledgerDelta, ledgerEntries, renumberedLedger, replaceVersion } from "./review-protocol-renumber.js";
import { BUILT_IN_SKILLS, reproduceBuiltInSkills } from "./review-generated-skills.js";

/** Git in the review mirror; a failure carries its exit status and `stdout`, as `execFile`'s does. */
export type BaseMergeGit = (args: string[]) => Promise<string>;

const SHA = /^[0-9a-f]{40}$/u;
/** Past these, the proof is not attempted and the head is an ordinary commit. */
const MAX_CONFLICTED_FILES = 64;
const MAX_CONFLICTED_FILE_BYTES = 2 * 1024 * 1024;

const REGULAR_FILE = /^100(?:644|755)$/u;

/** `output`, unless it holds U+FFFD: then an undecodable byte may hide behind it, so it throws. */
function lossless(output: string): string {
  if (output.includes("\u{FFFD}")) throw new Error("git output did not decode losslessly");
  return output;
}

/** Every path that differs between two trees, with its modes and status, or null if unparsable. */
async function rawChanges(git: BaseMergeGit, from: string, to: string):
  Promise<Array<{ path: string; oldMode: string; newMode: string; status: string }> | null> {
  const fields = (await git(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--end-of-options", from, to])).split("\0");
  if ((fields.length - 1) % 2 !== 0 || fields.at(-1) !== "") return null;
  const changes: Array<{ path: string; oldMode: string; newMode: string; status: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])$/u.exec(fields[index]!);
    const path = fields[index + 1];
    if (!header || !path) return null;
    changes.push({ path, oldMode: header[1]!, newMode: header[2]!, status: header[3]! });
  }
  return changes;
}

async function ancestor(git: BaseMergeGit, commit: string, of: string): Promise<boolean> {
  return git(["merge-base", "--is-ancestor", "--end-of-options", commit, of]).then(() => true, () => false);
}

/** Git's own merge of `ours` and `theirs` (Git 2.38+), with the paths it left conflicted. */
async function automaticMerge(git: BaseMergeGit, ours: string, theirs: string): Promise<{ tree: string; conflicted: string[] } | null> {
  let output: string;
  try {
    output = await git(["-c", "merge.conflictStyle=merge", "merge-tree", "--write-tree", "--no-messages", "--name-only", "-z", ours, theirs]);
  } catch (error) {
    // Exit status 1 is a merge with conflicts; anything else (an older Git, say) proves nothing.
    // `execFile` reports the status as `code`, `execFileSync` as `status`.
    const failed = error as { code?: unknown; status?: unknown; stdout?: unknown };
    if ((failed.code ?? failed.status) !== 1 || typeof failed.stdout !== "string") return null;
    output = failed.stdout;
  }
  const [tree, ...rest] = output.split("\0");
  return tree && SHA.test(tree) ? { tree, conflicted: rest.filter(Boolean) } : null;
}

/**
 * Whether `resolved` is `conflicted` with only its conflict blocks rewritten: the text outside every
 * `<<<<<<< ours` … `>>>>>>> theirs` block appears in `resolved`, whole and in order, from its start
 * to its end. A file with no well-formed block (a binary or path-level conflict) proves nothing.
 */
export function resolvedWithinConflicts(conflicted: string, resolved: string, ours: string, theirs: string): boolean {
  const start = `<<<<<<< ${ours}`, end = `>>>>>>> ${theirs}`;
  const clean: string[] = [];
  let current = "";
  let inside = false;
  for (const line of conflicted.split(/(?<=\n)/u)) {
    const bare = line.replace(/\r?\n$/u, "");
    if (inside) {
      if (bare === end) inside = false;
      else if (bare === start) return false;
      continue;
    }
    if (bare === end) return false;
    if (bare === start) {
      clean.push(current);
      current = "";
      inside = true;
      continue;
    }
    current += line;
  }
  if (inside || !clean.length) return false;
  clean.push(current);
  const first = clean[0]!, last = clean.at(-1)!;
  const limit = resolved.length - last.length;
  if (!resolved.startsWith(first) || !resolved.endsWith(last) || limit < first.length) return false;
  let at = first.length;
  for (const segment of clean.slice(1, -1)) {
    const found = resolved.indexOf(segment, at);
    if (found < 0 || found + segment.length > limit) return false;
    at = found + segment.length;
  }
  return true;
}

/**
 * What `head` is relative to the reviewed head `reference` on a pull request whose base is now
 * `baseSha`: `equivalent` when it is a strict base merge that leaves the pull request's own diff
 * (each changed path's mode and blobs against its merge base) byte-identical, `resolution` for any
 * other strict base merge, and null for everything else, including any failure to prove it.
 */
export async function classifyBaseMerge(raw: BaseMergeGit, reference: string, head: string, baseSha: string): Promise<ReviewBaseMerge | null> {
  if (![reference, head, baseSha].every((sha) => SHA.test(sha)) || reference === head) return null;
  // Git output arrives decoded as UTF-8, so distinct invalid bytes (in a path or in content) all
  // read as U+FFFD and would compare equal. Output that did not decode losslessly proves nothing.
  const git: BaseMergeGit = async (args) => {
    try {
      return lossless(await raw(args));
    } catch (error) {
      const failed = error as { stdout?: unknown };
      if (typeof failed.stdout === "string") lossless(failed.stdout);
      throw error;
    }
  };
  try {
    const parents = (await git(["rev-list", "--parents", "-n", "1", "--end-of-options", head])).trim().split(" ");
    if (parents.length !== 3 || parents[0] !== head || parents[1] !== reference) return null;
    const merged = parents[2]!;
    if (!SHA.test(merged) || !await ancestor(git, merged, baseSha) || await ancestor(git, merged, reference)) return null;
    const automatic = await automaticMerge(git, reference, merged);
    if (!automatic || automatic.conflicted.length > MAX_CONFLICTED_FILES) return null;
    const conflicted = new Set(automatic.conflicted);
    const differing = await rawChanges(git, automatic.tree, `${head}^{tree}`);
    if (!differing || differing.length > MAX_CONFLICTED_FILES) return null;
    const read = (revision: string, path: string) => git(["cat-file", "blob", `${revision}:${path}`]);
    const mergeBase = async (revision: string) => (await git(["merge-base", "--end-of-options", baseSha, revision])).trim();
    // Missing, unsupported or ambiguous declarations disable the relaxation, not the old proof.
    const declarations = await Promise.all([reference, head, await mergeBase(reference), merged].map(async (revision) => {
      try {
        return ledgerEntries(await read(revision, LEDGER));
      } catch { return null; }
    }));
    const [prior, current, originalBase, mergedBase] = declarations;
    const oldVersion = prior ? Math.max(...prior.entries.keys()) : 0;
    const newVersion = current ? Math.max(...current.entries.keys()) : 0;
    // A base's version advance is not a PR renumber. Both numbers must be this PR's own claims,
    // and the new entry must be exactly the old one, placed under its declared slot.
    const newEntry = current?.entries.get(newVersion);
    const renumber = prior && current && originalBase && mergedBase && newVersion > oldVersion &&
      !originalBase.entries.has(oldVersion) && !mergedBase.entries.has(newVersion) &&
      newEntry === replaceVersion(prior.entries.get(oldVersion)!, oldVersion, newVersion) &&
      (await read(head, LEDGER)).includes(`  // v${newVersion} slot\n${newEntry}`)
      ? { oldVersion, newVersion } : null;
    for (const { path, oldMode, newMode, status } of differing) {
      // Content only: modes, types, additions and deletions never receive the relaxation.
      if (status !== "M" || oldMode !== newMode || !REGULAR_FILE.test(newMode)) return null;
      const [text, resolution] = await Promise.all([
        git(["cat-file", "blob", `${automatic.tree}:${path}`]), git(["cat-file", "blob", `${head}:${path}`]),
      ]);
      if (Buffer.byteLength(text) > MAX_CONFLICTED_FILE_BYTES || Buffer.byteLength(resolution) > MAX_CONFLICTED_FILE_BYTES) return null;
      if (conflicted.has(path) && resolvedWithinConflicts(text, resolution, reference, merged)) continue;
      if (!renumber) return null;
      if (path === BUILT_IN_SKILLS) {
        const [beforeOutput, afterOutput] = await Promise.all([
          reproduceBuiltInSkills(git, automatic.tree), reproduceBuiltInSkills(git, head),
        ]);
        if (beforeOutput === text && afterOutput === resolution) continue;
        return null;
      }
      if (generated(path, text) || generated(path, resolution)) return null;
      const { oldVersion: old, newVersion: next } = renumber;
      const normalized = replaceVersion(text, old, next);
      if (path === LEDGER && renumberedLedger(text, resolution, old, next)) continue;
      if (path === LEDGER && conflicted.has(path)) {
        const prior = ledgerEntries(await read(reference, LEDGER));
        const current = ledgerEntries(resolution);
        const entry = current?.entries.get(next);
        if (entry && prior?.entries.get(old) && replaceVersion(prior.entries.get(old)!, old, next) === entry &&
            resolvedWithinConflicts(text, resolution.replace(entry, ""), reference, merged)) continue;
      }
      if (conflicted.has(path) ? resolvedWithinConflicts(normalized, resolution, reference, merged) : normalized === resolution) continue;
      return null;
    }
    const own = async (revision: string) => git(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--end-of-options", await mergeBase(revision), revision]);
    const [before, after] = await Promise.all([own(reference), own(head)]);
    if (before === after) return "equivalent";
    if (!renumber) return "resolution";
    // Compare the PR's own diff again with its renumber undone. Base-side blobs must still match;
    // any actual conflict resolution or changed base content retains a reviewer.
    const beforeFields = before.split("\0"), afterFields = after.split("\0");
    if (beforeFields.length !== afterFields.length) return "resolution";
    for (let i = 0; i + 1 < beforeFields.length; i += 2) {
      const a = /^(:\d{6} \d{6} [0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(beforeFields[i]!);
      const b = /^(:\d{6} \d{6} [0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/u.exec(afterFields[i]!);
      const path = beforeFields[i + 1]!;
      if (!a || !b || a[3] !== b[3] || path !== afterFields[i + 1]) return "resolution";
      if (path === LEDGER && a[1]!.slice(0, 14) === b[1]!.slice(0, 14)) {
        const [baseBefore, baseAfter, prior, current] = await Promise.all([
          read(await mergeBase(reference), path), read(await mergeBase(head), path), read(reference, path), read(head, path),
        ]);
        const delta = ledgerDelta(baseBefore, prior, renumber.oldVersion, renumber.newVersion);
        if (delta === null || delta !== ledgerDelta(baseAfter, current, renumber.newVersion, renumber.newVersion)) return "resolution";
        continue;
      }
      if (a[1] !== b[1]) return "resolution";
      if (a[2] === b[2]) continue;
      if (!/^:(?:000000|100(?:644|755)) 100(?:644|755) /u.test(a[1]!)) return "resolution";
      const [left, right] = await Promise.all([read(reference, path), read(head, path)]);
      if (Buffer.byteLength(left) > MAX_CONFLICTED_FILE_BYTES || Buffer.byteLength(right) > MAX_CONFLICTED_FILE_BYTES) return "resolution";
      if (path === BUILT_IN_SKILLS) {
        const [beforeOutput, afterOutput] = await Promise.all([
          reproduceBuiltInSkills(git, reference), reproduceBuiltInSkills(git, head),
        ]);
        if (beforeOutput !== left || afterOutput !== right) return "resolution";
      } else if (generated(path, left) || generated(path, right)) return "resolution";
      if (path === LEDGER ? !renumberedLedger(left, right, renumber.oldVersion, renumber.newVersion) :
          replaceVersion(left, renumber.oldVersion, renumber.newVersion) !== right) return "resolution";
    }
    return "equivalent";
  } catch {
    return null;
  }
}
