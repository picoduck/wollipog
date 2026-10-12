import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mediaOnlyToolSet, prepareEvidenceReviewNamespace } from "./evidence-review-namespace.js";

test("actual narrowed namespace cannot read fresh operator oracle, generator, parent path or symlink", (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace required"); return; }
  const root = mkdtempSync(join(tmpdir(), "media-namespace-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), oracle = join(root, "operator"), project = join(root, "source");
  for (const path of [state, oracle, project]) mkdirSync(path, { mode: 0o700 });
  const secret = join(oracle, "expected.json"), generator = join(project, "generator.ts");
  writeFileSync(secret, "synthetic private test truth", { mode: 0o600 });
  writeFileSync(generator, "synthetic generator test", { mode: 0o600 });
  writeFileSync(join(state, "approved.txt"), "approved state", { mode: 0o600 });
  symlinkSync(secret, join(state, "escape"));
  const ns = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: realpathSync("/usr/bin/python3"),
    forbiddenRoots: [oracle, project], network: "deny" });
  const script = "import os,sys; assert open('/reviewer-state/approved.txt').read()=='approved state'; " +
    "assert all(not os.path.exists(p) for p in sys.argv[1:]); print('namespace denied all forbidden test inputs')";
  const output = execFileSync(ns.command, [...ns.args, "--", "/usr/bin/python3", "-I", "-c", script,
    secret, generator, join(oracle, "..", "operator", "expected.json"), "/reviewer-state/escape"], {
    env: {}, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(output.trim(), "namespace denied all forbidden test inputs");
  assert.match(ns.namespaceSha256, /^[a-f0-9]{64}$/u);
  assert.match(ns.launchSha256, /^[a-f0-9]{64}$/u);
  const replacementState = join(root, "replacement-state"); mkdirSync(replacementState, { mode: 0o700 });
  const replacement = prepareEvidenceReviewNamespace({ stateDirectory: replacementState,
    providerExecutable: realpathSync("/usr/bin/python3"), forbiddenRoots: [oracle, project], network: "deny" });
  assert.equal(replacement.namespaceSha256, ns.namespaceSha256, "profile proof is stable; Session/grant must separately bind launch identity");
  assert.notEqual(replacement.launchSha256, ns.launchSha256, "a replacement has a distinct concrete launch mapping");
  assert.equal(ns.args.some((arg, i) => arg === "--ro-bind" && ns.args[i + 1] === "/"), false);
  assert.throws(() => prepareEvidenceReviewNamespace({ stateDirectory: oracle, providerExecutable: "/usr/bin/bwrap",
    forbiddenRoots: [oracle, project], network: "deny" }), /expose forbidden/u);
  assert.throws(() => prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: "/usr/bin/bwrap",
    forbiddenRoots: [root], network: "deny" }), /expose forbidden/u);
});
test("media-only tool contract rejects generic filesystem tools and extra MCP handlers", () => {
  assert.equal(mediaOnlyToolSet(["review_video_evidence_frame", "submit_video_evidence_verdict"]), true);
  for (const extra of ["Read", "Bash", "list_sessions", "fetch_resource", "WebFetch"]) {
    assert.equal(mediaOnlyToolSet(["review_video_evidence_frame", "submit_video_evidence_verdict", extra]), false);
  }
  assert.equal(mediaOnlyToolSet(["review_video_evidence_frame", "review_video_evidence_frame"]), false);
});
