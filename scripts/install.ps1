#Requires -Version 5
<#
  Wollipog — desktop app installer (Windows x64 / ARM64).

  Usage:
    irm https://raw.githubusercontent.com/picoduck/wollipog/main/scripts/install.ps1 | iex

  Downloads the matching MSI from the latest published GitHub release and installs it.
  The MSI is matched by ARCH SUFFIX (*_x64_*.msi), so this works across the
  Agent Manager -> Wollipog product rename on either side of the release.
  The app is unsigned, so SmartScreen may warn on first launch (More info -> Run anyway).
#>
$ErrorActionPreference = 'Stop'
$repo = 'picoduck/wollipog'
$ua = @{ 'User-Agent' = 'wollipog-install' }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
Write-Host "Wollipog installer - architecture: $arch"

$useGh = $false
try {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $ua
} catch {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub release lookup failed. For a private repository install/authenticate gh (gh auth login, or set GH_TOKEN with Contents: read), then rerun a local copy of this script. $($_.Exception.Message)"
  }
  $json = & gh api "repos/$repo/releases/latest" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Authenticated gh release lookup failed: $json" }
  $rel = $json | ConvertFrom-Json
  $useGh = $true
}
$asset = $rel.assets | Where-Object { $_.name -like "*_${arch}_*.msi" } | Select-Object -First 1
if (-not $asset) { throw "No $arch MSI in release $($rel.tag_name). Has it been published?" }
$digest = [string]$asset.digest
if ($digest -cnotmatch '^sha256:([0-9a-f]{64})$') {
  throw "Desktop asset $($asset.name) has no valid GitHub SHA-256 digest; refusing an unverified install."
}
$expectedSha256 = $Matches[1]

$out = Join-Path $env:TEMP "$PID-$($asset.name)"
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
try {
  if ($useGh) {
    & gh release download $rel.tag_name --repo $repo --pattern $asset.name --output $out
    if ($LASTEXITCODE -ne 0) { throw "gh failed to download $($asset.name)" }
  } else {
    Invoke-WebRequest $asset.browser_download_url -OutFile $out -Headers $ua
  }
  $actualSha256 = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Desktop asset $($asset.name) failed SHA-256 verification."
  }
  Write-Host "Installing..."
  $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$out`"" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "msiexec exited with code $($p.ExitCode)" }
} finally {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
Write-Host "Installed Wollipog $($rel.tag_name). Launch it from the Start menu."
