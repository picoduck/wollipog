import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function script(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../scripts/${name}`, import.meta.url)), "utf8");
}

test("release installers retain authenticated gh fallback for private repositories", () => {
  for (const name of ["install-runner.sh", "install-runner.ps1", "install.sh", "install.ps1"]) {
    const body = script(name);
    if (name.endsWith(".ps1") || name.endsWith(".sh")) {
      assert.match(body, /gh api "repos\/\$repo\/releases\/latest"/,
        `${name}: raw authenticated metadata lookup retains publisher digests`);
      assert.doesNotMatch(
        body,
        name.endsWith(".ps1") ? /& gh release view/ : /^\s*gh release view/m,
        `${name}: projected gh metadata drops digests`,
      );
    }
    assert.match(body, /gh release download/, `${name}: authenticated asset download`);
    assert.match(body, /digest/, `${name}: publisher digest metadata is retained`);
    assert.match(body, /GH_TOKEN/, `${name}: actionable private-repository guidance`);
    assert.doesNotMatch(body, /Write-(Host|Output).*\$Token/, `${name}: token must not be printed`);
  }
  const desktopPosix = script("install.sh");
  assert.match(desktopPosix, /gh release download "\$release_tag".*--pattern "\$download_asset"/,
    "authenticated desktop downloads are bound to the resolved release tag");
  assert.match(desktopPosix, /staged="\$\{dest\}\.download\.\$\$"/,
    "Linux desktop bytes stage beside the live destination");
  assert.ok(desktopPosix.indexOf('verify_sha256 "$staged"') <
    desktopPosix.indexOf('mv -f "$staged" "$dest"'),
    "Linux desktop digest verification precedes atomic same-filesystem promotion");
});

test("standalone runner installers download beside the live binary and promote atomically", () => {
  const posix = script("install-runner.sh");
  assert.ok(posix.indexOf('canonical="wollipog-runner-${triple}"') <
    posix.indexOf('legacy="agent-manager-runner-${triple}"'));
  assert.match(posix, /asset_record=\$\(release_asset_record "\$canonical"\)/,
    "public release lookup parses the exact canonical asset record");
  assert.match(posix, /if \[ -z "\$asset_record" \]; then[\s\S]*release_asset_record "\$legacy"/,
    "the published v0.15.0 legacy asset remains a metadata-proven fallback");
  assert.match(posix, /gh release download "\$release_tag".*--pattern "\$asset_name"/,
    "authenticated binary download is bound to the resolved release tag");
  assert.match(posix, /gh release download "\$release_tag".*--pattern SHA256SUMS/,
    "authenticated checksum download is bound to the same release tag");
  assert.match(posix, /\$2 == asset && length\(\$1\) == 64/,
    "manifest lookup requires one exact filename and a full digest");
  assert.match(posix, /"\$legacy_selected" -eq 1[\s\S]*legacy-runner-asset-warning-v1/,
    "legacy fallback warning is persisted once");
  assert.match(posix, /echo "Warning: Wollipog used a legacy runner asset[^$]+" >&2/,
    "POSIX fallback produces a value-free warning");
  assert.match(posix, /partial="\$\{bin\}\.download\.\$\$"/);
  assert.match(posix, /bin="\$bindir\/wollipog-runner"/);
  assert.match(posix, /legacy_bin="\$bindir\/agent-manager-runner"/);
  assert.match(posix, /trap cleanup EXIT/);
  assert.match(posix, /--output "\$partial"/);
  assert.match(posix, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(posix, /sha256sum "\$partial"|shasum -a 256 "\$partial"/);
  assert.ok(posix.indexOf("actual_sha256=") < posix.indexOf('mv -f "$partial" "$bin"'),
    "POSIX publisher digest verification must precede promotion");
  assert.match(posix, /mv -f "\$partial" "\$bin"/);
  assert.match(posix, /mv -f "\$legacy_partial" "\$legacy_bin"/,
    "the legacy command alias is replaced atomically");
  assert.match(posix, /canonical_cfgdir="\$HOME\/\.config\/wollipog"/);
  assert.match(posix, /legacy_cfgdir="\$HOME\/\.config\/agent-manager"/);
  assert.ok(posix.indexOf('if [ -f "$canonical_cfg" ]') < posix.indexOf('elif [ -f "$legacy_cfg" ]'),
    "an existing canonical config wins before legacy fallback");
  assert.match(posix, /existing legacy runner config[\s\S]*it was not copied or changed/,
    "legacy config migration warning discloses no config values");
  assert.match(posix, /cleanup\(\)\s*\{[\s\S]*rm -f "\$partial"[\s\S]*rm -f "\$checksum_partial"/,
    "failed downloads remove binary and manifest staging bytes");

  const powershell = script("install-runner.ps1");
  assert.match(powershell, /@\("wollipog-runner-\$triple\.exe", "agent-manager-runner-\$triple\.exe"\)/);
  assert.match(powershell, /if \(\$asset\.name -eq \$assetNames\[1\]\) \{\s*Write-Warning 'Wollipog used a legacy runner asset[^']+'/,
    "Windows fallback produces a value-free warning");
  assert.match(powershell, /\^sha256:\(\[0-9a-f\]\{64\}\)\$/);
  assert.match(powershell, /gh api "repos\/\$repo\/releases\/latest"/,
    "Windows private releases use raw authenticated GitHub metadata with publisher digests");
  assert.match(powershell, /Get-FileHash -LiteralPath \$partial -Algorithm SHA256/);
  assert.ok(powershell.indexOf("Get-FileHash") < powershell.indexOf("Move-Item -LiteralPath $partial"),
    "publisher digest verification must precede promotion");
  assert.match(powershell, /\$partial = "\$bin\.download-\$PID"/);
  assert.match(powershell, /'User-Agent' = 'wollipog-install'/);
  assert.match(powershell, /Join-Path \$env:LOCALAPPDATA 'Wollipog'/);
  assert.match(powershell, /Join-Path \$dir 'wollipog-runner\.exe'/);
  assert.match(powershell, /Join-Path \$legacyDir 'agent-manager-runner\.exe'/);
  assert.match(powershell, /--output \$partial/);
  assert.match(powershell, /Move-Item -LiteralPath \$partial -Destination \$bin -Force/);
  assert.match(powershell, /MoveFileEx\(\$legacyPartial, \$legacyBin, \$replaceExistingAndWriteThrough\)/,
    "an existing unlocked Windows legacy command alias is replaced atomically");
  assert.match(powershell, /catch \{[\s\S]*Could not refresh the legacy runner command alias/,
    "a locked Windows legacy command remains intact without aborting the canonical install");
  assert.ok(powershell.indexOf("Test-Path -LiteralPath $canonicalCfg") <
    powershell.indexOf("Test-Path -LiteralPath $legacyCfg"), "canonical Windows config wins first");
  assert.match(powershell, /existing legacy runner config[\s\S]*it was not copied or changed/,
    "Windows legacy config migration warning discloses no config values");
  assert.match(powershell, /finally\s*\{[\s\S]*Remove-Item -LiteralPath \$partial/, "failed downloads clean staging bytes");
});
