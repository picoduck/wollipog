import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, chmodSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "@wollipog/test-support/bounded-child-process";
import { campaignCodeOperationTargets } from "@wollipog/protocol";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { campaignOperationEvidence, campaignOperationEvidenceCurrent } from "./campaign-operation-evidence.js";

test("canonical operation evidence rejects dangling links and catches a replaced target without reading contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-operation-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/auth.ts"), "fixture\n");
    const link = join(directory, "src/link.ts");
    symlinkSync(join(directory, "src/auth.ts"), link);
    const evidence = campaignOperationEvidence("Read", { kind: "file", path: link });
    assert.equal(evidence.filesystem?.targets[0]?.resolvedPath, join(directory, "src/auth.ts"));
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), true);
    unlinkSync(link); symlinkSync(join(directory, "absent.ts"), link);
    assert.equal(campaignOperationEvidence("Read", { kind: "file", path: link }).filesystem, undefined);
    assert.equal(campaignOperationEvidenceCurrent("Read", evidence), false);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: "cat src/auth.ts", cwd: join(directory, "missing") }).filesystem, undefined);
    assert.equal(campaignOperationEvidence("Write", { kind: "file", path: join(directory, "src/new.ts") }).filesystem?.targets[0]?.resolvedPath, join(directory, "src/new.ts"));
    assert.equal(campaignOperationEvidence("Unknown", { kind: "file", path: link, filesystem: { targets: [{ path: link, resolvedPath: link }] } }).filesystem, undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("read evidence requires existing regular files while native writes retain missing-target support", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-read-target-"));
  try {
    const missing = join(directory, "missing.ts"), folder = join(directory, "folder.ts");
    mkdirSync(folder);
    for (const path of [missing, folder]) {
      assert.equal(campaignOperationEvidence("Read", { kind: "file", path }).filesystem, undefined);
      assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${path}` }).filesystem, undefined);
    }
    assert.equal(campaignOperationEvidence("Write", { kind: "file", path: missing }).filesystem?.targets[0]?.resolvedPath, missing);
    writeFileSync(missing, "regular fixture\n");
    assert.equal(campaignOperationEvidence("Read", { kind: "file", path: missing }).filesystem?.targets[0]?.resolvedPath, missing);
    assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${missing}` }).filesystem?.targets[0]?.resolvedPath, missing);
    if (process.platform === "linux") {
      const fifo = join(directory, "pipe.ts"); execFileSync("mkfifo", [fifo], { timeout: 10_000 });
      assert.equal(campaignOperationEvidence("Read", { kind: "file", path: fifo }).filesystem, undefined);
      assert.equal(campaignOperationEvidence("Bash", { kind: "command", input: `cat ${fifo}` }).filesystem, undefined);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Git helper fixtures demonstrate why canonical inspection targets cannot authorize execution", {
  skip: process.platform !== "linux" ? "POSIX Git helper and util-linux PTY fixtures" : false,
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-git-effects-"));
  const { GIT_PAGER: _inheritedPager, ...fixtureEnvironment } = process.env;
  const env = { ...fixtureEnvironment, TERM: "xterm", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty-config"),
    WOLLIPOG_TEST_GIT_HELPER_MARKER: join(directory, "helper-ran") };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
  const helper = join(directory, "helper.sh");
  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    mkdirSync(join(directory, "empty-hooks"));
    git("init", "-q");
    git("config", "core.hooksPath", join(directory, "empty-hooks"));
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(directory, "sample.ts"), "original\n");
    git("add", "sample.ts"); git("commit", "-qm", "fixture");
    writeFileSync(join(directory, "sample.ts"), "modified\n");
    // Every executed helper is this local fixture, with no project hook or external effects.
    writeFileSync(helper, '#!/bin/sh\nmode="$1"; shift\nprintf %s "$mode" >> "$WOLLIPOG_TEST_GIT_HELPER_MARKER"\ncase "$mode" in\nfsmonitor) printf "fixture-token\\0" ;;\ntextconv) cat "$1" ;;\nclean) cat ;;\npager) cat > /dev/null ;;\nexternal) : ;;\nesac\n');
    chmodSync(helper, 0o700);
    const helperCommand = (mode: string) => `'${helper}' ${mode}`;
    const run = (command: string, args: string[], expectedHelper: string, pty = false) => {
      rmSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER, { force: true });
      const operation = { kind: "command" as const, input: command, cwd: directory };
      assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, command);
      assert.equal(campaignOperationEvidence("commandExecution", operation).filesystem, undefined, command);
      assert.equal(existsSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER), false, "evidence collection executes no helper");
      if (pty) execFileSync("script", ["-q", "-c", command, "/dev/null"], { cwd: directory, env, timeout: 10_000 });
      else git(...args);
      assert.ok(existsSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER), `${expectedHelper} executes despite an in-repository target`);
      assert.equal(readFileSync(env.WOLLIPOG_TEST_GIT_HELPER_MARKER, "utf8").replaceAll(expectedHelper, ""), "", "only the configured fixture helper ran");
    };

    git("config", "core.fsmonitor", helperCommand("fsmonitor"));
    run("git status --short", ["status", "--short"], "fsmonitor");
    git("config", "--unset", "core.fsmonitor");

    writeFileSync(join(directory, ".gitattributes"), "sample.ts diff=fixture\n");
    git("config", "diff.fixture.textconv", helperCommand("textconv"));
    run("git diff -- sample.ts", ["diff", "--", "sample.ts"], "textconv");
    git("config", "--unset", "diff.fixture.textconv");

    writeFileSync(join(directory, ".gitattributes"), "sample.ts filter=fixture\n");
    git("config", "filter.fixture.clean", helperCommand("clean"));
    run("git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- sample.ts",
      ["-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--", "sample.ts"], "clean");
    git("config", "--unset", "filter.fixture.clean");
    writeFileSync(join(directory, ".gitattributes"), "");

    // An included local config can hide execution behind an ordinary diff command too.
    const customConfig = join(directory, "custom-config");
    writeFileSync(customConfig, `[diff]\n\texternal = ${JSON.stringify(helperCommand("external"))}\n`);
    git("config", "include.path", customConfig);
    run("git diff -- sample.ts", ["diff", "--", "sample.ts"], "external");
    git("config", "--unset", "include.path");

    if (spawnSync("script", ["--version"], { env, timeout: 10_000 }).status === 0) {
      git("config", "core.pager", helperCommand("pager"));
      run("git --paginate diff -- sample.ts", [], "pager", true);
    } else t.diagnostic("PTY pager fixture unavailable; portable selector negatives still cover pager/custom config forms");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
