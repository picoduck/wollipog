import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {spawnSync} from "@wollipog/test-support/bounded-child-process";
import {ASSISTANT_SKILL_PARITY} from "./assistant-skill-parity.js";

test("group 6 has no audit gaps and all mapped tools exist in actual production composition", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url))],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Production inventory failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(line => line.startsWith("OWNER_PARITY_SNAPSHOT "));
  assert.ok(line);
  const actual = JSON.parse(line.slice("OWNER_PARITY_SNAPSHOT ".length)) as {routes: string[]; tools: string[]};
  const inventory = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8"));
  for (const [tool, route] of [...ASSISTANT_SKILL_PARITY, ["auto_triggers", "GET /api/automations/:id/triggers"],
    ["auto_trigger_remove", "DELETE /api/automations/:id/triggers/:triggerId"]]) {
    assert.ok(actual.routes.includes(route), route);
    assert.ok(actual.tools.includes(tool), `${tool} absent from production composition`);
    assert.deepEqual(inventory[route], {tools: [tool]});
    assert.ok(`wollipog__${tool}`.length <= 64);
  }
  for (const route of actual.routes.filter(route => /\/api\/(?:automations|skills|skill-[\w-]+|orphaned-skill-copies)(?:\/|$)|\/api\/runners\/:id\/(?:skills|skill-|orphaned-skill-)/.test(route))) {
    const entry = inventory[route];
    assert.ok(entry && !("gap" in entry), `${route} remains an unresolved group-6 gap`);
    if (entry.exclusion) {
      assert.equal(entry.exclusion, "human_authority");
      assert.ok(entry.reason && entry.remedy);
    } else for (const tool of entry.tools) assert.ok(actual.tools.includes(tool), tool);
  }
});
