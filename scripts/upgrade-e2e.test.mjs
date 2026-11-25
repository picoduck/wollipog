import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";

const script = fileURLToPath(new URL("./upgrade-e2e.sh", import.meta.url));
const linuxTest = process.platform === "linux" ? test : test.skip;

function runFixture(fixture, ...args) {
  const result = spawnSync("bash", ["-eu", "-o", "pipefail", "-c", fixture, "fixture", script, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}

for (const [label, output, version] of [
  ["stable", "0.36.1 (protocol v332)\n", "0.36.1"],
  ["release candidate", "0.37.0-rc.3 (protocol v393)\nextra output\n", "0.37.0-rc.3"],
  ["CRLF", "0.37.0-rc.3\r\n", "0.37.0-rc.3"],
]) {
  linuxTest(`upgrade rehearsal extracts the version from ${label} output`, () => {
    const actual = runFixture(`
      source "$1"
      executable() {
        test "$1" = --version || return 1
        printf '%s' "$version_output"
      }
      version_output=$2
      version_of executable
    `, output);
    assert.equal(actual, `${version}\n`);
  });
}

linuxTest("upgrade rehearsal uses the system service account for admin status", () => {
  const actual = runFixture(`
    source "$1"
    sudo() { printf '%s\\n' "$@"; }
    cli='/fixture/bin with spaces/wollipog'
    admin_status
  `);
  assert.equal(actual, "-u\nwollipog\n-H\n/fixture/bin with spaces/wollipog\nadmin\nstatus\n--json\n");
});
