import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import rootPackage from "../../../package.json" with { type: "json" };
import { EXPECTED_RELEASE_ASSET_COUNT } from "../../../scripts/verify-runner-release-assets.mjs";
import { APP_RELEASE_VERSION, RUNNER_RELEASE_TAG } from "./release-version.js";

test("control-plane runner release identity stays aligned with packaged and runner versions", () => {
  const runnerSource = readFileSync(join(process.cwd(), "apps", "runner", "src", "version.ts"), "utf8");
  const runnerVersion = runnerSource.match(/VERSION = "([^"]+)"/)?.[1];
  const desktopPackage = JSON.parse(
    readFileSync(join(process.cwd(), "apps", "desktop", "package.json"), "utf8"),
  ) as { version?: unknown };
  const tauriConfig = JSON.parse(
    readFileSync(join(process.cwd(), "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { version?: unknown };
  const cargoToml = readFileSync(join(process.cwd(), "apps", "desktop", "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^version = "([^"]+)"/mu)?.[1];
  const cargoLock = readFileSync(join(process.cwd(), "apps", "desktop", "src-tauri", "Cargo.lock"), "utf8");
  const cargoLockVersion = cargoLock.match(
    /\[\[package\]\]\r?\nname = "wollipog-desktop"\r?\nversion = "([^"]+)"/u,
  )?.[1];
  assert.equal(APP_RELEASE_VERSION, rootPackage.version);
  assert.equal(runnerVersion, rootPackage.version);
  assert.equal(desktopPackage.version, rootPackage.version);
  assert.equal(tauriConfig.version, rootPackage.version);
  assert.equal(cargoVersion, rootPackage.version);
  assert.equal(cargoLockVersion, rootPackage.version);
  assert.equal(RUNNER_RELEASE_TAG, `v${rootPackage.version}`);
});

test("release notes disclose the control-plane service compatibility boundary", () => {
  const protocol = readFileSync(join(process.cwd(), "packages", "protocol", "src", "index.ts"), "utf8");
  assert.match(protocol, /CONTROL_PLANE_SERVICE = WOLLIPOG_CONTROL_PLANE_SERVICE/u);

  const releaseNotes = readFileSync(
    join(process.cwd(), "docs", `release-notes-v${rootPackage.version}.md`),
    "utf8",
  );
  assert.match(releaseNotes, /`wollipog-control-plane`/u);
  assert.match(releaseNotes, /Desktop v0\.15\.0 and later/u);
  assert.match(releaseNotes, /The address is not a Wollipog control plane\./u);
  const documentedAssetCount = Number(
    releaseNotes.match(/draft holds exactly ([0-9]+) assets/u)?.[1],
  );
  assert.equal(documentedAssetCount, EXPECTED_RELEASE_ASSET_COUNT);
  assert.match(releaseNotes, /14 desktop bundles, 12 runner names, and\s+`SHA256SUMS`/u);
  assert.match(releaseNotes, /Publishing the verified draft remains a\s+manual operator step\./u);
});

test("release and desktop producers emit Wollipog environment and build-global names", () => {
  const sidecar = readFileSync(join(process.cwd(), "apps", "desktop", "scripts", "build-sidecar.mjs"), "utf8");
  const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  const releaseMetadata = readFileSync(
    join(process.cwd(), "scripts", "resolve-draft-release-asset-digest.sh"),
    "utf8",
  );
  const rust = readFileSync(join(process.cwd(), "apps", "desktop", "src-tauri", "src", "lib.rs"), "utf8");
  const releaseSource = readFileSync(join(process.cwd(), "apps", "control-plane", "src", "release-version.ts"), "utf8");
  assert.match(sidecar, /__WOLLIPOG_RUNNER_RELEASE_TAG__/u);
  assert.doesNotMatch(sidecar, /__MAM_RUNNER_RELEASE_TAG__/u);
  assert.ok(
    sidecar.indexOf("`wollipog-runner-${triple}${exe}`") <
      sidecar.indexOf("`agent-manager-runner-${triple}${exe}`"),
    "desktop packaging must prefer the canonical runner build and retain the legacy bridge",
  );
  assert.match(
    sidecar,
    /if \(builtRunner === legacyRunner\) \{\s*console\.warn\(\s*"Wollipog used a legacy runner asset[^"]+"/u,
    "desktop packaging warns only after choosing the legacy bridge",
  );
  assert.ok(
    sidecar.indexOf("rmSync(canonicalRunner, { force: true })") <
      sidecar.indexOf("execFileSync(process.execPath, [runnerBuildScript]"),
    "desktop packaging removes stale canonical and legacy candidates before building",
  );
  assert.ok(
    sidecar.indexOf("rmSync(legacyRunner, { force: true })") <
      sidecar.indexOf("execFileSync(process.execPath, [runnerBuildScript]"),
    "desktop packaging cannot select stale legacy bytes either",
  );
  assert.match(releaseSource, /__WOLLIPOG_RUNNER_RELEASE_TAG__/u);
  assert.doesNotMatch(releaseSource, /__MAM_RUNNER_RELEASE_TAG__/u);
  assert.match(workflow, /^\s+WOLLIPOG_RUNNER_RELEASE_TAG:/mu);
  assert.doesNotMatch(workflow, /^\s+MAM_RUNNER_RELEASE_TAG:/mu);
  assert.match(
    workflow,
    /remote_digest=\$\(sh scripts\/resolve-draft-release-asset-digest\.sh "\$GITHUB_REPOSITORY" "\$RELEASE_TAG" "\$asset_name"\)/u,
    "release publishing must resolve draft metadata through the behavior-tested retry helper",
  );
  assert.match(
    releaseMetadata,
    /if release_pages=\$\(gh api --paginate --slurp "repos\/\$repo\/releases\?per_page=100"\); then/u,
    "release publishing must retry a failed draft-list request under strict shell",
  );
  assert.match(
    releaseMetadata,
    /if release_id=\$\(printf '%s' "\$release_pages" \| node "\$metadata_parser" draft-release-id "\$release_tag"\); then/u,
    "release publishing must resolve an exact draft tag from an API that includes drafts",
  );
  assert.match(
    releaseMetadata,
    /if asset_pages=\$\(gh api --paginate --slurp "repos\/\$repo\/releases\/\$release_id\/assets\?per_page=100"\); then/u,
    "release publishing must read draft assets through the resolved release id and retry request failures",
  );
  assert.match(
    releaseMetadata,
    /if remote_digest=\$\(printf '%s' "\$asset_pages" \| node "\$metadata_parser" asset-digest "\$asset_name"\); then/u,
    "release publishing must retry malformed or incomplete asset metadata instead of exiting under pipefail",
  );
  assert.doesNotMatch(
    releaseMetadata,
    /releases\/tags\//u,
    "draft metadata must not use the published-release-by-tag endpoint",
  );
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/u,
    "release publishing must require GitHub's full publisher digest");
  assert.match(workflow, /\$\{remote_digest#sha256:\}.*\$local_sha/u,
    "release publishing must compare the publisher digest with the local uploaded bytes");
  assert.match(rust, /\.env\("WOLLIPOG_WEB_DIST"/u);
  assert.doesNotMatch(rust, /\.env\("MAM_WEB_DIST"/u);
});
