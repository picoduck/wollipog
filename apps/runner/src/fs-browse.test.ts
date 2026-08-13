import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, wslListArgs } from "./fs-browse.js";

test("wslListArgs passes the path as a positional arg, never interpolated (no shell injection)", () => {
  const evil = '$(touch /tmp/pwned)`whoami`"; rm -rf ~ #';
  const args = wslListArgs("Ubuntu", evil);
  const script = args[args.indexOf("-c") + 1]!;
  // the attacker string must NOT appear in the script the shell parses...
  assert.ok(!script.includes("pwned"), "path must not be interpolated into the script");
  assert.ok(!script.includes("rm -rf"));
  assert.ok(script.includes('p="$1"'), "script reads the path from $1");
  // ...it must be a standalone argv element (becomes $1), preceded by the $0 placeholder.
  assert.equal(args[args.length - 1], evil);
  assert.equal(args[args.length - 2], "sh");
});

test("wslListArgs omits the positional for an empty path (wsl.exe rejects a trailing empty arg)", () => {
  const args = wslListArgs("Ubuntu", "");
  // No empty trailing element — the last arg is the $0 placeholder, and $1 stays unset ($HOME).
  assert.equal(args[args.length - 1], "sh");
  assert.ok(!args.includes(""), "argv must contain no empty string");
});

test("listDirectory (native): sub-directories only, sorted, hiding dotdirs + files; has a parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-browse-"));
  try {
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "x");

    const r = await listDirectory({ kind: "native" }, root);
    assert.deepEqual(
      r.entries.map((e) => e.name),
      ["alpha", "beta"], // dirs only, sorted, no dotdir, no file
    );
    assert.ok(r.entries.every((e) => e.isDir));
    assert.ok(r.entries.every((e) => e.path.endsWith(e.name)));
    assert.ok(r.parent && r.parent.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listDirectory (native): throws on a missing path", async () => {
  await assert.rejects(() => listDirectory({ kind: "native" }, join(tmpdir(), "wollipog-nope-xyz-123456")));
});
