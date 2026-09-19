/**
 * Pins the ambient-ignore isolation of the shared test-repository helper. Each case builds a
 * machine configuration that ignores the fixture name, proves a plain `git init` repository is
 * blinded by it, then proves one set up by `initRepo` is not. Dropping either neutraliser from
 * `isolateFromAmbientIgnores` fails exactly one case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo } from "./git-test-repo.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();
const FIXTURE = "untracked.txt";

/** The production view of untracked files, which is what the ambient rules can hide. */
function untracked(repo: string): string[] {
  return execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

/**
 * Run `body` with a global git config holding `config`, restoring the environment afterwards.
 * GIT_CONFIG_GLOBAL replaces the user's own global config for every child git process.
 */
function withGlobalConfig(root: string, config: string, body: () => void): void {
  const path = join(root, "gitconfig");
  writeFileSync(path, config);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}

function assertIsolated(root: string): void {
  const plain = join(root, "plain");
  mkdirSync(plain);
  execFileSync("git", ["init", "-q"], { cwd: plain });
  writeFileSync(join(plain, FIXTURE), "x\n");
  assert.deepEqual(untracked(plain), [], "the ambient rule must hide the fixture from an unisolated repository");

  const repo = join(root, "repo");
  mkdirSync(repo);
  initRepo(repo);
  writeFileSync(join(repo, FIXTURE), "x\n");
  assert.deepEqual(untracked(repo), [FIXTURE]);
}

test("initRepo ignores a global core.excludesFile that matches a fixture name", { skip: !GIT }, () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-test-repo-global-"));
  try {
    const excludes = join(root, "global-ignore");
    writeFileSync(excludes, `${FIXTURE}\n`);
    withGlobalConfig(root, `[core]\n\texcludesFile = ${excludes.replaceAll("\\", "/")}\n`, () => assertIsolated(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initRepo ignores an info/exclude seeded by init.templateDir", { skip: !GIT }, () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-test-repo-template-"));
  try {
    const template = join(root, "template");
    mkdirSync(join(template, "info"), { recursive: true });
    writeFileSync(join(template, "info", "exclude"), `${FIXTURE}\n`);
    withGlobalConfig(root, `[init]\n\ttemplateDir = ${template.replaceAll("\\", "/")}\n`, () => assertIsolated(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
