import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const haveNativeShell = spawnSync("sh", ["-c", ":"], { stdio: "ignore" }).status === 0;
const haveWslShell = process.platform === "win32" &&
  spawnSync("wsl.exe", ["--exec", "sh", "-c", ":"], { stdio: "ignore" }).status === 0;
const havePosixShell = haveNativeShell || haveWslShell;
const posixTest = havePosixShell ? test : test.skip;
const nativePermissionTest = haveNativeShell && process.platform !== "win32" ? test : test.skip;

function shellPath(path) {
  const normalized = path.replace(/\\/gu, "/");
  if (process.platform !== "win32") return normalized;
  const prefix = haveNativeShell ? "" : "/mnt";
  return normalized.replace(/^([A-Za-z]):/u, (_, drive) => `${prefix}/${drive.toLowerCase()}`);
}

function spawnPosix(args, options = {}) {
  return spawnSync(haveNativeShell ? "sh" : "wsl.exe", haveNativeShell ? args : ["--exec", "sh", ...args], options);
}

const installer = shellPath(fileURLToPath(new URL("./install-runner.sh", import.meta.url)));
const runnerBytes = "#!/bin/sh\nprintf 'wollipog-test-runner\\n'\n";
const runnerDigest = createHash("sha256").update(runnerBytes).digest("hex");
const runnerBase64 = Buffer.from(runnerBytes).toString("base64");

function writeExecutable(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function installHarness(t, { failCopies = false, failLinks = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-installer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(home, { recursive: true });

  writeExecutable(join(fakeBin, "uname"), `#!/bin/sh
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) exit 2 ;;
esac
`);
  writeExecutable(join(fakeBin, "hostname"), "#!/bin/sh\nprintf 'installer-test-host\\n'\n");
  writeExecutable(join(fakeBin, "curl"), `#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  *api.github.com*)
    printf '%s' '{"tag_name":"v-test","assets":[{"name":"wollipog-runner-x86_64-unknown-linux-gnu","digest":"sha256:${runnerDigest}","browser_download_url":"https://downloads.test/wollipog-runner-x86_64-unknown-linux-gnu"},{"name":"SHA256SUMS","browser_download_url":"https://downloads.test/SHA256SUMS"}]}'
    ;;
  */wollipog-runner-x86_64-unknown-linux-gnu)
    printf '%s' '${runnerBase64}' | base64 -d > "$out"
    ;;
  */SHA256SUMS)
    printf '%s  %s\\n' '${runnerDigest}' 'wollipog-runner-x86_64-unknown-linux-gnu' > "$out"
    ;;
  *)
    printf 'unexpected URL: %s\\n' "$url" >&2
    exit 3
    ;;
esac
`);
  if (failLinks) {
    writeExecutable(join(fakeBin, "ln"), "#!/bin/sh\nexit 1\n");
  }
  if (failCopies) {
    writeExecutable(join(fakeBin, "cp"), "#!/bin/sh\nexit 1\n");
  }

  function run(token) {
    const result = spawnPosix([
      "-c",
      'PATH="$1:$PATH"; HOME="$2"; export PATH HOME; exec sh "$3" --token "$4"',
      "installer-identity-test",
      shellPath(fakeBin),
      shellPath(home),
      installer,
      token,
    ], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `installer failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return result;
  }

  return { home, run };
}

posixTest("POSIX standalone installer creates canonical paths and a functional legacy alias", (t) => {
  const { home, run } = installHarness(t);
  const result = run("fresh-token");
  const canonicalBin = join(home, ".local", "bin", "wollipog-runner");
  const legacyBin = join(home, ".local", "bin", "agent-manager-runner");
  const canonicalConfig = join(home, ".config", "wollipog", "runner.config.json");

  assert.equal(readFileSync(canonicalBin, "utf8"), runnerBytes);
  assert.equal(readFileSync(legacyBin, "utf8"), runnerBytes);
  if (process.platform !== "win32") {
    assert.equal(statSync(canonicalBin).mode & 0o111, 0o111);
    assert.equal(statSync(dirname(canonicalConfig)).mode & 0o777, 0o700);
    assert.equal(statSync(canonicalConfig).mode & 0o777, 0o600);
  }
  assert.match(readFileSync(canonicalConfig, "utf8"), /"token": "fresh-token"/);
  assert.equal(existsSync(join(home, ".config", "agent-manager", "runner.config.json")), false);
  assert.match(result.stdout, /Runner installed: .*\/\.local\/bin\/wollipog-runner/);
  assert.match(result.stdout, /Start it:.*\/\.config\/wollipog\/runner\.config\.json/);

  const aliasResult = spawnPosix([shellPath(legacyBin)], { encoding: "utf8" });
  assert.equal(aliasResult.status, 0);
  assert.equal(aliasResult.stdout, "wollipog-test-runner\n");
});

posixTest("POSIX standalone installer preserves a credential-bearing legacy config and warns once", (t) => {
  const { home, run } = installHarness(t);
  const legacyConfig = join(home, ".config", "agent-manager", "runner.config.json");
  const canonicalConfig = join(home, ".config", "wollipog", "runner.config.json");
  const marker = join(home, ".config", "agent-manager", ".wollipog-config-location-warning-v1");
  const original = '{"runnerId":"legacy","token":"do-not-copy-this-secret"}\n';
  mkdirSync(dirname(legacyConfig), { recursive: true });
  writeFileSync(legacyConfig, original);
  if (process.platform !== "win32") chmodSync(legacyConfig, 0o640);

  const first = run("replacement-token-must-not-be-written");
  assert.equal(readFileSync(legacyConfig, "utf8"), original);
  if (process.platform !== "win32") assert.equal(statSync(legacyConfig).mode & 0o777, 0o640);
  assert.equal(existsSync(canonicalConfig), false);
  assert.equal(statSync(marker).size, 0, "warning marker must not contain config or credential values");
  assert.match(first.stderr, /existing legacy runner config/);
  assert.doesNotMatch(first.stderr, /do-not-copy-this-secret|replacement-token-must-not-be-written/);
  assert.match(first.stdout, /Start it:.*\/\.config\/agent-manager\/runner\.config\.json/);

  const second = run("another-unused-token");
  assert.doesNotMatch(second.stderr, /existing legacy runner config/);
  assert.equal(readFileSync(legacyConfig, "utf8"), original);
});

posixTest("POSIX standalone installer gives an existing canonical config precedence", (t) => {
  const { home, run } = installHarness(t);
  const canonicalConfig = join(home, ".config", "wollipog", "runner.config.json");
  const legacyConfig = join(home, ".config", "agent-manager", "runner.config.json");
  const canonical = '{"runnerId":"canonical","token":"canonical-secret"}\n';
  const legacy = '{"runnerId":"legacy","token":"legacy-secret"}\n';
  mkdirSync(dirname(canonicalConfig), { recursive: true });
  mkdirSync(dirname(legacyConfig), { recursive: true });
  writeFileSync(canonicalConfig, canonical);
  writeFileSync(legacyConfig, legacy);

  const result = run("unused-token");
  assert.equal(readFileSync(canonicalConfig, "utf8"), canonical);
  assert.equal(readFileSync(legacyConfig, "utf8"), legacy);
  assert.doesNotMatch(result.stderr, /existing legacy runner config/);
  assert.match(result.stdout, /Start it:.*\/\.config\/wollipog\/runner\.config\.json/);
});

posixTest("POSIX standalone installer refreshes an existing alias through the copy fallback", (t) => {
  const { home, run } = installHarness(t, { failLinks: true });
  const canonicalBin = join(home, ".local", "bin", "wollipog-runner");
  const legacyBin = join(home, ".local", "bin", "agent-manager-runner");
  mkdirSync(dirname(legacyBin), { recursive: true });
  writeFileSync(legacyBin, "old-runner-bytes\n");
  chmodSync(legacyBin, 0o755);

  run("upgrade-token");

  assert.equal(readFileSync(canonicalBin, "utf8"), runnerBytes);
  assert.equal(readFileSync(legacyBin, "utf8"), runnerBytes);
  if (process.platform !== "win32") assert.equal(statSync(legacyBin).mode & 0o111, 0o111);
});

posixTest("POSIX standalone installer completes canonical setup when the legacy alias cannot be refreshed", (t) => {
  const { home, run } = installHarness(t, { failCopies: true, failLinks: true });
  const canonicalBin = join(home, ".local", "bin", "wollipog-runner");
  const legacyBin = join(home, ".local", "bin", "agent-manager-runner");
  const canonicalConfig = join(home, ".config", "wollipog", "runner.config.json");

  const result = run("alias-failure-token");

  assert.equal(readFileSync(canonicalBin, "utf8"), runnerBytes);
  assert.equal(existsSync(legacyBin), false);
  assert.match(readFileSync(canonicalConfig, "utf8"), /"token": "alias-failure-token"/u);
  assert.match(result.stderr, /could not refresh the legacy runner command alias/u);
  assert.match(result.stdout, /Runner installed:/u);
  assert.match(result.stdout, /Start it:/u);
  assert.deepEqual(readdirSync(dirname(legacyBin)).filter((name) => name.includes(".alias-")), []);
});

nativePermissionTest("POSIX standalone installer does not abort when a legacy warning marker is unwritable", (t) => {
  const { home, run } = installHarness(t);
  const legacyConfig = join(home, ".config", "agent-manager", "runner.config.json");
  const legacyDir = dirname(legacyConfig);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(legacyConfig, '{"runnerId":"legacy","token":"preserved"}\n');
  chmodSync(legacyDir, 0o500);

  try {
    const result = run("unused-token");
    assert.match(result.stderr, /existing legacy runner config/u);
    assert.match(result.stdout, /Runner installed:/u);
    assert.match(result.stdout, /Start it:/u);
    assert.equal(existsSync(join(legacyDir, ".wollipog-config-location-warning-v1")), false);
  } finally {
    chmodSync(legacyDir, 0o700);
  }
});
