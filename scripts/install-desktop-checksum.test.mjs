import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("./install.sh", import.meta.url));
const windowsInstaller = fileURLToPath(new URL("./install.ps1", import.meta.url));
const assetName = "Wollipog_1.2.3_amd64.AppImage";
const bytes = Buffer.from("verified desktop bytes\n");
const digest = createHash("sha256").update(bytes).digest("hex");

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`, "utf8");
  chmodSync(path, 0o755);
}

function makeHarness({ publisherDigest = `sha256:${digest}`, privateRelease = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-desktop-installer-"));
  const home = join(root, "home");
  const fakeBin = join(root, "bin");
  const payload = join(root, "payload");
  const ghLog = join(root, "gh.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(payload, bytes);
  executable(join(fakeBin, "uname"), '[ "${1:-}" = "-s" ] && echo Linux || echo x86_64');
  executable(join(fakeBin, "curl"), `
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac
done
if echo "$url" | grep -q '/releases/latest$'; then
  [ "$TEST_PRIVATE" = 0 ] || exit 22
  printf '%s' '{"tag_name":"v1.2.3","assets":[{"name":"other_x64.AppImage","digest":"sha256:${"b".repeat(64)}","browser_download_url":"https://example.test/other_x64.AppImage"},{"name":"${assetName}","digest":'"$TEST_DIGEST_JSON"',"browser_download_url":"https://example.test/${assetName}"}]}'
else cp "$TEST_PAYLOAD" "$out"
fi`);
  executable(join(fakeBin, "gh"), `
printf '%s\\n' "$*" >> "$TEST_GH_LOG"
if [ "$1" = api ]; then
  printf '%s\\n' v1.2.3
  printf '%s\\t%s\\thttps://example.test/%s\\n' '${assetName}' "$TEST_DIGEST_FIELD" '${assetName}'
elif [ "$1" = release ] && [ "$2" = download ]; then
  while [ "$#" -gt 0 ]; do [ "$1" != --output ] || { cp "$TEST_PAYLOAD" "$2"; exit; }; shift; done
fi`);
  const live = join(home, ".local", "bin", "wollipog.AppImage");
  const run = () => spawnSync("sh", [installer], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: home,
      TEST_PRIVATE: privateRelease ? "1" : "0",
      TEST_DIGEST_JSON: JSON.stringify(publisherDigest),
      TEST_DIGEST_FIELD: publisherDigest ?? "",
      TEST_PAYLOAD: payload,
      TEST_GH_LOG: ghLog,
    },
  });
  return { root, home, live, ghLog, run };
}

test("POSIX desktop installer verifies the publisher digest before promotion", () => {
  const harness = makeHarness();
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(harness.live), bytes);
  } finally { rmSync(harness.root, { recursive: true, force: true }); }
});

test("POSIX desktop installer rejects a mismatch and preserves an existing install", () => {
  const harness = makeHarness({ publisherDigest: `sha256:${"0".repeat(64)}` });
  try {
    mkdirSync(join(harness.home, ".local", "bin"), { recursive: true });
    writeFileSync(harness.live, "known-good");
    const result = harness.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed SHA-256 verification/u);
    assert.equal(readFileSync(harness.live, "utf8"), "known-good");
  } finally { rmSync(harness.root, { recursive: true, force: true }); }
});

test("POSIX desktop installer rejects a missing or malformed publisher digest", () => {
  for (const publisherDigest of [null, "", "ABC", `SHA256:${digest}`, `sha256:${"A".repeat(64)}`]) {
    const harness = makeHarness({ publisherDigest });
    try {
      const result = harness.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no valid GitHub SHA-256 digest/u);
      assert.equal(existsSync(harness.live), false);
    } finally { rmSync(harness.root, { recursive: true, force: true }); }
  }
});

test("authenticated POSIX installs fetch raw digest metadata and verify the selected release asset", () => {
  const harness = makeHarness({ privateRelease: true });
  try {
    const result = harness.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(harness.live), bytes);
    const log = readFileSync(harness.ghLog, "utf8");
    assert.match(log, /api repos\/picoduck\/wollipog\/releases\/latest/u);
    assert.match(log, new RegExp(`release download v1\\.2\\.3 .*--pattern ${assetName}`));
  } finally { rmSync(harness.root, { recursive: true, force: true }); }
});

test("macOS installer verifies the publisher digest before mounting the DMG", () => {
  const source = readFileSync(installer, "utf8");
  const darwin = source.slice(source.indexOf("  Darwin)"), source.indexOf("  Linux)"));
  const digestCheck = darwin.indexOf("verify_sha256");
  const mount = darwin.indexOf("hdiutil attach");
  assert.ok(digestCheck >= 0 && mount > digestCheck);
});

test("Windows installer validates raw REST digest before invoking msiexec", () => {
  const source = readFileSync(windowsInstaller, "utf8");
  assert.match(source, /gh api "repos\/\$repo\/releases\/latest"/u);
  const digestCheck = source.indexOf("$digest -cnotmatch '^sha256:([0-9a-f]{64})$'");
  const fileHash = source.indexOf("Get-FileHash -LiteralPath $out -Algorithm SHA256");
  const install = source.indexOf("Start-Process msiexec.exe");
  assert.ok(digestCheck >= 0 && fileHash > digestCheck && install > fileHash);
  assert.match(source, /finally \{[\s\S]*Remove-Item -LiteralPath \$out/u);
});
