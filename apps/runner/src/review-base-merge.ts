/**
 * Strict base-merge proof for review runs (#4075). A head whose only change since the last valid
 * round is one merge of the moved base branch is reviewed without using the epoch's round budget,
 * so the proof is deliberately narrow: anything it cannot establish is an ordinary commit.
 *
 * The head must be a two-parent merge whose first parent is the reviewed head and whose second is a
 * commit of the pull request's current base that the reviewed head did not already contain. Its tree
 * may differ from Git's own merge of those parents only inside the conflicted hunks Git left: a
 * clean merge must match exactly, and a resolution may rewrite each conflict block of a regular file
 * but not the text around it, nor the file's mode or type. Octopus merges, a merged parent outside the base branch, a commit after the merge, a
 * path-level conflict (rename, delete, binary) or any change outside a conflict block fail the proof.
 */
import type { ReviewBaseMerge } from "@wollipog/protocol";

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
    if (!differing) return null;
    for (const { path, oldMode, newMode, status } of differing) {
      // Only a conflicted regular file's content may change: its mode, type and presence may not.
      if (!conflicted.has(path) || status !== "M" || oldMode !== newMode || !REGULAR_FILE.test(newMode)) return null;
      const [text, resolution] = await Promise.all([
        git(["cat-file", "blob", `${automatic.tree}:${path}`]), git(["cat-file", "blob", `${head}:${path}`]),
      ]);
      if (Buffer.byteLength(text) > MAX_CONFLICTED_FILE_BYTES || Buffer.byteLength(resolution) > MAX_CONFLICTED_FILE_BYTES ||
          !resolvedWithinConflicts(text, resolution, reference, merged)) return null;
    }
    const mergeBase = async (revision: string) => (await git(["merge-base", "--end-of-options", baseSha, revision])).trim();
    const own = async (revision: string) => git(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
      "--end-of-options", await mergeBase(revision), revision]);
    const [before, after] = await Promise.all([own(reference), own(head)]);
    return before === after ? "equivalent" : "resolution";
  } catch {
    return null;
  }
}
