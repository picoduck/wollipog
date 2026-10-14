import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { test } from "node:test";
import { preflightInstalledCodexMediaSdk } from "./codex-media-preflight.js";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const executable = realpathSync(process.execPath);
// Schema-shape unit fixture only. The executable identity is real, but Node is not an installed
// Codex SDK; these inputs may prove refusal only and can never establish media readiness.
const schema = { title: "ThreadStartParams", properties: {
  config: { additionalProperties: true }, dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
} };
const sdk = { executable, version: "0.162.1", executableSha256: hash(readFileSync(executable)),
  threadStartSchema: schema, threadStartSchemaSha256: hash(JSON.stringify(schema)) };
test("open-ended config and dynamic tools never certify complete native tool isolation", () => {
  assert.equal(preflightInstalledCodexMediaSdk(sdk).reason, "builtin_tool_allowlist_unavailable");
  const expanded = { ...schema, properties: { ...schema.properties, toolAllowlist: { type: "array" } } };
  const result = preflightInstalledCodexMediaSdk({ ...sdk, threadStartSchema: expanded,
    threadStartSchemaSha256: hash(JSON.stringify(expanded)) });
  assert.equal(result.supported, false);
  assert.equal(result.reason, "builtin_tool_allowlist_unavailable");
});
test("unmatched executable, unsupported installation, substituted schema and missing dynamic registry fail closed", () => {
  for (const change of [{ version: "0.160.0" }, { executableSha256: hash("another executable") },
    { threadStartSchemaSha256: hash("different schema") }, { executable: "/missing-native-provider" }]) {
    assert.equal(preflightInstalledCodexMediaSdk({ ...sdk, ...change }).reason, "installed_contract_mismatch");
  }
  const noTools = { title: "ThreadStartParams", properties: { config: { additionalProperties: true } } };
  assert.equal(preflightInstalledCodexMediaSdk({ ...sdk, threadStartSchema: noTools,
    threadStartSchemaSha256: hash(JSON.stringify(noTools)) }).reason, "dynamic_tools_unavailable");
});
