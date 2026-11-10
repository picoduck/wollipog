#!/usr/bin/env node
/**
 * Protocol version ledger check (#975).
 *
 * `PROTOCOL_VERSION` is the highest entry of the ledger in packages/protocol/src/protocol-version.ts.
 * This check fails when:
 * - an entry's `// N:` comment and its `N,` line disagree, versions do not increase, or a new
 *   version does not sit directly below its own `// vN slot` anchor;
 * - the ledger stops deriving `PROTOCOL_VERSION` from its entries, or index.ts defines it again;
 * - a version the merge base already had is removed or renumbered;
 * - a version this branch adds is not greater than the base's `PROTOCOL_VERSION`.
 *
 * A branch that adds no version passes the base comparison unconditionally.
 *
 * Usage:
 *   node scripts/protocol-version-ledger.mjs                 compare with origin/main when present
 *   node scripts/protocol-version-ledger.mjs --base <ref>    compare with <ref>; fail if unreadable
 *   node scripts/protocol-version-ledger.mjs --extend <n>    append n more slot anchors
 *
 * CI passes `--base HEAD^1`: a pull request's merge commit, a merge-group commit and a rolling main
 * commit each have the commit they land on as their first parent.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_PATH = "packages/protocol/src/protocol-version.ts";
export const INDEX_PATH = "packages/protocol/src/index.ts";
export const ARRAY_OPEN = "const PROTOCOL_VERSION_HISTORY: readonly number[] = [";
export const EXPORT_LINE = "export const PROTOCOL_VERSION: number = Math.max(...PROTOCOL_VERSION_HISTORY);";
/** Below this many unclaimed anchors the check asks for `--extend` (a notice, never a failure). */
export const MIN_OPEN_SLOTS = 25;

const SLOT = /^ {2}\/\/ v(\d+) slot$/u;
const HEADER = /^ {2}\/\/ (\d+): \S/u;
const CONTINUATION = /^ {2}\/\/( |$)/u;
const VERSION = /^ {2}(\d+),$/u;

/** An entry's comment without indentation, so a ledger entry and a legacy one compare equal. */
function entryText(lines) {
  return lines.map((line) => line.trim()).join("\n");
}

/** Parse the ledger file. Every problem names the file line it concerns. */
export function parseLedger(text) {
  const lines = text.split(/\r?\n/u);
  const problems = [];
  const start = lines.indexOf(ARRAY_OPEN);
  const end = start < 0 ? -1 : lines.indexOf("];", start);
  if (end < 0) {
    return { entries: [], slots: [], problems: [`${LEDGER_PATH}: cannot find \`${ARRAY_OPEN}\` ... \`];\`.`], version: null };
  }
  if (!lines.slice(end + 1).includes(EXPORT_LINE)) {
    problems.push(`${LEDGER_PATH}: PROTOCOL_VERSION must be exported exactly as \`${EXPORT_LINE}\`, so it is always the highest entry.`);
  }
  const entries = [];
  const slots = [];
  let open = null; // the entry whose comment is being read
  let slot = null; // the latest anchor, and whether an entry already fills it
  const unfinished = (at) => {
    if (open) problems.push(`${LEDGER_PATH}:${open.line}: history entry \`// ${open.version}:\` has no \`${open.version},\` line before line ${at}.`);
    open = null;
  };
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const at = index + 1;
    let match;
    if ((match = SLOT.exec(line))) {
      unfinished(at);
      const version = Number(match[1]);
      if (slots.length > 0 && version !== slots.at(-1) + 1) {
        problems.push(`${LEDGER_PATH}:${at}: anchor v${version} follows v${slots.at(-1)}; anchors must be consecutive.`);
      }
      slots.push(version);
      slot = { version, filled: false };
    } else if ((match = HEADER.exec(line))) {
      unfinished(at);
      open = { version: Number(match[1]), line: at, comment: [line] };
    } else if (CONTINUATION.test(line)) {
      if (open) open.comment.push(line);
      else problems.push(`${LEDGER_PATH}:${at}: comment outside a history entry; an entry starts with \`// N: \`.`);
    } else if ((match = VERSION.exec(line))) {
      const version = Number(match[1]);
      if (!open) {
        problems.push(`${LEDGER_PATH}:${at}: version ${version} has no \`// ${version}: \` history entry directly above it.`);
      } else if (open.version !== version) {
        problems.push(`${LEDGER_PATH}:${at}: history entry \`// ${open.version}:\` ends with version ${version}; the comment and the number must name the same version.`);
      }
      if (slot && (slot.filled || slot.version !== version)) {
        problems.push(`${LEDGER_PATH}:${at}: version ${version} must sit directly below its own \`// v${version} slot\` anchor.`);
      }
      if (slot) slot.filled = true;
      entries.push({ version, line: at, anchored: slot !== null, text: entryText(open?.comment ?? []) });
      open = null;
    } else {
      problems.push(`${LEDGER_PATH}:${at}: unexpected line ${JSON.stringify(line.slice(0, 80))}; the ledger holds only entries and slot anchors.`);
    }
  }
  unfinished(end + 1);
  for (let index = 1; index < entries.length; index += 1) {
    const [previous, current] = [entries[index - 1], entries[index]];
    if (current.version <= previous.version) {
      problems.push(`${LEDGER_PATH}:${current.line}: version ${current.version} follows ${previous.version}; versions must increase.`);
    }
  }
  if (entries.length === 0) problems.push(`${LEDGER_PATH}: the ledger has no entries.`);
  if (slots.length === 0) {
    problems.push(`${LEDGER_PATH}: the ledger has no \`// vN slot\` anchors; add them with --extend.`);
  } else {
    // History above the first anchor predates the anchors. Anything from the first anchor's version
    // up is a claim, and a claim outside its anchor would bring back the shared insertion point.
    for (const entry of entries) {
      if (!entry.anchored && entry.version >= slots[0]) {
        problems.push(`${LEDGER_PATH}:${entry.line}: version ${entry.version} must sit directly below its own \`// v${entry.version} slot\` anchor, not above the anchors.`);
      }
    }
  }
  const version = entries.length > 0 ? Math.max(...entries.map((entry) => entry.version)) : null;
  return { entries, slots, problems, version };
}

/** Read a tree from before #975, whose history comment and literal constant lived in index.ts. */
export function parseLegacyIndex(text) {
  const literal = /^export const PROTOCOL_VERSION = (\d+);\r?$/mu.exec(text);
  if (!literal) return null;
  const entries = [];
  let open = null; // the entry whose comment is being read, until the comment block ends
  for (const line of text.slice(0, literal.index).split(/\r?\n/u)) {
    const header = /^\/\/ (\d+): /u.exec(line);
    if (header) entries.push(open = { version: Number(header[1]), comment: [line] });
    else if (open && /^\/\/( |$)/u.test(line)) open.comment.push(line);
    else open = null;
  }
  for (const entry of entries) {
    entry.text = entryText(entry.comment);
    delete entry.comment;
  }
  return { entries, slots: [], problems: [], version: Number(literal[1]) };
}

/** index.ts must only re-export the ledger, so an old-format rebase cannot reintroduce the hotspot. */
export function indexProblems(text) {
  const problems = [];
  if (/^export const PROTOCOL_VERSION\b/mu.test(text)) {
    problems.push(`${INDEX_PATH} defines PROTOCOL_VERSION again; it must only re-export it from ./protocol-version.js. Move the entry into ${LEDGER_PATH}.`);
  }
  const stray = /^\/\/ (\d+): /mu.exec(text);
  if (stray) {
    problems.push(`${INDEX_PATH} still has a protocol history entry \`// ${stray[1]}:\`; move it into ${LEDGER_PATH} under its slot anchor.`);
  }
  return problems;
}

/**
 * Compare the versions this branch adds (present in `head` but not in `mergeBase`) with `base`.
 * Locally the merge base and the base differ when the branch is behind; in CI they are both the
 * tested commit's first parent.
 */
export function compareWithBase({ head, mergeBase, base, baseName }) {
  const problems = [];
  const known = new Set(mergeBase.entries.map((entry) => entry.version));
  const present = new Set(head.entries.map((entry) => entry.version));
  for (const version of known) {
    if (!present.has(version)) {
      problems.push(`Protocol version ${version} is in ${baseName}'s ledger but not on this branch. A version that reached ${baseName} is never removed or renumbered; claim a new one instead.`);
    }
  }
  // An entry identical to the base's is the base's own, merged in before the merge base caught up
  // (a merge of main that is not committed yet, say): it is not this branch's claim.
  const inherited = new Map(base.entries.map((entry) => [entry.version, entry.text]));
  const claims = head.entries
    .filter((entry) => !known.has(entry.version))
    .filter((entry) => !inherited.has(entry.version) || inherited.get(entry.version) !== entry.text)
    .map((entry) => entry.version)
    .sort((a, b) => a - b);
  const taken = new Set(inherited.keys());
  let next = base.version + 1;
  for (const claim of claims) {
    if (claim > base.version && !taken.has(claim)) continue;
    problems.push(
      `This branch claims protocol version ${claim}, but PROTOCOL_VERSION on ${baseName} is already ${base.version}. ` +
      `A new version must be greater than ${base.version}: claim ${next} instead. Move the entry below the ` +
      `\`// v${next} slot\` anchor in ${LEDGER_PATH} and update any capability floor that used ${claim}.`,
    );
    next += 1;
  }
  return { claims, problems };
}

/** Append `count` consecutive slot anchors after the last one. */
export function extendSlots(text, count) {
  const ledger = parseLedger(text);
  if (ledger.problems.length > 0) throw new Error(ledger.problems.join("\n"));
  const lines = text.split(/\r?\n/u);
  const end = lines.indexOf("];", lines.indexOf(ARRAY_OPEN));
  const from = (ledger.slots.at(-1) ?? ledger.version) + 1;
  const anchors = Array.from({ length: count }, (_, offset) => `  // v${from + offset} slot`);
  lines.splice(end, 0, ...anchors);
  return lines.join("\n");
}

function openSlots(ledger) {
  return ledger.slots.filter((slot) => slot > ledger.version).length;
}

function main(argv) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const option = (name) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const ledgerFile = join(repo, LEDGER_PATH);
  const extend = option("--extend");
  if (extend !== undefined) {
    const count = Number(extend);
    if (!Number.isInteger(count) || count < 1) throw new Error("--extend needs a positive whole number");
    writeFileSync(ledgerFile, extendSlots(readFileSync(ledgerFile, "utf8"), count));
    console.log(`Appended ${count} slot anchors to ${LEDGER_PATH}.`);
    return 0;
  }

  const head = parseLedger(readFileSync(ledgerFile, "utf8"));
  const problems = [...head.problems, ...indexProblems(readFileSync(join(repo, INDEX_PATH), "utf8"))];
  const notices = [];
  if (head.version !== null && openSlots(head) < MIN_OPEN_SLOTS) {
    notices.push(`Only ${openSlots(head)} unclaimed slot anchors remain; add more in a separate pull request with \`node scripts/protocol-version-ledger.mjs --extend 200\`.`);
  }

  const explicit = option("--base");
  const baseRef = explicit ?? "origin/main";
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
  const readAt = (commit) => {
    for (const [path, parse] of [[LEDGER_PATH, parseLedger], [INDEX_PATH, parseLegacyIndex]]) {
      let text;
      try { text = git("show", `${commit}:${path}`); } catch { continue; }
      const ledger = parse(text);
      if (ledger && ledger.version !== null) return ledger;
    }
    throw new Error(`no protocol version ledger at ${commit}`);
  };
  let base = null;
  let mergeBase = null;
  try {
    const baseCommit = git("rev-parse", "--verify", `${baseRef}^{commit}`);
    base = readAt(baseCommit);
    mergeBase = readAt(git("merge-base", "HEAD", baseCommit));
  } catch (error) {
    const reason = String(error?.stderr || error?.message || error).trim().split("\n")[0];
    if (explicit !== undefined) problems.push(`Cannot read the protocol version ledger at ${baseRef}: ${reason}`);
    else notices.push(`Skipped the comparison with ${baseRef} (${reason}); pass --base <ref> to require it.`);
  }
  let summary = `PROTOCOL_VERSION is ${head.version ?? "unreadable"}.`;
  if (base && mergeBase && head.problems.length === 0) {
    const comparison = compareWithBase({ head, mergeBase, base, baseName: baseRef });
    problems.push(...comparison.problems);
    summary = comparison.claims.length === 0
      ? `This branch adds no protocol version (${baseRef} is at ${base.version}).`
      : `This branch adds protocol version ${comparison.claims.join(", ")} above ${baseRef}'s ${base.version}.`;
  }
  for (const notice of notices) console.log(`Notice: ${notice}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(`Protocol version ledger is consistent. ${summary}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
