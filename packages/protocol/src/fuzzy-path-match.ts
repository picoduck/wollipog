/**
 * Go to File's fuzzy path matching (#1263), shared so the runner keeps the same best matches under
 * its result cap that the dashboard then ranks and underlines. A query matches a root-relative path
 * when its characters appear in order, ignoring case and whitespace: "sdtsx" finds
 * "apps/web/src/components/SessionDetail.tsx". The score prefers characters that start a path
 * segment or a word, consecutive runs, and the file name over its folders.
 *
 * The runner scores up to its whole visit cap (20,000 entries) synchronously, so the alignment
 * allocates nothing per path beyond the folded text and keeps no back-pointers unless asked.
 */

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTEND = -1;
const BONUS_CONSECUTIVE = 5;
const BONUS_SEGMENT = 10;
const BONUS_WORD = 8;
const BONUS_CAMEL = 7;
const BONUS_NAME = 4;
const FIRST_CHARACTER_MULTIPLIER = 2;
/** Every character in the file name: quick open is mostly typing a file's name. */
const NAME_ONLY = 40;
const NAME_EXACT = 64;
const NAME_PREFIX = 24;
/** Above this many cells the best alignment is not searched; matches are pushed toward the end. */
const MAX_ALIGNMENT_CELLS = 65_536;
const NONE = -1e9;

export interface FuzzyPathMatch {
  score: number;
  /** UTF-16 offsets in the path of each matched query character, ascending. */
  positions: number[];
}

/** The query as matched: lower case, without whitespace. An empty needle matches nothing. */
export function fuzzyPathNeedle(query: string): string {
  return foldCase(query.replace(/\s+/g, ""));
}

/**
 * Alignment work a caller allows across many paths, in cells (query length × path length). Once it
 * runs out, each further path takes the cheap placement that pushes its characters toward the end,
 * so scoring a whole traversal stays linear in its size whatever the query.
 */
export interface FuzzyAlignmentBudget {
  cells: number;
}

/** The match's score, or null when `needle` (from `fuzzyPathNeedle`) is not in `path` in order. */
export function fuzzyPathScore(path: string, needle: string, budget?: FuzzyAlignmentBudget): number | null {
  return align(path, needle, false, budget)?.score ?? null;
}

/** The match's score and the matched offsets, for underlining. */
export function fuzzyPathMatch(path: string, needle: string): FuzzyPathMatch | null {
  return align(path, needle, true);
}

/** Lower case one UTF-16 unit at a time, so offsets in the folded text are offsets in the original. */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = "";
  for (const unit of text.split("")) {
    const unitLower = unit.toLowerCase();
    folded += unitLower.length === 1 ? unitLower : unit;
  }
  return folded;
}

function isLower(code: number): boolean {
  if (code < 128) return code >= 97 && code <= 122;
  const unit = String.fromCharCode(code);
  return unit !== unit.toUpperCase() && unit === unit.toLowerCase();
}

function isUpper(code: number): boolean {
  if (code < 128) return code >= 65 && code <= 90;
  const unit = String.fromCharCode(code);
  return unit !== unit.toLowerCase() && unit === unit.toUpperCase();
}

function bonusAt(path: string, index: number, nameStart: number): number {
  const name = index >= nameStart ? BONUS_NAME : 0;
  const previous = index === 0 ? 47 : path.charCodeAt(index - 1);
  if (previous === 47) return BONUS_SEGMENT + name; // "/"
  if (previous === 45 || previous === 95 || previous === 46 || previous === 32) return BONUS_WORD + name; // "-_. "
  const current = path.charCodeAt(index);
  const digit = current >= 48 && current <= 57;
  if ((isLower(previous) && isUpper(current)) || (digit && (isLower(previous) || isUpper(previous)))) {
    return BONUS_CAMEL + name;
  }
  return name;
}

/** The better of the match within the whole path and, with a bonus, within the file name alone. */
function align(path: string, needle: string, withPositions: boolean, budget?: FuzzyAlignmentBudget): FuzzyPathMatch | null {
  if (needle.length === 0 || needle.length > path.length) return null;
  const haystack = foldCase(path);
  const nameStart = path.lastIndexOf("/") + 1;
  const inPath = alignFrom(path, haystack, needle, 0, nameStart, withPositions, budget);
  if (!inPath) return null;
  const inName = nameStart === 0 ? inPath : alignFrom(path, haystack, needle, nameStart, nameStart, withPositions, budget);
  const best = inName && inName.score + NAME_ONLY >= inPath.score
    ? { score: inName.score + NAME_ONLY, positions: inName.positions }
    : inPath;
  const name = haystack.slice(nameStart);
  best.score += name === needle ? NAME_EXACT : name.startsWith(needle) ? NAME_PREFIX : 0;
  return best;
}

// Scratch rows reused across calls; matching is synchronous, so no two calls share them at once.
let scores = [new Float64Array(256), new Float64Array(256)];
let runs = [new Int32Array(256), new Int32Array(256)];
let earliest = new Int32Array(64);
let latest = new Int32Array(64);

function reserve(n: number, m: number): void {
  if (scores[0]!.length < n) {
    const size = Math.max(n, scores[0]!.length * 2);
    scores = [new Float64Array(size), new Float64Array(size)];
    runs = [new Int32Array(size), new Int32Array(size)];
  }
  if (earliest.length < m) {
    earliest = new Int32Array(Math.max(m, earliest.length * 2));
    latest = new Int32Array(earliest.length);
  }
}

/** The best in-order placement of `needle` at or after `start`. */
function alignFrom(
  path: string,
  haystack: string,
  needle: string,
  start: number,
  nameStart: number,
  withPositions: boolean,
  budget?: FuzzyAlignmentBudget,
): FuzzyPathMatch | null {
  const n = haystack.length;
  const m = needle.length;
  reserve(n, m);
  // The earliest and latest offset each query character can take in an in-order match.
  for (let i = 0, j = start; i < m; i += 1, j += 1) {
    j = haystack.indexOf(needle[i]!, j);
    if (j < 0) return null;
    earliest[i] = j;
  }
  for (let i = m - 1, j = n - 1; i >= 0; i -= 1, j -= 1) {
    j = haystack.lastIndexOf(needle[i]!, j);
    latest[i] = j;
  }
  const cells = m * (n - start);
  if (cells > MAX_ALIGNMENT_CELLS || (budget !== undefined && budget.cells < cells)) {
    const positions = Array.from(latest.subarray(0, m));
    return { score: scorePositions(path, positions, nameStart), positions: withPositions ? positions : [] };
  }
  if (budget) budget.cells -= cells;
  // previous[j]: the best score with the previous query character at offset j; previousRun[j]: the
  // bonus of the character that started its run. A run keeps its start's bonus, so "index" scores
  // higher as a whole word in "src/indexer/" than as letters spread across "binder-example".
  // Row i writes [earliest[i], latest[i]]; row i + 1 reads up to latest[i + 1] - 1, so each row
  // clears through the end of the path first.
  let previous = scores[0]!;
  let current = scores[1]!;
  let previousRun = runs[0]!;
  let currentRun = runs[1]!;
  const from = withPositions ? new Int32Array(m * n).fill(-1) : null;
  previous.fill(NONE, Math.max(0, earliest[0]! - 2), n);
  for (let j = earliest[0]!; j <= latest[0]!; j += 1) {
    if (haystack[j] !== needle[0]) continue;
    const bonus = bonusAt(path, j, nameStart);
    previous[j] = SCORE_MATCH + bonus * FIRST_CHARACTER_MULTIPLIER;
    previousRun[j] = bonus;
  }
  for (let i = 1; i < m; i += 1) {
    current.fill(NONE, Math.max(0, earliest[i]! - 2), n);
    let gap = NONE;
    let gapFrom = -1;
    for (let j = earliest[i - 1]! + 1; j <= latest[i]!; j += 1) {
      // The best earlier character at least two back, less the gap between it and j.
      if (gap > NONE) gap += GAP_EXTEND;
      const skipped = j - 2;
      if (skipped >= earliest[i - 1]! && previous[skipped]! > NONE && previous[skipped]! + GAP_START > gap) {
        gap = previous[skipped]! + GAP_START;
        gapFrom = skipped;
      }
      if (j < earliest[i]! || haystack[j] !== needle[i]) continue;
      const bonus = bonusAt(path, j, nameStart);
      const run = previous[j - 1]! > NONE ? previous[j - 1]! + runBonus(bonus, previousRun[j - 1]!) : NONE;
      const jump = gap > NONE ? gap + bonus : NONE;
      if (run <= NONE && jump <= NONE) continue;
      current[j] = Math.max(run, jump) + SCORE_MATCH;
      currentRun[j] = run >= jump ? previousRun[j - 1]! : bonus;
      if (from) from[i * n + j] = run >= jump ? j - 1 : gapFrom;
    }
    [previous, current] = [current, previous];
    [previousRun, currentRun] = [currentRun, previousRun];
  }
  let end = -1;
  for (let j = earliest[m - 1]!; j <= latest[m - 1]!; j += 1) {
    if (previous[j]! > NONE && (end < 0 || previous[j]! > previous[end]!)) end = j;
  }
  if (end < 0) return null;
  const positions: number[] = [];
  if (from) {
    for (let i = m - 1, j = end; i >= 0; j = from[i * n + j]!, i -= 1) positions.unshift(j);
  }
  return { score: previous[end]!, positions };
}

/** A character that continues a run scores at least its run's start, and at least a plain run. */
function runBonus(own: number, runStart: number): number {
  return Math.max(own, runStart, BONUS_CONSECUTIVE);
}

/** The same scoring as the alignment, for one given placement. */
function scorePositions(path: string, positions: readonly number[], nameStart: number): number {
  let score = 0;
  let runStart = 0;
  positions.forEach((position, i) => {
    const bonus = bonusAt(path, position, nameStart);
    const skipped = i === 0 ? -1 : position - positions[i - 1]! - 1;
    if (i === 0) {
      score += SCORE_MATCH + bonus * FIRST_CHARACTER_MULTIPLIER;
      runStart = bonus;
    } else if (skipped === 0) {
      score += SCORE_MATCH + runBonus(bonus, runStart);
    } else {
      score += SCORE_MATCH + bonus + GAP_START + GAP_EXTEND * (skipped - 1);
      runStart = bonus;
    }
  });
  return score;
}
