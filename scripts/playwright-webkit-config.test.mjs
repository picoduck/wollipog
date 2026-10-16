import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

// Load each config in a fresh process, as Playwright does, and report only the fields that decide
// which browser runs which specs.
function loadConfig(file) {
  const script = `
    const { default: config, WEBKIT_SPECS } = await import(${JSON.stringify(`./${file}`)});
    console.log(JSON.stringify({ browserName: config.use?.browserName ?? null, projects: config.projects ?? null,
      testDir: config.testDir, testMatch: config.testMatch ?? null, webkitSpecs: WEBKIT_SPECS ?? null }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root, env: { ...process.env, SYNTHETIC_ARTIFACT_FAILURE: "false" }, encoding: "utf8",
  }));
}

test("WebKit runs only the specs that opted in, and the default suite stays Chromium", () => {
  const webkit = loadConfig("playwright.webkit.config.ts");
  assert.equal(webkit.browserName, "webkit");
  assert.equal(webkit.projects, null, "a project list would run every spec in every project");
  assert.deepEqual(webkit.testMatch, webkit.webkitSpecs);
  assert.ok(webkit.webkitSpecs.includes("number-fields.spec.ts"), "#3214's spec must stay covered");

  const readme = readFileSync(new URL("../apps/web/e2e/README.md", import.meta.url), "utf8");
  for (const spec of webkit.webkitSpecs) {
    assert.ok(existsSync(new URL(`../${webkit.testDir}/${spec}`, import.meta.url)),
      `${spec}: a listed spec that does not exist matches nothing, and the WebKit job runs no tests`);
    assert.match(readme, new RegExp(`\`${spec.replaceAll(".", "\\.")}\``), `${spec}: the e2e README must name it`);
  }

  // Chromium is Playwright's default; a browserName or projects here would move the whole suite.
  const chromium = loadConfig("playwright.config.ts");
  assert.equal(chromium.browserName, null);
  assert.equal(chromium.projects, null);
  assert.equal(chromium.testDir, webkit.testDir);
});
