import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ARTIFACT_SIGNING_TIMESTAMP_URL,
  removeWindowsSignature,
  runWindowsSigningCli,
  signWindowsBinary,
  signtoolSignArgs,
  windowsSigningConfig,
} from "./windows-authenticode.mjs";

const enabled = {
  WOLLIPOG_WINDOWS_SIGNING: "1",
  WOLLIPOG_SIGNTOOL: "C:/kits/x64/signtool.exe",
  WOLLIPOG_ARTIFACT_SIGNING_DLIB: "C:/client/bin/x64/Azure.CodeSigning.Dlib.dll",
  WOLLIPOG_ARTIFACT_SIGNING_METADATA: "C:/client/metadata.json",
};

function recorder(failures = 0) {
  const calls = [];
  let remaining = failures;
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "sign" && remaining > 0) {
      remaining -= 1;
      throw new Error("transient signing failure");
    }
  };
  return { calls, run };
}

test("signing stays off unless the release workflow enables it", () => {
  assert.equal(windowsSigningConfig({}), null);
  assert.equal(windowsSigningConfig({ ...enabled, WOLLIPOG_WINDOWS_SIGNING: "0" }), null);
  const { calls, run } = recorder();
  assert.equal(signWindowsBinary("runner.exe", { env: {}, run }), false);
  assert.equal(removeWindowsSignature("runner.exe", { env: {}, run }), false);
  assert.deepEqual(calls, []);
});

test("an enabled flag with a missing setting is a configuration error, not a silent skip", () => {
  for (const name of ["WOLLIPOG_SIGNTOOL", "WOLLIPOG_ARTIFACT_SIGNING_DLIB", "WOLLIPOG_ARTIFACT_SIGNING_METADATA"]) {
    assert.throws(() => windowsSigningConfig({ ...enabled, [name]: "" }), new RegExp(name, "u"));
  }
});

test("signtool signs with SHA-256, an RFC 3161 timestamp, and the Artifact Signing dlib", () => {
  const args = signtoolSignArgs("app.exe", windowsSigningConfig(enabled));
  assert.deepEqual(args, [
    "sign", "/v", "/fd", "SHA256", "/tr", ARTIFACT_SIGNING_TIMESTAMP_URL, "/td", "SHA256",
    "/dlib", enabled.WOLLIPOG_ARTIFACT_SIGNING_DLIB, "/dmdf", enabled.WOLLIPOG_ARTIFACT_SIGNING_METADATA, "app.exe",
  ]);
});

test("a signed file is verified against the Windows trust policy", () => {
  const { calls, run } = recorder();
  assert.equal(signWindowsBinary("app.exe", { env: enabled, run }), true);
  assert.deepEqual(calls.map((call) => call[1]), ["sign", "verify"]);
  assert.deepEqual(calls[1], [enabled.WOLLIPOG_SIGNTOOL, "verify", "/pa", "/v", "app.exe"]);
});

test("transient signing failures are retried, and the last failure surfaces", () => {
  const retried = recorder(2);
  assert.equal(signWindowsBinary("app.exe", { env: enabled, run: retried.run }), true);
  assert.deepEqual(retried.calls.map((call) => call[1]), ["sign", "sign", "sign", "verify"]);

  const exhausted = recorder(3);
  assert.throws(() => signWindowsBinary("app.exe", { env: enabled, run: exhausted.run }), /transient signing failure/u);
  assert.equal(exhausted.calls.some((call) => call[1] === "verify"), false);
});

test("removing the node.exe signature before injection tolerates an unsigned input", () => {
  const run = () => {
    throw new Error("no signature");
  };
  assert.equal(removeWindowsSignature("runner.exe", { env: enabled, run }), true);
});

test("the Tauri sign command refuses to report success while signing is disabled", () => {
  const { run } = recorder();
  assert.throws(() => runWindowsSigningCli(["app.exe"], { env: {}, run }), /refusing to report app\.exe as signed/u);
  assert.throws(() => runWindowsSigningCli([], { env: enabled, run }), /usage/u);
  assert.doesNotThrow(() => runWindowsSigningCli(["app.exe"], { env: enabled, run }));
});

test("both SEA producers sign each binary once, after injection and before any copy", () => {
  const runner = readFileSync(new URL("./build-binary.mjs", import.meta.url), "utf8");
  assert.ok(runner.indexOf("removeWindowsSignature(out)") < runner.indexOf("await inject(out"));
  assert.ok(runner.indexOf("await inject(out") < runner.indexOf("signWindowsBinary(out)"));
  assert.ok(runner.indexOf("signWindowsBinary(out)") < runner.indexOf("publishLegacyRunnerAlias(out, legacyOut)"));
  assert.equal(runner.match(/signWindowsBinary\(/gu)?.length, 1);

  const sidecar = readFileSync(new URL("../../desktop/scripts/build-sidecar.mjs", import.meta.url), "utf8");
  assert.ok(sidecar.indexOf("removeWindowsSignature(out)") < sidecar.indexOf("await inject(out"));
  assert.ok(sidecar.indexOf("await inject(out") < sidecar.indexOf("signWindowsBinary(out)"));
  assert.ok(sidecar.indexOf("signWindowsBinary(out)") < sidecar.indexOf("publishLegacyRunnerAlias(out, headlessControlPlane)"));
  assert.equal(sidecar.match(/signWindowsBinary\(/gu)?.length, 1);
});
