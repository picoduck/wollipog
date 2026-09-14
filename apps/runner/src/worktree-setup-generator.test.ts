import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { test } from "node:test";
import fc from "fast-check";
import {
  generateWorktreeSetupConfig,
  inspectCheckoutWorktreeSetupConfig,
  resolveWorktreeSetupRepositoryRoot,
  writeStarterWorktreeSetupConfig,
} from "./worktree-setup-generator.js";
import { parseWorktreeSetupConfig, WORKTREE_SETUP_CONFIG } from "./worktree-setup.js";

const native = { kind: "native" as const };

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "wollipog-setup-generator-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".env\nrunner.config.json\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  execFileSync("git", ["add", ".gitignore", "pnpm-lock.yaml"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("generator uses deterministic tool precedence and production parsing", () => {
  const generated = generateWorktreeSetupConfig({
    files: ["yarn.lock", "package-lock.json", "pnpm-lock.yaml", "uv.lock"],
    ignoredCopyCandidates: ["runner.config.json", ".env", ".env", "not-approved.secret"],
  });
  assert.deepEqual(generated.config.setup.map((step) => step.command), [
    ["pnpm", "install", "--frozen-lockfile"],
    ["uv", "sync", "--frozen"],
  ]);
  assert.deepEqual(generated.config.copyFiles, [
    { source: ".env", destination: ".env" },
    { source: "runner.config.json", destination: "runner.config.json" },
  ]);
  assert.deepEqual(parseWorktreeSetupConfig(generated.source), generated.config);
});

test("arbitrary observations always serialize deterministically to the accepted schema", () => {
  fc.assert(fc.property(
    fc.array(fc.string({ maxLength: 40 }), { maxLength: 40 }),
    fc.array(fc.string({ maxLength: 40 }), { maxLength: 40 }),
    (files, ignoredCopyCandidates) => {
      const first = generateWorktreeSetupConfig({ files, ignoredCopyCandidates });
      const second = generateWorktreeSetupConfig({
        files: [...files].reverse(),
        ignoredCopyCandidates: [...ignoredCopyCandidates].reverse(),
      });
      assert.equal(first.source, second.source);
      assert.deepEqual(parseWorktreeSetupConfig(first.source), first.config);
    },
  ), { numRuns: 250 });
});

test("starter writer creates one untracked config and never runs, stages, commits, or overwrites", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, ".env"), "SECRET=kept-private\n");
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const beforeIndex = execFileSync("git", ["diff", "--cached"], { cwd: root, encoding: "utf8" });
    const generated = await writeStarterWorktreeSetupConfig(native, root);
    assert.equal(generated.path, WORKTREE_SETUP_CONFIG);
    assert.deepEqual(generated.status.status, "valid");
    assert.deepEqual(parseWorktreeSetupConfig(readFileSync(join(root, WORKTREE_SETUP_CONFIG), "utf8")), generated.config);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }), beforeHead);
    assert.equal(execFileSync("git", ["diff", "--cached"], { cwd: root, encoding: "utf8" }), beforeIndex);
    assert.match(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }), /\?\? \.wollipog\.json/u);
    const original = readFileSync(join(root, WORKTREE_SETUP_CONFIG), "utf8");
    await assert.rejects(() => writeStarterWorktreeSetupConfig(native, root), /already exists; it was not changed/u);
    assert.equal(readFileSync(join(root, WORKTREE_SETUP_CONFIG), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkout inspection distinguishes absent, valid, invalid, and unsafe paths", async () => {
  const root = repository();
  try {
    assert.deepEqual(await inspectCheckoutWorktreeSetupConfig(native, root), { status: "absent" });
    const generated = generateWorktreeSetupConfig({ files: ["pnpm-lock.yaml"], ignoredCopyCandidates: [] });
    writeFileSync(join(root, WORKTREE_SETUP_CONFIG), generated.source);
    assert.equal((await inspectCheckoutWorktreeSetupConfig(native, root)).status, "valid");
    writeFileSync(join(root, WORKTREE_SETUP_CONFIG), JSON.stringify({ version: 1, unexpected: true }));
    assert.deepEqual(await inspectCheckoutWorktreeSetupConfig(native, root), {
      status: "invalid",
      error: ".wollipog.json.unexpected is not supported",
    });
    rmSync(join(root, WORKTREE_SETUP_CONFIG));
    symlinkSync("pnpm-lock.yaml", join(root, WORKTREE_SETUP_CONFIG));
    const unsafe = await inspectCheckoutWorktreeSetupConfig(native, root);
    assert.equal(unsafe.status, "invalid");
    assert.match(unsafe.status === "invalid" ? unsafe.error : "", /regular file/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository root resolution rejects non-repositories", async () => {
  const root = repository();
  const outside = mkdtempSync(join(tmpdir(), "wollipog-not-repository-"));
  try {
    mkdirSync(join(root, "nested"));
    assert.equal(await resolveWorktreeSetupRepositoryRoot(native, join(root, "nested")), root);
    await assert.rejects(() => resolveWorktreeSetupRepositoryRoot(native, outside), /not a Git repository/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("checked-in reference and every documentation example use the production schema", () => {
  parseWorktreeSetupConfig(readFileSync(WORKTREE_SETUP_CONFIG, "utf8"));
  const docs = readFileSync("docs/worktree-setup.md", "utf8");
  const examples = [...docs.matchAll(/```json wollipog\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
  assert.ok(examples.length >= 2);
  for (const example of examples) parseWorktreeSetupConfig(example);
});
