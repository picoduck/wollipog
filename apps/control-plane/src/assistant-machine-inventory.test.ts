import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ASSISTANT_MACHINE_MANAGEMENT } from "./assistant-machine-management.js";

test("group-4 audit operations are present in actual production HTTP/MCP registration", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url))],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production inventory failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_PARITY_SNAPSHOT "));
  assert.ok(line);
  const snapshot = JSON.parse(line.slice("OWNER_PARITY_SNAPSHOT ".length)) as {routes: string[]; tools: string[]};
  const audit = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8")) as Record<string, {tools?: string[]; exclusion?: string; reason?: string; remedy?: string}>;
  for (const [operation, route] of ASSISTANT_MACHINE_MANAGEMENT) {
    assert.ok(snapshot.routes.includes(route), `${route} is absent from the production owner API`);
    assert.deepEqual(audit[route]?.tools, [operation]);
    assert.ok(snapshot.tools.includes(operation), `${operation} is absent from production MCP`);
  }
  for (const route of [
    "DELETE /api/runners/:id/provider-logins/:operationId", "PUT /api/runners/:id/provider-logins/:operationId/dismiss",
    "GET /api/runners/:id/provider-accounts/:accountId/home-lease", "POST /api/runners/:id/provider-accounts/:accountId/recover-lease",
    "PUT /api/runners/:id/automatic-account-switching", "PUT /api/runners/:id/provider-account-defaults/:provider",
    "PUT /api/runners/:id/provider-account-policies/:provider",
  ]) {
    assert.ok(snapshot.routes.includes(route));
    assert.equal(audit[route]?.exclusion, "human_authority");
    assert.ok(audit[route]?.reason?.trim() && audit[route]?.remedy?.trim());
  }
  for (const route of ["POST /api/runners/:runnerId/host-action", "POST /api/sessions/:id/host-action"]) {
    assert.ok(snapshot.routes.includes(route));
    assert.equal(audit[route]?.exclusion, "interactive_workspace_io");
    assert.ok(audit[route]?.reason?.trim() && audit[route]?.remedy?.trim());
  }
});
