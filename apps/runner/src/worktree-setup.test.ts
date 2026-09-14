import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import fc from "fast-check";
import {
  expandWorktreeSetupEnvironment,
  loadWorktreeSetupConfig,
  parseWorktreeSetupConfig,
  runWorktreeSetup,
  WorktreeSetupTrustStore,
  worktreeSetupHash,
  type WorktreeSetupConfig,
} from "./worktree-setup.js";

const exec = promisify(execFile);
const native = { kind: "native" as const };

const validConfig: WorktreeSetupConfig = {
  version: 1,
  copyFiles: [{ source: ".env.local", destination: ".env.local" }],
  environment: { APP_ROOT: "${WOLLIPOG_WORKTREE_PATH}" },
  setup: [{ name: "Prepare", command: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 10, optional: false }],
};

test("worktree setup parser normalizes defaults and hashes deterministically", () => {
  const parsed = parseWorktreeSetupConfig(JSON.stringify({
    setup: [{ command: ["pnpm", "install"], name: "Install" }],
    environment: { ZED: "z", ALPHA: "a" },
    version: 1,
  }));
  assert.deepEqual(parsed, {
    version: 1,
    copyFiles: [],
    environment: { ALPHA: "a", ZED: "z" },
    setup: [{ name: "Install", command: ["pnpm", "install"], timeoutSeconds: 600, optional: false }],
  });
  assert.equal(worktreeSetupHash(parsed), worktreeSetupHash(parseWorktreeSetupConfig(JSON.stringify(parsed))));
});

test("configuration is read from the immutable base commit, not mutable worktree files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await exec("git", ["config", "user.name", "Wollipog Test"], { cwd: root });
  await writeFile(join(root, ".wollipog.json"), '{"version":1,"environment":{"MODE":"base"}}', "utf8");
  await exec("git", ["add", ".wollipog.json"], { cwd: root });
  await exec("git", ["commit", "-qm", "base"], { cwd: root });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await writeFile(join(root, ".wollipog.json"), '{"version":1,"environment":{"MODE":"mutated"}}', "utf8");
  const loaded = await loadWorktreeSetupConfig(native, root, base);
  assert.equal(loaded?.config.environment.MODE, "base");
  const originalHash = loaded?.hash;
  await writeFile(join(root, ".wollipog.json"), '{\n  "version": 1,\n  "environment": { "MODE": "base" }\n}\n', "utf8");
  await exec("git", ["add", ".wollipog.json"], { cwd: root });
  await exec("git", ["commit", "-qm", "reformat config"], { cwd: root });
  const reformatted = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const reformattedConfig = await loadWorktreeSetupConfig(native, root, reformatted);
  assert.notEqual(reformattedConfig?.hash, originalHash, "any config byte change must require a new trust decision");
  await exec("git", ["rm", "-fq", ".wollipog.json"], { cwd: root });
  await exec("git", ["commit", "-qm", "remove config"], { cwd: root });
  const absentCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  assert.equal(await loadWorktreeSetupConfig(native, root, absentCommit), null);
});

test("worktree setup parser rejects shell strings, traversal, unsafe env, placeholders, and unknown keys", () => {
  assert.throws(() => parseWorktreeSetupConfig('{"version":1,"setup":[{"name":"Bad","command":"echo hi"}]}'), /command/u);
  assert.throws(() => parseWorktreeSetupConfig('{"version":1,"copyFiles":[{"source":"..\/secret","destination":"x"}]}'), /relative path/u);
  assert.throws(() => parseWorktreeSetupConfig('{"version":1,"environment":{"WOLLIPOG_FAKE":"x"}}'), /reserved/u);
  for (const name of [
    "OPENAI_API_KEY", "google_application_credentials", "MAM_PLAIN",
    "PATH", "https_proxy", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "ssl_cert_file",
    "ANTHROPIC_BEDROCK_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "OPENROUTER_ENDPOINT",
    "LD_AUDIT", "dyld_fallback_library_path", "PYTHONPATH", "BASH_ENV",
    "GIT_CONFIG_PARAMETERS", "git_config_global", "GIT_SSH_COMMAND", "SSH_ASKPASS",
    "NODE_PATH", "JAVA_TOOL_OPTIONS", "DOTNET_STARTUP_HOOKS", "RUSTC_WRAPPER",
  ]) {
    assert.throws(
      () => parseWorktreeSetupConfig(JSON.stringify({ version: 1, environment: { [name]: "redirect" } })),
      /reserved/u,
      name,
    );
  }
  assert.throws(() => parseWorktreeSetupConfig('{"version":1,"environment":{"ROOT":"${SECRET_TOKEN}"}}'), /unknown placeholder/u);
  assert.throws(() => parseWorktreeSetupConfig('{"version":1,"teardown":[]}'), /not supported/u);
});

test("placeholder expansion accepts only runner-owned names", () => {
  const variables = {
    WOLLIPOG_WORKTREE_PATH: "/worktree",
    WOLLIPOG_WORKTREE_BRANCH: "agent/test",
    WOLLIPOG_WORKTREE_BASE_REF: "main",
    WOLLIPOG_PRIMARY_CHECKOUT: "/repo",
  };
  assert.deepEqual(expandWorktreeSetupEnvironment({ ROOT: "${WOLLIPOG_WORKTREE_PATH}/app" }, variables), { ROOT: "/worktree/app" });
  assert.throws(() => expandWorktreeSetupEnvironment({ TOKEN: "${SECRET_TOKEN}" }, variables), /unknown placeholder/u);
});

test("property: valid config round-trips with a stable canonical hash", () => {
  const safeString = fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/u).filter((value) => value !== "." && value !== "..");
  const envName = fc.stringMatching(/^PROJECT_[A-Z0-9]{1,8}$/u);
  const configArb = fc.record({
    version: fc.constant(1 as const),
    copyFiles: fc.uniqueArray(fc.record({ source: safeString, destination: safeString }), {
      maxLength: 5,
      selector: (copy) => copy.destination.toLowerCase(),
    }),
    environment: fc.dictionary(envName, safeString, { maxKeys: 5 }),
    setup: fc.uniqueArray(fc.record({
      name: safeString,
      command: fc.tuple(safeString, fc.array(safeString, { maxLength: 4 })).map(([head, tail]) => [head, ...tail]),
      timeoutSeconds: fc.integer({ min: 1, max: 720 }),
      optional: fc.boolean(),
    }), { maxLength: 5, selector: (step) => step.name }),
  });
  fc.assert(fc.property(configArb, (value) => {
    const first = parseWorktreeSetupConfig(JSON.stringify(value));
    const second = parseWorktreeSetupConfig(JSON.stringify(first));
    assert.deepEqual(second, first);
    assert.equal(worktreeSetupHash(second), worktreeSetupHash(first));
  }));
});

test("property: arbitrary JSON values fail safely or produce a bounded v1 config", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    try {
      const config = parseWorktreeSetupConfig(JSON.stringify(value));
      assert.equal(config.version, 1);
      assert.ok(config.copyFiles.length <= 128);
      assert.ok(config.setup.length <= 64);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }));
});

test("setup copies only ignored files and runs steps sequentially in the worktree with env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  await mkdir(primary);
  await exec("git", ["init", "-q"], { cwd: primary });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: primary });
  await exec("git", ["config", "user.name", "Wollipog Test"], { cwd: primary });
  await writeFile(join(primary, ".gitignore"), ".env.local\norder.txt\n", "utf8");
  await writeFile(join(primary, "tracked.txt"), "tracked\n", "utf8");
  await exec("git", ["add", ".gitignore", "tracked.txt"], { cwd: primary });
  await exec("git", ["commit", "-qm", "base"], { cwd: primary });
  await writeFile(join(primary, ".env.local"), "SECRET=not-logged\n", "utf8");
  await exec("git", ["worktree", "add", "-qb", "agent/test", worktree], { cwd: primary });

  const script = "require('fs').appendFileSync('order.txt', process.argv[1] + ':' + process.cwd() + ':' + process.env.APP_ROOT + '\\n')";
  const config: WorktreeSetupConfig = {
    ...validConfig,
    setup: [
      { name: "First", command: [process.execPath, "-e", script, "first"], timeoutSeconds: 10, optional: false },
      { name: "Optional", command: [process.execPath, "-e", "process.exit(7)"], timeoutSeconds: 10, optional: true },
      { name: "Last", command: [process.execPath, "-e", script, "last"], timeoutSeconds: 10, optional: false },
    ],
  };
  const state = await runWorktreeSetup({ context: native, primaryCheckout: primary, worktreePath: worktree, branch: "agent/test", baseRef: "main", config });
  assert.equal(state.status, "completed");
  assert.deepEqual(state.steps.map((step) => step.status), ["completed", "failed", "completed"]);
  assert.deepEqual(state.steps.map((step) => step.exitCode), [0, 7, 0]);
  assert.equal(await readFile(join(worktree, ".env.local"), "utf8"), "SECRET=not-logged\n");
  const order = await readFile(join(worktree, "order.txt"), "utf8");
  assert.deepEqual(order.trim().split("\n"), [`first:${worktree}:${worktree}`, `last:${worktree}:${worktree}`]);
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktree });
  assert.equal(stdout, "");
  assert.equal(JSON.stringify(state).includes("SECRET=not-logged"), false);
});

test("execution isolation is prepared after copies and supplies the step environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  await Promise.all([mkdir(primary), mkdir(worktree)]);
  await exec("git", ["init", "-q"], { cwd: worktree });
  await writeFile(join(primary, "local.txt"), "copied before snapshot\n", "utf8");
  await writeFile(join(worktree, ".gitignore"), "local.txt\nresult.txt\n", "utf8");
  let prepared = false;
  const state = await runWorktreeSetup({
    context: native, primaryCheckout: primary, worktreePath: worktree, branch: "agent/test",
    config: {
      version: 1,
      copyFiles: [{ source: "local.txt", destination: "local.txt" }],
      environment: { PHASE: "host" },
      setup: [{
        name: "Observe Prepared State",
        command: [process.execPath, "-e", "require('fs').writeFileSync('result.txt', process.env.PHASE)"],
        timeoutSeconds: 10,
        optional: false,
      }],
    },
    prepareExecution: async () => {
      assert.equal(await readFile(join(worktree, "local.txt"), "utf8"), "copied before snapshot\n");
      prepared = true;
      return { environment: { PHASE: "prepared" } };
    },
  });
  assert.equal(prepared, true);
  assert.equal(state.status, "completed");
  assert.equal(await readFile(join(worktree, "result.txt"), "utf8"), "prepared");
});

test("required failure stops later steps and retry resumes at that step", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd: root });
  const marker = join(root, "marker");
  const failOnce = "const f=process.argv[1]; const fs=require('fs'); if(!fs.existsSync(f)){fs.writeFileSync(f,'1');process.exit(9)}";
  const config: WorktreeSetupConfig = {
    version: 1, copyFiles: [], environment: {}, setup: [
      { name: "Optional", command: [process.execPath, "-e", "process.exit(4)"], timeoutSeconds: 10, optional: true },
      { name: "Once", command: [process.execPath, "-e", failOnce, marker], timeoutSeconds: 10, optional: false },
      { name: "Later", command: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 10, optional: false },
    ],
  };
  const first = await runWorktreeSetup({ context: native, primaryCheckout: root, worktreePath: root, branch: "agent/test", config });
  assert.equal(first.status, "failed");
  assert.equal(first.steps.length, 2);
  const retried = await runWorktreeSetup({ context: native, primaryCheckout: root, worktreePath: root, branch: "agent/test", config, prior: first });
  assert.equal(retried.status, "completed");
  assert.deepEqual(retried.steps.map((step) => step.status), ["failed", "completed", "completed"]);
  assert.notEqual(retried.attemptId, first.attemptId);
});

test("retry resumes at a failed copy without overwriting completed copies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-copy-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  await Promise.all([mkdir(primary), mkdir(worktree)]);
  await exec("git", ["init", "-q"], { cwd: worktree });
  await writeFile(join(worktree, ".gitignore"), "first.local\nsecond.local\n", "utf8");
  await writeFile(join(primary, "first.local"), "first\n", "utf8");
  const config: WorktreeSetupConfig = {
    version: 1, environment: {}, setup: [], copyFiles: [
      { source: "first.local", destination: "first.local" },
      { source: "second.local", destination: "second.local" },
    ],
  };
  const first = await runWorktreeSetup({ context: native, primaryCheckout: primary, worktreePath: worktree, branch: "agent/test", config });
  assert.equal(first.status, "failed");
  assert.deepEqual(first.copies.map((copy) => copy.status), ["completed", "failed"]);
  await writeFile(join(worktree, "first.local"), "user changed\n", "utf8");
  await writeFile(join(primary, "second.local"), "second\n", "utf8");
  const retried = await runWorktreeSetup({ context: native, primaryCheckout: primary, worktreePath: worktree, branch: "agent/test", config, prior: first });
  assert.equal(retried.status, "completed");
  assert.equal(await readFile(join(worktree, "first.local"), "utf8"), "user changed\n");
  assert.equal(await readFile(join(worktree, "second.local"), "utf8"), "second\n");
});

test("required step timeout is recorded as failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd: root });
  const config: WorktreeSetupConfig = { version: 1, copyFiles: [], environment: {}, setup: [
    { name: "Slow", command: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"], timeoutSeconds: 1, optional: false },
  ] };
  const state = await runWorktreeSetup({ context: native, primaryCheckout: root, worktreePath: root, branch: "agent/test", config });
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /timed out|SIGKILL/iu);
});

test("step output is streamed before the command completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-stream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd: root });
  let sawOutput!: () => void;
  const output = new Promise<void>((resolveOutput) => { sawOutput = resolveOutput; });
  const run = runWorktreeSetup({
    context: native,
    primaryCheckout: root,
    worktreePath: root,
    branch: "agent/test",
    config: { version: 1, copyFiles: [], environment: {}, setup: [{
      name: "Stream",
      command: [process.execPath, "-e", "process.stdout.write('ready\\n');setTimeout(()=>{},250)"],
      timeoutSeconds: 10,
      optional: false,
    }] },
    onOutput: (_index, text) => { if (text.includes("ready")) sawOutput(); },
  });
  const first = await Promise.race([
    output.then(() => "output" as const),
    run.then((state) => ({ state })),
  ]);
  assert.equal(first, "output", typeof first === "string" ? undefined : JSON.stringify(first.state));
  let completed = false;
  void run.then(() => { completed = true; });
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  assert.equal(completed, false);
  assert.equal((await run).status, "completed");
});

test("aborting setup terminates the running step without recording a false failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-q"], { cwd: root });
  const controller = new AbortController();
  let observeStart!: () => void;
  const started = new Promise<void>((resolveStarted) => { observeStart = resolveStarted; });
  let lastStatus: string | undefined;
  const run = runWorktreeSetup({
    context: native, primaryCheckout: root, worktreePath: root, branch: "agent/test",
    signal: controller.signal,
    config: { version: 1, copyFiles: [], environment: {}, setup: [{
      name: "Long Step",
      command: [process.execPath, "-e", "console.log('started');setTimeout(()=>{},60_000)"],
      timeoutSeconds: 60,
      optional: false,
    }] },
    onOutput: (_index, output) => { if (output.includes("started")) observeStart(); },
    onState: (state) => { lastStatus = state.status; },
  });
  await started;
  controller.abort();
  await assert.rejects(run, (error: Error) => error.name === "AbortError" && /cancelled/u.test(error.message));
  assert.equal(lastStatus, "running", "cancellation is not persisted as a setup failure or decline");
});

test("copy refuses a destination symlink before writing outside the worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, "primary");
  const worktree = join(root, "worktree");
  const outside = join(root, "outside");
  await Promise.all([mkdir(primary), mkdir(worktree), mkdir(outside)]);
  await exec("git", ["init", "-q"], { cwd: worktree });
  await writeFile(join(primary, "local.txt"), "private\n", "utf8");
  await writeFile(join(worktree, ".gitignore"), "linked/\n", "utf8");
  await symlink(outside, join(worktree, "linked"), "dir");
  const state = await runWorktreeSetup({
    context: native, primaryCheckout: primary, worktreePath: worktree, branch: "agent/test",
    config: { version: 1, environment: {}, setup: [], copyFiles: [{ source: "local.txt", destination: "linked/copied.txt" }] },
  });
  assert.equal(state.status, "failed");
  await assert.rejects(readFile(join(outside, "copied.txt")), /ENOENT/u);
});

test("trust is durable per project and exact config hash without storing project paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wollipog-setup-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new WorktreeSetupTrustStore(root);
  await first.approve("/project/alpha", "hash-a");
  assert.equal(await first.isApproved("/project/alpha", "hash-a"), true);
  assert.equal(await first.isApproved("/project/alpha", "hash-b"), false);
  assert.equal(await first.isApproved("/project/beta", "hash-a"), false);
  const second = new WorktreeSetupTrustStore(root);
  assert.equal(await second.isApproved("/project/alpha", "hash-a"), true);
  const persisted = await readFile(join(root, "worktree-setup-trust.json"), "utf8");
  assert.equal(persisted.includes("/project/alpha"), false);
});
