import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const resolver = fileURLToPath(
  new URL("./resolve-draft-release-asset-digest.sh", import.meta.url),
);
const forcePosixTest =
  process.env.WOLLIPOG_FORCE_POSIX_RELEASE_METADATA_TEST === "1";

test(
  "draft release digest resolver retries request and parse failures under strict shell",
  {
    skip:
      process.platform === "win32" && !forcePosixTest
        ? "requires a POSIX shell"
        : false,
  },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-release-metadata-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const releaseCount = join(root, "release-count");
    const assetCount = join(root, "asset-count");
    const gh = join(root, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh
set -eu
case "$*" in
  *'/releases?per_page=100'*)
    count=$(cat "$GH_RELEASE_COUNT" 2>/dev/null || printf 0)
    count=$((count + 1))
    printf '%s' "$count" > "$GH_RELEASE_COUNT"
    case "$count" in
      1) exit 75 ;;
      2) printf 'transient invalid JSON' ;;
      *) printf '[[{"id":42,"tag_name":"v-test","draft":true}]]' ;;
    esac
    ;;
  *'/releases/42/assets?per_page=100'*)
    count=$(cat "$GH_ASSET_COUNT" 2>/dev/null || printf 0)
    count=$((count + 1))
    printf '%s' "$count" > "$GH_ASSET_COUNT"
    case "$count" in
      1) printf '[[{"name":"runner","digest":null}]]' ;;
      *) printf '[[{"name":"runner","digest":"sha256:%s"}]]' '${"a".repeat(64)}' ;;
    esac
    ;;
  *) exit 99 ;;
esac
`,
    );
    chmodSync(gh, 0o755);

    const result = spawnSync(
      "sh",
      [resolver, "owner/repo", "v-test", "runner"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          GH_RELEASE_COUNT: releaseCount,
          GH_ASSET_COUNT: assetCount,
          WOLLIPOG_RELEASE_METADATA_ATTEMPTS: "4",
          WOLLIPOG_RELEASE_METADATA_RETRY_DELAY_SECONDS: "0",
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `sha256:${"a".repeat(64)}`);
    assert.equal(readFileSync(releaseCount, "utf8"), "3");
    assert.equal(readFileSync(assetCount, "utf8"), "2");
  },
);
