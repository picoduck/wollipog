import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ARRAY_OPEN, EXPORT_LINE, LEDGER_PATH, compareWithBase, extendSlots, indexProblems, parseLedger, parseLegacyIndex,
} from "./protocol-version-ledger.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/protocol-version-ledger.mjs");

function ledger(body) {
  return ["/** doc */", ARRAY_OPEN, ...body, "];", "", EXPORT_LINE, ""].join("\n");
}
const BASE = ["  // 4: first.", "  //    more.", "  4,", "  // 6: second.", "  6,", "  // v7 slot", "  // v8 slot", "  // v9 slot"];
const claim = (body, version, text = `change ${version}.`) => body.flatMap((line) =>
  line === `  // v${version} slot` ? [line, `  // ${version}: ${text}`, `  ${version},`] : [line]);

test("the committed ledger parses cleanly and has room for new claims", () => {
  const parsed = parseLedger(readFileSync(join(repo, LEDGER_PATH), "utf8"));
  assert.deepEqual(parsed.problems, []);
  assert.ok(parsed.version >= 327);
  assert.ok(parsed.slots.filter((slot) => slot > parsed.version).length > 0);
});

test("a ledger with gaps parses to its highest version", () => {
  const parsed = parseLedger(ledger(BASE));
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.entries.map((entry) => entry.version), [4, 6]);
  assert.equal(parsed.version, 6);
  assert.deepEqual(parsed.slots, [7, 8, 9]);
  assert.equal(parseLedger(ledger(claim(BASE, 8))).version, 8);
});

test("a comment and number that disagree are refused, so a renumber cannot miss one of them", () => {
  const body = claim(BASE, 7).map((line) => (line === "  7," ? "  8," : line));
  const [problem] = parseLedger(ledger(body)).problems;
  assert.match(problem, /history entry `\/\/ 7:` ends with version 8/u);
});

test("an entry must sit directly below its own anchor", () => {
  const misplaced = BASE.flatMap((line) => (line === "  // v8 slot" ? [line, "  // 7: wrong slot.", "  7,"] : [line]));
  assert.ok(parseLedger(ledger(misplaced)).problems.some((problem) => /version 7 must sit directly below its own `\/\/ v7 slot`/u.test(problem)));
  const doubled = claim(BASE, 7).flatMap((line) => (line === "  7," ? [line, "  // 8: squeezed.", "  8,"] : [line]));
  assert.ok(parseLedger(ledger(doubled)).problems.some((problem) => /version 8 must sit directly below/u.test(problem)));
});

test("a claim above the first anchor is refused, while the migrated history there is accepted", () => {
  const committed = readFileSync(join(repo, LEDGER_PATH), "utf8");
  const first = parseLedger(committed).slots[0];
  const unanchored = committed.replace(`  // v${first} slot`, `  // ${first}: unanchored claim.\n  ${first},\n  // v${first} slot`);
  const problems = parseLedger(unanchored).problems;
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`version ${first} must sit directly below its own \`// v${first} slot\` anchor, not above the anchors`, "u"));
  assert.match(parseLedger(ledger(["  // 4: a.", "  4,"])).problems[0], /has no `\/\/ vN slot` anchors/u);
});

test("a checkout with CRLF line endings parses the same", () => {
  const committed = readFileSync(join(repo, LEDGER_PATH), "utf8");
  const crlf = parseLedger(committed.replaceAll("\n", "\r\n"));
  assert.deepEqual(crlf.problems, []);
  assert.equal(crlf.version, parseLedger(committed).version);
  assert.equal(parseLegacyIndex("// 4: a.\r\nexport const PROTOCOL_VERSION = 4;\r\n").version, 4);
});

test("missing numbers, missing entries, decreasing versions and a literal export are refused", () => {
  assert.match(parseLedger(ledger(["  // 4: no number.", "  // v5 slot"])).problems[0], /has no `4,` line/u);
  assert.match(parseLedger(ledger(["  4,", "  // v5 slot"])).problems[0], /version 4 has no `\/\/ 4: ` history entry/u);
  assert.ok(parseLedger(ledger(["  // 6: a.", "  6,", "  // 5: b.", "  5,"])).problems.some((problem) => /version 5 follows 6/u.test(problem)));
  const literal = ledger(BASE).replace(EXPORT_LINE, "export const PROTOCOL_VERSION = 6;");
  assert.match(parseLedger(literal).problems[0], /must be exported exactly/u);
  assert.match(parseLedger(ledger([...BASE, "  const x = 1;"])).problems[0], /unexpected line/u);
});

test("index.ts may only re-export the version", () => {
  assert.deepEqual(indexProblems('export { PROTOCOL_VERSION } from "./protocol-version.js";\n'), []);
  assert.equal(indexProblems("// 328: leftover.\nexport const PROTOCOL_VERSION = 328;\n").length, 2);
  assert.deepEqual(indexProblems(readFileSync(join(repo, "packages/protocol/src/index.ts"), "utf8")), []);
});

test("a tree from before the ledger is read through its literal and history comment", () => {
  const legacy = parseLegacyIndex("// 4: a.\n//    b.\n// 6: c.\nexport const PROTOCOL_VERSION = 6;\n// 9: not history.\n");
  assert.deepEqual(legacy.entries.map((entry) => entry.version), [4, 6]);
  assert.equal(legacy.version, 6);
  assert.equal(parseLegacyIndex("export const other = 1;\n"), null);
});

test("a branch that adds no version is unaffected, even when the base has moved on", () => {
  const head = parseLedger(ledger(BASE));
  const base = parseLedger(ledger(claim(claim(BASE, 7), 8)));
  assert.deepEqual(compareWithBase({ head, mergeBase: head, base, baseName: "main" }), { claims: [], problems: [] });
});

test("a claim above the base passes", () => {
  const mergeBase = parseLedger(ledger(BASE));
  const head = parseLedger(ledger(claim(BASE, 7)));
  assert.deepEqual(compareWithBase({ head, mergeBase, base: mergeBase, baseName: "main" }), { claims: [7], problems: [] });
});

test("a claim that is not greater than the base names both values and the next free version", () => {
  const mergeBase = parseLedger(ledger(BASE));
  // Another change took 8 first; this branch claimed 7, which the base has moved past.
  const base = parseLedger(ledger(claim(BASE, 8)));
  const head = parseLedger(ledger(claim(claim(BASE, 7), 8)));
  const { claims, problems } = compareWithBase({ head, mergeBase, base, baseName: "main" });
  assert.deepEqual(claims, [7, 8]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /claims protocol version 7, but PROTOCOL_VERSION on main is already 8\. A new version must be greater than 8: claim 9 instead/u);
  assert.match(problems[0], /`\/\/ v9 slot`/u);
  // The same number written independently on both sides: still a claim, refused.
  assert.match(problems[1], /claims protocol version 8, but PROTOCOL_VERSION on main is already 8.*claim 10 instead/u);
});

test("removing or renumbering a merged version is refused", () => {
  const mergeBase = parseLedger(ledger(claim(BASE, 7)));
  const head = parseLedger(ledger(claim(BASE, 8)));
  const { problems } = compareWithBase({ head, mergeBase, base: mergeBase, baseName: "main" });
  assert.match(problems[0], /Protocol version 7 is in main's ledger but not on this branch/u);
});

test("extend appends consecutive anchors without touching entries", () => {
  const extended = parseLedger(extendSlots(ledger(claim(BASE, 7)), 3));
  assert.deepEqual(extended.problems, []);
  assert.deepEqual(extended.slots, [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(extended.entries.map((entry) => entry.version), [4, 6, 7]);
});

test("claims of different versions merge without a conflict; claims of the same version conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-ledger-merge-"));
  try {
    const write = (name, body) => { writeFileSync(join(dir, name), ledger(body)); return join(dir, name); };
    const base = write("base", BASE);
    const ours = write("ours", claim(BASE, 7));
    const theirs = write("theirs", claim(BASE, 8));
    const merged = execFileSync("git", ["merge-file", "-p", ours, base, theirs], { encoding: "utf8" });
    assert.equal(merged, ledger(claim(claim(BASE, 7), 8)));
    assert.deepEqual(parseLedger(merged).problems, []);
    const rival = write("rival", claim(BASE, 7, "another change."));
    assert.equal(spawnSync("git", ["merge-file", "-p", ours, base, rival]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the check fails a branch whose claim the base has passed, and passes one that claims nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-ledger-cli-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (body, message) => {
    writeFileSync(join(dir, LEDGER_PATH), ledger(body));
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  try {
    git("init", "-q");
    mkdirSync(join(dir, "packages/protocol/src"), { recursive: true });
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "packages/protocol/src/index.ts"), 'export { PROTOCOL_VERSION } from "./protocol-version.js";\n');
    writeFileSync(join(dir, "scripts/protocol-version-ledger.mjs"), readFileSync(script));
    const root = commit(BASE, "base");
    commit(claim(BASE, 8), "main takes 8");
    const main = git("rev-parse", "HEAD").trim();
    git("checkout", "-q", "-b", "branch", root);
    commit(claim(BASE, 7), "branch claims 7");
    const run = (...args) => spawnSync("node", [join(dir, "scripts/protocol-version-ledger.mjs"), ...args], { encoding: "utf8" });
    const failed = run("--base", main);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /claims protocol version 7, but PROTOCOL_VERSION on [0-9a-f]+ is already 8\. A new version must be greater than 8: claim 9 instead/u);
    assert.equal(run("--base", root).status, 0);
    git("checkout", "-q", "-b", "quiet", root);
    commit(BASE.map((line) => (line === "  //    more." ? "  //    reworded." : line)), "no claim");
    const quiet = run("--base", main);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.match(quiet.stdout, /adds no protocol version/u);
    assert.equal(run("--base", "no-such-ref").status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
