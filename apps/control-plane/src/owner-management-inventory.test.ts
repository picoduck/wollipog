import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OwnerManagementInventory, type OwnerOperationCoverage } from "./owner-management-inventory.js";
import { ASSISTANT_CONNECTION_OPERATIONS } from "./assistant-connection-operations.js";

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

test("session-protocol classification cannot absorb an owner route or omit its registered read counterpart", async () => {
  const app = Fastify(), inventory = new OwnerManagementInventory();
  inventory.attach(app);
  app.post("/api/sessions/:id/waits", () => ({}));
  app.post("/api/sessions/:id/pull-request-watch", () => ({}));
  app.post("/api/sessions/:id/config", () => ({}));
  const protocol = {exclusion: "session_protocol" as const, reason: "Matching self-session credential is required; owner HTTP is refused.",
    remedy: "Read state using session_watch_get; the genuine session runtime performs these writes.", ownerTools: ["session_watch_get"]};
  const coverage: Record<string, OwnerOperationCoverage> = {
    "POST /api/sessions/:id/waits": protocol,
    "POST /api/sessions/:id/pull-request-watch": protocol,
    "POST /api/sessions/:id/config": {tools: ["session_config"]},
  };
  const registered = new Set(["session_watch_get", "session_config"]);
  try {
    inventory.assertComplete(coverage, registered);
    coverage["POST /api/sessions/:id/config"] = protocol;
    assert.throws(() => inventory.assertComplete(coverage, registered), /restricted to the two adjudicated/);
    coverage["POST /api/sessions/:id/config"] = {tools: ["session_config"]};
    assert.throws(() => inventory.assertComplete(coverage, new Set(["session_config"])), /read counterpart session_watch_get is not registered/);
    coverage["POST /api/sessions/:id/waits"] = {...protocol, ownerTools: []};
    assert.throws(() => inventory.assertComplete(coverage, registered), /registered owner-facing read counterpart/);
    coverage["POST /api/sessions/:id/waits"] = {...protocol, ownerTools: ["session_config"]};
    assert.throws(() => inventory.assertComplete(coverage, registered), /exact registered owner-facing read counterpart session_watch_get/);
  } finally {await app.close();}
});

test("production composition inventory is exhaustive; unresolved gaps cannot count as exclusions", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url))],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production composition failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_PARITY_SNAPSHOT "));
  assert.ok(line, "Production composition did not return its route/registry inventory.");
  const snapshot = JSON.parse(line.slice("OWNER_PARITY_SNAPSHOT ".length)) as {routes: string[]; tools: string[]};
  // The Discord composition must retain the authenticated-origin session seam and both
  // management registration families. A conflict resolution must not silently drop one.
  for (const tool of ["session_launch", "command_get", "assistant_work_track", "assistant_work_read",
    "assistant_work_reconcile", "auto_list", "skill_pin_get", "session_config", "location_add",
    "session_work_get", "queue_get", "queue_edit", "queue_cancel", "session_steer", "session_invoke",
    "session_project", "session_workspace", "session_column", "session_retitle", "session_rewind", "session_fork",
    "session_reprocess", "session_delete", "session_adopt", "session_role_get", "session_role",
    "session_watch_get", "side_chat_get", "side_chat_create",
    "prompt_history", "history_preview", "attachment_history", "session_export", "session_artifacts",
    "transcript_shares", "reminder_get", "reminder_set", "reminder_remove", "shell_list", "shell_open", "shell_close"]) {
    assert.ok(snapshot.tools.includes(tool), `${tool}: production composition lost a registration family`);
  }
  for (const tool of ["session_watch", "session_wait_report"]) {
    assert.ok(!snapshot.tools.includes(tool), `${tool}: an owner connection must not impersonate session-runtime protocol writes`);
  }
  const manifest = JSON.parse(readFileSync(new URL("../../../docs/assistant-owner-capabilities.json", import.meta.url), "utf8")) as
    Record<string, OwnerOperationCoverage | {gap: string}>;
  for (const [tool, route] of ASSISTANT_CONNECTION_OPERATIONS) {
    assert.ok(snapshot.tools.includes(tool), `${tool}: production lost a group-5 connection operation`);
    assert.deepEqual(manifest[route], {tools: [tool]}, `${route}: group-5 audit drift`);
  }
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

test("real owner HTTP and Assistant MCP cannot write runtime wait/watch state under another identity", {timeout: 30_000}, () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-support/owner-parity-snapshot.ts", import.meta.url)), "--verify-runtime-identity"],
    {encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024});
  assert.equal(child.status, 0, "Isolated production identity-fence verification failed; raw logs withheld.");
  const line = child.stdout.split("\n").find(value => value.startsWith("OWNER_RUNTIME_IDENTITY_FENCES "));
  assert.ok(line, "Production HTTP/MCP did not return identity-fence evidence.");
  assert.deepEqual(JSON.parse(line.slice("OWNER_RUNTIME_IDENTITY_FENCES ".length)), {ownerReads: 1, ownerWritesDenied: 2, assistantWritesDenied: 2, effects: 0});
});
