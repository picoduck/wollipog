import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validAntigravitySetupView, type AntigravitySetupView } from "@wollipog/protocol";
import {
  advertisedAntigravityModels,
  antigravityCredentialContext,
  AntigravitySetupSupervisor,
  parseAntigravitySignInUrl,
  parseAntigravityVersion,
  type AntigravitySetupSupervisorOptions,
} from "./antigravity-setup.js";

// Every test runs Google's CLI as a credential-free fixture (fixtures/antigravity/fake-agy.mjs).
const FIXTURE = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const AMBIENT = { GEMINI_API_KEY: "fixture-key", AGY_ADC_AUTH: "true", GOOGLE_CLOUD_PROJECT: "fixture-project",
  GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_API_KEY: "fixture-key", GOOGLE_GEMINI_BASE_URL: "https://example.invalid" };

let root: string;
let state: string;
let agy: string;
const supervisors: AntigravitySetupSupervisor[] = [];

before(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-setup-test-"));
  agy = join(root, "agy");
  writeFileSync(agy, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(agy, 0o755);
});

after(() => {
  for (const supervisor of supervisors) supervisor.shutdown();
  rmSync(root, { recursive: true, force: true });
  for (const name of [...Object.keys(AMBIENT), "FAKE_AGY_STATE", "FAKE_AGY_MODE"]) delete process.env[name];
});

beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
  process.env.FAKE_AGY_STATE = state;
  delete process.env.FAKE_AGY_MODE;
});

function mode(...modes: string[]): void {
  process.env.FAKE_AGY_MODE = modes.join(",");
}

function supervisor(options: Partial<AntigravitySetupSupervisorOptions> = {}): { setup: AntigravitySetupSupervisor; published: AntigravitySetupView[] } {
  const published: AntigravitySetupView[] = [];
  const setup = new AntigravitySetupSupervisor({
    dataDir: mkdtempSync(join(root, "data-")),
    platform: "linux",
    resolveExecutable: async () => agy,
    onUpdate: (view) => published.push(view),
    signInLinkTimeoutMs: 5_000,
    ...options,
  });
  supervisors.push(setup);
  return { setup, published };
}

async function until(setup: AntigravitySetupSupervisor, predicate: (view: AntigravitySetupView) => boolean, timeoutMs = 10_000): Promise<AntigravitySetupView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = setup.current();
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last setup: ${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function assertAllValid(published: AntigravitySetupView[]): void {
  assert.ok(published.length > 0);
  for (const view of published) assert.ok(validAntigravitySetupView(view), `invalid published setup ${JSON.stringify(view)}`);
}

test("the credential context drops ambient keys, ADC and every Google Cloud setting", () => {
  const context = antigravityCredentialContext({ ...AMBIENT, GOOGLE_CLOUD_QUOTA_PROJECT: "q", HOME: "/home/fixture", PATH: "/usr/bin" });
  for (const name of [...Object.keys(AMBIENT), "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.ok(context.scrubInheritedEnv.includes(name), `${name} is scrubbed`);
  }
  assert.ok(!context.scrubInheritedEnv.includes("HOME"));
  assert.ok(!context.scrubInheritedEnv.includes("PATH"));
  assert.deepEqual(context.env, {});
  assert.equal(context.credentialStore, "shared_os_keyring");
});

test("checks, sign-in and verification all run without ambient credentials", async () => {
  Object.assign(process.env, AMBIENT);
  try {
    const { setup } = supervisor();
    await setup.check();
    setup.startSignIn();
    const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
    setup.submitCode(waiting.signIn!.operationId, "FIXTURE-GOOD-CODE");
    await until(setup, (view) => view.signIn?.status === "succeeded");
  } finally {
    for (const name of Object.keys(AMBIENT)) delete process.env[name];
  }
  const records = readFileSync(join(state, "environments.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { label: string; present: string[]; home: string | null });
  assert.deepEqual([...new Set(records.map((record) => record.label))].sort(), ["acp", "login", "version"]);
  for (const record of records) {
    assert.deepEqual(record.present, [], `${record.label} saw ambient credentials`);
    // The runner user's own HOME (and so its keyring) is the shared credential context.
    assert.equal(record.home, process.env.HOME ?? null);
  }
});

test("a missing executable reports missing_runtime", async () => {
  const { setup, published } = supervisor({ resolveExecutable: async () => null });
  const view = await setup.check();
  assert.equal(view.status, "missing_runtime");
  assert.equal(view.executable, undefined);
  assert.throws(() => setup.startSignIn(), /not installed/);
  assertAllValid(published);
});

test("an unsupported platform reports guidance without running anything", async () => {
  let resolved = false;
  const { setup } = supervisor({ platform: "win32", resolveExecutable: async () => { resolved = true; return agy; } });
  const view = await setup.check();
  assert.equal(view.status, "unsupported");
  assert.equal(view.failure, "unsupported_platform");
  assert.equal(resolved, false);
});

test("a working runtime without a sign-in reports sign_in_required", async () => {
  const { setup, published } = supervisor();
  assert.equal(setup.current().status, "checking");
  const view = await setup.check();
  assert.equal(view.status, "sign_in_required");
  assert.deepEqual(view.executable, { path: agy, version: "1.4.2" });
  assert.equal(view.models, undefined);
  assert.equal(published[0]?.status, "checking");
  assertAllValid(published);
});

test("remote sign-in reaches ready only after the access check, and keeps the code out of every view", async () => {
  const { setup, published } = supervisor();
  await setup.check();
  const started = setup.startSignIn();
  assert.match(started.signIn!.operationId, /^agy_login_/u);
  assert.throws(() => setup.startSignIn(), /already running/);
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  // Trailing sentence punctuation is not part of the link.
  assert.equal(waiting.signIn!.verificationUrl,
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=fixture-state");
  const submitted = setup.submitCode(waiting.signIn!.operationId, "  FIXTURE-GOOD-CODE  ");
  assert.equal(submitted.signIn!.status, "waiting_for_provider");
  assert.equal(submitted.signIn!.verificationUrl, undefined);
  const ready = await until(setup, (view) => view.signIn?.status === "succeeded");
  assert.equal(ready.status, "ready");
  assert.deepEqual(ready.models, [{ id: "fixture-pro", name: "Fixture Pro" }, { id: "fixture-flash", name: "Fixture Flash" }]);
  assert.ok(published.some((view) => view.signIn?.status === "verifying"));
  assert.ok(!JSON.stringify(published).includes("FIXTURE-GOOD-CODE"));
  assertAllValid(published);
});

test("a rejected or expired code fails the sign-in and never reports success", async () => {
  const { setup, published } = supervisor();
  await setup.check();
  setup.startSignIn();
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  setup.submitCode(waiting.signIn!.operationId, "FIXTURE-WRONG-CODE");
  const failed = await until(setup, (view) => view.signIn?.status === "failed");
  assert.equal(failed.signIn!.failure, "not_completed");
  assert.equal(failed.status, "sign_in_required");
  assert.ok(!published.some((view) => view.status === "ready" || view.signIn?.status === "succeeded"));
  assert.ok(!JSON.stringify(published).includes("FIXTURE-WRONG-CODE"));
});

test("a zero exit is not success: an unconfirmed sign-in fails as not_verified", async () => {
  mode("login_exit0_unverified");
  const { setup, published } = supervisor();
  await setup.check();
  setup.startSignIn();
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  setup.submitCode(waiting.signIn!.operationId, "FIXTURE-GOOD-CODE");
  const failed = await until(setup, (view) => view.signIn?.status === "failed");
  assert.equal(failed.signIn!.failure, "not_verified");
  assert.equal(failed.status, "sign_in_required");
  assert.ok(!published.some((view) => view.status === "ready"));
});

test("a sign-in that prints no link fails as link_unavailable", async () => {
  mode("login_no_link");
  const { setup } = supervisor({ signInLinkTimeoutMs: 300 });
  await setup.check();
  setup.startSignIn();
  const failed = await until(setup, (view) => view.signIn?.status === "failed");
  assert.equal(failed.signIn!.failure, "link_unavailable");
});

test("cancel stops the sign-in, and a retry starts a new one", async () => {
  const { setup } = supervisor();
  await setup.check();
  const first = setup.startSignIn().signIn!.operationId;
  await until(setup, (view) => view.signIn?.status === "awaiting_code");
  const cancelled = setup.cancelSignIn(first);
  assert.equal(cancelled.signIn!.status, "cancelled");
  assert.equal(cancelled.signIn!.verificationUrl, undefined);
  assert.throws(() => setup.submitCode(first, "FIXTURE-GOOD-CODE"), /not waiting/);
  assert.throws(() => setup.cancelSignIn(first), /no longer running/);
  const retry = setup.startSignIn().signIn!;
  assert.notEqual(retry.operationId, first);
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  setup.submitCode(waiting.signIn!.operationId, "FIXTURE-GOOD-CODE");
  const ready = await until(setup, (view) => view.signIn?.status === "succeeded");
  assert.equal(ready.status, "ready");
});

test("a sign-in that outlives its window times out", async () => {
  const { setup } = supervisor({ signInTimeoutMs: 300 });
  await setup.check();
  setup.startSignIn();
  const timedOut = await until(setup, (view) => view.signIn?.status === "timed_out");
  assert.equal(timedOut.status, "sign_in_required");
});

test("check failures other than sign-in report verification_failed with the failing step", async () => {
  const cases: Array<{ modes: string[]; failure: string; signedIn?: boolean; options?: Partial<AntigravitySetupSupervisorOptions> }> = [
    { modes: ["version_fail"], failure: "version_check_failed" },
    { modes: ["handshake_bad"], failure: "handshake_failed" },
    { modes: ["acp_exit"], failure: "handshake_failed" },
    { modes: ["handshake_hang"], failure: "timed_out", options: { handshakeTimeoutMs: 300 } },
    { modes: ["session_error"], failure: "session_check_failed", signedIn: true },
    { modes: ["session_hang"], failure: "timed_out", signedIn: true, options: { sessionTimeoutMs: 300 } },
    // A session without any advertised model is not recognized, so it is not ready.
    { modes: ["session_no_models"], failure: "session_check_failed", signedIn: true },
  ];
  for (const testCase of cases) {
    state = mkdtempSync(join(root, "state-"));
    process.env.FAKE_AGY_STATE = state;
    if (testCase.signedIn) writeFileSync(join(state, "signed-in"), "fixture");
    mode(...testCase.modes);
    const { setup, published } = supervisor(testCase.options);
    const view = await setup.check();
    assert.equal(view.status, "verification_failed", testCase.modes.join());
    assert.equal(view.failure, testCase.failure, testCase.modes.join());
    assert.equal(view.models, undefined);
    assertAllValid(published);
  }
});

test("an existing sign-in is reused, including agents that report session model state", async () => {
  writeFileSync(join(state, "signed-in"), "fixture");
  mode("session_model_state", "version_garbled");
  const { setup } = supervisor();
  const view = await setup.check();
  assert.equal(view.status, "ready");
  assert.deepEqual(view.executable, { path: agy });
  assert.deepEqual(view.models?.map((model) => model.id), ["fixture-pro", "fixture-flash"]);
});

test("access checks run in a private empty folder that is removed afterwards", async () => {
  writeFileSync(join(state, "signed-in"), "fixture");
  const dataDir = mkdtempSync(join(root, "data-"));
  const { setup } = supervisor({ dataDir });
  await setup.check();
  const scratch = join(dataDir, "antigravity-setup");
  assert.ok(existsSync(scratch));
  assert.deepEqual((await import("node:fs")).readdirSync(scratch), []);
});

test("output after the link is never read: an echoed code is not published and the code step never reopens", async () => {
  mode("login_echo_code");
  const { setup, published } = supervisor();
  await setup.check();
  setup.startSignIn();
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  const operationId = waiting.signIn!.operationId;
  setup.submitCode(operationId, "FIXTURE-GOOD-CODE");
  assert.throws(() => setup.submitCode(operationId, "FIXTURE-GOOD-CODE"), /not waiting/);
  const ready = await until(setup, (view) => view.signIn?.status === "succeeded");
  assert.equal(ready.status, "ready");
  assert.ok(!JSON.stringify(published).includes("FIXTURE-GOOD-CODE"));
  const statuses = published.map((view) => view.signIn?.status).filter(Boolean);
  assert.equal(statuses.lastIndexOf("awaiting_code") < statuses.indexOf("waiting_for_provider"), true,
    "the operation never returns to awaiting its code");
});

test("a link split across writes is published only once it is complete", async () => {
  mode("login_split_url");
  const { setup, published } = supervisor();
  await setup.check();
  setup.startSignIn();
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  assert.equal(waiting.signIn!.verificationUrl,
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=fixture-state");
  assert.equal(published.filter((view) => view.signIn?.verificationUrl).length, 1);
});

test("a chunk cut inside an escape sequence within the link does not end the link early", async () => {
  mode("login_ansi_split");
  const { setup, published } = supervisor();
  await setup.check();
  setup.startSignIn();
  const waiting = await until(setup, (view) => view.signIn?.status === "awaiting_code");
  assert.equal(waiting.signIn!.verificationUrl,
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture-client&state=fixture-state");
  assert.equal(published.filter((view) => view.signIn?.verificationUrl).length, 1);
});

test("JSON that is not a JSON-RPC message is ignored rather than crashing the check", async () => {
  writeFileSync(join(state, "signed-in"), "fixture");
  mode("acp_null");
  const { setup } = supervisor();
  const view = await setup.check();
  assert.equal(view.status, "ready");
});

test("a nameless model with a long id still produces a ready report the control plane accepts", async () => {
  writeFileSync(join(state, "signed-in"), "fixture");
  mode("session_long_model");
  const { setup, published } = supervisor();
  const view = await setup.check();
  assert.equal(view.status, "ready");
  assert.equal(view.models?.[0]?.id, "m".repeat(161));
  assert.equal(view.models?.[0]?.name.length, 160);
  assertAllValid(published);
});

test("parsers accept only safe, complete links, versions and bounded models", () => {
  assert.equal(parseAntigravitySignInUrl("visit http://insecure.example/x then https://user:pw@accounts.google.com/x\n"), undefined);
  assert.equal(parseAntigravitySignInUrl("\u001b[4mhttps://accounts.google.com/o?x=1\u001b[0m).\n"), "https://accounts.google.com/o?x=1");
  assert.equal(parseAntigravitySignInUrl("https://accounts.google.com/o?state=par"), undefined, "a link at the end may be cut short");
  for (const partial of ["\u001b", "\u001b[", "\u001b[0", "\u009b0"]) {
    assert.equal(parseAntigravitySignInUrl(`https://accounts.google.com/o/auth${partial}`), undefined, JSON.stringify(partial));
  }
  assert.equal(parseAntigravitySignInUrl("https://accounts.google.com/o/auth\u001b[0m?state=s\n"), "https://accounts.google.com/o/auth?state=s");
  assert.equal(parseAntigravityVersion("\u001b[32mAntigravity CLI v2.0.1-beta.3\u001b[0m"), "2.0.1-beta.3");
  assert.equal(parseAntigravityVersion("no version here"), undefined);
  assert.deepEqual(advertisedAntigravityModels({ models: { availableModels: [
    { modelId: "a", name: "A" }, { modelId: "a", name: "duplicate" }, { modelId: "bad\nid", name: "B" }, { modelId: "c" },
  ] } }), [{ id: "a", name: "A" }, { id: "c", name: "c" }]);
  assert.deepEqual(advertisedAntigravityModels({ sessionId: "s" }), []);
  assert.deepEqual(advertisedAntigravityModels(null), []);
});
