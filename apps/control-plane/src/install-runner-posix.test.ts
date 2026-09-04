import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { createHash } from "node:crypto";
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

const haveSh = process.platform !== "win32" && spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0;
const requireSh = process.platform !== "win32" && process.env.CI === "true";
const warning =
  "Warning: Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed.";

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

test("POSIX installer pins releases and verifies public and authenticated publisher digests", {
  skip: process.platform === "win32" || (!haveSh && !requireSh),
}, (t) => {
  assert.equal(haveSh, true, "POSIX sh is required for this installer harness in CI");
  const installer = fileURLToPath(new URL("../../../scripts/install-runner.sh", import.meta.url));
  const canonical = "wollipog-runner-x86_64-unknown-linux-gnu";
  const legacy = "agent-manager-runner-x86_64-unknown-linux-gnu";
  const scenarios = [
    { name: "public-canonical", source: "public", selection: "canonical", result: "success" },
    { name: "public-legacy", source: "public", selection: "legacy", result: "success" },
    { name: "gh-canonical", source: "gh", selection: "canonical", result: "success" },
    { name: "gh-legacy", source: "gh", selection: "legacy", result: "success" },
    { name: "public-mismatch", source: "public", selection: "canonical", result: "mismatch" },
    { name: "gh-mismatch", source: "gh", selection: "canonical", result: "mismatch" },
    { name: "public-missing-digest", source: "public", selection: "canonical", result: "missing" },
    { name: "gh-missing-digest", source: "gh", selection: "canonical", result: "missing" },
    { name: "gh-failed-download", source: "gh", selection: "canonical", result: "download-failure" },
  ] as const;

  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-posix-installer-${scenario.name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const ghLog = join(root, "gh.log");
    const curlLog = join(root, "curl.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    writeExecutable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf '%s\\n' installer-test\n");
    writeExecutable(join(fakeBin, "uname"), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' Linux ;;
  -m) printf '%s\\n' x86_64 ;;
  *) exit 2 ;;
esac
`);
    writeExecutable(join(fakeBin, "curl"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
case " $* " in
  *"/releases/latest"*)
    [ "$FAKE_SOURCE" = public ] || exit 22
    printf '%s' "$FAKE_RELEASE_JSON"
    exit 0
    ;;
esac
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -fL) shift ;;
    *) url=$1; shift ;;
  esac
done
[ "$url" = "$FAKE_EXPECTED_URL" ] || { echo "wrong public asset URL: $url" >&2; exit 81; }
[ -n "$output" ] || { echo "missing public output" >&2; exit 82; }
printf '%s' "$FAKE_PAYLOAD" > "$output"
exit 0
`);
    writeExecutable(join(fakeBin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = api ]; then
  [ "$2" = repos/picoduck/wollipog/releases/latest ] || exit 90
  [ "$FAKE_SOURCE" = gh ] || exit 91
  printf '%s\\n' "$FAKE_RELEASE_TAG"
  printf '%s\\n' "$FAKE_METADATA_ROWS"
  exit 0
fi
if [ "$1" = release ] && [ "$2" = download ]; then
  [ "$3" = "$FAKE_RELEASE_TAG" ] || { echo "download did not pin the selected release tag" >&2; exit 92; }
  shift 3
  output=
  pattern=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --repo) shift 2 ;;
      --pattern) pattern=$2; shift 2 ;;
      --output) output=$2; shift 2 ;;
      *) echo "unexpected download argument: $1" >&2; exit 93 ;;
    esac
  done
  [ "$pattern" = "$FAKE_EXPECTED_ASSET" ] || { echo "wrong selected asset: $pattern" >&2; exit 94; }
  [ -n "$output" ] || { echo "missing download output" >&2; exit 95; }
  printf '%s' "$FAKE_PAYLOAD" > "$output"
  [ "$FAKE_RESULT" != download-failure ] || exit 9
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 96
`);

    const expectedAsset = scenario.selection === "legacy" ? legacy : canonical;
    const payload = `${scenario.name}-runner`;
    const digestBytes = scenario.result === "mismatch" ? "different-runner" : payload;
    const digest = scenario.result === "missing"
      ? undefined
      : `sha256:${createHash("sha256").update(digestBytes).digest("hex")}`;
    const assetUrl = `https://github.com/picoduck/wollipog/releases/download/v-pinned-test/${expectedAsset}`;
    const assets = scenario.selection === "legacy"
      ? [{ name: legacy, digest, browser_download_url: assetUrl }]
      : [
          { name: canonical, digest, browser_download_url: assetUrl },
          { name: legacy, digest, browser_download_url: assetUrl.replace(canonical, legacy) },
        ];
    const metadataRows = assets
      .map((asset) => `${asset.name}\t${asset.digest ?? ""}\t${asset.browser_download_url}`)
      .join("\n");
    const result = spawnSync("sh", [
      installer,
      "--url", "ws://127.0.0.1:4317/runner",
      "--token", "test-token",
      "--workspace", root,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAKE_SOURCE: scenario.source,
        FAKE_RESULT: scenario.result,
        FAKE_GH_LOG: ghLog,
        FAKE_CURL_LOG: curlLog,
        FAKE_RELEASE_TAG: "v-pinned-test",
        FAKE_RELEASE_JSON: JSON.stringify({ tag_name: "v-pinned-test", assets }),
        FAKE_METADATA_ROWS: metadataRows,
        FAKE_EXPECTED_ASSET: expectedAsset,
        FAKE_EXPECTED_URL: assetUrl,
        FAKE_PAYLOAD: payload,
      },
    });

    const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split(/\r?\n/u) : [];
    if (scenario.source === "gh") {
      assert.equal(ghCalls.filter((call) => call.startsWith("api ")).length, 1, `${scenario.name}: one raw metadata call`);
      if (scenario.result !== "missing") {
        assert.ok(
          ghCalls.some((call) => call.startsWith("release download v-pinned-test ")),
          `${scenario.name}: download uses the exact metadata tag`,
        );
      }
    } else {
      assert.equal(ghCalls.length, 0, `${scenario.name}: public metadata does not invoke gh`);
    }

    const installed = join(home, ".local", "bin", "wollipog-runner");
    const legacyInstalled = join(home, ".local", "bin", "agent-manager-runner");
    const binDir = join(home, ".local", "bin");
    if (scenario.result !== "success") {
      assert.notEqual(result.status, 0, `${scenario.name}: unverified bytes fail closed`);
      assert.equal(existsSync(installed), false, `${scenario.name}: unverified bytes are never promoted`);
      assert.equal(existsSync(legacyInstalled), false, `${scenario.name}: no legacy alias is promoted`);
      assert.deepEqual(
        existsSync(binDir)
          ? readdirSync(binDir).filter((name) => name.includes(".download.") || name.includes(".alias."))
          : [],
        [],
        `${scenario.name}: partial bytes are removed`,
      );
      if (scenario.result === "missing") {
        assert.match(result.stderr, /has no valid GitHub SHA-256 digest/u);
      } else if (scenario.result === "mismatch") {
        assert.match(result.stderr, /failed SHA-256 verification/u);
      }
      continue;
    }

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(installed, "utf8"), payload);
    assert.equal(readFileSync(legacyInstalled, "utf8"), payload, `${scenario.name}: legacy alias is byte-identical`);
    const warningCount = result.stderr.split(warning).length - 1;
    assert.equal(warningCount, scenario.selection === "legacy" ? 1 : 0, `${scenario.name}: warning matches fallback`);
  }
});
