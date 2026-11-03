import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READ_FILE_CAP,
  bestFuzzyFiles,
  createWorkspaceReference,
  inspectWorkspaceReferenceDiff,
  listSessionFiles,
  nativeWorkspaceVisit,
  normalizeRelPath,
  parseWslWorkspaceReferenceSearch,
  parseWslWorkspaceVisit,
  readSessionFile,
  resolveWorkspaceReference,
  searchWorkspaceReferences,
  workspaceReferenceDiffContent,
  wslListArgs,
  wslReadArgs,
  wslSearchArgs,
} from "./session-files.js";

const NATIVE = { kind: "native" } as const;

/* ------------------------------ normalizeRelPath ------------------------------ */

test("normalizeRelPath accepts root-relative paths and normalizes separators", () => {
  assert.equal(normalizeRelPath(""), "");
  assert.equal(normalizeRelPath("a/b.txt"), "a/b.txt");
  assert.equal(normalizeRelPath("a\\b\\c"), "a/b/c");
  assert.equal(normalizeRelPath("./a//b/."), "a/b");
});

test("normalizeRelPath rejects anything that could escape the session root", () => {
  assert.equal(normalizeRelPath("../x"), null);
  assert.equal(normalizeRelPath("a/../../x"), null);
  assert.equal(normalizeRelPath("a/.."), null); // any `..` segment — even non-escaping — is out
  assert.equal(normalizeRelPath("/etc/passwd"), null);
  assert.equal(normalizeRelPath("\\\\server\\share"), null);
  assert.equal(normalizeRelPath("C:/Windows"), null);
  assert.equal(normalizeRelPath("c:\\x"), null);
  assert.equal(normalizeRelPath("a\0b"), null);
});

/* --------------------------------- native list -------------------------------- */

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-files-"));
  writeFileSync(join(root, "b.txt"), "hello");
  writeFileSync(join(root, ".env"), "SECRET=1"); // dotfiles ARE listed (unlike the workspace picker)
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "inner.md"), "# hi\n");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: x");
  return root;
}

test("nativeList: dirs first, .git hidden, sizes and root-relative slash paths", async () => {
  const root = makeFixture();
  try {
    const { path, entries } = await listSessionFiles(NATIVE, root, "");
    assert.equal(path, "");
    assert.deepEqual(
      entries.map((e) => e.name),
      ["sub", ".env", "b.txt"],
    );
    const b = entries.find((e) => e.name === "b.txt")!;
    assert.equal(b.isDir, false);
    assert.equal(b.size, 5);
    assert.equal(b.path, "b.txt");
    assert.equal(entries.find((e) => e.name === "sub")!.isDir, true);

    const sub = await listSessionFiles(NATIVE, root, "sub");
    assert.equal(sub.path, "sub");
    assert.deepEqual(sub.entries.map((e) => e.path), ["sub/inner.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nativeList: backslash rel paths normalize; escapes and unknown dirs reject", async () => {
  const root = makeFixture();
  try {
    const viaBackslash = await listSessionFiles(NATIVE, root, "sub\\");
    assert.equal(viaBackslash.path, "sub");
    await assert.rejects(() => listSessionFiles(NATIVE, root, "../outside"), /invalid path/);
    await assert.rejects(() => listSessionFiles(NATIVE, root, "no-such-dir"), /cannot read directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nativeList: broken symlink is listed sizeless instead of failing the directory", async (t) => {
  const root = makeFixture();
  try {
    try {
      symlinkSync(join(root, "gone.txt"), join(root, "dangling.txt"), "file");
    } catch {
      t.skip("symlinks unavailable (Windows without developer mode)");
      return;
    }
    const { entries } = await listSessionFiles(NATIVE, root, "");
    const dangling = entries.find((e) => e.name === "dangling.txt");
    assert.ok(dangling, "dangling symlink still listed");
    assert.equal(dangling!.size, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------- native read -------------------------------- */

test("nativeRead: content, size, binary detection, cap, and guards", async () => {
  const root = makeFixture();
  try {
    const txt = await readSessionFile(NATIVE, root, "b.txt");
    assert.equal(txt.content, "hello");
    assert.equal(txt.size, 5);
    assert.equal(txt.truncated, false);
    assert.equal(txt.binary, false);

    writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const bin = await readSessionFile(NATIVE, root, "blob.bin");
    assert.equal(bin.binary, true);
    assert.equal(bin.content, undefined);
    assert.equal(bin.size, 4);

    writeFileSync(join(root, "big.txt"), "x".repeat(READ_FILE_CAP + 1000));
    const big = await readSessionFile(NATIVE, root, "big.txt");
    assert.equal(big.truncated, true);
    assert.equal(big.content!.length, READ_FILE_CAP);
    assert.equal(big.size, READ_FILE_CAP + 1000);

    await assert.rejects(() => readSessionFile(NATIVE, root, ""), /invalid path/); // root itself is not a file
    await assert.rejects(() => readSessionFile(NATIVE, root, "../etc"), /invalid path/);
    await assert.rejects(() => readSessionFile(NATIVE, root, "missing.txt"), /cannot read file/);
    await assert.rejects(() => readSessionFile(NATIVE, root, "sub"), /not a file|cannot read file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace reference search is bounded to the session root and skips symlinks", async (t) => {
  const root = makeFixture();
  const outside = mkdtempSync(join(tmpdir(), "wollipog-files-outside-"));
  try {
    writeFileSync(join(outside, "secret-match.txt"), "secret");
    try {
      symlinkSync(outside, join(root, "outside-link"), "dir");
    } catch {
      t.skip("symlinks unavailable (Windows without developer mode)");
      return;
    }
    const found = await searchWorkspaceReferences(NATIVE, root, "inner");
    assert.deepEqual(found.results, [{ path: "sub/inner.md", isDirectory: false }]);
    const escaped = await searchWorkspaceReferences(NATIVE, root, "secret-match");
    assert.deepEqual(escaped.results, []);
    await assert.rejects(() => readSessionFile(NATIVE, root, "outside-link/secret-match.txt"), /cannot read file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("native workspace search distinguishes exactly 50 flat-root matches from a 51st match", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-search-boundary-"));
  try {
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(root, `match-${String(index).padStart(2, "0")}.txt`), "");
    }
    const exact = await searchWorkspaceReferences(NATIVE, root, "match-");
    assert.equal(exact.results.length, 50);
    assert.equal(exact.truncated, false);

    writeFileSync(join(root, "match-50.txt"), "");
    const overflow = await searchWorkspaceReferences(NATIVE, root, "match-");
    assert.equal(overflow.results.length, 50);
    assert.equal(overflow.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fuzzy search returns files only, best first, inside the session root (#1263)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-search-fuzzy-"));
  const outside = mkdtempSync(join(tmpdir(), "wollipog-search-fuzzy-outside-"));
  try {
    mkdirSync(join(root, "apps", "web", "src", "components"), { recursive: true });
    mkdirSync(join(root, "docs", "sdtsx-notes"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "apps", "web", "src", "components", "SessionDetail.tsx"), "");
    writeFileSync(join(root, "docs", "sdtsx-notes", "readme.md"), "");
    writeFileSync(join(root, "docs", "sidebar-details.tsx"), "");
    writeFileSync(join(root, "docs", "unrelated.md"), "");
    writeFileSync(join(root, ".git", "SessionDetail.tsx"), "");
    writeFileSync(join(outside, "SessionDetail.tsx"), "");
    let linked = true;
    try {
      symlinkSync(outside, join(root, "outside-link"), "dir");
    } catch {
      linked = false;
    }

    const found = await searchWorkspaceReferences(NATIVE, root, "sd tsx", "fuzzy");
    assert.equal(found.match, "fuzzy");
    assert.equal(found.truncated, false);
    assert.equal(found.limit, undefined);
    assert.deepEqual(found.results.map((candidate) => candidate.path), [
      "apps/web/src/components/SessionDetail.tsx",
      "docs/sidebar-details.tsx",
      "docs/sdtsx-notes/readme.md",
    ], "the folder named like the query is not a result; the file under it ranks below name matches");
    assert.ok(found.results.every((candidate) => !candidate.isDirectory));
    if (!linked) t.diagnostic("symlinks unavailable; the escape case was not exercised");

    const substring = await searchWorkspaceReferences(NATIVE, root, "sdtsx");
    assert.equal(substring.match, undefined, "without `match` the search keeps its substring contract");
    assert.deepEqual(substring.results, [
      { path: "docs/sdtsx-notes", isDirectory: true },
      { path: "docs/sdtsx-notes/readme.md", isDirectory: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a fuzzy search keeps the best 50 matches, not the first 50 found, and names the cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-search-fuzzy-cap-"));
  try {
    for (let index = 0; index < 60; index += 1) {
      writeFileSync(join(root, `m-${String(index).padStart(2, "0")}-t.txt`), "");
    }
    mkdirSync(join(root, "deep", "er"), { recursive: true });
    writeFileSync(join(root, "deep", "er", "mt.ts"), "");
    const found = await searchWorkspaceReferences(NATIVE, root, "mt", "fuzzy");
    assert.equal(found.results.length, 50);
    assert.equal(found.results[0]?.path, "deep/er/mt.ts", "visited last, it still ranks first");
    assert.equal(found.truncated, true);
    assert.equal(found.limit, "results");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** `src/a.ts` and `notes.txt` beside two `node_modules` directories, one nested. A file that is
 * merely named `node_modules` is kept: only directories are skipped. */
function makeDependencyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-search-ignored-"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "src", "node_modules"), { recursive: true });
  mkdirSync(join(root, "docs"));
  for (let index = 0; index < 5; index += 1) writeFileSync(join(root, "node_modules", "pkg", `dep-${index}.ts`), "");
  writeFileSync(join(root, "src", "node_modules", "nested.ts"), "");
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "docs", "node_modules"), "");
  writeFileSync(join(root, "notes.txt"), "");
  return root;
}

const DEPENDENCY_FIXTURE_ENTRIES = ["docs", "docs/node_modules", "notes.txt", "src", "src/a.ts"];

test("native search skips node_modules directories without counting them against the visit cap (#4095)", async () => {
  const root = makeDependencyFixture();
  try {
    const exact = nativeWorkspaceVisit(root, DEPENDENCY_FIXTURE_ENTRIES.length);
    assert.deepEqual(exact.entries.map((candidate) => candidate.path).sort(), DEPENDENCY_FIXTURE_ENTRIES);
    assert.equal(exact.truncated, false, "the skipped trees spend none of the cap");
    assert.equal(nativeWorkspaceVisit(root, DEPENDENCY_FIXTURE_ENTRIES.length - 1).truncated, true,
      "the cap still bounds the project's own entries");

    const fuzzy = await searchWorkspaceReferences(NATIVE, root, "dep", "fuzzy");
    assert.deepEqual(fuzzy.results, []);
    assert.equal(fuzzy.limit, undefined);
    const substring = await searchWorkspaceReferences(NATIVE, root, "node_modules");
    assert.deepEqual(substring.results, [{ path: "docs/node_modules", isDirectory: false }]);
    assert.equal(substring.truncated, false);

    const listing = await listSessionFiles(NATIVE, root, "");
    assert.ok(listing.entries.some((entry) => entry.path === "node_modules" && entry.isDir),
      "the folder view still lists the skipped directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bestFuzzyFiles bounds its total alignment work and still ranks every match", () => {
  const entries = [
    { path: "src/sidebar-details.tsx", isDirectory: false },
    { path: "apps/web/src/components/SessionDetail.tsx", isDirectory: false },
    { path: "src/unrelated.ts", isDirectory: false },
  ];
  const unbounded = bestFuzzyFiles({ entries, truncated: false }, "sdtsx");
  const spent = bestFuzzyFiles({ entries, truncated: false }, "sdtsx", 0);
  assert.deepEqual(spent.results.map((candidate) => candidate.path).sort(), unbounded.results.map((candidate) => candidate.path).sort(),
    "a spent budget changes how finely matches are scored, never which paths match");
  assert.equal(spent.results.length, 2);
});

test("bestFuzzyFiles reports the visit cap ahead of the result cap", () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({ path: `src/item-${index}.ts`, isDirectory: false }));
  const visitBound = bestFuzzyFiles({ entries, truncated: true }, "item");
  assert.equal(visitBound.results.length, 50);
  assert.equal(visitBound.limit, "entries");
  assert.equal(visitBound.truncated, true);

  const complete = bestFuzzyFiles({ entries: entries.slice(0, 50), truncated: false }, "item");
  assert.equal(complete.truncated, false);
  assert.equal(complete.limit, undefined);
  assert.deepEqual(complete.results.map((candidate) => candidate.path).slice(0, 2), ["src/item-0.ts", "src/item-1.ts"],
    "equal scores keep the visit order");
});

test("workspace references bind root, target content, ranges, and diff identity", async () => {
  const root = makeFixture();
  try {
    const first = await createWorkspaceReference(NATIVE, root, {
      path: "sub/inner.md", kind: "lines", startLine: 1, endLine: 1,
    });
    assert.equal(first.path, "sub/inner.md");
    assert.equal(first.kind, "lines");
    writeFileSync(join(root, "sub", "inner.md"), "# changed\n");
    const changed = await createWorkspaceReference(NATIVE, root, {
      path: "sub/inner.md", kind: "lines", startLine: 1, endLine: 1,
    });
    assert.notEqual(changed.targetFingerprint, first.targetFingerprint);
    const diff = await createWorkspaceReference(NATIVE, root, {
      path: "deleted.ts", kind: "diff", startLine: 7, endLine: 9,
      side: "left", diffScope: "uncommitted", diffHash: "c".repeat(64),
    });
    assert.equal(diff.side, "left");
    assert.equal(diff.diffHash, "c".repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory reference resolution traverses once for native and WSL contexts", async () => {
  for (const context of [NATIVE, { kind: "wsl", distro: "Ubuntu" } as const]) {
    let rootFingerprintCalls = 0;
    let directoryTreeCalls = 0;
    const resolved = await resolveWorkspaceReference(context, "/session/root", {
      path: "docs",
      kind: "directory",
    }, {
      rootFingerprint: async (receivedContext, receivedRoot) => {
        rootFingerprintCalls += 1;
        assert.deepEqual(receivedContext, context);
        assert.equal(receivedRoot, "/session/root");
        return "root-fingerprint";
      },
      directoryTree: async (receivedContext, receivedRoot, receivedPath) => {
        directoryTreeCalls += 1;
        assert.deepEqual(receivedContext, context);
        assert.equal(receivedRoot, "/session/root");
        assert.equal(receivedPath, "docs");
        return { content: "docs/guide.md (5 bytes)", truncated: false };
      },
    });
    assert.equal(rootFingerprintCalls, 1);
    assert.equal(directoryTreeCalls, 1);
    assert.equal(resolved.directoryTree?.content, "docs/guide.md (5 bytes)");
    assert.equal(resolved.reference.rootFingerprint, "root-fingerprint");
  }
});

test("invalid structured diff scopes are rejected before Git inspection", async () => {
  let gitInspections = 0;
  await assert.rejects(
    () => inspectWorkspaceReferenceDiff({
      path: "source.ts",
      kind: "diff",
      startLine: 1,
      endLine: 1,
      side: "right",
      diffHash: "d".repeat(64),
      diffScope: "unsupported" as "uncommitted",
    }, async () => {
      gitInspections += 1;
      throw new Error("Git must not run");
    }),
    /diff reference identity is invalid/,
  );
  assert.equal(gitInspections, 0);
});

test("diff references resolve the exact selected side and reject gaps", async () => {
  const root = makeFixture();
  try {
    const diffHash = "d".repeat(64);
    const right = await createWorkspaceReference(NATIVE, root, {
      path: "sub/inner.md", kind: "diff", startLine: 10, endLine: 12,
      side: "right", diffScope: "uncommitted", diffHash,
    });
    const diff = {
      scope: "uncommitted" as const,
      diffHash,
      stats: { filesChanged: 1, insertions: 1, deletions: 1 },
      files: [{
        path: "sub/inner.md",
        status: "modified" as const,
        binary: false,
        hunks: [{
          header: "@@ -10,3 +10,3 @@", oldStart: 10, oldCount: 3, newStart: 10, newCount: 3,
          lines: [
            { status: " " as const, text: "same" },
            { status: "-" as const, text: "old" },
            { status: "+" as const, text: "new" },
            { status: " " as const, text: "tail" },
          ],
        }],
      }],
    };
    assert.equal(workspaceReferenceDiffContent(diff, right), "10  same\n11 +new\n12  tail");
    assert.throws(() => workspaceReferenceDiffContent(diff, { ...right, startLine: 9 }), /every selected diff line/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- WSL argv shapes ------------------------------ */

test("wslListArgs/wslReadArgs: paths ride as positional args, never inside the script", () => {
  const hostile = "repo/$(rm -rf ~)/`id`/$HOME";
  for (const args of [wslListArgs("Ubuntu", "/home/u/repo", hostile), wslReadArgs("Ubuntu", "/home/u/repo", hostile, 1024)]) {
    assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "--exec", "sh", "-c"]);
    const script = args[5]!;
    assert.ok(!script.includes(hostile), "hostile path never interpolated into the script");
    assert.ok(!script.includes("/home/u/repo"), "root never interpolated into the script");
    assert.ok(script.includes('"$1"'), "root consumed as $1");
    assert.ok(script.includes('$2'), "rel consumed as $2");
    assert.equal(args[6], "sh"); // $0 placeholder
    assert.equal(args[7], "/home/u/repo");
    assert.equal(args[8], hostile);
  }
  const read = wslReadArgs("Ubuntu", "/r", "f.txt", 2048);
  assert.equal(read[9], "2048"); // cap as $3
  assert.ok(read[5]!.includes('"$3"'));
  const list = wslListArgs("Ubuntu", "/r", "sub");
  assert.match(list[5]!, /\[ -L "\$e" \].*readlink -f.*case "\$x"/, "symlinks are resolved and contained rather than hidden");
});

test("wslSearchArgs: preserves find grouping and emits type metadata in one bounded process", () => {
  const args = wslSearchArgs("Ubuntu", "/home/u/repo", 20_000);
  assert.deepEqual(args.slice(0, 5), ["-d", "Ubuntu", "--exec", "sh", "-c"]);
  assert.match(args[5]!, /\\\( -type f -o -type d \\\)/, "the shell receives escaped find grouping");
  assert.match(args[5]!, /-printf "%y\\t%P\\n"/, "one traversal returns both type and path");
  assert.match(args[5]!, /find \. -mindepth 1 \\\( -path \.\/\.git -o -type d -name node_modules \\\) -prune/,
    "the root, .git and node_modules directories never print, so none of them takes a row");
  assert.equal(args[7], "/home/u/repo");
  assert.equal(args[8], "20001", "one sentinel row distinguishes a capped traversal");
});

test("WSL search parsing bounds matches and reports both result and traversal truncation", () => {
  const exactMatches = Array.from({ length: 50 }, (_, index) => `f\tsrc/item-${index}\n`).join("");
  const exact = parseWslWorkspaceReferenceSearch(exactMatches, "src");
  assert.equal(exact.results.length, 50);
  assert.equal(exact.truncated, false);

  const matches = Array.from({ length: 51 }, (_, index) => `${index % 2 ? "d" : "f"}\tsrc/item-${index}\n`).join("");
  const resultBound = parseWslWorkspaceReferenceSearch(matches, "src");
  assert.equal(resultBound.results.length, 50);
  assert.equal(resultBound.results[1]?.isDirectory, true);
  assert.equal(resultBound.truncated, true);

  const visitBound = parseWslWorkspaceReferenceSearch("f\tone\nf\ttwo\nf\tthree\n", "o", 2);
  assert.deepEqual(visitBound.results.map((candidate) => candidate.path), ["one", "two"]);
  assert.equal(visitBound.truncated, true);
});

test("WSL fuzzy search ranks the same bounded traversal and names a capped visit", () => {
  const listing = "d\tsrc\nf\tsrc/sidebar.ts\r\nf\tsrc/components/SessionDetail.tsx\nf\tREADME.md\n";
  const visit = parseWslWorkspaceVisit(listing);
  assert.deepEqual(visit.entries[1], { path: "src/sidebar.ts", isDirectory: false }, "a CRLF row loses its CR");
  assert.equal(visit.truncated, false);
  const found = bestFuzzyFiles(visit, "sdtsx");
  assert.deepEqual(found.results.map((candidate) => candidate.path), ["src/components/SessionDetail.tsx"]);
  assert.equal(found.truncated, false);

  const capped = bestFuzzyFiles(parseWslWorkspaceVisit(listing, 3), "s");
  assert.equal(capped.limit, "entries");
  assert.deepEqual(capped.results.map((candidate) => candidate.path), ["src/sidebar.ts", "src/components/SessionDetail.tsx"]);
});

test("the WSL search script prunes node_modules before its bounded listing counts it (#4095)", (t) => {
  if (process.platform !== "linux") {
    t.skip("the WSL script needs GNU find, which only a Linux host has");
    return;
  }
  const root = makeDependencyFixture();
  try {
    const cap = DEPENDENCY_FIXTURE_ENTRIES.length;
    // The argv after `--exec` is what the distro runs; Linux runs the same `sh -c` script directly.
    const ran = spawnSync("sh", wslSearchArgs("Ubuntu", root, cap).slice(4), { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout.split("\n").filter(Boolean).length, cap, "neither the root nor a pruned entry reaches `head`");
    const visit = parseWslWorkspaceVisit(ran.stdout, cap);
    assert.deepEqual(visit.entries.map((candidate) => candidate.path).sort(), DEPENDENCY_FIXTURE_ENTRIES);
    assert.deepEqual(visit.entries.find((candidate) => candidate.path === "docs/node_modules"),
      { path: "docs/node_modules", isDirectory: false });
    assert.equal(visit.truncated, false, "the skipped trees spend none of the cap");

    const capped = spawnSync("sh", wslSearchArgs("Ubuntu", root, cap - 1).slice(4), { encoding: "utf8" });
    assert.equal(capped.status, 0, capped.stderr);
    assert.equal(parseWslWorkspaceVisit(capped.stdout, cap - 1).truncated, true,
      "the cap still bounds the project's own entries");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
