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
import { assertRunnerTargetHost, publishLeaseHelperCompanion, publishLegacyRunnerAlias, runnerArtifactNames } from "./runner-artifacts.mjs";
import { removeWindowsSignature, signWindowsBinary } from "./windows-authenticode.mjs";
import { prepareLeaseHelperAssets } from "./prepare-lease-helper-assets.mjs";
import { helperAssociationBytes, helperAssociationName, helperDigest, helperReleaseAssetName } from "../../../scripts/lease-helper-distribution.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, ".."); // apps/runner
const buildDir = join(runner, ".bin-build");
const outDir = join(runner, "dist-bin");
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const triple = process.env.TARGET_TRIPLE || hostTriple();
assertRunnerTargetHost(triple, process.platform, process.arch);
// Explicit resource/fixture parents use the same locator as their source/SEA consumers.
// There is no alternate-root fallback on a failed ownership proof.
const preparedHelper = await prepareLeaseHelperAssets({ outDir: process.env.WOLLIPOG_LEASE_HELPER_ROOT || outDir, buildDir });
if (preparedHelper.tuple.target !== triple) throw new Error("offline helper target differs from the native runner");
const nativeDefine = { "import.meta.url": "undefined", __WOLLIPOG_LEASE_HELPER_TUPLE__: JSON.stringify(preparedHelper.tuple) };
if (process.platform === "win32") {
  const bytes = preparedHelper.image.verify();
  if (bytes.length < 1 || bytes.length > 65536) throw new Error("managed build input byte limit");
  nativeDefine.__WOLLIPOG_LEASE_MANAGED_IMAGE_BASE64__ = JSON.stringify(bytes.toString("base64"));
  // CI's source test product receives the same offline compiler inputs as source/SEA.
  // Production startup never reads this mutable build-workspace record.
  writeFileSync(join(buildDir, "lease-helper-test-inputs.json"), JSON.stringify({
    tuple: preparedHelper.tuple, managedImage: bytes.toString("base64"),
  }));
}

// Build the actual private worker first. Its fixed built-code input is shared by source and SEA;
// no runner startup may extract or compile it. Refuse before publishing an oversized worker.
const leaseWorker = join(buildDir, "provider-home-lease-worker.cjs");
const workerBuild = await build({
  entryPoints: [join(runner, "src", "provider-home-lease-worker.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node24", write: false,
  define: nativeDefine,
  outfile: leaseWorker, legalComments: "none", logLevel: "info",
});
if (workerBuild.outputFiles.length !== 1) throw new Error("fixed source worker output inventory");
const workerBytes = workerBuild.outputFiles[0].contents;
if (!workerBytes.length || workerBytes.length > 1024 * 1024) throw new Error("built lease worker before-write byte limit");
const workerCode = Buffer.from(workerBytes).toString("utf8");
if (!Buffer.from(workerCode).equals(Buffer.from(workerBytes))) throw new Error("invalid built lease worker encoding");
writeFileSync(leaseWorker, workerBytes);

// Explicit offline source product: Node executes the actual daemon and its exact eval worker.
// Raw Windows tsx has no independent expected DLL input and refuses lease operations.
await build({
  entryPoints: [join(runner, "src", "cli.ts")], bundle: true, platform: "node",
  format: "cjs", target: "node24", outfile: join(buildDir, "runner-source.cjs"),
  define: { ...nativeDefine, "import.meta.url": "__wollipog_source_module_url__", __WOLLIPOG_LEASE_SOURCE_WORKER__: JSON.stringify(workerCode) },
  banner: { js: 'const __wollipog_source_module_url__ = require("node:url").pathToFileURL(__filename).href;' },
  legalComments: "none", logLevel: "info",
});

// 1) Bundle the runner into a single CJS file. node: builtins stay external — provided by
// the Node runtime the SEA is built on.
const bundle = join(buildDir, "runner.cjs");
await build({
  // cli.ts dispatches the internal sidecar modes (see runner-entry.ts), else the daemon.
  entryPoints: [join(runner, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  // The bundle is CJS, where __filename is always available. This removes esbuild's otherwise
  // noisy import.meta fallback warning while preserving the source ESM path under tsx.
  define: { ...nativeDefine, __WOLLIPOG_LEASE_SOURCE_WORKER__: "undefined" },
  outfile: bundle,
  legalComments: "none",
  logLevel: "info",
});
console.log("bundled runner ->", bundle);

// SEA embeds the exact bounded worker already built above.

// Linux adoption moves files with a fixed renameat2(RENAME_NOREPLACE) helper. It is linked
// statically so the SEA runs on any Linux libc, and it is compiled before the bundle-only exit so
// CI's bundle check proves the exact release build.
const linuxRenameHelper = join(buildDir, "linux-skill-rename");
if (process.platform === "linux") {
  execFileSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static",
    join(runner, "native", "linux-skill-rename.c"), "-o", linuxRenameHelper], { stdio: "inherit" });
  console.log("compiled Linux skill rename helper ->", linuxRenameHelper);
}

// Protected Claude sessions use a fixed Linux pipe owner to report a provider's
// exit after its already-written output, independently of inherited pipe EOF.
const claudePipeHelper = join(buildDir, "claude-provider-pipe");
if (process.platform === "linux") {
  execFileSync("/usr/bin/cc", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-static",
    join(runner, "native", "claude-provider-pipe.c"), "-o", claudePipeHelper], { stdio: "inherit" });
  console.log("compiled Claude provider pipe helper ->", claudePipeHelper);
}

// Stop here when only validating the bundle (CI / quick check).
if (process.argv.includes("--bundle-only")) {
  console.log("bundle-only: skipping SEA packaging");
  process.exit(0);
}

// 2) Node SEA blob.
const seaConfig = join(buildDir, "sea-config.json");
const blob = join(buildDir, "runner.blob");
const assets = { "wollipog/provider-home-lease-worker-hrtime-ns-v1": leaseWorker };
// POSIX executes the immutable companion directly. Windows loads fixed admitted bytes in memory.
if (process.platform === "win32") assets["wollipog/provider-home-lease-io.dll"] = preparedHelper.image.path;
if (process.platform === "linux") assets["wollipog/claude-provider-pipe"] = claudePipeHelper;
if (process.platform === "darwin") {
  const helper = join(buildDir, "macos-skill-snapshots");
  execFileSync("/usr/bin/clang", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror",
    "-Wno-deprecated-declarations", join(runner, "native", "macos-skill-snapshots.c"), "-o", helper],
  { stdio: "inherit" });
  assets["wollipog/macos-skill-snapshots"] = helper;
}
if (process.platform === "linux") assets["wollipog/linux-skill-rename"] = linuxRenameHelper;
if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("node-pty/package.json");
  assets["node-pty/conpty.node"] = join(dirname(packageJson), "prebuilds", `win32-${process.arch}`, "conpty.node");
  assets["wollipog/wsl-bwrap-launcher.c"] = join(runner, "native", "wsl-bwrap-launcher.c");
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
const names = runnerArtifactNames(triple);
const out = join(outDir, names.canonical);
copyFileSync(process.execPath, out);

// 4) Inject the SEA blob. On macOS, SEA injection requires removing the copied binary's
// signature first and ad-hoc re-signing after, or Gatekeeper kills the modified binary. Release CI
// on Windows likewise strips node.exe's signature here and Authenticode-signs after injection.
if (process.platform === "darwin") tryExec("codesign", ["--remove-signature", out]);
if (process.platform === "win32") removeWindowsSignature(out);
await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });
// Sign before the alias copy so both release names carry the same signed bytes.
if (process.platform === "win32" && signWindowsBinary(out)) console.log("Authenticode signed ->", out);

console.log("runner binary built ->", out);
const legacyOut = join(outDir, names.legacy);
publishLegacyRunnerAlias(out, legacyOut);
console.log("legacy runner alias ->", legacyOut);
// These are offline release outputs, not runtime/installation cache growth.
preparedHelper.image.verify();
if (process.platform !== "win32") {
  const companion = join(outDir, helperReleaseAssetName(triple));
  publishLeaseHelperCompanion(companion, preparedHelper.image.verify(), preparedHelper.tuple);
}
writeFileSync(join(outDir, helperAssociationName(triple)), helperAssociationBytes({
  schema: "WPLR1", helper: preparedHelper.tuple, ...names,
  runnerSha256: helperDigest(readFileSync(out)), storage: process.platform === "win32" ? "embedded" : "external",
  installerMode: "--lease-helper-install",
}));

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
