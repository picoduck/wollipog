import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const triple = "x86_64-unknown-linux-gnu";
const runnerAsset = `wollipog-runner-${triple}`;
const controlPlaneAsset = `wollipog-control-plane-${triple}`;
const webAsset = "wollipog-web.tar.gz";
const releaseTag = "v1.2.3";
const havePosixShell = process.platform !== "win32" && spawnSync("sh", ["-c", ":"], { stdio: "ignore" }).status === 0
  && spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
const posixTest = havePosixShell ? test : test.skip;
const installer = fileURLToPath(new URL("./install-runner.sh", import.meta.url));

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { encoding: "utf8" });
  chmodSync(path, 0o755);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** A fake GitHub release with runner, control-plane, and web assets served by fake curl. */
function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-headless-installer-"));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const assetsDir = join(root, "assets");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(assetsDir, "web"), { recursive: true });
  writeFileSync(join(assetsDir, runnerAsset), "runner bytes\n");
  writeFileSync(join(assetsDir, controlPlaneAsset), "control plane bytes\n");
  writeFileSync(join(assetsDir, "web", "index.html"), "<html>dashboard</html>");
  assert.equal(spawnSync("tar", ["-C", assetsDir, "-czf", join(assetsDir, webAsset), "web"], { stdio: "ignore" }).status, 0);
  const names = options.omitControlPlane ? [runnerAsset, webAsset] : [runnerAsset, controlPlaneAsset, webAsset];
  const digests = Object.fromEntries(names.map((name) => [name, sha256(readFileSync(join(assetsDir, name)))]));
  if (options.tamperControlPlane) writeFileSync(join(assetsDir, controlPlaneAsset), "tampered\n");
  const manifest = `${names.map((name) => `${digests[name]}  ${name}`).sort().join("\n")}\n`;
  writeFileSync(join(assetsDir, "SHA256SUMS"), manifest);
  const assetsJson = JSON.stringify({
    tag_name: releaseTag,
    assets: [
      ...names.map((name) => ({ name, digest: `sha256:${digests[name]}`, browser_download_url: `https://download.test/${releaseTag}/${name}` })),
      ...(options.omitManifest ? [] : [{ name: "SHA256SUMS", digest: `sha256:${sha256(Buffer.from(manifest))}`, browser_download_url: `https://download.test/${releaseTag}/SHA256SUMS` }]),
    ],
  });
  writeFileSync(join(root, "release.json"), assetsJson);
  executable(join(fakeBin, "uname"), `[ "\${1:-}" = "-s" ] && echo ${options.os ?? "Linux"} || echo x86_64\n`);
  executable(join(fakeBin, "hostname"), "echo test-host\n");
  executable(join(fakeBin, "curl"), `
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
if echo "$url" | grep -q '/releases/latest$'; then cat "$TEST_RELEASE_JSON"; exit 0; fi
name=$(basename "$url")
cp "$TEST_ASSETS_DIR/$name" "$out"
`);
  const run = (...args) => spawnSync("sh", ["-c", 'PATH="$1:$PATH"; HOME="$2"; TEST_RELEASE_JSON="$3"; TEST_ASSETS_DIR="$4"; export PATH HOME TEST_RELEASE_JSON TEST_ASSETS_DIR; shift 4; exec sh "$@"',
    "installer-test", fakeBin, home, join(root, "release.json"), assetsDir, installer, ...args], { encoding: "utf8" });
  return { root, home, run };
}

posixTest("install-runner.sh --control-plane installs the verified control plane and dashboard bundle and leaves the runner config to service install", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const bin = join(h.home, ".local", "bin");
  assert.equal(readFileSync(join(bin, "wollipog-runner"), "utf8"), "runner bytes\n");
  assert.equal(readFileSync(join(bin, "wollipog-control-plane"), "utf8"), "control plane bytes\n");
  assert.ok(existsSync(join(bin, "wollipog")), "the CLI alias is published");
  assert.equal(readFileSync(join(h.home, ".local", "share", "wollipog", "web", "index.html"), "utf8"), "<html>dashboard</html>");
  assert.ok(!existsSync(join(h.home, ".config", "wollipog", "runner.config.json")), "no starter config: service install writes it");
  assert.match(result.stdout, /Control plane:\s+.*wollipog-control-plane/u);
  assert.match(result.stdout, /Next:\s+.*service install/u);
  assert.deepEqual(readdirSync(bin).filter((name) => name.includes(".download.")), [], "no staging files remain");
  assert.deepEqual(readdirSync(join(h.home, ".local", "share", "wollipog")).filter((name) => name.startsWith(".web.")), []);
});

posixTest("install-runner.sh --control-plane fails closed on a tampered control plane and on a release without headless assets", (t) => {
  const tampered = harness({ tamperControlPlane: true });
  t.after(() => rmSync(tampered.root, { recursive: true, force: true }));
  const bad = tampered.run("--control-plane");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /wollipog-control-plane-x86_64-unknown-linux-gnu failed SHA-256 verification/u);
  assert.ok(!existsSync(join(tampered.home, ".local", "bin", "wollipog-control-plane")));
  assert.ok(existsSync(join(tampered.home, ".local", "bin", "wollipog-runner")), "the already-verified runner stays installed");

  const old = harness({ omitControlPlane: true });
  t.after(() => rmSync(old.root, { recursive: true, force: true }));
  const missing = old.run("--control-plane");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /has no wollipog-control-plane-x86_64-unknown-linux-gnu; update to a release that publishes headless assets/u);
  assert.ok(!existsSync(join(old.home, ".local", "bin", "wollipog-runner")), "the runner is not installed either: no mixed generations");

  // Without SHA256SUMS the headless assets cannot be cross-checked, so nothing headless is installed.
  const unverifiable = harness({ omitManifest: true });
  t.after(() => rmSync(unverifiable.root, { recursive: true, force: true }));
  const noManifest = unverifiable.run("--control-plane");
  assert.notEqual(noManifest.status, 0);
  assert.match(noManifest.stderr, /has no SHA256SUMS; refusing a headless install/u);
  assert.ok(!existsSync(join(unverifiable.home, ".local", "bin", "wollipog-control-plane")));
  assert.ok(!existsSync(join(unverifiable.home, ".local", "bin", "wollipog-runner")), "refused before the runner was downloaded");

  // --control-plane is a Linux/systemd flow; on macOS it stops before downloading anything.
  const mac = harness({ os: "Darwin" });
  t.after(() => rmSync(mac.root, { recursive: true, force: true }));
  const darwin = mac.run("--control-plane");
  assert.notEqual(darwin.status, 0);
  assert.match(darwin.stderr, /--control-plane needs Linux with systemd/u);
  assert.ok(!existsSync(join(mac.home, ".local", "bin", "wollipog-runner")), "nothing is installed before the platform check");

  const plain = harness();
  t.after(() => rmSync(plain.root, { recursive: true, force: true }));
  const runnerOnly = plain.run();
  assert.equal(runnerOnly.status, 0, runnerOnly.stderr);
  assert.ok(!existsSync(join(plain.home, ".local", "bin", "wollipog-control-plane")), "without --control-plane nothing headless is installed");
  assert.ok(existsSync(join(plain.home, ".config", "wollipog", "runner.config.json")), "the starter config is still written for plain runner installs");
});
