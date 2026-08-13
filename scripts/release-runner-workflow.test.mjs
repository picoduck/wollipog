import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RUNNER_TARGET_TRIPLES } from "../apps/runner/scripts/runner-artifacts.mjs";
import {
  EXPECTED_DESKTOP_RELEASE_ASSET_COUNT,
  EXPECTED_RELEASE_ASSET_COUNT,
} from "./verify-runner-release-assets.mjs";

test("release workflow natively verifies dual runner assets and gates the final hosted inventory", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const sidecar = readFileSync(new URL("../apps/desktop/scripts/build-sidecar.mjs", import.meta.url), "utf8");
  const hostedGate = readFileSync(new URL("./verify-draft-runner-release.sh", import.meta.url), "utf8");
  const versionGate = readFileSync(new URL("./verify-runner-release-version.sh", import.meta.url), "utf8");
  const releaseDocs = readFileSync(new URL("../docs/RELEASING.md", import.meta.url), "utf8");
  const releaseTargetTable = releaseDocs.split("\nEach desktop bundle", 1)[0];
  const documentedRows = [...releaseTargetTable.matchAll(/^\| `[^`]+`\s*\| `([^`]+)`\s*\| (.+?)\s*\|$/gmu)];
  assert.deepEqual(documentedRows.map((match) => match[1]).sort(), [...RUNNER_TARGET_TRIPLES].sort());
  assert.equal(
    documentedRows.reduce((total, match) => total + (match[2].match(/`[^`]+`/gu)?.length ?? 0), 0),
    EXPECTED_DESKTOP_RELEASE_ASSET_COUNT,
  );
  assert.equal(EXPECTED_RELEASE_ASSET_COUNT, EXPECTED_DESKTOP_RELEASE_ASSET_COUNT + RUNNER_TARGET_TRIPLES.length * 2 + 1);
  assert.equal(workflow.match(/^\s+target: /gmu)?.length, RUNNER_TARGET_TRIPLES.length);
  for (const triple of RUNNER_TARGET_TRIPLES) {
    assert.equal(workflow.match(new RegExp(`target: ${triple}`, "gu"))?.length, 1, `${triple} must have one native job`);
  }
  assert.match(workflow, /canonical="apps\/runner\/dist-bin\/wollipog-runner-\$\{TARGET_TRIPLE\}\$\{executable\}"/u);
  assert.match(workflow, /legacy="apps\/runner\/dist-bin\/agent-manager-runner-\$\{TARGET_TRIPLE\}\$\{executable\}"/u);
  assert.doesNotMatch(workflow, /pnpm --filter @wollipog\/runner build:binary/u);
  assert.equal(sidecar.match(/execFileSync\(process\.execPath, \[runnerBuildScript\]/gu)?.length, 1);
  assert.doesNotMatch(workflow, /ls apps\/runner\/dist-bin\/agent-manager-runner-/u);
  assert.match(
    workflow,
    /sh scripts\/verify-runner-release-version\.sh[\s\S]*apps\/runner\/src\/version\.ts[\s\S]*"\$canonical"[\s\S]*"\$legacy"/u,
  );
  assert.match(versionGate, /sed[\s\S]*version_source[\s\S]*tr -d '\\r'/u);
  assert.match(versionGate, /"\$runner_binary" --version \| tr -d '\\r'/u);
  assert.match(workflow, /cmp -s "\$canonical" "\$legacy"/u);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$canonical" "\$legacy"/u);
  assert.match(workflow, /verify-runner-release:[\s\S]*needs: \[preflight, build\]/u);
  assert.match(workflow, /--pattern 'wollipog-runner-\*'[\s\S]*--pattern 'agent-manager-runner-\*'/u);
  assert.match(workflow, /--manifest SHA256SUMS[\s\S]*gh release upload "\$RELEASE_TAG" SHA256SUMS/u);
  assert.match(
    workflow,
    /bash scripts\/verify-draft-runner-release\.sh[\s\S]*"\$GITHUB_REPOSITORY"[\s\S]*"\$RELEASE_TAG"[\s\S]*SHA256SUMS/u,
  );
  assert.doesNotMatch(workflow, /verify-draft-runner-release\.sh[^\n]*[\s\S]{0,120}\b27\b/u);
  assert.doesNotMatch(workflow, /releases\/tags\/\$\{RELEASE_TAG\}/u);
  assert.match(hostedGate, /gh api --paginate --slurp "repos\/\$repo\/releases\?per_page=100"/u);
  assert.match(hostedGate, /draft-release-id "\$release_tag"/u);
  assert.match(
    hostedGate,
    /gh api --paginate --slurp "repos\/\$repo\/releases\/\$release_id\/assets\?per_page=100"/u,
  );
  assert.match(hostedGate, /if node "\$release_verifier" release[\s\S]*--assets-json "\$assets_json"/u);
  assert.doesNotMatch(hostedGate, /expected_total|\b27\b/u);
  assert.doesNotMatch(hostedGate, /releases\/tags\//u);
});
