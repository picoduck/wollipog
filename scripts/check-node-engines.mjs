import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const supported = new Map([
  ["22.13.0", true],
  ["23.2.0", false],
  ["23.4.0", true],
]);
const recommended = process.versions.node.startsWith("24.");
assert.ok(recommended || supported.has(process.versions.node), `Untested runtime ${process.version}; update the boundary cases explicitly`);
const expected = recommended || supported.get(process.versions.node);
const cliPaths = process.argv.slice(2).map((path) => resolve(path));
assert.equal(cliPaths.length, 2, "Pass the pnpm 10 and repository-pinned pnpm CLI paths");
const cliVersions = cliPaths.map((path) => JSON.parse(readFileSync(join(dirname(path), "../package.json"), "utf8")).version);
assert.equal(cliVersions[0], "10.11.0", "Legacy .npmrc compatibility probe must use pinned pnpm 10");
assert.equal(`pnpm@${cliVersions[1]}`, manifest.packageManager, "Probe the repository-pinned pnpm release");

// These documented boundaries are intentionally explicit: changing support requires updating
// both the behavioral cases and the contributor promise, not silently widening a semver test.
for (const file of ["README.md", "CONTRIBUTING.md"]) {
  assert.match(readFileSync(join(root, file), "utf8"), /Node\.js 22\.13\+ within 22\.x, or 23\.4\+ \(24 recommended; 23\.0–23\.3 are unsupported\)/u, `${file}: update the documented boundary with the probe`);
}

const temporary = mkdtempSync(join(tmpdir(), "wollipog-engine-boundary-"));
try {
  for (const [index, cli] of cliPaths.entries()) {
    const workspace = join(temporary, `pnpm-${cliVersions[index]}`);
    mkdirSync(workspace);
    // No dependencies or lifecycle scripts: only the root engine policy is under test.
    // Copy the real configuration verbatim; do not pass engine-strict on the command line.
    writeFileSync(join(workspace, "package.json"), JSON.stringify({
      name: "wollipog-engine-boundary-probe", version: "1.0.0", private: true,
      engines: manifest.engines,
    }));
    copyFileSync(join(root, ".npmrc"), join(workspace, ".npmrc"));
    // Exercise .npmrc independently for legacy installs. pnpm 10 understands both
    // files, so copying the workspace setting as well would mask a broken .npmrc.
    if (index === 1) copyFileSync(join(root, "pnpm-workspace.yaml"), join(workspace, "pnpm-workspace.yaml"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(npm_config_|pnpm_|corepack_|node_options$)/i.test(key)));
    // Keep user/global configuration from masking a missing repository setting.
    env.NPM_CONFIG_USERCONFIG = join(temporary, "empty-user.npmrc");
    env.NPM_CONFIG_GLOBALCONFIG = join(temporary, "empty-global.npmrc");
    env.XDG_CONFIG_HOME = join(temporary, "config");
    env.CI = "true";
    // pnpm 11 imports node:sqlite before checking project engines. Node 23.2 needs this
    // flag to reach that check; it does not change process.version or bypass the policy.
    const nodeFlags = process.versions.node === "23.2.0" && index === 1 ? ["--experimental-sqlite"] : [];
    const result = spawnSync(process.execPath, [...nodeFlags, cli, "install", "--offline", "--ignore-scripts", "--lockfile=false"], {
      cwd: workspace, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.ifError(result.error);
    if (expected) {
      assert.equal(result.status, 0, `Node ${process.version}, pnpm ${cliVersions[index]} rejected a supported runtime:\n${output}`);
    } else {
      assert.notEqual(result.status, 0, `Node ${process.version}, pnpm ${cliVersions[index]} accepted an excluded runtime`);
      assert.match(output, /ERR_PNPM_UNSUPPORTED_ENGINE/u, `Expected engine-policy rejection, not bootstrap failure:\n${output}`);
      assert.ok(output.includes(manifest.engines.node), `Rejection must identify the repository engine range:\n${output}`);
    }
    console.log(`Node ${process.version}, pnpm ${cliVersions[index]}: ${expected ? "accepted" : "rejected by engine policy"}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
