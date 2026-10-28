import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

// apps/runner/native-media-core/Cargo.lock carries advisories that never ship because nothing
// builds the crate's optional `native-core` feature. Its README records that policy (#3766); this
// guard keeps the premise true: a feature build must come from a workflow that audits the lockfile.

const ROOT = resolve(import.meta.dirname, "..");
const AUDIT = /\bcargo audit --file apps\/runner\/native-media-core\/Cargo\.lock\b/;
const FEATURE_FLAG = /(?:--features|-F)[= ]?\S*\bnative-core\b/;
const SCRIPT = /\.(?:mjs|cjs|js|sh|ps1)$/;

function buildsNativeCore(text) {
  return text.split(/\r?\n/).some((line) => /\bcargo\b/.test(line)
    && (FEATURE_FLAG.test(line) || (/--all-features\b/.test(line) && text.includes("native-media-core"))));
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

test("the detector recognises native-core feature builds and ignores unrelated cargo commands", () => {
  assert.ok(buildsNativeCore("cargo check --manifest-path apps/runner/native-media-core/Cargo.toml --features native-core"));
  assert.ok(buildsNativeCore("cargo test -F wollipog-native-media-core/native-core"));
  assert.ok(buildsNativeCore("working-directory: apps/runner/native-media-core\nrun: cargo build --all-features"));
  assert.ok(!buildsNativeCore("cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml"));
  assert.ok(!buildsNativeCore("cargo test --manifest-path apps/runner/native-media-core/Cargo.toml"));
  assert.ok(!buildsNativeCore("echo --features native-core"), "a non-cargo line is not a build");
  assert.ok(AUDIT.test("run: cargo audit --file apps/runner/native-media-core/Cargo.lock"));
});

test("a workflow that builds native-core also audits its lockfile", () => {
  assert.ok(workflows.length > 0, "workflow discovery must find the repository's workflows");
  for (const path of workflows) {
    const text = readFileSync(join(ROOT, path), "utf8");
    if (!buildsNativeCore(text)) continue;
    assert.match(text, AUDIT,
      `${path} builds native-core, so it must run cargo audit --file apps/runner/native-media-core/Cargo.lock (#3766)`);
  }
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
