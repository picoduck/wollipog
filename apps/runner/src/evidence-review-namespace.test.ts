import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
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

test("existing network grant gets only bounded DNS/TLS runtime files while forbidden operator state remains inaccessible", (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace required"); return; }
  const root = mkdtempSync(join(tmpdir(), "media-runtime-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), forbidden = join(root, "operator");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(forbidden, { mode: 0o700 });
  writeFileSync(join(forbidden, "expected.json"), "synthetic private test truth", { mode: 0o600 });
  const ns = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: realpathSync("/usr/bin/python3"),
    forbiddenRoots: [forbidden], network: "inherit" });
  const script = "import os,ssl; assert os.environ['SSL_CERT_FILE']=='/etc/ssl/certs/ca-certificates.crt'; " +
    "assert len(ssl.create_default_context().get_ca_certs())>0, 'mounted CA bundle must be usable'; " +
    "assert os.path.isfile('/etc/resolv.conf'), 'bounded resolver file must exist'; " +
    "assert not os.path.exists('/etc/shadow'), 'shadow must remain inaccessible'; " +
    "assert not os.path.exists('/etc/passwd'), 'passwd must remain inaccessible'; print('bounded DNS/TLS runtime only')";
  assert.equal(execFileSync(ns.command, [...ns.args, "--", "/usr/bin/python3", "-I", "-c", script], {
    env: { SSL_CERT_FILE: join(forbidden, "expected.json") }, encoding: "utf8", timeout: 5_000,
  }).trim(), "bounded DNS/TLS runtime only");
  assert.equal(ns.args.some((arg, i) => arg === "--ro-bind" && ns.args[i + 1] === "/etc"), false);
  const deny = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: realpathSync("/usr/bin/python3"),
    forbiddenRoots: [forbidden], network: "deny" });
  assert.ok(deny.args.includes("--unshare-net"));
  assert.equal(deny.args.includes("/etc/resolv.conf"), false);
  assert.equal(deny.env.SSL_CERT_FILE, undefined);
  assert.equal(ns.env.SSL_CERT_FILE, "/etc/ssl/certs/ca-certificates.crt");
  assert.notEqual(deny.namespaceSha256, ns.namespaceSha256);
});

test("an installed executable outside runtime roots uses its exact private in-namespace mapping", (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace required"); return; }
  const root = mkdtempSync(join(tmpdir(), "media-provider-mapping-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), forbidden = join(root, "operator"), executable = join(root, "provider");
  mkdirSync(state, { mode: 0o700 }); mkdirSync(forbidden, { mode: 0o700 });
  writeFileSync(executable, "#!/bin/sh\nprintf 'synthetic provider metadata\\n'\n", { mode: 0o700 });
  const ns = prepareEvidenceReviewNamespace({ stateDirectory: state, providerExecutable: executable,
    forbiddenRoots: [forbidden], network: "deny" });
  assert.equal(ns.providerCommand, "/provider");
  assert.equal(execFileSync(ns.command, [...ns.args, "--", ns.providerCommand, "--version"], {
    env: {}, encoding: "utf8", timeout: 5_000,
  }).trim(), "synthetic provider metadata");
});
