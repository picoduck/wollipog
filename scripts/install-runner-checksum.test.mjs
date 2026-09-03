import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const canonical = "wollipog-runner-x86_64-unknown-linux-gnu";
const legacy = "agent-manager-runner-x86_64-unknown-linux-gnu";
const releaseTag = "v1.2.3";
const haveNativeShell = spawnSync("sh", ["-c", ":"], { stdio: "ignore" }).status === 0;
const haveWslShell = process.platform === "win32" &&
  spawnSync("wsl.exe", ["--exec", "sh", "-c", ":"], { stdio: "ignore" }).status === 0;
const havePosixShell = haveNativeShell || haveWslShell;
const posixTest = havePosixShell ? test : test.skip;
const installer = shellPath(fileURLToPath(new URL("./install-runner.sh", import.meta.url)));

function shellPath(path) {
  const normalized = path.replace(/\\/gu, "/");
  if (process.platform !== "win32") return normalized;
  const prefix = haveNativeShell ? "" : "/mnt";
  return normalized.replace(/^([A-Za-z]):/u, (_, drive) => `${prefix}/${drive.toLowerCase()}`);
}

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, { encoding: "utf8" });
  chmodSync(path, 0o755);
}

function makeHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-posix-installer-"));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  const binary = join(root, "runner.bin");
  const manifest = join(root, "SHA256SUMS");
  const ghLog = join(root, "gh.log");
  const bytes = Buffer.from("verified runner bytes\n");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(binary, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asset = options.asset ?? canonical;
  writeFileSync(manifest, options.manifest ?? `${digest}  ${asset}\n`);
  const manifestDigest = createHash("sha256").update(readFileSync(manifest)).digest("hex");
  executable(join(fakeBin, "uname"), '[ "${1:-}" = "-s" ] && echo Linux || echo x86_64\n');
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
if [ "\${TEST_PRIVATE:-0}" = 1 ] && echo "$url" | grep -q '/releases/latest$'; then exit 22; fi
if echo "$url" | grep -q '/releases/latest$'; then
  manifest_asset=
  [ "\${TEST_MANIFEST:-1}" = 0 ] || manifest_asset=$(printf ',{"name":"SHA256SUMS","digest":"sha256:${manifestDigest}","browser_download_url":"https://download.test/%s/SHA256SUMS"}' "$TEST_RELEASE_TAG")
  printf '{"tag_name":"%s","assets":[{"name":"%s","digest":"sha256:%s","browser_download_url":"https://download.test/%s/%s"}%s]}' "$TEST_RELEASE_TAG" "$TEST_ASSET" "$TEST_DIGEST" "$TEST_RELEASE_TAG" "$TEST_ASSET" "$manifest_asset"
elif echo "$url" | grep -q '/SHA256SUMS$'; then
  cp "$TEST_MANIFEST_FILE" "$out"
else
  cp "$TEST_BINARY_FILE" "$out"
fi
`);
  executable(join(fakeBin, "gh"), `
printf '%s\\n' "$*" >>"$TEST_GH_LOG"
if [ "$1" = api ]; then
  [ "$2" = repos/picoduck/wollipog/releases/latest ]
  echo "$TEST_RELEASE_TAG"
  printf '%s\tsha256:%s\thttps://download.test/%s/%s\n' "$TEST_ASSET" "$TEST_DIGEST" "$TEST_RELEASE_TAG" "$TEST_ASSET"
  [ "\${TEST_MANIFEST:-1}" = 0 ] || printf 'SHA256SUMS\tsha256:${manifestDigest}\thttps://download.test/%s/SHA256SUMS\n' "$TEST_RELEASE_TAG"
elif [ "$1" = release ] && [ "$2" = download ]; then
  pattern=
  out=
  shift 2
  tag="$1"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --output) out="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ "$tag" = "$TEST_RELEASE_TAG" ]
  if [ "$pattern" = SHA256SUMS ]; then cp "$TEST_MANIFEST_FILE" "$out"; else cp "$TEST_BINARY_FILE" "$out"; fi
fi
`);

  const run = ({ home: runHome = home, releaseTag: runReleaseTag = options.releaseTag ?? releaseTag } = {}) => {
    const shellArgs = [
      "-c",
      'PATH="$1:$PATH"; HOME="$2"; TEST_ASSET="$3"; TEST_MANIFEST="$4"; TEST_PRIVATE="$5"; ' +
        'TEST_BINARY_FILE="$6"; TEST_MANIFEST_FILE="$7"; TEST_GH_LOG="$8"; TEST_DIGEST="$9"; ' +
        'TEST_RELEASE_TAG="${10}"; ' +
        'export PATH HOME TEST_ASSET TEST_MANIFEST TEST_PRIVATE TEST_BINARY_FILE TEST_MANIFEST_FILE TEST_GH_LOG TEST_DIGEST TEST_RELEASE_TAG; ' +
        'exec sh "${11}"',
      "installer-test",
      shellPath(fakeBin),
      shellPath(runHome),
      asset,
      options.includeManifest === false ? "0" : "1",
      options.private === true ? "1" : "0",
      shellPath(binary),
      shellPath(manifest),
      shellPath(ghLog),
      digest,
      runReleaseTag,
      installer,
    ];
    return spawnSync(
      haveNativeShell ? "sh" : "wsl.exe",
      haveNativeShell ? shellArgs : ["--exec", "sh", ...shellArgs],
      { encoding: "utf8" },
    );
  };
  return {
    root,
    home,
    ghLog,
    bytes,
    run,
    live: join(home, ".local", "bin", "wollipog-runner"),
    cliLive: join(home, ".local", "bin", "wollipog"),
    legacyLive: join(home, ".local", "bin", "agent-manager-runner"),
    warningForTag: (tag = options.releaseTag ?? releaseTag) => join(
      home,
      ".config",
      "wollipog",
      `.legacy-runner-asset-warning-v1-${createHash("sha256").update(tag).digest("hex")}`,
    ),
  };
}

function assertNoStagingFiles(harness) {
  const dir = join(harness.home, ".local", "bin");
  if (!existsSync(dir)) return;
  assert.deepEqual(readdirSync(dir).filter((name) =>
    name.includes(".download.") || name.includes(".alias.") || name.includes(".SHA256SUMS.")), []);
}

posixTest("POSIX runner installer verifies the exact canonical checksum before atomic promotion", () => {
  const harness = makeHarness();
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(harness.live), harness.bytes);
    assert.deepEqual(readFileSync(harness.cliLive), harness.bytes);
    assert.deepEqual(readFileSync(harness.legacyLive), harness.bytes);
    assert.equal(existsSync(harness.warningForTag()), false);
    assertNoStagingFiles(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

posixTest("publisher-digest-verified canonical assets remain installable before a manifest exists", () => {
  const harness = makeHarness({ includeManifest: false });
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(harness.live), harness.bytes);
    assertNoStagingFiles(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

posixTest("present manifests fail closed without one exact matching checksum and preserve the live runner", () => {
  for (const options of [
    { manifest: `${"0".repeat(64)}  prefixed-${canonical}\n` },
    { manifest: `${"0".repeat(64)}  ${canonical}\n` },
  ]) {
    const harness = makeHarness(options);
    try {
      mkdirSync(join(harness.home, ".local", "bin"), { recursive: true });
      writeFileSync(harness.live, "known-good");
      writeFileSync(harness.legacyLive, "known-good");
      const result = harness.run();
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(harness.live, "utf8"), "known-good");
      assert.equal(readFileSync(harness.legacyLive, "utf8"), "known-good");
      assertNoStagingFiles(harness);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  }
});

posixTest("a legacy asset is still fail-closed when its release supplies a mismatched manifest", () => {
  const harness = makeHarness({ asset: legacy, manifest: `${"0".repeat(64)}  ${legacy}\n` });
  try {
    mkdirSync(join(harness.home, ".local", "bin"), { recursive: true });
    writeFileSync(harness.live, "known-good");
    writeFileSync(harness.legacyLive, "known-good");
    const result = harness.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(harness.live, "utf8"), "known-good");
    assert.equal(readFileSync(harness.legacyLive, "utf8"), "known-good");
    assert.equal(existsSync(harness.warningForTag()), false);
    assertNoStagingFiles(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

posixTest("legacy-only pre-manifest releases warn once per release without exposing release values", () => {
  const harness = makeHarness({ asset: legacy, includeManifest: false });
  try {
    const first = harness.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /Wollipog used a legacy runner asset because the canonical asset was absent/);
    assert.doesNotMatch(first.stderr, /v1\.2\.3|agent-manager-runner|wollipog-runner/u,
      "the migration warning is value-free");
    assert.equal(existsSync(harness.warningForTag()), true);
    const second = harness.run();
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /Wollipog used a legacy runner asset because the canonical asset was absent/);

    const nextRelease = harness.run({ releaseTag: "v1.2.4" });
    assert.equal(nextRelease.status, 0, nextRelease.stderr);
    assert.match(nextRelease.stderr, /Wollipog used a legacy runner asset because the canonical asset was absent/);
    assert.doesNotMatch(nextRelease.stderr, /v1\.2\.4|agent-manager-runner|wollipog-runner/u,
      "the next release warning is also value-free");
    assert.equal(existsSync(harness.warningForTag("v1.2.4")), true);
    assertNoStagingFiles(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

posixTest("authenticated installs bind binary and checksum downloads to one exact release tag", () => {
  const harness = makeHarness({ private: true });
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(harness.ghLog, "utf8");
    assert.match(log, new RegExp(`release download v1\\.2\\.3 .*--pattern ${canonical}`));
    assert.match(log, /release download v1\.2\.3 .*--pattern SHA256SUMS/);
    assertNoStagingFiles(harness);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});
