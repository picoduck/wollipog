import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveAssetDigest,
  resolveDraftReleaseId,
} from "./release-asset-metadata.mjs";

const cli = fileURLToPath(
  new URL("./release-asset-metadata.mjs", import.meta.url),
);

test("draft release lookup includes paginated drafts and ignores a published tag collision", () => {
  const pages = [
    [
      { id: 10, tag_name: "v1.2.3", draft: false },
      { id: 11, tag_name: "v-other", draft: true },
    ],
    [{ id: 12, tag_name: "v1.2.3", draft: true }],
  ];
  assert.equal(resolveDraftReleaseId(pages, "v1.2.3"), "12");
});

test("draft release lookup fails closed on missing, duplicate, and invalid ids", () => {
  assert.throws(() => resolveDraftReleaseId([[]], "v1"), /found 0/u);
  assert.throws(
    () =>
      resolveDraftReleaseId(
        [
          [
            { id: 1, tag_name: "v1", draft: true },
            { id: 2, tag_name: "v1", draft: true },
          ],
        ],
        "v1",
      ),
    /found 2/u,
  );
  assert.throws(
    () =>
      resolveDraftReleaseId([[{ id: "1", tag_name: "v1", draft: true }]], "v1"),
    /invalid id/u,
  );
});

test("asset lookup returns the exact raw REST digest from paginated metadata", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    resolveAssetDigest(
      [
        [{ name: "other", digest: `sha256:${"b".repeat(64)}` }],
        [{ name: "wollipog-runner-linux", digest }],
      ],
      "wollipog-runner-linux",
    ),
    digest,
  );
});

test("asset lookup fails closed on missing, duplicate, or non-string REST digests", () => {
  assert.throws(() => resolveAssetDigest([[]], "runner"), /found 0/u);
  assert.throws(
    () =>
      resolveAssetDigest(
        [
          [
            { name: "runner", digest: "one" },
            { name: "runner", digest: "two" },
          ],
        ],
        "runner",
      ),
    /found 2/u,
  );
  assert.throws(
    () => resolveAssetDigest([[{ name: "runner", digest: null }]], "runner"),
    /no REST digest/u,
  );
});

test("metadata CLI exposes parse failure as a retryable nonzero command result", () => {
  const result = spawnSync(process.execPath, [cli, "draft-release-id", "v1"], {
    encoding: "utf8",
    input: "transient invalid JSON",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not valid JSON/u);
  assert.equal(result.stdout, "");
});

test("metadata CLI executes through a symlinked repository root", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-release-metadata-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const linkedRoot = join(root, "repository-link");
  symlinkSync(repositoryRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const linkedCli = join(linkedRoot, "scripts", "release-asset-metadata.mjs");
  const result = spawnSync(process.execPath, [linkedCli, "draft-release-id", "v1"], {
    encoding: "utf8",
    input: '[[{"id":42,"tag_name":"v1","draft":true}]]',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "42");
});
