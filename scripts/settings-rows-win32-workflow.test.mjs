import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const WORKFLOW = ".github/workflows/settings-rows-win32.yml";
const text = readFileSync(resolve(process.cwd(), WORKFLOW), "utf8");

/** The job's text from its heading to the next job's, comments and blank lines dropped. */
function job(id) {
  const jobsText = text.split(/^jobs:\r?\n/m)[1];
  const starts = [...jobsText.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):$/gm)];
  const index = starts.findIndex((match) => match[1] === id);
  assert.notEqual(index, -1, `${WORKFLOW}: missing job ${id}`);
  return jobsText
    .slice(starts[index].index, starts[index + 1]?.index)
    .split("\n")
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
    .join("\n");
}

/** A step's lines, from its `- name:` to the next step's. */
function step(jobText, name) {
  const steps = jobText.split(/^(?=      - )/m);
  const found = steps.find((candidate) => candidate.startsWith(`      - name: ${name}\n`));
  assert.ok(found, `${WORKFLOW}: missing step "${name}"`);
  return found;
}

test("the win32 baselines workflow is callable from CI and dispatchable for a chosen ref", () => {
  assert.match(text, /^on:\n  workflow_call:\n    inputs:\n      ref:\n/m);
  assert.match(text, /^  workflow_dispatch:\n    inputs:\n      ref:\n/m,
    "a manual run must accept the ref to regenerate for");
  assert.doesNotMatch(text, /^  (pull_request|push|merge_group):/m,
    "CI calls this workflow; triggering it separately would run it outside the required check");
  assert.match(text, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(text, /^concurrency:/m,
    "a called workflow's github.workflow is the caller's, so its own group would cancel CI");
  assert.equal([...text.matchAll(/^ {10}ref: \$\{\{ inputs\.ref \}\}$/gm)].length, 2,
    "both jobs must check out the ref a manual run chose");
});

test("the win32 comparison runs on Windows only when the scope job finds settings-rows changes", () => {
  const compare = job("compare");
  assert.match(compare,
    /^  compare:\n    needs: scope\n    if: needs\.scope\.outputs\.affected == 'true'\n    name: Compare win32 Settings-Rows Baselines\n    runs-on: windows-latest\n    timeout-minutes: \d+\n    steps:$/m);
  assert.deepEqual(compare.split("\n").filter((line) => /^    \S/.test(line)).map((line) => line.split(":")[0].trim()),
    ["needs", "if", "name", "runs-on", "timeout-minutes", "steps"],
    "compare: a job key such as continue-on-error would report stale baselines as a success");

  assert.equal(step(compare, "Compare Against the Committed win32 Baselines"),
    "      - name: Compare Against the Committed win32 Baselines\n" +
    "        id: compare\n" +
    "        run: pnpm exec playwright test settings-rows\n",
    "the comparison step must be exactly its name, id and command: an if or continue-on-error lets drift pass");
});

test("a failed comparison regenerates only the changed win32 images and still fails", () => {
  const compare = job("compare");
  const regenerate = step(compare, "Regenerate the Changed win32 Baselines");
  assert.match(regenerate, /^        if: failure\(\) && steps\.compare\.outcome == 'failure'$/m);
  assert.match(regenerate, /^        run: pnpm exec playwright test settings-rows --update-snapshots=changed$/m);

  const collect = step(compare, "Collect the Regenerated win32 Baselines");
  assert.match(collect, /git status --porcelain --untracked-files=all -- 'apps\/web\/e2e\/settings-rows\.spec\.ts-snapshots\/\*-win32\.png'/,
    "only win32 images may reach the artifact");

  const upload = step(compare, "Upload the Regenerated win32 Baselines");
  assert.match(upload, /^        uses: actions\/upload-artifact@[0-9a-f]{40} # v\S+$/m);
  assert.match(upload, /^          name: settings-rows-win32-baselines$/m);
  assert.match(upload, /^          path: \$\{\{ steps\.collect\.outputs\.staging \}\}$/m);

  const summary = step(compare, "Tell the Author How to Commit Them");
  assert.match(summary, /gh run download \$RUN_ID --repo \$REPOSITORY --name settings-rows-win32-baselines --dir \./);
  assert.match(summary, /GITHUB_STEP_SUMMARY/);

  for (const [name, body] of [["regenerate", regenerate], ["collect", collect], ["upload", upload], ["summary", summary]]) {
    assert.match(body, /^        if: failure\(\) && /m, `${name}: runs only after the comparison failed`);
  }
});

/** Runs the scope step's script in `cwd` and returns what it wrote to GITHUB_OUTPUT. */
function runScope(cwd, env) {
  const script = step(job("scope"), "Compare the Diff Against the Settings-Rows Paths")
    .split(/^        run: \|\n/m)[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
  const output = join(cwd, "..", "output");
  const summary = join(cwd, "..", "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  execFileSync("bash", ["-c", script], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      MERGE_GROUP_BASE: "",
      PUSH_BEFORE: "",
      ...env,
    },
    stdio: "pipe",
  });
  return readFileSync(output, "utf8").trim();
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function commit(cwd, file, message) {
  mkdirSync(join(cwd, dirname(file)), { recursive: true });
  writeFileSync(join(cwd, file), message);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * A repository whose `origin` is itself, holding a base commit and a change on a branch, checked
 * out the way each event's checkout leaves it.
 */
function repository(t, changedFile) {
  const root = mkdtempSync(join(tmpdir(), "settings-rows-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  mkdirSync(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "remote", "add", "origin", pathToFileURL(cwd).href);
  const base = commit(cwd, "README.md", "base");
  git(cwd, "checkout", "-q", "-b", "change");
  const head = commit(cwd, changedFile, "change");
  // The pull-request test merge commit: first parent the base, second parent the change.
  git(cwd, "checkout", "-q", "main");
  commit(cwd, "other.txt", "base moved on");
  git(cwd, "merge", "-q", "--no-ff", "-m", "test merge", "change");
  return { cwd, base, head };
}

const SPEC_PATHS = [
  ["apps/web/e2e/settings-rows.spec.ts", "true"],
  ["apps/web/e2e/settings-rows.spec.ts-snapshots/chevron-dark-linux.png", "true"],
  ["apps/web/e2e/settings-rows.spec.ts-snapshots/chevron-dark-win32.png", "true"],
  ["apps/web/e2e/settings-rows.spec.tsx", "false"],
  ["apps/web/e2e/colour-schemes.spec.ts", "false"],
  ["apps/web/src/components/SettingsRows.tsx", "false"],
];

for (const [changedFile, expected] of SPEC_PATHS) {
  test(`a pull request changing ${changedFile} scopes affected=${expected}`, (t) => {
    const { cwd } = repository(t, changedFile);
    assert.equal(runScope(cwd, { EVENT_NAME: "pull_request" }), `affected=${expected}`);
  });

  test(`a merge group changing ${changedFile} scopes affected=${expected}`, (t) => {
    const { cwd, base, head } = repository(t, changedFile);
    git(cwd, "checkout", "-q", head);
    assert.equal(runScope(cwd, { EVENT_NAME: "merge_group", MERGE_GROUP_BASE: base }), `affected=${expected}`);
  });
}

test("a pull request diff excludes what the base gained after the branch point", (t) => {
  // The base moved on with an unrelated file; the test merge's first parent is that moved base,
  // so only the pull request's own change counts. Here the base itself touched the spec.
  const { cwd } = repository(t, "unrelated.txt");
  git(cwd, "checkout", "-q", "main~1");
  git(cwd, "checkout", "-q", "-b", "moved");
  commit(cwd, "apps/web/e2e/settings-rows.spec.ts", "base touched the spec");
  git(cwd, "merge", "-q", "--no-ff", "-m", "test merge", "change");
  assert.equal(runScope(cwd, { EVENT_NAME: "pull_request" }), "affected=false");
});

test("anything the scope cannot resolve compares rather than skips", (t) => {
  const { cwd, head } = repository(t, "unrelated.txt");
  assert.equal(runScope(cwd, { EVENT_NAME: "workflow_dispatch" }), "affected=true");
  git(cwd, "checkout", "-q", head);
  assert.equal(runScope(cwd, { EVENT_NAME: "pull_request" }), "affected=true",
    "a checkout that is not a test merge commit has no base to diff against");
  assert.equal(runScope(cwd, { EVENT_NAME: "merge_group", MERGE_GROUP_BASE: "" }), "affected=true");
  assert.equal(runScope(cwd, { EVENT_NAME: "merge_group", MERGE_GROUP_BASE: "f".repeat(40) }), "affected=true");
  assert.equal(runScope(cwd, { EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40) }), "affected=true");
});
