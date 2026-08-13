import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  runnerArtifactNames,
  RUNNER_TARGET_TRIPLES,
} from "../apps/runner/scripts/runner-artifacts.mjs";

const helper = fileURLToPath(
  new URL("./verify-draft-runner-release.sh", import.meta.url),
);
const windowsBash = "C:\\Program Files\\Git\\bin\\bash.exe";
const shell = process.platform === "win32" ? windowsBash : "bash";
const haveShell =
  process.platform !== "win32" || existsSync(windowsBash);

function shellPath(path) {
  if (process.platform !== "win32") return path;
  return path.replace(/\\/gu, "/").replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
}

test(
  "draft hosted verification resolves by id and retries API, JSON, and inventory failures",
  { skip: haveShell ? false : "requires bash" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-draft-release-gate-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const gh = join(root, "gh");
    const ghLog = join(root, "gh.log");
    const listCount = join(root, "list-count");
    const assetCount = join(root, "asset-count");
    const manifest = join(root, "SHA256SUMS");

    const runnerAssets = [];
    const manifestLines = [];
    for (const triple of RUNNER_TARGET_TRIPLES) {
      const digest = createHash("sha256").update(`runner for ${triple}`).digest("hex");
      for (const name of Object.values(runnerArtifactNames(triple))) {
        runnerAssets.push({ name, size: 100, digest: `sha256:${digest}` });
        manifestLines.push(`${digest}  ${name}`);
      }
    }
    const manifestText = `${manifestLines.sort().join("\n")}\n`;
    writeFileSync(manifest, manifestText);
    const assets = [
      ...runnerAssets,
      {
        name: "SHA256SUMS",
        size: Buffer.byteLength(manifestText),
        digest: `sha256:${createHash("sha256").update(manifestText).digest("hex")}`,
      },
      ...Array.from({ length: 14 }, (_, index) => ({
        name: `desktop-${index}`,
        size: 100,
        digest: `sha256:${String(index).padStart(64, "0")}`,
      })),
    ];
    assert.equal(assets.length, 27);
    const assetPagesJson = JSON.stringify([assets.slice(0, 13), assets.slice(13)]);
    const incompleteAssetPagesJson = JSON.stringify([assets.slice(0, -1)]);

    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$GH_LOG"
case "$*" in
  *'/releases?per_page=100'*)
    count=$(cat "$GH_LIST_COUNT" 2>/dev/null || printf 0)
    count=$((count + 1))
    printf '%s' "$count" >"$GH_LIST_COUNT"
    case "$count" in
      1) exit 75 ;;
      2) printf 'transient invalid JSON' ;;
      *) printf '[[{"id":42,"tag_name":"v-test","draft":true}]]' ;;
    esac
    ;;
  *'/releases/42/assets?per_page=100'*)
    count=$(cat "$GH_ASSET_COUNT" 2>/dev/null || printf 0)
    count=$((count + 1))
    printf '%s' "$count" >"$GH_ASSET_COUNT"
    case "$count" in
      1) exit 75 ;;
      2) printf 'malformed asset JSON' ;;
      3) printf '%s' '${incompleteAssetPagesJson}' ;;
      *) printf '%s' '${assetPagesJson}' ;;
    esac
    ;;
  *) exit 99 ;;
esac
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      shell,
      [
        "-c",
        'PATH="$1:$PATH"; GH_LOG="$2"; GH_LIST_COUNT="$3"; GH_ASSET_COUNT="$4"; ' +
          'WOLLIPOG_RELEASE_METADATA_ATTEMPTS=5; WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS=0; ' +
          "export PATH GH_LOG GH_LIST_COUNT GH_ASSET_COUNT WOLLIPOG_RELEASE_METADATA_ATTEMPTS " +
          'WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS; exec bash "$5" owner/repo v-test "$6"',
        "draft-release-test",
        shellPath(root),
        shellPath(ghLog),
        shellPath(listCount),
        shellPath(assetCount),
        shellPath(helper),
        shellPath(manifest),
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(listCount, "utf8"), "3");
    assert.equal(readFileSync(assetCount, "utf8"), "4");
    const calls = readFileSync(ghLog, "utf8");
    assert.match(calls, /api --paginate --slurp repos\/owner\/repo\/releases\?per_page=100/u);
    assert.match(calls, /api --paginate --slurp repos\/owner\/repo\/releases\/42\/assets\?per_page=100/u);
    assert.doesNotMatch(calls, /releases\/tags\//u);
  },
);

test("draft hosted verification exhausts bounded release-id retries before any asset request", {
  skip: haveShell ? false : "requires bash",
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-draft-release-exhaustion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gh = join(root, "gh");
  const ghLog = join(root, "gh.log");
  const manifest = join(root, "SHA256SUMS");
  writeFileSync(manifest, "unused\n");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$GH_LOG"\nprintf '[]'\n`);
  chmodSync(gh, 0o755);

  const result = spawnSync(shell, [
    "-c",
    'PATH="$1:$PATH"; GH_LOG="$2"; WOLLIPOG_RELEASE_METADATA_ATTEMPTS=2; ' +
      'WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS=0; export PATH GH_LOG ' +
      'WOLLIPOG_RELEASE_METADATA_ATTEMPTS WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS; ' +
      'exec bash "$3" owner/repo v-missing "$4"',
    "draft-release-exhaustion-test",
    shellPath(root),
    shellPath(ghLog),
    shellPath(helper),
    shellPath(manifest),
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not resolve the draft release id for v-missing/u);
  const calls = readFileSync(ghLog, "utf8").trim().split(/\r?\n/u);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.includes("/releases?per_page=100")));
  assert.ok(calls.every((call) => !call.includes("/assets")));
});
