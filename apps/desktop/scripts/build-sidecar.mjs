/**
 * Build the control plane into a standalone single-executable (Node SEA) so the Tauri
 * desktop app can run it as a sidecar — no separate Node/`pnpm dev` required.
 *
 * Steps: esbuild the CP (+ its deps) into one CJS file → make a Node SEA blob → copy the
 * node binary and inject the blob with postject → drop it in src-tauri/binaries named
 * with the Rust target triple (what Tauri's `externalBin` expects).
 *
 * Run: `node apps/desktop/scripts/build-sidecar.mjs`  (or `pnpm --filter @wollipog/desktop sidecar:build`)
 */
import { build } from "esbuild";
import { inject } from "postject";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCompatibleEnv } from "../../../scripts/env-compat.mjs";
import { assertRunnerTargetHost } from "../../runner/scripts/runner-artifacts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // repo root
const desktop = join(here, "..");
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const runnerReleaseTag =
  readCompatibleEnv(
    process.env,
    "WOLLIPOG_RUNNER_RELEASE_TAG",
    "MAM_RUNNER_RELEASE_TAG",
    (warning) => console.warn(`[sidecar] ${warning}`),
  ) || `v${appVersion}`;
const buildDir = join(desktop, ".sidecar-build");
const binDir = join(desktop, "src-tauri", "binaries");
mkdirSync(buildDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1) Bundle the control plane into a single CJS file. node: builtins (incl. node:sqlite)
// stay external — provided by the Node runtime the SEA is built on.
const bundle = join(buildDir, "control-plane.cjs");
await build({
  entryPoints: [join(root, "apps", "control-plane", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: { __WOLLIPOG_RUNNER_RELEASE_TAG__: JSON.stringify(runnerReleaseTag) },
  outfile: bundle,
  legalComments: "none",
  logLevel: "info",
});
console.log("runner release identity ->", runnerReleaseTag);
console.log("bundled control plane ->", bundle);

// Stop here when only validating the bundle (CI / quick check).
if (process.argv.includes("--bundle-only")) {
  console.log("bundle-only: skipping SEA packaging");
  process.exit(0);
}

// 2) Node SEA blob.
const seaConfig = join(buildDir, "sea-config.json");
const blob = join(buildDir, "control-plane.blob");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3) Determine the target triple. Tauri sets TAURI_ENV_TARGET_TRIPLE when this runs as a
// beforeBuildCommand (so `tauri build --target X` names the binary correctly); it must be one of
// the exact six RUNNER_TARGET_TRIPLES release values. Fall back to the host triple for a direct
// `sidecar:build`. The SEA embeds THIS host's Node runtime, so
// refuse a target whose architecture differs from the host instead of shipping a binary
// named for one arch that contains another (cross-target needs a per-target CI build).
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
assertRunnerTargetHost(triple, process.platform, process.arch);
const exe = process.platform === "win32" ? ".exe" : "";
const out = join(binDir, `control-plane-${triple}${exe}`);
copyFileSync(process.execPath, out);

// 4) Inject the SEA blob (postject's programmatic API — no shelling out to npx). On macOS,
// SEA injection requires removing the copied binary's signature first and ad-hoc re-signing
// after, or Gatekeeper kills the modified binary.
if (process.platform === "darwin") tryExec("codesign", ["--remove-signature", out]);
await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log("sidecar built ->", out);

// 5) Build the runner for the same native target and copy it into Tauri's sidecar directory.
// The desktop owns this copy so "Set Up This Machine" can start a config-free local runner
// without Node, pnpm, a repository clone, or a separate installer.
const runnerBuildScript = join(root, "apps", "runner", "scripts", "build-binary.mjs");
const runnerBuildDir = join(root, "apps", "runner", "dist-bin");
const canonicalRunner = join(runnerBuildDir, `wollipog-runner-${triple}${exe}`);
const legacyRunner = join(runnerBuildDir, `agent-manager-runner-${triple}${exe}`);
// Branch switches across the dual-publish window can leave either name behind. Remove both before
// the build so name preference can never select stale bytes from a prior producer generation.
rmSync(canonicalRunner, { force: true });
rmSync(legacyRunner, { force: true });
execFileSync(process.execPath, [runnerBuildScript], {
  stdio: "inherit",
  env: { ...process.env, TARGET_TRIPLE: triple },
});
const builtRunner = [canonicalRunner, legacyRunner].find(existsSync);
if (!builtRunner) throw new Error(`runner build produced no compatible binary for ${triple}`);
if (builtRunner === legacyRunner) {
  console.warn(
    "Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed.",
  );
}
const bundledRunner = join(binDir, `runner-${triple}${exe}`);
copyFileSync(builtRunner, bundledRunner);
console.log("local runner sidecar built ->", bundledRunner);

/** The Rust host target triple (e.g. aarch64-pc-windows-msvc). */
function hostTriple() {
  const t = /host:\s*(\S+)/.exec(execFileSync("rustc", ["-Vv"]).toString())?.[1];
  if (!t) throw new Error("could not determine the target triple (set TAURI_ENV_TARGET_TRIPLE or install rustc)");
  return t;
}

/** Run a command, ignoring failures (e.g. codesign absent in odd environments). */
function tryExec(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}
