import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OwnerManagementInventory, type OwnerOperationCoverage } from "./owner-management-inventory.js";

test("parity gate observes generated owner routes and fails unregistered or undocumented operations", async () => {
  const app = Fastify(), inventory = new OwnerManagementInventory();
  inventory.attach(app);
  for (const action of ["rotate", "revoke"]) app.post(`/api/assistant-connections/:id/${action}`, () => ({}));
  app.post("/api/sessions/:id/config", () => ({}));
  app.get("/api/projects", () => ({}));
  app.put("/api/runners/:id/capacity", () => ({}));
  app.post("/api/automations", () => ({}));
  app.post("/api/skills/:id/versions", () => ({}));
  app.get("/api/skill-groups", () => ({}));
  app.get("/health", () => ({}));
  try {
    const coverage: Record<string, OwnerOperationCoverage> = {};
    assert.equal(inventory.list().length, 8);
    assert.throws(() => inventory.assertComplete(coverage, new Set()), /POST \/api\/automations/);
    for (const route of inventory.list()) coverage[route] = {tools: ["fixture_tool"]};
    assert.throws(() => inventory.assertComplete(coverage, new Set()), /not registered/);
    inventory.assertComplete(coverage, new Set(["fixture_tool"]));
    coverage["POST /api/sessions/:id/config"] = {tools: []};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["fixture_tool"])), /actual registered tool/);
    coverage["POST /api/sessions/:id/config"] = {exclusion: "human_authority", reason: "", remedy: ""};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["fixture_tool"])), /reason and supported remedy/);
  } finally {await app.close();}
});

test("production composition inventory is exhaustive; unresolved gaps cannot count as exclusions", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url))],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production composition failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_PARITY_SNAPSHOT "));
  assert.ok(line, "Production composition did not return its route/registry inventory.");
  const snapshot = JSON.parse(line.slice("OWNER_PARITY_SNAPSHOT ".length)) as {routes: string[]; tools: string[]};
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8")) as
    Record<string, OwnerOperationCoverage | {gap: string}>;
  assert.deepEqual(snapshot.routes, Object.keys(manifest).sort(), "An owner-route candidate was added/removed: classify it explicitly; never regenerate to hide a gap.");
  const inventory = new OwnerManagementInventory();
  const app = Fastify();
  inventory.attach(app);
  for (const route of snapshot.routes) {
    const space = route.indexOf(" ");
    app.route({method: route.slice(0, space) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: route.slice(space + 1), handler: () => ({})});
  }
  const coverage = Object.fromEntries(Object.entries(manifest).filter(([, entry]) => !("gap" in entry))) as Record<string, OwnerOperationCoverage>;
  const gaps = inventory.gaps(coverage, new Set(snapshot.tools));
  for (const [route, entry] of Object.entries(manifest)) {
    if ("gap" in entry) assert.ok(gaps.some(gap => gap.route === route), `${route}: an unresolved gap was silently counted as coverage`);
  }
  // This is the audit contract test, not a claim of full parity. The strict acceptance command
  // calls assertComplete against this same production inventory and must fail until gaps land.
  if (gaps.length) assert.throws(() => inventory.assertComplete(coverage, new Set(snapshot.tools)), /parity is incomplete/);
});
