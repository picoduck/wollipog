import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXED_WINDOWS_POWERSHELL, fixedWindowsEnvironment } from "./provider-account-config-windows-engine.js";
import { WindowsAccountConfigError } from "./provider-account-config-windows-protocol.js";
import { captureWindowsAccountConfig } from "./provider-account-config-windows.js";
test("Windows publication trust scope is fixed OS installation, never inherited launcher hooks", () => {
  assert.equal(FIXED_WINDOWS_POWERSHELL, String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`);
  const env = fixedWindowsEnvironment();
  for (const key of Object.keys(env)) assert.ok(["SystemRoot","WINDIR","PSModuleAnalysisCachePath"].includes(key));
  for (const key of ["PATH","PSModulePath","COR_ENABLE_PROFILING","COR_PROFILER","COMPLUS_Version","DOTNET_STARTUP_HOOKS","NODE_OPTIONS"])
    assert.equal(env[key], undefined);
  // This asserts source selection/scrubbing, not executable image attestation or Windows admission.
});
test("an unbuilt source adapter refuses instead of loading an adjacent self-declared helper", () => {
  // The selected native source bundle has build-bound identity; ordinary unbuilt TS has none.
  if (process.platform === "win32") return;
  assert.throws(() => captureWindowsAccountConfig("C:\\synthetic\\config.json", [], () => []), WindowsAccountConfigError);
});
