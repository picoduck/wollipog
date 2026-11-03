import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolatedDiscoveryEnvironment } from "./provider-home.js";
import { discoverModels, createAgentModelDiscoverer } from "./models.js";

test("discovery model fallbacks read the authorized HOME and keep distinct HOME caches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-discovery-model-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedDiscoveryEnvironment(root);
  writeFileSync(join(env.CODEX_HOME!, "models_cache.json"), JSON.stringify({ models: [{ slug: "fixture-model" }] }));
  assert.equal((await discoverModels("codex", { kind: "native" }, env))[0]?.id, "fixture-model");
  let queries = 0;
  const discover = createAgentModelDiscoverer({ queryAppServer: async () => { queries++; throw { code: -32601 }; }, fallback: discoverModels });
  const agent = { id: "codex", name: "Codex", command: "fixture", args: [], driver: "codex-app-server" as const, available: true, env };
  assert.equal((await discover(agent)).models[0]?.id, "fixture-model");
  assert.deepEqual((await discover({ ...agent, env: isolatedDiscoveryEnvironment(join(root, "other")) })).models, []);
  assert.equal(queries, 2, "one HOME's catalog cannot satisfy another HOME's probe");
});

test("discovery refuses a HOME symlink before creating any child directories", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-discovery-home-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "other-runner");
  mkdirSync(target);
  symlinkSync(target, join(root, "discovery-home"));
  assert.throws(() => isolatedDiscoveryEnvironment(root), /private directory/);
  assert.deepEqual(readdirSync(target), []);
});
