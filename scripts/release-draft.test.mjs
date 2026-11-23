import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import { releaseDraft } from "./release-draft.mjs";

const repo = "owner/repo";
const collection = `repos/${repo}/releases`;
const tag = "v0.38.0-rc.1";
const commit = "a".repeat(40);
const target = { tag, commit, prerelease: true };
const canonical = { id: 42, tag_name: tag, target_commitish: commit, draft: true, prerelease: true };

test("a rerun recovers an accepted draft creation after a lost response", () => {
  const releases = [{ ...canonical, id: 31, tag_name: "v0.37.1", draft: false, prerelease: false }];
  const create = (path, ...args) => {
    assert.equal(path, collection);
    assert.deepEqual(args.slice(0, 6), ["--method", "POST", "-f", `tag_name=${tag}`, "-f", `target_commitish=${commit}`]);
    for (const flag of ["draft=true", "prerelease=true", "make_latest=false"]) assert.ok(args.includes(flag));
    releases.push(canonical);
    throw new Error("connection closed");
  };
  const pages = (path) => {
    assert.equal(path, `${collection}?per_page=100`);
    return releases;
  };
  const draft = releaseDraft(repo, target, create, pages);
  assert.throws(() => draft.prepare(), /connection closed/u);
  assert.equal(draft.prepare(), 42);
  assert.equal(releases.filter((release) => release.tag_name === tag).length, 1);
});

test("draft preparation refuses duplicates, published releases and conflicting targets without writing", () => {
  const unexpectedWrite = () => assert.fail("must not create or edit a release");
  for (const releases of [
    [canonical, { ...canonical, id: 43 }],
    [{ ...canonical, draft: false }],
    [{ ...canonical, target_commitish: "b".repeat(40) }],
    [{ ...canonical, prerelease: false }],
  ]) {
    const draft = releaseDraft(repo, target, unexpectedWrite, () => releases);
    assert.throws(() => draft.prepare(), /multiple releases|not the expected draft/u);
  }
});

test("asset operations use the exact prepared draft ID and refuse a different release", () => {
  const asset = { id: 123, name: "SHA256SUMS", size: 100 };
  const read = (path) => {
    assert.equal(path, `${collection}/42`);
    return canonical;
  };
  const pages = (path) => {
    assert.equal(path, `${collection}/42/assets?per_page=100`);
    return [asset];
  };
  assert.deepEqual(releaseDraft(repo, target, read, pages).assets("42"), [asset]);
  const different = releaseDraft(repo, target, () => ({ ...canonical, id: 99 }), () => assert.fail("must not list assets"));
  assert.throws(() => different.assets("42"), /Release ID does not identify the expected draft/u);
  assert.throws(() => different.assets(""), /Release ID does not identify the expected draft/u);
});

test("release CLI only replaces and downloads assets from the prepared draft", {
  skip: process.platform === "win32" ? "requires a POSIX gh fixture" : false,
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wollipog-draft-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("./release-draft.mjs", import.meta.url));
  writeFileSync(join(directory, "gh"), `#!/bin/sh
set -eu
[ "$1" = api ]
case "$2" in
  repos/owner/repo/releases/42) printf '%s' '${JSON.stringify(canonical)}' ;;
  --paginate)
    [ "$3 $4" = '--slurp repos/owner/repo/releases/42/assets?per_page=100' ]
    printf '%s' '[[{"id":123,"name":"SHA256SUMS","size":5},{"id":124,"name":"other.txt","size":5}]]' ;;
  repos/owner/repo/releases/assets/123)
    case "$3 $4" in
      '--method DELETE') printf 'deleted\n' >> calls ;;
      '--header Accept: application/octet-stream') printf bytes ;;
      *) exit 99 ;;
    esac ;;
  'https://uploads.github.com/repos/owner/repo/releases/42/assets?name=SHA256SUMS')
    [ "$3 $4 $5 $6 $7 $8" = '--method POST --header Content-Type: application/octet-stream --input SHA256SUMS' ]
    [ "$(cat calls)" = deleted ] && [ "$(cat "$8")" = bytes ]
    printf '%s' '{"name":"SHA256SUMS","state":"uploaded","size":5}' ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: directory + delimiter + process.env.PATH,
    GITHUB_REPOSITORY: repo, GITHUB_SHA: commit, RELEASE_TAG: tag, RELEASE_ID: "42", RELEASE_PRERELEASE: "true",
  };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, env, encoding: "utf8" });
  writeFileSync(join(directory, "SHA256SUMS"), "bytes");
  mkdirSync(join(directory, "download"));
  const upload = run("upload", "SHA256SUMS");
  assert.equal(upload.status, 0, upload.stderr);
  const download = run("download", "download", "SHA256*");
  assert.equal(download.status, 0, download.stderr);
  assert.equal(readFileSync(join(directory, "download", "SHA256SUMS"), "utf8"), "bytes");
});
