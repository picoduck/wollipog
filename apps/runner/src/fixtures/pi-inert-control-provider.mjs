// Real outer/inner OS topology with an inert fixed MCP helper, never a Pi/provider invocation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Readable, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
const [moduleUrl, serializedPolicy] = process.argv.slice(2);
const { createPiInertControlLauncher } = await import(moduleUrl);
const { piCommandHomePrototypeNamespaceUnavailable } = await import(new URL("./pi-command-home-prototype.ts", moduleUrl));
const policy = JSON.parse(serializedPolicy), home = policy.providerHome, cwd = policy.outer.protectedWorktree.path;
const configPath = policy.outer.readOnlyBinds.find(path => path.endsWith("/config.worktree"));
assert.ok(configPath);
assert.throws(() => writeFileSync(configPath, "[core]\nhooksPath=inert"), error => ["EROFS", "EACCES"].includes(error.code));
assert.equal(readFileSync(configPath, "utf8"), "");
const auth = `${home}/auth.json`;
writeFileSync(`${auth}.temporary`, "provider-refresh"); renameSync(`${auth}.temporary`, auth);
mkdirSync(`${home}/sessions`, { recursive: true }); writeFileSync(`${home}/sessions/transcript.jsonl`, "provider-transcript");
for (const file of ["settings.value", "settings.batch", "skills.config"]) writeFileSync(`${home}/${file}`, "provider-config");
console.log("PI_INERT_CONTROL_OUTER_WRITES: passed");
const mcp = fileURLToPath(new URL("./fixtures/pi-inert-control-helper.mjs", moduleUrl));
const launcher = createPiInertControlLauncher({ commandPolicy: policy,
  controlEntrypoint: fileURLToPath(new URL("./pi-inert-control-entrypoint.mjs", moduleUrl)), mcpEntrypoint: mcp,
  mcpEntrypointSha256: createHash("sha256").update(readFileSync(mcp)).digest("hex"), imports: [],
  transportEnvironment: { WOLLIPOG_CANARY: "inert-canary-value-3922" },
}, { auditInstallation: () => true, auditRuntime: () => true });
// The fake installation audits above never establish Pi/import identity. Actual OS writes below
// exercise the same fixed launcher and policy constructor that a future attested integration needs.
async function call(method, extra = {}) {
  const output = new PassThrough(), errors = new PassThrough();
  let stdout = "", stderr = "";
  output.on("data", data => { stdout += data; }); errors.on("data", data => { stderr += data; });
  try {
    const result = await launcher.run(Readable.from([JSON.stringify({ id: 1, method, ...extra }) + "\n"]), output, errors, { timeoutMs: 5_000 });
    return { ...result, stdout, stderr };
  } catch (error) { return { error, stdout, stderr }; }
}
const probe = await call("inspect");
if (probe.exitCode !== 0 && piCommandHomePrototypeNamespaceUnavailable(probe.stderr)) {
  console.log("PI_INERT_CONTROL_UNAVAILABLE: nested namespace refused");
} else {
  assert.equal(probe.exitCode, 0, `${probe.error?.message ?? ""} ${probe.stderr}`);
  assert.equal(JSON.parse(probe.stdout).envDelivered, true);
  for (const request of [
    { operation: "create", path: `${home}/new-file` }, { operation: "overwrite", path: auth },
    { operation: "delete", path: auth }, { operation: "rename", temporary: `${cwd}/replacement`, path: auth },
    { operation: "alias", path: `${cwd}/home-alias/auth.json` },
  ]) {
    const response = await call("write", request);
    assert.equal(response.exitCode, 0, response.stderr);
    assert.equal(JSON.parse(response.stdout).denied, true);
    assert.equal(readFileSync(auth, "utf8"), "provider-refresh");
  }
  const descendant = await call("descendant-write", { path: auth });
  assert.equal(descendant.exitCode, 0, descendant.stderr); assert.equal(JSON.parse(descendant.stdout).denied, true);
  const read = await call("read", { path: auth }); assert.equal(JSON.parse(read.stdout).result, "provider-refresh");
  const write = await call("write", { path: `${cwd}/allowed` }); assert.equal(JSON.parse(write.stdout).denied, false);
  assert.equal(readFileSync(`${cwd}/allowed`, "utf8"), "inert-write");
  assert.equal(readFileSync(`${home}/sessions/transcript.jsonl`, "utf8"), "provider-transcript");
  for (const file of ["settings.value", "settings.batch", "skills.config"]) assert.equal(readFileSync(`${home}/${file}`, "utf8"), "provider-config");
  const controller = new AbortController(), input = new PassThrough(), output = new PassThrough(), errors = new PassThrough();
  output.resume(); errors.resume(); input.write('{"method":"hang"}\n');
  const pending = launcher.run(input, output, errors, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, /aborted/u); } finally { clearTimeout(timer); }
  console.log("PI_INERT_CONTROL_OS_CONFORMANCE: passed");
}
