import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// apps/runner/native-media-core/Cargo.lock carries advisories that never ship because nothing
// builds the crate's optional `native-core` feature. Its README records that policy (#3766); this
// guard keeps the premise true: a feature build must come from a workflow job whose earlier,
// failure-stopping step audits the lockfile.

const ROOT = resolve(import.meta.dirname, "..");
const CRATE = "native-media-core";
const AUDIT = /\bcargo audit --file apps\/runner\/native-media-core\/Cargo\.lock\b/;
// The whole command: plain flags may follow, but no pipe, list, negation, redirection or
// substitution that could mask the audit's exit status.
const AUDIT_COMMAND = /^cargo audit --file apps\/runner\/native-media-core\/Cargo\.lock(?:\s+[\w.=/-]+)*$/;
// Whitespace includes newlines, so folded YAML and argument arrays (`"--features", "native-core"`)
// match as well as a single shell line; `-Fnative-core` needs no separator at all.
const FEATURE_FLAG = /(?:--features|(?<![\w-])-F)[\s"'`,=[\]]*(?:[^\s"'`]*[^\w\s"'`])?native-core\b/;
const TOLERATED = /^\s*(?:-\s+)?continue-on-error:\s*(?!false\b)\S/m;
const RUNS_AFTER_FAILURE = /^\s*(?:-\s+)?if:.*\b(?:always|failure|cancelled)\(\)/m;
const SCRIPT = /\.(?:mjs|cjs|js|sh|ps1)$/;

function buildsNativeCore(text, crateInScope = text.includes(CRATE)) {
  return /\bcargo\b/.test(text) && (FEATURE_FLAG.test(text) || (/--all-features\b/.test(text) && crateInScope));
}

function indent(line) {
  return line.length - line.trimStart().length;
}

function jobs(workflow) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  const result = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^  [\w-]+:\s*(?:#.*)?$/.test(line)) result.push({ name: line.trim().slice(0, -1), lines: [] });
    else result.at(-1)?.lines.push(line);
  }
  return result.map(({ name, lines: body }) => {
    const stepsAt = body.findIndex((line) => /^\s+steps:\s*(?:#.*)?$/.test(line));
    const steps = [];
    const outside = [...body];
    if (stepsAt >= 0) {
      const keyIndent = indent(body[stepsAt]);
      const itemIndent = indent(body.slice(stepsAt + 1).find((line) => line.trim().startsWith("- ")) ?? "");
      let end = stepsAt + 1;
      for (; end < body.length; end += 1) {
        const line = body[end];
        if (line.trim() === "" || line.trim().startsWith("#")) { steps.at(-1)?.push(line); continue; }
        if (indent(line) <= keyIndent) break;
        if (indent(line) === itemIndent && line.trim().startsWith("- ")) steps.push([line]);
        else steps.at(-1)?.push(line);
      }
      outside.splice(stepsAt, end - stepsAt);
    }
    return { name, header: outside.join("\n"), steps: steps.map((step) => step.join("\n")) };
  });
}

// The commands of a step's `run:` value. A literal block (`|`) keeps one command per line; a
// folded block (`>`) or a plain scalar is one command.
function runCommands(step) {
  const lines = step.split("\n");
  const at = lines.findIndex((line) => /^\s*(?:-\s+)?run:/.test(line));
  if (at < 0) return [];
  const value = lines[at].replace(/^\s*(?:-\s+)?run:\s*/, "").trim();
  if (!/^[|>]/.test(value)) return [value.replace(/^(["'])(.*)\1$/, "$2")];
  const keyIndent = indent(lines[at]);
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && indent(line) <= keyIndent) break;
    block.push(line.trim());
  }
  const commands = block.filter((line) => line !== "" && !line.startsWith("#"));
  return value.startsWith(">") ? [commands.join(" ")] : commands;
}

// A step's exit status is its last command's under every shell, so an audit stops the job only
// as the step's sole, unmasked command, without continue-on-error or a condition that skips it.
function stopsOnFailure(step) {
  const commands = runCommands(step);
  return commands.length === 1 && AUDIT_COMMAND.test(commands[0])
    && !TOLERATED.test(step) && !/^\s*(?:-\s+)?if:/m.test(step);
}

function auditProblems(path, workflow) {
  if (!buildsNativeCore(workflow)) return [];
  const crateInScope = workflow.includes(CRATE);
  const problems = [];
  let located = false;
  for (const job of jobs(workflow)) {
    job.steps.forEach((step, index) => {
      if (!buildsNativeCore(step, crateInScope)) return;
      located = true;
      const where = `${path} job ${job.name} step ${index + 1}`;
      if (!job.steps.slice(0, index).some(stopsOnFailure)) {
        problems.push(`${where} builds native-core without an earlier step in the same job whose only command is cargo audit --file apps/runner/native-media-core/Cargo.lock`);
      }
      if (TOLERATED.test(job.header)) problems.push(`${where} is in a continue-on-error job, so a failing audit cannot stop it`);
      if (RUNS_AFTER_FAILURE.test(step)) problems.push(`${where} runs after a failed step, so a failing audit cannot stop it`);
    });
  }
  if (!located) problems.push(`${path} enables native-core outside any job step; keep the feature build in a run step so the audit order can be checked`);
  return problems;
}

function files(directory, keep) {
  if (!existsSync(join(ROOT, directory))) return [];
  return readdirSync(join(ROOT, directory), { recursive: true })
    .map((entry) => join(directory, String(entry)))
    .filter((path) => !path.split(/[\\/]/).includes("node_modules") && keep(path));
}

const packageDirectories = ["apps", "packages"].flatMap((root) =>
  readdirSync(join(ROOT, root)).map((name) => join(root, name)));
const workflows = files(".github/workflows", (path) => /\.ya?ml$/.test(path));
const buildEntryPoints = [
  "package.json",
  ...packageDirectories.map((directory) => join(directory, "package.json"))
    .filter((path) => existsSync(join(ROOT, path))),
  ...["scripts", ...packageDirectories.map((directory) => join(directory, "scripts"))].flatMap((directory) =>
    files(directory, (path) => SCRIPT.test(path) && !path.endsWith(".test.mjs"))),
];

function workflow(...steps) {
  return ["on: workflow_dispatch", "jobs:", "  build:", "    runs-on: ubuntu-latest", "    steps:", ...steps].join("\n");
}
const AUDIT_STEP = "      - run: cargo audit --file apps/runner/native-media-core/Cargo.lock";
const BUILD_STEP = "      - run: cargo check --manifest-path apps/runner/native-media-core/Cargo.toml --features native-core";

test("the detector recognises native-core feature builds and ignores unrelated cargo commands", () => {
  assert.ok(buildsNativeCore("cargo check --manifest-path apps/runner/native-media-core/Cargo.toml --features native-core"));
  assert.ok(buildsNativeCore("cargo test -F wollipog-native-media-core/native-core"));
  assert.ok(buildsNativeCore("cargo check --manifest-path apps/runner/native-media-core/Cargo.toml -Fnative-core"),
    "an attached short flag must be detected");
  assert.ok(buildsNativeCore("cargo check --features=native-core"));
  assert.ok(buildsNativeCore("run: >-\n  cargo check --manifest-path apps/runner/native-media-core/Cargo.toml\n  --features native-core\n"),
    "a folded YAML command must be detected");
  assert.ok(buildsNativeCore('spawnSync("cargo", ["build", "--features", "native-core"])'), "an argument array must be detected");
  assert.ok(buildsNativeCore("working-directory: apps/runner/native-media-core\nrun: cargo build --all-features"));
  assert.ok(!buildsNativeCore("cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml"));
  assert.ok(!buildsNativeCore("cargo test --manifest-path apps/runner/native-media-core/Cargo.toml"));
  assert.ok(!buildsNativeCore("echo --features native-core"), "text without cargo is not a build");
});

test("the workflow rule accepts only an earlier audit that can stop the build", () => {
  assert.deepEqual(auditProblems("ok.yml", workflow(AUDIT_STEP, BUILD_STEP)), []);
  assert.deepEqual(auditProblems("named-block.yml", workflow(
    "      - name: Audit native-media-core", "        run: |", "          # Required before any native-core build (#3766).",
    "          cargo audit --file apps/runner/native-media-core/Cargo.lock --deny warnings", BUILD_STEP)), []);
  const rejected = {
    "no audit": workflow(BUILD_STEP),
    "audit after the build": workflow(BUILD_STEP, AUDIT_STEP),
    "audit sharing the build step": workflow("      - run: |", "          cargo audit --file apps/runner/native-media-core/Cargo.lock",
      "          cargo check --manifest-path apps/runner/native-media-core/Cargo.toml --features native-core"),
    "audit piped through tee": workflow(`${AUDIT_STEP} | tee audit.log`, BUILD_STEP),
    "negated audit": workflow("      - run: ! cargo audit --file apps/runner/native-media-core/Cargo.lock", BUILD_STEP),
    "audit followed by another command": workflow("      - run: |", "          cargo audit --file apps/runner/native-media-core/Cargo.lock",
      "          echo audited", BUILD_STEP),
    "compact flag without audit": workflow("      - run: cargo check --manifest-path apps/runner/native-media-core/Cargo.toml -Fnative-core"),
    "audit in another job": [workflow(AUDIT_STEP), "  native:", "    runs-on: ubuntu-latest", "    steps:", BUILD_STEP].join("\n"),
    "continue-on-error audit": workflow(AUDIT_STEP, "        continue-on-error: true", BUILD_STEP),
    "audit failure swallowed": workflow(`${AUDIT_STEP} || true`, BUILD_STEP),
    "conditional audit": workflow("      - if: github.event_name == 'push'", "        run: cargo audit --file apps/runner/native-media-core/Cargo.lock", BUILD_STEP),
    "build after failure": workflow(AUDIT_STEP, "      - if: always()", "        run: cargo check --manifest-path apps/runner/native-media-core/Cargo.toml --features native-core"),
    "continue-on-error job": workflow(AUDIT_STEP, BUILD_STEP).replace("    runs-on:", "    continue-on-error: true\n    runs-on:"),
    "folded build without audit": workflow("      - run: >-", "          cargo check --manifest-path apps/runner/native-media-core/Cargo.toml", "          --features native-core"),
    "feature flags outside a step": `env:\n  FLAGS: --features native-core\n${workflow(AUDIT_STEP, "      - run: cargo check $FLAGS")}`,
  };
  for (const [name, text] of Object.entries(rejected)) {
    assert.notDeepEqual(auditProblems(`${name}.yml`, text), [], `${name} must be rejected`);
  }
});

test("every workflow that builds native-core audits its lockfile first", () => {
  assert.ok(workflows.length > 0, "workflow discovery must find the repository's workflows");
  assert.deepEqual(workflows.flatMap((path) => auditProblems(path, readFileSync(join(ROOT, path), "utf8"))), []);
});

test("native-core is built only from a workflow, where the audit is enforced", () => {
  assert.ok(buildEntryPoints.includes(join("apps", "runner", "package.json")),
    "entry-point discovery must include package manifests");
  assert.ok(buildEntryPoints.some((path) => path.startsWith(join("apps", "runner", "scripts"))),
    "entry-point discovery must include app scripts");
  for (const path of buildEntryPoints) {
    assert.ok(!buildsNativeCore(readFileSync(join(ROOT, path), "utf8")),
      `${path} builds native-core outside a workflow; build it from a workflow step that audits the lockfile first (#3766)`);
  }
});
