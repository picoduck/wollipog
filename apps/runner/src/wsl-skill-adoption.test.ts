import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentDefinition, MachineSkillCandidate, SkillFile } from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { handleSkillAdoption } from "./skill-adoption-command.js";
import {
  listSkillAdoptionRecoveryWithWsl,
  restoreSkillAdoptionRecoveryWithWsl,
} from "./skill-adoption-recovery.js";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { cacheSkillSyncEntry, skillsStoreRoot } from "./skills.js";
import { adoptWslSkill, type WslAdoptionEnvironment } from "./wsl-skill-adoption.js";
import { reconcileWslSkills, type WslRun } from "./wsl-skills.js";

// The in-distro helper is Linux Python. Linux CI runs it directly against a temporary HOME; the
// Windows Platform Isolation job runs the same flow through real WSL (wsl-skills.wsl.test.ts).
const local = { skip: process.platform !== "linux" || spawnSync("python3", ["--version"]).status !== 0 };
const ownerHash = "c".repeat(64);
const distro = "Ubuntu";
const agents: AgentDefinition[] = [
  { id: "codex-native", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  { id: "codex-wsl", name: "Codex WSL", command: "codex", args: [], env: {}, driver: "codex",
    context: { kind: "wsl", distro } },
];

type Checkpoint = { stage: string; command: "c" | "f" | "k"; action?: () => void };

/** Run a "WSL" command locally with a private HOME, streaming stdout so a test-only checkpoint can
 * act on the filesystem before releasing the helper. The checkpoint rides in the helper's stdin
 * specification, which production never writes. Rejections carry stdout like runContextCommand. */
function localRun(home: string, checkpoint?: Checkpoint, env: Record<string, string> = {}): WslRun {
  return (_context, command, args, options) => new Promise((resolve, reject) => {
    const control = checkpoint ? join(fs.mkdtempSync(join(tmpdir(), "wsl-adoption-control-")), "command") : "";
    // The bootstrap passes the helper source with `-c`; a helper operation passes its script path.
    const stdin = checkpoint && command === "python3" && args[0] !== "-c" && options.stdin
      ? JSON.stringify({ ...JSON.parse(options.stdin), testCheckpoint: { stage: checkpoint.stage, control } })
      : options.stdin;
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env, HOME: home } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let stdout = "", stderr = "", released = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!checkpoint || released || !stdout.includes("checkpoint\n")) return;
      released = true;
      checkpoint.action?.();
      fs.writeFileSync(`${control}.tmp`, checkpoint.command);
      fs.renameSync(`${control}.tmp`, control);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr || `exit ${code ?? signal}`), { stdout, stderr }));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
}

const files: SkillFile[] = [
  { path: "SKILL.md", encoding: "utf8", content: "---\nname: alpha\n---\nOriginal instructions" },
  { path: "binary", encoding: "base64", content: Buffer.from([0, 255, 254]).toString("base64") },
  // Names that exercise JSON escaping and UTF-16 ordering of the canonical digest.
  { path: "notes/q\"uote.md", encoding: "utf8", content: "quoted" },
  { path: "notes/é/😀.md", encoding: "utf8", content: "astral" },
  { path: "notes/\uff21.md", encoding: "utf8", content: "fullwidth" },
];

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "wsl-skill-adoption-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), nativeHome = join(root, "native"), dataDir = join(root, "data");
  const parent = join(home, ".codex/skills"), source = join(parent, "alpha");
  // WSL reconciliation refuses group- or world-writable harness directories, whatever the umask.
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  fs.chmodSync(join(home, ".codex"), 0o755);
  fs.chmodSync(parent, 0o755);
  for (const file of files) {
    fs.mkdirSync(join(source, file.path, ".."), { recursive: true });
    fs.writeFileSync(join(source, file.path), Buffer.from(file.content, file.encoding), { mode: 0o644 });
  }
  fs.mkdirSync(nativeHome);
  fs.mkdirSync(dataDir);
  const digest = skillVersionDigest(files);
  const entry = { name: "alpha", files, versionDigest: digest, targets: [{ agentId: "codex-wsl", invocation: "agent" as const }] };
  cacheSkillSyncEntry(dataDir, agents, entry);
  const storeRoot = fs.realpathSync(skillsStoreRoot(dataDir));
  const environment = (checkpoint?: Checkpoint): WslAdoptionEnvironment =>
    ({ ownerHash, dataDir, run: localRun(home, checkpoint), storeRoot: async () => storeRoot });
  const candidate: MachineSkillCandidate = { id: "wsl-candidate", name: "alpha", sourceDirectory: ".codex/skills",
    generation: "a".repeat(64), context: { kind: "wsl", distro } };
  const adopt = (checkpoint?: Checkpoint, overrides: Partial<Parameters<typeof adoptWslSkill>[0]> = {}) =>
    adoptWslSkill({ ...environment(checkpoint), agents, candidate, digest, assertAuthorized: () => undefined, ...overrides });
  const list = () => listSkillAdoptionRecoveryWithWsl(nativeHome, dataDir, agents, [], environment());
  const restore = (operationId: string, checkpoint?: Checkpoint) => restoreSkillAdoptionRecoveryWithWsl({
    home: nativeHome, dataDir, agents, operationId, acquireProviderHomeLease: () => assert.fail("WSL leases in-distro"),
  }, environment(checkpoint));
  const backups = () => fs.readdirSync(parent).filter((name) => name.startsWith(".wollipog-adoption-"));
  const target = join(storeRoot, "alpha", digest);
  return { root, home, dataDir, parent, source, entry, digest, storeRoot, candidate, environment, adopt, list, restore,
    backups, target };
}

test("WSL adoption preserves the original and publishes a link to the translated store", local, async (t) => {
  const f = fixture(t);
  const before = fs.statSync(f.source);
  const result = await f.adopt();
  assert.equal(result.status, "adopted", JSON.stringify(result));
  if (result.status !== "adopted") return;
  const backup = join(f.home, result.backupDirectory);
  assert.equal(fs.statSync(join(backup, "original")).ino, before.ino, "the original directory is renamed, not copied");
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(backup, "intent.json")).mode & 0o777, 0o600);
  const intent = JSON.parse(fs.readFileSync(join(backup, "intent.json"), "utf8"));
  assert.deepEqual([intent.format, intent.operationId, intent.sourceDirectory, intent.digest, intent.targetRelative],
    [1, result.operationId, ".codex/skills", f.digest, `skills/store/alpha/${f.digest}`]);
  assert.ok(fs.existsSync(join(backup, "linked.json")));
  assert.equal(fs.readlinkSync(f.source), f.target);
  assert.equal((await f.adopt()).status, "rejected", "a stale retry never replaces the new link");

  const listed = await f.list();
  assert.deepEqual(listed.operations.map((entry) => [entry.operationId, entry.state, entry.context]),
    [[result.operationId, "managed_linked", { kind: "wsl", distro }]]);
  const restored = await f.restore(result.operationId);
  assert.equal(restored.status, "restored", JSON.stringify(restored));
  assert.equal(restored.operation?.context?.distro, distro);
  assert.equal(fs.statSync(f.source).ino, before.ino);
  assert.equal(fs.readlinkSync(join(backup, "managed-link")), f.target);
  assert.equal((await f.restore(result.operationId)).status, "not_needed");
});

test("WSL reconciliation routes an adopted harness link through the canonical link", local, async (t) => {
  const f = fixture(t);
  assert.equal((await f.adopt()).status, "adopted");
  const reconciled = await reconcileWslSkills({ dataDir: f.dataDir, ownerHash, agents, desired: [f.entry],
    allowRemovals: true, run: localRun(f.home), storeRoot: async () => f.storeRoot });
  assert.equal(reconciled.error, undefined, JSON.stringify(reconciled));
  assert.equal(reconciled.deployed[0]?.links[0]?.status, "linked", JSON.stringify(reconciled));
  assert.equal(fs.readlinkSync(f.source), join(fs.realpathSync(f.home), ".agents/skills/alpha"));
  assert.equal(fs.readlinkSync(join(f.home, ".agents/skills/alpha")), f.target);
});

for (const problem of ["changed-source", "executable", "hard-link", "source-link", "missing-store", "changed-store",
  "group-writable", "account", "native", "unsupported-source", "unauthorized"]) {
  test(`WSL adoption rejects ${problem} before replacing the source`, local, async (t) => {
    const f = fixture(t);
    let overrides: Partial<Parameters<typeof adoptWslSkill>[0]> = {};
    if (problem === "changed-source") fs.writeFileSync(join(f.source, "notes/\uff21.md"), "edited");
    if (problem === "executable") fs.chmodSync(join(f.source, "binary"), 0o755);
    if (problem === "hard-link") fs.linkSync(join(f.source, "SKILL.md"), join(f.root, "hard-link"));
    if (problem === "source-link") { fs.renameSync(f.source, f.source + "-original"); fs.symlinkSync(f.source + "-original", f.source); }
    if (problem === "missing-store") fs.renameSync(f.target, f.target + "-removed");
    if (problem === "changed-store") fs.writeFileSync(join(f.target, "SKILL.md"), "corrupt stored bytes");
    if (problem === "group-writable") fs.chmodSync(f.parent, 0o775);
    if (problem === "account") overrides = { candidate: { ...f.candidate, providerAccountId: "work" } };
    if (problem === "native") overrides = { candidate: { ...f.candidate, context: undefined } };
    if (problem === "unsupported-source") overrides = { candidate: { ...f.candidate, sourceDirectory: ".claude/skills" } };
    if (problem === "unauthorized") overrides = { assertAuthorized: () => { throw new Error("private detail"); } };
    const result = await f.adopt(undefined, overrides);
    assert.equal(result.status, "rejected", JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /private/u);
    assert.ok(fs.existsSync(join(f.source, "SKILL.md")));
    assert.deepEqual(f.backups(), []);
  });
}

for (const stage of ["intent_durable", "source_preserved", "link_created"] as const) {
  test(`WSL helper death at ${stage} leaves inspectable recovery evidence and original content`, local, async (t) => {
    const f = fixture(t);
    const result = await f.adopt({ stage, command: "k" });
    assert.equal(result.status, "recovery_required", JSON.stringify(result));
    if (result.status !== "recovery_required") return;
    const backup = join(f.home, result.backupDirectory);
    const original = stage === "intent_durable" ? f.source : join(backup, "original");
    assert.match(fs.readFileSync(join(original, "SKILL.md"), "utf8"), /Original instructions/u);
    assert.equal(fs.existsSync(join(backup, "linked.json")), false);
    const listed = await f.list();
    assert.deepEqual(listed.operations.map((entry) => entry.state), [
      stage === "intent_durable" ? "intent_only" : stage === "source_preserved" ? "source_preserved" : "managed_linked",
    ]);
    const restored = await f.restore(result.operationId);
    assert.equal(restored.status, stage === "intent_durable" ? "not_needed" : "restored", JSON.stringify(restored));
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });
}

test("WSL adoption never overwrites a concurrent occupant or preserves into a relocated journal", local, async (t) => {
  const occupied = fixture(t);
  const result = await occupied.adopt({ stage: "source_preserved", command: "c", action: () => {
    fs.mkdirSync(occupied.source);
    fs.writeFileSync(join(occupied.source, "new-user-file"), "keep me");
  } });
  assert.equal(result.status, "recovery_required");
  if (result.status !== "recovery_required") return;
  assert.equal(fs.readFileSync(join(occupied.source, "new-user-file"), "utf8"), "keep me");
  assert.deepEqual((await occupied.list()).operations.map((entry) => entry.state), ["blocked"]);
  assert.equal((await occupied.restore(result.operationId)).status, "blocked");
  assert.equal(fs.readFileSync(join(occupied.source, "new-user-file"), "utf8"), "keep me");

  const relocated = fixture(t);
  const moved = await relocated.adopt({ stage: "intent_durable", command: "c", action: () => {
    const [journal] = relocated.backups();
    fs.renameSync(join(relocated.parent, journal!), join(relocated.parent, "relocated-journal"));
  } });
  assert.equal(moved.status, "recovery_required");
  assert.match(fs.readFileSync(join(relocated.source, "SKILL.md"), "utf8"), /Original instructions/u);
  assert.equal(fs.existsSync(join(relocated.parent, "relocated-journal", "original")), false);
});

for (const stage of ["restore_intent_durable", "managed_link_preserved", "recovery_link_created"] as const) {
  test(`WSL restore retries safely after interruption at ${stage}`, local, async (t) => {
    const f = fixture(t);
    const adopted = await f.adopt();
    assert.equal(adopted.status, "adopted");
    if (adopted.status !== "adopted") return;
    assert.equal((await f.restore(adopted.operationId, { stage, command: "f" })).status, "recovery_required");
    const retry = await f.restore(adopted.operationId);
    assert.ok(retry.status === "restored" || retry.status === "not_needed", JSON.stringify(retry));
    assert.match(fs.readFileSync(join(f.source, "SKILL.md"), "utf8"), /Original instructions/u);
  });
}

test("WSL recovery still recognizes and restores journals after the store root is lost", local, async (t) => {
  const linked = fixture(t);
  const adopted = await linked.adopt();
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  fs.renameSync(linked.storeRoot, `${linked.storeRoot}-lost`);
  assert.deepEqual((await linked.list()).operations.map((entry) => entry.state), ["managed_linked"],
    "the link text still names the managed store version");
  assert.equal((await linked.restore(adopted.operationId)).status, "restored");
  assert.match(fs.readFileSync(join(linked.source, "SKILL.md"), "utf8"), /Original instructions/u);

  const preserved = fixture(t);
  const interrupted = await preserved.adopt({ stage: "source_preserved", command: "k" });
  assert.equal(interrupted.status, "recovery_required");
  if (interrupted.status !== "recovery_required") return;
  fs.renameSync(preserved.storeRoot, `${preserved.storeRoot}-lost`);
  assert.equal((await preserved.restore(interrupted.operationId)).status, "restored");
  assert.match(fs.readFileSync(join(preserved.source, "SKILL.md"), "utf8"), /Original instructions/u);
});

test("WSL restore reports a busy distro home without touching the journal", local, async (t) => {
  const f = fixture(t);
  const adopted = await f.adopt();
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const leases = join(f.home, ".agent-manager/provider-home-leases-v1");
  fs.rmSync(join(leases, "mutable-home.lock"), { recursive: true, force: true });
  fs.writeFileSync(join(leases, "mutable-home.lock"), "not a lease directory");
  const blocked = await f.restore(adopted.operationId);
  assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
  assert.equal(fs.readlinkSync(f.source), f.target);
});

test("the runner command adopts a WSL candidate only after rereading it through the Windows reader", local,
  async (t) => {
    const f = fixture(t);
    let reads = 0;
    let content = files;
    const snapshots = new MachineSkillSnapshots({ home: "C:\\Users\\me", agents: () => agents, platform: "win32",
      windowsList: () => [], wslHome: () => "\\\\wsl.localhost\\Ubuntu\\home\\me",
      windowsRead: () => { reads++; return content; } });
    // Mint a live WSL candidate through the runner's own discovery bookkeeping.
    snapshots["candidates"].set(f.candidate.id, { candidate: f.candidate, expires: Date.now() + 60_000,
      home: "\\\\wsl.localhost\\Ubuntu\\home\\me" });
    const message = { type: "skill_adoption" as const, runnerId: "runner", requestId: "adopt", candidate: f.candidate,
      digest: f.digest, confirmation: "explicit" as const, acceptSharedImpact: false };
    const options = { message, runnerId: "runner", home: "C:\\Users\\me", dataDir: f.dataDir, agents, snapshots,
      desired: [f.entry], acquireProviderHomeLease: () => assert.fail("WSL leases in-distro") };
    assert.equal((await handleSkillAdoption(options)).status, "rejected", "an older control plane gets no WSL adoption");
    content = [...files, { path: "extra.md", encoding: "utf8", content: "changed after preview" }];
    const stale = await handleSkillAdoption({ ...options, wsl: f.environment() });
    assert.equal(stale.status, "rejected");
    assert.match(stale.error ?? "", /changed after preview/u);
    assert.deepEqual(f.backups(), []);
    content = files;
    const adopted = await handleSkillAdoption({ ...options, wsl: f.environment() });
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
    assert.equal(reads, 2);
    assert.equal(fs.readlinkSync(f.source), f.target);
  });

test("a WSL helper run that fails with no output is reported as needing recovery, never as untouched", local,
  async (t) => {
    const f = fixture(t);
    const inner = localRun(f.home);
    // The helper really adopts, then wsl.exe fails and its output is lost.
    const lossy: WslRun = async (context, command, args, options) => {
      const result = await inner(context, command, args, options);
      if (command === "python3" && args[0] !== "-c") throw Object.assign(new Error("wsl.exe failed"), { stdout: "" });
      return result;
    };
    const result = await f.adopt(undefined, { run: lossy });
    assert.equal(result.status, "recovery_required", JSON.stringify(result));
    if (result.status !== "recovery_required") return;
    assert.match(result.error ?? "", /outcome is unknown/u);
    assert.deepEqual(f.backups(), [`.wollipog-adoption-${result.operationId}`]);
    const listed = await f.list();
    assert.deepEqual(listed.operations.map((entry) => [entry.operationId, entry.state]),
      [[result.operationId, "managed_linked"]]);
  });

test("a WSL distro that cannot be inspected makes the list incomplete and blocks every restore", local,
  async (t) => {
    const f = fixture(t);
    const adopted = await f.adopt();
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
    if (adopted.status !== "adopted") return;
    const inner = localRun(f.home);
    // The distro answers everything except recovery inspection, as when it stops mid-session.
    const failing: WslRun = async (context, command, args, options) => {
      if (command === "python3" && args[0] !== "-c" && JSON.parse(options.stdin ?? "{}").operation === "inspect") {
        throw Object.assign(new Error("wsl.exe failed"), { stdout: "" });
      }
      return inner(context, command, args, options);
    };
    const environment = { ...f.environment(), run: failing };
    const listed = await listSkillAdoptionRecoveryWithWsl(join(f.root, "native"), f.dataDir, agents, [], environment);
    assert.deepEqual(listed, { operations: [], truncated: true });
    for (const operationId of [adopted.operationId, "123e4567-e89b-42d3-a456-426614174000"]) {
      const restored = await restoreSkillAdoptionRecoveryWithWsl({ home: join(f.root, "native"), dataDir: f.dataDir,
        agents, operationId, acquireProviderHomeLease: () => assert.fail("no restore may start"),
      }, environment);
      assert.equal(restored.status, "blocked", JSON.stringify(restored));
      assert.match(restored.error ?? "", /WSL distro Ubuntu could not be inspected/u);
    }
    assert.equal(fs.readlinkSync(f.source), f.target, "nothing was restored");
  });

test("an unreadable WSL harness directory, journal, or intent record fails inspection instead of looking empty",
  { skip: local.skip || process.getuid?.() === 0 }, async (t) => {
    const f = fixture(t);
    const adopted = await f.adopt();
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
    if (adopted.status !== "adopted") return;
    const journal = join(f.parent, `.wollipog-adoption-${adopted.operationId}`);
    for (const locked of [f.parent, journal, join(journal, "intent.json")]) {
      const mode = fs.statSync(locked).mode & 0o777;
      fs.chmodSync(locked, 0);
      try {
        assert.deepEqual(await f.list(), { operations: [], truncated: true }, locked);
        const restored = await f.restore(adopted.operationId);
        assert.equal(restored.status, "blocked", JSON.stringify(restored));
        assert.match(restored.error ?? "", /could not be inspected/u);
      } finally { fs.chmodSync(locked, mode); }
    }
    assert.deepEqual((await f.list()).operations.map((entry) => entry.state), ["managed_linked"]);
  });

test("inherited or WSLENV-forwarded environment variables cannot reach the helper's test checkpoint", local,
  async (t) => {
    const f = fixture(t);
    const control = join(f.root, "control");
    fs.writeFileSync(control, "k");
    const run = (stage: string) => localRun(f.home, undefined, {
      WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT: stage, WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL: control,
      WSLENV: "WOLLIPOG_SKILL_ADOPTION_TEST_CHECKPOINT:WOLLIPOG_SKILL_ADOPTION_TEST_CONTROL" });
    const adopted = await f.adopt(undefined, { run: run("source_preserved") });
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
    if (adopted.status !== "adopted") return;
    const restored = await restoreSkillAdoptionRecoveryWithWsl({ home: join(f.root, "native"), dataDir: f.dataDir,
      agents, operationId: adopted.operationId, acquireProviderHomeLease: () => assert.fail("WSL leases in-distro"),
    }, { ...f.environment(), run: run("restore_intent_durable") });
    assert.equal(restored.status, "restored", JSON.stringify(restored));
  });

test("a same-distro reader discovered while the helper is prepared still needs shared-impact consent", local,
  async (t) => {
    const f = fixture(t);
    const snapshots = new MachineSkillSnapshots({ home: "C:\\Users\\me", agents: () => agents, platform: "win32",
      windowsList: () => [], wslHome: () => "\\\\wsl.localhost\\Ubuntu\\home\\me", windowsRead: () => files });
    const adopt = async (acceptSharedImpact: boolean) => {
      snapshots["candidates"].set(f.candidate.id, { candidate: f.candidate, expires: Date.now() + 60_000,
        home: "\\\\wsl.localhost\\Ubuntu\\home\\me" });
      let live = agents;
      const environment = f.environment();
      return handleSkillAdoption({
        message: { type: "skill_adoption", runnerId: "runner", requestId: "adopt", candidate: f.candidate,
          digest: f.digest, confirmation: "explicit", acceptSharedImpact },
        runnerId: "runner", home: "C:\\Users\\me", dataDir: f.dataDir, agents, currentAgents: () => live, snapshots,
        desired: [f.entry], acquireProviderHomeLease: () => assert.fail("WSL leases in-distro"),
        // Discovery adds another Codex agent in the same distro while the helper is bootstrapped.
        wsl: { ...environment, storeRoot: async (name) => {
          live = [...agents, { id: "codex-wsl-2", name: "Codex WSL 2", command: "codex", args: [], env: {},
            driver: "codex", context: { kind: "wsl", distro } }];
          return environment.storeRoot!(name);
        } },
      });
    };
    const refused = await adopt(false);
    assert.equal(refused.status, "rejected", JSON.stringify(refused));
    assert.deepEqual(f.backups(), []);
    assert.ok(fs.lstatSync(f.source).isDirectory(), "the source stays in place");
    const adopted = await adopt(true);
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted));
    assert.equal(fs.readlinkSync(f.source), f.target);
  });
