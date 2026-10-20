/** Ahead-of-time only. Fixed trusted OS toolchain; no runtime compilation or installation. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), DIR = join(ROOT, "apps/runner/.bin-build");
const PS = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const SHA = b => createHash("sha256").update(b).digest("hex");
const sourcePath = join(ROOT, "apps/runner/native/provider-account-config-windows.cs");
const enginePath = join(ROOT, "apps/runner/src/provider-account-config-windows-engine.ts");
const identityPath = join(DIR, "provider-account-config-windows-v1.identity.json");
function need(ok, why) { if (!ok) throw new Error(why); }
function save(path, bytes, cap) { need(bytes.length <= cap, "build output capacity"); writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
const ENV = { SystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`, WINDIR: String.raw`\\?\GLOBALROOT\SystemRoot`, PSModuleAnalysisCachePath: "NUL" };
function compile(file, fixture) {
  need(!existsSync(file), "native compiler output already exists; no replay");
  const temp = join(DIR, fixture ? "account-config-compiler-fixture-tmp" : "account-config-compiler-prod-tmp");
  mkdirSync(temp, { mode: 0o700 });
  const script = `$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';` +
    `$runtime=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory();$compiler=[IO.Path]::Combine($runtime,'csc.exe');` +
    `if(-not [IO.File]::Exists($compiler)){throw 'fixed CLR compiler unavailable'};` +
    `$cscArgs='/noconfig /nologo /target:library /platform:anycpu /optimize+ /debug- /warnaserror+ /nostdlib+ ` + (fixture ? `/define:WACW_FIXTURE ` : "") +
    `/reference:"'+[IO.Path]::Combine($runtime,'mscorlib.dll')+'" /reference:"'+[IO.Path]::Combine($runtime,'System.dll')+'" /out:"'+$env:WACW_BUILD_OUTPUT+'" "'+$env:WACW_BUILD_SOURCE+'"';` +
    `$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$compiler;$info.UseShellExecute=$false;$info.Arguments=$cscArgs;` +
    `$p=[Diagnostics.Process]::Start($info);$p.WaitForExit();if($p.ExitCode -ne 0){exit $p.ExitCode};` +
    `[Console]::WriteLine('WACW_COMPILER='+$compiler);`;
  const result = spawnSync(PS, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...ENV, TEMP: temp, TMP: temp, WACW_BUILD_SOURCE: sourcePath, WACW_BUILD_OUTPUT: file }, shell: false,
    windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
  const receipt = Buffer.from(JSON.stringify({ actualOSExit: result.status, signal: result.signal, error: result.error?.message,
    stdout: result.stdout?.toString(), stderr: result.stderr?.toString(), compilerMode: fixture ? "fixture" : "production", sourceSha256: SHA(readFileSync(sourcePath)) }));
  save(join(DIR, fixture ? "account-config-compile-fixture.json" : "account-config-compile-prod.json"), receipt, 5 * 1024 * 1024);
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
  need(!result.error && result.status === 0 && !result.signal, "native compiler failed; preserve outputs; no replay; " + JSON.stringify({ actualOSExit: result.status, signal: result.signal, error: result.error?.message, errorCode: result.error?.code, errorErrno: result.error?.errno, errorSyscall: result.error?.syscall, compilerMode: fixture ? "fixture" : "production" }));
  need(readdirSync(temp).length === 0, "unexpected compiler temporary producer; preserve and stop");
  const bytes = readFileSync(file); need(bytes.length > 0 && bytes.length <= 1024 * 1024, "native DLL capacity");
  const compiler = result.stdout.toString().split(/\r?\n/u).find(x => x.startsWith("WACW_COMPILER=")); need(compiler, "missing compiler identity");
  return { sha256: SHA(bytes), sizeBytes: bytes.length, compiler: compiler.slice(14) };
}
async function engine(dll, fixture) {
  const result = await build({ entryPoints: [enginePath], bundle: true, platform: "node", format: "cjs", target: "node24", write: false,
    legalComments: "none", define: { __WACW_DLL_SHA__: JSON.stringify(dll.sha256), __WACW_FIXTURE__: String(fixture) } });
  need(result.outputFiles.length === 1, "engine output count"); const raw = Buffer.from(result.outputFiles[0].contents);
  const name = fixture ? "provider-account-config-windows-fixture-engine.cjs" : "provider-account-config-windows-engine.cjs";
  save(join(DIR, name), raw, 1024 * 1024); return { name, sha256: SHA(raw), sizeBytes: raw.length };
}
export async function prepareWindowsAccountConfig({ fixtures = false } = {}) {
  if (process.platform !== "win32") return undefined;
  need(process.arch === "x64" || process.arch === "arm64", "unsupported native build architecture");
  mkdirSync(DIR, { recursive: true });
  const sourceSha256 = SHA(readFileSync(sourcePath)), engineSourceSha256 = SHA(readFileSync(enginePath)), protocolSourceSha256 = SHA(readFileSync(join(ROOT,"apps/runner/src/provider-account-config-windows-protocol.ts")));
  let id;
  if (existsSync(identityPath)) {
    id = JSON.parse(readFileSync(identityPath, "utf8"));
    need(id.version === 1 && id.architecture === process.arch && id.sourceSha256 === sourceSha256 && id.engineSourceSha256 === engineSourceSha256 && id.protocolSourceSha256 === protocolSourceSha256, "existing helper source identity drift; no rebuild/recovery");
    for (const [name, expected] of [["provider-account-config-windows-v1.dll", id.dll], [id.engine.name, id.engine]])
      need(statSync(join(DIR, name)).size === expected.sizeBytes && SHA(readFileSync(join(DIR, name))) === expected.sha256, "existing helper byte drift");
  } else {
    const dll = compile(join(DIR, "provider-account-config-windows-v1.dll"), false), builtEngine = await engine(dll, false);
    id = { version: 1, protocol: "WACW1", architecture: process.arch, sourceSha256, engineSourceSha256, protocolSourceSha256, dll, engine: builtEngine };
    save(identityPath, Buffer.from(JSON.stringify(id)), 16384);
  }
  if (fixtures) {
    need(!existsSync(join(DIR, "provider-account-config-windows-fixture.dll")), "fixture compiler allowance already used");
    const fixtureDll = compile(join(DIR, "provider-account-config-windows-fixture.dll"), true);
    const fixtureEngine = await engine(fixtureDll, true);
    save(join(DIR, "provider-account-config-windows-fixture.identity.json"), Buffer.from(JSON.stringify({ sourceSha256, fixtureDll, fixtureEngine })), 16384);
  }
  return id;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = await prepareWindowsAccountConfig({ fixtures: process.argv.includes("--fixtures") });
  if (!id) throw new Error("native Windows build required");
  console.log(JSON.stringify(id));
}
