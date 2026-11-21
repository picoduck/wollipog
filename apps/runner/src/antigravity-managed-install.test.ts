import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function environments(): Array<{ label: string; copy: string; home: string | null; autoUpdateDisabled: string | null; present: string[] }> {
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
