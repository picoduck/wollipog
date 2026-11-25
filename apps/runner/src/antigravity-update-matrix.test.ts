import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validAntigravitySetupView, type AntigravitySetupView } from "@wollipog/protocol";
import { AntigravityManagedStore } from "./antigravity-install.js";
import { AntigravitySetupSupervisor } from "./antigravity-setup.js";
import { FakeReleaseServer, FIXTURE_MANIFEST_BASE, fakeAgyWrapper, fakeTarGz } from "./fixtures/antigravity/fake-release.js";

// The update decision as a table (Refs #4780): every managed copy state × PATH copy state ×
// candidate release, asserting whether the update proceeds, its failure, and which copy stays
// selected. Each case runs the real supervisor against fake releases and the fake CLI
// (fixtures/antigravity/), with no network.
//
// The rule under test: an update first runs the ordinary check. A check that timed out (including
// a managed version check that timed out while the PATH copy stood in) stops it before anything is
// downloaded. Otherwise the activated candidate, checked alone, must reach at least the baseline's
// rank and at least "sign-in required" (ready 2, sign-in required 1, anything else 0), or it is
// rolled back and the copy selected before stays selected.

const FIXTURE = fileURLToPath(new URL("./fixtures/antigravity/fake-agy.mjs", import.meta.url));
const PLATFORM = "linux_amd64";
const root = mkdtempSync(join(tmpdir(), "antigravity-matrix-test-"));
const supervisors: AntigravitySetupSupervisor[] = [];
after(() => {
  for (const supervisor of supervisors) supervisor.shutdown();
  rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_AGY_STATE;
  delete process.env.FAKE_AGY_MODE;
});

type Managed = "absent" | "ok" | "version_timeout" | "sign_in_required" | "broken";
type PathCopy = "absent" | "ok" | "sign_in_required";
type Candidate = "ok" | "sign_in_required" | "validation_fail" | "timeout";

const MANAGED: Managed[] = ["absent", "ok", "version_timeout", "sign_in_required", "broken"];
const PATHS: PathCopy[] = ["absent", "ok", "sign_in_required"];
const CANDIDATES: Candidate[] = ["ok", "sign_in_required", "validation_fail", "timeout"];

function wrapper(path: string, mode?: string): string {
  writeFileSync(path, `#!/bin/sh\n${mode ? `FAKE_AGY_MODE=${mode} ` : ""}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

const CANDIDATE_MODE: Record<Candidate, string | undefined> = {
  ok: undefined,
  sign_in_required: "session_auth_required",
  validation_fail: "acp_help_fail",
  timeout: "session_hang",
};

/** What the rule above predicts. */
function expected(managed: Managed, path: PathCopy, candidate: Candidate): {
  proceeds: boolean;
  failure?: string;
  selected: { source?: "managed" | "path"; version?: string };
} {
  // The copy selected before the update, and its rank.
  const before: { rank: number; selected: { source?: "managed" | "path"; version?: string } } =
    managed === "ok" ? { rank: 2, selected: { source: "managed", version: "1.5.14" } }
      : managed === "sign_in_required" ? { rank: 1, selected: { source: "managed", version: "1.5.14" } }
        : managed === "broken" || managed === "absent"
          ? path === "ok" ? { rank: 2, selected: { source: "path", version: "1.4.2" } }
            : path === "sign_in_required" ? { rank: 1, selected: { source: "path", version: "1.4.2" } }
              : { rank: 0, selected: managed === "broken" ? { source: "managed" } : {} }
          // A version timeout leaves the update stopped; the copy itself works once checked again.
          : { rank: -1, selected: { source: "managed", version: "1.5.14" } };
  if (managed === "version_timeout") return { proceeds: false, failure: "timed_out", selected: before.selected };
  if (candidate === "validation_fail") return { proceeds: false, failure: "validation_failed", selected: before.selected };
  const rank = candidate === "ok" ? 2 : candidate === "sign_in_required" ? 1 : 0;
  return rank >= Math.max(before.rank, 1)
    ? { proceeds: true, selected: { source: "managed", version: "1.6.0" } }
    : { proceeds: false, failure: "access_check_failed", selected: before.selected };
}

async function seedManaged(managedRoot: string, mode: string | undefined): Promise<void> {
  const store = new AntigravityManagedStore(managedRoot);
  const staging = await store.createStaging(Date.now());
  writeFileSync(join(staging.directory, "agy"), fakeAgyWrapper({ fixture: FIXTURE, version: "1.5.14", mode }), { mode: 0o755 });
  await store.activate(staging, {
    version: "1.5.14", activatedAt: 1, installerSha256: "0".repeat(64),
    manifestUrl: `${FIXTURE_MANIFEST_BASE}/manifests/${PLATFORM}.json`,
    archiveUrl: "https://storage.googleapis.com/antigravity-public/1.5.14-fixture/cli.tar.gz", archiveSha512: "0".repeat(128),
  });
  await store.confirm();
  await store.discardStaging();
}

async function until(setup: AntigravitySetupSupervisor, predicate: (view: AntigravitySetupView) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = setup.current();
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`timed out waiting; last setup: ${JSON.stringify(view)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const managed of MANAGED) {
  for (const path of PATHS) {
    for (const candidate of CANDIDATES) {
      const want = expected(managed, path, candidate);
      test(`managed ${managed} × PATH ${path} × candidate ${candidate}: ${want.proceeds ? "updates" : `stops (${want.failure})`}, ` +
        `${want.selected.source ?? "nothing"} selected`, async () => {
        const state = mkdtempSync(join(root, "state-"));
        process.env.FAKE_AGY_STATE = state;
        delete process.env.FAKE_AGY_MODE;
        writeFileSync(join(state, "signed-in"), "fixture");
        const dataDir = mkdtempSync(join(root, "data-"));
        const managedRoot = join(dataDir, "antigravity-managed");
        if (managed !== "absent") await seedManaged(managedRoot, managed === "sign_in_required" ? "session_auth_required" : undefined);
        if (managed === "broken") writeFileSync(join(managedRoot, "current", "agy"), "#!/bin/sh\nexit 3\n");
        const pathExecutable = path === "absent" ? null
          : wrapper(join(dataDir, `path-agy-${path}`), path === "sign_in_required" ? "session_auth_required" : undefined);

        const server = new FakeReleaseServer();
        const { archiveUrl } = server.publish({ platform: PLATFORM, version: "1.6.0",
          archive: fakeTarGz([{ name: "antigravity", content: fakeAgyWrapper({ fixture: FIXTURE, version: "1.6.0", mode: CANDIDATE_MODE[candidate] }) }]) });
        const published: AntigravitySetupView[] = [];
        const setup = new AntigravitySetupSupervisor({
          dataDir, platform: "linux", arch: "x64", musl: () => false, fetch: server.fetch,
          resolveExecutable: async () => pathExecutable, onUpdate: (view) => published.push(view),
          versionTimeoutMs: 1_000, sessionTimeoutMs: 1_000, handshakeTimeoutMs: 5_000,
        });
        supervisors.push(setup);
        await setup.check("never");
        const currentBefore = existsSync(join(managedRoot, "current")) ? readlinkSync(join(managedRoot, "current")) : null;
        if (managed === "version_timeout") writeFileSync(join(state, "hang-next-version"), "");

        const operationId = setup.startInstall().managedInstall?.operation?.operationId;
        const settled = await until(setup, (view) => view.managedInstall?.operation?.operationId === operationId &&
          view.managedInstall?.operation?.status !== "running" && view.status !== "checking");
        const operation = settled.managedInstall!.operation!;

        assert.equal(operation.status, want.proceeds ? "succeeded" : "failed");
        assert.equal(operation.failure, want.failure);
        const currentAfter = existsSync(join(managedRoot, "current")) ? readlinkSync(join(managedRoot, "current")) : null;
        if (want.proceeds) assert.notEqual(currentAfter, currentBefore, "the candidate is current");
        else assert.equal(currentAfter, currentBefore, "the copy before the update is current");
        assert.equal(existsSync(join(managedRoot, "pending-activation.json")), false, "nothing is left pending");
        if (want.failure === "timed_out") {
          assert.ok(!server.requests.includes(archiveUrl), "a timed-out baseline downloads nothing");
        }
        // Which copy is selected once the outcome settles (after a fresh check for a stopped
        // update whose baseline timed out, since the copy itself works).
        const view = want.failure === "timed_out" ? await setup.check("never") : settled;
        assert.equal(view.executable?.source, want.selected.source);
        if (want.selected.version) assert.equal(view.executable?.version, want.selected.version);
        if (view.executable?.source === "path") assert.equal(setup.launchTarget()?.command, pathExecutable);
        const generations = existsSync(join(managedRoot, "generations")) ? readdirSync(join(managedRoot, "generations")).length : 0;
        assert.ok(generations <= 2, "at most current and one previous generation remain");
        for (const entry of published) assert.ok(validAntigravitySetupView(entry), `invalid published setup ${JSON.stringify(entry)}`);
      });
    }
  }
}
