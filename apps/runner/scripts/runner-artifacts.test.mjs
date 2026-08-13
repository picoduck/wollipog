import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertRunnerTargetHost,
  publishLegacyRunnerAlias,
  runnerArtifactNames,
  runnerPlatformOfTarget,
  RUNNER_TARGET_TRIPLES,
} from "./runner-artifacts.mjs";

test("runner release names cover the exact six native targets", () => {
  assert.deepEqual(RUNNER_TARGET_TRIPLES.map(runnerArtifactNames), [
    { canonical: "wollipog-runner-aarch64-apple-darwin", legacy: "agent-manager-runner-aarch64-apple-darwin" },
    { canonical: "wollipog-runner-x86_64-apple-darwin", legacy: "agent-manager-runner-x86_64-apple-darwin" },
    { canonical: "wollipog-runner-aarch64-unknown-linux-gnu", legacy: "agent-manager-runner-aarch64-unknown-linux-gnu" },
    { canonical: "wollipog-runner-x86_64-unknown-linux-gnu", legacy: "agent-manager-runner-x86_64-unknown-linux-gnu" },
    { canonical: "wollipog-runner-aarch64-pc-windows-msvc.exe", legacy: "agent-manager-runner-aarch64-pc-windows-msvc.exe" },
    { canonical: "wollipog-runner-x86_64-pc-windows-msvc.exe", legacy: "agent-manager-runner-x86_64-pc-windows-msvc.exe" },
  ]);
  assert.throws(() => runnerArtifactNames("x86_64-unknown-freebsd"), /unsupported runner target triple/);
  assert.deepEqual(RUNNER_TARGET_TRIPLES.map(runnerPlatformOfTarget), [
    "darwin", "darwin", "linux", "linux", "win32", "win32",
  ]);
});

test("runner and desktop SEA producers accept only the exact native release hosts", () => {
  const supportedHosts = [
    ["aarch64-apple-darwin", "darwin", "arm64"],
    ["x86_64-apple-darwin", "darwin", "x64"],
    ["aarch64-unknown-linux-gnu", "linux", "arm64"],
    ["x86_64-unknown-linux-gnu", "linux", "x64"],
    ["aarch64-pc-windows-msvc", "win32", "arm64"],
    ["x86_64-pc-windows-msvc", "win32", "x64"],
  ];
  for (const [triple, platform, arch] of supportedHosts) {
    assert.doesNotThrow(() => assertRunnerTargetHost(triple, platform, arch));
  }
  assert.throws(
    () => assertRunnerTargetHost("x86_64-unknown-freebsd", "freebsd", "x64"),
    /unsupported runner target triple: x86_64-unknown-freebsd/u,
  );
  assert.throws(
    () => assertRunnerTargetHost("x86_64-unknown-linux-gnu", "linux", "arm64"),
    /requires a linux\/x64 host; received linux\/arm64/u,
  );

  for (const sourceUrl of [
    new URL("./build-binary.mjs", import.meta.url),
    new URL("../../desktop/scripts/build-sidecar.mjs", import.meta.url),
  ]) {
    assert.match(readFileSync(sourceUrl, "utf8"), /assertRunnerTargetHost\(triple, process\.platform, process\.arch\)/u);
  }
});

test("the legacy runner alias is byte-identical and keeps the canonical executable mode", () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-runner-alias-"));
  try {
    const canonical = join(root, "wollipog-runner");
    const legacy = join(root, "agent-manager-runner");
    writeFileSync(canonical, Buffer.from([0, 1, 2, 3, 255]));
    publishLegacyRunnerAlias(canonical, legacy);
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest(legacy), digest(canonical));
    if (process.platform !== "win32") {
      assert.equal(statSync(legacy).mode & 0o777, statSync(canonical).mode & 0o777);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the binary producer injects and signs only the canonical artifact before copying the alias", () => {
  const source = readFileSync(new URL("./build-binary.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/await inject\(/gu)?.length, 1);
  assert.ok(source.indexOf("const out = join(outDir, names.canonical)") < source.indexOf("await inject(out"));
  assert.ok(source.indexOf("await inject(out") < source.indexOf("publishLegacyRunnerAlias(out, legacyOut)"));
  assert.match(source, /assertRunnerTargetHost\(triple, process\.platform, process\.arch\)/u);
});
