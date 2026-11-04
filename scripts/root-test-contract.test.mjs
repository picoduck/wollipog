import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the root test command includes runner script tests", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts.test, /"apps\/\*\*\/scripts\/\*\*\/\*\.test\.mjs"/u);
  assert.match(
    readFileSync(new URL("../apps/runner/scripts/runner-artifacts.test.mjs", import.meta.url), "utf8"),
    /runner release names cover the exact six native targets/u,
  );
});

test("the root test commands bound a hung test instead of waiting forever", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  // Node defaults to --test-timeout=0, so an async test that never settles stalls the
  // whole suite. The bound must clear the slowest real test with room for a slower CI
  // runner: the slowest observed test runs ~41s, so 300s is roughly seven times over.
  for (const script of ["test", "test:watch", "test:full", "test:ci", "test:fast", "test:remaining"]) {
    const match = packageJson.scripts[script].match(/--test-timeout=(\d+)/u);
    assert.ok(match, `${script} must set an explicit --test-timeout`);
    const timeoutMs = Number(match[1]);
    assert.ok(
      timeoutMs >= 120_000,
      `${script}: --test-timeout=${timeoutMs} is too tight for the slowest observed test`,
    );
    assert.ok(
      timeoutMs <= 600_000,
      `${script}: --test-timeout=${timeoutMs} is too loose to bound a hang usefully`,
    );
  }
});

test("CI preserves full required coverage rather than selecting only fast contracts", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(scripts["test:ci"], /^node scripts\/test-node\.mjs --suite full /);
  assert.match(scripts["test:fast"], /--suite fast /);
  assert.match(scripts["test:remaining"], /--suite remaining /);
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Unit Tests\n[\s\S]*?else\n\s+pnpm test:ci --shard=\$\{\{ matrix\.shard \}\}\/3\n\s+fi/);
  assert.doesNotMatch(workflow, /run: pnpm test:(?:fast|remaining)\b/);
});
