import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { buildBwrapArgs, spawnAgent, type BwrapSpawnIsolation } from "./spawn.js";

/** Never inherit this process's stdin: a sandboxed child that reads it blocks the whole suite. */
const RUN = { stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], encoding: "utf8" as const, timeout: 60_000 };

/** Probe the exact capability: a host AppArmor profile can deny unprivileged user namespaces even
 * when bubblewrap is installed, and that host should skip rather than report a false failure. */
function bubblewrapUsable(): boolean {
  if (process.platform !== "linux") return false;
  return spawnSync("bwrap", [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--unshare-pid", "--", "/bin/true",
  ], RUN).status === 0;
}
const SKIP_BWRAP = bubblewrapUsable() ? false : "bubblewrap cannot create a user namespace on this host";

const CODEX = process.env.CODEX_BIN || "codex";
/** Codex's inner sandbox opens this registry under $TMPDIR before it launches anything (#4150). */
const REGISTRY_PANIC = /synthetic bubblewrap mount registry/u;

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

/** A Codex App Server boundary resolved by the runner, with the runner's own TMPDIR inside its data
 * directory the way an installed runner stages helpers: outside /tmp and outside every writable bind. */
async function codexSessionFixture() {
  // Outside /tmp, so the runner's TMPDIR is a real host directory the private /tmp cannot cover.
  const root = realpathSync(mkdtempSync(join(process.cwd(), "wollipog-bwrap-tmpdir-")));
  roots.push(root);
  const dataDir = join(root, "data"), cwd = join(root, "worktree"), home = join(root, "home");
  const runnerTmp = join(dataDir, "runner", "helper-staging");
  for (const path of [cwd, home, runnerTmp]) mkdirSync(path, { recursive: true });
  const isolation = await resolveExecutionIsolation({ mode: "bwrap", network: "inherit" }, { kind: "native" }, {}, {
    driver: "codex-app-server", dataDir, env: { HOME: home }, sessionId: "s_tmpdir", cwd,
  });
  assert.ok(isolation?.backend === "bwrap");
  return { cwd, home, runnerTmp, isolation };
}

async function runSpawned(command: string, args: string[], cwd: string, env: Record<string, string>,
  isolation: BwrapSpawnIsolation): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawnAgent({ command, args, cwd, env, isolation, windowsShell: false });
  child.stdin.end();
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => (out += text));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => (err += text));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, out, err };
}

/** What Codex's inner sandbox does first: create its per-user registry directory and open the lock. */
const TAKE_REGISTRY_LOCK = [
  "-c", 'dir="$TMPDIR/codex-bwrap-synthetic-mount-targets-$(id -u)" && mkdir -p "$dir" && : > "$dir/lock" && printf %s "$TMPDIR"',
];

test("a Codex session's TMPDIR is writable under its real bwrap boundary", { skip: SKIP_BWRAP }, async () => {
  const { cwd, runnerTmp, isolation } = await codexSessionFixture();
  // Control: the same boundary with the runner's TMPDIR passed straight through is the reported bug.
  const raw = spawnSync(isolation.command, buildBwrapArgs({ command: "/bin/sh", args: TAKE_REGISTRY_LOCK, cwd }, isolation),
    { ...RUN, cwd, env: { ...process.env, TMPDIR: runnerTmp } });
  assert.notEqual(raw.status, 0, "the runner's TMPDIR must be read-only inside the boundary for this test to mean anything");
  assert.match(`${raw.stderr}`, /Read-only file system/u);

  const launched = await runSpawned("/bin/sh", TAKE_REGISTRY_LOCK, cwd, { TMPDIR: runnerTmp }, isolation);
  assert.equal(launched.code, 0, launched.err);
  assert.equal(launched.out, "/tmp");
});

test("a writable TMPDIR keeps its value under the real bwrap boundary", { skip: SKIP_BWRAP }, async () => {
  const { cwd, isolation } = await codexSessionFixture();
  const launched = await runSpawned("/bin/sh", TAKE_REGISTRY_LOCK, cwd, { TMPDIR: cwd }, isolation);
  assert.equal(launched.code, 0, launched.err);
  assert.equal(launched.out, cwd);
});

test("real codex sandbox: the inner sandbox takes its registry lock from a runner-launched session", {
  skip: SKIP_BWRAP,
}, async (t) => {
  const version = spawnSync(CODEX, ["--version"], RUN);
  if (version.error || version.status !== 0) { t.skip(`codex is not installed (${version.error?.message ?? version.stderr})`); return; }
  const { cwd, home, runnerTmp, isolation } = await codexSessionFixture();
  const codexHome = join(cwd, ".codex-home");
  mkdirSync(codexHome);
  const env = { HOME: home, CODEX_HOME: codexHome, TMPDIR: runnerTmp };
  const launched = await runSpawned(CODEX, ["sandbox", "--", "/bin/true"], cwd, env, isolation);
  t.diagnostic(JSON.stringify({ codex: version.stdout.trim(), code: launched.code, stderr: launched.err.slice(-400) }));
  // Nesting Codex's own bwrap can still fail on a host that forbids a second user namespace; that is
  // a host limit, not this bug, so only the registry panic is asserted.
  assert.doesNotMatch(launched.err, REGISTRY_PANIC);
});
