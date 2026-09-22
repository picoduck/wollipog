import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));

function stepIndex(name) {
  const index = workflow.indexOf(`- name: ${name}\n`);
  assert.notEqual(index, -1, `missing step: ${name}`);
  return index;
}

test("only signing Windows legs enter the release environment, and they may mint an OIDC token", () => {
  assert.match(
    workflow,
    /environment: \$\{\{ startsWith\(matrix\.os, 'windows'\) && \(github\.ref_type == 'tag' \|\| inputs\.windows_signing\) && 'release' \|\| '' \}\}/u,
  );
  assert.match(workflow, /build:[\s\S]*permissions:\n\s+contents: write[^\n]*\n\s+id-token: write/u);
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+windows_signing:[\s\S]*?type: boolean\n\s+default: false/u);
});

test("a tag run refuses to publish unsigned Windows bundles and a partial configuration fails", () => {
  assert.match(workflow, /if \(\$env:REF_TYPE -eq 'tag'\) \{[\s\S]*?refusing to publish unsigned Windows bundles"\s*\n\s*exit 1/u);
  assert.match(workflow, /Windows signing is partially configured[\s\S]*?exit 1/u);
  for (const name of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "ARTIFACT_SIGNING_ENDPOINT", "ARTIFACT_SIGNING_ACCOUNT", "ARTIFACT_SIGNING_PROFILE"]) {
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`, "u"), `${name} must come from environment variables`);
    assert.doesNotMatch(workflow, new RegExp(`secrets\\.${name}`, "u"));
  }
});

test("the signing client is pinned by version and digest, and actions are pinned by commit", () => {
  assert.match(workflow, /ARTIFACT_SIGNING_CLIENT_VERSION: \d+\.\d+\.\d+\n/u);
  assert.match(workflow, /ARTIFACT_SIGNING_CLIENT_SHA256: [0-9a-f]{64}\n/u);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256[\s\S]*?-ne \$env:ARTIFACT_SIGNING_CLIENT_SHA256[\s\S]*?exit 1/u);
  assert.match(workflow, /uses: azure\/login@[0-9a-f]{40} # v\d/u);
});

test("signing is wired before the build and verified before any standalone asset is uploaded", () => {
  const configure = stepIndex("Configure Windows Authenticode signing");
  const login = stepIndex("Sign in to Azure for Windows signing");
  const token = stepIndex("Acquire the Artifact Signing access token");
  const build = stepIndex("Build & publish desktop bundles");
  const verify = stepIndex("Verify Windows Authenticode signatures");
  const runnerUpload = stepIndex("Verify & upload runner binaries");
  const controlPlaneUpload = stepIndex("Verify & upload control-plane binary");
  assert.ok(configure < login && login < token && token < build && build < verify);
  assert.ok(verify < runnerUpload && verify < controlPlaneUpload);
  assert.match(
    workflow,
    /args: --target \$\{\{ matrix\.target \}\}\$\{\{ env\.WINDOWS_SIGNING == '1' && format\(' --config \{0\}', env\.TAURI_WINDOWS_SIGNING_CONFIG\) \|\| '' \}\}/u,
  );
  assert.match(workflow, /signCommand = @\{ cmd = 'node'; args = @\(\$signer, '%1'\) \}/u);
  assert.match(workflow, /'apps\\runner\\scripts\\windows-authenticode\.mjs'/u);
  assert.equal(tauriConfig.bundle.windows?.signCommand, undefined, "local builds must never carry the CI sign command");
});

test("verification covers every shipped Windows executable with one timestamped signer", () => {
  const verify = workflow.slice(stepIndex("Verify Windows Authenticode signatures"), stepIndex("Verify & upload runner binaries"));
  assert.match(verify, /msiexec\.exe[\s\S]*'\/a'/u);
  for (const asset of ["wollipog-runner-", "agent-manager-runner-", "wollipog-control-plane-"]) {
    assert.match(verify, new RegExp(`${asset}\\$env:TARGET_TRIPLE\\.exe`, "u"));
  }
  assert.match(verify, /verify \/pa/u);
  assert.match(verify, /TimeStamperCertificate/u);
  assert.match(verify, /\$subjects\.Count -ne 1/u);
});
