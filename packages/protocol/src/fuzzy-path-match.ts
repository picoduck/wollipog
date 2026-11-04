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

/** A run this long inside the file name reads as typing part of the name, even mid-word. */
const CLEAN_NAME_RUN = 3;

/**
 * Whether a match reads as deliberate: every run of matched characters starts a word (a path
 * segment, a separator or a camelCase hump) or is at least three characters of the file name.
 * "sdtsx" in SessionDetail.tsx is clean (S, D, tsx); in CheckBadge.tsx it is not, since its "d"
 * sits alone mid-word. Go to File lifts changed and recent files only on a clean match (#1263),
 * so a coincidental scatter never outranks a stronger match just because the file was touched.
 */
export function fuzzyPathMatchIsClean(path: string, positions: readonly number[]): boolean {
  const nameStart = path.lastIndexOf("/") + 1;
  for (let start = 0; start < positions.length;) {
    let end = start + 1;
    while (end < positions.length && positions[end] === positions[end - 1]! + 1) end += 1;
    const first = positions[start]!;
    const wordStart = bonusAt(path, first, nameStart) - (first >= nameStart ? BONUS_NAME : 0) > 0;
    if (!wordStart && !(first >= nameStart && end - start >= CLEAN_NAME_RUN)) return false;
    start = end;
  }
  return positions.length > 0;
}

/**
 * Lower case one UTF-16 unit at a time, so offsets in the folded text are offsets in the original,
 * and the same way for the query and every path: whole-string lower-casing is contextual (a final Σ
 * becomes ς), so it is used only for ASCII, where it is not.
 */
function foldCase(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase();
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

/**
 * A run's carried bonus, as it can still matter: `runBonus` never pays less than a plain run, so
 * every start bonus up to BONUS_CONSECUTIVE carries the same. The alignment keeps one state per
 * level, since a lower score now with a higher carried bonus can win after more consecutive letters.
 */
const LEVEL_VALUES = [...new Set([0, BONUS_CAMEL, BONUS_WORD, BONUS_SEGMENT]
  .flatMap((base) => [base, base + BONUS_NAME])
  .map((bonus) => Math.max(bonus, BONUS_CONSECUTIVE)))].sort((a, b) => a - b);
const LEVELS = LEVEL_VALUES.length;
const LEVEL_OF = Array.from({ length: BONUS_SEGMENT + BONUS_NAME + 1 }, (_, bonus) =>
  LEVEL_VALUES.indexOf(Math.max(bonus, BONUS_CONSECUTIVE)));

// Scratch rows reused across calls; matching is synchronous, so no two calls share them at once.
// Each holds LEVELS rows of the path's length: state (level, offset) lives at level * n + offset.
let scores = [new Float64Array(256 * LEVELS), new Float64Array(256 * LEVELS)];
let earliest = new Int32Array(64);
let latest = new Int32Array(64);

function reserve(n: number, m: number): void {
  if (scores[0]!.length < n * LEVELS) {
    const size = Math.max(n * LEVELS, scores[0]!.length * 2);
    scores = [new Float64Array(size), new Float64Array(size)];
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
  // previous[level * n + j]: the best score with the previous query character at offset j, in a run
  // whose start carries `level`. A run keeps its start's bonus, so "index" scores higher as a whole
  // word in "src/indexer/" than as letters spread across "binder-example". Row i writes
  // [earliest[i], latest[i]]; row i + 1 reads from earliest[i], so each row clears from just before
  // its earliest offset through the end of the path first.
  let previous = scores[0]!;
  let current = scores[1]!;
  // from[(i * LEVELS + level) * n + j]: the previous character's offset * LEVELS + its level.
  const from = withPositions ? new Int32Array(m * LEVELS * n).fill(-1) : null;
  const clear = (row: Float64Array, offset: number) => {
    for (let level = 0; level < LEVELS; level += 1) row.fill(NONE, level * n + Math.max(0, offset - 2), level * n + n);
  };
  clear(previous, earliest[0]!);
  for (let j = earliest[0]!; j <= latest[0]!; j += 1) {
    if (haystack[j] !== needle[0]) continue;
    const bonus = bonusAt(path, j, nameStart);
    previous[LEVEL_OF[bonus]! * n + j] = SCORE_MATCH + bonus * FIRST_CHARACTER_MULTIPLIER;
  }
  for (let i = 1; i < m; i += 1) {
    clear(current, earliest[i]!);
    let gap = NONE;
    let gapFrom = -1;
    for (let j = earliest[i - 1]! + 1; j <= latest[i]!; j += 1) {
      // The best earlier character at least two back, in any run, less the gap between it and j.
      if (gap > NONE) gap += GAP_EXTEND;
      const skipped = j - 2;
      if (skipped >= earliest[i - 1]!) {
        for (let level = 0; level < LEVELS; level += 1) {
          const before = previous[level * n + skipped]!;
          if (before > NONE && before + GAP_START > gap) {
            gap = before + GAP_START;
            gapFrom = skipped * LEVELS + level;
          }
        }
      }
      if (j < earliest[i]! || haystack[j] !== needle[i]) continue;
      const bonus = bonusAt(path, j, nameStart);
      // Continue each run, keeping its level.
      for (let level = 0; level < LEVELS; level += 1) {
        const before = previous[level * n + j - 1]!;
        if (before <= NONE) continue;
        current[level * n + j] = before + SCORE_MATCH + Math.max(bonus, LEVEL_VALUES[level]!);
        if (from) from[(i * LEVELS + level) * n + j] = (j - 1) * LEVELS + level;
      }
      // Or start a new run here after a gap.
      if (gap > NONE) {
        const level = LEVEL_OF[bonus]!;
        const jump = gap + SCORE_MATCH + bonus;
        if (jump > current[level * n + j]!) {
          current[level * n + j] = jump;
          if (from) from[(i * LEVELS + level) * n + j] = gapFrom;
        }
      }
    }
    [previous, current] = [current, previous];
  }
  let end = -1;
  for (let j = earliest[m - 1]!; j <= latest[m - 1]!; j += 1) {
    for (let level = 0; level < LEVELS; level += 1) {
      const at = level * n + j;
      if (previous[at]! > NONE && (end < 0 || previous[at]! > previous[end]!)) end = at;
    }
  }
  if (end < 0) return null;
  const score = previous[end]!;
  const positions: number[] = [];
  if (from) {
    let state = (end % n) * LEVELS + Math.floor(end / n);
    for (let i = m - 1; i >= 0; i -= 1) {
      const j = Math.floor(state / LEVELS);
      positions.unshift(j);
      state = from[(i * LEVELS + (state % LEVELS)) * n + j]!;
    }
  }
  return { score, positions };
}

/** A character that continues a run scores at least its run's start, and at least a plain run. */
function runBonus(own: number, runStart: number): number {
  return Math.max(own, runStart, BONUS_CONSECUTIVE);
}

/**
 * The score the alignment maximizes, for one given placement of the query's characters (ascending
 * offsets), before the file-name bonuses. Exported so tests can check the alignment against every
 * placement.
 */
export function fuzzyPathPlacementScore(path: string, positions: readonly number[]): number {
  return scorePositions(path, positions, path.lastIndexOf("/") + 1);
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
