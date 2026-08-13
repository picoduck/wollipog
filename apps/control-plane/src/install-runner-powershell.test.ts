import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const havePowerShell = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
  stdio: "ignore",
}).status === 0;
const requirePowerShell = process.platform === "win32" || process.env.CI === "true";

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test("Windows installer preserves publisher digest verification through authenticated gh API metadata", {
  skip: !havePowerShell && !requirePowerShell,
}, () => {
  assert.equal(havePowerShell, true, "PowerShell is required for this installer harness on Windows and in CI");
  const root = mkdtempSync(join(tmpdir(), "wollipog-private-installer-"));
  const localAppData = join(root, "local-app-data");
  const wrapper = join(root, "run-installer.ps1");
  const installer = fileURLToPath(new URL("../../../scripts/install-runner.ps1", import.meta.url));
  const payload = "private-release-runner";
  const digest = createHash("sha256").update(payload).digest("hex");
  const release = JSON.stringify({
    tag_name: "v-private-test",
    assets: [{
      name: "agent-manager-runner-x86_64-pc-windows-msvc.exe",
      digest: `sha256:${digest}`,
    }],
  }).replaceAll("'", "''");
  try {
    const legacyInstalled = join(localAppData, "AgentManager", "agent-manager-runner.exe");
    mkdirSync(join(localAppData, "AgentManager"), { recursive: true });
    writeFileSync(legacyInstalled, "old-runner-bytes");
    writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(localAppData)}
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:COMPUTERNAME = 'installer-test'
function global:Invoke-RestMethod { throw 'anonymous metadata unavailable' }
function global:gh {
  if ($args[0] -eq 'api' -and $args[1] -eq 'repos/picoduck/wollipog/releases/latest') {
    $global:LASTEXITCODE = 0
    Write-Output '${release}'
    return
  }
  if ($args[0] -eq 'release' -and $args[1] -eq 'download') {
    $outputIndex = [Array]::IndexOf($args, '--output')
    if ($outputIndex -lt 0) { throw 'missing gh download output' }
    [System.IO.File]::WriteAllText([string]$args[$outputIndex + 1], ${psQuote(payload)}, (New-Object System.Text.UTF8Encoding $false))
    $global:LASTEXITCODE = 0
    return
  }
  throw "unexpected gh invocation: $args"
}
& ${psQuote(installer)} -Token 'test-token' -Workspace ${psQuote(root)}
`, "utf8");

    execFileSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    ], { encoding: "utf8", stdio: "pipe" });
    const installed = join(localAppData, "Wollipog", "wollipog-runner.exe");
    assert.equal(readFileSync(installed, "utf8"), payload,
      "the authenticated raw metadata digest verifies the exact downloaded private asset");
    assert.equal(readFileSync(legacyInstalled, "utf8"), payload,
      "the compatibility command is refreshed from the same verified bytes");
    assert.match(readFileSync(join(localAppData, "Wollipog", "runner.config.json"), "utf8"), /"token":\s*"test-token"/u);
    assert.equal(existsSync(join(localAppData, "AgentManager", "runner.config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows installer completes canonical setup when a running legacy alias cannot be refreshed", {
  skip: process.platform !== "win32" || !havePowerShell,
}, () => {
  assert.equal(havePowerShell, true, "PowerShell is required for this installer harness on Windows and in CI");
  const root = mkdtempSync(join(tmpdir(), "wollipog-locked-legacy-installer-"));
  const localAppData = join(root, "local-app-data");
  const legacyDir = join(localAppData, "AgentManager");
  const legacyInstalled = join(legacyDir, "agent-manager-runner.exe");
  const wrapper = join(root, "run-installer.ps1");
  const resultPath = join(root, "result.txt");
  const installer = fileURLToPath(new URL("../../../scripts/install-runner.ps1", import.meta.url));
  const payload = "verified-canonical-runner";
  const digest = createHash("sha256").update(payload).digest("hex");
  const release = JSON.stringify({
    tag_name: "v-locked-alias-test",
    assets: [{
      name: "wollipog-runner-x86_64-pc-windows-msvc.exe",
      digest: `sha256:${digest}`,
      browser_download_url: "https://download.test/wollipog-runner.exe",
    }],
  }).replaceAll("'", "''");
  try {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyInstalled, "running-legacy-runner");
    writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(localAppData)}
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:COMPUTERNAME = 'installer-test'
function global:Invoke-RestMethod { return '${release}' | ConvertFrom-Json }
function global:Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [hashtable]$Headers)
  [System.IO.File]::WriteAllText($OutFile, ${psQuote(payload)}, (New-Object System.Text.UTF8Encoding $false))
}
$lock = [System.IO.File]::Open(${psQuote(legacyInstalled)}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
  $output = & ${psQuote(installer)} -Token 'locked-test-token' -Workspace ${psQuote(root)} *>&1 | Out-String
  [System.IO.File]::WriteAllText(${psQuote(resultPath)}, $output, (New-Object System.Text.UTF8Encoding $false))
} finally {
  $lock.Dispose()
}
`, "utf8");

    execFileSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    ], { encoding: "utf8", stdio: "pipe" });
    assert.equal(readFileSync(join(localAppData, "Wollipog", "wollipog-runner.exe"), "utf8"), payload);
    assert.equal(readFileSync(legacyInstalled, "utf8"), "running-legacy-runner");
    assert.match(readFileSync(join(localAppData, "Wollipog", "runner.config.json"), "utf8"),
      /"token":\s*"locked-test-token"/u);
    const output = readFileSync(resultPath, "utf8");
    assert.match(output, /Could not refresh the legacy runner command alias/u);
    assert.match(output, /Runner installed:/u);
    assert.match(output, /Start it:/u);
    assert.deepEqual(readdirSync(legacyDir).filter((name) => name.includes(".alias-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows installer rejects missing and mismatched publisher digests without promotion", {
  skip: !havePowerShell && !requirePowerShell,
}, () => {
  assert.equal(havePowerShell, true, "PowerShell is required for this installer harness on Windows and in CI");
  const installer = fileURLToPath(new URL("../../../scripts/install-runner.ps1", import.meta.url));
  for (const scenario of ["missing", "mismatch"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-private-installer-${scenario}-`));
    const localAppData = join(root, "local-app-data");
    const wrapper = join(root, "run-installer.ps1");
    const resultPath = join(root, "result.txt");
    const digest = scenario === "missing" ? undefined : `sha256:${"0".repeat(64)}`;
    const release = JSON.stringify({
      tag_name: "v-private-test",
      assets: [{
        name: "wollipog-runner-x86_64-pc-windows-msvc.exe",
        ...(digest ? { digest } : {}),
      }],
    }).replaceAll("'", "''");
    try {
      writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(localAppData)}
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:COMPUTERNAME = 'installer-test'
$global:DownloadCalled = $false
function global:Invoke-RestMethod { throw 'anonymous metadata unavailable' }
function global:gh {
  if ($args[0] -eq 'api') {
    $global:LASTEXITCODE = 0
    Write-Output '${release}'
    return
  }
  if ($args[0] -eq 'release' -and $args[1] -eq 'download') {
    $global:DownloadCalled = $true
    $outputIndex = [Array]::IndexOf($args, '--output')
    [System.IO.File]::WriteAllText([string]$args[$outputIndex + 1], 'untrusted-runner')
    $global:LASTEXITCODE = 0
    return
  }
  throw "unexpected gh invocation: $args"
}
try {
  & ${psQuote(installer)} -Token 'test-token' -Workspace ${psQuote(root)}
  throw 'installer unexpectedly succeeded'
} catch {
  [System.IO.File]::WriteAllText(${psQuote(resultPath)}, $_.Exception.Message + [Environment]::NewLine + [string]$global:DownloadCalled)
}
`, "utf8");

      execFileSync(powershell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
      ], { encoding: "utf8", stdio: "pipe" });
      const [message, downloadCalled] = readFileSync(resultPath, "utf8").split(/\r?\n/u);
      assert.match(message!, scenario === "missing" ? /no valid GitHub SHA-256 digest/u : /failed SHA-256 verification/u);
      assert.equal(downloadCalled, scenario === "missing" ? "False" : "True");
      const canonicalDir = join(localAppData, "Wollipog");
      const legacyDir = join(localAppData, "AgentManager");
      assert.equal(existsSync(join(canonicalDir, "wollipog-runner.exe")), false);
      assert.equal(existsSync(join(legacyDir, "agent-manager-runner.exe")), false);
      for (const installDir of [canonicalDir, legacyDir]) {
        assert.deepEqual(
          existsSync(installDir)
            ? readdirSync(installDir).filter((name) => name.includes(".download-") || name.includes(".alias-"))
            : [],
          [],
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Windows installer preserves legacy config in place and gives canonical config precedence", {
  skip: !havePowerShell && !requirePowerShell,
}, () => {
  assert.equal(havePowerShell, true, "PowerShell is required for this installer harness on Windows and in CI");
  const installer = fileURLToPath(new URL("../../../scripts/install-runner.ps1", import.meta.url));
  for (const scenario of ["legacy-only", "canonical-and-legacy"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-config-precedence-${scenario}-`));
    const localAppData = join(root, "local-app-data");
    const canonicalConfig = join(localAppData, "Wollipog", "runner.config.json");
    const legacyConfig = join(localAppData, "AgentManager", "runner.config.json");
    const wrapper = join(root, "run-installer.ps1");
    const resultPath = join(root, "result.txt");
    const canonical = '{"runnerId":"canonical","token":"canonical-secret"}';
    const legacy = '{"runnerId":"legacy","token":"legacy-secret"}';
    const payload = `verified-${scenario}`;
    const digest = createHash("sha256").update(payload).digest("hex");
    const release = JSON.stringify({
      tag_name: "v-config-test",
      assets: [{
        name: "wollipog-runner-x86_64-pc-windows-msvc.exe",
        digest: `sha256:${digest}`,
      }],
    }).replaceAll("'", "''");
    try {
      writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$env:LOCALAPPDATA = ${psQuote(localAppData)}
$env:PROCESSOR_ARCHITECTURE = 'AMD64'
$env:COMPUTERNAME = 'installer-test'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(legacyConfig)}) | Out-Null
[System.IO.File]::WriteAllText(${psQuote(legacyConfig)}, ${psQuote(legacy)}, (New-Object System.Text.UTF8Encoding $false))
if (${psQuote(scenario)} -eq 'canonical-and-legacy') {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(canonicalConfig)}) | Out-Null
  [System.IO.File]::WriteAllText(${psQuote(canonicalConfig)}, ${psQuote(canonical)}, (New-Object System.Text.UTF8Encoding $false))
}
function global:Invoke-RestMethod { return '${release}' | ConvertFrom-Json }
function global:Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [hashtable]$Headers)
  [System.IO.File]::WriteAllText($OutFile, ${psQuote(payload)}, (New-Object System.Text.UTF8Encoding $false))
}
& ${psQuote(installer)} -Token 'unused-token' -Workspace ${psQuote(root)} 3>&1 |
  Out-File -LiteralPath ${psQuote(resultPath)} -Encoding utf8
`, "utf8");

      execFileSync(powershell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
      ], { encoding: "utf8", stdio: "pipe" });
      assert.equal(readFileSync(legacyConfig, "utf8"), legacy);
      if (scenario === "legacy-only") {
        assert.equal(existsSync(canonicalConfig), false, "legacy credentials are not copied into the canonical path");
        assert.equal(existsSync(join(localAppData, "AgentManager", ".wollipog-config-location-warning-v1")), true);
        assert.match(readFileSync(resultPath, "utf8"), /existing legacy runner config/u);
      } else {
        assert.equal(readFileSync(canonicalConfig, "utf8"), canonical);
        assert.equal(existsSync(join(localAppData, "AgentManager", ".wollipog-config-location-warning-v1")), false);
        assert.doesNotMatch(readFileSync(resultPath, "utf8"), /existing legacy runner config/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
