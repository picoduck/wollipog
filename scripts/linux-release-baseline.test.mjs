import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fc from "fast-check";

const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const validation = readFileSync(new URL("../.github/workflows/linux-release-compatibility.yml", import.meta.url), "utf8");
const guard = fileURLToPath(new URL("./verify-linux-release-baseline.sh", import.meta.url));
const dependencies = readFileSync(new URL("./install-linux-release-deps.sh", import.meta.url), "utf8");

test("every Ubuntu host selector is supported while Linux release userland stays digest-pinned", () => {
  const workflows = new URL("../.github/workflows/", import.meta.url);
  for (const path of readdirSync(workflows).filter((path) => path.endsWith(".yml"))) {
    const workflow = readFileSync(new URL(path, workflows), "utf8");
    assert.doesNotMatch(workflow, /^\s+(?:runs-on|os):[^\n]*ubuntu-22\.04/m, path);
  }
  const containers = [...release.matchAll(/^            container: (.+)$/gm)].map((match) => match[1]);
  assert.equal(containers.length, 2, "only the two native Linux release targets use a baseline container");
  assert.match(containers[0], /^ubuntu:22\.04@sha256:[0-9a-f]{64}$/);
  assert.equal(containers[0], containers[1]);
  assert.match(release, /container: \$\{\{ matrix\.container \}\}/);
  assert.match(validation, new RegExp("container: " + containers[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const [os, target] of [["ubuntu-24.04", "x86_64-unknown-linux-gnu"], ["ubuntu-24.04-arm", "aarch64-unknown-linux-gnu"]]) {
    assert.ok(release.includes("os: " + os + "\n            target: " + target + "\n            container: " + containers[0]));
    assert.ok(validation.includes("os: " + os + "\n            target: " + target));
  }
  assert.match(release, /matrix\.container && '-ubuntu22\.04'/);
  assert.match(dependencies, /test "\$VERSION_ID" = 22\.04/);
  assert.match(dependencies, /glibc 2\.35/);
  assert.match(dependencies, /gh_version=2\.102\.0/);
  assert.equal([...dependencies.matchAll(/gh_sha=([0-9a-f]{64})/g)].length, 2);
  assert.match(dependencies, /sha256sum --check/);
  assert.match(dependencies, /gh api --help \| grep -- --slurp/);
});

test("native compatibility builds real packages and verifies baseline without publication or secrets", () => {
  assert.match(validation, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(validation, /\$\{\{\s*secrets\.|gh release|tauri-action|workflow_dispatch/);
  assert.match(validation, /pnpm install --frozen-lockfile/);
  assert.match(validation, /node-version-file: \.nvmrc/);
  assert.match(validation, /pnpm --filter @wollipog\/desktop tauri build --target \$\{\{ matrix\.target \}\}/);
  assert.match(validation, /bash scripts\/verify-linux-release-baseline\.sh/);
  assert.match(release, /bash scripts\/install-linux-release-deps\.sh/);
  assert.match(validation, /bash scripts\/install-linux-release-deps\.sh/);
  assert.match(release, /Verify Linux Release Baseline[\s\S]*bash scripts\/verify-linux-release-baseline\.sh/);
  assert.match(validation, /APPIMAGE_EXTRACT_AND_RUN: "1"/);
  const executableWorkflow = (release + validation).split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(executableWorkflow, /--privileged|\/dev\/fuse|WEBKIT_DISABLE_SANDBOX/);
  assert.match(validation, /if: github.event_name != 'pull_request' \|\| github.event.action == 'ready_for_review' \|\| github.event.pull_request.draft == false/);
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "linux-release-abi-"));
  const binary = join(directory, "synthetic-binary");
  const versions = join(directory, "versions");
  writeFileSync(binary, "synthetic fixture");
  writeFileSync(join(directory, "readelf"), '#!/bin/sh\ncase "$1" in --file-header) printf "Machine: %s\\n" "$FAKE_MACHINE";; --version-info) cat "$FAKE_VERSION_FILE";; *) exit 64;; esac\n', { mode: 0o755 });
  writeFileSync(join(directory, "ldd"), '#!/bin/sh\nprintf "%s\\n" "$FAKE_LDD"\nexit "${FAKE_LDD_STATUS:-0}"\n', { mode: 0o755 });
  return {
    run(symbols, options = {}) {
      writeFileSync(versions, symbols.map((version) => "Name: " + version).join("\n"));
      return spawnSync("bash", ["-c", 'source "$1"; verify_linux_release_binary "$2" "$3"', "test", guard, binary, "Advanced Micro Devices X86-64"], {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env, PATH: directory + ":" + process.env.PATH,
          FAKE_MACHINE: options.machine ?? "Advanced Micro Devices X86-64",
          FAKE_VERSION_FILE: versions,
          FAKE_LDD: options.loader ?? "libc.so.6 => /lib/libc.so.6",
          FAKE_LDD_STATUS: String(options.status ?? 0),
        },
      });
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("the actual ABI guard accepts exactly symbol versions supplied by glibc 2.35", { skip: process.platform !== "linux" }, () => {
  const synthetic = fixture();
  try {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 12 }), (minors) => {
      const result = synthetic.run(minors.map((minor) => "GLIBC_2." + minor));
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, minors.every((minor) => minor <= 35), result.stderr);
    }), { numRuns: 50, examples: [[[35]], [[36]], [[9]], [[100]]] });
  } finally { synthetic.close(); }
});

test("the actual guard rejects wrong architecture, private ABI and unresolved libraries", { skip: process.platform !== "linux" }, () => {
  const synthetic = fixture();
  try {
    for (const [symbols, options] of [
      [["GLIBC_2.35"], { machine: "AArch64" }],
      [["GLIBC_PRIVATE"], {}],
      [["GLIBC_ABI_DT_RELR"], {}],
      [[], {}],
      [["GLIBC_2.35"], { loader: "libc.so.6 => not found" }],
      [["GLIBC_2.35"], { loader: "undefined symbol: changed_abi" }],
      [["GLIBC_2.35"], { status: 1 }],
    ]) {
      const result = synthetic.run(symbols, options);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, JSON.stringify({ symbols, options }));
    }
  } finally { synthetic.close(); }
});

