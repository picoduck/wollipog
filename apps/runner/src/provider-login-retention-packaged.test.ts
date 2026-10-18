import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("source and an actual Node SEA retain synthetic duplicate and removed-account HOMEs", {
  skip: process.platform !== "linux" && process.platform !== "darwin", timeout: 180_000,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-retention-sea-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const require = createRequire(import.meta.url);
  const entry = fileURLToPath(new URL("./fixtures/provider-login-retention.cjs", import.meta.url));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(result.status, 0, `${String(result.error ?? "")}\n${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const sourceHome = join(root, "source"); mkdirSync(sourceHome);
  assert.match(run(process.execPath, ["--import", "tsx", entry, sourceHome]), /synthetic retention verified/u);

  const bundle = join(root, "retention.cjs"), binary = join(root, "retention-sea");
  const blob = join(root, "retention.blob"), config = join(root, "sea.json");
  const builder = join(root, "build.cjs");
  writeFileSync(builder, "require(" + JSON.stringify(require.resolve("esbuild")) + ").buildSync("
    + JSON.stringify({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs",
      target: "node24", define: { "import.meta.url": "undefined" } }) + ");");
  run(process.execPath, [builder]);
  writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
  run(process.execPath, ["--experimental-sea-config", config]);
  copyFileSync(process.execPath, binary); chmodSync(binary, 0o700);
  if (process.platform === "darwin") {
    const unsigned = spawnSync("/usr/bin/codesign", ["--remove-signature", binary], { encoding: "utf8", timeout: 30_000 });
    assert.ok(unsigned.status === 0 || unsigned.stderr.includes("not signed at all"), unsigned.stderr);
  }
  const injector = join(root, "inject.cjs");
  writeFileSync(injector, "require(" + JSON.stringify(require.resolve("postject")) + ").inject("
    + JSON.stringify(binary) + ",'NODE_SEA_BLOB',require('node:fs').readFileSync(" + JSON.stringify(blob) + "),"
    + JSON.stringify({ sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}) })
    + ").catch(e=>{console.error(e);process.exitCode=1;});");
  run(process.execPath, [injector]);
  if (process.platform === "darwin") run("/usr/bin/codesign", ["--sign", "-", binary]);
  const packagedHome = join(root, "packaged"); mkdirSync(packagedHome);
  assert.match(run(binary, [packagedHome]), /synthetic retention verified/u);
});
