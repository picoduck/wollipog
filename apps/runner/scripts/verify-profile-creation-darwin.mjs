/** Inert conformance fixture using the actual native helper/worker assets inside a built SEA. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), bundleOnly = process.argv.includes("--bundle-only");
if (!bundleOnly) assert.equal(process.platform, "darwin", "actual Darwin host required");
const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-darwin-sea-")));
const setter = join(root, "acl-fixture"), bundled = join(root, "fixture.cjs"), temp = join(root, "tmp"), home = join(root, "home");
for (const path of [temp, home]) mkdirSync(path, { mode: 0o700 });
try {
  await build({ entryPoints: [join(repo, "apps/runner/src/fixtures/profile-creation-darwin-packaged.ts")],
    outfile: bundled, bundle: true, platform: "node", format: "cjs", target: "node24",
    define: { "import.meta.url": "undefined", __WACW_ENGINE_SHA__: '""' }, logLevel: "silent" });
  if (!bundleOnly) {
    execFileSync("/usr/bin/clang", ["-Os", "-std=c11", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0",
      join(repo, "apps/runner/src/fixtures/profile-creation-darwin-acl.c"), "-o", setter]);
    const directory = join(repo, "apps/runner/dist-bin");
    const names = readdirSync(directory).filter(name => /^wollipog-runner-/u.test(name));
    assert.equal(names.length, 1, "one actual host SEA required");
    const expected = createHash("sha256").update(readFileSync(join(repo, "apps/runner/.bin-build/provider-home-lease-io"))).digest("hex");
    const preload = join(root, "preload.cjs");
    writeFileSync(preload, `if(require('node:worker_threads').isMainThread){
      const{getAsset,isSea}=require('node:sea');require('node:assert/strict').equal(isSea(),true);
      const digest=require('node:crypto').createHash('sha256').update(Buffer.from(getAsset('wollipog/provider-home-lease-io'))).digest('hex');
      require('node:assert/strict').equal(digest,${JSON.stringify(expected)});
      require(${JSON.stringify(bundled)}).verifyPackagedDarwinProfileCreation(${JSON.stringify(root)},${JSON.stringify(setter)})
        .then(()=>{console.log('DARWIN_PROFILE_PACKAGED_CONFORMANCE_OK '+digest);process.exit(0);})
        .catch(error=>{console.error(error);process.exit(1);});
    }`);
    const result = await promisify(execFile)(join(directory, names[0]), ["--wollipog-cli", "help"], {
      cwd: root, timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 65536,
      env: { ...process.env, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    });
    assert.ok(result.stdout.includes(`DARWIN_PROFILE_PACKAGED_CONFORMANCE_OK ${expected}`), result.stderr);
    console.log(`verified actual SEA native SHA256 ${expected}: Add Account -> marker/lease -> synthetic spawn refusal; import -> config -> subsequent admission; absent/empty/deny/inherited-deny ACLs`);
  }
} finally {
  if (!bundleOnly && existsSync(setter)) for (const name of ["empty", "deny", "deny_inherit"]) {
    const target = join(root, name);
    if (existsSync(target)) execFileSync(setter, [target, "empty"]); // Exact synthetic ACLs only.
  }
  rmSync(root, { recursive: true, force: true });
}
