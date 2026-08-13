import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactDownloadFilename, artifactExportRequest } from "./artifact-download.js";

test("artifact export request keeps the paired token in Authorization and out of the URL", () => {
  const request = artifactExportRequest("https://manager.example", "artifact/id", "paired-secret");
  assert.equal(request.url, "https://manager.example/api/artifacts/artifact%2Fid/export");
  assert.equal(request.url.includes("paired-secret"), false);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.cache, "no-store");
  assert.deepEqual(request.init.headers, { authorization: "Bearer paired-secret" });
});

test("artifact download filenames are fixed by content kind and never by an agent-authored name", () => {
  assert.equal(artifactDownloadFilename("html_preview", "text/html"), "workflow-artifact-html_preview.html");
  assert.equal(artifactDownloadFilename("patch", "text/x-diff"), "workflow-artifact-patch.patch");
  assert.equal(artifactDownloadFilename("review_report", "text/markdown"), "workflow-artifact-review_report.md");
  assert.equal(artifactDownloadFilename("test_log", "text/plain"), "workflow-artifact-test_log.log");
  assert.equal(artifactDownloadFilename("verdict", "application/json"), "workflow-artifact-verdict.json");
  assert.equal(artifactDownloadFilename("screenshot", "image/png"), "workflow-artifact-screenshot.png");
  assert.equal(artifactDownloadFilename("screenshot", "image/jpg"), "workflow-artifact-screenshot.jpg");
  assert.equal(artifactDownloadFilename("screenshot", "image/gif"), "workflow-artifact-screenshot.gif");
  assert.equal(artifactDownloadFilename("screenshot", "text/html"), "workflow-artifact-screenshot.bin");
});
