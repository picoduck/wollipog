/**
 * Build the runner into a standalone single-executable (Node SEA) so it installs and runs
 * with no Node/pnpm on the host. Mirrors apps/desktop/scripts/build-sidecar.mjs.
 *
 * esbuild apps/runner -> one CJS file -> Node SEA blob -> copy the node binary + inject the
 * blob with postject -> dist-bin/wollipog-runner-<target-triple>[.exe], then publish a
 * byte-identical dist-bin/agent-manager-runner-* compatibility alias.
 *
 * The SEA embeds THIS host's Node runtime, so it must be built on the target architecture
 * (per-target CI). TARGET_TRIPLE must be one of the exact six RUNNER_TARGET_TRIPLES values;
 * otherwise the host triple (via rustc) is used and must still be in that closed release set.
 *
 * Run: `node apps/runner/scripts/build-binary.mjs`  (or `pnpm --filter @wollipog/runner build:binary`)
 */
import { build } from "esbuild";
import { inject } from "postject";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertRunnerTargetHost, publishLegacyRunnerAlias, runnerArtifactNames } from "./runner-artifacts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, ".."); // apps/runner
const buildDir = join(runner, ".bin-build");
const outDir = join(runner, "dist-bin");
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// 1) Bundle the runner into a single CJS file. node: builtins stay external — provided by
// the Node runtime the SEA is built on.
const bundle = join(buildDir, "runner.cjs");
await build({
  // cli.ts dispatches: `--conductor-mcp` -> the conductor's MCP server, else the daemon.
  entryPoints: [join(runner, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // The bundle is CJS, where __filename is always available. This removes esbuild's otherwise
  // noisy import.meta fallback warning while preserving the source ESM path under tsx.
  define: { "import.meta.url": "undefined" },
  outfile: bundle,
  legalComments: "none",
  logLevel: "info",
});
console.log("bundled runner ->", bundle);

// Stop here when only validating the bundle (CI / quick check).
if (process.argv.includes("--bundle-only")) {
  console.log("bundle-only: skipping SEA packaging");
  process.exit(0);
}

// 2) Node SEA blob.
const seaConfig = join(buildDir, "sea-config.json");
const blob = join(buildDir, "runner.blob");
const assets = {};
if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("node-pty/package.json");
  assets["node-pty/conpty.node"] = join(dirname(packageJson), "prebuilds", `win32-${process.arch}`, "conpty.node");
}
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  ...(Object.keys(assets).length ? { assets } : {}),
}, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// 3) Determine the target triple. The SEA embeds THIS host's Node runtime, so refuse a
// target whose architecture differs from the host (cross-target needs a per-target CI build).
const triple = process.env.TARGET_TRIPLE || hostTriple();
assertRunnerTargetHost(triple, process.platform, process.arch);
const names = runnerArtifactNames(triple);
const out = join(outDir, names.canonical);
copyFileSync(process.execPath, out);

// 4) Inject the SEA blob. On macOS, SEA injection requires removing the copied binary's
// signature first and ad-hoc re-signing after, or Gatekeeper kills the modified binary.
if (process.platform === "darwin") tryExec("codesign", ["--remove-signature", out]);
await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

console.log("runner binary built ->", out);
const legacyOut = join(outDir, names.legacy);
publishLegacyRunnerAlias(out, legacyOut);
console.log("legacy runner alias ->", legacyOut);

/** The Rust host target triple (e.g. aarch64-pc-windows-msvc). */
function hostTriple() {
  const t = /host:\s*(\S+)/.exec(execFileSync("rustc", ["-Vv"]).toString())?.[1];
  if (!t) throw new Error("could not determine the target triple (set TARGET_TRIPLE or install rustc)");
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
