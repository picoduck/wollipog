import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const helper = resolve("scripts/playwright-system-packages.sh");
const linuxOnly = { skip: process.platform === "win32" && "Ubuntu-only apt helper" };

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "playwright-system-packages-"));
  const calls = join(dir, "calls");
  const output = join(dir, "output");
  const report = "Missing system dependencies (2):\n  libexample1\n  example-data\n";
  const archives = "'https://mirror.example/a' libexample1_1_amd64.deb 12 SHA256:aaa\n'https://mirror.example/b' example-data_2_all.deb 34 SHA256:bbb\n";
  try {
    writeFileSync(join(dir, "sudo"), `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$CACHE_TEST_CALLS"
case "$1 $2" in
  'apt-get update') exit "\${CACHE_TEST_UPDATE_STATUS:-0}" ;;
  'apt-get install')
    if [[ " $* " == *' --print-uris '* ]]; then
      printf '%s' "$CACHE_TEST_ARCHIVES"
      exit 0
    fi
    [[ " $* " == *' --no-download '* ]] || exit 99
    exit "\${CACHE_TEST_OFFLINE_STATUS:-0}" ;;
  'pkill -KILL') exit 1 ;;
  'cp '*) exit "\${CACHE_TEST_COPY_STATUS:-0}" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, "pnpm"), `#!/bin/bash
printf 'pnpm %s\\n' "$*" >> "$CACHE_TEST_CALLS"
if [[ " $* " == *' --dry-run '* ]]; then
  printf '%s' "$CACHE_TEST_REPORT"
exit "\${CACHE_TEST_REPORT_STATUS:-1}"
fi
exit "\${CACHE_TEST_INSTALL_STATUS:-0}"
`, { mode: 0o755 });
    // Collect has no root privileges. Substitute its source archive directory only; copying
    // still uses the real cp and fails for a missing archive. No host apt directory is touched.
    writeFileSync(join(dir, "cp"), `#!/bin/bash
src="$1"
if [[ "$src" == /var/cache/apt/archives/* ]]; then src="$CACHE_TEST_DEPOT/\${src##*/}"; fi
exec /bin/cp "$src" "$2"
`, { mode: 0o755 });
    const depot = join(dir, "depot");
    mkdirSync(depot);
    for (const name of ["libexample1_1_amd64.deb", "example-data_2_all.deb", "unrelated.deb"]) {
      writeFileSync(join(depot, name), name);
    }
    const env = { ...process.env, HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: output,
      PATH: `${dir}${delimiter}${process.env.PATH}`, ImageOS: "ubuntu24", ImageVersion: "20261020.1",
      PLAYWRIGHT_VERSION: "1.63.0", CACHE_TEST_CALLS: calls, CACHE_TEST_DEPOT: depot,
      CACHE_TEST_REPORT: report, CACHE_TEST_ARCHIVES: archives };
    function execute(phase, browser = "chromium", mode = "system", overrides = {}) {
      writeFileSync(calls, "");
      writeFileSync(output, "");
      const result = spawnSync("bash", [helper, phase, browser, mode], {
        env: { ...env, ...overrides }, encoding: "utf8",
      });
      assert.equal(result.error, undefined);
      return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
        output: readFileSync(output, "utf8") };
    }
    run({ dir, env, execute });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("package keys follow the image, Playwright and exact archives while ignoring mirror URLs and order", linuxOnly, () => fixture(({ execute, env }) => {
  const first = execute("resolve");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.output, /^key=playwright-system-v1-chromium-ubuntu24-20261020\.1-1\.63\.0-[a-f0-9]{64}\n$/);
  assert.equal(first.calls[0], "sudo apt-get update -qq");
  assert.equal(first.calls[2], "sudo apt-get install -qq --print-uris --no-install-recommends libexample1 example-data");
  for (const overrides of [
    { ImageOS: "ubuntu26" }, { ImageVersion: "20261021.1" }, { PLAYWRIGHT_VERSION: "1.64.0" },
    { CACHE_TEST_ARCHIVES: env.CACHE_TEST_ARCHIVES.replace("_1_", "_3_") },
    { CACHE_TEST_ARCHIVES: env.CACHE_TEST_ARCHIVES.replace(" 12 ", " 13 ") },
    { CACHE_TEST_ARCHIVES: env.CACHE_TEST_ARCHIVES.replace("SHA256:aaa", "SHA256:ccc") },
  ]) {
    const result = execute("resolve", "chromium", "system", overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.output, first.output);
  }
  const moved = env.CACHE_TEST_ARCHIVES.trim().split("\n").reverse().join("\n").replaceAll("mirror.example", "other.example");
  assert.equal(execute("resolve", "chromium", "system", { CACHE_TEST_ARCHIVES: moved }).output, first.output);
  assert.notEqual(execute("resolve", "webkit").output, first.output);
}));

test("failed or changed dependency resolution never emits a usable key", linuxOnly, () => fixture(({ execute }) => {
  for (const overrides of [
    { CACHE_TEST_UPDATE_STATUS: "23" }, { CACHE_TEST_REPORT_STATUS: "2" },
    { CACHE_TEST_REPORT: "All system dependencies are installed.", CACHE_TEST_REPORT_STATUS: "0" },
    { CACHE_TEST_REPORT: "unexpected output" },
    { CACHE_TEST_REPORT: "Missing system dependencies (2):\n  only-one\n" },
    { CACHE_TEST_REPORT: "Missing system dependencies (1):\n  --allow-unauthenticated\n" },
    { CACHE_TEST_ARCHIVES: "" },
  ]) {
    const result = execute("resolve", "chromium", "system", overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.output, "");
  }
}));

test("hits forbid apt archive downloads in both browser paths; misses preserve Playwright installs", linuxOnly, () => fixture(({ execute }) => {
  for (const browser of ["chromium", "webkit"]) {
    assert.equal(execute("resolve", browser).status, 0);
    for (const mode of ["system", "browser"]) {
      const hit = execute("install", browser, mode, { SYSTEM_CACHE_HIT: "true" });
      assert.equal(hit.status, 0, hit.stderr);
      assert.match(hit.calls[0], /^sudo cp .*\.deb \/var\/cache\/apt\/archives\/$/);
      assert.equal(hit.calls[1], "sudo apt-get install -y --no-install-recommends --no-download libexample1 example-data");
      assert.deepEqual(hit.calls.slice(2), mode === "browser" ? [`pnpm exec playwright install ${browser}`] : []);
      for (const cacheHit of ["false", ""]) {
        const miss = execute("install", browser, mode, { SYSTEM_CACHE_HIT: cacheHit });
        assert.equal(miss.status, 0, miss.stderr);
        assert.deepEqual(miss.calls, ["sudo pkill -KILL -x apt-get", mode === "browser"
          ? `pnpm exec playwright install --with-deps ${browser}` : `pnpm exec playwright install-deps ${browser}`]);
      }
      for (const overrides of [{ SYSTEM_CACHE_HIT: "true", CACHE_TEST_COPY_STATUS: "17" },
        { SYSTEM_CACHE_HIT: "true", CACHE_TEST_OFFLINE_STATUS: "23" },
        { SYSTEM_CACHE_HIT: "false", CACHE_TEST_INSTALL_STATUS: "31" }]) {
        assert.notEqual(execute("install", browser, mode, overrides).status, 0, "failure must reach the bounded retry");
      }
    }
  }
}));

test("collect keeps exactly the resolved archives and rejects an incomplete collection", linuxOnly, () => fixture(({ dir, execute }) => {
  assert.equal(execute("resolve").status, 0);
  assert.equal(execute("collect").status, 0);
  const cache = join(dir, ".cache/playwright-chromium-packages");
  assert.equal(readFileSync(join(cache, "example-data_2_all.deb"), "utf8"), "example-data_2_all.deb");
  assert.throws(() => readFileSync(join(cache, "unrelated.deb")));
  rmSync(join(dir, "depot/libexample1_1_amd64.deb"));
  assert.notEqual(execute("collect").status, 0);
}));
