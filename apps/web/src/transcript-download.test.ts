import assert from "node:assert/strict";
import { test } from "node:test";
import { requestTranscriptDownload, transcriptExportRequest, type TranscriptDownloadDependencies } from "./transcript-download.js";

test("transcript export request keeps the paired token in Authorization, never the URL", () => {
  const request = transcriptExportRequest("http://manager", "session/id", "markdown", "paired-secret");
  assert.equal(request.url, "http://manager/api/sessions/session%2Fid/export?format=markdown");
  assert.equal(request.url.includes("paired-secret"), false);
  assert.deepEqual(request.init.headers, { authorization: "Bearer paired-secret" });
});

test("transcript download uses a temporary Blob URL and delayed revocation", () => {
  const calls: string[] = [];
  let scheduled: (() => void) | undefined;
  const anchor = {
    href: "", download: "", hidden: false,
    click: () => { calls.push("click"); },
    remove: () => { calls.push("remove"); },
  };
  const dependencies: TranscriptDownloadDependencies = {
    createObjectUrl: () => { calls.push("create"); return "blob:transcript"; },
    revokeObjectUrl: (url) => { calls.push(`revoke:${url}`); },
    createAnchor: () => anchor,
    appendAnchor: () => { calls.push("append"); },
    schedule: (callback, delay) => { calls.push(`schedule:${delay}`); scheduled = callback; },
  };
  requestTranscriptDownload(new Blob(["safe"]), "transcript.json", dependencies);
  assert.deepEqual(calls, ["create", "append", "click", "remove", "schedule:60000"]);
  assert.equal(anchor.href, "blob:transcript");
  assert.equal(anchor.download, "transcript.json");
  assert.equal(anchor.hidden, true);
  scheduled?.();
  assert.equal(calls.at(-1), "revoke:blob:transcript");
});

test("transcript download removes and schedules revocation when the click fails", () => {
  const calls: string[] = [];
  const dependencies: TranscriptDownloadDependencies = {
    createObjectUrl: () => "blob:failure",
    revokeObjectUrl: () => {},
    createAnchor: () => ({
      href: "", download: "", hidden: false,
      click: () => { throw new Error("blocked"); },
      remove: () => { calls.push("remove"); },
    }),
    appendAnchor: () => {},
    schedule: (_callback, delay) => { calls.push(`schedule:${delay}`); },
  };
  assert.throws(() => requestTranscriptDownload(new Blob(), "transcript.md", dependencies), /blocked/);
  assert.deepEqual(calls, ["remove", "schedule:60000"]);
});
