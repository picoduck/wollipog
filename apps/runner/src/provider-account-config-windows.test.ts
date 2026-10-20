import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_WINDOWS_POWERSHELL, fixedWindowsEnvironment, validateWindowsPlatform, resolveWindowsPlatform } from "./provider-account-config-windows-engine.js";
import { WindowsAccountConfigError } from "./provider-account-config-windows-protocol.js";
import { captureWindowsAccountConfig } from "./provider-account-config-windows.js";
test("Windows publication trust scope is fixed OS installation, never inherited launcher hooks", () => {
  assert.equal(FIXED_WINDOWS_POWERSHELL, String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`);
  const root = "D:\\Windows", image = root + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.deepEqual(validateWindowsPlatform(root, image), { systemRoot: root, executable: image });
  for (const bad of ["Windows", "\\\\server\\Windows", "D:\\Windows\\..", "D:\\Windows ", "D:\\Win:evil"])
    assert.throws(() => validateWindowsPlatform(bad, bad + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
  assert.throws(() => validateWindowsPlatform(root, "D:\\other\\powershell.exe"));
  if (process.platform === "win32") {
    const actual = resolveWindowsPlatform();
    assert.deepEqual(validateWindowsPlatform(actual.systemRoot, actual.executable), actual);
  }
  const env = fixedWindowsEnvironment(root);
  assert.equal(env.SystemRoot, root); assert.equal(env.WINDIR, root); assert.equal(env.PATH, "");
  for (const key of Object.keys(env)) assert.ok(["SystemRoot","WINDIR","PATH","PSModuleAnalysisCachePath"].includes(key));
  for (const key of ["PSModulePath","COR_ENABLE_PROFILING","COR_PROFILER","COMPLUS_Version","DOTNET_STARTUP_HOOKS","NODE_OPTIONS"])
    assert.equal(env[key], undefined);
  // Pure checks cover validation/env only; Windows metadata checks are not image attestation or native publication proof.
});
test("an unbuilt source adapter refuses instead of loading an adjacent self-declared helper", () => {
  // The selected native source bundle has build-bound identity; ordinary unbuilt TS has none.
  if (process.platform === "win32") return;
  assert.throws(() => captureWindowsAccountConfig("C:\\synthetic\\config.json", [], () => []), WindowsAccountConfigError);
});
