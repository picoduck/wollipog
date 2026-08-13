#Requires -Version 5
<#
  Wollipog — Runner Installer (Windows x64 / ARM64).

  Downloads the standalone runner binary (no Node required) and writes a starter config.

  Usage (local dashboard, defaults):
    irm https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.ps1 | iex

  Usage (remote dashboard — pass params via a scriptblock):
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install-runner.ps1))) -Url ws://HOST:4317/runner -Token YOUR_TOKEN
#>
param(
  [string]$Url = 'ws://127.0.0.1:4317/runner',
  [string]$Token = 'dev-local-token',
  [string]$RunnerId = $env:COMPUTERNAME,
  [string]$Workspace = $env:USERPROFILE
)
$ErrorActionPreference = 'Stop'
$repo = 'picoduck/wollipog'
$ua = @{ 'User-Agent' = 'wollipog-install' }

$triple = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
$useGh = $false
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $ua
} catch {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub release lookup failed. For a private repository install/authenticate gh (gh auth login, or set GH_TOKEN with Contents: read), then rerun a local copy of this script. $($_.Exception.Message)"
  }
  # `gh release view --json assets` projects GitHub's response through gh's own schema and drops
  # the publisher `digest`. `gh api` preserves the authenticated raw REST payload, so private
  # installs keep the same fail-closed checksum contract as public installs.
  $json = & gh api "repos/$repo/releases/latest" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Authenticated gh release lookup failed: $json" }
  $rel = $json | ConvertFrom-Json
  $useGh = $true
}
$assetNames = @("wollipog-runner-$triple.exe", "agent-manager-runner-$triple.exe")
$asset = $null
foreach ($name in $assetNames) {
  $asset = $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if ($asset) { break }
}
if (-not $asset) { throw "No runner binary for $triple in release $($rel.tag_name) (published, and built after the installer PR?)." }
if ($asset.name -eq $assetNames[1]) {
  Write-Warning 'Wollipog used a legacy runner asset because the canonical asset was absent; update the release producer before compatibility is removed.'
}
$digest = [string]$asset.digest
if ($digest -notmatch '^sha256:([0-9a-f]{64})$') {
  throw "Runner asset $($asset.name) has no valid GitHub SHA-256 digest; refusing an unverified install."
}
$expectedSha256 = $Matches[1]

$dir = Join-Path $env:LOCALAPPDATA 'Wollipog'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bin = Join-Path $dir 'wollipog-runner.exe'
$legacyDir = Join-Path $env:LOCALAPPDATA 'AgentManager'
$legacyBin = Join-Path $legacyDir 'agent-manager-runner.exe'
$partial = "$bin.download-$PID"
$legacyPartial = "$legacyBin.alias-$PID"
Write-Host "Downloading $($asset.name)..."
try {
  if ($useGh) {
    & gh release download $rel.tag_name --repo $repo --pattern $asset.name --output $partial
    if ($LASTEXITCODE -ne 0) { throw "gh failed to download $($asset.name)" }
  } else {
    Invoke-WebRequest $asset.browser_download_url -OutFile $partial -Headers $ua
  }
  $actualSha256 = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Runner asset $($asset.name) failed SHA-256 verification."
  }
  Move-Item -LiteralPath $partial -Destination $bin -Force
} finally {
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
}

# Keep existing services and commands functional during the compatibility window. MoveFileEx
# swaps a stopped existing alias atomically. If a running process locks the old executable, retain
# those complete old bytes, finish the canonical install, and tell the operator how to retry.
try {
  New-Item -ItemType Directory -Force -Path $legacyDir | Out-Null
  Copy-Item -LiteralPath $bin -Destination $legacyPartial -Force
  if (Test-Path -LiteralPath $legacyBin -PathType Leaf) {
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
      if (-not ([System.Management.Automation.PSTypeName]'WollipogInstaller.NativeMethods').Type) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace WollipogInstaller {
  public static class NativeMethods {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
  }
}
'@
      }
      $replaceExistingAndWriteThrough = 0x1 -bor 0x8
      if (-not [WollipogInstaller.NativeMethods]::MoveFileEx($legacyPartial, $legacyBin, $replaceExistingAndWriteThrough)) {
        throw "Windows could not replace the legacy runner command alias."
      }
    } else {
      # The installer harness runs under pwsh on Linux CI; production Windows uses MoveFileEx above.
      Move-Item -LiteralPath $legacyPartial -Destination $legacyBin -Force
    }
  } else {
    Move-Item -LiteralPath $legacyPartial -Destination $legacyBin
  }
} catch {
  Write-Warning "Could not refresh the legacy runner command alias at $legacyBin. The canonical runner is installed; stop any process using the legacy command and rerun this installer."
} finally {
  Remove-Item -LiteralPath $legacyPartial -Force -ErrorAction SilentlyContinue
}

$canonicalCfg = Join-Path $dir 'runner.config.json'
$legacyCfg = Join-Path $legacyDir 'runner.config.json'
if (Test-Path -LiteralPath $canonicalCfg -PathType Leaf) {
  $cfg = $canonicalCfg
} elseif (Test-Path -LiteralPath $legacyCfg -PathType Leaf) {
  # Do not copy credential-bearing configuration. The empty marker contains no secret values and
  # makes the path-only migration warning one-time for an existing installation.
  $cfg = $legacyCfg
  $configWarning = Join-Path $legacyDir '.wollipog-config-location-warning-v1'
  if (-not (Test-Path -LiteralPath $configWarning -PathType Leaf)) {
    Write-Warning "Using the existing legacy runner config at $legacyCfg; it was not copied or changed. Fresh installs use $canonicalCfg."
    try {
      [System.IO.File]::WriteAllText($configWarning, '', (New-Object System.Text.UTF8Encoding $false))
    } catch {
      # The warning already reached the operator. A read-only legacy config directory should make
      # it repeat on the next run, not abort an otherwise successful canonical install.
    }
  }
} else {
  $cfg = $canonicalCfg
}
if (-not (Test-Path $cfg)) {
  $obj = [ordered]@{
    runnerId        = $RunnerId
    controlPlaneUrl = $Url
    token           = $Token
    workspaces      = @([ordered]@{ id = 'home'; name = $RunnerId; path = $Workspace })
    agents          = @()
  }
  # BOM-less UTF-8: PowerShell's Set-Content -Encoding utf8 prepends a BOM that the runner's
  # JSON.parse rejects, so write the bytes directly.
  [System.IO.File]::WriteAllText($cfg, ($obj | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Wrote starter config: $cfg"
}

Write-Host ""
Write-Host "Runner installed: $bin"
Write-Host "Start it:  & '$bin' --config '$cfg'"
