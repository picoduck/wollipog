import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ReleaseStaging, stagingFilesystem } from "../apps/runner/src/release-staging.ts";

const triple = "x86_64-unknown-linux-gnu";
const runnerAsset = `wollipog-runner-${triple}`;
const controlPlaneAsset = `wollipog-control-plane-${triple}`;
const webAsset = "wollipog-web.tar.gz";
const releaseTag = "v1.2.3";
const havePosixShell = process.platform !== "win32" && spawnSync("sh", ["-c", ":"], { stdio: "ignore" }).status === 0
  && spawnSync("tar", ["--version"], { stdio: "ignore" }).status === 0;
const posixTest = havePosixShell ? test : test.skip;
const installer = process.env.HEADLESS_INSTALLER_TEST_PATH ?? fileURLToPath(new URL("./install-runner.sh", import.meta.url));

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
  mkdirSync(join(assetsDir, "web"), { recursive: true, mode: 0o755 });
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
    -fsSL | -fL) shift ;;
    https://*) url="$1"; shift ;;
    *) echo "unexpected fixture curl argument" >&2; exit 91 ;;
  esac
done
case "$url" in
  https://api.github.com/repos/picoduck/wollipog/releases/latest | https://api.github.com/repos/picoduck/wollipog/releases/tags/"$TEST_RELEASE_TAG")
    cat "$TEST_RELEASE_JSON"; exit 0 ;;
  https://api.github.com/repos/picoduck/wollipog/releases/tags/*) exit 22 ;;
  https://download.test/"$TEST_RELEASE_TAG"/wollipog-runner-x86_64-unknown-linux-gnu | https://download.test/"$TEST_RELEASE_TAG"/wollipog-control-plane-x86_64-unknown-linux-gnu | https://download.test/"$TEST_RELEASE_TAG"/wollipog-web.tar.gz | https://download.test/"$TEST_RELEASE_TAG"/SHA256SUMS)
    [ -n "$out" ] || exit 92
    cp "$TEST_ASSETS_DIR/$(basename "$url")" "$out" ;;
  *) echo "unexpected fixture curl URL" >&2; exit 93 ;;
esac
`);
  // Even a missing release must not fall through to ambient gh credentials or network.
  executable(join(fakeBin, "gh"), 'echo "unexpected fixture gh invocation" >&2\nexit 22\n');
  const run = (...args) => spawnSync("sh", ["-c", 'umask 022\nexec sh "$@"', "installer-test", installer, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      HOME: home,
      LC_ALL: "C",
      TEST_RELEASE_JSON: join(root, "release.json"),
      TEST_ASSETS_DIR: assetsDir,
      TEST_RELEASE_TAG: releaseTag,
    },
  });
  return { root, home, run };
}

const admissionAsset = {
  name: runnerAsset, size: 1, digest: `sha256:${sha256(Buffer.from("x"))}`, url: "https://fixture.invalid/runner",
};
const identity = (path) => {
  const { dev, ino, uid, gid, mode } = lstatSync(path);
  return { dev, ino, uid, gid, mode };
};
// Model supported host ancestry only outside the private fixture. Some managed sandboxes
// present / and /tmp as UID 65534. Every fixture-owned identity, mode and syscall stays real.
function admissionFilesystem(root) {
  const externalAncestors = new Set();
  for (let path = dirname(root);; path = dirname(path)) {
    externalAncestors.add(path);
    if (path === dirname(path)) break;
  }
  return {
    ...stagingFilesystem,
    lstat: (path) => {
      const stat = stagingFilesystem.lstat(path);
      return externalAncestors.has(path)
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0n })
        : stat;
    },
  };
}
const admit = (data, root, fs = admissionFilesystem(root)) =>
  ReleaseStaging.create(data, { mode: "user", serviceUid: null }, releaseTag, [admissionAsset], fs);

posixTest("fresh headless root is private under umask 022 and admits generic staging without executing assets", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  // Arbitrary existing ancestors must retain their modes while the new leaf becomes private.
  const share = join(h.home, ".local", "share");
  mkdirSync(share, { recursive: true, mode: 0o755 });
  chmodSync(h.home, 0o750);
  chmodSync(share, 0o750);
  const ancestors = [h.home, join(h.home, ".local"), share].map(identity);
  const result = h.run("--control-plane");
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const data = join(share, "wollipog");
  const stat = statSync(data);
  assert.equal(stat.mode & 0o7777, 0o700, "fresh headless root must satisfy exact 0700 admission");
  assert.equal(stat.uid, statSync(h.home).uid);
  assert.equal(stat.gid, statSync(share).gid);
  assert.deepEqual([h.home, join(h.home, ".local"), share].map(identity), ancestors);
  assert.equal(statSync(join(h.home, ".config", "wollipog")).mode & 0o7777, 0o700);
  // The scoped umask must not affect the existing public dashboard archive semantics.
  assert.equal(statSync(join(data, "web")).mode & 0o777, 0o755);
  if (process.platform === "linux") {
    const before = identity(data);
    const staging = admit(data, h.root);
    assert.equal(staging.finish(), null);
    assert.deepEqual(identity(data), before);
    assert.ok(!existsSync(join(data, "upgrades")));
    // The explicit ancestor view cannot make a wrong data-root or ancestor owner admissible.
    const fs = admissionFilesystem(h.root);
    const foreignUid = BigInt(process.geteuid()) + 1n;
    for (const path of [data, "/"]) {
      const wrongOwner = { ...fs, lstat: (name) => {
        const stat = fs.lstat(name);
        return name === path ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: foreignUid }) : stat;
      } };
      assert.throws(() => admit(data, h.root, wrongOwner), /expected owner|unsafe ancestor ownership/u);
      assert.ok(!existsSync(join(data, "upgrades")));
    }
    const local = join(h.home, ".local");
    chmodSync(local, 0o775); // Deliberately unsupported, fixture-owned ancestor only.
    const unsupported = identity(local);
    assert.throws(() => admit(data, h.root), /unsafe ancestor ownership or writable permissions/u);
    assert.deepEqual(identity(local), unsupported, "admission never repairs the unsupported ancestor");
    assert.ok(!existsSync(join(data, "upgrades")));
  }
});

posixTest("headless installer preserves pre-existing root identities and stored content while admission stays strict", (t) => {
  for (const mode of [0o700, 0o755, 0o2700]) {
    const h = harness();
    t.after(() => rmSync(h.root, { recursive: true, force: true }));
    const data = join(h.home, ".local", "share", "wollipog");
    const config = join(h.home, ".config", "wollipog");
    mkdirSync(join(data, "control-plane"), { recursive: true, mode: 0o755 });
    mkdirSync(join(data, "runner"), { recursive: true, mode: 0o755 });
    mkdirSync(config, { recursive: true, mode: 0o755 });
    const contents = [
      [join(data, "control-plane", "control-plane.db"), "stored database"],
      [join(data, "control-plane", "artifact"), "stored artifact"],
      [join(data, "runner", "state"), "stored runner state"],
      [join(config, "control-plane.env"), "existing config"],
      [join(config, "runner.config.json"), '{"runnerId":"existing","token":"inert-sentinel"}'],
      [join(config, "runner.token"), "inert credential sentinel"],
    ];
    for (const [path, content] of contents) {
      writeFileSync(path, content);
      chmodSync(path, 0o640);
    }
    chmodSync(data, mode);
    chmodSync(config, 0o750);
    const roots = [data, config, join(data, "control-plane"), join(data, "runner")];
    const rootIdentities = roots.map(identity);
    const fileIdentities = contents.map(([path]) => identity(path));
    const result = h.run("--control-plane");
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.deepEqual(roots.map(identity), rootIdentities, `existing root identities for ${mode.toString(8)}`);
    assert.deepEqual(contents.map(([path]) => identity(path)), fileIdentities);
    for (const [path, content] of contents) assert.equal(readFileSync(path, "utf8"), content);
    if (process.platform === "linux") {
      if (mode === 0o700) assert.equal(admit(data, h.root).finish(), null);
      else assert.throws(() => admit(data, h.root), /data directory must have its expected owner and private 0700 permissions/u);
      assert.ok(!existsSync(join(data, "upgrades")), "no suspect-root recovery or staging left behind");
      assert.deepEqual(roots.map(identity), rootIdentities);
    }
  }
});

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

posixTest("install-runner.sh --release installs an exact tag and rejects malformed or unknown tags", (t) => {
  const h = harness();
  t.after(() => rmSync(h.root, { recursive: true, force: true }));
  const exact = h.run("--release", releaseTag, "--control-plane");
  assert.equal(exact.status, 0, exact.stderr + exact.stdout);
  assert.equal(readFileSync(join(h.home, ".local", "bin", "wollipog-control-plane"), "utf8"), "control plane bytes\n");
  assert.match(exact.stdout, new RegExp(`from ${releaseTag.replace(/\./g, "\\.")}`));

  const malformed = h.run("--release", "latest");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /--release must look like v1\.2\.3/u);

  // An unknown tag fails the tags endpoint and the fake gh refuses fallback.
  const unknown = h.run("--release", "v9.9.9");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /GitHub release lookup failed for v9\.9\.9/u);
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
