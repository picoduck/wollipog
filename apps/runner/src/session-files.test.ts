import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READ_FILE_CAP,
  listSessionFiles,
  normalizeRelPath,
  readSessionFile,
  wslListArgs,
  wslReadArgs,
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
});
