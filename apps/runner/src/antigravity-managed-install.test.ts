import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { AntigravityManagedStore } from "./antigravity-install.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validAntigravitySetupView, type AntigravitySetupView } from "@wollipog/protocol";
import {
  ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV,
  AntigravitySetupSupervisor,
  antigravitySetupForControlPlane,
  type AntigravitySetupSupervisorOptions,
} from "./antigravity-setup.js";
import { FakeReleaseServer, fakeAgyWrapper, fakeInstallerScript, fakeTarGz } from "./fixtures/antigravity/fake-release.js";
import { resolveAcpLaunch } from "./acp-compatibility.js";
import { ANTIGRAVITY_UNAVAILABLE, antigravityAgentDefinition, antigravityLaunchResolver, antigravitySignOutSuperseded } from "./antigravity-session.js";
import { AcpDriver } from "./drivers/acp-driver.js";
import { killTreeAndWait, spawnAgent } from "./spawn.js";

// Every test installs fake releases from fake origins (fixtures/antigravity/fake-release.ts) whose
// binary runs the credential-free fake CLI (fixtures/antigravity/fake-agy.mjs). No network is used.
const FIXTURE = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const PLATFORM = "linux_amd64";

const root = mkdtempSync(join(tmpdir(), "antigravity-managed-test-"));
const pathAgy = join(root, "path-agy");
writeFileSync(pathAgy, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
chmodSync(pathAgy, 0o755);
const supervisors: AntigravitySetupSupervisor[] = [];
let state: string;

after(() => {
  for (const supervisor of supervisors) supervisor.shutdown();
  rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_AGY_STATE;
  delete process.env.FAKE_AGY_MODE;
});

beforeEach(() => {
  state = mkdtempSync(join(root, "state-"));
  process.env.FAKE_AGY_STATE = state;
  delete process.env.FAKE_AGY_MODE;
  // Signed in, so a ready check is reachable.
  writeFileSync(join(state, "signed-in"), "fixture");
});

function release(version: string, mode?: string): Buffer {
  return fakeTarGz([{ name: "antigravity", content: fakeAgyWrapper({ fixture: FIXTURE, version, mode }) }]);
}

function supervisor(server: FakeReleaseServer, options: Partial<AntigravitySetupSupervisorOptions> = {}) {
  const published: AntigravitySetupView[] = [];
  const logs: string[] = [];
  const dataDir = mkdtempSync(join(root, "data-"));
  const setup = new AntigravitySetupSupervisor({
    dataDir,
    platform: "linux",
    arch: "x64",
    musl: () => false,
    resolveExecutable: async () => null,
    fetch: server.fetch,
    onUpdate: (view) => published.push(view),
    log: (message) => logs.push(message),
    ...options,
  });
  supervisors.push(setup);
  return { setup, published, logs, dataDir, managedRoot: join(dataDir, "antigravity-managed") };
}

async function until(setup: AntigravitySetupSupervisor, predicate: (view: AntigravitySetupView) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = setup.current();
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last setup: ${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settled = (view: AntigravitySetupView) =>
  view.managedInstall?.operation?.status !== "running" && view.status !== "checking";

async function install(setup: AntigravitySetupSupervisor): Promise<AntigravitySetupView> {
  const started = setup.startInstall();
  assert.equal(started.managedInstall?.operation?.status, "running");
  const operationId = started.managedInstall?.operation?.operationId;
  return until(setup, (view) => view.managedInstall?.operation?.operationId === operationId && settled(view));
}

function environments(): Array<{ label: string; copy: string; home: string | null; autoUpdateDisabled: string | null;
  runtimeDir: string | null; sessionBus: string | null; present: string[] }> {
  const file = join(state, "environments.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function assertAllValid(published: AntigravitySetupView[]): void {
  assert.ok(published.length > 0);
  for (const view of published) assert.ok(validAntigravitySetupView(view), `invalid published setup ${JSON.stringify(view)}`);
}

test("an install stages, verifies, validates in isolation, activates and then checks the managed copy", async () => {
  const server = new FakeReleaseServer();
  const { archiveUrl, manifestUrl } = server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, published, logs, managedRoot } = supervisor(server);
  assert.equal((await setup.check("never")).status, "missing_runtime");

  const view = await install(setup);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.executable, { path: join(managedRoot, "current", "agy"), version: "1.5.14", source: "managed" });
  const managed = view.managedInstall!;
  assert.equal(managed.available, true);
  assert.equal(managed.operation?.status, "succeeded");
  assert.equal(managed.operation?.kind, "install");
  assert.equal(managed.operation?.targetVersion, "1.5.14");
  assert.equal(managed.active?.version, "1.5.14");
  assert.equal(managed.active?.manifestUrl, manifestUrl);
  assert.equal(managed.active?.archiveUrl, archiveUrl);
  assert.match(managed.active?.installerSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.match(managed.active?.archiveSha512 ?? "", /^[0-9a-f]{128}$/u);
  assert.equal(managed.previousVersion, undefined);
  assertAllValid(published);

  // Progress went through every stage, in order.
  const stages = [...new Set(published.map((entry) => entry.managedInstall?.operation?.stage).filter(Boolean))];
  assert.deepEqual(stages, ["fetching_installer", "fetching_manifest", "downloading", "extracting", "validating", "activating"]);

  // The staged release ran only in its private scratch HOME; once active it runs with the runner
  // user's HOME. The managed copy always runs with its self-updater off.
  const managedRuns = environments().filter((entry) => entry.copy === "managed-1.5.14");
  const validation = managedRuns.filter((entry) => entry.home?.startsWith(join(managedRoot, "staging")));
  assert.deepEqual(validation.map((entry) => entry.label), ["version", "acp_help", "acp"]);
  const active = managedRuns.filter((entry) => !entry.home?.startsWith(join(managedRoot, "staging")));
  assert.deepEqual(active.map((entry) => entry.label), ["version", "acp"]);
  assert.ok(active.every((entry) => entry.home === process.env.HOME));
  assert.ok(managedRuns.every((entry) => entry.autoUpdateDisabled === "true"));

  // The staging folder is gone; release.json records the provenance; the log names it.
  assert.equal(existsSync(join(managedRoot, "staging")), false);
  const generation = readlinkSync(join(managedRoot, "current"));
  const record = JSON.parse(readFileSync(join(managedRoot, generation, "release.json"), "utf8"));
  assert.deepEqual(record, managed.active);
  assert.ok(logs.some((line) => line.includes("activated managed v1.5.14") && line.includes(managed.active!.archiveSha512)));

  // The exported launch target is the managed copy with the self-updater off (#4779).
  const target = setup.launchTarget();
  assert.equal(target?.command, join(managedRoot, "current", "agy"));
  assert.equal(target?.context.env[ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV], "true");
});

test("a failed update keeps the last working version active, and a later update keeps one previous", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, published, managedRoot } = supervisor(server);
  await install(setup);
  const working = readlinkSync(join(managedRoot, "current"));

  // 1.6.0 fails validation: it does not offer `acp --help`.
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0", "acp_help_fail") });
  const failed = await install(setup);
  assert.equal(failed.managedInstall?.operation?.status, "failed");
  assert.equal(failed.managedInstall?.operation?.kind, "update");
  assert.equal(failed.managedInstall?.operation?.failure, "validation_failed");
  assert.equal(failed.managedInstall?.operation?.targetVersion, "1.6.0");
  assert.equal(failed.managedInstall?.active?.version, "1.5.14");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(existsSync(join(managedRoot, "staging")), false);
  assert.equal(readdirSync(join(managedRoot, "generations")).length, 1);
  const rechecked = await setup.check("never");
  assert.equal(rechecked.status, "ready");
  assert.equal(rechecked.executable?.version, "1.5.14");

  // A tampered archive is refused before it is read.
  server.publish({ platform: PLATFORM, version: "1.6.1", archive: release("1.6.1"), manifestSha512: "0".repeat(128) });
  const tampered = await install(setup);
  assert.equal(tampered.managedInstall?.operation?.failure, "checksum_mismatch");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);

  // A partial archive is refused too.
  const partial = fakeTarGz([{ name: "antigravity", content: "#!/bin/sh\n", declaredSize: 9_000 }], { end: false });
  server.publish({ platform: PLATFORM, version: "1.6.2", archive: partial });
  assert.equal((await install(setup)).managedInstall?.operation?.failure, "archive_invalid");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);

  // A working update activates, keeping 1.5.14 as the previous generation.
  server.publish({ platform: PLATFORM, version: "1.7.0", archive: release("1.7.0") });
  const updated = await install(setup);
  assert.equal(updated.managedInstall?.operation?.status, "succeeded");
  assert.equal(updated.executable?.version, "1.7.0");
  assert.equal(updated.managedInstall?.active?.version, "1.7.0");
  assert.equal(updated.managedInstall?.previousVersion, "1.5.14");
  assert.equal(readlinkSync(join(managedRoot, "previous")), working);
  assertAllValid(published);
});

test("an unrecognized installer, an off-origin redirect or a timeout fails closed with its own reason", async () => {
  const unrecognized = new FakeReleaseServer();
  unrecognized.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14"),
    installer: fakeInstallerScript({ base: "https://downloads.example.com" }) });
  const first = supervisor(unrecognized);
  await first.setup.check("never");
  const refused = await install(first.setup);
  assert.equal(refused.managedInstall?.operation?.failure, "installer_not_recognized");
  assert.equal(refused.status, "missing_runtime");
  assert.equal(refused.managedInstall?.available, true, "the install can be tried again, and the guidance still shows");
  assert.equal(existsSync(join(first.managedRoot, "current")), false);
  assert.deepEqual(unrecognized.requests, ["https://antigravity.google/cli/install.sh"]);

  const redirected = new FakeReleaseServer();
  const { archiveUrl } = redirected.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  redirected.set(archiveUrl, { status: 302, headers: { location: "https://mirror.example/cli.tar.gz" } });
  const second = supervisor(redirected);
  await second.setup.check("never");
  assert.equal((await install(second.setup)).managedInstall?.operation?.failure, "redirect_refused");
  assert.ok(!redirected.requests.includes("https://mirror.example/cli.tar.gz"));

  const hanging = new FakeReleaseServer();
  const hung = hanging.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  hanging.set(hung.archiveUrl, { hang: true });
  const third = supervisor(hanging, { downloadTimeoutMs: 100 });
  await third.setup.check("never");
  assert.equal((await install(third.setup)).managedInstall?.operation?.failure, "timed_out");
  assertAllValid([...first.published, ...second.published, ...third.published]);
});

test("a working managed copy is preferred; the PATH copy is the fallback and keeps its own behavior", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot } = supervisor(server, { resolveExecutable: async () => pathAgy });

  const fromPath = await setup.check("never");
  assert.deepEqual(fromPath.executable, { path: pathAgy, version: "1.4.2", source: "path" });
  assert.equal(fromPath.managedInstall?.pathExecutable, pathAgy);
  // The PATH copy keeps its own self-update behavior.
  assert.ok(environments().filter((entry) => entry.copy === "path").every((entry) => entry.autoUpdateDisabled === null));
  assert.equal(setup.launchTarget()?.context.env[ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV], undefined);

  const managed = await install(setup);
  assert.equal(managed.executable?.source, "managed");
  assert.equal(managed.managedInstall?.pathExecutable, pathAgy);

  // A managed copy that stops working falls back to the PATH copy and says so.
  writeFileSync(join(managedRoot, "current", "agy"), "#!/bin/sh\nexit 3\n");
  const fallback = await setup.check("never");
  assert.equal(fallback.status, "ready");
  assert.equal(fallback.executable?.source, "path");
  assert.equal(fallback.managedInstall?.activeCheckFailed, true);
  assert.equal(fallback.managedInstall?.active?.version, "1.5.14");
  assert.ok(validAntigravitySetupView(fallback));

  // Without a PATH copy, the managed copy's failure is the result.
  const alone = supervisor(server);
  await install(alone.setup);
  writeFileSync(join(alone.managedRoot, "current", "agy"), "#!/bin/sh\nexit 3\n");
  const failed = await alone.setup.check("never");
  assert.equal(failed.status, "verification_failed");
  assert.equal(failed.failure, "version_check_failed");
  assert.equal(failed.executable?.source, "managed");
  assert.ok(validAntigravitySetupView(failed));

  // A PATH entry that leads into the managed folder is not a separate fallback.
  const looping = supervisor(server, { resolveExecutable: async () => join(looping.managedRoot, "current", "agy") });
  await install(looping.setup);
  assert.equal(looping.setup.current().managedInstall?.pathExecutable, undefined);
});

test("Google's latest release is read on a person's check or at start with a managed copy, never otherwise", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup } = supervisor(server, { resolveExecutable: async () => pathAgy });

  await setup.check("if_managed");
  await setup.check("never");
  assert.deepEqual(server.requests, [], "no managed copy: nothing is read at start");
  const checked = await setup.check("always");
  assert.equal(checked.managedInstall?.latest?.version, "1.5.14");
  assert.equal(server.requests.length, 2, "the installer and the manifest, not the archive");

  await install(setup);
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0") });
  const atStart = await setup.check("if_managed");
  assert.equal(atStart.managedInstall?.latest?.version, "1.6.0");
  assert.equal(atStart.managedInstall?.active?.version, "1.5.14");

  // An unreadable manifest offers nothing rather than a stale version.
  server.set("https://antigravity.google/cli/install.sh", { status: 503 });
  const unreadable = await setup.check("always");
  assert.equal(unreadable.managedInstall?.latest, undefined);
  assert.equal(unreadable.status, "ready");
});

test("an install is refused on unmapped platforms and while a sign-in, check or install runs", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });

  const unmapped = supervisor(server, { arch: "ia32" });
  const view = await unmapped.setup.check("always");
  assert.deepEqual(view.managedInstall, { available: false });
  assert.throws(() => unmapped.setup.startInstall(), /no Antigravity release/u);
  assert.deepEqual(server.requests, []);

  const windows = supervisor(server, { platform: "win32" });
  assert.equal((await windows.setup.check("always")).managedInstall, undefined);
  assert.throws(() => windows.setup.startInstall(), /Linux and macOS/u);

  const busy = supervisor(server, { resolveExecutable: async () => pathAgy });
  await busy.setup.check("never");
  busy.setup.startInstall();
  assert.throws(() => busy.setup.startInstall(), /already being installed/u);
  assert.throws(() => busy.setup.startSignIn(), /being installed/u);
  assert.equal((await busy.setup.check("always")).managedInstall?.operation?.status, "running", "a check waits for the install");
  await until(busy.setup, settled);

  const signingIn = supervisor(server, { resolveExecutable: async () => pathAgy });
  await signingIn.setup.check("never");
  rmSync(join(state, "signed-in"));
  signingIn.setup.startSignIn();
  assert.throws(() => signingIn.setup.startInstall(), /sign-in/u);
});

test("a control plane before v404 receives the setup without the managed install fields", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup } = supervisor(server);
  const view = await install(setup);
  const legacy = antigravitySetupForControlPlane(view, false);
  assert.equal(legacy.managedInstall, undefined);
  assert.equal(legacy.executable?.source, undefined);
  assert.equal(legacy.executable?.path, view.executable?.path);
  assert.deepEqual(antigravitySetupForControlPlane(view, true), view);
  // The v403 shape: only the keys an older validator accepts.
  assert.deepEqual(Object.keys(legacy).sort(), ["checkedAt", "credentialStore", "executable", "models", "status", "version"]);
  assert.deepEqual(Object.keys(legacy.executable!).sort(), ["path", "version"]);
});

test("a runner that starts stopping during activation keeps the version it had", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  let stopAt: string | undefined;
  let target: AntigravitySetupSupervisor | undefined;
  const { setup, managedRoot } = supervisor(server, {
    onUpdate: (view) => { if (stopAt && view.managedInstall?.operation?.stage === stopAt) { stopAt = undefined; target?.shutdown(); } },
  });
  target = setup;
  await install(setup);
  const working = readlinkSync(join(managedRoot, "current"));

  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0") });
  stopAt = "activating";
  setup.startInstall();
  const stopped = await until(setup, (view) => view.managedInstall?.operation?.status === "failed");
  assert.equal(stopped.managedInstall?.operation?.failure, "activation_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(stopped.managedInstall?.active?.version, "1.5.14");
  assert.equal(readdirSync(join(managedRoot, "generations")).length, 1, "the unactivated generation is removed");
});

test("an update that fails the access check its predecessor passed is rolled back", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, published, managedRoot } = supervisor(server);
  assert.equal((await install(setup)).status, "ready");
  const working = readlinkSync(join(managedRoot, "current"));

  // 1.6.0 starts and initializes, but can't open a session with the runner's sign-in.
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0", "session_error") });
  const rolledBack = await install(setup);
  assert.equal(rolledBack.managedInstall?.operation?.status, "failed");
  assert.equal(rolledBack.managedInstall?.operation?.failure, "access_check_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(rolledBack.status, "ready");
  assert.equal(rolledBack.executable?.version, "1.5.14");
  assert.equal(rolledBack.managedInstall?.active?.version, "1.5.14");
  assert.equal(readdirSync(join(managedRoot, "generations")).length, 1, "the rejected generation is removed");
  assertAllValid(published);

  // A first managed copy beside a ready PATH copy is held to the same standard: on failure the
  // managed copy is removed and the PATH copy is used again.
  const beside = supervisor(server, { resolveExecutable: async () => pathAgy });
  assert.equal((await beside.setup.check("never")).status, "ready");
  const removed = await install(beside.setup);
  assert.equal(removed.managedInstall?.operation?.failure, "access_check_failed");
  assert.equal(removed.status, "ready");
  assert.equal(removed.executable?.source, "path");
  assert.equal(existsSync(join(beside.managedRoot, "current")), false);
  // Every report during the rollback is valid: none names the removed copy as the managed release.
  assertAllValid(beside.published);

  // Without a sign-in, a first install that only needs one succeeds: nothing worked before it.
  rmSync(join(state, "signed-in"));
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const unsigned = supervisor(server);
  assert.equal((await unsigned.setup.check("never")).status, "missing_runtime");
  const installed = await install(unsigned.setup);
  assert.equal(installed.managedInstall?.operation?.status, "succeeded");
  assert.equal(installed.status, "sign_in_required");
  assert.equal(installed.executable?.source, "managed");
});

test("a staged release is validated without the runner user's runtime folder or session bus", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const saved = { runtime: process.env.XDG_RUNTIME_DIR, bus: process.env.DBUS_SESSION_BUS_ADDRESS };
  process.env.XDG_RUNTIME_DIR = "/run/user/fixture";
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/fixture/bus";
  try {
    const { setup, managedRoot } = supervisor(server);
    await install(setup);
    const runs = environments().filter((entry) => entry.copy === "managed-1.5.14");
    const validation = runs.filter((entry) => entry.home?.startsWith(join(managedRoot, "staging")));
    assert.equal(validation.length, 3);
    for (const entry of validation) {
      assert.equal(entry.runtimeDir, entry.home, "the runtime folder is the private scratch folder");
      assert.equal(entry.sessionBus, null);
    }
    // Once active, the managed copy runs in the runner user's own session, as the PATH copy would.
    const active = runs.filter((entry) => !validation.includes(entry));
    assert.ok(active.length > 0 && active.every((entry) => entry.sessionBus === "unix:path=/run/user/fixture/bus"));
  } finally {
    for (const [name, value] of [["XDG_RUNTIME_DIR", saved.runtime], ["DBUS_SESSION_BUS_ADDRESS", saved.bus]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a PATH entry leading into the managed folder doesn't hide a separate copy later on PATH", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const aliased = supervisor(server, {
    resolveExecutables: async () => [join(aliased.managedRoot, "current", "agy"), pathAgy],
  });
  await install(aliased.setup);
  assert.equal(aliased.setup.current().managedInstall?.pathExecutable, pathAgy);
  writeFileSync(join(aliased.managedRoot, "current", "agy"), "#!/bin/sh\nexit 3\n");
  const fallback = await aliased.setup.check("never");
  assert.equal(fallback.executable?.source, "path");
  assert.equal(fallback.executable?.path, pathAgy);
  assert.equal(fallback.managedInstall?.activeCheckFailed, true);
});

test("an update is verified by itself: a working PATH copy can't pass it on the new version's behalf", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot, published } = supervisor(server, { resolveExecutable: async () => pathAgy });
  await setup.check("never");
  assert.equal((await install(setup)).executable?.source, "managed");
  const working = readlinkSync(join(managedRoot, "current"));

  // 1.6.0 passes every staged check, but its version check fails in the runner user's own HOME.
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0", "version_fail_outside_staging") });
  const failed = await install(setup);
  assert.equal(failed.managedInstall?.operation?.failure, "access_check_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(failed.executable?.source, "managed");
  assert.equal(failed.executable?.version, "1.5.14");
  assert.equal(failed.status, "ready");
  assertAllValid(published);
});

/** A ready managed 1.5.14, then an update to `candidate` during which the managed folder becomes
 * unwritable as soon as the candidate's own check starts (its pointers have already moved). */
async function updateWithBlockedFolder(candidate: Buffer) {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  let block = false;
  let root = "";
  const views: AntigravitySetupView[] = [];
  const created = supervisor(server, {
    onUpdate: (view) => {
      views.push(view);
      if (block && view.managedInstall?.operation?.stage === "activating" && view.status === "checking") {
        block = false;
        chmodSync(root, 0o500);
      }
    },
  });
  root = created.managedRoot;
  await install(created.setup);
  const working = readlinkSync(join(root, "current"));
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: candidate });
  block = true;
  created.setup.startInstall();
  const failed = await until(created.setup, (view) => view.managedInstall?.operation?.status === "failed" && view.status !== "checking");
  return { ...created, server, views, working, failed, unblock: () => chmodSync(root, 0o700) };
}

test("a rollback that fails is reported as such, blocks new installs, and the next check restores the version it replaced", async () => {
  const blocked = await updateWithBlockedFolder(release("1.6.0", "session_error"));
  const { setup, managedRoot, working, failed, views } = blocked;
  try {
    assert.equal(failed.managedInstall?.operation?.failure, "rollback_failed");
    assert.notEqual(readlinkSync(join(managedRoot, "current")), working, "the rejected version is still current");
    assert.equal(await setup.verifiedLaunchTarget(), null, "no session can launch the rejected version (#4779)");
    assert.ok(existsSync(join(managedRoot, "pending-activation.json")), "the pending record stays for a retry");
    // Nothing new is installed over a record that still names the last working version.
    assert.throws(() => setup.startInstall(), /hasn't restored the version before the last update/u);
  } finally {
    blocked.unblock();
  }
  const recovered = await setup.check("never");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(existsSync(join(managedRoot, "pending-activation.json")), false);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.executable?.version, "1.5.14");
  assert.equal(recovered.managedInstall?.active?.version, "1.5.14");
  assert.equal((await setup.verifiedLaunchTarget())?.command, realpathSync(join(managedRoot, working, "agy")),
    "after the restore, sessions launch the verified working generation");
  // Once restored, the outcome is the failed check the update began with, not a pending rollback.
  assert.equal(recovered.managedInstall?.operation?.failure, "access_check_failed");
  assertAllValid(views);
});

test("a restore whose only failure is removing the rejected folder counts as restored", async () => {
  const blocked = await updateWithBlockedFolder(release("1.6.0", "session_error"));
  const { setup, managedRoot, working, failed } = blocked;
  assert.equal(failed.managedInstall?.operation?.failure, "rollback_failed");
  const rejected = join(managedRoot, readlinkSync(join(managedRoot, "current")));
  blocked.unblock();
  // The pointers and the record can be restored; the rejected folder's contents can't be removed.
  chmodSync(rejected, 0o500);
  try {
    const recovered = await setup.check("never");
    assert.equal(readlinkSync(join(managedRoot, "current")), working);
    assert.equal(existsSync(join(managedRoot, "pending-activation.json")), false);
    assert.equal(recovered.managedInstall?.operation?.failure, "access_check_failed");
    assert.equal(recovered.executable?.version, "1.5.14");
    // Nothing is pending, so an install isn't refused.
    assert.doesNotThrow(() => setup.startInstall());
    await until(setup, settled);
  } finally {
    chmodSync(rejected, 0o700);
  }
});

test("Try Again after a failed rollback first restores the last working version and holds the retry to it", async () => {
  const blocked = await updateWithBlockedFolder(release("1.6.0", "session_error"));
  const { setup, managedRoot, working, failed, server } = blocked;
  assert.equal(failed.managedInstall?.operation?.failure, "rollback_failed");
  blocked.unblock();
  // Retried before any check, with a release that asks for a new sign-in. The restored version
  // works with the existing sign-in, so asking for one is worse and the retry is refused.
  server.publish({ platform: PLATFORM, version: "1.6.1", archive: release("1.6.1", "session_auth_required") });
  const retried = await install(setup);
  assert.equal(retried.managedInstall?.operation?.failure, "access_check_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(existsSync(join(managedRoot, "pending-activation.json")), false);
  const checked = await setup.check("never");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(checked.executable?.version, "1.5.14");
});

test("an update that passes its check but can't be committed is not reported as a success", async () => {
  // A healthy candidate: only the folder fault stops it.
  const blocked = await updateWithBlockedFolder(release("1.6.0"));
  const { setup, managedRoot, working, failed } = blocked;
  try {
    assert.notEqual(failed.managedInstall?.operation?.status, "succeeded");
    assert.equal(failed.managedInstall?.operation?.failure, "rollback_failed");
    assert.ok(existsSync(join(managedRoot, "pending-activation.json")));
    // The candidate passed its checks, the one after the failed rollback included, but was never
    // committed (#4779): sessions keep launching the committed generation, which is still kept.
    const candidate = realpathSync(join(managedRoot, "current", "agy"));
    const committed = realpathSync(join(managedRoot, working, "agy"));
    assert.notEqual(candidate, committed);
    assert.equal(setup.current().status, "ready");
    assert.equal((await setup.verifiedLaunchTarget())?.command, committed);
    assert.equal(setup.launchableTarget()?.command, committed);
    assert.ok(existsSync(committed));
  } finally {
    blocked.unblock();
  }
  const recovered = await setup.check("never");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(recovered.executable?.version, "1.5.14");
  // The candidate passed its check: once restored, the outcome is the failed commit.
  assert.equal(recovered.managedInstall?.operation?.failure, "activation_failed");
});

test("a runner that exits mid-verification restores the replaced version when it starts again", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const first = supervisor(server);
  await install(first.setup);
  const working = readlinkSync(join(first.managedRoot, "current"));
  first.setup.shutdown();

  // The runner activated 1.6.0 and exited before verifying it: the pending record remains.
  const store = new AntigravityManagedStore(first.managedRoot);
  const staging = await store.createStaging(Date.now());
  writeFileSync(join(staging.directory, "agy"), fakeAgyWrapper({ fixture: FIXTURE, version: "1.6.0", mode: "session_hang" }), { mode: 0o755 });
  const activation = await store.activate(staging, { ...store.read("current")!.release, version: "1.6.0" });
  assert.equal(readlinkSync(join(first.managedRoot, "current")), `generations/${activation.generation.id}`);

  const restarted = new AntigravitySetupSupervisor({
    dataDir: first.dataDir, platform: "linux", arch: "x64", musl: () => false, resolveExecutable: async () => null,
    fetch: server.fetch, onUpdate: () => {},
  });
  supervisors.push(restarted);
  assert.equal(readlinkSync(join(first.managedRoot, "current")), working, "restored before the first check");
  assert.equal(existsSync(activation.generation.directory), false);
  assert.equal(restarted.current().managedInstall?.active?.version, "1.5.14");
  assert.equal((await restarted.check("never")).executable?.version, "1.5.14");
});

test("a runner that starts stopping during verification never confirms the new version", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  let stopDuringCheck = false;
  let target: AntigravitySetupSupervisor | undefined;
  const { setup, managedRoot } = supervisor(server, {
    onUpdate: (view) => {
      if (stopDuringCheck && view.managedInstall?.operation?.stage === "activating" && view.status === "checking") {
        stopDuringCheck = false;
        target?.shutdown();
      }
    },
  });
  target = setup;
  await install(setup);
  const working = readlinkSync(join(managedRoot, "current"));
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0") });
  stopDuringCheck = true;
  setup.startInstall();
  const stopped = await until(setup, (view) => view.managedInstall?.operation?.status === "failed");
  assert.equal(stopped.managedInstall?.operation?.failure, "activation_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.equal(existsSync(join(managedRoot, "pending-activation.json")), false);
});

test("updates beside a broken managed copy keep the working PATH fallback in use", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot, published } = supervisor(server, { resolveExecutable: async () => pathAgy });
  await setup.check("never");
  await install(setup);
  // The managed copy breaks with a definite version failure; the signed-in PATH copy is in use.
  writeFileSync(join(managedRoot, "current", "agy"), "#!/bin/sh\nexit 3\n");
  const broken = readlinkSync(join(managedRoot, "current"));
  const fallback = await setup.check("never");
  assert.equal(fallback.status, "ready");
  assert.equal(fallback.executable?.source, "path");

  // An update that stops before activation (a tampered archive) leaves the PATH copy selected.
  server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0"), manifestSha512: "0".repeat(128) });
  const tampered = await install(setup);
  assert.equal(tampered.managedInstall?.operation?.failure, "checksum_mismatch");
  assert.equal(tampered.status, "ready");
  assert.equal(tampered.executable?.source, "path");
  assert.equal(tampered.managedInstall?.activeCheckFailed, true);
  assert.equal(setup.launchTarget()?.command, pathAgy);

  // A candidate that asks for a sign-in is worse than the signed-in PATH copy: it is rolled back.
  server.publish({ platform: PLATFORM, version: "1.6.1", archive: release("1.6.1", "session_auth_required") });
  const refused = await install(setup);
  assert.equal(refused.managedInstall?.operation?.failure, "access_check_failed");
  assert.equal(readlinkSync(join(managedRoot, "current")), broken);
  assert.equal(refused.status, "ready");
  assert.equal(refused.executable?.source, "path");
  assert.equal(setup.launchTarget()?.command, pathAgy);
  assertAllValid(published);
});

test("a PATH copy can't stand in for a managed copy whose baseline check timed out", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  // A separate PATH copy that asks for a sign-in even though the managed copy's sign-in works.
  const unsignedPath = join(root, "path-agy-unsigned");
  writeFileSync(unsignedPath, `#!/bin/sh\nFAKE_AGY_MODE=session_auth_required exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(unsignedPath, 0o755);
  const { setup, managedRoot } = supervisor(server, { resolveExecutable: async () => unsignedPath, versionTimeoutMs: 1_000 });
  assert.equal((await install(setup)).status, "ready");
  const working = readlinkSync(join(managedRoot, "current"));

  const { archiveUrl, manifestUrl } = server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0", "session_auth_required") });
  // The managed copy's version check stalls once during the update's baseline.
  writeFileSync(join(state, "hang-next-version"), "");
  const requestsBefore = server.requests.length;
  const stopped = await install(setup);
  assert.equal(stopped.managedInstall?.operation?.failure, "timed_out");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  const requested = server.requests.slice(requestsBefore);
  assert.ok(!requested.includes(manifestUrl) && !requested.includes(archiveUrl), "no release was read");
  const checked = await setup.check("never");
  assert.equal(checked.status, "ready");
  assert.equal(checked.executable?.source, "managed");
  assert.equal(checked.executable?.version, "1.5.14");
});

test("an update stops before it starts when the copy in use can't be checked in time", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot, published } = supervisor(server, { sessionTimeoutMs: 1_000 });
  assert.equal((await install(setup)).status, "ready");
  const working = readlinkSync(join(managedRoot, "current"));

  // The candidate asks for a new sign-in; the working copy's own check is interrupted once.
  const { archiveUrl } = server.publish({ platform: PLATFORM, version: "1.6.0", archive: release("1.6.0", "session_auth_required") });
  writeFileSync(join(state, "hang-next-session"), "");
  const stopped = await install(setup);
  assert.equal(stopped.managedInstall?.operation?.failure, "timed_out");
  assert.equal(readlinkSync(join(managedRoot, "current")), working);
  assert.ok(!server.requests.includes(archiveUrl), "nothing was downloaded");
  assert.equal(readdirSync(join(managedRoot, "generations")).length, 1);
  const checked = await setup.check("never");
  assert.equal(checked.status, "ready");
  assert.equal(checked.executable?.version, "1.5.14");
  assertAllValid(published);
});

test("a session launch waits for a running install to verify before reading its target (#4779)", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot } = supervisor(server);
  await setup.check("never");
  assert.equal(await setup.verifiedLaunchTarget(), null, "nothing verified yet: a launch is refused");
  setup.startInstall();
  assert.equal(setup.current().managedInstall?.operation?.status, "running");
  // Asked while the install runs, the answer waits for it, its verification included.
  const target = await setup.verifiedLaunchTarget();
  const view = setup.current();
  assert.equal(view.managedInstall?.operation?.status, "succeeded", "the install, its verification included, finished first");
  assert.equal(view.status, "ready");
  // A session launches the verified generation by its own path, never the movable `current/agy`.
  const generation = realpathSync(join(managedRoot, "current", "agy"));
  assert.notEqual(generation, join(managedRoot, "current", "agy"));
  assert.equal(target?.command, generation);
  assert.equal(target?.context.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true", "the managed copy launches with its updater off");
  assert.ok((target?.accessObservedAt ?? 0) > 0);
});

test("a launch resolves its executable when it spawns, so two updates after its preparation can't remove it (#4779)", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot } = supervisor(server);
  await install(setup);
  // The launch is prepared against 1.5.14, then awaits (isolation, provider home) while two
  // updates commit: the second prunes 1.5.14.
  const prepared = await setup.verifiedLaunchTarget();
  assert.ok(prepared && existsSync(prepared.command));
  for (const version of ["1.6.0", "1.7.0"]) {
    server.publish({ platform: PLATFORM, version, archive: release(version) });
    assert.equal((await install(setup)).managedInstall?.operation?.status, "succeeded");
  }
  assert.equal(existsSync(prepared.command), false, "the generation chosen at preparation is gone");
  const resolveLaunch = antigravityLaunchResolver(setup);
  const spawned = resolveAcpLaunch(prepared.command, { profile: "antigravity", resumable: false, resolveLaunch });
  assert.equal(spawned.command, realpathSync(join(managedRoot, "current", "agy")), "the committed 1.7.0, by its generation path");
  assert.ok(existsSync(spawned.command));
  assert.deepEqual(spawned.compatibility?.pinnedEnvironment, { [ANTIGRAVITY_DISABLE_AUTO_UPDATE_ENV]: "true" });
  spawned.release?.();
});

test("a launcher that opens the resolved generation late still finds it after two commits (#4779)", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  const { setup, managedRoot } = supervisor(server);
  await install(setup);
  const g1 = realpathSync(join(managedRoot, "current", "agy"));
  // A launcher (as bwrap or the cgroup helper would be) that opens the executable only once a gate
  // file appears, long after the runner spawned it.
  const gate = join(state, "launcher-gate");
  const script = `while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.02; done; exec "$0" "$@"`;
  let spawnedCommand: string | undefined;
  const cwd = mkdtempSync(join(root, "worktree-"));
  const driver = new AcpDriver({
    command: g1, args: ["acp"], env: {}, cwd, config: {}, context: { kind: "native" },
    acpCompatibility: { profile: "antigravity", resumable: false, resolveLaunch: antigravityLaunchResolver(setup) },
  }, { onEvent: () => {}, onStderr: () => {}, onExit: () => {} } as never, {
    spawn: (options) => {
      spawnedCommand = options.command;
      return spawnAgent({ ...options, command: "/bin/sh", args: ["-c", script, options.command, ...options.args] });
    },
  });
  try {
    assert.equal(spawnedCommand, g1);
    for (const version of ["1.6.0", "1.7.0"]) {
      server.publish({ platform: PLATFORM, version, archive: release(version) });
      assert.equal((await install(setup)).managedInstall?.operation?.status, "succeeded");
    }
    assert.notEqual(realpathSync(join(managedRoot, "previous", "agy")), g1, "neither pointer names 1.5.14 any more");
    assert.ok(existsSync(g1), "the launch still needs 1.5.14, so no commit removed it");
    writeFileSync(gate, "open");
    await driver.initialize();
    // Answered: the launch no longer holds it, and the next commit removes it.
    server.publish({ platform: PLATFORM, version: "1.8.0", archive: release("1.8.0") });
    assert.equal((await install(setup)).managedInstall?.operation?.status, "succeeded");
    assert.equal(existsSync(g1), false);
  } finally {
    driver.dispose();
  }
});

test("a first install that passes its check but can't be committed is not offered in New Session (#4779)", async () => {
  const server = new FakeReleaseServer();
  server.publish({ platform: PLATFORM, version: "1.5.14", archive: release("1.5.14") });
  let block = false;
  let managedFolder = "";
  // No PATH copy: the candidate is the only Antigravity on this machine.
  const created = supervisor(server, {
    onUpdate: (view) => {
      if (block && view.managedInstall?.operation?.stage === "activating" && view.status === "checking") {
        block = false;
        chmodSync(managedFolder, 0o500);
      }
    },
  });
  managedFolder = created.managedRoot;
  const { setup } = created;
  block = true;
  setup.startInstall();
  const failed = await until(setup, (view) => view.managedInstall?.operation?.status === "failed" && view.status !== "checking");
  try {
    assert.equal(failed.managedInstall?.operation?.failure, "rollback_failed");
    assert.equal(failed.status, "ready", "the uncommitted candidate itself passed its check");
    assert.equal(setup.launchableTarget(), null, "nothing committed can be launched");
    assert.equal(await setup.verifiedLaunchTarget(), null);
    const row = antigravityAgentDefinition(failed, setup.credentialContext(true), { mode: "provider", network: "inherit" },
      setup.launchableTarget() !== null)!;
    assert.equal(row.available, false, "New Session doesn't offer what every launch would refuse");
    assert.equal(row.unavailableReason, ANTIGRAVITY_UNAVAILABLE.checkFailed);
  } finally {
    chmodSync(managedFolder, 0o700);
  }
});

test("access is observed when the probe's session opens, before its cleanup, so a sign-out during cleanup stands (#4779)", async () => {
  // Wall-clock based: request deadlines are computed on it.
  let clock = Date.now();
  const kills: number[] = [];
  const { setup } = supervisor(new FakeReleaseServer(), {
    resolveExecutable: async () => pathAgy,
    now: () => clock,
    // Every process cleanup takes a while on this clock.
    kill: async (child) => {
      kills.push(clock);
      clock += 1_000;
      return killTreeAndWait(child);
    },
  });
  const view = await setup.check("never");
  assert.equal(view.status, "ready");
  const observed = setup.accessObservedAt();
  const probeCleanup = kills.at(-1)!;
  assert.ok(observed !== undefined && observed <= probeCleanup, "stamped before the access probe's cleanup began");
  // A session reported the sign-out while the probe was being cleaned up: that check doesn't clear it.
  assert.equal(antigravitySignOutSuperseded(view, observed, probeCleanup + 500), false);
  assert.equal(antigravitySignOutSuperseded(view, observed, observed - 1), true);
});
