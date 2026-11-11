import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { killTree, provenProcessTreeExit, spawnAgent } from "./spawn.js";

async function runFixture(mode: "generated" | "sdk") {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".pi-inert-contract-")));
  const fixture = fileURLToPath(new URL("./fixtures/pi-inert-control-sdk.mjs", import.meta.url));
  const child = spawnAgent({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture,
    new URL("./", import.meta.url).href, mode === "sdk" ? process.env.WOLLIPOG_TEST_PI_CODE_ROOT! : "-", root, mode],
  cwd: process.cwd(), env: { HOME: root, PATH: "/usr/bin:/bin" }, scrubInheritedEnv: Object.keys(process.env), context: { kind: "native" }, windowsShell: false });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  child.stdin.end();
  const timer = setTimeout(() => { timedOut = true; void killTree(child); }, 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(await provenProcessTreeExit(child), true, "contract fixture must retire every helper");
    assert.equal(timedOut, false, `inert contract timed out: ${stderr}`);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); await killTree(child); rmSync(root, { recursive: true, force: true }); }
}
const linux = process.platform !== "linux" ? "UNAVAILABLE: inactive command policy is native Linux only" : false;
test("actual generated extension traverses fixed private MCP launch for every role and lifecycle using an explicit inert registry", {
  skip: linux, timeout: 30_000,
}, async () => {
  const result = await runFixture("generated");
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PI_INERT_CONTROL_GENERATED_TRANSPORT: passed/u);
  assert.doesNotMatch(result.stdout, /PI_INERT_CONTROL_PINNED_SDK/u);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("inert-canary-value-3922"));
});
test("pinned installed SDK loader/event contract is distinguished from the generated-source inert registry", {
  skip: linux || (!process.env.WOLLIPOG_TEST_PI_CODE_ROOT ? "UNAVAILABLE: provide audited installed Pi code; no package is downloaded" : false), timeout: 30_000,
}, async t => {
  const result = await runFixture("sdk");
  if (result.code === 77) {
    assert.equal(result.stdout.trim(), "PI_INERT_CONTROL_SDK_UNAVAILABLE: pinned installed loader lacks @earendil-works/pi-server");
    assert.equal(result.stderr, "");
    t.skip("UNAVAILABLE: exact pinned installed SDK cannot resolve @earendil-works/pi-server; real loader coverage unproven"); return;
  }
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PI_INERT_CONTROL_PINNED_SDK: passed/u);
});
